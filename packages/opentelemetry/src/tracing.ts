/**
 * packages/opentelemetry/src/tracing.ts — W3C Trace Context propagation
 *
 * Shared trace-context propagation for indexer, oracle-service, and
 * notifications. Implements W3C traceparent (https://www.w3.org/TR/trace-context/)
 * so a single trace view can be reconstructed across service boundaries during
 * incident response.
 *
 * Design:
 *   - Every inbound HTTP request is assigned a traceparent (either extracted from
 *     the incoming `traceparent` header or newly generated). The header is
 *     validated per the W3C spec.
 *   - The active traceparent is available via `AsyncLocalStorage` (or fallback
 *     via request object) so downstream `fetch` calls can propagate it.
 *   - Spans are created via `@opentelemetry/api` if an OTEL SDK is configured;
 *     otherwise the code degrades gracefully to header-only propagation (no-op spans)
 *     so tracing never breaks the request path.
 *   - Traces are exported to a queryable backend when `OTEL_EXPORTER_OTLP_ENDPOINT`
 *     is set (Jaeger / Tempo / Honeycomb / OTEL Collector). See docs/monitoring.md.
 *
 * Usage (Express):
 *   import { traceMiddleware, withSpan, propagateFetch } from '@iln/opentelemetry/tracing';
 *   app.use(traceMiddleware('indexer'));
 *   await withSpan('indexer.db.query', { 'iln.invoice_id': 42 }, async (span) => { ... });
 *   await fetch(url, propagateFetch({ headers: {} }));
 */

import { randomBytes } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { trace, context, SpanStatusCode, SpanKind, propagation } from '@opentelemetry/api';

// ── W3C traceparent helpers ─────────────────────────────────────────────────

const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[0-9a-f])$/i;

export function isValidTraceParent(header: string): boolean {
  if (!TRACEPARENT_REGEX.test(header)) return false;
  // version 00, trace-id and parent-id must not be all-zero per spec
  const [, traceId, parentId] = header.match(TRACEPARENT_REGEX) ?? [];
  if (!traceId || !parentId) return false;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return false;
  return true;
}

export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function generateParentId(): string {
  return randomBytes(8).toString('hex');
}

export function createTraceParent(traceId: string, parentId: string, sampled = '01'): string {
  return `00-${traceId}-${parentId}-${sampled}`;
}

export function generateTraceParent(sampled = '01'): string {
  return createTraceParent(generateTraceId(), generateParentId(), sampled);
}

export interface ParsedTraceParent {
  version: string;
  traceId: string;
  parentId: string;
  sampled: string;
}

export function parseTraceParent(header: string): ParsedTraceParent | null {
  const m = header.match(TRACEPARENT_REGEX);
  if (!m) return null;
  const [, traceId, parentId, flags] = m;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { version: '00', traceId, parentId, sampled: flags.slice(1) };
}

// ── AsyncLocalStorage for request-scoped trace context ──────────────────────

interface TraceContext {
  traceparent: string;
  tracestate?: string;
  traceId: string;
  parentId: string;
}

const als = new AsyncLocalStorage<TraceContext>();

export function getCurrentTraceContext(): TraceContext | null {
  return als.getStore() ?? null;
}

export function getCurrentTraceParent(): string | null {
  return getCurrentTraceContext()?.traceparent ?? null;
}

// ── Express middleware ───────────────────────────────────────────────────────

export interface TraceMiddlewareOptions {
  headerName?: string;
  sampled?: string;
}

/**
 * Express middleware that extracts or generates a W3C traceparent, stores it
 * in AsyncLocalStorage, reflects it in the response header, and creates a
 * root span for the request.
 */
export function traceMiddleware(serviceName: string, opts: TraceMiddlewareOptions = {}) {
  const headerName = (opts.headerName ?? 'traceparent').toLowerCase();
  const sampled = opts.sampled ?? '01';

  return (req: any, res: any, next: any) => {
    const incoming = (req.headers?.[headerName] as string | undefined) ?? '';
    const traceparent = isValidTraceParent(incoming) ? incoming : generateTraceParent(sampled);
    const parsed = parseTraceParent(traceparent)!;
    const ctx: TraceContext = {
      traceparent,
      traceId: parsed.traceId,
      parentId: parsed.parentId,
      tracestate: req.headers?.['tracestate'] as string | undefined,
    };

    // Reflect trace context in response so callers and canary can assert propagation
    res.setHeader('traceparent', traceparent);
    if (ctx.tracestate) res.setHeader('tracestate', ctx.tracestate);
    // Also expose X-Trace-Id for human readability in incident response (first 16 chars)
    res.setHeader('X-Trace-Id', parsed.traceId);

    const tracer = trace.getTracer(serviceName);
    const spanName = `${req.method} ${req.path ?? req.url ?? ''}`.trim();

    als.run(ctx, () => {
      const activeCtx = propagation.extract(context.active(), req.headers as any);
      const span = tracer.startSpan(spanName, { kind: SpanKind.SERVER as any }, activeCtx);
      span.setAttribute('http.method', req.method);
      span.setAttribute('http.route', req.path ?? req.url ?? '');
      span.setAttribute('trace.id', parsed.traceId);

      const start = Date.now();
      const onFinish = () => {
        const duration = Date.now() - start;
        span.setAttribute('http.status_code', res.statusCode);
        span.setAttribute('http.duration_ms', duration);
        if (res.statusCode >= 400) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.statusCode}` });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end();
        res.removeListener('finish', onFinish);
        res.removeListener('close', onFinish);
      };
      res.on('finish', onFinish);
      res.on('close', onFinish);

      // Store span in context for withSpan children
      const spanCtx = trace.setSpan(activeCtx, span);
      context.with(spanCtx, () => next());
    });
  };
}

// ── Span helper ──────────────────────────────────────────────────────────────

/**
 * Create a child span around an async function. If no tracer is configured this
 * still propagates trace context and is a no-op otherwise.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: any) => Promise<T>
): Promise<T> {
  const tracer = trace.getTracer('iln');
  const parentCtx = context.active();
  const span = tracer.startSpan(name, { kind: SpanKind.INTERNAL as any }, parentCtx);
  for (const [k, v] of Object.entries(attributes)) {
    span.setAttribute(k, v);
  }
  const ctx = trace.setSpan(parentCtx, span);
  try {
    const result = await context.with(ctx, () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err: any) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message ?? String(err) });
    throw err;
  } finally {
    span.end();
  }
}

// ── Fetch propagation helper ────────────────────────────────────────────────

/**
 * Inject the current W3C traceparent into an outgoing fetch init's headers.
 * Usage: `fetch(url, propagateFetch({ headers: {} }))`
 */
export function propagateFetch(init: RequestInit = {}): RequestInit {
  const tp = getCurrentTraceParent();
  if (!tp) return init;
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
    traceparent: tp,
  };
  const ctx = getCurrentTraceContext();
  if (ctx?.tracestate) headers['tracestate'] = ctx.tracestate;
  return { ...init, headers };
}

/**
 * Non-ALS fallback: explicitly pass a traceparent string (e.g. from canary
 * or manual threading) to inject into headers.
 */
export function injectTraceParent(headers: Record<string, string>, traceparent?: string): Record<string, string> {
  const tp = traceparent ?? getCurrentTraceParent() ?? generateTraceParent();
  return { ...headers, traceparent: tp };
}

// Re-export helpers for direct use in tests and canary
export const _internal = { TRACEPARENT_REGEX };
