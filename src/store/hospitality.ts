// Hospitality: lodges and camps as partners, front-desk hosts, QR check-in,
// guest roll calls ("Are you safe?") and all-clear notices.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { withTx, type Db, type DbClient, type Queryable } from '../db/pool.js';
import { eventRef } from '../domain/eventRef.js';
import { DomainError } from './events.js';
import { enqueue, type Job } from './outboxJobs.js';

export interface LodgeRow {
  id: string; name: string; area_id: string; zone_id: number | null; phone: string | null; checkin_code: string;
  active: boolean; demo: boolean; created_at: Date; area_name?: string; zone_name?: string | null;
}

interface MsgOpts { emergencyLine: string; testMode: boolean; includeDemoRecipients?: boolean }

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
/** Short, unambiguous code printed in the reception QR (no 0/O/1/I). */
export function newCheckinCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join('');
}

// ============================================================ lodges
const LODGE_SELECT = `SELECT l.*, a.name AS area_name, z.name AS zone_name
  FROM lodges l JOIN areas a ON a.id = l.area_id LEFT JOIN safety_zones z ON z.id = l.zone_id`;

export const LodgeInputSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9-]{2,40}$/, 'Use 2–40 lowercase letters, digits or -').optional(),
  name: z.string().trim().min(2, 'Enter the lodge name').max(80),
  area_id: z.string().min(1, 'Choose the area'),
  zone_id: z.coerce.number().int().positive().nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  active: z.boolean().optional(),
});

export async function listLodges(db: Queryable) {
  return (
    await db.query<LodgeRow & { guests_tonight: number; hosts: number }>(
      `${LODGE_SELECT.replace('SELECT l.*', `SELECT l.*,
         (SELECT count(*)::int FROM tourists t WHERE t.lodge_id = l.id AND t.active AND current_date BETWEEN t.trip_start AND t.trip_end) AS guests_tonight,
         (SELECT count(*)::int FROM operators o WHERE o.lodge_id = l.id AND o.active AND o.role = 'host') AS hosts`)}
       ORDER BY l.active DESC, a.name, l.name`,
    )
  ).rows;
}
export async function getLodge(db: Queryable, id: string): Promise<LodgeRow | null> {
  return (await db.query<LodgeRow>(`${LODGE_SELECT} WHERE l.id = $1`, [id])).rows[0] ?? null;
}
export async function getLodgeByCode(db: Queryable, code: string): Promise<LodgeRow | null> {
  return (await db.query<LodgeRow>(`${LODGE_SELECT} WHERE l.checkin_code = $1 AND l.active`, [code.trim().toUpperCase()])).rows[0] ?? null;
}

async function checkZone(db: Queryable, areaId: string, zoneId: number | null | undefined) {
  if (!(await db.query('SELECT 1 FROM areas WHERE id = $1', [areaId])).rowCount) throw new DomainError(400, 'unknown_area', 'Unknown area');
  if (zoneId && !(await db.query('SELECT 1 FROM safety_zones WHERE id = $1 AND area_id = $2', [zoneId, areaId])).rowCount) {
    throw new DomainError(400, 'unknown_zone', 'Choose a safety zone in the same area');
  }
}

export async function createLodge(db: Queryable, input: z.infer<typeof LodgeInputSchema>, demo = false): Promise<LodgeRow> {
  await checkZone(db, input.area_id, input.zone_id);
  const id = input.id || slug(input.name);
  if (id.length < 2) throw new DomainError(400, 'invalid_id', 'Choose a lodge ID');
  const r = await db.query<{ id: string }>(
    `INSERT INTO lodges (id, name, area_id, zone_id, phone, checkin_code, demo) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [id, input.name, input.area_id, input.zone_id ?? null, input.phone || null, newCheckinCode(), demo],
  );
  if (!r.rows[0]) throw new DomainError(409, 'lodge_exists', `A lodge with ID "${id}" already exists`);
  return (await getLodge(db, id))!;
}

export async function updateLodge(db: Queryable, id: string, patch: Partial<z.infer<typeof LodgeInputSchema>>): Promise<LodgeRow> {
  const cur = await getLodge(db, id);
  if (!cur) throw new DomainError(404, 'not_found', 'Lodge not found');
  const next = { ...cur, ...patch, zone_id: patch.zone_id === undefined ? cur.zone_id : patch.zone_id };
  await checkZone(db, next.area_id, next.zone_id);
  await db.query('UPDATE lodges SET name=$2, area_id=$3, zone_id=$4, phone=$5, active=$6 WHERE id=$1',
    [id, next.name, next.area_id, next.zone_id ?? null, next.phone || null, next.active]);
  return (await getLodge(db, id))!;
}

export async function regenerateCheckinCode(db: Queryable, id: string): Promise<LodgeRow> {
  const r = await db.query('UPDATE lodges SET checkin_code = $2 WHERE id = $1', [id, newCheckinCode()]);
  if (!r.rowCount) throw new DomainError(404, 'not_found', 'Lodge not found');
  return (await getLodge(db, id))!;
}

/** Link a traveller to a lodge after scanning the reception QR; their trip covers at least today. */
export async function checkInTourist(db: Queryable, touristId: number, lodge: LodgeRow, tripEnd?: string | null): Promise<void> {
  await db.query(
    `UPDATE tourists SET lodge_id = $2, lodge = $3, area_id = $4,
            trip_start = LEAST(trip_start, current_date),
            trip_end = GREATEST(current_date, COALESCE($5::date, trip_end))
      WHERE id = $1`,
    [touristId, lodge.id, lodge.name, lodge.area_id, tripEnd ?? null],
  );
  // Arriving during a roll call: the new guest is asked too.
  await db.query(
    `INSERT INTO guest_check_responses (check_id, tourist_id)
     SELECT id, $2 FROM guest_checks WHERE lodge_id = $1 AND closed_at IS NULL
     ON CONFLICT DO NOTHING`,
    [lodge.id, touristId],
  );
}

export interface GuestRow { id: number; name: string; phone: string; language: 'en' | 'sw'; group_size: number; trip_end: string; sms_alerts: boolean; demo: boolean }
export async function inHouseGuests(db: Queryable, lodgeId: string): Promise<GuestRow[]> {
  return (
    await db.query<GuestRow>(
      `SELECT id, name, phone, language, group_size, to_char(trip_end, 'YYYY-MM-DD') AS trip_end, sms_alerts, demo
         FROM tourists WHERE lodge_id = $1 AND active AND current_date BETWEEN trip_start AND trip_end ORDER BY name`,
      [lodgeId],
    )
  ).rows;
}

// ============================================================ roll calls
export interface CheckRow {
  id: number; lodge_id: string; event_id: number | null; reason: string; started_by: string; started_at: Date;
  completed_at: Date | null; closed_at: Date | null; closed_reason: string | null; demo: boolean;
}

function rollCallSms(lang: 'en' | 'sw', reason: { en: string; sw: string }, lodgeName: string, opts: MsgOpts, test: boolean): string {
  const tag = opts.testMode || test ? ' TEST' : '';
  return lang === 'sw'
    ? `Safe Savannah${tag}: ${reason.sw}. ${lodgeName} inawahesabu wageni. Uko salama? Jibu SALAMA au MSAADA. Baki ndani. Dharura: ${opts.emergencyLine}`
    : `Safe Savannah${tag}: ${reason.en}. ${lodgeName} is checking on every guest. Are you safe? Reply SAFE or HELP. Stay inside. Emergency: ${opts.emergencyLine}`;
}

/**
 * Start a roll call for a lodge (or return the one already open). Every guest staying tonight gets an
 * "Are you safe?" request in the app and, when the roll call is tied to an incident, by SMS.
 * Returns the tourist ids that were sent a roll-call SMS, so the caller can skip duplicate warnings.
 */
export async function startRollCall(
  c: DbClient,
  args: { lodge: LodgeRow; eventId: number | null; reason: { en: string; sw: string }; startedBy: string; simulated?: boolean; demo?: boolean },
  opts: MsgOpts,
): Promise<{ check: CheckRow; created: boolean; smsTo: Set<number> }> {
  const { lodge } = args;
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rollcall:${lodge.id}`]);
  const open = (await c.query<CheckRow>('SELECT * FROM guest_checks WHERE lodge_id = $1 AND closed_at IS NULL', [lodge.id])).rows[0];
  if (open) {
    if (!open.event_id && args.eventId) await c.query('UPDATE guest_checks SET event_id = $2 WHERE id = $1', [open.id, args.eventId]);
    const smsTo = new Set((await c.query<{ tourist_id: number }>('SELECT tourist_id FROM guest_check_responses WHERE check_id = $1', [open.id])).rows.map((r) => Number(r.tourist_id)));
    return { check: open, created: false, smsTo };
  }
  const check = (
    await c.query<CheckRow>(
      `INSERT INTO guest_checks (lodge_id, event_id, reason, started_by, demo) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [lodge.id, args.eventId, args.reason.en, args.startedBy, !!args.demo || lodge.demo],
    )
  ).rows[0]!;
  const guests = await inHouseGuests(c, lodge.id);
  for (const g of guests) await c.query('INSERT INTO guest_check_responses (check_id, tourist_id) VALUES ($1,$2)', [check.id, g.id]);

  const smsTo = new Set<number>();
  if (args.eventId) {
    const jobs: Job[] = [];
    const includeDemo = opts.includeDemoRecipients !== false;
    for (const g of guests) {
      if (!g.sms_alerts || (g.demo && !includeDemo)) continue;
      smsTo.add(g.id);
      jobs.push({ kind: `rollcall-${check.id}`, alias: `tourist:${g.id}`, to: g.phone, recipientKind: 'tourist', body: rollCallSms(g.language, args.reason, lodge.name, opts, !!args.simulated) });
    }
    if (lodge.phone && (includeDemo || !lodge.demo)) {
      jobs.push({
        kind: `rollcall-${check.id}`, alias: `lodge:${lodge.id}`, to: lodge.phone, recipientKind: 'lodge',
        body: `Safe Savannah${opts.testMode || args.simulated ? ' TEST' : ''}: ${args.reason.en} ${eventRef(args.eventId)}. Roll call started for ${guests.length} guest${guests.length === 1 ? '' : 's'}. Open the front desk screen.`,
      });
    }
    await enqueue(c, args.eventId, jobs);
    await c.query(`INSERT INTO event_actions (event_id, actor, action, note) VALUES ($1, 'system:lodge', 'note', $2)`, [
      args.eventId, `Roll call started at ${lodge.name}: ${guests.length} guest${guests.length === 1 ? '' : 's'} asked "Are you safe?"`,
    ]);
  }
  return { check, created: true, smsTo };
}

/** Wildlife risk at a lodge's own safety zone (high or critical) starts that lodge's roll call automatically. */
export async function rollCallsForIncident(
  c: DbClient,
  e: { id: number; safety_zone_id: number | null; demo: boolean },
  reason: { en: string; sw: string },
  simulated: boolean,
  opts: MsgOpts,
): Promise<Set<number>> {
  const handled = new Set<number>();
  if (!e.safety_zone_id) return handled;
  const lodges = (await c.query<LodgeRow>(`${LODGE_SELECT} WHERE l.zone_id = $1 AND l.active`, [e.safety_zone_id])).rows;
  for (const lodge of lodges) {
    const r = await startRollCall(c, { lodge, eventId: e.id, reason, startedBy: 'system', simulated, demo: e.demo }, opts);
    for (const id of r.smsTo) handled.add(id);
  }
  return handled;
}

export async function startManualRollCall(db: Db, lodge: LodgeRow, operatorId: string, eventId: number | null, opts: MsgOpts) {
  return withTx(db, async (c) => {
    let reason = { en: `Safety check at ${lodge.name}`, sw: `Ukaguzi wa usalama ${lodge.name}` };
    if (eventId) {
      const e = (await c.query<{ title: string | null; area_id: string | null; source: string }>('SELECT title, area_id, source FROM events WHERE id = $1', [eventId])).rows[0];
      if (!e || e.area_id !== lodge.area_id) throw new DomainError(400, 'unknown_incident', 'Choose an incident in this lodge’s area');
      reason = { en: `${e.title ?? 'Wildlife alert'}`, sw: `Tahadhari: ${e.title ?? 'wanyamapori'}` };
      return startRollCall(c, { lodge, eventId, reason, startedBy: operatorId, simulated: e.source !== 'inference' }, opts);
    }
    return startRollCall(c, { lodge, eventId: null, reason, startedBy: operatorId }, opts);
  });
}

/** Record a guest's answer. Returns the updated row; marks the roll call complete when nobody is left. */
export async function respondToRollCall(
  db: Db,
  args: { checkId: number; touristId: number; status: 'safe' | 'help'; channel: 'app' | 'sms' | 'host'; markedBy?: string | null; sosEventId?: number | null },
): Promise<{ status: string; complete: boolean }> {
  return withTx(db, async (c) => {
    const chk = (await c.query<CheckRow>('SELECT * FROM guest_checks WHERE id = $1 FOR UPDATE', [args.checkId])).rows[0];
    if (!chk) throw new DomainError(404, 'not_found', 'Roll call not found');
    if (chk.closed_at) throw new DomainError(409, 'closed', 'This roll call has ended');
    const r = await c.query(
      `UPDATE guest_check_responses SET status = $3, channel = $4, responded_at = now(), marked_by = $5, sos_event_id = COALESCE($6, sos_event_id)
        WHERE check_id = $1 AND tourist_id = $2`,
      [args.checkId, args.touristId, args.status, args.channel, args.markedBy ?? null, args.sosEventId ?? null],
    );
    if (!r.rowCount) throw new DomainError(404, 'not_guest', 'This guest is not part of the roll call');
    const counts = (
      await c.query<{ total: number; pending: number; help: number }>(
        `SELECT count(*)::int total, count(*) FILTER (WHERE status = 'pending')::int pending, count(*) FILTER (WHERE status = 'help')::int help
           FROM guest_check_responses WHERE check_id = $1`,
        [args.checkId],
      )
    ).rows[0]!;
    const complete = counts.pending === 0;
    if (complete && !chk.completed_at) {
      await c.query('UPDATE guest_checks SET completed_at = now() WHERE id = $1', [args.checkId]);
      if (chk.event_id) {
        const lodge = await getLodge(c, chk.lodge_id);
        await c.query(`INSERT INTO event_actions (event_id, actor, action, note) VALUES ($1, 'system:lodge', 'note', $2)`, [
          chk.event_id, `Roll call complete at ${lodge?.name ?? chk.lodge_id}: all ${counts.total} guests answered${counts.help ? `, ${counts.help} asked for help` : ', all safe'}.`,
        ]);
      }
    }
    return { status: args.status, complete };
  });
}

export async function closeRollCall(db: Queryable, checkId: number, lodgeId: string): Promise<void> {
  const r = await db.query(`UPDATE guest_checks SET closed_at = now(), closed_reason = 'host' WHERE id = $1 AND lodge_id = $2 AND closed_at IS NULL`, [checkId, lodgeId]);
  if (!r.rowCount) throw new DomainError(404, 'not_found', 'No open roll call to end');
}

/** The traveller's open roll calls (shown as "Are you safe?" in the app). */
export async function touristChecks(db: Queryable, touristId: number) {
  return (
    await db.query<{ id: number; lodge_name: string; reason: string; started_at: Date; status: string; event_id: number | null; sos_event_id: number | null }>(
      `SELECT g.id, l.name AS lodge_name, g.reason, g.started_at, r.status, g.event_id, r.sos_event_id
         FROM guest_check_responses r JOIN guest_checks g ON g.id = r.check_id JOIN lodges l ON l.id = g.lodge_id
        WHERE r.tourist_id = $1 AND g.closed_at IS NULL ORDER BY g.started_at DESC`,
      [touristId],
    )
  ).rows.map((x) => ({ ...x, id: Number(x.id) }));
}

/** Latest open roll call a phone number belongs to (for SMS replies). */
export async function openCheckForPhone(db: Queryable, phone: string) {
  return (
    await db.query<{ check_id: number; tourist_id: number; event_id: number | null; lodge_name: string; language: 'en' | 'sw' }>(
      `SELECT g.id AS check_id, t.id AS tourist_id, g.event_id, l.name AS lodge_name, t.language
         FROM tourists t JOIN guest_check_responses r ON r.tourist_id = t.id JOIN guest_checks g ON g.id = r.check_id JOIN lodges l ON l.id = g.lodge_id
        WHERE t.phone = $1 AND t.active AND g.closed_at IS NULL ORDER BY g.started_at DESC LIMIT 1`,
      [phone],
    )
  ).rows[0] ?? null;
}

/** Everything the front desk needs on one screen. */
export async function lodgeConsole(db: Queryable, lodgeId: string) {
  const lodge = await getLodge(db, lodgeId);
  if (!lodge) throw new DomainError(404, 'not_found', 'Lodge not found');
  const [guests, check, alerts, sos, clear] = await Promise.all([
    inHouseGuests(db, lodgeId),
    db.query<CheckRow & { event_ref?: string }>(
      `SELECT * FROM guest_checks WHERE lodge_id = $1 AND (closed_at IS NULL OR closed_at > now() - interval '3 hours') ORDER BY closed_at IS NULL DESC, started_at DESC LIMIT 1`,
      [lodgeId],
    ),
    db.query<{ id: number; kind: string; status: string; risk_level: string | null; title: string | null; zone_label: string | null; opened_at: Date; source: string; demo: boolean; at_property: boolean; responder: string | null }>(
      `SELECT e.id, e.kind, e.status, e.risk_level, e.title, e.zone_label, e.opened_at, e.source, e.demo, COALESCE(e.safety_zone_id = $2, false) AS at_property,
              o.name AS responder
         FROM events e LEFT JOIN operators o ON o.id = e.acknowledged_by
        WHERE e.area_id = $1 AND e.kind IN ('wildlife', 'zone_alert') AND e.status IN ('open', 'acknowledged')
          AND (e.safety_zone_id = $2 OR (e.risk_level IN ('high', 'critical') AND e.last_seen_at > now() - interval '12 hours'))
        ORDER BY COALESCE(e.safety_zone_id = $2, false) DESC, e.opened_at DESC LIMIT 10`,
      [lodge.area_id, lodge.zone_id ?? -1],
    ),
    db.query<{ id: number; status: string; emergency_type: string; opened_at: Date; closed_at: Date | null; name: string; phone: string; responder: string | null }>(
      `SELECT e.id, e.status, e.emergency_type, e.opened_at, e.closed_at, t.name, t.phone, o.name AS responder
         FROM events e JOIN tourists t ON t.id = e.tourist_id LEFT JOIN operators o ON o.id = e.acknowledged_by
        WHERE e.kind = 'sos' AND t.lodge_id = $1 AND (e.status IN ('open','acknowledged') OR e.opened_at > now() - interval '24 hours')
        ORDER BY e.status IN ('open','acknowledged') DESC, e.opened_at DESC LIMIT 10`,
      [lodgeId],
    ),
    db.query(
      `SELECT title_en AS title, created_at FROM tourist_alerts WHERE area_id = $1 AND level = 'clear' AND created_at > now() - interval '3 hours'
        ORDER BY created_at DESC LIMIT 1`,
      [lodge.area_id],
    ),
  ]);
  const chk = check.rows[0];
  let rollCall = null;
  if (chk) {
    const responses = (
      await db.query<{ tourist_id: number; status: string; channel: string | null; responded_at: Date | null; marked_by: string | null; sos_event_id: number | null }>(
        'SELECT tourist_id, status, channel, responded_at, marked_by, sos_event_id FROM guest_check_responses WHERE check_id = $1',
        [chk.id],
      )
    ).rows;
    const names = new Map(
      (await db.query<{ id: number; name: string; phone: string; group_size: number }>(
        'SELECT id, name, phone, group_size FROM tourists WHERE id = ANY($1::bigint[])', [responses.map((r) => r.tourist_id)],
      )).rows.map((t) => [Number(t.id), t]),
    );
    const list = responses.map((r) => ({ ...r, tourist_id: Number(r.tourist_id), ...names.get(Number(r.tourist_id)) }))
      .sort((a, b) => ({ help: 0, pending: 1, safe: 2 }[a.status]! - { help: 0, pending: 1, safe: 2 }[b.status]!) || String(a.name).localeCompare(String(b.name)));
    rollCall = {
      ...chk, id: Number(chk.id), event_ref: chk.event_id ? eventRef(chk.event_id) : null,
      counts: { total: list.length, safe: list.filter((r) => r.status === 'safe').length, help: list.filter((r) => r.status === 'help').length, pending: list.filter((r) => r.status === 'pending').length },
      people: list.reduce((n, r) => n + (r.group_size ?? 1), 0),
      responses: list,
    };
  }
  return {
    lodge,
    guests,
    rollCall,
    alerts: alerts.rows.map((a) => ({ ...a, ref: eventRef(a.id) })),
    sos: sos.rows.map((s) => ({ ...s, ref: eventRef(s.id) })),
    allClear: clear.rows,
  };
}

// ============================================================ all clear
/**
 * After a ranger resolves a wildlife incident, tell travellers it is safe to resume: an app notice for the
 * area and an SMS to everyone who was warned or asked "Are you safe?". Also ends that incident's roll calls.
 * Idempotent per incident.
 */
export async function issueAllClear(db: Db, eventId: number, opts: MsgOpts): Promise<{ issued: boolean; sms: number; rollCallsClosed: number }> {
  return withTx(db, async (c) => {
    const e = (
      await c.query<{ id: number; kind: string; status: string; area_id: string | null; zone_label: string | null; title: string | null; demo: boolean; source: string }>(
        'SELECT id, kind, status, area_id, zone_label, title, demo, source FROM events WHERE id = $1 FOR UPDATE', [eventId],
      )
    ).rows[0];
    if (!e || e.kind === 'sos' || (e.status !== 'closed' && e.status !== 'false_alert')) return { issued: false, sms: 0, rollCallsClosed: 0 };
    const closed = await c.query(`UPDATE guest_checks SET closed_at = now(), closed_reason = 'all_clear' WHERE event_id = $1 AND closed_at IS NULL`, [eventId]);
    const warned = (await c.query<{ place: string | null }>(`SELECT place FROM tourist_alerts WHERE event_id = $1 AND level <> 'clear' ORDER BY id LIMIT 1`, [eventId])).rows[0];
    const already = (await c.query(`SELECT 1 FROM tourist_alerts WHERE event_id = $1 AND level = 'clear'`, [eventId])).rowCount;
    if (!warned || already || !e.area_id) return { issued: false, sms: 0, rollCallsClosed: closed.rowCount ?? 0 };

    const place = warned.place ?? e.zone_label ?? 'the area';
    const falseAlarm = e.status === 'false_alert';
    const simulated = e.source !== 'inference';
    await c.query(
      `INSERT INTO tourist_alerts (area_id, event_id, level, title_en, title_sw, body_en, body_sw, place, expires_at, demo)
       VALUES ($1,$2,'clear',$3,$4,$5,$6,$7, now() + interval '6 hours', $8)`,
      [e.area_id, eventId, `All clear near ${place}${simulated ? ' (simulated test)' : ''}`, `Hali ni shwari karibu na ${place}${simulated ? ' (jaribio)' : ''}`,
        falseAlarm
          ? 'Rangers checked and it was a false alarm. You can carry on with your plans. Keep following your guide.'
          : 'Rangers have checked the area. You can carry on with your plans. Keep following your guide and stay alert.',
        falseAlarm
          ? 'Askari wamekagua na haikuwa hatari. Unaweza kuendelea na mipango yako. Endelea kufuata maelekezo ya kiongozi wako.'
          : 'Askari wamekagua eneo. Unaweza kuendelea na mipango yako. Endelea kufuata maelekezo ya kiongozi wako na kuwa makini.',
        place, e.demo],
    );
    // SMS everyone who was messaged about this incident (warnings and roll calls).
    const recipients = (
      await c.query<{ recipient_alias: string; to_number: string; recipient_kind: string }>(
        `SELECT DISTINCT ON (recipient_alias) recipient_alias, to_number, recipient_kind FROM notification_jobs
          WHERE event_id = $1 AND recipient_kind IN ('tourist', 'lodge') AND to_number IS NOT NULL AND (kind LIKE 'alert%' OR kind LIKE 'rollcall-%')`,
        [eventId],
      )
    ).rows;
    const langs = new Map(
      (await c.query<{ id: number; language: string }>(
        `SELECT id, language FROM tourists WHERE id = ANY($1::bigint[])`,
        [recipients.filter((r) => r.recipient_alias.startsWith('tourist:')).map((r) => Number(r.recipient_alias.split(':')[1]))],
      )).rows.map((t) => [`tourist:${t.id}`, t.language]),
    );
    const tag = opts.testMode || simulated ? ' TEST' : '';
    const jobs: Job[] = recipients.map((r) => ({
      kind: 'all_clear', alias: r.recipient_alias, to: r.to_number, recipientKind: r.recipient_kind as Job['recipientKind'],
      body: langs.get(r.recipient_alias) === 'sw'
        ? `Safe Savannah${tag}: Hali ni shwari karibu na ${place}. Askari wamekagua. Endelea kufuata maelekezo ya kiongozi wako.`
        : r.recipient_kind === 'lodge'
          ? `Safe Savannah${tag}: All clear near ${place} (${eventRef(eventId)}). Rangers have resolved the incident. Guests have been told.`
          : `Safe Savannah${tag}: All clear near ${place}. Rangers have checked the area. Keep following your guide.`,
    }));
    await enqueue(c, eventId, jobs);
    await c.query(`INSERT INTO event_actions (event_id, actor, action, note) VALUES ($1, 'system:lodge', 'note', $2)`, [
      eventId, `All clear sent to travellers${jobs.length ? ` (${jobs.length} SMS)` : ''}${closed.rowCount ? `; ${closed.rowCount} roll call${closed.rowCount === 1 ? '' : 's'} ended` : ''}.`,
    ]);
    return { issued: true, sms: jobs.length, rollCallsClosed: closed.rowCount ?? 0 };
  });
}
