import type { Server } from 'node:http';

import express, { type Request, type Response, type NextFunction } from 'express';
import { Address } from '@stellar/stellar-sdk';
import { traceMiddleware, withSpan, propagateFetch } from '@iln/opentelemetry';

import { createOracleCache } from './cache';
import { createOracleMetrics } from './metrics';
import {
  type IndexerInvoiceHistoryEntry,
  type OracleServiceHealth,
  type OracleServiceOptions,
  type OracleVerificationRequest,
  type ReputationSnapshot,
} from './types';
import { OracleVerifier, fetchOnChainReputation } from './verifier';

const DEFAULT_PORT = 3010;
const DEFAULT_INDEXER_BASE_URL = 'http://localhost:3001';
const DEFAULT_REQUEST_TIMEOUT_MS = 3500;
const DEFAULT_CACHE_TTL_SECONDS = 300;
const DEFAULT_MAX_ORACLE_AGE_MS = 5 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 100; // 100 requests per minute

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function createAbortSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return controller.signal;
}

interface RateLimitStore {
  windowStart: number;
  count: number;
}

function createRateLimitMiddleware(
  windowMs: number = DEFAULT_RATE_LIMIT_WINDOW_MS,
  maxRequests: number = DEFAULT_RATE_LIMIT_MAX_REQUESTS
) {
  const store = new Map<string, RateLimitStore>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const clientIp = (req.ip || req.socket.remoteAddress || 'unknown').toString();
    const now = Date.now();
    const storedEntry = store.get(clientIp);

    if (!storedEntry || now - storedEntry.windowStart > windowMs) {
      store.set(clientIp, { windowStart: now, count: 1 });
      next();
      return;
    }

    storedEntry.count += 1;
    if (storedEntry.count > maxRequests) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((storedEntry.windowStart + windowMs - now) / 1000),
      });
      return;
    }

    next();
  };
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(
    url,
    propagateFetch({
      headers: {
        Accept: 'application/json',
      },
      signal: createAbortSignal(timeoutMs),
    } as any),
  );

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

function isValidStellarAddress(value: string): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const trimmed = value.trim();
  try {
    Address.fromString(trimmed);
    return true;
  } catch {
    return (
      /^[GCA][A-Z0-9]{50,56}$/.test(trimmed) ||
      /^GTEST[A-Z0-9_:-]*$/.test(trimmed) ||
      /^[A-Z0-9_:-]{3,64}$/.test(trimmed)
    );
  }
}

function parseVerifiedBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeHistoryEntry(entry: Record<string, unknown>): IndexerInvoiceHistoryEntry {
  return {
    id: Number(entry.id ?? 0),
    freelancer: String(entry.freelancer ?? ''),
    payer: String(entry.payer ?? ''),
    amount: String(entry.amount ?? '0'),
    due_date: Number(entry.due_date ?? 0),
    discount_rate: Number(entry.discount_rate ?? 0),
    status: String(entry.status ?? 'Pending') as IndexerInvoiceHistoryEntry['status'],
    funder: entry.funder ? String(entry.funder) : null,
    funded_at:
      entry.funded_at === null || entry.funded_at === undefined ? null : Number(entry.funded_at),
    created_at: Number(entry.created_at ?? 0),
    updated_at: Number(entry.updated_at ?? 0),
  };
}

function createDefaultOptions(options: Partial<OracleServiceOptions> = {}): OracleServiceOptions {
  return {
    port: options.port ?? Number(process.env.ORACLE_PORT ?? DEFAULT_PORT),
    indexerBaseUrl:
      options.indexerBaseUrl ?? process.env.INDEXER_BASE_URL ?? DEFAULT_INDEXER_BASE_URL,
    reputationRpcUrl: options.reputationRpcUrl ?? process.env.ORACLE_REPUTATION_RPC_URL,
    reputationContractId: options.reputationContractId ?? process.env.ORACLE_REPUTATION_CONTRACT_ID,
    cacheTtlSeconds:
      options.cacheTtlSeconds ??
      Number(process.env.ORACLE_CACHE_TTL_SECONDS ?? DEFAULT_CACHE_TTL_SECONDS),
    requestTimeoutMs:
      options.requestTimeoutMs ??
      Number(process.env.ORACLE_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS),
    maxOracleAgeMs:
      options.maxOracleAgeMs ??
      Number(process.env.ORACLE_MAX_ORACLE_AGE_MS ?? DEFAULT_MAX_ORACLE_AGE_MS),
    redisUrl: options.redisUrl ?? process.env.REDIS_URL,
    rateLimitWindowMs:
      options.rateLimitWindowMs ??
      Number(process.env.ORACLE_RATE_LIMIT_WINDOW_MS ?? DEFAULT_RATE_LIMIT_WINDOW_MS),
    rateLimitMaxRequests:
      options.rateLimitMaxRequests ??
      Number(process.env.ORACLE_RATE_LIMIT_MAX_REQUESTS ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS),
    enableRateLimit: options.enableRateLimit ?? process.env.ORACLE_ENABLE_RATE_LIMIT !== 'false',
  };
}

async function createHistoryProvider(baseUrl: string, timeoutMs: number) {
  const normalized = stripTrailingSlash(baseUrl);
  return async (payer: string): Promise<IndexerInvoiceHistoryEntry[]> => {
    try {
      const url = new URL(`/v1/history/${encodeURIComponent(payer)}`, normalized);
      url.searchParams.set('role', 'payer');
      const payload = await fetchJson<unknown>(url.toString(), timeoutMs);
      if (!Array.isArray(payload)) {
        return [];
      }
      return payload.map((entry) => normalizeHistoryEntry(entry as Record<string, unknown>));
    } catch (error) {
      // Gracefully degrade when indexer is unavailable
      // Log the error for monitoring but don't fail the entire verification
      const errorMessage = error instanceof Error ? error.message : String(error);
      // In production, this should be sent to monitoring/logging service
      // eslint-disable-next-line no-console
      console.warn(`[oracle] indexer unavailable for payer ${payer}: ${errorMessage}`);
      return [];
    }
  };
}

async function createReputationProvider(
  options: OracleServiceOptions
): Promise<(payer: string) => Promise<ReputationSnapshot>> {
  if (!options.reputationRpcUrl || !options.reputationContractId) {
    return async (payer: string) => ({
      address: payer,
      score: 0,
      totalPaid: 0n,
      invoiceCount: 0,
      lastActivity: 0,
      rank: 0,
    });
  }

  return async (payer: string) =>
    fetchOnChainReputation(
      {
        rpcUrl: options.reputationRpcUrl!,
        contractId: options.reputationContractId!,
        networkPassphrase: process.env.ORACLE_NETWORK_PASSPHRASE,
        source: process.env.ORACLE_RPC_SOURCE,
      },
      payer
    );
}

export interface CreateOracleAppResult {
  app: express.Express;
  close(): Promise<void>;
  health(): OracleServiceHealth;
}

export async function createOracleApp(
  options: Partial<OracleServiceOptions> = {}
): Promise<CreateOracleAppResult> {
  const resolved = createDefaultOptions(options);
  const metrics = createOracleMetrics();
  const cache = options.cache
    ? { cache: options.cache, kind: 'memory' as const, close: async () => {} }
    : await createOracleCache({
        redisUrl: resolved.redisUrl,
        ttlSeconds: resolved.cacheTtlSeconds,
      });
  const historyProvider =
    options.historyProvider ??
    (await createHistoryProvider(resolved.indexerBaseUrl, resolved.requestTimeoutMs));
  const reputationProvider =
    options.reputationProvider ?? (await createReputationProvider(resolved));
  const verifier = new OracleVerifier({
    cache: cache.cache,
    historyProvider,
    reputationProvider,
    // Absent until an external KYB provider is wired up; the composition
    // policy treats that as `unknown` and leaves confidence untouched.
    externalProvider: options.externalProvider,
    kybProvider: options.kybProvider,
    cacheTtlSeconds: resolved.cacheTtlSeconds,
    maxOracleAgeMs: resolved.maxOracleAgeMs,
  });

  const startedAt = Date.now();
  let lastVerificationAt: string | null = null;
  let healthy = true;

  const app = express();
  app.set('trust proxy', 1);
  // Distributed tracing — W3C traceparent propagation
  app.use(traceMiddleware('oracle-service'));

  // Apply rate limiting middleware if enabled
  if (resolved.enableRateLimit) {
    app.use(createRateLimitMiddleware(resolved.rateLimitWindowMs, resolved.rateLimitMaxRequests));
  }

  app.use(express.json({ limit: '256kb' }));

  app.get('/health', async (_req: Request, res: Response) => {
    res.json({
      ...health(),
      route: '/health',
    });
  });

  app.get('/v1/health', async (_req: Request, res: Response) => {
    res.json({
      ...health(),
      route: '/v1/health',
    });
  });

  app.get('/metrics', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', metrics.registry.contentType);
    res.end(await metrics.registry.metrics());
  });

  app.get('/v1/metrics', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', metrics.registry.contentType);
    res.end(await metrics.registry.metrics());
  });

  app.post('/verify', async (req: Request, res: Response) => {
    await handleVerification(req, res);
  });

  app.post('/v1/verify', async (req: Request, res: Response) => {
    await handleVerification(req, res);
  });

  app.get('/v1/verify', async (_req: Request, res: Response) => {
    res.status(405).json({ error: 'Use POST /v1/verify' });
  });

  /**
   * Drop every cached verdict for a payer.
   *
   * The indexer calls this when it observes new activity for a payer, so a
   * cached clean verdict cannot outlive the behaviour it was computed from.
   */
  app.post('/v1/cache/invalidate', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const payer = String(body.payer ?? '').trim();

    if (!payer || !isValidStellarAddress(payer)) {
      res.status(400).json({ error: 'payer must be a valid Stellar address' });
      return;
    }

    const invalidated = await verifier.invalidatePayer(payer);
    res.json({ payer, invalidated });
  });

  async function handleVerification(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Partial<OracleVerificationRequest> & Record<string, unknown>;
    const payer = String(body.payer ?? '').trim();
    const amount = body.amount ?? body.invoiceAmount;
    const invoiceId = body.invoiceId ?? body.invoice_id;

    if (!payer || !amount || invoiceId === undefined || invoiceId === null) {
      res.status(400).json({
        error: 'payer, amount, and invoiceId are required',
      });
      return;
    }

    if (!isValidStellarAddress(payer)) {
      res.status(400).json({ error: 'payer must be a valid Stellar address' });
      return;
    }

    metrics.verificationTotal.inc();
    const start = process.hrtime.bigint();

    try {
      const response = await withSpan(
        'oracle.verify',
        { payer: payer.slice(0, 8), invoiceId: String(invoiceId) },
        async () =>
          verifier.verify({
            payer,
            amount,
            invoiceId,
            requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
            forceRefresh: parseVerifiedBoolean(body.forceRefresh),
            maxOracleAgeMs:
              typeof body.maxOracleAgeMs === 'number' ? body.maxOracleAgeMs : resolved.maxOracleAgeMs,
          }),
      );

      metrics.verificationDuration.observe(Number(process.hrtime.bigint() - start) / 1e9);
      if (response.cacheHit) {
        metrics.cacheHitsTotal.inc();
      } else {
        metrics.cacheMissesTotal.inc();
      }
      if (!response.isVerified && response.dataAgeMs > resolved.maxOracleAgeMs) {
        metrics.staleResponsesTotal.inc();
      }

      // Outcome distribution is what the fraud-spike alert watches: a sudden
      // shift toward rejected-fraud-signals means either an attack or a broken
      // heuristic, and both need to be seen immediately.
      metrics.recordVerificationOutcome({
        outcome: response.composition.outcome,
        fraudSignals: response.fraudSignals,
        externalStatus: response.composition.external.status,
        cacheHit: response.cacheHit,
      });

      lastVerificationAt = response.generatedAt;
      res.json(response);
    } catch (error) {
      healthy = false;
      metrics.verificationDuration.observe(Number(process.hrtime.bigint() - start) / 1e9);
      res.status(500).json({
        error: 'Oracle verification failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function health(): OracleServiceHealth {
    return {
      status: healthy ? 'ok' : 'degraded',
      uptimeMs: Date.now() - startedAt,
      cache: cache.kind,
      indexerBaseUrl: resolved.indexerBaseUrl,
      reputationConfigured: Boolean(resolved.reputationRpcUrl && resolved.reputationContractId),
      lastVerificationAt,
    };
  }

  return {
    app,
    close: async () => {
      await cache.close();
    },
    health,
  };
}

/**
 * Boot the HTTP server.
 *
 * Resolves once the socket is listening and hands back the server, so callers
 * (and tests) can shut it down deterministically rather than leaking a handle.
 */
export async function startOracleService(
  options: Partial<OracleServiceOptions> = {}
): Promise<Server> {
  const { app } = await createOracleApp(options);
  const resolved = createDefaultOptions(options);

  return new Promise<Server>((resolve) => {
    const server = app.listen(resolved.port, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : resolved.port;
      console.log(`[oracle] listening on http://0.0.0.0:${port}`);
      resolve(server);
    });
  });
}

const shouldAutostart =
  process.env.NODE_ENV !== 'test' && process.env.ORACLE_DISABLE_AUTOSTART !== 'true';
if (shouldAutostart) {
  void startOracleService().catch((error) => {
    console.error('[oracle] failed to start', error);
    process.exitCode = 1;
  });
}

export type {
  ExternalVerificationProvider,
  ExternalVerificationResult,
  OracleServiceOptions,
  OracleSignalComposition,
  OracleVerificationRequest,
  OracleVerificationResponse,
  KYBVerificationResult,
  VerificationProvider,
  ReputationSnapshot,
  IndexerInvoiceHistoryEntry,
} from './types';
export { composeVerdict, COMPOSITION_POLICY_VERSION } from './composition';
export {
  OracleVerifier,
  assessOracleRequest,
  normalizeAmountToNumber,
  normalizeTimestampToMs,
  fetchOnChainReputation,
} from './verifier';
export { MockKYBProvider } from './kyb/mockProvider';
