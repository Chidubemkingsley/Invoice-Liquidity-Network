/**
 * Provider health monitoring and fallback routing for notifications.
 * When the email or webhook host provider itself has an outage, critical
 * alerts could silently fail. This module defines automatic health checking
 * and fallback-channel routing with priority-aware capacity handling.
 */

import { getCircuitBreakerState } from './delivery';
import type { NotificationTrigger, SubscriptionChannel } from './types';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';
export type ProviderChannel = SubscriptionChannel;

export interface ProviderHealth {
  channel: ProviderChannel;
  status: HealthStatus;
  lastChecked: number;
  failureCount: number;
  successCount: number;
  latencyMs?: number;
}

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const DEGRADED_FAILURE_THRESHOLD = 3;
const UNHEALTHY_FAILURE_THRESHOLD = 5;

// Fallback mapping: primary -> ordered list of fallback channels.
// When a primary provider's health check fails, notifications are
// automatically routed to the first healthy fallback channel the
// recipient is subscribed to.
export const FALLBACK_MAP: Record<ProviderChannel, ProviderChannel[]> = {
  email: ['webhook', 'sms', 'websocket'],
  webhook: ['email', 'sms'],
  sms: ['email', 'webhook'],
  websocket: ['email', 'webhook'],
};

// Trigger priority — critical/high get preferential fallback under
// constrained capacity. Low-priority notifications may be dropped when
// fallback capacity is exhausted, while critical alerts are still delivered.
export const TRIGGER_PRIORITY: Record<NotificationTrigger, 'critical' | 'high' | 'low'> = {
  invoice_defaulted: 'critical',
  invoice_overdue: 'critical',
  invoice_due_soon: 'high',
  invoice_paid: 'high',
  invoice_funded: 'low',
};

export function getTriggerPriority(trigger: NotificationTrigger): 'critical' | 'high' | 'low' {
  return TRIGGER_PRIORITY[trigger] ?? 'low';
}

// Capacity limiter for fallback deliveries. When the primary provider is
// down, fallback channels have finite capacity. Under constrained capacity,
// low-priority notifications are shed first.
export class FallbackCapacityLimiter {
  private count = 0;
  private windowStart = Date.now();
  constructor(
    private readonly maxPerWindow: number = 100,
    private readonly windowMs: number = 60_000
  ) {}

  private maybeResetWindow(): void {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.count = 0;
      this.windowStart = now;
    }
  }

  /**
   * Attempt to reserve capacity for a fallback delivery.
   * Returns true if capacity is available (or priority is critical),
   * false if low-priority fallback should be shed.
   */
  tryAcquire(priority: 'critical' | 'high' | 'low'): boolean {
    this.maybeResetWindow();
    // Critical always gets through, even if over capacity (with warning)
    if (priority === 'critical') {
      this.count++;
      return true;
    }
    // High priority: allow up to 120% of window for burst
    if (priority === 'high') {
      if (this.count < this.maxPerWindow * 1.2) {
        this.count++;
        return true;
      }
      return false;
    }
    // Low priority: strict cap
    if (this.count < this.maxPerWindow) {
      this.count++;
      return true;
    }
    return false;
  }

  getUsage(): { count: number; max: number; windowStart: number } {
    this.maybeResetWindow();
    return { count: this.count, max: this.maxPerWindow, windowStart: this.windowStart };
  }

  reset(): void {
    this.count = 0;
    this.windowStart = Date.now();
  }
}

export const fallbackCapacityLimiter = new FallbackCapacityLimiter();

// In-memory health registry — provider health is checked via synthetic probes
// and via circuit-breaker signals.
const healthRegistry = new Map<ProviderChannel, ProviderHealth>();

function initHealth(channel: ProviderChannel): ProviderHealth {
  if (!healthRegistry.has(channel)) {
    healthRegistry.set(channel, {
      channel,
      status: 'healthy',
      lastChecked: Date.now(),
      failureCount: 0,
      successCount: 0,
    });
  }
  return healthRegistry.get(channel)!;
}

export function getProviderHealth(channel: ProviderChannel): HealthStatus {
  const entry = healthRegistry.get(channel);
  if (!entry) return 'healthy';
  // Also consider circuit-breaker as a signal: if any destination for this
  // channel is open, degrade health. We approximate by checking a synthetic
  // destination key per channel.
  // For now, rely on explicit health status plus failure counts.
  return entry.status;
}

export function isProviderHealthy(channel: ProviderChannel): boolean {
  return getProviderHealth(channel) === 'healthy';
}

export function setProviderHealth(channel: ProviderChannel, status: HealthStatus): void {
  const entry = initHealth(channel);
  entry.status = status;
  entry.lastChecked = Date.now();
  if (status === 'healthy') {
    entry.failureCount = 0;
  }
}

export function recordProviderSuccess(channel: ProviderChannel, latencyMs?: number): void {
  const entry = initHealth(channel);
  entry.successCount++;
  entry.failureCount = Math.max(0, entry.failureCount - 1);
  entry.latencyMs = latencyMs;
  // Recover from degraded if successes accumulate
  if (entry.status !== 'healthy' && entry.failureCount === 0) {
    entry.status = 'healthy';
  }
  entry.lastChecked = Date.now();
}

export function recordProviderFailure(channel: ProviderChannel): void {
  const entry = initHealth(channel);
  entry.failureCount++;
  entry.lastChecked = Date.now();
  if (entry.failureCount >= UNHEALTHY_FAILURE_THRESHOLD) {
    entry.status = 'unhealthy';
  } else if (entry.failureCount >= DEGRADED_FAILURE_THRESHOLD) {
    entry.status = 'degraded';
  }
}

export function getAllProviderHealth(): Record<ProviderChannel, ProviderHealth> {
  const out: Record<string, ProviderHealth> = {};
  for (const ch of ['email', 'webhook', 'sms', 'websocket'] as ProviderChannel[]) {
    out[ch] = initHealth(ch);
  }
  return out as Record<ProviderChannel, ProviderHealth>;
}

export function resetProviderHealth(): void {
  healthRegistry.clear();
  fallbackCapacityLimiter.reset();
}

// Automatic health checking — probes each provider's endpoint.
// In production, this would hit Resend/Twilio health endpoints.
// Here we simulate with a lightweight check that can be stubbed in tests.
export interface HealthCheckResult {
  channel: ProviderChannel;
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

export async function checkProviderHealth(
  channel: ProviderChannel
): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    // Synthetic probe — in tests this is mocked via fetch.
    // For email: check Resend API health (GET https://api.resend.com/health)
    // For webhook: no central host, so we check a canary subscriber endpoint if configured.
    // For sms: check Twilio credential validity via Twilio's API.
    // Here we treat a successful fetch as healthy.
    const probeUrls: Record<ProviderChannel, string | null> = {
      email: process.env.RESEND_HEALTH_URL ?? null,
      webhook: process.env.WEBHOOK_HEALTH_URL ?? null,
      sms: process.env.TWILIO_HEALTH_URL ?? null,
      websocket: null,
    };
    const url = probeUrls[channel];
    if (url) {
      const res = await fetch(url, { method: 'GET' });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        recordProviderSuccess(channel, latencyMs);
        return { channel, healthy: true, latencyMs };
      }
      recordProviderFailure(channel);
      return { channel, healthy: false, latencyMs, error: `HTTP ${res.status}` };
    }
    // No probe URL configured — fall back to circuit-breaker signal.
    // If synthetic destinations are not open, assume healthy.
    const latencyMs = Date.now() - start;
    // Use a sentinel destination per channel to check circuit state.
    const sentinel = `provider-health-${channel}`;
    const circuit = getCircuitBreakerState(sentinel);
    const healthy = circuit === 'closed';
    if (healthy) recordProviderSuccess(channel, latencyMs);
    else recordProviderFailure(channel);
    return { channel, healthy, latencyMs };
  } catch (error: any) {
    const latencyMs = Date.now() - start;
    recordProviderFailure(channel);
    return { channel, healthy: false, latencyMs, error: error?.message ?? String(error) };
  }
}

export async function checkAllProviders(): Promise<HealthCheckResult[]> {
  const channels: ProviderChannel[] = ['email', 'webhook', 'sms'];
  const results: HealthCheckResult[] = [];
  for (const ch of channels) {
    // Run sequentially to avoid thundering herd; interval is 30s anyway.
    // eslint-disable-next-line no-await-in-loop
    const r = await checkProviderHealth(ch);
    results.push(r);
  }
  return results;
}

let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

export function startHealthChecks(intervalMs: number = HEALTH_CHECK_INTERVAL_MS): void {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(() => {
    void checkAllProviders();
  }, intervalMs);
  // Don't block process exit in tests
  if (healthCheckTimer && typeof (healthCheckTimer as any).unref === 'function') {
    (healthCheckTimer as any).unref();
  }
}

export function stopHealthChecks(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

// Drill helpers — simulate a primary-provider outage and verify fallback
export function simulateProviderOutage(channel: ProviderChannel): void {
  setProviderHealth(channel, 'unhealthy');
}

export function restoreProvider(channel: ProviderChannel): void {
  setProviderHealth(channel, 'healthy');
}

export function getFallbackChannels(primary: ProviderChannel): ProviderChannel[] {
  return FALLBACK_MAP[primary] ?? [];
}

export function shouldUseFallback(trigger: NotificationTrigger, primaryHealth: HealthStatus): boolean {
  // Always fallback if primary is unhealthy/degraded, regardless of priority.
  // Priority only matters for capacity shedding.
  return primaryHealth !== 'healthy';
}
