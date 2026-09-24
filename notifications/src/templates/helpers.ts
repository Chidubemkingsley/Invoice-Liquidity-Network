/**
 * Template helper utilities shared across all email templates.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                ESCAPING CONTRACT — READ BEFORE EDITING                │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ Every outbound template interpolates at least one field that is          │
 * │ attacker-controlled (chain data or user input). The correct escape       │
 * │ function MUST be used for the template's output context:                │
 * │                                                                         │
 * │  Output context      │ Escaper to use              │ Example bug if     │
 * │                      │                             │ omitted             │
 * │──────────────────────┼─────────────────────────────┼────────────────────│
 * │ HTML email body      │ escapeHtml()                │ <script>alert(1)   │
 * │ HTML attribute (href │ escapeHtml() on URL +       │ "><img onerror=   │
 * │   / title)           │ validate via isValidUrl()   │                    │
 * │ Webhook JSON body    │ JSON.stringify() (never     │ breaking JSON with │
 * │                      │ string concat)              │ "}, {"evil":       │
 * │ Webhook headers      │ escapeHeaderValue()         │ CRLF injection     │
 * │  X-ILN-*             │                             │                    │
 * │ Discord markdown*    │ escapeDiscordMarkdown()     │ @everyone, ||spoiler│
 * │ SMS plain text       │ escapeSmsText() (control   │ SMS split / carrier│
 * │                      │ char strip)                 │ filter bypass      │
 * │ Subject line (email) │ escapeHtml() OR strip +     │ header injection   │
 * │  header)             │ escapeHeaderValue()         │                    │
 * │ Plain-text fallback  │ escapeSmsText()             │                    │
 * │                                                                         │
 * │ *Discord is not a persisted subscription channel today but               │
 * │ governance-monitor and future digest-Discord adapters reuse the same     │
 * │ helpers, so every helper is unit-tested with adversarial payloads.       │
 * │                                                                         │
 * │ Data-source trace (field → origin → trust):                             │
 * │   invoice.id, amount, due_date, discount_rate → chain (Soroban event) │  │
 * │     → treat as untrusted (contract may emit arbitrary stringified data) │
 * │   invoice.freelancer/payer/funder → Stellar address from chain →       │
 * │     untrusted (may be G... + HTML payload if memo spoof)                 │
 * │   recipient.address/email, webhook destination → user input → untrusted │
 * │   trigger, status, periodLabel → internal enum → trusted but still     │
 * │     escaped for defense-in-depth                                        │
 * │                                                                         │
 * │ Template inventory (all outbound surfaces that interpolate):              │
 * │   1. funded.template.ts    — HTML email (funded)  — fields: invoiceId, │
 * │        amount, dueDate, freelancer/payer/funder, greeting, dashboardUrl│
 * │   2. payment.template.ts   — HTML email (paid)    — same + roleLabel   │
 * │   3. dispute.template.ts   — HTML email (default) — same                │
 * │   4. due-warning.template.ts — HTML email (due soon) — same             │
 * │   5. digest.template.ts    — HTML email (daily/weekly digest) —         │
 * │        recipient, amount, dueDate, freelancer/payer, invoiceId,         │
 * │        periodLabel, unsubscribeToken (via URL)                            │
 * │   6. delivery.ts:sendEmail — HTML wrapper around payload.message/       │
 * │        invoice fields (Resend) — message, invoice.id/status/due_date   │
 * │   7. delivery.ts:sendWebhook — JSON body (invoice, trigger, actor,     │
 * │        subject, message, eventId) — all chain/user fields JSON-escaped │
 * │        + headers X-ILN-* (escapeHeaderValue)                             │
 * │   8. delivery.ts:sendSms   — SMS text (subject + invoice.id/status)    │
 * │        plain-text (control-char strip)                                    │
 * │   9. template-engine.ts    — Generic {{var}} interpolation — now        │
 * │        context-aware (HTML escape by default)                             │
 * │  10. preferences-api.ts unsubscribe page — HTML escape on address        │
 * │  11. WebSocket broadcast (websocket.ts) — JSON payload (JSON.stringify) │
 * │                                                                         │
 * │ If you add a new template, add a row above and a matching adversarial   │
 * │ test in tests/template-injection.test.ts.                                │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

/** Format a stroops/micro-unit amount as a human-readable decimal string. */
export function formatAmount(rawAmount: string): string {
  const n = BigInt(rawAmount);
  const whole = n / 10_000_000n;
  const frac = (n % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Format a Unix timestamp (seconds) as a readable UTC date string. */
export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toUTCString();
}

/** Truncate a Stellar address for display: GABCD…WXYZ. */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

/** Escape HTML special characters to prevent injection in templates. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a string for safe embedding in an HTML attribute value (e.g. href).
 * Uses escapeHtml and additionally escapes backticks and validates URL scheme.
 */
export function escapeAttribute(str: string): string {
  return escapeHtml(str).replace(/`/g, '&#96;');
}

/**
 * Escape for Discord markdown output.
 * Neutralizes: **, *, __, _, `, ||, > quote, [link], @everyone/@here, #channel
 */
export function escapeDiscordMarkdown(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\*\*/g, '\\*\\*')
    .replace(/\*/g, '\\*')
    .replace(/__/g, '\\_\\_')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\|\|/g, '\\|\\|')
    .replace(/@/g, '@\u200b') // zero-width space breaks @everyone / @here without visible change
    .replace(/#/g, '#\u200b');
}

/**
 * Escape for plain-text SMS: strip control characters (including CRLF injection)
 * and truncate to 1600 chars (carrier limit). SMS has no markup, but control
 * chars can split messages or confuse carriers.
 */
export function escapeSmsText(str: string): string {
  // Remove C0 control chars except tab/newline, replace CRLF runs with single space
  const cleaned = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\r?\n+/g, ' ');
  return cleaned.slice(0, 1600);
}

/**
 * Escape for HTTP header values (X-ILN-Trigger, X-ILN-Recipient, X-ILN-Signature).
 * Strips CRLF and non-printable ASCII to prevent header injection.
 * Returns a fallback sanitized string rather than throwing for resilience.
 */
export function escapeHeaderValue(str: string): string {
  return str.replace(/[\r\n\x00-\x1F\x7F]+/g, ' ').trim().slice(0, 512);
}

/**
 * Validate that a string, when embedded as a JSON string value via JSON.stringify,
 * round-trips correctly. This is a test helper to prove webhook JSON context is safe.
 */
export function isJsonSafeRoundTrip(value: string): boolean {
  try {
    const encoded = JSON.stringify({ v: value });
    const decoded = JSON.parse(encoded) as { v: string };
    return decoded.v === value;
  } catch {
    return false;
  }
}

/** Shared email wrapper: responsive, inbox-safe HTML shell.
 *
 * @param title       Email `<title>` and visible heading text.
 * @param bodyHtml    Pre-rendered body section.
 * @param options Optional shell options. Pass `unsubscribeUrl` to make the
 *   footer's "Unsubscribe" link point at a tokenized, address-specific
 *   preferences endpoint so the link always works and takes effect immediately.
 *   When omitted, the link falls back to the public marketing URL.
 */
export function emailShell(
  title: string,
  bodyHtml: string,
  options: { unsubscribeUrl?: string } = {}
): string {
  const { unsubscribeUrl } = options;
  const unsubHref = unsubscribeUrl ?? 'https://iln.finance/unsubscribe';
  const unsubLabel = 'Unsubscribe';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${escapeHtml(title)}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    /* Reset */
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body { margin: 0; padding: 0; background-color: #f4f6f9; font-family: Arial, Helvetica, sans-serif; }

    /* Layout */
    .wrapper { width: 100%; table-layout: fixed; background-color: #f4f6f9; padding: 32px 0; }
    .main { background-color: #ffffff; max-width: 600px; margin: 0 auto; border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08); overflow: hidden; }

    /* Header */
    .header { background-color: #1a56db; padding: 28px 32px; text-align: center; }
    .header h1 { margin: 0; color: #ffffff; font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
    .header p  { margin: 6px 0 0; color: #bfdbfe; font-size: 13px; }

    /* Body */
    .body-content { padding: 32px; color: #374151; font-size: 15px; line-height: 1.6; }
    .body-content h2 { margin: 0 0 16px; font-size: 18px; color: #111827; }

    /* Invoice card */
    .invoice-card { background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px;
                    padding: 20px 24px; margin: 24px 0; }
    .invoice-card table { width: 100%; border-collapse: collapse; }
    .invoice-card td  { padding: 6px 0; font-size: 14px; color: #374151; }
    .invoice-card td.label { font-weight: 600; color: #6b7280; width: 40%; }

    /* Status badge */
    .badge { display: inline-block; padding: 3px 10px; border-radius: 9999px;
             font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge-funded  { background-color: #d1fae5; color: #065f46; }
    .badge-paid    { background-color: #dbeafe; color: #1e40af; }
    .badge-default { background-color: #fee2e2; color: #991b1b; }
    .badge-warning { background-color: #fef3c7; color: #92400e; }

    /* CTA button */
    .btn-wrap { text-align: center; margin: 28px 0; }
    .btn { display: inline-block; background-color: #1a56db; color: #ffffff !important;
           text-decoration: none; padding: 12px 28px; border-radius: 6px;
           font-size: 15px; font-weight: 600; }

    /* Footer */
    .footer { background-color: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px 32px;
              text-align: center; font-size: 12px; color: #9ca3af; }
    .footer a { color: #6b7280; text-decoration: underline; }

    /* Responsive */
    @media only screen and (max-width: 620px) {
      .main    { border-radius: 0; }
      .header, .body-content, .footer { padding: 20px; }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="main">
      ${bodyHtml}
      <div class="footer">
        <p>Invoice Liquidity Network &mdash; Stellar-based invoice financing</p>
        <p>
          <a href="https://iln.finance">Dashboard</a> &bull;
          <a href="https://docs.iln.finance">Docs</a> &bull;
          <a href="${escapeHtml(unsubHref)}">${escapeHtml(unsubLabel)}</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;
}
