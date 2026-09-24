# Postmortem: [Incident Title]

**Date**: YYYY-MM-DD  
**Severity**: P1 / P2 / P3  
**Status**: DRAFT / IN_REVIEW / APPROVED  
**Incident Commander**: @username  
**Lead Author**: @username  
**Impacted Repositories**: `Invoice-Liquidity-Network` | `ILN-Frontend` | `ILN-Smart-Contract`  

---

## 1. Executive Summary

Brief 2-3 sentence overview of what happened, root cause, impact to users, and resolution.

---

## 2. Impact & SLO Budget Depletion

- **User Impact**: (e.g. 12% of dApp users displayed invalid verification badges)
- **Downtime / Degradation Duration**: XX minutes
- **SLO Impact**:
  - Indexer Lag SLO: Depleted XX% of monthly error budget
  - Oracle Service Latency SLO: Depleted XX% of monthly error budget
  - Service Availability: XX%

---

## 3. Incident Timeline (UTC)

- `HH:MM` - Incident injected / defect triggered
- `HH:MM` - First alert fired (`[Alert Name]`)
- `HH:MM` - Incident Commander opened war room
- `HH:MM` - Root cause isolated to [Service / Component]
- `HH:MM` - Mitigation applied ([Feature flag / Fallback])
- `HH:MM` - Permanent patch deployed and verified
- `HH:MM` - Incident resolved

---

## 4. Root Cause Analysis (5 Whys)

1. **Why did the incident occur?**  
   Answer 1
2. **Why?**  
   Answer 2
3. **Why?**  
   Answer 3
4. **Why?**  
   Answer 4
5. **Why? (Root Cause)**  
   Answer 5

---

## 5. Cross-Repo Cascading Effects & Technical Breakdown

Explain how the failure originated in one repo and propagated to downstream repos.

---

## 6. Action Items (Corrective & Preventative)

| Action Item | Type | Assigned Owner | Target Repo | Due Date | Status |
|---|---|---|---|---|---|
| Enforce strict Zod schema validation before caching | Preventative | @backend-lead | `Invoice-Liquidity-Network` | YYYY-MM-DD | TODO |
| Add dApp UI fallback state for unrecognized oracle codes | Corrective | @frontend-lead | `ILN-Frontend` | YYYY-MM-DD | TODO |
| Add smart contract oracle payload freshness check | Preventative | @contract-lead | `ILN-Smart-Contract` | YYYY-MM-DD | TODO |
