import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

// Central registry for all metrics exported by the indexer.
export const registry = new Registry();

// Collect node/process default metrics with `iln_` prefix.
collectDefaultMetrics({ register: registry, prefix: 'iln_' });

export const dbQueryDuration = new Histogram({
  name: 'iln_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
  registers: [registry],
});

export const dbErrorsTotal = new Counter({
  name: 'iln_db_errors_total',
  help: 'Database errors',
  registers: [registry],
});

export const eventsProcessedTotal = new Counter({
  name: 'iln_events_processed_total',
  help: 'Number of contract events processed',
  registers: [registry],
});

export const invoicesUpsertedTotal = new Counter({
  name: 'iln_invoices_upserted_total',
  help: 'Number of invoices upserted into the DB',
  registers: [registry],
});

export const lastProcessedLedger = new Gauge({
  name: 'iln_last_processed_ledger',
  help: 'Last processed ledger sequence number',
  registers: [registry],
});

export const cursorUpdatedAt = new Gauge({
  name: 'iln_cursor_updated_at',
  help: 'Timestamp (ms) when cursor was last updated',
  registers: [registry],
});

// ── SLO instrumentation (latency & availability) ───────────────────────────

export const httpRequestsTotal = new Counter({
  name: 'iln_http_requests_total',
  help: 'Total HTTP requests by method, route, and status',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpErrorsTotal = new Counter({
  name: 'iln_http_errors_total',
  help: 'Total HTTP errors (status >= 500) by method and route',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'iln_http_request_duration_seconds',
  help: 'HTTP request latency in seconds by method and route',
  labelNames: ['method', 'route'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

// ── Cost attribution (per-service, per-operation) ──────────────────────────

export const costUsdTotal = new Counter({
  name: 'iln_cost_usd_total',
  help: 'Attributed cost in USD by service and operation',
  labelNames: ['service', 'operation'] as const,
  registers: [registry],
});

export const sloErrorBudgetBurn = new Gauge({
  name: 'iln_slo_error_budget_burn',
  help: 'Current error-budget burn rate (ratio) by SLO name',
  labelNames: ['slo'] as const,
  registers: [registry],
});

export function observeCost(service: string, operation: string, usd: number): void {
  try {
    costUsdTotal.inc({ service, operation }, usd);
  } catch {}
}

export function observeHttpRequest(
  method: string,
  route: string,
  status: number,
  durationSeconds: number
): void {
  try {
    httpRequestsTotal.inc({ method, route, status: String(status) });
    if (status >= 500) {
      httpErrorsTotal.inc({ method, route, status: String(status) });
    }
    httpRequestDuration.observe({ method, route }, durationSeconds);
    // Cost attribution: ~$0.00002 per read request (RPC + DB)
    costUsdTotal.inc({ service: 'indexer', operation: 'http_request' }, 0.00002);
  } catch {}
}
