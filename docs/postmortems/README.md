# Shared Cross-Repo Postmortem Repository

Welcome to the canonical postmortem repository for the **Invoice Liquidity Network (ILN)** ecosystem.

This location (`docs/postmortems/` in `Invoice-Liquidity-Network`) serves as the single source of truth for post-incident reviews, root-cause analyses, and action-item tracking across all three repositories:

1. **`Invoice-Liquidity-Network`** (Main Repo: Backend microservices, Indexer, Oracle, Notifications, SDK)
2. **`ILN-Frontend`** (dApp UI, client state management, wallet connectors)
3. **`ILN-Smart-Contract`** (Soroban Rust smart contracts, ledger state logic)

---

## 1. Postmortem Guidelines & Governance

- **Canonical Home**: All P1 (Critical) and P2 (High) incidents spanning any repository MUST store their official postmortem document in this directory.
- **Blameless Culture**: Postmortems focus on systemic failures, missing safeguards, and process improvements—never individual human error.
- **Action Item SLA**:
  - **P1 Action Items**: Completed within **7 days**.
  - **P2 Action Items**: Completed within **14 days**.
  - **P3 Action Items**: Tracked in backlog for next sprint.

---

## 2. Document Structure & Workflow

- [`TEMPLATE.md`](TEMPLATE.md): The standard markdown template to copy when opening a new postmortem.
- [`PROCESS.md`](PROCESS.md): Step-by-step lifecycle guide for facilitating reviews, assigning cross-repo action items, and archiving postmortems.

---

## 3. Postmortem Index

| Date | Incident Title | Impacted Repos | Severity | Lead Author | Document Link |
|---|---|---|---|---|---|
| 2026-08-30 | Game-Day #1: Oracle Cache Malfunction & Badge State Mismatch | Main Repo, Frontend, Contract | P1 (Simulated) | @adetomiwa21 | [`2026-08-30-cross-repo-game-day-oracle-malfunction.md`](2026-08-30-cross-repo-game-day-oracle-malfunction.md) |
