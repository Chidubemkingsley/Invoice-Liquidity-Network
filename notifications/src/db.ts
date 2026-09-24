import Database from 'better-sqlite3';
import { CONFIG } from './config';
import type {
  ILNEventType,
  Invoice,
  NotificationTrigger,
  Subscription,
  SubscriptionChannel,
  WebhookDeliveryLog,
} from './types';

type SQLiteDatabase = InstanceType<typeof Database>;

let _db: SQLiteDatabase | null = null;

export function getDb(): SQLiteDatabase {
  if (!_db) {
    _db = createDb(CONFIG.dbPath);
  }
  return _db;
}

export function createDb(path: string): SQLiteDatabase {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function setDb(db: SQLiteDatabase): void {
  _db = db;
}

function runMigrations(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id            INTEGER PRIMARY KEY,
      freelancer    TEXT    NOT NULL,
      payer         TEXT    NOT NULL,
      amount        TEXT    NOT NULL,
      due_date      INTEGER NOT NULL,
      discount_rate INTEGER NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'Pending',
      funder        TEXT,
      funded_at     INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id         TEXT    PRIMARY KEY,
      event_type       TEXT    NOT NULL,
      invoice_id       INTEGER NOT NULL,
      ledger           INTEGER NOT NULL,
      ledger_closed_at TEXT    NOT NULL,
      created_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cursor (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      last_ledger  INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id              INTEGER PRIMARY KEY,
      stellar_address TEXT    NOT NULL,
      channel         TEXT    NOT NULL CHECK (channel IN ('email', 'webhook', 'sms')),
      destination     TEXT    NOT NULL,
      triggers        TEXT    NOT NULL,
      webhook_secret  TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sent_notifications (
      id                INTEGER PRIMARY KEY,
      invoice_id        INTEGER NOT NULL,
      trigger           TEXT    NOT NULL,
      recipient_address TEXT    NOT NULL,
      channel           TEXT    NOT NULL,
      destination       TEXT    NOT NULL,
      event_id          TEXT,
      sent_at           INTEGER NOT NULL,
      UNIQUE (invoice_id, trigger, recipient_address, channel, destination)
    );

    CREATE TABLE IF NOT EXISTS webhook_delivery_logs (
      id               INTEGER PRIMARY KEY,
      subscription_id  INTEGER NOT NULL,
      event_id         TEXT,
      trigger          TEXT    NOT NULL,
      invoice_id       INTEGER NOT NULL,
      recipient_address TEXT   NOT NULL,
      status           TEXT    NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
      attempts         INTEGER NOT NULL,
      response_status  INTEGER,
      error            TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      FOREIGN KEY(subscription_id) REFERENCES subscriptions(id)
    );

    -- Durable, queryable delivery-confirmation audit log. Independent of
    -- transient dispatch-retry state (webhook_delivery_logs) and dedup table
    -- (sent_notifications). One row per confirmed delivery outcome, whether
    -- delivered or permanently failed, with attempt timestamps and final status.
    CREATE TABLE IF NOT EXISTS delivery_audit_log (
      id                 INTEGER PRIMARY KEY,
      invoice_id         INTEGER NOT NULL,
      trigger            TEXT    NOT NULL,
      recipient_address  TEXT    NOT NULL,
      channel            TEXT    NOT NULL CHECK (channel IN ('email', 'webhook', 'sms', 'websocket')),
      destination        TEXT    NOT NULL,
      event_id           TEXT,
      status             TEXT    NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
      attempts           INTEGER NOT NULL,
      last_error         TEXT,
      attempt_timestamps TEXT    NOT NULL,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_status     ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_freelancer ON invoices(freelancer);
    CREATE INDEX IF NOT EXISTS idx_invoices_payer      ON invoices(payer);
    CREATE INDEX IF NOT EXISTS idx_invoices_funder     ON invoices(funder);
    CREATE INDEX IF NOT EXISTS idx_events_invoice_id   ON events(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_address ON subscriptions(stellar_address);
    CREATE INDEX IF NOT EXISTS idx_sent_notifications_invoice ON sent_notifications(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_audit_recipient     ON delivery_audit_log(recipient_address);
    CREATE INDEX IF NOT EXISTS idx_audit_event         ON delivery_audit_log(event_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created       ON delivery_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_trigger       ON delivery_audit_log(trigger);
    CREATE INDEX IF NOT EXISTS idx_audit_channel       ON delivery_audit_log(channel);
    CREATE INDEX IF NOT EXISTS idx_audit_status        ON delivery_audit_log(status);

    -- Issue #741 compliance: ensure one-click unsubscribe tokens are
    -- single-use. The nonce is recorded here on successful verify; a
    -- replay attempts an INSERT OR IGNORE that returns changes = 0
    -- and is rejected with HTTP 409.
    CREATE TABLE IF NOT EXISTS redeemed_unsubscribe_tokens (
      nonce       TEXT    PRIMARY KEY,
      redeemed_at INTEGER NOT NULL
    );
  `);
}

export function upsertInvoice(invoice: Omit<Invoice, 'created_at' | 'updated_at'>): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO invoices
         (id, freelancer, payer, amount, due_date, discount_rate,
          status, funder, funded_at, created_at, updated_at)
       VALUES
         (@id, @freelancer, @payer, @amount, @due_date, @discount_rate,
          @status, @funder, @funded_at, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         status    = excluded.status,
         funder    = excluded.funder,
         funded_at = excluded.funded_at,
         updated_at = excluded.updated_at`
    )
    .run({
      ...invoice,
      funder: invoice.funder ?? null,
      funded_at: invoice.funded_at ?? null,
      created_at: now,
      updated_at: now,
    });
}

export function queryInvoicesByStatus(status: string): Invoice[] {
  return getDb()
    .prepare('SELECT * FROM invoices WHERE status = ? ORDER BY id ASC')
    .all(status) as Invoice[];
}

export function hasEvent(eventId: string): boolean {
  return getDb().prepare('SELECT 1 FROM events WHERE event_id = ?').get(eventId) !== undefined;
}

export function insertEvent(event: {
  event_id: string;
  event_type: ILNEventType;
  invoice_id: number;
  ledger: number;
  ledger_closed_at: string;
  created_at: number;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO events
         (event_id, event_type, invoice_id, ledger, ledger_closed_at, created_at)
       VALUES
         (@event_id, @event_type, @invoice_id, @ledger, @ledger_closed_at, @created_at)`
    )
    .run(event);
}

export function getCursorLedger(): number {
  const row = getDb().prepare('SELECT last_ledger FROM cursor WHERE id = 1').get() as
    | { last_ledger: number }
    | undefined;
  return row?.last_ledger ?? 0;
}

export function setCursorLedger(ledger: number): void {
  getDb()
    .prepare(
      `INSERT INTO cursor (id, last_ledger, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_ledger = excluded.last_ledger,
         updated_at  = excluded.updated_at`
    )
    .run(ledger, Date.now());
}

export function createSubscription(
  subscription: Omit<Subscription, 'id' | 'created_at'>
): Subscription {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO subscriptions
         (stellar_address, channel, destination, triggers, webhook_secret, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      subscription.stellar_address,
      subscription.channel,
      subscription.destination,
      JSON.stringify(subscription.triggers),
      subscription.webhook_secret ?? null,
      now
    );

  return {
    id: Number(result.lastInsertRowid),
    ...subscription,
    created_at: now,
  };
}

export function getSubscriptionsByAddress(address: string): Subscription[] {
  return getDb()
    .prepare('SELECT * FROM subscriptions WHERE stellar_address = ? ORDER BY id ASC')
    .all(address)
    .map((row: any) => ({
      id: row.id,
      stellar_address: row.stellar_address,
      channel: row.channel,
      destination: row.destination,
      triggers: JSON.parse(row.triggers),
      webhook_secret: row.webhook_secret ?? undefined,
      created_at: row.created_at,
    })) as Subscription[];
}

export function getSubscriptionById(id: number): Subscription | undefined {
  const row = getDb().prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as any;

  if (!row) {
    return undefined;
  }

  return {
    id: row.id,
    stellar_address: row.stellar_address,
    channel: row.channel,
    destination: row.destination,
    triggers: JSON.parse(row.triggers),
    webhook_secret: row.webhook_secret ?? undefined,
    created_at: row.created_at,
  } as Subscription;
}

export function deleteSubscriptionById(id: number): boolean {
  const result = getDb().prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteSubscriptionByAddressAndDestination(
  address: string,
  destination: string
): boolean {
  const result = getDb()
    .prepare('DELETE FROM subscriptions WHERE stellar_address = ? AND destination = ?')
    .run(address, destination);
  return result.changes > 0;
}

export function createWebhookDeliveryLog(log: {
  subscription_id: number;
  event_id: string | null;
  trigger: NotificationTrigger;
  invoice_id: number;
  recipient_address: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  response_status: number | null;
  error: string | null;
}): WebhookDeliveryLog {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO webhook_delivery_logs
         (subscription_id, event_id, trigger, invoice_id, recipient_address,
          status, attempts, response_status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      log.subscription_id,
      log.event_id,
      log.trigger,
      log.invoice_id,
      log.recipient_address,
      log.status,
      log.attempts,
      log.response_status,
      log.error,
      now,
      now
    );

  return {
    id: Number(result.lastInsertRowid),
    ...log,
    created_at: now,
    updated_at: now,
  };
}

export function updateWebhookDeliveryLog(
  id: number,
  updates: Partial<Pick<WebhookDeliveryLog, 'status' | 'attempts' | 'response_status' | 'error'>>
): void {
  const fields: string[] = [];
  const params: any[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    params.push(updates.status);
  }
  if (updates.attempts !== undefined) {
    fields.push('attempts = ?');
    params.push(updates.attempts);
  }
  if (updates.response_status !== undefined) {
    fields.push('response_status = ?');
    params.push(updates.response_status);
  }
  if (updates.error !== undefined) {
    fields.push('error = ?');
    params.push(updates.error);
  }

  if (fields.length === 0) {
    return;
  }

  fields.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  getDb()
    .prepare(`UPDATE webhook_delivery_logs SET ${fields.join(', ')} WHERE id = ?`)
    .run(...params);
}

export function getWebhookDeliveryLogs(subscriptionId: number): WebhookDeliveryLog[] {
  return getDb()
    .prepare(
      'SELECT * FROM webhook_delivery_logs WHERE subscription_id = ? ORDER BY created_at DESC'
    )
    .all(subscriptionId)
    .map((row: any) => ({
      id: row.id,
      subscription_id: row.subscription_id,
      event_id: row.event_id,
      trigger: row.trigger,
      invoice_id: row.invoice_id,
      recipient_address: row.recipient_address,
      status: row.status,
      attempts: row.attempts,
      response_status: row.response_status,
      error: row.error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })) as WebhookDeliveryLog[];
}

export function hasSentNotification(
  invoiceId: number,
  trigger: NotificationTrigger,
  recipientAddress: string,
  channel: SubscriptionChannel,
  destination: string
): boolean {
  return (
    getDb()
      .prepare(
        `SELECT 1 FROM sent_notifications
         WHERE invoice_id = ?
           AND trigger = ?
           AND recipient_address = ?
           AND channel = ?
           AND destination = ?`
      )
      .get(invoiceId, trigger, recipientAddress, channel, destination) !== undefined
  );
}

export function logSentNotification(
  invoiceId: number,
  trigger: NotificationTrigger,
  recipientAddress: string,
  channel: SubscriptionChannel,
  destination: string,
  eventId?: string
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO sent_notifications
         (invoice_id, trigger, recipient_address, channel, destination, event_id, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(invoiceId, trigger, recipientAddress, channel, destination, eventId ?? null, Date.now());
}

export interface DeliveryAnalytics {
  total: number;
  byChannel: Record<string, number>;
  byTrigger: Record<string, number>;
}

export function getDeliveryAnalytics(): DeliveryAnalytics {
  const { count: total } = getDb()
    .prepare('SELECT COUNT(*) as count FROM sent_notifications')
    .get() as { count: number };

  const channelRows = getDb()
    .prepare('SELECT channel, COUNT(*) as count FROM sent_notifications GROUP BY channel')
    .all() as { channel: string; count: number }[];

  const triggerRows = getDb()
    .prepare('SELECT trigger, COUNT(*) as count FROM sent_notifications GROUP BY trigger')
    .all() as { trigger: string; count: number }[];

  const byChannel: Record<string, number> = {};
  for (const row of channelRows) byChannel[row.channel] = row.count;

  const byTrigger: Record<string, number> = {};
  for (const row of triggerRows) byTrigger[row.trigger] = row.count;

  return { total, byChannel, byTrigger };
}

export interface ChannelComparisonRow {
  channel: string;
  sent: number;
  failed: number;
  successRate: number;
}

export function getChannelComparison(): ChannelComparisonRow[] {
  const sentRows = getDb()
    .prepare('SELECT channel, COUNT(*) as sent FROM sent_notifications GROUP BY channel')
    .all() as { channel: string; sent: number }[];

  const { count: failedWebhook } = getDb()
    .prepare("SELECT COUNT(*) as count FROM webhook_delivery_logs WHERE status = 'failed'")
    .get() as { count: number };

  return sentRows.map((row) => {
    const failed = row.channel === 'webhook' ? failedWebhook : 0;
    const successRate = row.sent > 0 ? (row.sent - failed) / row.sent : 1;
    return { channel: row.channel, sent: row.sent, failed, successRate };
  });
}

export interface TrendRow {
  date: string;
  count: number;
}

export function getTrendAnalytics(days: number): TrendRow[] {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  return getDb()
    .prepare(
      `SELECT date(sent_at / 1000, 'unixepoch') as date, COUNT(*) as count
        FROM sent_notifications
        WHERE sent_at >= ?
        GROUP BY date
        ORDER BY date ASC`
    )
    .all(cutoffMs) as TrendRow[];
}

// ─── Delivery audit log (durable, queryable, independent of retry state) ─────

export interface DeliveryAuditRecord {
  id: number;
  invoice_id: number;
  trigger: NotificationTrigger;
  recipient_address: string;
  channel: SubscriptionChannel;
  destination: string;
  event_id: string | null;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error: string | null;
  attempt_timestamps: number[]; // decoded from JSON
  created_at: number;
  updated_at: number;
}

export interface DeliveryAuditFilter {
  recipient?: string;
  eventId?: string;
  trigger?: string;
  channel?: string;
  status?: 'pending' | 'delivered' | 'failed';
  startTime?: number; // ms epoch inclusive
  endTime?: number; // ms epoch inclusive
  limit?: number;
  offset?: number;
}

export function createDeliveryAuditLog(entry: {
  invoice_id: number;
  trigger: NotificationTrigger;
  recipient_address: string;
  channel: SubscriptionChannel;
  destination: string;
  event_id?: string | null;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error?: string | null;
  attempt_timestamps: number[];
}): DeliveryAuditRecord {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO delivery_audit_log
        (invoice_id, trigger, recipient_address, channel, destination, event_id, status, attempts, last_error, attempt_timestamps, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.invoice_id,
      entry.trigger,
      entry.recipient_address,
      entry.channel,
      entry.destination,
      entry.event_id ?? null,
      entry.status,
      entry.attempts,
      entry.last_error ?? null,
      JSON.stringify(entry.attempt_timestamps),
      now,
      now
    );

  return {
    id: Number(result.lastInsertRowid),
    invoice_id: entry.invoice_id,
    trigger: entry.trigger,
    recipient_address: entry.recipient_address,
    channel: entry.channel,
    destination: entry.destination,
    event_id: entry.event_id ?? null,
    status: entry.status,
    attempts: entry.attempts,
    last_error: entry.last_error ?? null,
    attempt_timestamps: entry.attempt_timestamps,
    created_at: now,
    updated_at: now,
  };
}

export function updateDeliveryAuditLog(
  id: number,
  updates: Partial<Pick<DeliveryAuditRecord, 'status' | 'attempts' | 'last_error' | 'attempt_timestamps'>>
): void {
  const fields: string[] = [];
  const params: any[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    params.push(updates.status);
  }
  if (updates.attempts !== undefined) {
    fields.push('attempts = ?');
    params.push(updates.attempts);
  }
  if (updates.last_error !== undefined) {
    fields.push('last_error = ?');
    params.push(updates.last_error);
  }
  if (updates.attempt_timestamps !== undefined) {
    fields.push('attempt_timestamps = ?');
    params.push(JSON.stringify(updates.attempt_timestamps));
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  getDb()
    .prepare(`UPDATE delivery_audit_log SET ${fields.join(', ')} WHERE id = ?`)
    .run(...params);
}

export function getDeliveryAuditLogs(filter: DeliveryAuditFilter = {}): DeliveryAuditRecord[] {
  const clauses: string[] = [];
  const params: any[] = [];

  if (filter.recipient) {
    clauses.push('recipient_address = ?');
    params.push(filter.recipient);
  }
  if (filter.eventId) {
    clauses.push('event_id = ?');
    params.push(filter.eventId);
  }
  if (filter.trigger) {
    clauses.push('trigger = ?');
    params.push(filter.trigger);
  }
  if (filter.channel) {
    clauses.push('channel = ?');
    params.push(filter.channel);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.startTime !== undefined) {
    clauses.push('created_at >= ?');
    params.push(filter.startTime);
  }
  if (filter.endTime !== undefined) {
    clauses.push('created_at <= ?');
    params.push(filter.endTime);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filter.limit !== undefined ? Math.min(Math.max(filter.limit, 1), 1000) : 100;
  const offset = filter.offset ?? 0;

  const rows = getDb()
    .prepare(
      `SELECT * FROM delivery_audit_log
       ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as any[];

  return rows.map((row) => ({
    id: row.id,
    invoice_id: row.invoice_id,
    trigger: row.trigger,
    recipient_address: row.recipient_address,
    channel: row.channel,
    destination: row.destination,
    event_id: row.event_id,
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    attempt_timestamps: JSON.parse(row.attempt_timestamps),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export function getDeliveryAuditLogById(id: number): DeliveryAuditRecord | undefined {
  const row = getDb().prepare('SELECT * FROM delivery_audit_log WHERE id = ?').get(id) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    trigger: row.trigger,
    recipient_address: row.recipient_address,
    channel: row.channel,
    destination: row.destination,
    event_id: row.event_id,
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    attempt_timestamps: JSON.parse(row.attempt_timestamps),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function countDeliveryAuditLogs(filter: DeliveryAuditFilter = {}): number {
  const clauses: string[] = [];
  const params: any[] = [];

  if (filter.recipient) {
    clauses.push('recipient_address = ?');
    params.push(filter.recipient);
  }
  if (filter.eventId) {
    clauses.push('event_id = ?');
    params.push(filter.eventId);
  }
  if (filter.trigger) {
    clauses.push('trigger = ?');
    params.push(filter.trigger);
  }
  if (filter.channel) {
    clauses.push('channel = ?');
    params.push(filter.channel);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.startTime !== undefined) {
    clauses.push('created_at >= ?');
    params.push(filter.startTime);
  }
  if (filter.endTime !== undefined) {
    clauses.push('created_at <= ?');
    params.push(filter.endTime);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const row = getDb()
    .prepare(`SELECT COUNT(*) as count FROM delivery_audit_log ${where}`)
    .get(...params) as { count: number };
  return row.count;
}

/**
 * Retention enforcement consistent with docs/privacy.md:
 * - sent_notifications: 30 days (from sent_at)
 * - webhook_delivery_logs: 90 days (from created_at)
 * - delivery_audit_log: 90 days (from created_at) — matches webhook logs as the
 *   durable counterpart independent of retry state.
 *
 * Returns counts of purged rows per table.
 */
export function purgeExpiredDeliveryLogs(nowMs: number = Date.now()): {
  sentNotifications: number;
  webhookLogs: number;
  auditLogs: number;
} {
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

  const sentCutoff = nowMs - thirtyDaysMs;
  const longCutoff = nowMs - ninetyDaysMs;

  const sentRes = getDb().prepare('DELETE FROM sent_notifications WHERE sent_at < ?').run(sentCutoff);
  const webhookRes = getDb()
    .prepare('DELETE FROM webhook_delivery_logs WHERE created_at < ?')
    .run(longCutoff);
  const auditRes = getDb()
    .prepare('DELETE FROM delivery_audit_log WHERE created_at < ?')
    .run(longCutoff);

  return {
    sentNotifications: sentRes.changes,
    webhookLogs: webhookRes.changes,
    auditLogs: auditRes.changes,
  };
}
