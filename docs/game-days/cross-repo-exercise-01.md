# Cross-Repo Game-Day Exercise #1 Execution Report

**Date**: 2026-08-30  
**Exercise Lead**: Lead Site Reliability Engineer  
**Participating Repositories & Teams**:
1. `Invoice-Liquidity-Network` (Main Repo / Backend & Service Maintainers)
2. `ILN-Frontend` (Frontend / dApp Maintainers)
3. `ILN-Smart-Contract` (Contract / Soroban Core Maintainers)

---

## 1. Scenario Overview

### "The Phantom Verification Badge Incident"
A simulated production defect was injected where the `oracle-service` in the main repo experienced cache corruption following an upstream external API schema change. 

- **Contract Repo Behaviour (`ILN-Smart-Contract`)**: Functioned **100% correctly**. On-chain state mutations and invoice verification function invocations were valid.
- **Main Repo Behaviour (`Invoice-Liquidity-Network`)**: The `oracle-service` cached stale/malformed verification signatures, returning HTTP 200 with an invalid verification status payload.
- **Frontend Repo Behaviour (`ILN-Frontend`)**: Displayed **"VERIFICATION FAILED"** red warning badges on legitimate invoice cards in the dApp UI due to parsing the malformed oracle payload without fallback validation.

This scenario was specifically designed to test cross-repo team coordination, root-cause isolation across system boundaries, and detection-to-resolution timing.

---

## 2. Telemetry & Detection Metrics

- **Injection Timestamp**: `2026-08-30T10:00:00Z` (T+00:00)
- **First Alert Trigger**: `2026-08-30T10:03:15Z` (T+03:15) — Upptime & Prometheus alert `OracleServiceLatencyHigh` & `FrontendBadgeErrorSpike`
- **Mean Time To Detect (MTTD)**: **3 minutes 15 seconds**
- **Mean Time To Acknowledge (MTTA)**: **3 minutes 45 seconds** (Incident Commander acknowledged P1 page at T+07:00)
- **Mean Time To Mitigate (MTTM)**: **7 minutes 00 seconds** (T+14:00 - Fallback oracle cache bypass enabled)
- **Mean Time To Resolve (MTTR)**: **8 minutes 00 seconds** (T+22:00 - Oracle patch deployed & frontend UI cache invalidated)
- **Total Detection-to-Resolution Cycle**: **22 minutes 00 seconds**

---

## 3. Detailed Incident Timeline

```
[00:00] Injected malformed payload into Oracle cache simulator.
   │
[00:03] PagerDuty P1 fires: Frontend error rate spike (12% badge failure).
   │
[00:07] Cross-repo incident room assembled (#incident-20260830-gameday).
   │   ├── Contract Team verifies Soroban ledger status: OK.
   │   ├── Frontend Team confirms dApp UI receiving 200 OK with bad payload.
   │   └── Main Repo Team isolates defect to oracle-service cache key generation.
   │
[00:14] Mitigation: Main repo on-call triggers emergency Oracle cache bypass flag.
   │   └── Frontend badge status recovers to "PENDING RE-VERIFICATION".
   │
[00:22] Resolution: Oracle hotfix deployed to clear malformed cache key format.
       All badges in Frontend show "VERIFIED". Incident closed.
```

| Time Elapsed | Phase | Action / Event | Cross-Repo Handshake |
|---|---|---|---|
| **T+00:00** | Injection | Fault injected: `oracle-service` invalid signature generator activated. | — |
| **T+03:15** | Alerting | Automated canary probe (`.github/workflows/upptime.yml`) and Prometheus rule trigger alert. | Alert routed to `#alerts-all-repos` Slack. |
| **T+07:00** | Triage | On-call engineers from Contract, Main Repo, and Frontend join incident war room. | Initial triage matrix checked: Contract vs Service vs UI. |
| **T+09:30** | Isolation | Contract team confirms Soroban RPC functions returning valid data. Issue isolated to Main Repo `oracle-service`. | Main Repo team takes lead on fix; Frontend prepares cache flush. |
| **T+14:00** | Mitigation | Main Repo team flips feature toggle `ORACLE_BYPASS_CACHE=true`. | Frontend team validates badge state fallback to optimistic loading. |
| **T+18:30** | Patching | Main Repo team merges patch clearing invalid cache entries and enforcing schema validation. | CI release workflow triggered. |
| **T+22:00** | Verification | End-to-end verification confirmed across contract, backend, and dApp UI. | Incident Commander declares incident resolved. |

---

## 4. Key Findings & Cross-Repo Runbook Fixes

1. **Finding 1 (Cross-Repo Diagnostic Lag)**: Initial alert came from Frontend telemetry, causing 4 minutes spent checking frontend code before verifying the Oracle API payload.
   - **Fix Applied**: Updated `docs/runbooks/incident-response.md` with a mandatory 3-step triage flowchart (Check Contract Ledger -> Check Main Repo Services -> Check Frontend UI).
2. **Finding 2 (Payload Schema Mismatch)**: `oracle-service` did not strictly validate response schema prior to caching.
   - **Fix Applied**: Enforced strict Zod schema validation on all oracle response payloads before caching.
3. **Finding 3 (Frontend Graceful Degradation)**: Frontend displayed a hard failure state instead of a retriable warning when receiving unrecognized oracle codes.
   - **Fix Applied**: Added fallback state handling to Frontend runbook and dApp verification badge component.

---

## 5. Game-Day Sign-off

- **Incident Commander**: @adetomiwa21 (Lead SRE)
- **Main Repo Lead**: @adetomiwa21 (Backend Engineer)
- **Frontend Lead**: @iln-frontend-lead
- **Contract Lead**: @iln-contract-lead
