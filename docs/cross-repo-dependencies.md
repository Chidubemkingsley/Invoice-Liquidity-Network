# Cross-Repo Dependency Version Compatibility Matrix

## Overview

The Invoice Liquidity Network spans three repositories whose outputs are consumed by one another:

| Repository | Component | Version Source |
|---|---|---|
| [ILN-Smart-Contract](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract) | [Soroban](glossary.md#soroban) contracts (Rust) | `backend/contracts/invoice_liquidity/Cargo.toml` → `[package].version` |
| [Invoice-Liquidity-Network](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network) — `sdk/` | TypeScript SDK | `sdk/package.json` → `version` |
| [ILN-Frontend](https://github.com/Invoice-Liquidity-Network/ILN-Frontend) | Next.js dApp | `frontend/package.json` → `version` |

The smart contract repo produces a compiled WASM and a contract spec (`spec.json`) that the SDK consumes to generate TypeScript types. The frontend depends on those generated SDK types to build its UI. A version mismatch between any of these layers causes silent breakages — wrong type shapes, missing fields, or runtime transaction failures.

---

## Compatibility Matrix

Each row represents a tested, compatible combination of component versions. **The CI pipeline validates that the currently checked-out versions match at least one row in this table.**

<!-- COMPATIBILITY_MATRIX_START -->
| Contract (`invoice_liquidity`) | SDK (`@invoice-liquidity/sdk`) | Frontend (`ILN-Frontend`) | Notes |
|---|---|---|---|
| `0.1.0` | `0.1.0` | `0.1.0` | Initial release — all components aligned |
<!-- COMPATIBILITY_MATRIX_END -->

> **Important**: The markers `<!-- COMPATIBILITY_MATRIX_START -->` and `<!-- COMPATIBILITY_MATRIX_END -->` are parsed by the CI compatibility check script. Do not remove or rename them.

### Relationship to the docs site version banner

The documentation site is single-track: it always describes the latest build deployed to Stellar testnet, and states which contract and SDK release that is in a banner on every page. See [Documentation Versioning](versioning.md) for the policy and for the declared values.

The banner reads from [`docs/version-manifest.json`](version-manifest.json), and `scripts/check-compatibility.ts` asserts that the manifest's `(contract, sdk)` pair appears in the matrix above. A banner can therefore never advertise a combination this table does not list — if you add a row here for a new release, bump the manifest in the same PR, and vice versa.

---

## Dependency Graph

```
ILN-Smart-Contract (Rust / Soroban)
        │
        │  stellar contract build → .wasm
        │  stellar contract info  → spec.json
        ▼
@invoice-liquidity/sdk (TypeScript)
        │
        │  pnpm generate:types → sdk/src/generated/types.ts
        │  npm publish → @invoice-liquidity/sdk@x.y.z
        ▼
ILN-Frontend (Next.js)
        │
        │  imports @stellar/stellar-sdk
        │  uses generated contract types
        ▼
   End-user dApp
```

### Shared Dependencies

All three layers share the Stellar SDK ecosystem:

| Dependency | Contract | SDK | Frontend |
|---|---|---|---|
| `soroban-sdk` (Rust crate) | `25.3.1` | — | — |
| `@stellar/stellar-sdk` (npm) | — | `^15.0.1` | `^15.0.1` |
| `@stellar/freighter-api` (npm) | — | `^6.0.1` | `^6.0.1` |

When upgrading `@stellar/stellar-sdk`, **both** the SDK and frontend must be updated in lockstep to avoid runtime incompatibilities in XDR serialization.

---

## Update Process

Follow this process whenever a cross-repo dependency changes:

### 1. Bump the version in the source repo

- **Contract change** → update `version` in `backend/contracts/invoice_liquidity/Cargo.toml`
- **SDK change** → update `version` in `sdk/package.json`
- **Frontend change** → update `version` in `frontend/package.json`

### 2. Add a new row to the compatibility matrix

Open `docs/cross-repo-dependencies.md` and add a new row between the `COMPATIBILITY_MATRIX_START` and `COMPATIBILITY_MATRIX_END` markers:

```markdown
| `0.2.0` | `0.2.0` | `0.1.0` | Contract + SDK bump; frontend unchanged |
```

If the newly deployed contract or SDK is what the docs now describe, update
[`docs/version-manifest.json`](version-manifest.json) in the same PR and mirror the change into
`packages/docs/lib/docs-version.ts` and `docs/theme.config.jsx`. The compatibility check fails
otherwise. See [Documentation Versioning](versioning.md).

### 3. Regenerate SDK types (if contract changed)

```bash
pnpm generate:types
```

### 4. Run the CI compatibility check locally

```bash
pnpm check-compatibility
```

### 5. Include the matrix update in your PR

The PR that changes any version **must** also update this document. CI will fail if the current version combination is not found in the matrix.

---

## CI Enforcement

A dedicated CI job (`check-compatibility`) runs on every push and pull request. It:

1. Reads the current `version` from each of the three source files
2. Parses the compatibility matrix table in this document
3. Asserts that the current `(contract, sdk, frontend)` tuple appears in at least one row
4. Validates the docs site version declaration:
   - `packages/docs/lib/docs-version.ts` and `docs/theme.config.jsx` match [`docs/version-manifest.json`](version-manifest.json)
   - both versioning pages (`docs/versioning.md`, `packages/docs/content/versioning.mdx`) quote the manifest's contract version and contract ID
   - the manifest's `(contract, sdk)` pair appears in the matrix above
5. Fails with a clear error message if any of the above does not hold

The check script lives at [`scripts/check-compatibility.ts`](../scripts/check-compatibility.ts) and is also runnable locally via `pnpm check-compatibility`.

---

## FAQ

**Q: What if I only change the frontend and not the contract or SDK?**
A: Bump the frontend version, add a new row with the existing contract and SDK versions paired with the new frontend version, and the CI check will pass.

**Q: What if the contract changes but the SDK types haven't been regenerated yet?**
A: The existing `sdk-types-sync` CI job catches this. It rebuilds the contract, regenerates types, and fails if `sdk/src/generated/types.ts` has uncommitted changes.

**Q: Can I have multiple valid rows for the same contract version?**
A: Yes. For example, contract `0.1.0` may be compatible with SDK `0.1.0` and SDK `0.1.1` if the spec didn't change.

---

## Service Level Objectives (SLOs) Cross-Repo Reference

The main repository hosts authoritative SLO definitions for the ecosystem in [`docs/slos.md`](slos.md). Downstream repositories (`ILN-Frontend` and `ILN-Smart-Contract`) MUST reference these authoritative numbers for downtime resilience, lag tolerances, and timeout settings:

- **Indexer Ingestion Lag Target**: `< 5.0s` for 99.9% of ledgers. Frontend cache resilience fallback window is set to **15.0s** based on this target.
- **Oracle Verification Latency Target**: `p95 < 150ms`, `p99 < 400ms`. Frontend badge verification spinner timeout is capped at **2.0s**.
- **Notification Delivery Latency Target**: `p95 < 10.0s` across email, SMS, and webhooks. Frontend polling interval aligns with this 10.0s target.
- **Uptime Targets**: Indexer `99.9%`, Oracle Service `99.95%`, Notification Service `99.9%`.

