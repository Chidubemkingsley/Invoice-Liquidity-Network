process.env.NOTIFICATIONS_RPC_URL = 'http://localhost:8000';
process.env.NOTIFICATIONS_CONTRACT_ID = 'GTESTCONTRACT';
process.env.NOTIFICATIONS_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
process.env.RESEND_API_KEY = 'test-api-key';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDb, setDb, createSubscription, getDeliveryAuditLogs } from '../src/db';
import { resetProviderHealth, simulateProviderOutage, restoreProvider, getProviderHealth, fallbackCapacityLimiter } from '../src/provider-health';
import { deliverWithFallback, drillProviderOutage } from '../src/fallback';
import { clearDeadLetterQueue, resetCircuitBreakers } from '../src/delivery';

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

function makeInvoice(id: number) {
  return {
    id,
    freelancer: 'GFREELANCER',
    payer: 'GPAYER',
    amount: '100000000',
    due_date: Math.floor(Date.now() / 1000) + 86400,
    discount_rate: 300,
    status: 'Funded' as const,
    funder: 'GFUNDER',
    funded_at: 1_700_000_000,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function makePayload(trigger: any, invoiceId: number, recipient: string) {
  return {
    trigger,
    invoice: makeInvoice(invoiceId),
    recipientAddress: recipient,
    subject: `Invoice #${invoiceId} ${trigger}`,
    message: `msg ${trigger}`,
    actor: 'freelancer' as const,
    eventId: `evt-${invoiceId}-${trigger}`,
  };
}

beforeEach(() => {
  setDb(createDb(':memory:'));
  resetProviderHealth();
  clearDeadLetterQueue();
  resetCircuitBreakers();
  fallbackCapacityLimiter.reset();
  vi.useFakeTimers();
  emailSend.mockReset().mockResolvedValue({ id: 'email-1' });
  smsCreate.mockReset().mockResolvedValue({ sid: 'SM123' });
  twilioFactory.mockReturnValue({ messages: { create: smsCreate } });
  dnsLookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Provider degraded fallback routing', () => {
  it('uses primary channel when provider is healthy', async () => {
    const recipient = 'GRECIPIENT_HEALTHY';
    const emailSub = createSubscription({
      stellar_address: recipient,
      channel: 'email',
      destination: 'healthy@example.com',
      triggers: ['invoice_funded'],
    });

    const result = await deliverWithFallback(emailSub as any, makePayload('invoice_funded', 1, recipient) as any);
    await vi.runAllTimersAsync();

    expect(result.success).toBe(true);
    expect(result.channel).toBe('email');
    expect(result.fallbackChannel).toBeUndefined();
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(getProviderHealth('email')).toBe('healthy');
  });

  it('automatically falls back to webhook when email provider is unhealthy', async () => {
    const recipient = 'GRECIPIENT_FALLBACK';
    const emailSub = createSubscription({
      stellar_address: recipient,
      channel: 'email',
      destination: 'fail@example.com',
      triggers: ['invoice_funded'],
    });
    createSubscription({
      stellar_address: recipient,
      channel: 'webhook',
      destination: 'https://fallback.example.com/hook',
      triggers: ['invoice_funded'],
    });

    simulateProviderOutage('email');
    expect(getProviderHealth('email')).toBe('unhealthy');

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deliverWithFallback(emailSub as any, makePayload('invoice_funded', 2, recipient) as any);
    await vi.runAllTimersAsync();

    expect(result.success).toBe(true);
    expect(result.fallbackChannel).toBe('webhook');
    expect(fetchMock).toHaveBeenCalledWith('https://fallback.example.com/hook', expect.anything());

    // Audit log shows fallback channel record
    const audits = getDeliveryAuditLogs({ recipient });
    const webhookAudit = audits.find((a) => a.channel === 'webhook');
    expect(webhookAudit).toBeDefined();
    expect(webhookAudit?.status).toBe('delivered');

    restoreProvider('email');
  });

  it('prefers critical over low priority under constrained fallback capacity', async () => {
    const recipient = 'GRECIPIENT_PRIORITY';
    const emailSubLow = createSubscription({
      stellar_address: recipient,
      channel: 'email',
      destination: 'low@example.com',
      triggers: ['invoice_funded'], // low priority
    });
    const emailSubCritical = createSubscription({
      stellar_address: recipient,
      channel: 'email',
      destination: 'critical@example.com',
      triggers: ['invoice_defaulted'], // critical
    });
    createSubscription({
      stellar_address: recipient,
      channel: 'webhook',
      destination: 'https://fallback-priority.example.com/hook',
      triggers: ['invoice_funded', 'invoice_defaulted'],
    });

    simulateProviderOutage('email');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    // Exhaust fallback capacity with low-priority deliveries
    // Set limiter to tiny window: max 1 per window
    // We hack by directly setting private count via repeated calls
    fallbackCapacityLimiter.reset();
    // Fill capacity: 1 low-priority fallback consumes the slot
    const lowResult = await deliverWithFallback(emailSubLow as any, makePayload('invoice_funded', 10, recipient) as any);
    await vi.runAllTimersAsync();
    expect(lowResult.success).toBe(true);

    // Advance to not reset window, next low-priority should be shed
    // Fill remaining capacity (max 100 per window) so next low is shed.
    // Already used 1, so need 99 more to reach 100.
    for (let i = 0; i < 99; i++) {
      fallbackCapacityLimiter.tryAcquire('low');
    }

    const lowSecond = await deliverWithFallback(emailSubLow as any, makePayload('invoice_funded', 11, recipient) as any);
    await vi.runAllTimersAsync();
    // Low priority second should be shed (capacityAllowed false)
    expect(lowSecond.capacityAllowed).toBe(false);
    expect(lowSecond.success).toBe(false);

    // Critical should still get through even when capacity exhausted
    const criticalResult = await deliverWithFallback(emailSubCritical as any, makePayload('invoice_defaulted', 12, recipient) as any);
    await vi.runAllTimersAsync();
    expect(criticalResult.success).toBe(true);
    expect(criticalResult.priority).toBe('critical');
    expect(criticalResult.capacityAllowed).toBe(true);
    expect(criticalResult.fallbackChannel).toBe('webhook');

    restoreProvider('email');
  });

  it('drill simulating primary-provider outage verifies fallback delivery actually occurs', async () => {
    const recipient = 'GDRILL';
    const emailSub = createSubscription({
      stellar_address: recipient,
      channel: 'email',
      destination: 'drill@example.com',
      triggers: ['invoice_paid'], // high priority
    });
    createSubscription({
      stellar_address: recipient,
      channel: 'webhook',
      destination: 'https://drill-fallback.example.com/hook',
      triggers: ['invoice_paid'],
    });

    emailSend.mockRejectedValue(new Error('Resend outage'));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const { outageSimulated, fallbackResult } = await drillProviderOutage(
      'email',
      makePayload('invoice_paid', 99, recipient) as any,
      emailSub as any
    );
    await vi.runAllTimersAsync();

    expect(outageSimulated).toBe(true);
    expect(fallbackResult.success).toBe(true);
    expect(fallbackResult.fallbackChannel).toBe('webhook');
    expect(fetchMock).toHaveBeenCalled();

    // Provider health restored after drill
    expect(getProviderHealth('email')).toBe('healthy');
  });

  it('health check probes and updates provider status', async () => {
    const { checkProviderHealth } = await import('../src/provider-health');
    // Mock fetch to simulate healthy probe
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    process.env.RESEND_HEALTH_URL = 'https://api.resend.com/health';
    let result = await checkProviderHealth('email');
    expect(result.healthy).toBe(true);
    expect(getProviderHealth('email')).toBe('healthy');

    // Simulate unhealthy probe — need 3 consecutive failures to degrade (threshold 3)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    for (let i = 0; i < 3; i++) {
      result = await checkProviderHealth('email');
    }
    expect(result.healthy).toBe(false);
    expect(['degraded', 'unhealthy']).toContain(getProviderHealth('email'));

    delete process.env.RESEND_HEALTH_URL;
  });
});
