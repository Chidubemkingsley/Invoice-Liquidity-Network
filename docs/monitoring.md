# Operational Monitoring & Grafana Observability

This document defines the production observability stack for the **Invoice Liquidity Network (ILN)** monorepo, covering metrics collection, Prometheus scraping, Grafana visualization, synthetic canary health verification **(now full critical-path correctness)**, and **cross-service distributed tracing** across all core microservices: **Indexer**, **Oracle Service**, **Notifications Service**, and the **TypeScript SDK**.

---

## 1. Overview & Operational Architecture

The ILN observability pipeline aggregates business metrics, service-level performance indicators (SLIs), and host runtime health into a unified Prometheus and Grafana deployment, complemented by active synthetic canaries and W3C trace context.

```
                  ┌────────────────────────┐
                  │   Grafana Dashboard    │
                  │ (monitoring/grafana/)  │
                  └───────────▲────────────┘
                              │ PromQL  (+ Exemplars → Traces)
                  ┌───────────┴────────────┐
                  │   Prometheus Server    │
                  └───────────▲────────────┘
                              │ HTTP GET /metrics + /traces (OTLP)
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌───────┴───────┐     ┌───────┴───────┐     ┌───────┴───────┐
│ Indexer API   │◄───►│ Oracle Service│◄───►│ Notifications │
│ (Port 3001)   │     │ (Port 3010)   │     │ (Port 4001)   │
└───────────────┘     └───────────────┘     └───────────────┘
        ▲  traceparent propagation (W3C) ▲
        └─────────────────────────────────┘
```

---

## 2. Service Metric Endpoints

Every backend service in the monorepo exposes a standard Prometheus `/metrics` endpoint:

| Service | HTTP Port | Primary Endpoint | Prom-Client Prefix / Metric Types |
| --- | --- | --- | --- |
| **Indexer Service** | `3001` | `http://localhost:3001/metrics` | `iln_*` (Process, Ledger Cursor, DB Latency, Contract Errors) |
| **Oracle Service** | `3010` | `http://localhost:3010/v1/metrics` | `oracle_*` (Requests, Cache Hits/Misses, Stale Responses, Latency) |
| **Notifications Service** | `4001` | `http://localhost:4001/metrics` | `iln_notifications_*` (Dispatches, Failures, Rate Limits, Subscriptions) |
| **SDK & OpenTelemetry** | Client-side | Exposed via OTel Meter | `iln_transaction_*`, `iln_simulation_*`, `iln_error_count_*` |
| **Traces (OTLP)** | `4317`/`4318` | `http://collector:4317` (gRPC) / `http://collector:4318` (HTTP) | W3C traceparent exemplars linked from Prometheus |

---

## 3. Prometheus Scrape Target Configuration

The production Prometheus configuration is located at `monitoring/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'iln-indexer'
    static_configs:
      - targets: ['indexer:3001']

  - job_name: 'iln-oracle'
    static_configs:
      - targets: ['oracle-service:3010']

  - job_name: 'iln-notifications'
    static_configs:
      - targets: ['notifications:4001']

  # OTel Collector (for traces, when configured)
  - job_name: 'otel-collector'
    static_configs:
      - targets: ['otel-collector:8889']
```

---

## 4. Unified Production Grafana Dashboard

The canonical production Grafana dashboard is located at **`monitoring/grafana/dashboard.json`** (also mirrored at `examples/grafana/dashboard.json`).

### Dashboard Structure & Panel Groups

1. **Protocol Business Metrics**:
   - **Invoice Submissions per Hour**: `rate(iln_invoice_submissions_total[1h])`
   - **Funded Invoices per Hour**: `rate(iln_funded_invoices_total[1h])`
   - **Settlement Rate**: `irate(iln_paid_invoices_total[5m]) / irate(iln_funded_invoices_total[5m])`
   - **Dispute / Default Rate**: `irate(iln_defaulted_invoices_total[5m]) / irate(iln_invoice_submissions_total[5m])`
   - **Average Transaction Fee**: `iln_transaction_fee_sum / iln_transaction_fee_count`
   - **LP Portfolio Distribution**: `sum by (lp) (iln_lp_portfolio_size_usd)`
   - **Contract Errors by Type**: `sum by (error_type) (rate(iln_contract_error_total[5m]))`

2. **Indexer Service Operations**:
   - **Last Processed Ledger**: `iln_last_processed_ledger`
   - **Ledger Cursor Sync Lag**: `time() - (iln_cursor_updated_at / 1000)`
   - **Event Processing Throughput**: `rate(iln_events_processed_total[5m])`
   - **Invoices Upsert Rate**: `rate(iln_invoices_upserted_total[5m])`
   - **DB Query Latency (p95/p99)**: `histogram_quantile(0.95, sum(rate(iln_db_query_duration_seconds_bucket[5m])) by (le))`
   - **Database Error Rate**: `rate(iln_db_errors_total[5m])`

3. **Oracle Service Performance & Accuracy**:
   - **Verification Request Rate**: `rate(oracle_verification_requests_total[5m])`
   - **Cache Hit vs Miss Ratio**: `rate(oracle_cache_hits_total[5m])` vs `rate(oracle_cache_misses_total[5m])`
   - **Stale Response Rate**: `rate(oracle_stale_responses_total[5m])`
   - **Verification Latency (p95/p99)**: `histogram_quantile(0.95, sum(rate(oracle_verification_duration_seconds_bucket[5m])) by (le))`

4. **Notifications Service & Channel Health**:
   - **Dispatches by Channel**: `sum by (channel) (rate(iln_notifications_dispatches_total[5m]))`
   - **Delivery Failure Rate**: `sum by (channel, reason) (rate(iln_notifications_failures_total[5m]))`
   - **Rate Limit Rejections (429s)**: `sum by (channel) (rate(iln_notifications_rate_limit_hits_total[5m]))`
   - **Notification Latency (p95)**: `histogram_quantile(0.95, sum(rate(iln_notifications_delivery_duration_seconds_bucket[5m])) by (le, channel))`
   - **Active Subscriptions**: `sum by (channel) (iln_notifications_active_subscriptions)`

5. **SDK & Client Telemetry**:
   - **Transaction Build & Simulation Latency**: `histogram_quantile(0.95, sum(rate(iln_transaction_duration_ms_bucket[5m])) by (le))`
   - **SDK Errors by Method & Code**: `sum by (method, code) (rate(iln_error_count_total[5m]))`

6. **System Resource Utilization**:
   - **Memory Usage (RSS)**: `sum by (job) (process_resident_memory_bytes)`
   - **CPU Usage Rate**: `sum by (job) (rate(process_cpu_seconds_total[5m]))`
   - **Event Loop Lag**: `sum by (job) (nodejs_eventloop_lag_seconds)`

7. **Distributed Traces (new)**:
   - **Trace Rate by Service**: `rate(traces_span_count[5m])` by `service.name`
   - **Cross-Service Latency (p95)**: `histogram_quantile(0.95, rate(traces_span_duration_seconds_bucket[5m]))` by `operation`
   - **Error Traces**: `rate(traces_span_errors_total[5m])`
   - Grafana *Explore → Traces* (Tempo/Jaeger datasource) linked from metrics via exemplars (`/metrics` exposes `trace_id` as exemplar).

---

## 5. Importing the Dashboard into Grafana

1. Log into your Grafana instance (`http://localhost:3000`).
2. Navigate to **Dashboards** -> **Import**.
3. Select **Upload JSON file** and choose `monitoring/grafana/dashboard.json`.
4. Select your configured Prometheus data source and click **Import**.

---

## 6. Synthetic Canary Integration — Full Critical-Path Coverage

The Grafana dashboard is complemented by active synthetic probes that exercise **every integrator-critical path end-to-end with correctness assertions**, not just HTTP 200. The prober lives at `scripts/synthetic-canary.ts` and runs as a scheduled workflow (`.github/workflows/synthetic-canary.yml` every 15 min + off-line unit tests).

### Why liveness alone is insufficient
A service can return `200 OK` while still being broken for integrators: pagination may overlap, GraphQL may diverge from REST, subscription writes may 500 while health passes, oracle may return stale trust scores from cache. The hardened canary catches those regressions by asserting **read-then-verify consistency** and schema correctness.

### Covered critical paths & pass/fail criteria

| Path (check name) | What it proves for integrators | Pass criterion | Fail severity | Runbook (direct) |
|---|---|---|---|---|
| **Indexer** | | | | |
| `indexer:health` | API process up & DB connected | `200` + `{status:"ok", db:"ok"}` | **P1** | [Incident #Signal-2](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/incident-response.md#signal-2-indexer-lag--ingestion-health) |
| `indexer:health:freshness` | Not stale (ledger lag) | `lastSync` < 5 min old, `syncLag` < 300s | **P1** | same |
| `indexer:invoice:${id}` | Canary invoice readable | `id` matches, `invoice` object present | **P1** | [Scenario B](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/incident-response.md#scenario-b-indexer-data-loss-or-state-corruption) |
| `indexer:invoice:schema` | Schema hasn't drifted | `id: number, freelancer/payer: string, amount: numeric-string, status ∈ enum` | **P1** | same |
| `indexer:list:pagination` | Pagination correct (integrators list) | `limit=2` → `hasMore`+`nextCursor` consistent, pages disjoint, sorted ASC | **P2** | [Monitoring §4](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/monitoring.md#indexer-service-operations) |
| `indexer:filter:status` | Filtering not broken | `status=Funded` → all rows `status==="Funded"` | **P2** | same |
| `indexer:stats` / `indexer:stats:sanity` | Stats not stale / negative | `totalInvoices: number ≥0, defaultRate 0–1` | **P3** | same |
| `indexer:graphql:consistency` | REST ↔ GraphQL parity (**read-then-verify-consistency flow**) | `REST /v1/invoice/:id` vs `POST /graphql { invoice(id) }` fields byte-equal | **P2** | same |
| `indexer:history` | History endpoint honest | array + schema valid | **P3** | same |
| `indexer:dashboard` | Dashboard not lying about lag | `sync.syncLag` numeric < 600s | **P2** | same |
| **Oracle** | | | | |
| `oracle:health` | Process up | `200` + `status ok/degraded` | **P1** | [Scenario C](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/incident-response.md#scenario-c-oracle-service-compromise-or-malfunction) |
| `oracle:verify:${addr}` | Real verification works | `isVerified: boolean, trustScore 0–100, confidence ∈ {low,medium,high,unknown}` | **P1** | same |
| `oracle:verify:schema` | No field drift | strict type/range checks | **P1** | same |
| `oracle:cache` | Cache not poisoned | 2nd verify (same payer) → `cacheHit:true` + same `trustScore` | **P2** | [Oracle docs](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/oracle-service.md#cache-invalidation) |
| `oracle:validation` | Input validation still enforced | `payer=INVALID` → `400` + `error` field | **P2** | same |
| `oracle:metrics` | Metrics not missing | `/v1/metrics` contains `oracle_verification` series | **P3** | [Monitoring §4.3](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/monitoring.md#oracle-service-performance--accuracy) |
| `oracle:staleness` | Not serving stale verdicts | `dataAgeMs ≤ maxOracleAgeMs` | **P2** | same |
| **Notifications** | | | | |
| `notifications:health` | Process up | `200` + `status:"ok"` | **P1** | [Signal-3](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/incident-response.md#signal-3-notification-service-failures) |
| `notifications:channel:email` | Email subscription path up | `POST /subscribe email` → `201`/`409` not `5xx`, rate-limit headers | **P1** | same |
| `notifications:channel:webhook` | Webhook dispatch up | `POST /test-webhook` → `success:true` or health proxy | **P1** | [Signal-4](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/incident-response.md#signal-4-webhook-delivery-errors) |
| `notifications:channel:sms` | SMS validation up | `POST /subscribe sms` with E.164 test number → not `5xx` | **P2** | [Signal-3](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/incident-response.md#signal-3-notification-service-failures) |
| `notifications:channel:websocket` | WS heartbeat | `ws://…/ws` → `type:"heartbeat"` | **P1** | same |
| `notifications:websocket:subscribe` | Real subscribe flow | `subscribe` → `unsubscribe` without `type:"error"` | **P2** | [Notifications arch](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/notifications.md#architectural-note-notifications-websocket-vs-indexer-subscription) |
| `notifications:subscription:roundtrip` | Full lifecycle works (not just health) | `POST /subscribe` → `GET /subscriptions/:addr` contains it → `POST /test-webhook` → `DELETE` | **P1** | [Signal-4](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/incident-response.md#signal-4-webhook-delivery-errors) |
| `notifications:analytics:shape` | Analytics not broken | `GET /analytics` keys non-empty | **P3** | [Monitoring §4.4](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/monitoring.md#signal-4-notifications-service--channel-health) |
| `notifications:channel-comparison` | Channel breakdown up | `/analytics/channel-comparison` shape valid | **P3** | same |
| `notifications:trends` | Trends not broken | `/analytics/trends?days=7` → `trends` present | **P3** | same |
| `notifications:rate-limit` | Rate limiter headers present | `X-RateLimit-*` on `POST /subscribe` | **P3** | [Notifications docs](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/notifications.md#rate-limits-and-delivery-guarantees) |
| `notifications:preferences` | Preferences not broken | `GET /preferences/:address` → not 5xx | **P3** | same |
| **Cross-service** | | | | |
| `cross:consistency:indexer-oracle` | Indexer ↔ Oracle agreement | `GET /v1/history/:payer` + `POST /v1/verify {payer}` both succeed, same payer, `trustScore` consistent | **P1** | [Scenario C](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/main/docs/incident-response.md#scenario-c-oracle-service-compromise-or-malfunction) |
| `cross:read-verify` | Read-then-verify-consistency flow | `GET /v1/invoice/:id` → `POST /v1/verify {payer}` | **P1** | same |

Each row is an individual `CheckResult` (`runAllCanaryChecks()` returns 26+ checks; `passed` is `every(c.passed)`). Every failure carries `runbookUrl` + `severity` so the workflow can page with a clickable runbook.

### On-demand execution

```bash
pnpm exec tsx scripts/synthetic-canary.ts
# env overrides
INDEXER_BASE_URL=https://indexer.iln.finance \
ORACLE_BASE_URL=https://oracle.iln.finance \
NOTIFICATIONS_BASE_URL=https://notifications.iln.finance \
tsx scripts/synthetic-canary.ts
```

### How failures page

- **Workflow**: `.github/workflows/synthetic-canary.yml` — `canary-unit-tests` (offline mocks) always runs; `canary-live-probe` runs when `INDEXER_BASE_URL` is set. On failure it:
  1. uploads `canary-output.log` as artifact (14-day retention),
  2. prints **direct runbook links** in the log group `🔗 Runbook links for failed checks`,
  3. emits a `::error title=Synthetic Canary Failed — P1::…` annotation (surfaces in PR/commit status),
  4. posts a JSON alert to `ALERT_WEBHOOK_URL` (Slack/PagerDuty) with `runbookUrl` + `severity` blocks, and (best-effort) opens a `incident,canary` GitHub issue.
- **Script**: `postAlert(message, runbookUrl, severity)` sends a Slack Block Kit payload with a `Runbook: <…|Open runbook>` button.
- **Local**: every failed line in stdout ends with `↳ https://github.com/…/incident-response.md#…`

### Off-line tests (CI without live services)

`tests/synthetic/canary.test.ts` spins up three local HTTP servers plus a `MockWebSocket` that emits a real heartbeat frame. All 26+ critical-path checks are exercised there (`pnpm vitest run tests/synthetic/canary.test.ts`). The mock servers implement pagination cursor, GraphQL parity, subscription lifecycle, cache behavior, and cross-service history so the critical-path assertions are tested without external dependencies.

---

## 7. Distributed Tracing — Shared Trace Context Across Services

> **Scope**: indexer, oracle-service, and notifications — exactly the three services in `docs/monitoring.md`'s scope. A latency spike or failure that bounces across those boundaries used to require manual log-correlation by timestamp; it now appears as a single trace.

### Mechanism

- **Propagation**: [W3C `traceparent`](https://www.w3.org/TR/trace-context/) (`00-${traceId}-${parentId}-${flags}`) + optional `tracestate`.
- **Generation**: if no inbound `traceparent` is present, `traceMiddleware(serviceName)` generates one (`00-${random16Bytes}-${random8Bytes}-01`), validates it via `TRACEPARENT_REGEX`, and reflects it in the response (`traceparent` + `X-Trace-Id`). If a valid `traceparent` is present, it is forwarded verbatim.
- **Storage**: `AsyncLocalStorage<TraceContext>` holds the active trace for the request lifetime; downstream `fetch` calls inherit it.
- **Span creation**: `traceMiddleware` opens a `SERVER` span per HTTP request (`http.method`, `http.route`, `trace.id`, `http.status_code`, `http.duration_ms`). Handlers that do cross-service I/O open `INTERNAL` spans via `withSpan('oracle.verify', {...})` or `withSpan('notifications.webhook.dispatch', {...})`.
- **Forwarding**: `propagateFetch(init)` injects `traceparent`/`tracestate` into outbound `fetch` headers; the oracle's `fetchJson` (history fetch from indexer) and notifications' `sendWebhook` both use it, so a canary's `cross:read-verify` traversal appears as one trace (`indexer: GET /v1/invoice/42` → `oracle: POST /v1/verify` with same `traceId`).

### Instrumented call paths (spans you will see in a trace view)

| Edge | Span name | Attributes sampled |
|------|-----------|---------------------|
| `indexer` inbound | `GET /v1/invoice/:id`, `GET /v1/invoices`, `POST /graphql`, etc. | `http.method`, `http.route`, `trace.id` |
| `oracle` inbound | `POST /v1/verify` (SERVER) + `oracle.verify` (INTERNAL) | `payer` (short), `invoiceId`, `cacheHit` |
| `oracle → indexer` | `fetchJson` inside `createHistoryProvider` | `http.url` (history URL), parent is `oracle.verify` |
| `notifications` inbound | `POST /subscribe`, `GET /subscriptions/:addr`, etc. | `http.*` |
| `notifications → webhook` | `notifications.webhook.dispatch` | `destination`, `trigger` |
| SDK (optional) | `ILNClient.*` | `iln.method`, `iln.invoice_id`, etc. (via `ILNInstrumentation`) |

### Backend wiring (queryable during incident response)

Traces are exported via OpenTelemetry OTLP. The services are backend-agnostic; the collector is configured by environment — the same code writes to **whichever you operate** (Tempo, Jaeger, Honeycomb, Datadog APM). The reference docker-compose (`docker-compose.yml`) runs `otel-collector` and forwards to `jaeger` for local dev.

```bash
# Production example — point any service at your collector:
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.iln.finance:4317   # gRPC
OTEL_SERVICE_NAME=indexer            # or oracle-service / notifications
OTEL_TRACES_SAMPLER=parentbased_always_on
# Optional: forward to Grafana Tempo and correlate with Prometheus exemplars
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=...,x-dataset=iln"
```

The shared package is `packages/opentelemetry` (`@iln/opentelemetry`). The middleware re-exports are:

```typescript
import { traceMiddleware, withSpan, propagateFetch, getCurrentTraceParent, isValidTraceParent } from '@iln/opentelemetry/tracing';
app.use(traceMiddleware('indexer'));               // must be first middleware
await withSpan('indexer.db.query', { 'iln.invoice_id': 42 }, async (span) => db.get(...));
await fetch(url, propagateFetch({ headers: {}, signal })); // forwards traceparent
```

When no OTEL SDK is configured (e.g. local `pnpm dev`), the helpers degrade to header-only propagation and emit no-op spans, so tracing never breaks the request path.

### Grafana query during an incident

1. **Metrics → Traces correlation**: in Grafana Explore pick the *Tempo* (or Jaeger) datasource → *Search* → filter `service.name = "oracle-service" && http.status_code = 500` → the matching trace shows the exact `indexer` call that preceded the oracle's outbound `fetchJson` (same `traceId`). Prometheus panels now expose exemplars: click the red dot on `rate(oracle_verification_duration_seconds_bucket)` to **jump directly to the trace** that caused the latency spike.
2. **Log correlation**: logs are enriched with `traceId` (`X-Trace-Id` response header). Search centralized logs (`Loki`) for `traceId=<32-hex>` to see every service that handled the same integrator request in chronological order — no timestamp correlation needed.
3. **Canary trace**: the synthetic canary propagates a fresh `traceparent` through `cross:read-verify`; filtering traces by `traceId` from `canary-output.log` shows the exact hop latency breakdown (`indexer: 42ms → oracle: 178ms`) used for the runbook.

### Environment variables (shared across services)

| Variable | Default | Purpose |
|----------|---------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (no export, header-only) | OTLP gRPC/HTTP endpoint of the collector. When set, spans are actually exported and visible in the backend. |
| `OTEL_SERVICE_NAME` | `traceMiddleware` arg (`indexer`/`oracle-service`/`notifications`) | `service.name` resource attribute |
| `OTEL_TRACES_SAMPLER` | `parentbased_always_on` | Sampling. Production uses `parentbased_traceidratio_0.1` for cost control. |
| `OTEL_TRACES_SAMPLER_ARG` | `0.1` | When ratio-based, sample 10% of root traces (every error trace is still flagged). |

### Operational note

This instrumentation is additive and has zero impact on existing dashboards: if the collector is down or unset, requests still succeed with header-only propagation. The critical-path canary asserts that `traceparent` is reflected (`traceparent` response header present) so a silent regression in propagation is itself a P2 canary failure.

---

## 8. Production Monitoring and Alert Configuration

This section specifies the production alert rules, health-probe sources, and operational runbooks for the five production signals required by the [Mainnet Launch Checklist](./mainnet-launch-checklist.md):

1. **Stellar RPC Node Health & Soroban Availability**
2. **Indexer Ledger Lag & Sync Degradation**
3. **Notification Service & Delivery Failures**
4. **Webhook Delivery Errors & Endpoint Failures**
5. **CI Release Failures & Provenance Failures**

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Monitoring Architecture                         │
└─────────────────────────────────────────────────────────────────────────────┘

    [ Stellar Horizon / Soroban RPC ]
                   ▲
                   │ (HTTP / JSON-RPC Probes)
                   ▼
  ┌─────────────────────────────────┐       ┌─────────────────────────────────┐
  │     Upptime Automated Prober    │       │     Prometheus / OpenTelemetry  │
  │   (.github/workflows/upptime.yml│       │       Metrics & Health Exporter │
  │        + .upptimerc.yml)        │       └────────────────┬────────────────┘
  └────────────────┬────────────────┘                        │
                   │                                         │
                   ▼                                         ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │                           Alert Routing Layer                             │
  │       (Slack Webhook / Discord / PagerDuty / GitHub Status Alerts)        │
  └───────────────────────────────────────────────────────────────────────────┘
```

---

## 8.1 Signal 1: RPC Health & Network Availability

### Signal Description
Probes the liveness and responsiveness of Stellar Horizon endpoints and Soroban RPC nodes for both testnet and mainnet environments.

### Monitoring Mechanism
1. **Upptime Automated Probing** (`.upptimerc.yml`):
   - `Stellar Horizon Testnet`: `GET https://horizon-testnet.stellar.org` (Interval: 5m)
   - `Stellar Horizon Mainnet`: `GET https://horizon.stellar.org` (Interval: 5m)
   - `Soroban RPC Endpoint`: `POST https://soroban-testnet.stellar.org` with `getHealth` and contract data probe (Interval: 5m)
2. **CI Pipeline Health Probing**:
   - Reusable workflow [`.github/workflows/reusable-testnet-health.yml`](../.github/workflows/reusable-testnet-health.yml) executes a 3-attempt validation with backoff before executing deployments or end-to-end integration runs.

### Alert Thresholds & Routing
- **Warning**: HTTP response time > 2500ms for 3 consecutive checks.
- **Critical**: HTTP status != 200 or connection failure / timeout > 5000ms.
- **Routing**: Notifications sent immediately to `#alerts-infra` Slack/Discord channel via `NOTIFICATION_SLACK` in Upptime workflow.

### Triage Runbook
1. Check Stellar network status on [Stellar Dashboard](https://dashboard.stellar.org).
2. Failover to secondary RPC provider (e.g. Validation Cloud / Ankr) by updating `RPC_URL`.
3. If self-hosted, verify quickstart container logs and Horizon ledger ingestion stream.

---

## 8.2 Signal 2: Indexer Lag & Ingestion Health

### Signal Description
Monitors the gap between the latest closed ledger on Stellar and the indexer's latest processed cursor ledger (`lastSync`).

### Monitoring Mechanism
1. **Health API Endpoint** (`GET /health` & `GET /dashboard` on Indexer):
   ```json
   {
     "status": "ok",
     "db": "ok",
     "lastSync": "2026-08-26T15:20:00.000Z",
     "uptime": 3600000
   }
   ```
2. **Dashboard Metrics** (`GET /dashboard`):
   - `sync.syncLag`: Difference (in seconds) between current server time and `lastSync` timestamp.
   - `sync.isSyncing`: Boolean indicating active polling state.
   - `performance.dbQueryAvgTime`: Database read/write latency.
3. **Automated Ping Probe**:
   - Upptime checks indexer `/health` endpoint every 5 minutes and validates HTTP 200 and `"db": "ok"`.

### Alert Thresholds & Routing
- **Warning**: `syncLag > 60s` (Indexer is falling behind latest ledger closure).
- **Critical**: `syncLag > 300s` or `"status": "degraded"` or `"db": "error"`.
- **Routing**: PagerDuty / Slack `#alerts-indexer`.

### Triage Runbook
1. Query indexer `/health` and `/dashboard` endpoints.
2. Inspect indexer logs for RPC rate-limiting errors (`429 Too Many Requests`) or connection timeouts.
3. Verify SQLite database lock status (`SQLITE_BUSY`) or disk write capacity.
4. If indexer process is stalled, restart the service or execute replay from last confirmed cursor checkpoint.

---

## 8.3 Signal 3: Notification Service Failures

### Signal Description
Monitors internal service health, queue backlogs, SMS/Email provider connectivity, and digest scheduling failures.

### Monitoring Mechanism
1. **Health Endpoint** (`GET /health` on Notification Service):
   - Returns `{ "status": "ok" }` when the internal poller and dispatch engine are operational.
2. **Delivery Analytics API** (`GET /analytics` & `GET /analytics/trends`):
   - Tracks total sent, failed, retry counts, and success rates across all notification channels (`email`, `sms`, `webhook`).
3. **Queue & Error Logging**:
   - Processor error logs capture template render failures, invalid destination errors, and provider rate-limits.

### Alert Thresholds & Routing
- **Warning**: Channel failure rate > 5% over 15-minute sliding window.
- **Critical**: Service `/health` endpoint unreachable or failure rate > 20%.
- **Routing**: Slack `#alerts-notifications`.

### Triage Runbook
1. Inspect `GET /analytics` for delivery error categorization (e.g. SMTP connection failure, Twilio SMS balance/rate-limit).
2. Check `notifications.db` for stuck delivery tasks.
3. Validate third-party API credentials (`TWILIO_AUTH_TOKEN`, `SMTP_PASSWORD`).

---

## 8.4 Signal 4: Webhook Delivery Errors

### Signal Description
Monitors HTTP delivery failure rates, retry exhaustion, and signature/timeout errors when delivering event webhooks to subscriber endpoints.

### Monitoring Mechanism
1. **Webhook Delivery Logs & Status** (`GET /subscriptions/:id/logs`):
   - Inspect status codes, response headers, delivery duration, and retry attempts for every webhook payload.
2. **Channel Comparison & Trends Endpoint** (`GET /analytics/channel-comparison`):
   - Aggregates webhook delivery success vs failure counts and average latencies.
3. **Diagnostic Test Webhook API** (`POST /test-webhook`):
   - Direct execution probe for verifying delivery pipeline end-to-end against a test destination.

### Alert Thresholds & Routing
- **Warning**: Consecutive webhook delivery failures across subscribers > 10% within 10 minutes.
- **Critical**: Global webhook dispatcher failure or systematic SSRF filter false-positive blocks.
- **Routing**: Slack `#alerts-notifications`.

### Triage Runbook
1. Inspect webhook delivery logs for HTTP error codes (e.g., 4xx subscriber endpoint errors vs 5xx timeout/network errors).
2. Confirm subscriber endpoint is reachable and not blocking ILN User-Agent or IP ranges.
3. Ensure exponential backoff and dead-letter retry queues are draining normally.

---

## 8.5 Signal 5: CI Release & Workflow Failures

### Signal Description
Monitors automated release pipelines, SLSA provenance generation, package publishing to npm, and scheduled security/backup workflows.

### Monitoring Mechanism
1. **Release Pipeline Monitoring** [`.github/workflows/release.yml`](../.github/workflows/release.yml) and [`.github/workflows/sdk-release.yml`](../.github/workflows/sdk-release.yml):
   - Automated failure notifications on release jobs.
   - SLSA build provenance verification step using `actions/attest-build-provenance`.
2. **Nightly & Scheduled Workflows**:
   - Indexer nightly backup ([`.github/workflows/indexer-backup.yml`](../.github/workflows/indexer-backup.yml)) with automated GitHub script failure warning.
   - E2E nightly regression suite ([`.github/workflows/e2e-nightly.yml`](../.github/workflows/e2e-nightly.yml)).
   - Snyk scheduled vulnerability scans ([`.github/workflows/snyk.yml`](../.github/workflows/snyk.yml)).

### Alert Thresholds & Routing
- **Warning**: Scheduled nightly backup or E2E workflow failure.
- **Critical**: Release workflow failure during tag publishing, npm token authentication failure, or SLSA provenance generation rejection.
- **Routing**: GitHub Actions failure notifications + maintainer release team dispatch.

### Triage Runbook
1. Review GitHub Actions workflow execution logs.
2. Check `NPM_TOKEN` and `RELEASE_PAT` validity in repository secrets.
3. For provenance errors, confirm OIDC token permissions (`id-token: write`) on release jobs.

---

## Summary Status Table

| Signal | Monitored Target | Probe / Metric Source | Alert Threshold | Target Runbook |
|---|---|---|---|---|
| **RPC Health** | Stellar Horizon & Soroban RPC | Upptime + `reusable-testnet-health.yml` | > 2.5s latency or non-200 | Switch RPC / Check SDF status |
| **Indexer Lag** | SQLite cursor vs Stellar ledger | `/health`, `/dashboard` (`syncLag`) + canary `indexer:health:freshness` | > 60s warning, > 300s critical | Check RPC / DB lock / Replay |
| **Notification Failures**| Email / SMS / Internal poller | `/health`, `/analytics` + canary `notifications:*` | > 5% error rate | Check provider API keys & queues |
| **Webhook Errors** | Subscriber HTTP endpoints | `/subscriptions/:id/logs`, `/analytics` + canary `notifications:subscription:roundtrip` | > 10% delivery failure | Check retry queue & dead-letter |
| **CI Release Failures** | Release workflows & provenance | GitHub Actions (`release.yml`, etc.) | Any workflow exit code != 0 | Check secrets / OIDC / build logs |
| **Trace Health** | Cross-service latency / errors | Tempo/Jaeger + `traceparent` exemplars | trace error rate > 1% | Query traces via `traceId` in logs |
