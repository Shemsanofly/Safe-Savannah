import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { parseEventRef } from '../domain/eventRef.js';
import type { NotificationJobRow } from '../notify/outbox.js';
import type { EventActionRow, EventRow } from './events.js';

/** SMS job statuses grouped the way a duty officer thinks about them. */
export const SMS_GROUPS = {
  queued: ['pending', 'sending', 'retry_wait'],
  accepted: ['accepted'],
  delivered: ['delivered'],
  problem: ['failed', 'unknown', 'delivery_failed'],
  not_sent: ['expired', 'cancelled'],
} as const;
export type SmsGroup = keyof typeof SMS_GROUPS | 'none';

const STATUSES = ['open', 'acknowledged', 'closed', 'false_alert'] as const;
const SOURCES = ['inference', 'simulated', 'synthetic'] as const;
const csv = <T extends string>(allowed: readonly T[]) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (!allowed.includes(p as T)) {
          ctx.addIssue({ code: 'custom', message: `Unknown value "${p}"` });
          return z.NEVER;
        }
      }
      return parts as T[];
    });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const IncidentFiltersSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v === 'active' ? 'open,acknowledged' : v))
    .pipe(csv(STATUSES)),
  source: csv(SOURCES),
  zone: z.string().max(64).optional(),
  sms: z.enum(['queued', 'accepted', 'delivered', 'problem', 'not_sent', 'none']).optional(),
  owner: z.string().max(32).optional(),
  /** Inclusive dates in the lodge time zone. */
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(['opened_at', 'last_seen_at', 'confidence', 'ack_seconds', 'id']).default('opened_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(20),
});
export type IncidentFilters = z.infer<typeof IncidentFiltersSchema>;

interface Built {
  where: string;
  params: unknown[];
}

/** Translate filters into a parameterised WHERE clause. `me` is the signed-in operator id. */
export function buildIncidentWhere(f: IncidentFilters, opts: { timeZone: string; me: string }): Built {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const clauses: string[] = [];
  if (f.status?.length) clauses.push(`e.status = ANY(${p(f.status)}::event_status[])`);
  if (f.source?.length) clauses.push(`e.source = ANY(${p(f.source)}::text[])`);
  if (f.zone) clauses.push(`e.zone_id = ${p(f.zone)}`);
  if (f.owner) clauses.push(`e.acknowledged_by = ${p(f.owner === 'me' ? opts.me : f.owner)}`);
  if (f.from) clauses.push(`e.opened_at >= (${p(f.from)}::date)::timestamp AT TIME ZONE ${p(opts.timeZone)}`);
  if (f.to) clauses.push(`e.opened_at < ((${p(f.to)}::date + 1)::timestamp AT TIME ZONE ${p(opts.timeZone)})`);
  if (f.sms === 'none') {
    clauses.push(`NOT EXISTS (SELECT 1 FROM notification_jobs j WHERE j.event_id = e.id)`);
  } else if (f.sms) {
    clauses.push(`EXISTS (SELECT 1 FROM notification_jobs j WHERE j.event_id = e.id AND j.status = ANY(${p([...SMS_GROUPS[f.sms]])}::text[]))`);
  }
  if (f.q) {
    const like = p(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const parts = [
      `e.zone_label ILIKE ${like}`,
      `e.zone_id ILIKE ${like}`,
      `e.close_reason ILIKE ${like}`,
      `e.acknowledged_by ILIKE ${like}`,
      `e.closed_by ILIKE ${like}`,
      `EXISTS (SELECT 1 FROM event_actions a WHERE a.event_id = e.id AND (a.note ILIKE ${like} OR a.actor ILIKE ${like}))`,
      `EXISTS (SELECT 1 FROM operators o WHERE o.name ILIKE ${like} AND o.id IN (e.acknowledged_by, e.closed_by))`,
    ];
    const id = parseEventRef(f.q);
    if (id) parts.push(`e.id = ${p(id)}`);
    clauses.push(`(${parts.join(' OR ')})`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const SORT_SQL: Record<IncidentFilters['sort'], string> = {
  opened_at: 'e.opened_at',
  last_seen_at: 'e.last_seen_at',
  confidence: 'e.confidence',
  ack_seconds: 'EXTRACT(EPOCH FROM e.acknowledged_at - e.opened_at)',
  id: 'e.id',
};

export interface IncidentListItem {
  id: number;
  zone_id: string;
  zone_label: string;
  class_label: string;
  confidence: number;
  status: EventRow['status'];
  source: EventRow['source'];
  first_seen_at: Date;
  opened_at: Date;
  last_seen_at: Date;
  acknowledged_by: string | null;
  acknowledged_by_name: string | null;
  acknowledged_at: Date | null;
  closed_by: string | null;
  closed_by_name: string | null;
  closed_at: Date | null;
  close_reason: string | null;
  ack_seconds: number | null;
  handoff_count: number;
  has_snapshot: boolean;
  sms_statuses: string[];
}

const LIST_SELECT = `
  SELECT e.id, e.zone_id, e.zone_label, e.class_label, e.confidence, e.status, e.source, e.first_seen_at, e.opened_at,
         e.last_seen_at, e.acknowledged_by, ack.name AS acknowledged_by_name, e.acknowledged_at, e.closed_by,
         cl.name AS closed_by_name, e.closed_at, e.close_reason, e.model,
         EXTRACT(EPOCH FROM e.acknowledged_at - e.opened_at)::float8 AS ack_seconds,
         (SELECT count(*)::int FROM event_actions a WHERE a.event_id = e.id AND a.action = 'handoff') AS handoff_count,
         (e.snapshot_path IS NOT NULL) AS has_snapshot,
         COALESCE((SELECT array_agg(j.status ORDER BY j.id) FROM notification_jobs j WHERE j.event_id = e.id), '{}') AS sms_statuses
    FROM events e
    LEFT JOIN operators ack ON ack.id = e.acknowledged_by
    LEFT JOIN operators cl ON cl.id = e.closed_by`;

export async function listIncidents(
  db: Queryable,
  f: IncidentFilters,
  opts: { timeZone: string; me: string },
): Promise<{ items: IncidentListItem[]; total: number; page: number; pageSize: number; pages: number }> {
  const { where, params } = buildIncidentWhere(f, opts);
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM events e ${where}`, params)).rows[0]?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / f.pageSize));
  const page = Math.min(f.page, pages);
  const nulls = f.order === 'desc' ? 'NULLS LAST' : 'NULLS FIRST';
  const r = await db.query<IncidentListItem>(
    `${LIST_SELECT} ${where}
     ORDER BY ${SORT_SQL[f.sort]} ${f.order === 'asc' ? 'ASC' : 'DESC'} ${nulls}, e.id ${f.order === 'asc' ? 'ASC' : 'DESC'}
     LIMIT ${f.pageSize} OFFSET ${(page - 1) * f.pageSize}`,
    params,
  );
  return { items: r.rows, total, page, pageSize: f.pageSize, pages };
}

/** All matching rows for export (capped). */
export async function exportIncidents(db: Queryable, f: IncidentFilters, opts: { timeZone: string; me: string }, cap = 10_000) {
  const { where, params } = buildIncidentWhere(f, opts);
  const r = await db.query<IncidentListItem & { model: string | null }>(
    `${LIST_SELECT} ${where} ORDER BY ${SORT_SQL[f.sort]} ${f.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, e.id LIMIT ${cap + 1}`,
    params,
  );
  return { rows: r.rows.slice(0, cap), truncated: r.rows.length > cap };
}

// ---------------------------------------------------------------------------
// Detail

export interface NotificationAttemptRow {
  id: number;
  job_id: number;
  started_at: Date;
  finished_at: Date;
  outcome: string;
  http_status: number | null;
  detail: string | null;
}

export type TimelineEntry =
  | { at: Date; kind: 'action'; action: string; actor: string; actorName: string | null; channel: string | null; note: string | null }
  | { at: Date; kind: 'sms_attempt'; recipient: string; outcome: string; detail: string | null; httpStatus: number | null }
  | { at: Date; kind: 'sms_queued'; recipient: string }
  | { at: Date; kind: 'sms_delivery'; recipient: string; status: string; detail: string | null }
  | { at: Date; kind: 'sms_not_sent'; recipient: string; status: string; detail: string | null };

export interface IncidentDetail {
  event: EventRow & { acknowledged_by_name: string | null; closed_by_name: string | null };
  actions: (EventActionRow & { actor_name: string | null })[];
  notifications: (NotificationJobRow & { attemptLog: NotificationAttemptRow[] })[];
  timeline: TimelineEntry[];
}

export async function getIncidentDetail(db: Queryable, id: number): Promise<IncidentDetail | null> {
  const ev = await db.query<IncidentDetail['event']>(
    `SELECT e.*, ack.name AS acknowledged_by_name, cl.name AS closed_by_name
       FROM events e LEFT JOIN operators ack ON ack.id = e.acknowledged_by LEFT JOIN operators cl ON cl.id = e.closed_by
      WHERE e.id = $1`,
    [id],
  );
  const event = ev.rows[0];
  if (!event) return null;
  const [actions, jobs, attempts] = await Promise.all([
    db.query<EventActionRow & { actor_name: string | null }>(
      `SELECT a.*, o.name AS actor_name FROM event_actions a LEFT JOIN operators o ON o.id = a.actor
        WHERE a.event_id = $1 ORDER BY a.created_at, a.id`,
      [id],
    ),
    db.query<NotificationJobRow>('SELECT * FROM notification_jobs WHERE event_id = $1 ORDER BY id', [id]),
    db.query<NotificationAttemptRow>(
      `SELECT t.* FROM notification_attempts t JOIN notification_jobs j ON j.id = t.job_id WHERE j.event_id = $1 ORDER BY t.started_at, t.id`,
      [id],
    ),
  ]);
  const notifications = jobs.rows.map((j) => ({ ...j, attemptLog: attempts.rows.filter((a) => a.job_id === j.id) }));
  const timeline: TimelineEntry[] = actions.rows.map((a) => ({
    at: a.created_at,
    kind: 'action' as const,
    action: a.action,
    actor: a.actor,
    actorName: a.actor_name,
    channel: a.channel,
    note: a.note,
  }));
  for (const j of notifications) {
    timeline.push({ at: j.created_at, kind: 'sms_queued', recipient: j.recipient_alias });
    for (const t of j.attemptLog) {
      timeline.push({ at: t.finished_at, kind: 'sms_attempt', recipient: j.recipient_alias, outcome: t.outcome, detail: t.detail, httpStatus: t.http_status });
    }
    if (j.delivered_at) timeline.push({ at: j.delivered_at, kind: 'sms_delivery', recipient: j.recipient_alias, status: 'delivered', detail: j.provider_status });
    else if (j.status === 'delivery_failed') {
      timeline.push({ at: j.updated_at, kind: 'sms_delivery', recipient: j.recipient_alias, status: 'delivery_failed', detail: j.provider_status });
    }
    if (j.status === 'expired' || j.status === 'cancelled') {
      timeline.push({ at: j.updated_at, kind: 'sms_not_sent', recipient: j.recipient_alias, status: j.status, detail: j.last_error });
    }
  }
  timeline.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { event, actions: actions.rows, notifications, timeline };
}

// ---------------------------------------------------------------------------
// Reports

export const ReportRangeSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    source: csv(SOURCES),
  })
  .refine((r) => r.from <= r.to, { message: '"from" must not be after "to"' })
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= 366, { message: 'Range is limited to 366 days' });
export type ReportRange = z.infer<typeof ReportRangeSchema>;

export interface ReportSummary {
  range: { from: string; to: string; timeZone: string; sources: string[] | null };
  totals: { incidents: number; open: number; acknowledged: number; closed: number; falseAlerts: number };
  bySource: Record<string, number>;
  byZone: { zone_label: string; n: number }[];
  acknowledgement: { count: number; medianSeconds: number | null; meanSeconds: number | null; maxSeconds: number | null };
  resolution: { count: number; medianSeconds: number | null };
  sms: { jobs: number; byStatus: Record<string, number>; medianSecondsToAccepted: number | null };
  perDay: { day: string; incidents: number; falseAlerts: number }[];
}

export async function reportSummary(db: Queryable, r: ReportRange, timeZone: string): Promise<ReportSummary> {
  const params: unknown[] = [r.from, r.to, timeZone];
  let sourceClause = '';
  if (r.source?.length) {
    params.push(r.source);
    sourceClause = `AND e.source = ANY($4::text[])`;
  }
  const scope = `FROM events e
    WHERE e.opened_at >= ($1::date)::timestamp AT TIME ZONE $3
      AND e.opened_at < (($2::date + 1)::timestamp AT TIME ZONE $3) ${sourceClause}`;

  const [totals, bySource, byZone, ack, res, sms, perDay] = await Promise.all([
    db.query<{ n: number; open: number; acknowledged: number; closed: number; false_alert: number }>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
              count(*) FILTER (WHERE status = 'closed')::int AS closed,
              count(*) FILTER (WHERE status = 'false_alert')::int AS false_alert ${scope}`,
      params,
    ),
    db.query<{ source: string; n: number }>(`SELECT e.source, count(*)::int AS n ${scope} GROUP BY e.source`, params),
    db.query<{ zone_label: string; n: number }>(`SELECT e.zone_label, count(*)::int AS n ${scope} GROUP BY e.zone_label ORDER BY n DESC`, params),
    db.query<{ n: number; median: number | null; mean: number | null; max: number | null }>(
      `SELECT count(*)::int AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS median, avg(s)::float8 AS mean, max(s)::float8 AS max
         FROM (SELECT EXTRACT(EPOCH FROM e.acknowledged_at - e.opened_at)::float8 AS s ${scope} AND e.acknowledged_at IS NOT NULL) x`,
      params,
    ),
    db.query<{ n: number; median: number | null }>(
      `SELECT count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS median
         FROM (SELECT EXTRACT(EPOCH FROM e.closed_at - e.opened_at)::float8 AS s ${scope} AND e.closed_at IS NOT NULL) x`,
      params,
    ),
    db.query<{ status: string; n: number; median_accept: number | null }>(
      `SELECT j.status, count(*)::int AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM j.accepted_at - e.opened_at)) AS median_accept
         FROM notification_jobs j JOIN events e ON e.id = j.event_id
        WHERE e.opened_at >= ($1::date)::timestamp AT TIME ZONE $3
          AND e.opened_at < (($2::date + 1)::timestamp AT TIME ZONE $3) ${sourceClause}
        GROUP BY ROLLUP (j.status)`,
      params,
    ),
    db.query<{ day: string; incidents: number; false_alerts: number }>(
      `SELECT to_char(date_trunc('day', e.opened_at AT TIME ZONE $3), 'YYYY-MM-DD') AS day, count(*)::int AS incidents,
              count(*) FILTER (WHERE e.status = 'false_alert')::int AS false_alerts
         ${scope} GROUP BY 1 ORDER BY 1`,
      params,
    ),
  ]);

  const t = totals.rows[0]!;
  const smsRows = sms.rows.filter((s) => s.status !== null);
  const smsTotal = sms.rows.find((s) => s.status === null);
  const round = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
  return {
    range: { from: r.from, to: r.to, timeZone, sources: r.source ?? null },
    totals: { incidents: t.n, open: t.open, acknowledged: t.acknowledged, closed: t.closed, falseAlerts: t.false_alert },
    bySource: Object.fromEntries(bySource.rows.map((s) => [s.source, s.n])),
    byZone: byZone.rows,
    acknowledgement: {
      count: ack.rows[0]!.n,
      medianSeconds: round(ack.rows[0]!.median),
      meanSeconds: round(ack.rows[0]!.mean),
      maxSeconds: round(ack.rows[0]!.max),
    },
    resolution: { count: res.rows[0]!.n, medianSeconds: round(res.rows[0]!.median) },
    sms: {
      jobs: smsTotal?.n ?? 0,
      byStatus: Object.fromEntries(smsRows.map((s) => [s.status, s.n])),
      medianSecondsToAccepted: round(smsTotal?.median_accept ?? null),
    },
    perDay: perDay.rows.map((d) => ({ day: d.day, incidents: d.incidents, falseAlerts: d.false_alerts })),
  };
}

// ---------------------------------------------------------------------------
// Notifications list

export const NotificationFiltersSchema = z.object({
  group: z.enum(['queued', 'accepted', 'delivered', 'problem', 'not_sent']).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
});

export async function listNotifications(db: Queryable, f: z.infer<typeof NotificationFiltersSchema>) {
  const params: unknown[] = [];
  let where = '';
  if (f.group) {
    params.push([...SMS_GROUPS[f.group]]);
    where = 'WHERE j.status = ANY($1::text[])';
  }
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM notification_jobs j ${where}`, params)).rows[0]?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / f.pageSize));
  const page = Math.min(f.page, pages);
  const r = await db.query(
    `SELECT j.id, j.event_id, j.recipient_alias, j.status, j.attempts, j.next_attempt_at, j.last_error, j.provider,
            j.provider_message_id, j.provider_status, j.message_body, j.created_at, j.updated_at, j.accepted_at, j.delivered_at,
            e.zone_label, e.status AS event_status, e.source AS event_source
       FROM notification_jobs j JOIN events e ON e.id = j.event_id
       ${where}
      ORDER BY j.updated_at DESC, j.id DESC
      LIMIT ${f.pageSize} OFFSET ${(page - 1) * f.pageSize}`,
    params,
  );
  const counts = await db.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM notification_jobs GROUP BY status');
  return { items: r.rows, total, page, pages, pageSize: f.pageSize, countsByStatus: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])) };
}
