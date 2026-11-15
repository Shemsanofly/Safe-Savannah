import type pg from 'pg';
import { withTx, type Db } from '../db/pool.js';
import { errMsg, type Logger } from '../log.js';
import { NOTIFY_CHANNEL } from '../store/events.js';
import { mapDeliveryStatus } from './africasTalking.js';
import { alertMessage } from './message.js';
import type { SendOutcome, SmsProvider, VoiceProvider } from './provider.js';

export type JobStatus =
  | 'pending'
  | 'sending'
  | 'retry_wait'
  | 'accepted'
  | 'delivered'
  | 'delivery_failed'
  | 'unknown'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface NotificationJobRow {
  id: number;
  event_id: number;
  recipient_alias: string;
  kind: string;
  status: JobStatus;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  provider: string | null;
  provider_message_id: string | null;
  provider_status: string | null;
  message_body: string | null;
  channel: 'sms' | 'voice';
  to_number: string | null;
  recipient_kind: 'duty' | 'ranger' | 'tourist' | 'admin';
  created_at: Date;
  updated_at: Date;
  accepted_at: Date | null;
  delivered_at: Date | null;
}

export interface OutboxOptions {
  provider: SmsProvider;
  /** Voice calls (Africa's Talking voice, or the labelled simulation). */
  voice?: VoiceProvider;
  recipients: Map<string, string>;
  freshnessSeconds: number;
  testMode: boolean;
  /** Retry backoff for transient failures: base * 2^(attempt-1), capped. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

export function backoffMs(attempts: number, baseMs = 5_000, capMs = 120_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

type ClaimedJob = NotificationJobRow & {
  event_status: string;
  event_last_seen_at: Date;
  zone_label: string;
  class_label: string;
  source: string;
};

export type ProcessResult = 'idle' | 'processed';

/**
 * Transactional-outbox SMS worker. Jobs are committed to disk with the alert,
 * so they survive restarts and outages. It does NOT promise exactly-once SMS:
 * an ambiguous outcome is marked "unknown" for a human to reconcile.
 */
export class OutboxWorker {
  constructor(
    private readonly db: Db,
    private readonly opts: OutboxOptions,
    private readonly log: Logger,
  ) {}

  /**
   * A job left in 'sending' means the worker died mid-request: we cannot know
   * whether the provider accepted it, so it becomes 'unknown' (never auto-resent).
   */
  async recoverInterrupted(): Promise<number> {
    const r = await this.db.query(
      `UPDATE notification_jobs
          SET status = 'unknown', updated_at = now(),
              last_error = 'worker stopped while the request was in flight; delivery outcome unknown'
        WHERE status = 'sending'`,
    );
    return r.rowCount ?? 0;
  }

  /** Claim and process one due job. Returns 'idle' when nothing is due. */
  async processOne(): Promise<ProcessResult> {
    const claimed = await withTx(this.db, async (c) => {
      const r = await c.query<ClaimedJob>(
        `SELECT j.*, e.status AS event_status, e.last_seen_at AS event_last_seen_at,
                COALESCE(e.zone_label, e.title, 'the area') AS zone_label, COALESCE(e.class_label, 'wildlife') AS class_label, e.source
           FROM notification_jobs j JOIN events e ON e.id = j.event_id
          WHERE j.status IN ('pending', 'retry_wait') AND j.next_attempt_at <= now()
          ORDER BY j.next_attempt_at, j.id
          FOR UPDATE OF j SKIP LOCKED
          LIMIT 1`,
      );
      const job = r.rows[0];
      if (!job) return null;

      // Alerts are pointless once an incident is closed; status updates (e.g. "your SOS is resolved") are not.
      const isAlert = job.kind === 'initial' || job.kind === 'alert' || job.kind === 'voice_alert';
      if (isAlert && (job.event_status === 'closed' || job.event_status === 'false_alert')) {
        await c.query(
          `UPDATE notification_jobs SET status = 'cancelled', updated_at = now(), last_error = $2 WHERE id = $1`,
          [job.id, `not sent: incident ${job.event_status} before the message could be sent`],
        );
        return { job, skip: true as const };
      }
      const ageMs = Date.now() - (isAlert ? job.event_last_seen_at : job.created_at).getTime();
      if (ageMs > this.opts.freshnessSeconds * 1000) {
        await c.query(
          `UPDATE notification_jobs SET status = 'expired', updated_at = now(), last_error = $2 WHERE id = $1`,
          [job.id, `not sent: alert last seen ${Math.round(ageMs / 1000)}s ago (> ${this.opts.freshnessSeconds}s freshness window)`],
        );
        return { job, skip: true as const };
      }
      const number = job.to_number ?? this.opts.recipients.get(job.recipient_alias);
      if (!number) {
        await c.query(
          `UPDATE notification_jobs SET status = 'failed', updated_at = now(), last_error = $2 WHERE id = $1`,
          [job.id, `no phone number configured for recipient alias "${job.recipient_alias}"`],
        );
        return { job, skip: true as const };
      }
      const body = job.message_body ?? alertMessage({
        eventId: job.event_id,
        zoneLabel: job.zone_label,
        classLabel: job.class_label,
        testMode: this.opts.testMode,
        simulated: job.source !== 'inference',
      });
      await c.query(
        `UPDATE notification_jobs
            SET status = 'sending', attempts = attempts + 1, provider = $2, message_body = $3, updated_at = now()
          WHERE id = $1`,
        [job.id, job.channel === 'voice' ? (this.opts.voice?.name ?? 'none') : this.opts.provider.name, body],
      );
      return { job, skip: false as const, number, body };
    });

    if (!claimed) return 'idle';
    if (claimed.skip) {
      this.log.info('notification skipped', { jobId: claimed.job.id, eventId: claimed.job.event_id });
      return 'processed';
    }

    const { job, number, body } = claimed;
    const startedAt = new Date();
    let outcome: SendOutcome;
    try {
      if (job.channel === 'voice') {
        outcome = this.opts.voice
          ? await this.opts.voice.call({ jobId: job.id, recipientAlias: job.recipient_alias, to: number, script: body })
          : { kind: 'rejected', detail: 'No voice provider configured' };
      } else {
        outcome = await this.opts.provider.send({ recipientAlias: job.recipient_alias, to: number, body });
      }
    } catch (err) {
      outcome = { kind: 'ambiguous', detail: `adapter threw: ${errMsg(err)}` };
    }
    await this.recordOutcome(job.id, job.attempts + 1, startedAt, outcome);
    this.log.info('notification attempt', { jobId: job.id, eventId: job.event_id, outcome: outcome.kind });
    return 'processed';
  }

  private async recordOutcome(jobId: number, attempts: number, startedAt: Date, o: SendOutcome): Promise<void> {
    await withTx(this.db, async (c) => {
      await c.query(
        `INSERT INTO notification_attempts (job_id, started_at, outcome, http_status, detail) VALUES ($1, $2, $3, $4, $5)`,
        [jobId, startedAt, o.kind, o.httpStatus ?? null, 'detail' in o ? (o.detail ?? null) : null],
      );
      switch (o.kind) {
        case 'accepted':
          await c.query(
            `UPDATE notification_jobs
                SET status = 'accepted', provider_message_id = $2, provider_status = $3, accepted_at = now(),
                    last_error = NULL, updated_at = now()
              WHERE id = $1`,
            [jobId, o.messageId, o.providerStatus],
          );
          break;
        case 'transient': {
          const delay = backoffMs(attempts, this.opts.backoffBaseMs, this.opts.backoffCapMs);
          await c.query(
            `UPDATE notification_jobs
                SET status = 'retry_wait', next_attempt_at = now() + ($2::int * interval '1 millisecond'),
                    last_error = $3, updated_at = now()
              WHERE id = $1`,
            [jobId, delay, o.detail],
          );
          break;
        }
        case 'ambiguous':
          await c.query(
            `UPDATE notification_jobs SET status = 'unknown', last_error = $2, updated_at = now() WHERE id = $1`,
            [jobId, o.detail],
          );
          break;
        case 'rejected':
          await c.query(
            `UPDATE notification_jobs SET status = 'failed', provider_status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
            [jobId, o.providerStatus ?? null, o.detail],
          );
          break;
      }
    });
  }

  /** Drain all due jobs. */
  async drain(): Promise<number> {
    let n = 0;
    while ((await this.processOne()) === 'processed') n += 1;
    return n;
  }

  /**
   * Run until aborted: wakes on LISTEN/NOTIFY from new alerts, and polls every
   * pollMs for retries that become due.
   */
  async run(signal: AbortSignal, listenClient: pg.Client, pollMs = 2_000): Promise<void> {
    let wake: (() => void) | null = null;
    let notified = false;
    listenClient.on('notification', () => {
      notified = true;
      wake?.();
    });
    await listenClient.query(`LISTEN ${NOTIFY_CHANNEL}`);
    const interrupted = await this.recoverInterrupted();
    if (interrupted) this.log.warn('jobs interrupted mid-send marked unknown', { count: interrupted });
    const onAbort = () => wake?.();
    signal.addEventListener('abort', onAbort, { once: true });
    while (!signal.aborted) {
      notified = false;
      try {
        await this.drain();
      } catch (err) {
        this.log.error('outbox drain failed', { error: errMsg(err) });
      }
      if (signal.aborted) break;
      if (notified) continue; // a new alert arrived while draining
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
    }
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Operator-requested resend of an 'unknown' or 'failed' job, after they have
 * checked the handset. Resets the same job (so the unique constraint still
 * guarantees one initial job per event and recipient) and logs who asked.
 */
export async function requestResend(db: Db, jobId: number, actor: string): Promise<NotificationJobRow> {
  return withTx(db, async (c) => {
    const r = await c.query<NotificationJobRow>('SELECT * FROM notification_jobs WHERE id = $1 FOR UPDATE', [jobId]);
    const job = r.rows[0];
    if (!job) throw Object.assign(new Error('Notification job not found'), { status: 404 });
    if (!['unknown', 'failed', 'expired', 'delivery_failed'].includes(job.status)) {
      throw Object.assign(new Error(`Cannot resend a job that is ${job.status}`), { status: 409 });
    }
    const u = await c.query<NotificationJobRow>(
      `UPDATE notification_jobs SET status = 'pending', next_attempt_at = now(), updated_at = now(),
              last_error = $2
        WHERE id = $1 RETURNING *`,
      [jobId, `resend requested by ${actor} (previous: ${job.status})`],
    );
    await c.query(
      `INSERT INTO event_actions (event_id, actor, action, channel, note) VALUES ($1, $2, 'sms_resend_requested', 'dashboard', $3)`,
      [job.event_id, actor, `SMS to ${job.recipient_alias} re-queued (was ${job.status})`],
    );
    await c.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, String(job.event_id)]);
    return u.rows[0]!;
  });
}

/**
 * Apply a provider delivery report. Updates notification state only — never
 * incident status or ownership. Final states are not overwritten by late
 * intermediate reports.
 */
export async function applyDeliveryReport(db: Db, report: { id: string; status: string; failureReason?: string }): Promise<boolean> {
  const mapped = mapDeliveryStatus(report.status);
  const detail = report.failureReason ? `${report.status}: ${report.failureReason}` : report.status;
  const r = await db.query(
    `UPDATE notification_jobs
        SET provider_status = $2,
            status = CASE WHEN $3::text IS NOT NULL AND status IN ('accepted', 'unknown') THEN $3::text ELSE status END,
            delivered_at = CASE WHEN $3::text = 'delivered' AND status IN ('accepted', 'unknown') THEN now() ELSE delivered_at END,
            last_error = CASE WHEN $3::text = 'delivery_failed' THEN $2 ELSE last_error END,
            updated_at = now()
      WHERE provider_message_id = $1`,
    [report.id, detail, mapped],
  );
  return (r.rowCount ?? 0) > 0;
}
