/**
 * Timing report from the database: per alert, the time from first in-zone
 * frame to stored event, event to provider acceptance / delivery report, and
 * event to human acknowledgement. Compare first_seen with your manually
 * annotated crossing time to get crossing → event latency.
 *
 *   npm run report:timings [-- --since 2026-11-15T00:00:00Z]
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { eventRef } from '../domain/eventRef.js';
import { flag, parseArgs } from './args.js';

const cfg = loadConfig();
const { flags } = parseArgs();
const since = flag(flags, 'since') ?? '1970-01-01T00:00:00Z';
const db = createPool(cfg.DATABASE_URL, 1);

interface Row {
  id: number;
  zone_label: string;
  source: string;
  status: string;
  first_seen_at: Date;
  opened_at: Date;
  persist_s: number;
  accepted_s: number | null;
  delivered_s: number | null;
  ack_s: number | null;
  sms_status: string | null;
}

try {
  const { rows } = await db.query<Row>(
    `SELECT e.id, e.zone_label, e.source, e.status, e.first_seen_at, e.opened_at,
            EXTRACT(EPOCH FROM e.opened_at - e.first_seen_at)::float8 AS persist_s,
            EXTRACT(EPOCH FROM min(j.accepted_at) - e.opened_at)::float8 AS accepted_s,
            EXTRACT(EPOCH FROM min(j.delivered_at) - e.opened_at)::float8 AS delivered_s,
            EXTRACT(EPOCH FROM e.acknowledged_at - e.opened_at)::float8 AS ack_s,
            string_agg(DISTINCT j.status, ',') AS sms_status
       FROM events e LEFT JOIN notification_jobs j ON j.event_id = e.id
      WHERE e.opened_at >= $1
      GROUP BY e.id ORDER BY e.id`,
    [since],
  );
  const f = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)}s`);
  console.log('ref      source     zone               first→event  event→SMS accepted  event→delivered  event→ack   sms');
  for (const r of rows) {
    console.log(
      [
        eventRef(r.id).padEnd(8),
        r.source.padEnd(10),
        r.zone_label.slice(0, 18).padEnd(18),
        f(r.persist_s).padStart(11),
        f(r.accepted_s).padStart(18),
        f(r.delivered_s).padStart(16),
        f(r.ack_s).padStart(10),
        ` ${r.sms_status ?? '—'}`,
      ].join(' '),
    );
  }
  const median = (xs: number[]) => {
    const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) / 2)]! : null;
  };
  console.log(
    `\n${rows.length} alert(s). Medians: first→event ${f(median(rows.map((r) => r.persist_s)))}, ` +
      `event→SMS accepted ${f(median(rows.flatMap((r) => (r.accepted_s === null ? [] : [r.accepted_s]))))}, ` +
      `event→ack ${f(median(rows.flatMap((r) => (r.ack_s === null ? [] : [r.ack_s]))))}.`,
  );
  console.log('Report the environment with these numbers (laptop model, CPU, source, network). They are not field response times.');
} finally {
  await db.end();
}
