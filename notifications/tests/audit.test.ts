process.env.NOTIFICATIONS_RPC_URL = 'http://localhost:8000';
process.env.NOTIFICATIONS_CONTRACT_ID = 'GTESTCONTRACT';
process.env.NOTIFICATIONS_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
process.env.RESEND_API_KEY = 'test-api-key';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api';
import {
  createDb,
  setDb,
  getDeliveryAuditLogs,
  countDeliveryAuditLogs,
  purgeExpiredDeliveryLogs,
  createSubscription,
  createDeliveryAuditLog,
} from '../src/db';

// Hoisted mocks for delivery providers
const { emailSend, smsCreate, twilioFactory, dnsLookup } = vi.hoisted(() => ({
  emailSend: vi.fn(),
  smsCreate: vi.fn(),
  twilioFactory: vi.fn(),
  dnsLookup: vi.fn(),
}));

vi.mock('../src/config', async () => {
  const actual = (await vi.importActual('../src/config')) as any;
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      resendApiKey: 'test-key',
      resendFromEmail: 'no-reply@example.com',
      twilioAccountSid: 'AC123',
      twilioAuthToken: 'auth-token',
      twilioFromNumber: '+15551234567',
      maxWebhookRetry: 3,
      webhookBackoffBaseMs: 10,
      dueWarningHours: 48,
    },
  };
});

vi.mock('node:dns/promises', () => ({
  lookup: dnsLookup,
}));

vi.mock('resend', () => ({
  Resend: vi.fn(function Resend() {
    return { emails: { send: emailSend } };
  }),
}));

vi.mock('twilio', () => ({ default: twilioFactory }));

describe('Delivery audit log — durable, queryable, retention-enforced', () => {
  const app = createApp();

  beforeEach(() => {
    setDb(createDb(':memory:'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    emailSend.mockReset().mockResolvedValue({ id: 'email-1' });
    smsCreate.mockReset().mockResolvedValue({ sid: 'SM123', status: 'queued' });
    twilioFactory.mockReturnValue({ messages: { create: smsCreate } });
    dnsLookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('creates an audit record on successful email delivery with attempt timestamps and channel', async () => {
    const { sendEmail, clearDeadLetterQueue, resetCircuitBreakers } = await import('../src/delivery');
    clearDeadLetterQueue();
    resetCircuitBreakers();

    const sub = createSubscription({
      stellar_address: 'GRECIPIENT',
      channel: 'email',
      destination: 'user@example.com',
      triggers: ['invoice_funded'],
    });

    await sendEmail(sub as any, {
      trigger: 'invoice_funded',
      invoice: {
        id: 1,
        freelancer: 'GRECIPIENT',
        payer: 'GPAYER',
        amount: '1000',
        due_date: Math.floor(Date.now() / 1000) + 86400,
        discount_rate: 100,
        status: 'Funded',
        funder: null,
        funded_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      recipientAddress: 'GRECIPIENT',
      subject: 'Invoice #1 funded',
      message: 'funded',
      actor: 'freelancer',
      eventId: 'evt-1',
    });

    const logs = getDeliveryAuditLogs({ recipient: 'GRECIPIENT' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      invoice_id: 1,
      trigger: 'invoice_funded',
      recipient_address: 'GRECIPIENT',
      channel: 'email',
      destination: 'user@example.com',
      event_id: 'evt-1',
      status: 'delivered',
    });
    expect(logs[0].attempts).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(logs[0].attempt_timestamps)).toBe(true);
    expect(logs[0].attempt_timestamps.length).toBe(logs[0].attempts);
  });

  it('creates an audit record on permanent email failure with final status failed', async () => {
    const { sendEmail, clearDeadLetterQueue, resetCircuitBreakers } = await import('../src/delivery');
    clearDeadLetterQueue();
    resetCircuitBreakers();
    emailSend.mockRejectedValue(new Error('provider down'));

    const sub = createSubscription({
      stellar_address: 'GFAIL',
      channel: 'email',
      destination: 'fail@example.com',
      triggers: ['invoice_paid'],
    });

    const promise = sendEmail(sub as any, {
      trigger: 'invoice_paid',
      invoice: {
        id: 2,
        freelancer: 'GFAIL',
        payer: 'GPAYER',
        amount: '2000',
        due_date: Math.floor(Date.now() / 1000) + 86400,
        discount_rate: 100,
        status: 'Paid',
        funder: null,
        funded_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      recipientAddress: 'GFAIL',
      subject: 'Invoice #2 paid',
      message: 'paid',
      actor: 'freelancer',
      eventId: 'evt-2',
    });

    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;

    const logs = getDeliveryAuditLogs({ recipient: 'GFAIL' });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('failed');
    expect(logs[0].channel).toBe('email');
    expect(logs[0].attempts).toBe(3);
    expect(logs[0].last_error).toMatch(/provider down|Circuit breaker/);
    expect(logs[0].attempt_timestamps).toHaveLength(3);
  });

  it('creates audit records for webhook success and permanent failure', async () => {
    const { sendWebhook, clearDeadLetterQueue, resetCircuitBreakers } = await import('../src/delivery');
    clearDeadLetterQueue();
    resetCircuitBreakers();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const sub = createSubscription({
      stellar_address: 'GWEBHOOK',
      channel: 'webhook',
      destination: 'https://example.com/hook',
      triggers: ['invoice_funded'],
    });

    await sendWebhook(sub as any, {
      trigger: 'invoice_funded',
      invoice: {
        id: 3,
        freelancer: 'GWEBHOOK',
        payer: 'GPAYER',
        amount: '3000',
        due_date: Math.floor(Date.now() / 1000) + 86400,
        discount_rate: 100,
        status: 'Funded',
        funder: null,
        funded_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      recipientAddress: 'GWEBHOOK',
      subject: 'funded',
      message: 'msg',
      actor: 'freelancer',
      eventId: 'evt-3',
    } as any);
    await vi.runAllTimersAsync();

    let logs = getDeliveryAuditLogs({ recipient: 'GWEBHOOK' });
    expect(logs[logs.length - 1].status).toBe('delivered');
    expect(logs[logs.length - 1].channel).toBe('webhook');

    // Now permanent failure
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const sub2 = createSubscription({
      stellar_address: 'GWEBHOOK2',
      channel: 'webhook',
      destination: 'https://example.com/hook2',
      triggers: ['invoice_paid'],
    });

    const p = sendWebhook(sub2 as any, {
      trigger: 'invoice_paid',
      invoice: {
        id: 4,
        freelancer: 'GWEBHOOK2',
        payer: 'GPAYER',
        amount: '4000',
        due_date: Math.floor(Date.now() / 1000) + 86400,
        discount_rate: 100,
        status: 'Paid',
        funder: null,
        funded_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      recipientAddress: 'GWEBHOOK2',
      subject: 'paid',
      message: 'msg',
      actor: 'freelancer',
      eventId: 'evt-4',
    } as any);
    await vi.runAllTimersAsync();
    await p;

    logs = getDeliveryAuditLogs({ recipient: 'GWEBHOOK2' });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('failed');
    expect(logs[0].attempts).toBe(3);
    expect(logs[0].attempt_timestamps).toHaveLength(3);
  });

  it('creates audit record even when webhook is rejected by SSRF (private IP)', async () => {
    const { sendWebhook, clearDeadLetterQueue, resetCircuitBreakers } = await import('../src/delivery');
    clearDeadLetterQueue();
    resetCircuitBreakers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const sub = createSubscription({
      stellar_address: 'GSSRF',
      channel: 'webhook',
      destination: 'http://169.254.169.254/latest/meta-data/',
      triggers: ['invoice_funded'],
    });

    await sendWebhook(sub as any, {
      trigger: 'invoice_funded' as any,
      invoice: {
        id: 5,
        freelancer: 'GSSRF',
        payer: 'GPAYER',
        amount: '5000',
        due_date: Math.floor(Date.now() / 1000) + 86400,
        discount_rate: 100,
        status: 'Funded',
        funder: null,
        funded_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      recipientAddress: 'GSSRF',
      subject: 'funded',
      message: 'msg',
      actor: 'freelancer',
      eventId: 'evt-5',
    } as any);
    await vi.runAllTimersAsync();

    const logs = getDeliveryAuditLogs({ recipient: 'GSSRF' });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('failed');
    expect(logs[0].last_error).toMatch(/169\.254/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('query interface filters by recipient, event, and time range', async () => {
    // Seed audit logs directly for time-range test
    const now = Date.now();
    createDeliveryAuditLog({
      invoice_id: 10,
      trigger: 'invoice_funded',
      recipient_address: 'GALICE',
      channel: 'email',
      destination: 'alice@example.com',
      event_id: 'evt-alice-1',
      status: 'delivered',
      attempts: 1,
      last_error: null,
      attempt_timestamps: [now - 2 * 24 * 60 * 60 * 1000],
    });
    // Manually adjust created_at to simulate old record
    const db = (await import('../src/db')).getDb();
    db.prepare(`UPDATE delivery_audit_log SET created_at = ?, updated_at = ? WHERE recipient_address = 'GALICE'`).run(now - 2 * 24 * 60 * 60 * 1000, now - 2 * 24 * 60 * 60 * 1000);

    createDeliveryAuditLog({
      invoice_id: 11,
      trigger: 'invoice_paid',
      recipient_address: 'GBOB',
      channel: 'sms',
      destination: '+15550001111',
      event_id: 'evt-bob-1',
      status: 'failed',
      attempts: 3,
      last_error: 'timeout',
      attempt_timestamps: [now, now],
    });

    // By recipient
    let res = await request(app).get('/audit/deliveries?recipient=GALICE');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.records[0].recipient_address).toBe('GALICE');

    // By event
    res = await request(app).get('/audit/deliveries?eventId=evt-bob-1');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.records[0].event_id).toBe('evt-bob-1');

    // By time range — only recent (last 1 day) should exclude GALICE's 2-day-old record
    const startIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    res = await request(app).get(`/audit/deliveries?start=${encodeURIComponent(startIso)}`);
    expect(res.status).toBe(200);
    const recipients = res.body.records.map((r: any) => r.recipient_address);
    expect(recipients).not.toContain('GALICE');
    expect(recipients).toContain('GBOB');

    // By channel and status
    res = await request(app).get('/audit/deliveries?channel=sms&status=failed');
    expect(res.status).toBe(200);
    expect(res.body.records.every((r: any) => r.channel === 'sms' && r.status === 'failed')).toBe(true);
  });

  it('retention policy purges audit logs after 90 days and sent_notifications after 30 days', async () => {
    const now = Date.now();
    // Recent audit log (should survive)
    createDeliveryAuditLog({
      invoice_id: 20,
      trigger: 'invoice_funded',
      recipient_address: 'GRECENT',
      channel: 'email',
      destination: 'recent@example.com',
      event_id: 'evt-recent',
      status: 'delivered',
      attempts: 1,
      last_error: null,
      attempt_timestamps: [now],
    });

    // Old audit log (91 days old — should be purged)
    const oldAudit = createDeliveryAuditLog({
      invoice_id: 21,
      trigger: 'invoice_paid',
      recipient_address: 'GOLD',
      channel: 'webhook',
      destination: 'https://old.example.com/hook',
      event_id: 'evt-old',
      status: 'failed',
      attempts: 2,
      last_error: 'timeout',
      attempt_timestamps: [now - 91 * 24 * 60 * 60 * 1000],
    });
    const db = (await import('../src/db')).getDb();
    const oldTime = now - 91 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE delivery_audit_log SET created_at = ?, updated_at = ? WHERE id = ?').run(oldTime, oldTime, oldAudit.id);

    // Old sent_notifications (31 days old — should be purged per privacy.md 30d)
    db.prepare(
      `INSERT INTO sent_notifications (invoice_id, trigger, recipient_address, channel, destination, event_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(99, 'invoice_funded', 'GOLD', 'email', 'old@example.com', 'evt-old-sent', now - 31 * 24 * 60 * 60 * 1000);

    // Old webhook logs (91 days old — should be purged per 90d)
    const webhookSub = createSubscription({
      stellar_address: 'GOLD',
      channel: 'webhook',
      destination: 'https://old.example.com/hook',
      triggers: ['invoice_funded'],
    });
    db.prepare(
      `INSERT INTO webhook_delivery_logs (subscription_id, event_id, trigger, invoice_id, recipient_address, status, attempts, response_status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(webhookSub.id, 'evt-old-whook', 'invoice_funded', 21, 'GOLD', 'failed', 3, 500, 'timeout', oldTime, oldTime);

    expect(countDeliveryAuditLogs()).toBe(2);

    const result = purgeExpiredDeliveryLogs(now);
    expect(result.auditLogs).toBe(1);
    expect(result.sentNotifications).toBe(1);
    expect(result.webhookLogs).toBe(1);

    expect(countDeliveryAuditLogs()).toBe(1);
    expect(countDeliveryAuditLogs({ recipient: 'GRECENT' })).toBe(1);
    expect(countDeliveryAuditLogs({ recipient: 'GOLD' })).toBe(0);

    // Via API purge endpoint
    // Seed another old record to test API
    const anotherOld = createDeliveryAuditLog({
      invoice_id: 22,
      trigger: 'invoice_defaulted',
      recipient_address: 'GOLD2',
      channel: 'sms',
      destination: '+15550002222',
      event_id: 'evt-old2',
      status: 'failed',
      attempts: 1,
      last_error: 'error',
      attempt_timestamps: [oldTime],
    });
    db.prepare('UPDATE delivery_audit_log SET created_at = ?, updated_at = ? WHERE id = ?').run(oldTime, oldTime, anotherOld.id);

    const res = await request(app).post('/audit/purge').send({});
    expect(res.status).toBe(200);
    expect(res.body.purged.auditLogs).toBe(1);
    expect(res.body.retentionPolicy.auditLogsDays).toBe(90);
  });

  it('durability: audit log is independent of transient dispatch-retry state', async () => {
    // Simulate that webhook_delivery_logs are transient and get cleared on restart,
    // but audit log persists. Create both, then delete webhook logs and verify audit remains.
    const now = Date.now();
    createDeliveryAuditLog({
      invoice_id: 30,
      trigger: 'invoice_funded',
      recipient_address: 'GDURABLE',
      channel: 'webhook',
      destination: 'https://durable.example.com/hook',
      event_id: 'evt-durable',
      status: 'failed',
      attempts: 3,
      last_error: 'HTTP 500',
      attempt_timestamps: [now - 1000, now - 500, now],
    });
    const db = (await import('../src/db')).getDb();
    const durableSub = createSubscription({
      stellar_address: 'GDURABLE',
      channel: 'webhook',
      destination: 'https://durable.example.com/hook',
      triggers: ['invoice_funded'],
    });
    db.prepare(
      `INSERT INTO webhook_delivery_logs (subscription_id, event_id, trigger, invoice_id, recipient_address, status, attempts, response_status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(durableSub.id, 'evt-durable', 'invoice_funded', 30, 'GDURABLE', 'failed', 3, 500, 'HTTP 500', now, now);

    // Simulate clearing transient retry state (e.g., process restart clears in-memory retry queue + webhook logs truncation)
    db.prepare('DELETE FROM webhook_delivery_logs WHERE event_id = ?').run('evt-durable');
    const webhookLogs = db.prepare('SELECT * FROM webhook_delivery_logs WHERE event_id = ?').all('evt-durable');
    expect(webhookLogs).toHaveLength(0);

    // Audit log must still be queryable
    const audits = getDeliveryAuditLogs({ eventId: 'evt-durable' });
    expect(audits).toHaveLength(1);
    expect(audits[0].status).toBe('failed');
    expect(audits[0].attempt_timestamps).toHaveLength(3);
  });
});
