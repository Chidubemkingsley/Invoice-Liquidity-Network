# Notification Rate Limiting Runbook

This runbook defines the first operator-facing slice for per-recipient notification storm protection.

## Default Policy

Use a per-recipient bucket keyed by the canonical recipient identifier:

- Stellar address for in-app and websocket destinations.
- Email address for email destinations.
- Webhook URL plus subscription id for webhook destinations.
- Phone number for SMS destinations.

Recommended starting defaults:

| Window | Limit | Behavior |
| --- | --- | --- |
| 60 seconds | 20 notifications | Deliver until the bucket is exhausted. |
| 5 minutes | 60 notifications | Coalesce non-critical overflow into a digest event. |
| 1 hour | 240 notifications | Drop duplicate low-priority overflow after logging. |

Critical security and payment-state notifications should be coalesced, not silently dropped. Duplicate status-change events for the same invoice can be merged into the newest status for that invoice.

## Required Logging

Every rate-limited event must create an operator-visible record with:

- Recipient key hash, never the raw address or email in high-cardinality logs.
- Channel name.
- Event type and invoice id when available.
- Action taken: `delivered`, `coalesced`, or `dropped_duplicate`.
- Current bucket count, limit, and reset time.

## Incident-Storm Validation

A chaos/load test should simulate a burst of invoice status changes for one recipient across email, webhook, SMS, and websocket delivery. The test should verify that:

1. The configured recipient limit is not exceeded.
2. Overflow is logged with an explicit action.
3. Critical notifications are retained through coalescing.
4. One recipient's storm does not throttle unrelated recipients.

## Rollout Notes

Start with observe-only logging in staging, then enable enforcement for low-priority duplicate notifications. Raise alerts if provider responses indicate abuse detection, throttling, or account-block risk.