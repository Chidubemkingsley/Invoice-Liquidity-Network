# Privacy and Data Retention Policy

This document describes the data the Invoice Liquidity Network stores on behalf of users, how long each piece of data is retained, and how users can exercise their right to view, export, or delete their data across all services (Notifications, Indexer, KYB Provider Interface, and Oracle).

For protocol-level security and threat-model information, see [`security-guide.md`](security-guide.md) and [`threat-model.md`](threat-model.md).

---

## 1. Notifications Service (`notifications/`)

The notifications service stores data in two distinct buckets:

### 1a. Notification preferences (per Stellar address)

| Field | Purpose |
|-------|---------|
| `stellarAddress` | Identifies the user (Stellar public key). |
| `enabledChannels` | Which delivery channels the user has opted-in to (`email`, `sms`, `webhook`, `websocket`). |
| `frequency` | Delivery frequency: `realtime`, `daily`, or `weekly`. |
| `quietHours` | Optional `{ startHour, endHour, timezone }` window during which notifications are held back. |
| `triggerPreferences` | Per-trigger overrides (e.g. "don't notify me of `invoice_defaulted` events"). |
| `updatedAt` | ISO 8601 timestamp of the last edit. |

### 1b. Subscriptions (rows in the `subscriptions` SQLite table)

Each row describes one outbound subscription:

| Column | Purpose |
|--------|---------|
| `stellar_address` | Owning user. |
| `channel` | `email`, `webhook`, or `sms`. |
| `destination` | Delivery target (email address, URL, or E.164 phone number — the user-provided contact data). |
| `triggers` | JSON array of invoice-event triggers the user subscribed to. |
| `webhook_secret` | Optional HMAC signing secret for webhooks. |
| `created_at` | Subscription creation timestamp. |

### 1c. Delivery audit log (rows in `sent_notifications`, `webhook_delivery_logs`, and `delivery_audit_log`)

These records support support/compliance investigations ("was this specific notification actually delivered, and when?") as a **durable, queryable audit log** independent of scattered application logs. Two kinds of records exist:

- **Transient dispatch-retry state** (`sent_notifications` for de-duplication and `webhook_delivery_logs` for retry bookkeeping) — may be cleared on restart and is not the source of truth for investigations.
- **Durable delivery-confirmation audit log** (`delivery_audit_log`) — one row per delivery outcome (whether `delivered` or `failed`), with attempt timestamps, channel, and final status. This table is the source of truth for `GET /audit/deliveries` (by recipient, event, or time range) and for the CLI `query-audit` tool.

They are not visible to users by default but are included in the export endpoint.

**Data Retention & Archive** (enforced via `POST /audit/purge` and the scheduled purge job; see `purgeExpiredDeliveryLogs` in `notifications/src/db.ts`):
- **Active preferences**: Until the user updates them, unsubscribes, or deletes the record.
- **Subscriptions**: Deleted immediately on `DELETE /unsubscribe` or `POST /unsubscribe`.
- **Delivery logs (`sent_notifications`)**: Retained for **30 days** from `sent_at`, then purged.
- **Webhook delivery logs**: Retained for **90 days** from `created_at`, then purged.
- **Delivery audit log (`delivery_audit_log`)**: Retained for **90 days** from `created_at`, then purged — consistent with webhook logs as the durable counterpart independent of retry state. Attempt timestamps and final status remain queryable within this window via `GET /audit/deliveries?recipient=...&eventId=...&start=...&end=...`.
- Client-side notification history follows the frontend application's data retention practices.

---

## 2. Indexer Service (`indexer/`)

- **Data Collected**: The indexer aggregates on-chain transaction data (e.g., wallet addresses, invoice token IDs, transfer events, and settlement actions).
- **Data Retention & Archive**: 
  - All indexed data is strictly derived from public on-chain ledgers. 
  - Historical indexed data is retained indefinitely to support network analytics and query resolution, but contains no off-chain Personally Identifiable Information (PII).

---

## 3. KYB Provider Interface

- **Data Collected**: If the external KYB (Know Your Business) provider integration is enabled, this service securely routes business identity verification payloads.
- **Data Retention & Archive**: 
  - We act merely as a passthrough for KYB-related data. No sensitive business documentation or identity verification details are stored persistently on our servers.
  - API request/response logs related to KYB verification are sanitized to remove PII and retained for a maximum of 14 days for debugging purposes.

---

## 4. Oracle Service (`oracle-service/`)

- **Data Collected**: The oracle service fetches and verifies off-chain asset pricing and invoice status updates.
- **Data Retention & Archive**: 
  - No user PII is involved. The oracle retains historical price feeds and cryptographic attestations for auditability.
  - Attestation logs are retained per the broader infrastructure archive-retention policy (typically 1 year for audit readiness).

---

## 5. What we **do not** store

| ❌ Not stored | Why |
|---------------|-----|
| Stellar secret keys | The infrastructure services are observer-only. |
| IP addresses | Failures are surfaced via application logs; PII is not retained alongside delivery records. |
| Tracking pixels / open-tracking data | We respect the user's inbox. |
| Third-party analytics identifiers | None are embedded in the templates or payloads. |

---

## 6. Contact

- Email: [security@invoiceliquidity.network](mailto:security@invoiceliquidity.network)
- For data-export / deletion requests, please email the security contact.

*This document accurately reflects our current data-handling practices across all services to ensure transparency, security, and compliance with data minimization principles.*
