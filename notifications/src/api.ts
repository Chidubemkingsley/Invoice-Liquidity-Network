import express, { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { RateLimiter } from './rate-limiter';
import { traceMiddleware } from '@iln/opentelemetry';
import {
  createSubscription,
  deleteSubscriptionByAddressAndDestination,
  deleteSubscriptionById,
  getSubscriptionsByAddress,
  getSubscriptionById,
  getWebhookDeliveryLogs,
  getDeliveryAnalytics,
  getChannelComparison,
  getTrendAnalytics,
  getDeliveryAuditLogs,
  getDeliveryAuditLogById,
  countDeliveryAuditLogs,
  purgeExpiredDeliveryLogs,
} from './db';
import {
  ALLOWED_CHANNELS,
  ALLOWED_TRIGGERS,
  isValidEmail,
  isValidPhone,
  isValidUrl,
  validateChannel,
  validateTrigger,
} from './config';
import type { NotificationTrigger } from './types';
import { sendWebhook } from './delivery';
import { createPreferencesRouter } from './preferences-api';
import { digestScheduler, DigestScheduler } from './digest';
import { preferencesService } from './preferences';
import { notificationsMetrics } from './metrics';
import { getAllProviderHealth } from './provider-health';

interface SubscribeRequest {
  stellar_address: string;
  channel: string;
  destination: string;
  triggers: unknown;
  webhook_secret?: string;
}

const rateLimiter = new RateLimiter({
  perUserLimit: parseInt(process.env.RATE_LIMIT_PER_USER ?? '60', 10),
  perChannelLimit: parseInt(process.env.RATE_LIMIT_PER_CHANNEL ?? '200', 10),
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
});

function applyRateLimit(req: Request, res: Response, next: NextFunction): void {
  const userId =
    ((req.body as any)?.stellar_address as string | undefined) ??
    req.params.address ??
    req.ip ??
    'anonymous';
  const channel = ((req.body as any)?.channel as string | undefined) ?? 'api';
  const result = rateLimiter.check(userId, channel);

  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', String(result.resetAt));

  if (!result.allowed) {
    res.status(429).json({
      error: 'Too many requests — rate limit exceeded. Please try again later.',
      retryAfter: result.resetAt,
    });
    return;
  }
  next();
}

export function createApp() {
  const app = express();
  app.use(traceMiddleware('notifications'));
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.get('/metrics', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', notificationsMetrics.registry.contentType);
    res.end(await notificationsMetrics.registry.metrics());
  });

  // Provider health inspection — for drill verification and ops dashboards
  app.get('/health/providers', (_req: Request, res: Response) => {
    res.json({ providers: getAllProviderHealth() });
  });

  app.post('/subscribe', applyRateLimit, (req: Request, res: Response) => {
    const body = req.body as SubscribeRequest;

    if (!body?.stellar_address || typeof body.stellar_address !== 'string') {
      return res.status(400).json({ error: 'stellar_address is required' });
    }

    if (!validateChannel(body.channel)) {
      return res.status(400).json({
        error: `channel must be one of: ${ALLOWED_CHANNELS.join(', ')}`,
      });
    }

    if (!body.destination || typeof body.destination !== 'string') {
      return res.status(400).json({ error: 'destination is required' });
    }

    if (!Array.isArray(body.triggers) || body.triggers.length === 0) {
      return res.status(400).json({ error: 'triggers must be a non-empty array' });
    }

    const triggers = body.triggers as unknown[];
    if (!triggers.every(validateTrigger)) {
      return res.status(400).json({
        error: `triggers must be one of: ${ALLOWED_TRIGGERS.join(', ')}`,
      });
    }

    if (body.channel === 'email' && !isValidEmail(body.destination)) {
      return res.status(400).json({ error: 'destination must be a valid email address' });
    }

    if (body.channel === 'webhook' && !isValidUrl(body.destination)) {
      return res.status(400).json({ error: 'destination must be a valid http or https URL' });
    }

    if (body.channel === 'sms' && !isValidPhone(body.destination)) {
      return res
        .status(400)
        .json({ error: 'destination must be a valid E.164 phone number (e.g. +14155552671)' });
    }

    const subscription = createSubscription({
      stellar_address: body.stellar_address,
      channel: body.channel as 'email' | 'webhook' | 'sms',
      destination: body.destination,
      triggers: triggers as NotificationTrigger[],
      webhook_secret:
        body.channel === 'webhook'
          ? typeof body.webhook_secret === 'string'
            ? body.webhook_secret
            : randomBytes(32).toString('hex')
          : undefined,
    });

    return res.status(201).json({ subscription });
  });

  app.delete('/unsubscribe', (req: Request, res: Response) => {
    const { id, address, destination } = req.body as {
      id?: number;
      address?: string;
      destination?: string;
    };

    let deleted = false;

    if (typeof id === 'number') {
      deleted = deleteSubscriptionById(id);
    } else if (address && destination) {
      deleted = deleteSubscriptionByAddressAndDestination(address, destination);
    } else {
      return res.status(400).json({ error: 'Provide subscription id or address and destination' });
    }

    if (!deleted) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    return res.status(200).json({ success: true });
  });

  app.get('/subscriptions/:address', (req: Request, res: Response) => {
    const address = req.params.address;

    if (!address) {
      return res.status(400).json({ error: 'address is required' });
    }

    const subscriptions = getSubscriptionsByAddress(address).map((sub) => ({
      id: sub.id,
      stellar_address: sub.stellar_address,
      channel: sub.channel,
      destination: sub.destination,
      triggers: sub.triggers,
      created_at: sub.created_at,
    }));
    return res.json({ subscriptions });
  });

  app.get('/subscriptions/:id/logs', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid subscription id' });
    }

    const logs = getWebhookDeliveryLogs(id);
    return res.json({ logs });
  });

  app.post('/test-webhook', applyRateLimit, async (req: Request, res: Response) => {
    const { id } = req.body as { id: number };

    if (typeof id !== 'number') {
      return res.status(400).json({ error: 'id is required and must be a number' });
    }

    const subscription = getSubscriptionById(id);
    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    if (subscription.channel !== 'webhook') {
      return res.status(400).json({ error: 'Subscription is not a webhook' });
    }

    try {
      await sendWebhook(subscription, {
        trigger: 'invoice_funded',
        invoice: {
          id: 0,
          freelancer: subscription.stellar_address,
          payer: subscription.stellar_address,
          amount: '100',
          due_date: Math.floor(Date.now() / 1000) + 86400,
          discount_rate: 100,
          status: 'Funded',
          funder: null,
          funded_at: null,
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        },
        recipientAddress: subscription.stellar_address,
        subject: 'Webhook Test',
        message: 'This is a test notification from the ILN Notification Service.',
        actor: 'freelancer',
      });

      return res.json({ success: true, statusCode: 200 });
    } catch (error: any) {
      const statusCode = error.message.includes('attempts:')
        ? parseInt(error.message.split(': ')[1]) || 500
        : 500;

      return res.json({ success: false, statusCode });
    }
  });

  app.get('/analytics', (_req: Request, res: Response) => {
    return res.json(getDeliveryAnalytics());
  });

  app.get('/analytics/channel-comparison', (_req: Request, res: Response) => {
    return res.json({ channels: getChannelComparison() });
  });

  app.get('/analytics/trends', (req: Request, res: Response) => {
    const rawDays = typeof req.query.days === 'string' ? parseInt(req.query.days, 10) : 30;
    const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 30;
    return res.json({ trends: getTrendAnalytics(days) });
  });

  // ── Delivery audit log (durable, queryable, independent of retry state) ─────
  // Support / compliance investigations need to answer "was this notification
  // actually delivered, and when" without scraping scattered application logs.
  // The audit log is a durable, queryable record per delivery outcome.
  app.get('/audit/deliveries', (req: Request, res: Response) => {
    const {
      recipient,
      eventId,
      trigger,
      channel,
      status,
      start,
      end,
      limit: rawLimit,
      offset: rawOffset,
    } = req.query as Record<string, string | undefined>;

    const filter: any = {};
    if (recipient) filter.recipient = recipient;
    if (eventId) filter.eventId = eventId;
    if (trigger) filter.trigger = trigger;
    if (channel) filter.channel = channel;
    if (status) {
      if (!['pending', 'delivered', 'failed'].includes(status)) {
        return res.status(400).json({ error: 'status must be pending, delivered, or failed' });
      }
      filter.status = status;
    }
    if (start) {
      const ms = Date.parse(start);
      if (Number.isNaN(ms)) return res.status(400).json({ error: 'start must be ISO 8601 date' });
      filter.startTime = ms;
    }
    if (end) {
      const ms = Date.parse(end);
      if (Number.isNaN(ms)) return res.status(400).json({ error: 'end must be ISO 8601 date' });
      filter.endTime = ms;
    }
    if (rawLimit) {
      const n = parseInt(rawLimit, 10);
      if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'limit must be positive integer' });
      filter.limit = Math.min(n, 1000);
    }
    if (rawOffset) {
      const n = parseInt(rawOffset, 10);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'offset must be non-negative integer' });
      filter.offset = n;
    }

    const records = getDeliveryAuditLogs(filter);
    const total = countDeliveryAuditLogs(filter);
    return res.json({ total, records });
  });

  app.get('/audit/deliveries/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid audit id' });
    const record = getDeliveryAuditLogById(id);
    if (!record) return res.status(404).json({ error: 'Audit record not found' });
    return res.json({ record });
  });

  // Retention enforcement — consistent with docs/privacy.md (30d sent, 90d webhook/audit).
  // Exposed for internal ops / CLI `purge-audit` and for scheduled job.
  app.post('/audit/purge', (req: Request, res: Response) => {
    const nowParam = (req.query.now as string | undefined) ?? (req.body as any)?.now;
    const nowMs = nowParam ? Date.parse(nowParam) : Date.now();
    if (Number.isNaN(nowMs)) return res.status(400).json({ error: 'now must be ISO 8601' });
    const result = purgeExpiredDeliveryLogs(nowMs);
    return res.json({ purged: result, retentionPolicy: { sentNotificationsDays: 30, webhookLogsDays: 90, auditLogsDays: 90 } });
  });

  app.get('/audit/stats', (_req: Request, res: Response) => {
    const delivered = countDeliveryAuditLogs({ status: 'delivered' });
    const failed = countDeliveryAuditLogs({ status: 'failed' });
    const pending = countDeliveryAuditLogs({ status: 'pending' });
    const total = countDeliveryAuditLogs();
    return res.json({ total, delivered, failed, pending });
  });

  // Issue #718: digest preview endpoint — returns pending buffer items
  // without sending an email, so users can see what their next digest
  // will contain.
  app.get('/digest/preview/:address', (req: Request, res: Response) => {
    const address = req.params.address;
    if (!address) {
      return res.status(400).json({ error: 'address is required' });
    }

    const pending = digestScheduler.pendingCount(address);
    const frequency = preferencesService.get(address).frequency;
    const digestEnabled = DigestScheduler.isDigestFrequency(frequency);

    return res.json({
      stellarAddress: address,
      digestEnabled,
      frequency,
      pendingCount: pending,
      nextDigestAt: digestEnabled
        ? frequency === 'daily'
          ? 'next 08:00 UTC'
          : 'next Monday 08:00 UTC'
        : null,
    });
  });

  // Issue #718: mount the preferences router. Read/write preferences,
  // one-click unsubscribe (both per-address and tokenized variants), and
  // GDPR-style data export all live under /preferences. The router mounts
  // before the catch-all error handler so 4xx responses are returned
  // consistently and the new endpoints are reachable in production.
  app.use('/preferences', createPreferencesRouter());

  return app;
}
