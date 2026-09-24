# Postmortem: Game-Day #1 Oracle Cache Malfunction & Badge State Mismatch

**Date**: 2026-08-30  
**Severity**: P1 (Simulated Game-Day Exercise)  
**Status**: APPROVED  
**Incident Commander**: @adetomiwa21  
**Lead Author**: @adetomiwa21  
**Impacted Repositories**: `Invoice-Liquidity-Network` (Main Repo), `ILN-Frontend` (Frontend Repo), `ILN-Smart-Contract` (Contract Repo)  

---

## 1. Executive Summary

During Cross-Repo Game-Day Exercise #1, a simulated schema change in external invoice verification signals caused the main repo's `oracle-service` to cache malformed verification payload signatures. 

While the `ILN-Smart-Contract` Soroban smart contracts functioned 100% correctly on-chain, the `ILN-Frontend` dApp displayed incorrect **"VERIFICATION FAILED"** red warning badges to users. 

The incident was detected via automated Upptime probes in 3 minutes 15 seconds, mitigated in 14 minutes by enabling oracle cache bypass, and fully resolved in 22 minutes via hotfix deployment and cache invalidation.

---

## 2. Impact & SLO Budget Depletion

- **User Impact**: 12% of active dApp UI users observed incorrect red warning badges on legitimate invoice cards.
- **Total Incident Duration**: 22 minutes (Detection-to-resolution cycle).
- **SLO Impact**:
  - Oracle Service Verification Latency SLO (p95 < 150ms): Depleted **4.2%** of monthly error budget.
  - Oracle Service Availability SLO (99.95%): Depleted **12.5%** of monthly error budget (2.7 minutes downtime equivalent).
  - Indexer Lag SLO: No impact (Sync lag remained < 5.0s).

---

## 3. Incident Timeline (2026-08-30 UTC)

- `10:00:00` - Fault injected into `oracle-service` cache key generation logic.
- `10:03:15` - Upptime probe and Prometheus alert `FrontendBadgeErrorSpike` fired.
- `10:07:00` - Incident Commander opened war room `#incident-20260830-gameday` with Contract, Main Repo, and Frontend leads.
- `10:09:30` - Contract team confirmed Soroban RPC state OK; issue isolated to Main Repo `oracle-service`.
- `10:14:00` - Main Repo team toggled `ORACLE_BYPASS_CACHE=true`, restoring Frontend UI badge state to retriable loading.
- `10:18:30` - Hotfix PR merged enforcing Zod runtime schema validation on cached payloads.
- `10:22:00` - Patch deployed to production, cache flushed, all Frontend badges restored to "VERIFIED". Incident closed.

---

## 4. Root Cause Analysis (5 Whys)

1. **Why did Frontend display red "VERIFICATION FAILED" badges?**  
   Because the dApp UI received HTTP 200 OK responses containing malformed oracle payload signatures.
2. **Why were the oracle payload signatures malformed?**  
   Because the `oracle-service` cached invalid payloads generated during an external provider schema change.
3. **Why did `oracle-service` cache invalid payloads?**  
   Because the cache writer did not validate payload schema prior to writing to Redis.
4. **Why was schema validation omitted before caching?**  
   Because runtime validation was only performed on incoming requests, assuming external data provider structures were immutable.
5. **Why was this single point of failure not caught earlier? (Root Cause)**  
   Lack of strict runtime Zod contract boundary validation and missing cross-repo integration tests between oracle cache generation and frontend badge status components.

---

## 5. Cross-Repo Cascading Effects & Technical Breakdown

```
[ External Data Provider ]
          │ Schema change
          ▼
[ Main Repo: oracle-service ] (Originating Defect)
  - Cached malformed signature without schema check
          │
          │ HTTP 200 (Malformed payload)
          ▼
[ ILN-Frontend Repo ] (Cascading Failure)
  - Received 200 OK, failed signature parse
  - UI displayed "VERIFICATION FAILED" badge
          │
          ▼
[ ILN-Smart-Contract Repo ] (Unaffected Core)
  - Soroban smart contract logic was 100% healthy
```

---

## 6. Action Items (Corrective & Preventative)

| Action Item | Type | Assigned Owner | Target Repo | Due Date | Status |
|---|---|---|---|---|---|
| Enforce strict Zod schema validation before writing to Oracle cache | Preventative | @adetomiwa21 | `Invoice-Liquidity-Network` | 2026-09-02 | DONE |
| Add 3-step cross-repo triage flowchart to incident runbook | Corrective | @adetomiwa21 | `Invoice-Liquidity-Network` | 2026-09-01 | DONE |
| Implement Frontend dApp UI fallback state for unrecognized oracle codes | Corrective | @iln-frontend-lead | `ILN-Frontend` | 2026-09-05 | IN_PROGRESS |
| Add contract oracle signature age & schema validation assertion | Preventative | @iln-contract-lead | `ILN-Smart-Contract` | 2026-09-05 | IN_PROGRESS |
