# Service Level Objectives (SLOs) & Service Level Indicators (SLIs)

This document establishes the authoritative Service Level Objectives (SLOs), Service Level Indicators (SLIs), Error Budgets, and Cross-Repo Dependencies for the services hosted within the main `Invoice-Liquidity-Network` repository.

These numbers serve as the single source of truth (SSOT) referenced by downstream repositories (including `ILN-Frontend` and `ILN-Smart-Contract`) for downtime resilience, lag tolerance, and verification latency expectations.

---

## 1. Overview & Service Scope

The main repository hosts three core operational microservices:

1. **Indexer Service** (`@iln/indexer`): Ingests Stellar/Soroban ledgers, indexes invoice lifecycle events, and serves read APIs for contract state.
2. **Oracle Service** (`@iln/oracle-service`): Fetches off-chain invoice validation signals, generates cryptographic proof payloads, and provides verification badge state.
3. **Notification Service** (`@iln/notifications`): Processes event triggers and dispatches notifications via Email, SMS, and HTTP Webhooks.

---

## 2. Authoritative Service Level Objectives (SLOs)

All SLOs are evaluated over a **30-day rolling measurement window**.

| Service | Category | Objective / Target | SLI Metric & Formula | Error Budget (30-day) | Severity / Alert Trigger |
|---|---|---|---|---|---|
| **Indexer** | Ingestion Lag | **< 5.0s** for **99.9%** of ledgers | `(ledgers ingested with lag < 5.0s / total ledgers) * 100` | 0.1% of ledgers (~43.2 min lag spike/mo) | **P1 Critical**: Lag > 60s for 5m<br>**P2 Warning**: Lag > 15s for 10m |
| **Indexer** | API Latency | **p95 < 200ms**, **p99 < 500ms** | `p95(http_request_duration_seconds{service="indexer"})` | 5% requests > 200ms | **P2 Warning**: p95 > 250ms for 15m |
| **Indexer** | Service Availability | **99.9% Uptime** | `(successful GET /health probes / total probes) * 100` | 43.2 minutes downtime / month | **P1 Critical**: Downtime > 5 consecutive probes (5m) |
| **Oracle Service** | API Verification Latency | **p95 < 150ms**, **p99 < 400ms** | `p95(http_request_duration_seconds{service="oracle-service"})` | 5% requests > 150ms | **P1 Critical**: p95 > 500ms for 5m<br>**P2 Warning**: p95 > 200ms for 10m |
| **Oracle Service** | Service Availability | **99.95% Uptime** | `(successful GET /health probes / total probes) * 100` | 21.6 minutes downtime / month | **P1 Critical**: 3 failed health probes (3m) |
| **Notification Service** | API Request Latency | **p95 < 200ms**, **p99 < 500ms** | `p95(http_request_duration_seconds{service="notifications"})` | 5% requests > 200ms | **P2 Warning**: p95 > 300ms for 15m |
| **Notification Service** | Delivery Latency | **p95 < 10.0s** across all channels | `p95(notification_dispatch_to_delivery_seconds)` | 5% dispatches > 10s | **P2 Warning**: p95 delivery > 20s for 15m |
| **Notification Service** | Delivery Success Rate | **99.5% Success** | `(successful notification dispatches / total dispatches) * 100` | 0.5% failed dispatches | **P1 Critical**: Failure rate > 5% over 15m |
| **Notification Service** | Service Availability | **99.9% Uptime** | `(successful GET /health probes / total probes) * 100` | 43.2 minutes downtime / month | **P1 Critical**: Downtime > 5 consecutive probes (5m) |

---

## 3. Service Level Indicator (SLI) Technical Definitions

### 3.1 Indexer Ingestion Lag SLI
- **Definition**: The elapsed time between a Stellar/Soroban ledger being closed by consensus and the indexer completing database commit for all events in that ledger.
- **Metric Name**: `indexer_ledger_ingestion_lag_seconds`
- **Target Threshold**: $L_{\text{target}} \le 5.0\text{ seconds}$
- **Formula**:
  $$\text{SLI}_{\text{lag}} = \frac{\sum \text{ledgers with } (\text{Timestamp}_{\text{commit}} - \text{Timestamp}_{\text{ledger\_close}}) \le 5.0\text{s}}{\sum \text{total ledgers processed}} \times 100\%$$

### 3.2 Oracle Service Verification Latency SLI
- **Definition**: Time spent validating off-chain invoices and producing signed verification payloads for clients or contracts.
- **Metric Name**: `oracle_verification_duration_seconds`
- **Target Threshold**: $\text{p95} \le 150\text{ms}, \text{p99} \le 400\text{ms}$
- **Formula**:
  $$\text{SLI}_{\text{oracle\_latency}} = \text{histogram\_quantile}(0.95, \text{sum(rate}(\text{oracle\_verification\_duration\_seconds\_bucket}[5\text{m}])) \text{ by } (\text{le}))$$

### 3.3 Notification Delivery Latency SLI
- **Definition**: Elapsed duration from when an event trigger is ingested by the notification worker to when the target recipient's provider (SMTP server, Twilio SMS API, or subscriber HTTP webhook endpoint) accepts the payload with a 2xx response.
- **Metric Name**: `notification_delivery_duration_seconds`
- **Target Threshold**: $\text{p95} \le 10.0\text{s}$

---

## 4. Cross-Repo Authoritative References

Downstream repositories reference these authoritative numbers to define their resilience, caching, fallback UI, and timeout strategies.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Authoritative Cross-Repo SLO Mapping                     │
└─────────────────────────────────────────────────────────────────────────────┘

 [ Main Repo: docs/slos.md ] (Authoritative SSOT)
   ├── Indexer Ingestion Lag: < 5.0s (99.9%)
   ├── Indexer API Latency: p95 < 200ms
   ├── Oracle Verification Latency: p95 < 150ms
   └── Notification Delivery Latency: p95 < 10.0s
            │
            ├───────────────► [ ILN-Frontend Repo ]
            │                 ├── Indexer Downtime Resilience Cache: 15s window (3x 5s lag)
            │                 ├── Oracle Badge Verification Timeout: 2.0s (13x 150ms p95)
            │                 └── Polling Interval: 10s (matches notification delivery p95)
            │
            └───────────────► [ ILN-Smart-Contract Repo ]
                              ├── Off-chain Oracle Verification TTL: 300s
                              └── Event Emit-to-Index Expected Window: < 5.0s
```

### 4.1 Frontend Repository (`ILN-Frontend`) References
- **Indexer Downtime Resilience**: The frontend optimistic UI state cache uses a fallback window of **15 seconds** based on the indexer's authoritative **5.0s (99.9%)** lag target plus 3x retry padding.
- **Verification Badge Latency**: Verification badge spinners time out at **2.0s** (authoritative Oracle p95 latency is **150ms**, allowing headroom for client network overhead).
- **Notification Toast Polling**: Toast update polling is configured to **10s**, aligning with the notification delivery p95 target.

### 4.2 Smart Contract Repository (`ILN-Smart-Contract`) References
- **Oracle Verification Signature TTL**: Contract invoice verification functions enforce an oracle signature age ceiling of **300 seconds**, accommodating the 99.95% availability SLO and 150ms verification latency.
- **Event-to-Index SLA**: Contract event emissions assume an upper indexing delay bound of **5.0s** before state queries reflect contract changes.

---

## 5. Error Budget & Burn Rate Policy

### 5.1 Error Budget Calculation
Error budgets are calculated based on the 30-day window ($30 \times 24 \times 60 = 43,200\text{ minutes}$):

- **99.95% Availability**: Budget = $43,200 \times 0.0005 = 21.6\text{ minutes}$ allowed downtime.
- **99.90% Availability**: Budget = $43,200 \times 0.0010 = 43.2\text{ minutes}$ allowed downtime.
- **99.50% Success Rate**: Budget = $0.5\%$ failed transactions/notifications.

### 5.2 Burn Rate Alerting Rules
- **Fast Burn (2% budget consumed in 1 hour)**: Fires **P1 Critical Page** to on-call engineer.
- **Slow Burn (5% budget consumed in 6 hours)**: Creates **P2 High Ticket** for next-business-day triage.
- **Budget Exhaustion Action**: When 100% of an error budget is depleted, non-critical feature deployments for that service are frozen until budget replenishes.

---

## 6. Review & Maintenance Cadence

- **Monthly Review**: SLO compliance is reviewed on the 1st of every month during the observability sync.
- **Quarterly Recalibration**: SLO targets are adjusted based on rolling 90-day performance trends and architecture updates.
