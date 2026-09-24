# Cross-Repo Incident Response Runbook

This document defines the unified, cross-repo incident response runbook for the Invoice Liquidity Network (ILN) ecosystem, spanning `Invoice-Liquidity-Network` (main repo / services), `ILN-Frontend` (dApp UI), and `ILN-Smart-Contract` (Soroban contracts).

---

## 1. Unified Incident Triage Protocol

When an alert fires or an incident is reported, engineers MUST follow this 3-step isolation sequence to determine ownership across repo boundaries:

```
                          ┌─────────────────────────┐
                          │  P1 / P2 Alert Trigger  │
                          └────────────┬────────────┘
                                       │
                                       ▼
                       ┌───────────────────────────────┐
                       │  Step 1: Check Smart Contract │
                       │  (Stellar Horizon / Soroban)  │
                       └───────────────┬───────────────┘
                                       │
                      Is ledger advancing / contract OK?
                                      │
                   ┌──────────────────┴──────────────────┐
                   │ YES                                 │ NO
                   ▼                                     ▼
     ┌───────────────────────────┐         ┌───────────────────────────┐
     │  Step 2: Check Main Repo  │         │  Escalate to Contract     │
     │  Services (Indexer/Oracle)│         │  Team (#incident-contract)│
     └─────────────┬─────────────┘         └───────────────────────────┘
                   │
    Are API payloads / sync lag OK?
                   │
        ┌──────────┴──────────┐
        │ YES                 │ NO
        ▼                     ▼
┌───────────────┐     ┌────────────────────────────────┐
│ Step 3: Check │     │ Escalate to Main Repo Team     │
│ Frontend UI   │     │ (#incident-main-repo)          │
└───────────────┘     └────────────────────────────────┘
```

### Step 1: Smart Contract Layer Check (`ILN-Smart-Contract`)
- **Query**: Run Horizon / Soroban RPC health probe: `POST /soroban/rpc` -> `getHealth()`.
- **Validation**: Verify that ledger sequence numbers are advancing every ~5s and contract calls do not revert due to contract state corruption.
- **Outcome**: If RPC/Contract is failing, escalate immediately to the Contract Team.

### Step 2: Main Repo Services Check (`Invoice-Liquidity-Network`)
- **Indexer Check**: `GET http://indexer-service/health` -> verify `syncLag < 60s` and `status: "ok"`.
- **Oracle Check**: `GET http://oracle-service/health` -> verify `status: "ok"` and p95 latency `< 150ms`.
- **Notifications Check**: `GET http://notification-service/health` -> verify queue backlog is draining.
- **Outcome**: If service APIs are degraded, execute the corresponding Service Recovery Playbook below.

### Step 3: Frontend Layer Check (`ILN-Frontend`)
- **Validation**: Inspect client-side console logs, network response headers, and cached SDK state.
- **Outcome**: If Contract and Main Repo APIs return valid responses but UI fails to render, escalate to the Frontend Team.

---

## 2. Escalation & Incident Roles

| Role | Responsibility | Primary Contact |
|---|---|---|
| **Incident Commander (IC)** | Leads incident response war-room, manages cross-repo communications, approves mitigations. | On-call SRE (`@sre-oncall`) |
| **Main Repo On-Call** | Triages Indexer, Oracle, and Notification microservices. | On-call Backend (`@backend-oncall`) |
| **Contract On-Call** | Triages Soroban Rust contract invocations, ledger event parsing, WASM state. | On-call Smart Contract (`@contract-oncall`) |
| **Frontend On-Call** | Triages dApp rendering, SDK integrations, wallet connection, UI toasts. | On-call Frontend (`@frontend-oncall`) |

---

## 3. Service Recovery Playbooks (Main Repo)

### 3.1 Oracle Service Malfunction Recovery Playbook
*Target Issue: Oracle returns corrupted payloads or high verification latency (Ref: Game-Day Exercise #1).*

1. **Activate Cache Bypass**:
   ```bash
   # Enable emergency cache bypass via environment or feature flag
   curl -X POST http://oracle-service/admin/flags -H "Authorization: Bearer $ADMIN_KEY" -d '{"ORACLE_BYPASS_CACHE": true}'
   ```
2. **Flush Corrupted Cache Key Space**:
   ```bash
   redis-cli -h redis-oracle.internal KEYS "oracle:verification:*" | xargs redis-cli -h redis-oracle.internal DEL
   ```
3. **Verify Upstream Data Provider**:
   Verify provider API status (e.g. Stellar Horizon / external invoice verifier).
4. **Deploy Schema Validation Patch**:
   Ensure all returned payloads pass strict Zod runtime verification before serving clients.

### 3.2 Indexer Sync Degradation Recovery Playbook
*Target Issue: Indexer lag exceeds SLO target (> 60s warning / > 300s critical).*

1. **Check Ledger Cursor**:
   ```bash
   curl -s http://indexer-service/health | jq '.lastSync'
   ```
2. **Restart Ingestion Pipeline**:
   ```bash
   kubectl rollout restart deployment/indexer-worker -n production
   ```
3. **Trigger Catchup Replay**:
   If indexer cursor is stuck on a reorg or broken block, replay from last known checkpoint:
   ```bash
   pnpm --filter @iln/indexer replay --from-ledger $LAST_GOOD_LEDGER
   ```

### 3.3 Notification Delivery Failure Recovery Playbook
*Target Issue: Delivery failure rate > 5% or webhook delivery retry exhaustion.*

1. **Inspect Dead-Letter Queue (DLQ)**:
   ```bash
   pnpm --filter @iln/notifications dlq:status
   ```
2. **Verify Provider Credentials**:
   Validate SMTP, Twilio, and HTTP Webhook egress connectivity.
3. **Replay DLQ Payload Tasks**:
   ```bash
   pnpm --filter @iln/notifications dlq:replay --batch-size 100
   ```

---

## 4. Cross-Repo Game-Day & Postmortem Integration

- **Game-Day Rehearsal Cadence**: Game-day exercises MUST be run bi-monthly across all three repos. Reports are stored in [`docs/game-days/`](../game-days/).
- **Shared Postmortem Process**: All P1 and severe P2 cross-repo incidents MUST produce a shared postmortem record stored in the canonical postmortem directory [`docs/postmortems/`](../postmortems/).
