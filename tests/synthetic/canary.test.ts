/**
 * tests/synthetic/canary.test.ts
 *
 * Synthetic canary monitoring tests — critical-path coverage.
 *
 * These tests run against lightweight Node.js http servers and a mock WebSocket
 * client so the suite executes fully offline in CI with ZERO external dependencies.
 * Each logical check is isolated in its own `it` block so failures are pinpointed.
 * Extended in batch hardening to cover pagination consistency, GraphQL↔REST
 * parity, subscription lifecycle, cache behavior, and cross-service read-verify.
 */

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ── Constants & Ports ─────────────────────────────────────────────────────────

const CANARY_INVOICE_ID = 1;
const CANARY_PAYER_ADDRESS = 'GC5GY2JTEOIVJDNFPEZQNMGZBTZJ5LFTJFWL5UB3LV4BGVVQAHC3D4S';

const INDEXER_PORT = 3091;
const NOTIFICATIONS_PORT = 4091;
const NOTIFICATIONS_WS_PORT = 4092;
const ORACLE_PORT = 3191;

const INDEXER_BASE_URL = `http://localhost:${INDEXER_PORT}`;
const NOTIFICATIONS_BASE_URL = `http://localhost:${NOTIFICATIONS_PORT}`;
const ORACLE_BASE_URL = `http://localhost:${ORACLE_PORT}`;
const WS_URL = `ws://localhost:${NOTIFICATIONS_WS_PORT}/ws`;

// ── Mock WebSocket class for offline testing ─────────────────────────────────

class MockWebSocket extends EventEmitter {
  public readyState = 1; // OPEN

  constructor(_url: string) {
    super();
    setTimeout(() => {
      this.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'heartbeat',
            payload: { clientId: 'mock-canary-client' },
            timestamp: Date.now(),
          }),
        ),
      );
    }, 20);
  }

  send(_data?: any) {}
  close() {
    this.emit('close');
  }
  terminate() {
    this.emit('close');
  }
}

(globalThis as any).WebSocket = MockWebSocket;

// ── Set process env BEFORE importing synthetic-canary module ─────────────────

process.env.INDEXER_BASE_URL = INDEXER_BASE_URL;
process.env.NOTIFICATIONS_BASE_URL = NOTIFICATIONS_BASE_URL;
process.env.ORACLE_BASE_URL = ORACLE_BASE_URL;
process.env.NOTIFICATIONS_WS_URL = WS_URL;
process.env.CANARY_INVOICE_ID = String(CANARY_INVOICE_ID);
process.env.CANARY_PAYER_ADDRESS = CANARY_PAYER_ADDRESS;
process.env.CANARY_REQUEST_TIMEOUT_MS = '4000';
process.env.CANARY_WEBHOOK_SUB_ID = '0';

let checkIndexer: typeof import('../../scripts/synthetic-canary').checkIndexer;
let checkNotifications: typeof import('../../scripts/synthetic-canary').checkNotifications;
let checkOracle: typeof import('../../scripts/synthetic-canary').checkOracle;
let checkCrossService: typeof import('../../scripts/synthetic-canary').checkCrossService;
let runAllCanaryChecks: typeof import('../../scripts/synthetic-canary').runAllCanaryChecks;

// ── HTTP Mock Servers ─────────────────────────────────────────────────────────

let indexerServer: http.Server;
let notificationsServer: http.Server;
let oracleServer: http.Server;

// Controllable server state for testing failure paths
let indexerHealthStatus = 'ok';
let indexerInvoiceNotFound = false;
let notificationsHealthStatus = 'ok';
let oracleHealthStatus = 'ok';
let oracleVerifyStatus = 200;
let oracleCorruptPayload = false;

// In-memory store for notifications subscription round-trip
let notifSubs: Array<{ id: number; stellar_address: string; destination: string; channel: string }> = [];
let nextSubId = 1000;
let oracleVerifyCallCount = 0;

function createIndexerServer(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    res.setHeader('Content-Type', 'application/json');
    // Tracing: reflect or generate W3C traceparent for canary propagation checks
    const incTp = req.headers['traceparent'] as string | undefined;
    if (incTp && /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[0-9a-f]$/i.test(incTp)) {
      res.setHeader('traceparent', incTp);
      res.setHeader('x-trace-id', incTp.split('-')[1]);
    } else if (url.pathname === '/v1/health' || url.pathname === '/health' || url.pathname === '/v1/dashboard' || url.pathname === '/dashboard') {
      const genTp = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
      res.setHeader('traceparent', genTp);
      res.setHeader('x-trace-id', 'a'.repeat(32));
    }

    if (url.pathname === '/v1/health') {
      if (indexerHealthStatus !== 'ok') {
        res.writeHead(500);
        res.end(JSON.stringify({ status: indexerHealthStatus }));
        return;
      }
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: 'ok',
          db: 'ok',
          lastSync: new Date().toISOString(),
          uptime: 12345,
        }),
      );
      return;
    }

    if (url.pathname === `/v1/invoice/${CANARY_INVOICE_ID}`) {
      if (indexerInvoiceNotFound) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      res.writeHead(200);
      res.end(
        JSON.stringify({
          invoice: {
            id: CANARY_INVOICE_ID,
            freelancer: 'GFREELANCER',
            payer: CANARY_PAYER_ADDRESS,
            amount: '10000000',
            due_date: Math.floor(Date.now() / 1000) + 86400,
            discount_rate: 300,
            status: 'Pending',
          },
        }),
      );
      return;
    }

    if (url.pathname === '/v1/stats') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          totalInvoices: 42,
          totalVolume: '420000000',
          totalYield: '1000000',
          defaultRate: 0.05,
          totalFunded: 30,
          totalPaid: 25,
        }),
      );
      return;
    }

    if (url.pathname === '/v1/invoices') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10) || 10, 100);
      const cursor = url.searchParams.get('cursor');
      const statusFilter = url.searchParams.get('status');
      // Simple pagination: ids 1..10
      let all = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        freelancer: 'GFREELANCER',
        payer: CANARY_PAYER_ADDRESS,
        amount: '10000000',
        due_date: Math.floor(Date.now() / 1000) + 86400,
        discount_rate: 300,
        status: i % 2 === 0 ? 'Pending' : 'Funded',
      }));
      if (statusFilter) all = all.filter((x) => x.status === statusFilter);
      let start = 0;
      if (cursor) {
        try {
          const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
          const cid = Number(decoded);
          const idx = all.findIndex((x) => x.id === cid);
          if (idx >= 0) start = idx + 1;
        } catch {}
      }
      const slice = all.slice(start, start + limit);
      const hasMore = start + limit < all.length;
      const nextCursor = hasMore ? Buffer.from(String(slice[slice.length - 1].id)).toString('base64') : undefined;
      res.writeHead(200);
      res.end(JSON.stringify({ invoices: slice, hasMore, nextCursor }));
      return;
    }

    if (url.pathname.startsWith('/v1/history/')) {
      res.writeHead(200);
      res.end(JSON.stringify([
        {
          id: CANARY_INVOICE_ID,
          freelancer: 'GFREELANCER',
          payer: CANARY_PAYER_ADDRESS,
          amount: '10000000',
          due_date: Math.floor(Date.now() / 1000) + 86400,
          discount_rate: 300,
          status: 'Pending',
        },
      ]));
      return;
    }

    if (url.pathname === '/v1/dashboard' || url.pathname === '/dashboard') {
      res.writeHead(200);
      res.end(JSON.stringify({
        sync: { syncLag: 5, lastSyncTime: new Date().toISOString(), isSyncing: false },
        performance: { requestCount: 100, averageResponseTime: 20 },
        errors: { totalErrors: 0, errorRate: 0 },
        uptime: { uptimeSeconds: 1000 },
      }));
      return;
    }

    if (url.pathname === '/graphql') {
      // Simple handler: parse body if POST, return canary invoice for invoice(id:1)
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (parsed.query && parsed.query.includes('invoice')) {
            res.writeHead(200);
            res.end(JSON.stringify({
              data: {
                invoice: {
                  id: CANARY_INVOICE_ID,
                  freelancer: 'GFREELANCER',
                  payer: CANARY_PAYER_ADDRESS,
                  amount: '10000000',
                  status: 'Pending',
                },
              },
            }));
          } else {
            res.writeHead(200);
            res.end(JSON.stringify({ data: { health: { status: 'ok' } } }));
          }
        } catch {
          res.writeHead(200);
          res.end(JSON.stringify({ data: { invoice: null } }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });
}

function createNotificationsServer(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    // For POST bodies we need to read
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString();
      let jsonBody: any = {};
      try { jsonBody = rawBody ? JSON.parse(rawBody) : {}; } catch {}
      res.setHeader('Content-Type', 'application/json');
      // Tracing reflection
      const incTp = req.headers['traceparent'] as string | undefined;
      if (incTp && /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[0-9a-f]$/i.test(incTp)) {
        res.setHeader('traceparent', incTp);
        res.setHeader('x-trace-id', incTp.split('-')[1]);
      } else if (url.pathname === '/health') {
        const genTp = `00-${'e'.repeat(32)}-${'f'.repeat(16)}-01`;
        res.setHeader('traceparent', genTp);
        res.setHeader('x-trace-id', 'e'.repeat(32));
      }
      // Add rate-limit headers on relevant responses
      res.setHeader('X-RateLimit-Limit', '60');
      res.setHeader('X-RateLimit-Remaining', '59');
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(Date.now()/1000)+60));

      if (url.pathname === '/health') {
        if (notificationsHealthStatus !== 'ok') {
          res.writeHead(500);
          res.end(JSON.stringify({ status: 'degraded' }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (url.pathname === '/subscribe' && req.method === 'POST') {
        // Basic validation
        if (jsonBody.channel === 'email' && typeof jsonBody.destination === 'string') {
          const newSub = { id: nextSubId++, stellar_address: jsonBody.stellar_address, destination: jsonBody.destination, channel: 'email' };
          notifSubs.push(newSub);
          res.writeHead(201);
          res.end(JSON.stringify({ subscription: newSub }));
          return;
        }
        if (jsonBody.channel === 'webhook' && typeof jsonBody.destination === 'string') {
          const newSub = { id: nextSubId++, stellar_address: jsonBody.stellar_address, destination: jsonBody.destination, channel: 'webhook' };
          notifSubs.push(newSub);
          res.writeHead(201);
          res.end(JSON.stringify({ subscription: newSub }));
          return;
        }
        if (jsonBody.channel === 'sms' && typeof jsonBody.destination === 'string') {
          const newSub = { id: nextSubId++, stellar_address: jsonBody.stellar_address, destination: jsonBody.destination, channel: 'sms' };
          notifSubs.push(newSub);
          res.writeHead(201);
          res.end(JSON.stringify({ subscription: newSub }));
          return;
        }
        // fallback for test: always 201
        const newSub = { id: 999, stellar_address: CANARY_PAYER_ADDRESS, destination: 'fallback', channel: 'email' };
        res.writeHead(201);
        res.end(JSON.stringify({ subscription: newSub }));
        return;
      }

      if (url.pathname === '/test-webhook' && req.method === 'POST') {
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, statusCode: 200 }));
        return;
      }

      if (url.pathname.startsWith('/subscriptions/')) {
        const parts = url.pathname.split('/');
        // /subscriptions/:address  or /subscriptions/:id/logs
        if (parts.length === 3) {
          const address = decodeURIComponent(parts[2]);
          const subs = notifSubs.filter(s => s.stellar_address === address);
          // also include default mock if empty
          const out = subs.length ? subs : [{ id: 999, stellar_address: address, channel: 'webhook', destination: 'https://example.com/hook', triggers: ['invoice_funded'] }];
          res.writeHead(200);
          res.end(JSON.stringify({ subscriptions: out }));
          return;
        }
        if (parts.length === 4 && parts[3] === 'logs') {
          res.writeHead(200);
          res.end(JSON.stringify({ logs: [] }));
          return;
        }
      }

      if (url.pathname === '/unsubscribe' && req.method === 'DELETE') {
        if (typeof jsonBody.id === 'number') {
          notifSubs = notifSubs.filter(s => s.id !== jsonBody.id);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (url.pathname === '/analytics') {
        res.writeHead(200);
        res.end(JSON.stringify({ sent: 100, failed: 2, successRate: 0.98 }));
        return;
      }

      if (url.pathname === '/analytics/channel-comparison') {
        res.writeHead(200);
        res.end(JSON.stringify({ channels: { email: { sent: 50 }, webhook: { sent: 50 } } }));
        return;
      }

      if (url.pathname === '/analytics/trends') {
        res.writeHead(200);
        res.end(JSON.stringify({ trends: [{ date: '2026-09-22', sent: 10 }] }));
        return;
      }

      if (url.pathname.startsWith('/preferences/')) {
        res.writeHead(200);
        res.end(JSON.stringify({ address: CANARY_PAYER_ADDRESS, frequency: 'immediate', channels: ['email'] }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });
}

function createOracleServer(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const incTp = req.headers['traceparent'] as string | undefined;
      if (incTp && /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[0-9a-f]$/i.test(incTp)) {
        res.setHeader('traceparent', incTp);
        res.setHeader('x-trace-id', incTp.split('-')[1]);
      } else if (url.pathname === '/v1/health' || url.pathname === '/health') {
        const genTp = `00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`;
        res.setHeader('traceparent', genTp);
        res.setHeader('x-trace-id', 'c'.repeat(32));
      }

      if (url.pathname === '/v1/health' || url.pathname === '/health') {
        if (oracleHealthStatus !== 'ok') {
          res.writeHead(500);
          res.end(JSON.stringify({ status: oracleHealthStatus }));
          return;
        }
        res.writeHead(200);
        res.end(
          JSON.stringify({
            status: 'ok',
            uptimeMs: 55000,
            cache: 'memory',
            reputationConfigured: false,
          }),
        );
        return;
      }

      if (url.pathname === '/v1/metrics' || url.pathname === '/metrics') {
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        res.writeHead(200);
        res.end(`# HELP oracle_verification_requests_total Total\n# TYPE oracle_verification_requests_total counter\noracle_verification_requests_total 42\noracle_cache_hits_total 10\n`);
        return;
      }

      if (url.pathname === '/v1/verify') {
        let parsed: any = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch {}
        // Invalid payer handling
        if (parsed.payer === 'INVALID') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'payer must be a valid Stellar address' }));
          return;
        }
        if (oracleVerifyStatus !== 200) {
          res.writeHead(oracleVerifyStatus);
          res.end(
            JSON.stringify({
              error: 'Oracle verification failed',
              message: 'upstream timeout',
            }),
          );
          return;
        }

        if (oracleCorruptPayload) {
          res.writeHead(200);
          res.end(JSON.stringify({ payer: CANARY_PAYER_ADDRESS }));
          return;
        }

        oracleVerifyCallCount++;
        const cacheHit = oracleVerifyCallCount > 1;
        res.writeHead(200);
        res.end(
          JSON.stringify({
            payer: CANARY_PAYER_ADDRESS,
            isVerified: true,
            trustScore: 85,
            confidenceLevel: 'high',
            cacheHit,
            dataAgeMs: 1000,
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });
}

function listenServer(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, () => resolve()));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── Test Lifecycle ────────────────────────────────────────────────────────────

beforeAll(async () => {
  indexerServer = createIndexerServer();
  notificationsServer = createNotificationsServer();
  oracleServer = createOracleServer();

  await Promise.all([
    listenServer(indexerServer, INDEXER_PORT),
    listenServer(notificationsServer, NOTIFICATIONS_PORT),
    listenServer(oracleServer, ORACLE_PORT),
  ]);

  const mod = await import('../../scripts/synthetic-canary');
  checkIndexer = mod.checkIndexer;
  checkNotifications = mod.checkNotifications;
  checkOracle = mod.checkOracle;
  checkCrossService = (mod as any).checkCrossService ?? (async () => []);
  runAllCanaryChecks = mod.runAllCanaryChecks;
  // reset counters
  oracleVerifyCallCount = 0;
  notifSubs = [];
  nextSubId = 1000;
});

afterAll(async () => {
  await Promise.all([
    closeServer(indexerServer),
    closeServer(notificationsServer),
    closeServer(oracleServer),
  ]);
});

// ── Indexer Checks ────────────────────────────────────────────────────────────

describe('Indexer synthetic canary checks', () => {
  it('indexer:health — reports status=ok with uptime', async () => {
    indexerHealthStatus = 'ok';
    const results = await checkIndexer();
    const healthCheck = results.find((r) => r.name === 'indexer:health');
    expect(healthCheck).toBeDefined();
    expect(healthCheck?.passed).toBe(true);
    expect(healthCheck?.detail).toMatch(/status=ok/);
    expect(healthCheck?.runbookUrl).toBeDefined();
  });

  it(`indexer:invoice:${CANARY_INVOICE_ID} — returns correct canary invoice`, async () => {
    indexerInvoiceNotFound = false;
    const results = await checkIndexer();
    const invoiceCheck = results.find((r) =>
      r.name.startsWith('indexer:invoice:'),
    );
    expect(invoiceCheck).toBeDefined();
    expect(invoiceCheck?.passed).toBe(true);
    expect(invoiceCheck?.detail).toMatch(`id=${CANARY_INVOICE_ID}`);
  });

  it('indexer:stats — stats endpoint is reachable', async () => {
    const results = await checkIndexer();
    const statsCheck = results.find((r) => r.name === 'indexer:stats');
    expect(statsCheck).toBeDefined();
    expect(statsCheck?.passed).toBe(true);
  });

  it('indexer:list:pagination — paginates without overlap', async () => {
    const results = await checkIndexer();
    const pag = results.find((r) => r.name === 'indexer:list:pagination');
    expect(pag).toBeDefined();
    expect(pag?.passed).toBe(true);
  });

  it('indexer:graphql:consistency — REST and GraphQL agree', async () => {
    const results = await checkIndexer();
    const g = results.find((r) => r.name === 'indexer:graphql:consistency');
    expect(g).toBeDefined();
    expect(g?.passed).toBe(true);
  });

  it('fails gracefully when indexer returns a 404 for the canary invoice', async () => {
    indexerInvoiceNotFound = true;
    const results = await checkIndexer();
    const invoiceCheck = results.find((r) =>
      r.name.startsWith('indexer:invoice:'),
    );
    expect(invoiceCheck?.passed).toBe(false);
    expect(invoiceCheck?.error).toMatch(/not found/i);
    expect(invoiceCheck?.runbookUrl).toMatch(/incident-response/);
    indexerInvoiceNotFound = false;
  });
});

// ── Notifications Checks ──────────────────────────────────────────────────────

describe('Notifications synthetic canary checks', () => {
  it('notifications:health — reports status=ok', async () => {
    notificationsHealthStatus = 'ok';
    const results = await checkNotifications();
    const healthCheck = results.find((r) => r.name === 'notifications:health');
    expect(healthCheck).toBeDefined();
    expect(healthCheck?.passed).toBe(true);
  });

  it('notifications:channel:email — email channel is responsive', async () => {
    const results = await checkNotifications();
    const emailCheck = results.find(
      (r) => r.name === 'notifications:channel:email',
    );
    expect(emailCheck).toBeDefined();
    expect(emailCheck?.passed).toBe(true);
  });

  it('notifications:channel:webhook — webhook channel is reachable', async () => {
    const results = await checkNotifications();
    const webhookCheck = results.find(
      (r) => r.name === 'notifications:channel:webhook',
    );
    expect(webhookCheck).toBeDefined();
    expect(webhookCheck?.passed).toBe(true);
  });

  it('notifications:channel:sms — SMS channel is responsive', async () => {
    const results = await checkNotifications();
    const smsCheck = results.find(
      (r) => r.name === 'notifications:channel:sms',
    );
    expect(smsCheck).toBeDefined();
    expect(smsCheck?.passed).toBe(true);
  });

  it('notifications:channel:websocket — WebSocket heartbeat received', async () => {
    const results = await checkNotifications();
    const wsCheck = results.find(
      (r) => r.name === 'notifications:channel:websocket',
    );
    expect(wsCheck).toBeDefined();
    expect(wsCheck?.passed).toBe(true);
    expect(wsCheck?.detail).toMatch(/heartbeat received/i);
  });

  it('notifications:subscription:roundtrip — lifecycle succeeds', async () => {
    const results = await checkNotifications();
    const rt = results.find((r) => r.name === 'notifications:subscription:roundtrip');
    expect(rt).toBeDefined();
    expect(rt?.passed).toBe(true);
  });

  it('notifications:websocket:subscribe — subscribe flow works', async () => {
    const results = await checkNotifications();
    const wsSub = results.find((r) => r.name === 'notifications:websocket:subscribe');
    expect(wsSub).toBeDefined();
    expect(wsSub?.passed).toBe(true);
  });

  it('reports failure when notifications service is degraded', async () => {
    notificationsHealthStatus = 'error';
    const results = await checkNotifications();
    const healthCheck = results.find((r) => r.name === 'notifications:health');
    expect(healthCheck?.passed).toBe(false);
    notificationsHealthStatus = 'ok';
  });
});

// ── Oracle Checks ─────────────────────────────────────────────────────────────

describe('Oracle synthetic canary checks', () => {
  it('oracle:health — reports status=ok', async () => {
    oracleHealthStatus = 'ok';
    const results = await checkOracle();
    const healthCheck = results.find((r) => r.name === 'oracle:health');
    expect(healthCheck).toBeDefined();
    expect(healthCheck?.passed).toBe(true);
  });

  it('oracle:verify — correctly assesses the canary address', async () => {
    oracleVerifyStatus = 200;
    oracleCorruptPayload = false;
    oracleVerifyCallCount = 0;
    const results = await checkOracle();
    const verifyCheck = results.find((r) => r.name.startsWith('oracle:verify:'));
    expect(verifyCheck).toBeDefined();
    expect(verifyCheck?.passed).toBe(true);
    expect(verifyCheck?.detail).toMatch(/trustScore=/);
    expect(verifyCheck?.detail).toMatch(/isVerified=/);
  });

  it('oracle:cache — second verify is cacheHit', async () => {
    oracleVerifyCallCount = 0;
    const results = await checkOracle();
    const cache = results.find((r) => r.name === 'oracle:cache');
    expect(cache).toBeDefined();
    expect(cache?.passed).toBe(true);
  });

  it('oracle:validation — rejects invalid payer with 400', async () => {
    const results = await checkOracle();
    const v = results.find((r) => r.name === 'oracle:validation');
    expect(v).toBeDefined();
    expect(v?.passed).toBe(true);
  });

  it('oracle:verify — fails when oracle returns a 500', async () => {
    oracleVerifyStatus = 500;
    const results = await checkOracle();
    const verifyCheck = results.find((r) => r.name.startsWith('oracle:verify:'));
    expect(verifyCheck?.passed).toBe(false);
    expect(verifyCheck?.error).toMatch(/HTTP 500/);
    oracleVerifyStatus = 200;
  });

  it('oracle:verify — fails when payer field is missing from response', async () => {
    oracleCorruptPayload = true;
    const results = await checkOracle();
    const verifyCheck = results.find((r) => r.name.startsWith('oracle:verify:'));
    expect(verifyCheck?.passed).toBe(false);
    oracleCorruptPayload = false;
  });
});

// ── Cross-service consistency ────────────────────────────────────────────────

describe('Cross-service canary checks', () => {
  it('cross:consistency:indexer-oracle — read-then-verify passes', async () => {
    oracleVerifyCallCount = 0;
    const results = await checkCrossService();
    const c = results.find((r) => r.name === 'cross:consistency:indexer-oracle');
    expect(c).toBeDefined();
    expect(c?.passed).toBe(true);
  });
});

// ── Full Suite Integration ────────────────────────────────────────────────────

describe('runAllCanaryChecks — full suite', () => {
  it('passes when all services return healthy responses', async () => {
    indexerHealthStatus = 'ok';
    indexerInvoiceNotFound = false;
    notificationsHealthStatus = 'ok';
    oracleHealthStatus = 'ok';
    oracleVerifyStatus = 200;
    oracleCorruptPayload = false;
    oracleVerifyCallCount = 0;
    notifSubs = [];

    const report = await runAllCanaryChecks();
    expect(report.passed).toBe(true);
    expect(report.runAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.checks.length).toBeGreaterThanOrEqual(8);
    // every check must carry runbookUrl + severity for paging
    for (const c of report.checks) {
      expect(c.runbookUrl).toMatch(/incident-response|monitoring|notifications|oracle-service/);
      expect(c.severity).toMatch(/P1|P2|P3/);
    }
  });

  it('marks overall report as failed when any single check fails', async () => {
    indexerInvoiceNotFound = true;
    const report = await runAllCanaryChecks();
    expect(report.passed).toBe(false);
    const failed = report.checks.filter((c) => !c.passed);
    expect(failed.length).toBeGreaterThan(0);
    // failed checks must have runbook
    for (const f of failed) {
      expect(f.runbookUrl).toBeDefined();
    }
    indexerInvoiceNotFound = false;
  });
});
