# scripts/

Utility and CI scripts for the Invoice Liquidity Network monorepo.

## dependency-audit.js

Orchestrates security and compliance checks across the pnpm workspace and individual npm projects. Backs six root-level npm scripts.

### Subcommands

| Command | npm script | Description |
|---|---|---|
| `audit` | `security:audit` | Runs `pnpm audit --prod` on the workspace, then `npm audit --omit=dev` in each sub-project that has a `package-lock.json` (cli, sdk, indexer, notifications, packages/indexer, packages/mock-backend, packages/sdk). Exits non-zero if any audit finds vulnerabilities. |
| `audit --fix` | `security:audit:fix` | Same as `audit`, but runs `npm audit fix --omit=dev` instead of a read-only audit. Skips pnpm audit and JSON reporting. |
| `snyk` | `security:snyk` | Runs `npx --yes snyk test --all-projects --severity-threshold=<level>`. Requires network access and a Snyk token. Exits non-zero on any finding. |
| `licenses` | `security:licenses` | Runs `node scripts/check-licenses.js` to verify all dependency licenses are approved. Exits non-zero on unapproved licenses. |
| `scan` | `security:scan` | Runs all three checks sequentially: pnpm audit, npm audit, licenses, snyk. Exits non-zero if any check fails. |
| `report` | `security:report` | Same as `scan`, but writes machine-readable output to `.security/`: `pnpm-audit-workspace.json`, `npm-audit-<project>.json`, `npm-audit-summary.json`, `snyk-report.json`, `license-report.txt`. Also prints a summary line with the output path. |

### Output formats

- **npm audit (JSON mode)**: Standard `npm audit --json` output per project, plus an `npm-audit-summary.json` array with `{project, command, status, report}` entries.
- **pnpm audit (JSON mode)**: Standard `pnpm audit --json` output written to `pnpm-audit-workspace.json`.
- **Snyk (JSON mode)**: Snyk JSON test output written to `snyk-report.json`.
- **Licenses**: Plain text from `check-licenses.js` written to `license-report.txt`.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SECURITY_AUDIT_LEVEL` | `high` | Severity threshold passed to `npm audit --audit-level` and `snyk test --severity-threshold`. Valid values: `low`, `moderate`, `high`, `critical`. |

### Tests

Unit tests are in `scripts/__tests__/dependency-audit.test.js`. Run with:

```
node --test scripts/__tests__/dependency-audit.test.js
```

Tests mock `spawnSync` to avoid network access and verify argument construction, error handling (missing tools, non-zero exits), and report path generation for each subcommand.

---

## Other scripts

| Script | Purpose |
|---|---|
| `check-licenses.js` | Validates dependency licenses against an allowlist. Called by `dependency-audit.js licenses`. |
| `check-compatibility.ts` | Validates that contract, SDK, and frontend versions in `docs/cross-repo-dependencies.md` match the actual codebase. |
| `check-bundle-size.js` | Checks bundle size budgets. |
| `check-changeset-dependents.mjs` | Validates changeset files reference correct packages. |
| `check-meta-nav.mjs` | Validates documentation navigation metadata. |
| `check-no-duplicate-types.mjs` | Detects duplicate TypeScript type definitions across packages. |
| `check-no-foreign-lockfiles.mjs` | Ensures only pnpm lockfiles are present (no npm/yarn). |
| `validate-packages.mjs` | Validates package.json fields across the monorepo. |
| `check-monorepo-map-drift.mjs` | Cross-references `docs/monorepo-map.md` status against each package's `package.json` (name, `deprecated` notice, publish intent). Advisory; run `pnpm drift:check`. |
| `mainnet-checklist-parser.js` | Parses the mainnet launch checklist markdown and updates issue statuses. |
| `generate-types.ts` | Generates shared TypeScript types from contract specs. |
| `deploy.ts` | Deployment orchestration for Soroban contracts. |
| `migrate.ts` | Database migration runner. |
| `load-test.ts` | API load testing. |
| `load-test-indexer.ts` | Indexer-specific load testing. |
| `load-test-notifications.ts` | Notifications service load testing. |
| `profile.ts` | Performance profiling utility. |
| `verify-deployment.ts` | Post-deployment verification checks. |
| `bulk-create-issues.py` | Bulk-creates GitHub issues from a mustache-style Markdown template + RFC 4180 CSV data. Defaults to a dry-run preview; pass `--live` to actually create issues. Backs the `Bulk Issue Create` workflow (`.github/workflows/bulk-issue-create.yml`). |
