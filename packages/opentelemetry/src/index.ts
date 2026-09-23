import { trace, metrics, SpanStatusCode, Tracer, Meter, Span } from '@opentelemetry/api';

/**
 * Default span attribute allowlist.
 * Only safe, low-cardinality, non-sensitive operational metadata is captured.
 */
export const DEFAULT_ALLOWED_SPAN_ATTRIBUTES = new Set<string>([
  'invoice_id',
  'token',
  'network',
  'status',
  'method',
  'iln.method',
  'iln.invoice_id',
  'iln.token',
  'iln.network',
  'iln.status',
  'iln.error.code',
]);

/**
 * Regex pattern matching Stellar secret seed keys (typically 56 chars starting with S).
 */
export const STELLAR_SECRET_KEY_REGEX = /S[A-Z0-9]{50,56}/g;

/**
 * Regex pattern matching Bearer authentication tokens.
 */
export const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9_\-\.]+/gi;

/**
 * Regex pattern matching long unbroken Base64 strings (such as raw XDR envelopes).
 * Requires contiguous base64 characters of 64+ length.
 */
export const RAW_XDR_REGEX = /(?:[A-Za-z0-9+/]{4}){16,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g;

/**
 * Configuration options for ILN OpenTelemetry instrumentation.
 */
export interface ILNInstrumentationOptions {
  meterProvider?: any;
  tracerProvider?: any;
  /**
   * Whether to sanitize and redact sensitive patterns (secret keys, tokens, XDR) from error messages and attributes.
   * Default: true
   */
  redactSensitiveData?: boolean;
  /**
   * Maximum length for error messages attached to spans to prevent collector bloat.
   * Default: 256
   */
  maxErrorMessageLength?: number;
  /**
   * Explicit allowlist of allowed span attribute names.
   * Default: DEFAULT_ALLOWED_SPAN_ATTRIBUTES
   */
  allowedAttributes?: string[];
  /**
   * Custom attribute sanitizer hook for integrators requiring specialized scrubbing.
   */
  customRedactor?: (key: string, value: unknown) => unknown;
}

/**
 * Sanitizes an error message by scrubbing secret keys, auth tokens, and long raw XDR payloads.
 */
export function sanitizeErrorMessage(
  message: string | undefined | null,
  maxLength = 256,
  redact = true
): string {
  if (!message) return 'Unknown error';
  if (!redact) {
    return message.length > maxLength ? `${message.slice(0, maxLength)}... [TRUNCATED]` : message;
  }

  let sanitized = message
    .replace(STELLAR_SECRET_KEY_REGEX, '[REDACTED_SECRET_KEY]')
    .replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED_AUTH_TOKEN]')
    .replace(RAW_XDR_REGEX, '[REDACTED_XDR_PAYLOAD]');

  if (sanitized.length > maxLength) {
    sanitized = `${sanitized.slice(0, maxLength)}... [TRUNCATED]`;
  }

  return sanitized;
}

/**
 * Sanitizes an attribute value to ensure OpenTelemetry type safety (string, number, boolean).
 */
export function sanitizeAttributeValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') {
    return value.replace(STELLAR_SECRET_KEY_REGEX, '[REDACTED_SECRET_KEY]');
  }
  return String(value);
}

export class ILNInstrumentation {
  private tracer: Tracer;
  private meter: Meter;
  private transactionDuration: any;
  private simulationDuration: any;
  private errorCount: any;
  private options: Required<Omit<ILNInstrumentationOptions, 'meterProvider' | 'tracerProvider' | 'customRedactor'>> & {
    customRedactor?: (key: string, value: unknown) => unknown;
  };
  private allowedAttributesSet: Set<string>;

  constructor(options: ILNInstrumentationOptions = {}) {
    this.options = {
      redactSensitiveData: options.redactSensitiveData ?? true,
      maxErrorMessageLength: options.maxErrorMessageLength ?? 256,
      allowedAttributes: options.allowedAttributes ?? Array.from(DEFAULT_ALLOWED_SPAN_ATTRIBUTES),
      customRedactor: options.customRedactor,
    };

    this.allowedAttributesSet = new Set(this.options.allowedAttributes);

    this.tracer = trace.getTracer('@invoice-liquidity/sdk');
    this.meter = metrics.getMeter('@invoice-liquidity/sdk');

    this.transactionDuration = this.meter.createHistogram('iln.transaction.duration', {
      description: 'Duration of ILN transactions',
      unit: 'ms',
    });

    this.simulationDuration = this.meter.createHistogram('iln.simulation.duration', {
      description: 'Duration of ILN transaction simulations',
      unit: 'ms',
    });

    this.errorCount = this.meter.createCounter('iln.error.count', {
      description: 'Count of ILN errors',
    });
  }

  /**
   * Safely applies an attribute to a span if permitted by the allowlist.
   */
  private setSafeAttribute(span: Span, key: string, rawValue: unknown): void {
    if (!this.allowedAttributesSet.has(key)) {
      return;
    }

    let value = rawValue;
    if (this.options.customRedactor) {
      value = this.options.customRedactor(key, value);
    }

    const sanitized = sanitizeAttributeValue(value);
    if (sanitized !== null) {
      span.setAttribute(key, sanitized);
    }
  }

  /**
   * Wraps an SDK client instance with OpenTelemetry instrumentation.
   * Intercepts method calls on the client while strictly filtering and redacting sensitive data.
   */
  public instrumentClient<T extends Record<string, any>>(client: T): T {
    const instrumented = { ...client };
    const prototype = Object.getPrototypeOf(client);

    const methods = Object.getOwnPropertyNames(prototype).filter(
      (p) => typeof client[p] === 'function' && p !== 'constructor'
    );

    for (const method of methods) {
      const original = client[method];

      (instrumented as any)[method] = async (...args: any[]) => {
        const span = this.tracer.startSpan(`ILNClient.${method}`);
        const startTime = Date.now();

        // Safe parameter extraction — only inspect known safe fields (never arbitrary args/secrets)
        const params = args[0] && typeof args[0] === 'object' ? args[0] : {};

        if (params.invoiceId !== undefined) {
          this.setSafeAttribute(span, 'invoice_id', params.invoiceId);
          this.setSafeAttribute(span, 'iln.invoice_id', params.invoiceId);
        }
        if (params.token !== undefined) {
          this.setSafeAttribute(span, 'token', params.token);
          this.setSafeAttribute(span, 'iln.token', params.token);
        }
        if (params.network !== undefined) {
          this.setSafeAttribute(span, 'network', params.network);
          this.setSafeAttribute(span, 'iln.network', params.network);
        }

        this.setSafeAttribute(span, 'method', method);
        this.setSafeAttribute(span, 'iln.method', method);

        try {
          const result = await original.apply(client, args);
          span.setStatus({ code: SpanStatusCode.OK });
          this.setSafeAttribute(span, 'status', 'success');
          this.setSafeAttribute(span, 'iln.status', 'success');

          const duration = Date.now() - startTime;
          if (method.includes('simulate')) {
            this.simulationDuration.record(duration, { method });
          } else {
            this.transactionDuration.record(duration, { method });
          }

          return result;
        } catch (error: any) {
          const sanitizedMsg = sanitizeErrorMessage(
            error?.message,
            this.options.maxErrorMessageLength,
            this.options.redactSensitiveData
          );

          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: sanitizedMsg,
          });

          this.setSafeAttribute(span, 'status', 'error');
          this.setSafeAttribute(span, 'iln.status', 'error');

          const rawCode = error?.code || 'UNKNOWN_ERROR';
          const safeCode = typeof rawCode === 'string' && rawCode.length < 64 ? rawCode : 'UNKNOWN_ERROR';

          this.setSafeAttribute(span, 'iln.error.code', safeCode);
          this.errorCount.add(1, { method, code: safeCode });

          throw error;
        } finally {
          span.end();
        }
      };
    }

    return instrumented as T;
  }
}

// Re-export tracing helpers for convenience; prefer `import ... from '@iln/opentelemetry/tracing'`
export * from './tracing';
