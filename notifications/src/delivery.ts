import { createHmac } from 'crypto';
import { Resend } from 'resend';
import Twilio from 'twilio';
import { CONFIG } from './config';
import { createWebhookDeliveryLog, updateWebhookDeliveryLog } from './db';
import { SSRFError, assertWebhookTargetPublic } from './ssrf';
import { escapeHtml, escapeHeaderValue, escapeSmsText } from './templates/helpers';
import { withSpan, propagateFetch } from '@iln/opentelemetry';
import type { NotificationPayload, Subscription, NotificationTrigger, Invoice } from './types';

const resend = new Resend(CONFIG.resendApiKey);

let twilioClient: ReturnType<typeof Twilio> | null = null;

function getTwilioClient() {
  if (!twilioClient && CONFIG.twilioAccountSid && CONFIG.twilioAuthToken) {
    twilioClient = Twilio(CONFIG.twilioAccountSid, CONFIG.twilioAuthToken);
  }
  return twilioClient;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Circuit Breaker ──────────────────────────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerEntry {
  failures: number;
  state: CircuitState;
  lastFailureAt: number;
  /** Timestamp (ms) when the circuit transitions from open to half-open. */
  nextProbeAt: number;
}

const circuitBreakers = new Map<string, CircuitBreakerEntry>();

const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 60_000;

export function getCircuitBreakerState(destination: string): CircuitState {
  const entry = circuitBreakers.get(destination);
  if (!entry) return 'closed';
  return entry.state;
}

export function resetCircuitBreakers(): void {
  circuitBreakers.clear();
}

function recordCircuitSuccess(destination: string): void {
  circuitBreakers.delete(destination);
}

function recordCircuitFailure(destination: string): CircuitState {
  const now = Date.now();
  const existing = circuitBreakers.get(destination);

  if (!existing) {
    circuitBreakers.set(destination, {
      failures: 1,
      state: 'closed',
      lastFailureAt: now,
      nextProbeAt: 0,
    });
    return 'closed';
  }

  existing.failures++;
  existing.lastFailureAt = now;

  if (existing.failures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    existing.state = 'open';
    existing.nextProbeAt = now + CIRCUIT_BREAKER_RESET_TIMEOUT_MS;
  }

  return existing.state;
}

function shouldAllowRequest(destination: string): boolean {
  const entry = circuitBreakers.get(destination);
  if (!entry) return true;

  if (entry.state === 'closed') return true;

  if (entry.state === 'open' && Date.now() >= entry.nextProbeAt) {
    entry.state = 'half-open';
    return true;
  }

  if (entry.state === 'half-open') return true;

  return false;
}

// ── Dead Letter Queue ────────────────────────────────────────────────────────

export interface DeadLetterEntry {
  channel: 'email' | 'sms' | 'webhook';
  destination: string;
  subscriptionId: string;
  trigger: NotificationTrigger;
  invoice: Invoice;
  subject: string;
  message: string;
  lastError: string;
  attempts: number;
  timestamp: number;
}

export interface RetryMetrics {
  totalRetries: number;
  activeRetries: number;
  deadLetterCount: number;
  deadLetterEntries: DeadLetterEntry[];
}

const deadLetterQueue: DeadLetterEntry[] = [];
let totalRetries = 0;
let activeRetries = 0;

export function getRetryMetrics(): RetryMetrics {
  return {
    totalRetries,
    activeRetries,
    deadLetterCount: deadLetterQueue.length,
    deadLetterEntries: [...deadLetterQueue],
  };
}

export function clearDeadLetterQueue(): void {
  deadLetterQueue.length = 0;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    label: string;
    maxRetries?: number;
    baseDelayMs?: number;
    onRetry?: (attempt: number, error: string) => void;
    onDeadLetter?: (lastError: string) => void;
  }
): Promise<T> {
  const maxRetries = options.maxRetries ?? CONFIG.maxWebhookRetry;
  const baseDelayMs = options.baseDelayMs ?? CONFIG.webhookBackoffBaseMs;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        totalRetries++;
      }
      return result;
    } catch (error: any) {
      const errorMessage = error?.message ?? String(error);
      if (attempt < maxRetries) {
        activeRetries++;
        totalRetries++;
        options.onRetry?.(attempt, errorMessage);
        const backoff = baseDelayMs * 2 ** (attempt - 1);
        await delay(backoff);
      } else {
        options.onDeadLetter?.(errorMessage);
        throw error;
      }
    }
  }

  throw new Error(`Retry exhausted for ${options.label}`);
}

export async function sendEmail(
  subscription: Subscription,
  payload: NotificationPayload
): Promise<void> {
  const destination = subscription.destination;
  if (!shouldAllowRequest(destination)) {
    console.warn(`[delivery] Circuit open for ${destination} — skipping email`);
    return;
  }

  try {
    await retryWithBackoff(
      async () => {
        // Context-appropriate escaping for HTML email body: all interpolated fields are untrusted
        // chain/user data, so escape for HTML before embedding.
        const safeMessage = escapeHtml(payload.message);
        const safeSubject = escapeHeaderValue(payload.subject); // header injection defense for subject line
        const safeStatus = escapeHtml(payload.invoice.status);
        const safeId = escapeHtml(String(payload.invoice.id));
        const safeDue = escapeHtml(new Date(payload.invoice.due_date * 1000).toISOString());
        await resend.emails.send({
          from: CONFIG.resendFromEmail,
          to: subscription.destination,
          subject: safeSubject,
          html: `<p>${safeMessage}</p>
      <p><strong>Invoice #${safeId}</strong></p>
      <p>Status: ${safeStatus}</p>
      <p>Due date: ${safeDue}</p>`,
        });
      },
      {
        label: `email to ${subscription.destination}`,
        onDeadLetter: (lastError) => {
          deadLetterQueue.push({
            channel: 'email',
            destination: subscription.destination,
            subscriptionId: subscription.id,
            trigger: payload.trigger,
            invoice: payload.invoice,
            subject: payload.subject,
            message: payload.message,
            lastError,
            attempts: CONFIG.maxWebhookRetry,
            timestamp: Date.now(),
          });
        },
      }
    );
    recordCircuitSuccess(destination);
  } catch {
    recordCircuitFailure(destination);
    throw new Error(`Circuit breaker: email delivery to ${destination} failed`);
  }
}

function getWebhookSignature(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export async function sendWebhook(
  subscription: Subscription,
  payload: NotificationPayload,
  attempt = 1,
  logId?: number
): Promise<void> {
  const destination = subscription.destination;
  if (!shouldAllowRequest(destination)) {
    console.warn(`[delivery] Circuit open for ${destination} — skipping webhook`);
    deadLetterQueue.push({
      channel: 'webhook',
      destination,
      subscriptionId: subscription.id,
      trigger: payload.trigger,
      invoice: payload.invoice,
      subject: payload.subject,
      message: payload.message,
      lastError: 'Circuit breaker open',
      attempts: attempt,
      timestamp: Date.now(),
    });
    return;
  }

  const body = JSON.stringify({
    trigger: payload.trigger,
    actor: payload.actor,
    invoice: payload.invoice,
    subject: payload.subject,
    message: payload.message,
    eventId: payload.eventId ?? null,
    eventType: payload.eventType ?? null,
  });

  const id =
    logId ??
    createWebhookDeliveryLog({
      subscription_id: subscription.id,
      event_id: payload.eventId ?? null,
      trigger: payload.trigger,
      invoice_id: payload.invoice.id,
      recipient_address: payload.recipientAddress,
      status: 'pending',
      attempts: 0,
      response_status: null,
      error: null,
    }).id;

  let response;
  let errorMessage: string | null = null;

  try {
    await assertWebhookTargetPublic(subscription.destination);
  } catch (error: unknown) {
    const reason =
      error instanceof SSRFError ? error.message : 'Destination URL rejected as unsafe';
    console.error(`[delivery] Refusing unsafe webhook target for ${subscription.id}: ${reason}`);
    await updateWebhookDeliveryLog(id, { status: 'failed', attempts: attempt, error: reason });
    deadLetterQueue.push({
      channel: 'webhook',
      destination: subscription.destination,
      subscriptionId: subscription.id,
      trigger: payload.trigger,
      invoice: payload.invoice,
      subject: payload.subject,
      message: payload.message,
      lastError: reason,
      attempts: attempt,
      timestamp: Date.now(),
    });
    return;
  }

  try {
    // Header values escaped against CRLF injection; JSON body is via JSON.stringify (safe for JSON context)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-ILN-Trigger': escapeHeaderValue(payload.trigger),
      'X-ILN-Recipient': escapeHeaderValue(payload.recipientAddress),
    };

    if (subscription.webhook_secret) {
      headers['X-ILN-Signature'] = `sha256=${getWebhookSignature(
        subscription.webhook_secret,
        body
      )}`;
    }

    if (payload.eventId) {
      headers['X-ILN-Event-Id'] = escapeHeaderValue(payload.eventId);
    }

    response = await fetch(
      subscription.destination,
      propagateFetch({
        method: 'POST',
        headers,
        body,
      }),
    );

    await updateWebhookDeliveryLog(id, {
      attempts: attempt,
      response_status: response.status,
    });

    if (response.ok) {
      await updateWebhookDeliveryLog(id, {
        status: 'success',
      });
      recordCircuitSuccess(destination);
      return;
    }

    errorMessage = `HTTP ${response.status}`;
  } catch (error: any) {
    errorMessage = error?.message ?? 'Network Error';
    console.error(`[delivery] Webhook fetch error on attempt ${attempt}:`, error);
  }

  if (attempt >= CONFIG.maxWebhookRetry) {
    await updateWebhookDeliveryLog(id, {
      status: 'failed',
      attempts: attempt,
      error: errorMessage,
    });
    deadLetterQueue.push({
      channel: 'webhook',
      destination: subscription.destination,
      subscriptionId: subscription.id,
      trigger: payload.trigger,
      invoice: payload.invoice,
      subject: payload.subject,
      message: payload.message,
      lastError: errorMessage ?? 'Unknown error',
      attempts: attempt,
      timestamp: Date.now(),
    });
    recordCircuitFailure(destination);
    return;
  }

  totalRetries++;
  activeRetries++;

  await updateWebhookDeliveryLog(id, {
    attempts: attempt,
    response_status: response?.status ?? null,
    error: errorMessage,
  });

  const backoff = CONFIG.webhookBackoffBaseMs * 2 ** (attempt - 1);
  await delay(backoff);
  await sendWebhook(subscription, payload, attempt + 1, id);
}

export async function sendSms(
  subscription: Subscription,
  payload: NotificationPayload
): Promise<void> {
  const client = getTwilioClient();
  if (!client) {
    throw new Error('Twilio credentials not configured');
  }

  const destination = subscription.destination;
  if (!shouldAllowRequest(destination)) {
    console.warn(`[delivery] Circuit open for ${destination} — skipping SMS`);
    return;
  }

  // SMS is plain-text — strip control chars / CRLF that could split messages or confuse carriers
  const message = escapeSmsText([
    payload.subject,
    '',
    `Invoice #${payload.invoice.id}`,
    `Status: ${payload.invoice.status}`,
    `Due date: ${new Date(payload.invoice.due_date * 1000).toISOString()}`,
  ].join('\n'));

  try {
    await retryWithBackoff(
      async () => {
        await client.messages.create({
          to: subscription.destination,
          from: CONFIG.twilioFromNumber,
          body: message,
        });
      },
      {
        label: `sms to ${subscription.destination}`,
        onDeadLetter: (lastError) => {
          deadLetterQueue.push({
            channel: 'sms',
            destination: subscription.destination,
            subscriptionId: subscription.id,
            trigger: payload.trigger,
            invoice: payload.invoice,
            subject: payload.subject,
            message: payload.message,
            lastError,
            attempts: CONFIG.maxWebhookRetry,
            timestamp: Date.now(),
          });
        },
      }
    );
    recordCircuitSuccess(destination);
  } catch {
    recordCircuitFailure(destination);
    throw new Error(`Circuit breaker: SMS delivery to ${destination} failed`);
  }
}

export async function deliverNotification(
  subscription: Subscription,
  payload: NotificationPayload
): Promise<void> {
  if (subscription.channel === 'email') {
    await sendEmail(subscription, payload);
    return;
  }

  if (subscription.channel === 'sms') {
    await sendSms(subscription, payload);
    return;
  }

  await sendWebhook(subscription, payload);
}
