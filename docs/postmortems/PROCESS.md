# Shared Cross-Repo Postmortem Process Guide

This guide details the operational lifecycle for creating, reviewing, publishing, and tracking postmortems across `Invoice-Liquidity-Network` (main repo), `ILN-Frontend`, and `ILN-Smart-Contract`.

---

## 1. When is a Postmortem Required?

A cross-repo postmortem MUST be conducted whenever an incident meets any of the following criteria:

1. **Severity P1 (Critical)**: Any outage or state corruption lasting > 5 minutes.
2. **Multi-Repo Propagation**: An incident where a fault originating in one repo degraded functionality in another repo (e.g. Oracle malfunction impacting Frontend UI or Contract event indexer lag breaking dApp status).
3. **SLO Error Budget Depletion**: Depletion of > 10% of a service's monthly error budget in a single event.
4. **Game-Day Exercises**: All cross-repo game-day exercises MUST produce a postmortem record applied retroactively.

---

## 2. Postmortem Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Postmortem Operational Lifecycle                     │
└─────────────────────────────────────────────────────────────────────────────┘

  [ 1. Incident Resolution ]
            │
            ▼
  [ 2. Draft Postmortem ] ──► Copy TEMPLATE.md to docs/postmortems/YYYY-MM-DD-title.md
            │
            ▼
  [ 3. Cross-Repo Review ] ──► Async review in GitHub PR with all 3 repo leads
            │
            ▼
  [ 4. Postmortem Meeting ] ──► 30-min blameless walkthrough & action item triage
            │
            ▼
  [ 5. Publish & Track ] ──► Merge PR, update README.md index, track action items
```

### Step 1: Draft Creation (Within 24 Hours)
The Incident Commander (IC) creates a new file in `docs/postmortems/` using the naming format:
`YYYY-MM-DD-<short-description>.md` (e.g. `2026-08-30-cross-repo-game-day-oracle-malfunction.md`).

### Step 2: Cross-Repo Async Review (Within 48 Hours)
The draft PR is tagged with `postmortem` and reviewers are assigned from each affected repository team:
- `Invoice-Liquidity-Network` maintainer
- `ILN-Frontend` maintainer
- `ILN-Smart-Contract` maintainer

### Step 3: Blameless Walkthrough (Within 72 Hours)
A 30-minute sync is held to review the 5 Whys, confirm root causes, and finalize action item assignments and SLAs.

### Step 4: Approval & Index Sync
Once all leads approve, the PR is merged into `Invoice-Liquidity-Network` (`main` branch) and the main index [`README.md`](README.md) is updated.

---

## 3. Individual Repo Template Linking

Individual repos (`ILN-Frontend` and `ILN-Smart-Contract`) link to this shared process:

- **Frontend Repo Link**: `.github/PULL_REQUEST_TEMPLATE/postmortem.md` -> Links to `https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/tree/main/docs/postmortems`
- **Contract Repo Link**: `.github/PULL_REQUEST_TEMPLATE/postmortem.md` -> Links to `https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/tree/main/docs/postmortems`
