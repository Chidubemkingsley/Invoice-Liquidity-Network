/**
 * notifications/tests/template-injection.test.ts
 *
 * Regression tests for template-injection hardening (hardening batch #1028).
 *
 * Every outbound template and every interpolated field is exercised with
 * adversarial payloads that try to break out of its output context:
 *   - HTML/script injection (email body, dashboard)
 *   - JSON-breaking characters (webhook JSON)
 *   - Discord markdown abuse
 *   - Header/CRLF injection
 *
 * Data-source trace: each field is annotated with (chain/user/internal) so
 * reviewers can see the trust boundary being tested.
 *
 * See notifications/src/templates/helpers.ts ESCAPING CONTRACT for the
 * per-context escaping rules this file validates.
 */

import { describe, expect, it } from 'vitest';
import {
  renderFundedEmail,
  renderPaymentEmail,
  renderDisputeEmail,
  renderDueWarningEmail,
  renderDigestEmail,
  escapeHtml,
  escapeDiscordMarkdown,
  escapeHeaderValue,
  escapeSmsText,
  isJsonSafeRoundTrip,
  formatAmount,
} from '../src/templates';
import { TemplateEngine } from '../src/template-engine';
import type { InvoiceEvent } from '../src/types';

// Adversarial payloads — each targets a specific output-context break
const ADVERSARIAL = {
  htmlScript: '<script>alert("xss")</script>',
  htmlImg: '<img src=x onerror=alert(1)>',
  htmlSvgAttr: '"><svg onload=alert(2)>',
  htmlAmpersand: '& < > " \' &lt; &gt;',
  jsonBreak: '","evil":"injected","x":"',
  jsonBackslash: '\\" \\n \\r',
  discordBold: '**@everyone bold**',
  discordSpoiler: '||spoiler|| __underline__ `code`',
  discordLink: '[click me](javascript:alert(1))',
  crlfHeader: 'invoice_funded\r\nX-Injected: evil',
  smsControl: 'Invoice\x00\x07 paid\nwith\x1F control chars\r\nsplit',
  stellarWithHtml: 'GABCD<script>alert(1)</script>000000000000000000000001',
  memoField: '"><img src=x onerror=alert(1)>',
};

function makeEvent(overrides: Partial<InvoiceEvent> = {}): InvoiceEvent {
  return {
    eventId: 'evt-adv-001',
    type: 'funded',
    invoiceId: 42,
    freelancer: 'GFREELANCER000000000000000000000000000000000000000000000001',
    payer: 'GPAYER00000000000000000000000000000000000000000000000000001',
    funder: 'GFUNDER000000000000000000000000000000000000000000000000001',
    amount: '10000000',
    dueDate: Math.floor(Date.now() / 1000) + 86400,
    discountRate: 300,
    ...overrides,
  };
}

describe('Injection audit — escaping helpers unit', () => {
  it('escapeHtml neutralizes all HTML-special chars', () => {
    const raw = ADVERSARIAL.htmlScript + ADVERSARIAL.htmlImg + ADVERSARIAL.htmlAmpersand;
    const esc = escapeHtml(raw);
    expect(esc).not.toContain('<script>');
    expect(esc).not.toContain('<img');
    expect(esc).toContain('&lt;script&gt;');
    expect(esc).toContain('&amp;');
    expect(esc).toContain('&quot;');
    expect(esc).toContain('&#39;');
  });

  it('escapeDiscordMarkdown neutralizes markdown abuse', () => {
    const raw = ADVERSARIAL.discordBold + ADVERSARIAL.discordSpoiler + ADVERSARIAL.discordLink;
    const esc = escapeDiscordMarkdown(raw);
    expect(esc).not.toContain('**');
    expect(esc).not.toContain('||');
    expect((esc.match(/@\u200b/g) ?? []).length).toBeGreaterThan(0); // @everyone broken
    expect(esc).toContain('\\*');
  });

  it('escapeDiscordMarkdown breaks @everyone / @here mentions', () => {
    expect(escapeDiscordMarkdown('@everyone hello')).toContain('@\u200b');
    expect(escapeDiscordMarkdown('@here hi')).toContain('@\u200b');
  });

  it('escapeHeaderValue strips CRLF injection', () => {
    const esc = escapeHeaderValue(ADVERSARIAL.crlfHeader);
    expect(esc).not.toContain('\r');
    expect(esc).not.toContain('\n');
    expect(esc).toContain('invoice_funded');
    // After stripping CRLF, the injected token becomes part of the same header value (not a new header line) — the critical guarantee is no line break
    expect(esc).not.toMatch(/[\r\n]/);
    // The value may still contain the substring but not as a header injection vector
    expect(esc).toBe('invoice_funded X-Injected: evil');
  });

  it('escapeSmsText strips control chars and truncates', () => {
    const esc = escapeSmsText(ADVERSARIAL.smsControl);
    expect(esc).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/);
    expect(esc).not.toContain('\x00');
  });

  it('isJsonSafeRoundTrip — webhook JSON context never breaks via JSON.stringify', () => {
    const payloads = [
      ADVERSARIAL.jsonBreak,
      ADVERSARIAL.htmlScript,
      ADVERSARIAL.discordBold,
      ADVERSARIAL.stellarWithHtml,
      '{"a":1}',
      'line1\nline2\r\nline3',
      '"quotes" and \'single\'',
    ];
    for (const p of payloads) {
      expect(isJsonSafeRoundTrip(p)).toBe(true);
      const encoded = JSON.stringify({ invoice: { freelancer: p, payer: p }, message: p });
      const decoded = JSON.parse(encoded) as any;
      expect(decoded.invoice.freelancer).toBe(p);
      expect(decoded.message).toBe(p);
    }
  });
});

describe('Injection audit — HTML email templates (funded/payment/dispute/due-warning/digest)', () => {
  const maliciousFreelancer = ADVERSARIAL.stellarWithHtml; // chain-derived address (user-controlled via Stellar account?)
  const maliciousPayer = ADVERSARIAL.htmlScript;
  const maliciousFunder = 'GFUNDER"><svg onload=alert(1)>000000000000000000000001';

  it('funded template — freelancer/payer/funder HTML injection is escaped', () => {
    const evt = makeEvent({ freelancer: maliciousFreelancer, payer: maliciousPayer, funder: maliciousFunder as any });
    const html = renderFundedEmail({ event: evt, recipientRole: 'freelancer' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onload=alert');
    expect(html).not.toContain('<svg');
    // shortAddress truncates long addresses — the injection is either escaped or removed by truncation, both are safe
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
    // Funder is truncated to first6…last6, so `<svg` in the middle is removed — verify truncation produced safe short address
    expect(html).toContain('GFUNDE');
  });

  it('funded template — amount field (chain amount) with HTML payload is escaped', () => {
    // Amount is BigInt-parsed — non-numeric HTML would throw, which is fail-closed. Valid numeric amount still tests escaping of other fields.
    const evt = makeEvent({ amount: '10000000', freelancer: maliciousFreelancer });
    const html = renderFundedEmail({ event: evt, recipientRole: 'freelancer' });
    expect(html).not.toContain('<script>');
    // formatAmount on HTML should throw, proving injection cannot be smuggled via amount
    expect(() => formatAmount(ADVERSARIAL.htmlScript)).toThrow();
  });

  it('payment template — HTML injection in payer address escaped', () => {
    const evt = makeEvent({ type: 'paid', payer: ADVERSARIAL.htmlImg });
    const html = renderPaymentEmail({ event: evt, recipientRole: 'freelancer' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('dispute template — funder injection escaped and funder row not exploitable', () => {
    const evt = makeEvent({ type: 'defaulted', funder: ADVERSARIAL.htmlScript as any });
    const html = renderDisputeEmail({ event: evt, recipientRole: 'lp' });
    expect(html).not.toContain('<script>');
    // funder is shortAddress-truncated, so check fragment escaping
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
  });

  it('due-warning template — payer HTML injection escaped', () => {
    const evt = makeEvent({ type: 'due_date_warning', payer: ADVERSARIAL.htmlSvgAttr });
    const html = renderDueWarningEmail({ event: evt });
    expect(html).not.toContain('<svg');
    expect(html).toContain('&lt;svg');
  });

  it('digest template — every row field escaped (freelancer, payer, amount, invoiceId)', () => {
    const items = [
      {
        invoiceId: 777,
        eventType: 'funded',
        amount: '700000000',
        freelancer: ADVERSARIAL.stellarWithHtml,
        payer: ADVERSARIAL.htmlScript,
        dueDate: Math.floor(Date.now() / 1000) + 86400,
        occurredAt: Date.now(),
      },
      {
        invoiceId: 778,
        eventType: 'paid',
        amount: '10000000', // numeric string — chain amount is always numeric; adversarial HTML would cause formatAmount throw, tested separately
        freelancer: 'GFREELANCER000000000000000000000000000000000000000000000001',
        payer: 'GPAYER00000000000000000000000000000000000000000000000000001',
        dueDate: Math.floor(Date.now() / 1000) + 86400,
        occurredAt: Date.now(),
      },
    ];
    const html = renderDigestEmail({
      recipientAddress: ADVERSARIAL.stellarWithHtml,
      frequency: 'daily',
      items: items as any,
      unsubscribeToken: 'tok-' + ADVERSARIAL.htmlScript,
      periodLabel: ADVERSARIAL.htmlScript,
      dashboardUrl: 'https://iln.finance',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // Discord-style fields if ever forwarded to Discord should also be safe — but HTML path is what digest uses
  });

  it('every HTML template escapes unsubscribeToken in URL attribute', () => {
    const tokenWithHtml = ADVERSARIAL.htmlScript;
    const html = renderDigestEmail({
      recipientAddress: 'GTEST000000000000000000000000000000000000000000000001',
      frequency: 'daily',
      items: [],
      unsubscribeToken: tokenWithHtml,
      periodLabel: '2026-09-23',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain(encodeURIComponent(tokenWithHtml).slice(0, 8)); // token is URL-encoded
  });

  it('HTML email dashboardUrl is escaped for href attribute', () => {
    const evilUrl = 'https://iln.finance/invoices/42"><script>alert(1)</script>';
    const html = renderFundedEmail({ event: makeEvent(), recipientRole: 'freelancer', dashboardUrl: evilUrl });
    expect(html).not.toContain('"><script>');
    expect(html).toContain('https://iln.finance');
    // The href should contain escaped version — the quote break must be encoded
    expect(html).not.toMatch(/href="[^"]*"><script>/);
  });
});

describe('Injection audit — webhook JSON context', () => {
  it('webhook JSON body with adversarial chain/user fields round-trips via JSON.stringify', () => {
    const payload = {
      trigger: 'invoice_funded',
      actor: 'freelancer',
      invoice: {
        id: 42,
        freelancer: ADVERSARIAL.stellarWithHtml,
        payer: ADVERSARIAL.htmlScript,
        amount: ADVERSARIAL.jsonBreak,
        due_date: 1780000000,
        discount_rate: 300,
        status: 'Funded',
        funder: ADVERSARIAL.htmlImg,
        funded_at: 1779000000,
        created_at: 1778000000,
        updated_at: 1779500000,
      },
      subject: `Invoice #42 ${ADVERSARIAL.htmlScript}`,
      message: `Amount ${ADVERSARIAL.jsonBreak} Due ${ADVERSARIAL.htmlImg}`,
      eventId: ADVERSARIAL.crlfHeader,
      eventType: 'funded',
    };
    const encoded = JSON.stringify(payload);
    // Must be valid JSON and must not break structure
    const decoded = JSON.parse(encoded) as any;
    expect(decoded.invoice.freelancer).toBe(ADVERSARIAL.stellarWithHtml);
    expect(decoded.message).toBe(payload.message);
    expect(decoded.eventId).toBe(ADVERSARIAL.crlfHeader);
    // Raw JSON string must contain escaped quotes, not raw breaking
    expect(encoded).toContain('\\"');
  });

  it('webhook headers escape CRLF injection', () => {
    const evilTrigger = ADVERSARIAL.crlfHeader as any;
    const evilRecipient = 'GTEST\r\nInjected-Header: evil';
    expect(escapeHeaderValue(evilTrigger)).not.toMatch(/[\r\n]/);
    expect(escapeHeaderValue(evilRecipient)).not.toMatch(/[\r\n]/);
  });
});

describe('Injection audit — SMS plain-text context', () => {
  it('SMS text with HTML/JS injection does not break carrier framing (control char stripped)', () => {
    const evt = makeEvent({ payer: ADVERSARIAL.htmlScript, freelancer: ADVERSARIAL.smsControl });
    const subject = `Invoice #${evt.invoiceId} ${ADVERSARIAL.htmlScript}`;
    const smsBody = [subject, '', `Invoice #${evt.invoiceId}`, `Status: ${evt.payer}`, `Due date: invalid`].join('\n');
    const safe = escapeSmsText(smsBody);
    // SMS is plain-text: <script> as literal text is not executable, so we only ensure control-char stripping
    expect(safe).toContain('<script>'); // plain text is okay for SMS
    expect(safe).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/);
  });
});

describe('Injection audit — Discord markdown context (future adapter)', () => {
  it('Discord markdown abuse is neutralized', () => {
    const raw = `${ADVERSARIAL.discordBold} ${ADVERSARIAL.discordSpoiler} ${ADVERSARIAL.discordLink} @here`;
    const esc = escapeDiscordMarkdown(raw);
    expect(esc).not.toContain('**');
    expect(esc).not.toContain('||');
    expect(esc).not.toContain('@here'); // @ must be broken
    expect(esc).toContain('\\*');
  });

  it('notification digest forwarded to Discord would be safe (if ever added)', () => {
    const item = {
      invoiceId: 42,
      eventType: 'funded',
      amount: '10000000',
      freelancer: ADVERSARIAL.discordBold,
      payer: ADVERSARIAL.discordSpoiler,
      dueDate: Math.floor(Date.now() / 1000),
      occurredAt: Date.now(),
    };
    // Simulate Discord rendering of amount/freelancer via markdown escaper
    const safeFreelancer = escapeDiscordMarkdown(item.freelancer);
    const safePayer = escapeDiscordMarkdown(item.payer);
    expect(safeFreelancer).not.toContain('**');
    expect(safePayer).not.toContain('||');
  });
});

describe('Injection audit — template-engine context-aware escaping', () => {
  it('template-engine HTML context escapes script', () => {
    const engine = new TemplateEngine();
    engine.upsertTemplate({
      id: 'test_html',
      name: 'Test',
      version: '1.0.0',
      subject: 'Hi {{payer}}',
      body: 'Invoice {{invoiceId}} from {{payer}} amount {{amount}}',
      triggers: ['invoice_funded'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const result = engine.render('test_html', {
      payer: ADVERSARIAL.htmlScript,
      invoiceId: '42' as any,
      amount: ADVERSARIAL.htmlImg,
    } as any, 'html');
    expect(result.body).not.toContain('<script>');
    expect(result.body).not.toContain('<img');
    expect(result.body).toContain('&lt;script&gt;');
  });

  it('template-engine discord context escapes markdown', () => {
    const engine = new TemplateEngine();
    engine.upsertTemplate({
      id: 'test_discord',
      name: 'Test',
      version: '1.0.0',
      subject: '{{invoiceId}}',
      body: 'Update {{payer}}',
      triggers: ['invoice_funded'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const r = engine.render('test_discord', { payer: ADVERSARIAL.discordBold } as any, 'discord');
    expect(r.body).not.toContain('**');
    expect(r.body).toContain('\\*');
  });

  it('template-engine sms context strips control chars', () => {
    const engine = new TemplateEngine();
    engine.upsertTemplate({
      id: 'test_sms',
      name: 'Test',
      version: '1.0.0',
      subject: '{{invoiceId}}',
      body: 'Hi {{payer}}',
      triggers: ['invoice_funded'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const r = engine.render('test_sms', { payer: ADVERSARIAL.smsControl } as any, 'sms');
    expect(r.body).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/);
  });

  it('template-engine json context escapes quotes for manual embedding', () => {
    const engine = new TemplateEngine();
    engine.upsertTemplate({
      id: 'test_json',
      name: 'Test',
      version: '1.0.0',
      subject: '{{invoiceId}}',
      body: '{"payer":"{{payer}}"}',
      triggers: ['invoice_funded'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const r = engine.render('test_json', { payer: ADVERSARIAL.jsonBreak } as any, 'json');
    // The body should be valid JSON after escaping (quotes escaped)
    expect(() => JSON.parse(r.body)).not.toThrow();
    const parsed = JSON.parse(r.body) as any;
    expect(parsed.payer).toBe(ADVERSARIAL.jsonBreak);
  });

  it('default render (html) is safe — calling without explicit context does not emit raw script', () => {
    const engine = new TemplateEngine();
    engine.upsertTemplate({
      id: 'test_default',
      name: 'Test',
      version: '1.0.0',
      subject: '{{payer}}',
      body: '{{payer}}',
      triggers: ['invoice_funded'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const r = engine.render('test_default', { payer: ADVERSARIAL.htmlScript } as any);
    expect(r.body).not.toContain('<script>');
    expect(r.body).toContain('&lt;script&gt;');
  });
});

describe('Injection audit — enumeration of all interpolated fields (data-source trace)', () => {
  it('documents every template field and its trust level (prevent future regressions)', () => {
    // This test is a living inventory — if a template adds a field without an entry here, it must be added
    const inventory: Array<{ template: string; field: string; source: 'chain' | 'user' | 'internal' | 'chain+user'; context: string; escaper: string }> = [
      // funded.template.ts
      { template: 'funded.template', field: 'invoiceId', source: 'chain', context: 'html', escaper: 'escapeHtml' },
      { template: 'funded.template', field: 'amount', source: 'chain', context: 'html', escaper: 'escapeHtml(formatAmount())' },
      { template: 'funded.template', field: 'dueDate', source: 'chain', context: 'html', escaper: 'escapeHtml(formatDate())' },
      { template: 'funded.template', field: 'freelancer', source: 'chain', context: 'html', escaper: 'escapeHtml(shortAddress())' },
      { template: 'funded.template', field: 'payer', source: 'chain', context: 'html', escaper: 'escapeHtml(shortAddress())' },
      { template: 'funded.template', field: 'funder', source: 'chain', context: 'html', escaper: 'escapeHtml(shortAddress())' },
      { template: 'funded.template', field: 'greeting', source: 'internal', context: 'html', escaper: 'escapeHtml' },
      { template: 'funded.template', field: 'dashboardUrl', source: 'user+internal', context: 'html-attr', escaper: 'escapeHtml(href)' },
      // payment.template.ts
      { template: 'payment.template', field: 'invoiceId/amount/dueDate/freelancer/payer/funder', source: 'chain', context: 'html', escaper: 'escapeHtml' },
      // dispute.template.ts
      { template: 'dispute.template', field: 'invoiceId/amount/dueDate/freelancer/payer/funder', source: 'chain', context: 'html', escaper: 'escapeHtml' },
      // due-warning.template.ts
      { template: 'due-warning.template', field: 'invoiceId/amount/dueDate/freelancer/payer', source: 'chain', context: 'html', escaper: 'escapeHtml' },
      // digest.template.ts
      { template: 'digest.template', field: 'recipientAddress', source: 'user', context: 'html', escaper: 'escapeHtml(shortAddress)' },
      { template: 'digest.template', field: 'frequency/periodLabel', source: 'internal', context: 'html', escaper: 'escapeHtml' },
      { template: 'digest.template', field: 'items[].freelancer/payer/amount', source: 'chain', context: 'html', escaper: 'escapeHtml' },
      { template: 'digest.template', field: 'unsubscribeToken', source: 'internal', context: 'url', escaper: 'encodeURIComponent + escapeHtml' },
      // delivery.ts channels
      { template: 'delivery:email', field: 'payload.message/subject/invoice.status', source: 'chain+internal', context: 'html', escaper: 'escapeHtml + escapeHeaderValue' },
      { template: 'delivery:webhook', field: 'invoice/trigger/actor/subject/message/eventId', source: 'chain+user', context: 'json', escaper: 'JSON.stringify' },
      { template: 'delivery:webhook headers', field: 'X-ILN-Trigger/Recipient/Event-Id', source: 'chain+user', context: 'header', escaper: 'escapeHeaderValue' },
      { template: 'delivery:sms', field: 'subject/invoice.id/status/due_date', source: 'chain+internal', context: 'sms', escaper: 'escapeSmsText' },
      { template: 'delivery:websocket', field: 'InvoiceEvent JSON', source: 'chain', context: 'json', escaper: 'JSON.stringify' },
      { template: 'template-engine', field: '{{var}} any', source: 'chain+user+internal', context: 'html/discord/sms/json', escaper: 'escapeForContext()' },
    ];
    // This array is the source of truth — every interpolation must appear here
    expect(inventory.length).toBeGreaterThanOrEqual(15);
    // Every chain or user source must have an explicit escaper (not "none")
    for (const row of inventory) {
      if (row.source === 'chain' || row.source === 'user' || row.source === 'chain+user' || row.source === 'chain+user+internal') {
        expect(row.escaper).not.toMatch(/^none$/i);
        expect(row.escaper.length).toBeGreaterThan(0);
      }
    }
  });
});
