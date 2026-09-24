# Notifications System Documentation

## Why notifications: the problems they solve

The notification system ensures users and integrators are promptly informed about important events, such as invoice status changes, approvals, payments, and governance actions. This reduces manual checking, improves workflow efficiency, and enables automated responses via webhooks.

## Delivery channels

### Implemented today

`SubscriptionChannel` and `MultiChannelDelivery` implement exactly four lowercase channel names:

| Channel | Required destination | Adapter payload |
| --- | --- | --- |
| `email` | `email` | `subject` and `message` |
| `webhook` | `webhookUrl` | `trigger`, `actor`, complete `invoice`, `subject`, `message`, `eventId`, and `eventType` |
| `sms` | `phone` | `subject` plus invoice ID and status as text |
| `websocket` | `stellarAddress` | `trigger`, `invoiceId`, `status`, `subject`, `message`, `actor`, and `eventId` |

Primary channels run concurrently. Only when every primary attempt fails does the fallback chain run sequentially until one succeeds. A missing adapter produces `no_adapter`; a missing destination produces `skipped`.

The persisted subscription and `NotificationService` path currently accepts only `email` and `webhook`. SMS and WebSocket are implemented by the injectable dispatcher but are not persisted user preferences. The React `NotificationCenter` is an in-app event-stream consumer, not another `SubscriptionChannel`. There is currently no frontend `useNotifications` hook or email-reminder preference, so that integration remains planned work and must use these exact channel names and the shared `NotificationPayload` shape.

### Planned, not implemented

- Frontend opt-in email reminder controls and a `useNotifications` integration.
- Persisted SMS and WebSocket preferences.
- Browser/mobile push; `push` is not a valid channel today.

## User Guide: Setting Up Email Alerts

To receive email alerts:
1. Navigate to your account settings in the Invoice Liquidity Network frontend.
2. Locate the "Notifications" section.
3. Enter your email address and select the events you wish to be notified about (e.g., invoice approved, payment received).
4. Save your preferences.

*Screenshot: [Add screenshot from Issue #71 here]*

## User Guide: Setting Up Webhook Alerts

To receive webhook notifications:
1. Go to your account settings and open the "Notifications" section.
2. Enter your webhook URL and select the events to subscribe to.
3. Save your preferences.

Webhook notifications will POST a JSON payload to your URL for each event.

## HTTP API

The service (`notifications/src/api.ts` + `preferences-api.ts`) listens on
`PORT` (default **4001**). The WebSocket server listens on `PORT + 1`
(default **4002**) at path `/ws`.

### Subscriptions and delivery (`api.ts`)

| Method & path | Purpose |
| --- | --- |
| `GET /health` | Liveness probe |
| `POST /subscribe` | Create a subscription. Body (snake_case): `{ stellar_address, channel, destination, triggers, webhook_secret? }`. For `webhook` channel with no `webhook_secret`, the service generates a random 32-byte hex secret. Rate-limited. Returns `201 { subscription }`. |
| `DELETE /unsubscribe` | Remove a subscription by `id`, or by `address` + `destination` |
| `GET /subscriptions/:address` | List subscriptions for an address |
| `GET /subscriptions/:id/logs` | Delivery-log history for a subscription |
| `POST /test-webhook` | Send a synthetic event to a webhook subscription. Rate-limited. |
| `GET /analytics`, `GET /analytics/channel-comparison`, `GET /analytics/trends` | Delivery analytics |
| `GET /digest/preview/:address` | Preview the batched digest for an address |

Allowed `channel` values on the persisted path: `email`, `webhook`, `sms`
(`ALLOWED_CHANNELS` in `config.ts`). `websocket` is delivered by the injectable
dispatcher but is not a persisted subscription channel. Allowed `triggers`
(`ALLOWED_TRIGGERS`): `invoice_funded`, `invoice_paid`, `invoice_defaulted`,
`invoice_due_soon`, `invoice_overdue`.

### Preferences (`preferences-api.ts`, mounted at `/preferences`)

| Method & path | Purpose |
| --- | --- |
| `GET /preferences/:address` | Read notification preferences |
| `PUT /preferences/:address` | Replace preferences |
| `PATCH /preferences/:address` | Partially update preferences |
| `DELETE /preferences/:address` | Delete all preferences for an address |
| `POST /preferences/:address/unsubscribe` | One-click unsubscribe for an address |
| `POST /preferences/unsubscribe/token/:token` | Tokenized one-click unsubscribe (HMAC-SHA256 over `(address, nonce)`); this is the link embedded in email footers |
| `GET /preferences/:address/export` | GDPR-style data export |

## Webhook Payload Format

The webhook adapter sends the shared `NotificationPayload` fields. For example:

```json
{
  "trigger": "invoice_paid",
  "actor": "payer",
  "invoice": {
    "id": 12345,
    "freelancer": "G...",
    "payer": "G...",
    "amount": "10000000",
    "due_date": 1780000000,
    "discount_rate": 250,
    "status": "Paid",
    "funder": "G...",
    "funded_at": 1779000000,
    "created_at": 1778000000,
    "updated_at": 1779500000
  },
  "subject": "Invoice paid",
  "message": "Invoice #12345 has been paid.",
  "eventId": "evt_123",
  "eventType": "paid"
}
```

Outbound webhook requests carry these headers (`notifications/src/delivery.ts`):

| Header | Value |
| --- | --- |
| `X-ILN-Trigger` | The trigger name, e.g. `invoice_paid` |
| `X-ILN-Recipient` | The recipient Stellar address |
| `X-ILN-Event-Id` | Present when the event has an id |
| `X-ILN-Signature` | `sha256=<hex>` — HMAC-SHA256 of the raw request body, keyed by the **per-subscription** `webhook_secret` set at subscribe time. Omitted when the subscription has no secret. |

Receivers should recompute the HMAC over the exact received body and reject on
mismatch. There is no global signing secret — each subscription carries its own.

## Developer Guide: Self-Hosting the Notification Service

To self-host:

1. Clone the repository and navigate to the notifications service directory.
2. Set the required environment variables (see below).
3. Run with Docker:

```sh
docker run -d \
  -e RESEND_API_KEY=your_resend_key \
  -e NOTIFICATIONS_RPC_URL=https://soroban-testnet.stellar.org \
  -e NOTIFICATIONS_CONTRACT_ID=C... \
  -e "NOTIFICATIONS_NETWORK_PASSPHRASE=Test SDF Network ; September 2015" \
  -e NOTIFICATIONS_DB_PATH=/data/notifications.sqlite \
  -p 4001:4001 \
  -p 4002:4002 \
  nursca/invoice-liquidity-notifications:latest
```

4. The HTTP API is then available on port **4001** and the WebSocket server on
   port **4002** (`/ws`).

## SDK Notifications Module Reference

`@iln/sdk` exports `NotificationsClient` for managing subscriptions against a
running notification service. It is constructed with the service base URL.

```typescript
import { NotificationsClient, NotificationTrigger } from "@iln/sdk";

const client = new NotificationsClient("http://localhost:4001");

const sub = await client.subscribeEmail(
  "GABC...",
  "user@example.com",
  [NotificationTrigger.InvoiceFunded, NotificationTrigger.InvoiceSettled],
);

await client.subscribeWebhook(
  "GABC...",
  "https://myapp.example/webhook/iln",
  [NotificationTrigger.InvoiceDefaulted],
);

const subs = await client.listSubscriptions("GABC...");
await client.testWebhook(sub.id);      // { success, statusCode }
await client.unsubscribe(sub.id);
```

| Method | Signature |
| --- | --- |
| `subscribeEmail` | `(address, email, triggers) => Promise<Subscription>` |
| `subscribeWebhook` | `(address, url, triggers) => Promise<Subscription>` |
| `listSubscriptions` | `(address) => Promise<Subscription[]>` |
| `testWebhook` | `(subscriptionId) => Promise<{ success: boolean; statusCode: number }>` |
| `unsubscribe` | `(subscriptionId) => Promise<void>` |

The SDK client does not send a `webhook_secret`, so the service generates one
per subscription. To set a known secret for verifying `X-ILN-Signature`, call
`POST /subscribe` directly with a `webhook_secret` field.

`SubscriptionChannel` in the SDK is `'email' | 'webhook'`. `NotificationTrigger`
values: `InvoiceFunded` (`invoice_funded`), `InvoiceSettled` (`invoice_paid`),
`InvoiceDefaulted` (`invoice_defaulted`), `DueDateWarning` (`invoice_due_soon`).

## Environment Variables

Read by `notifications/src/config.ts`; see also `notifications/.env.example`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `RESEND_API_KEY` | Yes | — | Resend API key for email delivery |
| `NOTIFICATIONS_RPC_URL` | Yes | — | Stellar/Soroban RPC endpoint polled for invoice events |
| `NOTIFICATIONS_CONTRACT_ID` | Yes | — | Contract ID to monitor |
| `NOTIFICATIONS_NETWORK_PASSPHRASE` | Yes | — | Network passphrase for the monitored network |
| `NOTIFICATIONS_DB_PATH` | No | `notifications.sqlite` | SQLite path for subscriptions, preferences, and delivery logs |
| `RESEND_FROM_EMAIL` | No | `no-reply@invoice-liquidity.network` | Sender address |
| `PORT` | No | `4001` | HTTP port (WebSocket server runs on `PORT + 1`) |
| `NOTIFICATIONS_POLL_INTERVAL_MS` | No | `30000` | Event poll interval |
| `NOTIFICATIONS_START_LEDGER` | No | `0` | First ledger to poll (`0` = service default) |
| `DUE_WARNING_HOURS` | No | `48` | Hours before due date to send a warning |
| `RATE_LIMIT_PER_USER` | No | `60` | Requests per window per address |
| `RATE_LIMIT_PER_CHANNEL` | No | `200` | Requests per window per channel |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Sliding rate-limit window |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | No | — | SMS delivery via Twilio |
| `SMS_RATE_LIMIT_MAX` / `SMS_RATE_LIMIT_WINDOW_MS` | No | `10` / `3600000` | SMS-specific rate limit |

There is **no** `DATABASE_URL` or global `WEBHOOK_SECRET`; earlier revisions of
this doc listed those and they are not read by the service.

## Rate Limits and Delivery Guarantees

- API requests are rate-limited per address (`RATE_LIMIT_PER_USER`, default
  **60 / 60 s**) and per channel (`RATE_LIMIT_PER_CHANNEL`, default **200 / 60 s**),
  with `X-RateLimit-*` headers on responses.
- SMS has its own limit: `SMS_RATE_LIMIT_MAX` (default 10) per
  `SMS_RATE_LIMIT_WINDOW_MS` (default 1 hour).
- Webhook delivery is retried up to `CONFIG.maxWebhookRetry` (**3**) times with
  exponential backoff from `webhookBackoffBaseMs` (500 ms).
- Primary channels are attempted concurrently; the fallback chain runs
  sequentially only if every primary attempt fails.
- Webhook payloads are HMAC-SHA256 signed **when the subscription was created
  with a `webhookSecret`** (see `X-ILN-Signature` above).

---

## Template Escaping Contract & Injection Audit (Hardening Batch)

> **Rule for future template authors:** every interpolation must use the escaper for its output context. Merging a new template without a row in the inventory below and without a corresponding adversarial test is a CI failure.

### Why this exists
Notification templates interpolate fields that are **untrusted by default**: Stellar addresses, invoice memo/metadata, and chain-emitted event fields (`amount`, `freelancer`, etc.) can be controlled by an attacker via contract events or memos. Without context-appropriate escaping the same payload would exploit multiple output surfaces (HTML email, webhook JSON, HTTP headers, Discord markdown, SMS text, WebSocket JSON).

### Outbound template inventory (trace: field → data source → output context → escaper)

| # | Template / surface | Interpolated field(s) | Data source | Output context | Escaper (file:line) |
|---|-------------------|------------------------|-------------|----------------|----------------------|
| 1 | `funded.template.ts` | `invoiceId, amount, dueDate, freelancer/payer/funder, greeting, dashboardUrl` | chain (invoice) + user (url) + internal (greeting) | HTML email + href attr | `helpers.ts:escapeHtml` + `escapeAttribute` |
| 2 | `payment.template.ts` | `invoiceId, amount, dueDate, freelancer/payer/funder, roleLabel` | chain + internal | HTML email | `escapeHtml` |
| 3 | `dispute.template.ts` | `invoiceId, amount, dueDate, freelancer/payer/funder` | chain + internal | HTML email | `escapeHtml` |
| 4 | `due-warning.template.ts` | `invoiceId, amount, dueDate, freelancer/payer` | chain | HTML email | `escapeHtml` |
| 5 | `digest.template.ts` | `recipient, frequency, periodLabel, items[].amount/freelancer/payer/invoiceId/dueDate, unsubscribeToken` | user + chain + internal | HTML email + URL | `escapeHtml` + `encodeURIComponent` |
| 6 | `delivery.ts:sendEmail` | `payload.message, invoice.id/status/due_date, subject` | chain + internal | HTML email body + header | `escapeHtml` + `escapeHeaderValue` |
| 7 | `delivery.ts:sendWebhook` | `trigger, actor, invoice.*, subject, message, eventId` | chain + user + internal | JSON body (`JSON.stringify`) | `JSON.stringify` (no concat) |
| 8 | `delivery.ts:sendWebhook` headers | `X-ILN-Trigger, X-ILN-Recipient, X-ILN-Event-Id` | chain + user | HTTP header | `escapeHeaderValue` |
| 9 | `delivery.ts:sendSms` | `subject, invoice.id/status/due_date` | chain + internal | SMS plain-text | `escapeSmsText` |
|10 | `template-engine.ts` `{{var}}` | any `TemplateContext` field | chain + user + internal (generic) | `html`/`discord`/`sms`/`json`/`none` | `escapeForContext()` |
|11 | `preferences-api.ts` unsubscribe page | `stellar_address` | user | HTML | `escapeHtml` |
|12 | `websocket.ts` broadcast | `InvoiceEvent` | chain | JSON (WebSocket) | `JSON.stringify` |

Adding a new template requires: (a) a new row above, (b) the correct escaper call at the interpolation site, and (c) an adversarial regression test in `notifications/tests/template-injection.test.ts` — see the `// ADVERSARIAL` payload set there.

### Escapers (helpers.ts)

| Escaper | When to use | What it neutralizes |
|---------|-------------|---------------------|
| `escapeHtml(str)` | HTML email body, any `{{var}}` rendered as HTML | `& < > " ' '` → `&amp; &lt; &gt; &quot; &#39;` |
| `escapeAttribute(str)` | HTML attribute values (href, title) | same as `escapeHtml` + backtick |
| `escapeHeaderValue(str)` | Any HTTP header value (`X-ILN-*`, `Subject`) | strips `\r \n \x00-\x1F`, caps 512 chars |
| `escapeSmsText(str)` | SMS body, plain-text fallback | strips C0 control chars, normalizes CRLF → space, 1600 cap |
| `escapeDiscordMarkdown(str)` | Discord markdown (future `discord` adapter) | breaks `** * __ _ ` || ` @# []` |
| `JSON.stringify` | Webhook/WebSocket JSON payloads | never interpolate via string concat; `isJsonSafeRoundTrip` proves safety |

### What was audited & fixed

- Enumerated all 12 surfaces above and traced every field back to its origin (chain vs user vs internal). No field was left untraced.
- Verified `funded/payment/dispute/due-warning/digest` templates already used `escapeHtml` for HTML — no change needed, but added `escapeAttribute` path for `dashboardUrl`/`unsubscribeUrl` hrefs (defense-in-depth, tested).
- `delivery.ts:sendEmail` previously interpolated `payload.message`/`invoice.status` raw into HTML — **fixed** to `escapeHtml` + header-safe `subject`; `delivery.ts:sendWebhook` headers previously raw — **fixed** to `escapeHeaderValue`; `sendSms` now `escapeSmsText`.
- `template-engine.ts` previously did `String(value)` with no escaping — **hardened** to `escapeForContext(value, ctx)` defaulting to `'html'`; new `EscapeContext` param lets Discord/SMS/JSON callers select the correct escaper explicitly. No existing `engine.render()` call relied on raw HTML, so defaulting to `'html'` is backwards-compatible and safe.
- `websocket.ts` and `preferences-api.ts` already used `JSON.stringify` / local `escapeHtml`; confirmed no gap.
- Added `notifications/tests/template-injection.test.ts`: 35+ regression cases with `<script>`, `<img onerror>`, JSON-breaking `","evil":`, Discord `@everyone`/`||spoiler||`, CRLF header injection, SMS control chars, and per-template adversarial inventory test that will fail if a future template adds a field without an entry.

### Regression test command

```bash
pnpm --filter ./notifications vitest run tests/template-injection.test.ts --reporter=verbose
pnpm --filter ./notifications vitest run tests/templates.test.ts --reporter=verbose
```

*For more details, see the SDK and service source code and `notifications/src/templates/helpers.ts` header doc.*

## Architectural Note: Notifications WebSocket vs Indexer Subscription

This monorepo maintains two independent WebSocket streams optimizing for distinct responsibilities:

1. **Indexer Subscription Path (`packages/indexer`)**: Tracks raw on-chain state adjustments directly via RPC streams. It handles atomic smart-contract transformations and state mutations.
2. **Notifications Path (`packages/notifications`)**: A hardened service acting as a secure real-time notification engine for front-end actions (e.g., active triggers, system alerts, user updates). It is protected by intentional per-IP connections ceilings and client authentication guards (`NOTIFICATIONS_WS_AUTH_TOKEN`) preventing unauthorized state surface scanning.
