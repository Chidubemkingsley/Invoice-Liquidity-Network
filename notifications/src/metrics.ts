import client, { type Registry } from 'prom-client';

export interface NotificationsMetrics {
  registry: Registry;
  dispatchesTotal: client.Counter<string>;
  failuresTotal: client.Counter<string>;
  rateLimitHitsTotal: client.Counter<string>;
  deliveryDuration: client.Histogram<string>;
  activeSubscriptions: client.Gauge<string>;
  costUsdTotal: client.Counter<string>;
  fallbackDeliveriesTotal: client.Counter<string>;
  healthChecksTotal: client.Counter<string>;
  auditRecordsTotal: client.Counter<string>;
  recordDispatch(channel: string, trigger: string): void;
  recordFailure(channel: string, reason: string): void;
  recordRateLimitHit(channel: string): void;
  recordCost(channel: string, usd: number): void;
  recordFallback(primary: string, fallback: string, priority: string): void;
}

export function createNotificationsMetrics(): NotificationsMetrics {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry, prefix: 'iln_notifications_' });

  const dispatchesTotal = new client.Counter({
    name: 'iln_notifications_dispatches_total',
    help: 'Total notification dispatches by channel and trigger',
    labelNames: ['channel', 'trigger'] as const,
    registers: [registry],
  });

  const failuresTotal = new client.Counter({
    name: 'iln_notifications_failures_total',
    help: 'Total notification delivery failures by channel and reason',
    labelNames: ['channel', 'reason'] as const,
    registers: [registry],
  });

  const rateLimitHitsTotal = new client.Counter({
    name: 'iln_notifications_rate_limit_hits_total',
    help: 'Total rate-limit rejections (429) by channel',
    labelNames: ['channel'] as const,
    registers: [registry],
  });

  const deliveryDuration = new client.Histogram({
    name: 'iln_notifications_delivery_duration_seconds',
    help: 'Notification delivery latency in seconds',
    labelNames: ['channel'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const activeSubscriptions = new client.Gauge({
    name: 'iln_notifications_active_subscriptions',
    help: 'Current active subscriptions by channel',
    labelNames: ['channel'] as const,
    registers: [registry],
  });

  const costUsdTotal = new client.Counter({
    name: 'iln_notifications_cost_usd_total',
    help: 'Attributed cost in USD by channel and operation',
    labelNames: ['channel', 'operation'] as const,
    registers: [registry],
  });

  const fallbackDeliveriesTotal = new client.Counter({
    name: 'iln_notifications_fallback_deliveries_total',
    help: 'Fallback channel deliveries by primary, fallback, and priority',
    labelNames: ['primary', 'fallback', 'priority'] as const,
    registers: [registry],
  });

  const healthChecksTotal = new client.Counter({
    name: 'iln_notifications_health_checks_total',
    help: 'Provider health checks by channel and result',
    labelNames: ['channel', 'result'] as const,
    registers: [registry],
  });

  const auditRecordsTotal = new client.Counter({
    name: 'iln_notifications_audit_records_total',
    help: 'Delivery audit records created by status and channel',
    labelNames: ['status', 'channel'] as const,
    registers: [registry],
  });

  function recordDispatch(channel: string, trigger: string): void {
    dispatchesTotal.inc({ channel, trigger });
  }

  function recordFailure(channel: string, reason: string): void {
    failuresTotal.inc({ channel, reason });
  }

  function recordRateLimitHit(channel: string): void {
    rateLimitHitsTotal.inc({ channel });
  }

  function recordCost(channel: string, usd: number): void {
    costUsdTotal.inc({ channel, operation: 'dispatch' }, usd);
  }

  function recordFallback(primary: string, fallback: string, priority: string): void {
    fallbackDeliveriesTotal.inc({ primary, fallback, priority });
  }

  return {
    registry,
    dispatchesTotal,
    failuresTotal,
    rateLimitHitsTotal,
    deliveryDuration,
    activeSubscriptions,
    costUsdTotal,
    fallbackDeliveriesTotal,
    healthChecksTotal,
    auditRecordsTotal,
    recordDispatch,
    recordFailure,
    recordRateLimitHit,
    recordCost,
    recordFallback,
  };
}

// Singleton for runtime
export const notificationsMetrics = createNotificationsMetrics();
