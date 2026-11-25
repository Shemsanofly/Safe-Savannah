// Guest requests: night escorts at a lodge, and activity check-ins ("I'm going on a walking safari until 17:00").
// Activity check-ins tell the risk engine who is really out on a trail right now.
import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { DomainError } from './events.js';

// ============================================================ escorts
export const ESCORT_DESTINATIONS = ['dining', 'reception', 'bar', 'room', 'other'] as const;
export const ESCORT_LABEL: Record<(typeof ESCORT_DESTINATIONS)[number], string> = {
  dining: 'Restaurant', reception: 'Reception', bar: 'Bar / fire pit', room: 'Their tent or room', other: 'Other',
};

export const EscortInputSchema = z
  .object({
    from_place: z.string().trim().min(1, 'Say where you are, for example "Tent 7"').max(60),
    to_key: z.enum(ESCORT_DESTINATIONS),
    to_text: z.string().trim().max(60).optional().nullable(),
    people: z.coerce.number().int().min(1).max(60).default(1),
    note: z.string().trim().max(200).optional().nullable(),
  })
  .refine((e) => e.to_key !== 'other' || !!e.to_text, { message: 'Say where you want to go', path: ['to_text'] });

export interface EscortRow {
  id: number; tourist_id: number; lodge_id: string; from_place: string; to_key: string; to_text: string | null; people: number; note: string | null;
  status: 'requested' | 'accepted' | 'done' | 'cancelled'; escort_name: string | null; accepted_at: Date | null; done_at: Date | null; created_at: Date;
}
const ESCORT_COLS = 'id, tourist_id, lodge_id, from_place, to_key, to_text, people, note, status, escort_name, accepted_at, done_at, created_at';
const num = <T extends { id: number }>(r: T): T => ({ ...r, id: Number(r.id) });

export async function requestEscort(
  db: Queryable, t: { id: number; lodge_id: string | null }, input: z.infer<typeof EscortInputSchema>,
): Promise<EscortRow> {
  if (!t.lodge_id) throw new DomainError(409, 'no_lodge', 'Escorts are arranged by your lodge. Check in with the QR code at reception first.');
  try {
    const r = await db.query<EscortRow>(
      `INSERT INTO escort_requests (tourist_id, lodge_id, from_place, to_key, to_text, people, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${ESCORT_COLS}`,
      [t.id, t.lodge_id, input.from_place, input.to_key, input.to_key === 'other' ? input.to_text : null, input.people, input.note || null],
    );
    return num(r.rows[0]!);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new DomainError(409, 'escort_open', 'You already have an escort request. Cancel it to make a new one.');
    throw err;
  }
}

export async function cancelEscort(db: Queryable, touristId: number, id: number): Promise<void> {
  const r = await db.query(`UPDATE escort_requests SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND tourist_id = $2 AND status IN ('requested','accepted')`, [id, touristId]);
  if (!r.rowCount) throw new DomainError(404, 'not_found', 'This request is no longer open.');
}

/** The traveller's open request, or one finished in the last hour. */
export async function touristEscort(db: Queryable, touristId: number): Promise<EscortRow | null> {
  const r = await db.query<EscortRow>(
    `SELECT ${ESCORT_COLS} FROM escort_requests WHERE tourist_id = $1
        AND (status IN ('requested','accepted') OR (status = 'done' AND done_at > now() - interval '1 hour'))
      ORDER BY created_at DESC LIMIT 1`,
    [touristId],
  );
  return r.rows[0] ? num(r.rows[0]) : null;
}

export async function lodgeEscorts(db: Queryable, lodgeId: string) {
  return (
    await db.query<EscortRow & { name: string; phone: string }>(
      `SELECT ${ESCORT_COLS.split(', ').map((c) => `e.${c}`).join(', ')}, t.name, t.phone
         FROM escort_requests e JOIN tourists t ON t.id = e.tourist_id
        WHERE e.lodge_id = $1 AND (e.status IN ('requested','accepted') OR e.done_at > now() - interval '3 hours')
        ORDER BY e.status = 'requested' DESC, e.status = 'accepted' DESC, e.created_at DESC LIMIT 20`,
      [lodgeId],
    )
  ).rows.map(num);
}

export async function acceptEscort(db: Queryable, lodgeId: string, id: number, op: { id: string; name: string }, escortName?: string | null): Promise<void> {
  const r = await db.query(
    `UPDATE escort_requests SET status = 'accepted', escort_name = $4, accepted_by = $3, accepted_at = COALESCE(accepted_at, now())
      WHERE id = $1 AND lodge_id = $2 AND status IN ('requested','accepted')`,
    [id, lodgeId, op.id, escortName?.trim() || op.name],
  );
  if (!r.rowCount) throw new DomainError(404, 'not_found', 'This request is no longer open.');
}

export async function finishEscort(db: Queryable, lodgeId: string, id: number): Promise<void> {
  const r = await db.query(`UPDATE escort_requests SET status = 'done', done_at = now() WHERE id = $1 AND lodge_id = $2 AND status IN ('requested','accepted')`, [id, lodgeId]);
  if (!r.rowCount) throw new DomainError(404, 'not_found', 'This request is no longer open.');
}

// ============================================================ activities
export const ACTIVITY_KINDS = ['game_drive', 'walking_safari', 'picnic', 'sundowner', 'other'] as const;
export const ACTIVITY_LABEL: Record<(typeof ACTIVITY_KINDS)[number], string> = {
  game_drive: 'game drive', walking_safari: 'walking safari', picnic: 'picnic', sundowner: 'sundowner', other: 'activity',
};
/** Overdue this long after the expected return time. */
export const OVERDUE_MINUTES = 30;
/** Places guests can go out to (properties themselves are not "out"). */
const OUTING_KINDS = ['trail', 'road', 'picnic', 'viewpoint', 'water', 'gate', 'other'];

export const ActivityInputSchema = z.object({
  kind: z.enum(ACTIVITY_KINDS),
  zone_id: z.coerce.number().int().positive(),
  people: z.coerce.number().int().min(1).max(60).optional(),
  starts_at: z.string().datetime({ offset: true }).optional(),
  ends_at: z.string().datetime({ offset: true }),
});

export interface ActivityRow {
  id: number; tourist_id: number; lodge_id: string | null; area_id: string; zone_id: number; kind: string; people: number;
  starts_at: Date; ends_at: Date; returned_at: Date | null; cancelled_at: Date | null; created_by: string; created_at: Date;
  zone_name?: string; status?: string;
}

export function activityStatus(a: Pick<ActivityRow, 'starts_at' | 'ends_at' | 'returned_at' | 'cancelled_at'>, now = Date.now()): 'cancelled' | 'returned' | 'planned' | 'out' | 'overdue' {
  if (a.cancelled_at) return 'cancelled';
  if (a.returned_at) return 'returned';
  if (new Date(a.starts_at).getTime() > now) return 'planned';
  return now > new Date(a.ends_at).getTime() + OVERDUE_MINUTES * 60_000 ? 'overdue' : 'out';
}
const withStatus = <T extends ActivityRow>(a: T) => ({ ...a, id: Number(a.id), zone_id: Number(a.zone_id), status: activityStatus(a) });

export async function activityPlaces(db: Queryable, areaId: string) {
  return (
    await db.query<{ id: number; name: string; kind: string }>(
      `SELECT id, name, kind FROM safety_zones WHERE area_id = $1 AND active AND kind = ANY($2::text[]) ORDER BY name`,
      [areaId, OUTING_KINDS],
    )
  ).rows.map((z) => ({ ...z, id: Number(z.id) }));
}

export async function startActivity(
  db: Queryable,
  args: { touristId: number; lodgeId: string | null; areaId: string; groupSize: number; createdBy: string; input: z.infer<typeof ActivityInputSchema> },
): Promise<ActivityRow> {
  const { input } = args;
  const zone = (await db.query<{ area_id: string; kind: string }>('SELECT area_id, kind FROM safety_zones WHERE id = $1 AND active', [input.zone_id])).rows[0];
  if (!zone || zone.area_id !== args.areaId || !OUTING_KINDS.includes(zone.kind)) throw new DomainError(400, 'unknown_place', 'Choose a place in your area');
  const starts = input.starts_at ? new Date(input.starts_at) : new Date();
  const ends = new Date(input.ends_at);
  if (ends.getTime() <= starts.getTime()) throw new DomainError(400, 'invalid_time', 'The return time must be after the start');
  if (ends.getTime() - starts.getTime() > 24 * 3_600_000) throw new DomainError(400, 'invalid_time', 'An activity can last at most 24 hours');
  if (starts.getTime() < Date.now() - 3_600_000 || starts.getTime() > Date.now() + 7 * 86_400_000) throw new DomainError(400, 'invalid_time', 'Choose a start time from now up to a week ahead');
  const live = await db.query(`SELECT 1 FROM guest_activities WHERE tourist_id = $1 AND returned_at IS NULL AND cancelled_at IS NULL AND ends_at > now() - interval '12 hours'`, [args.touristId]);
  if (live.rowCount) throw new DomainError(409, 'activity_open', 'You already have an activity checked in. Mark it as back first.');
  const r = await db.query<ActivityRow>(
    `INSERT INTO guest_activities (tourist_id, lodge_id, area_id, zone_id, kind, people, starts_at, ends_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [args.touristId, args.lodgeId, args.areaId, input.zone_id, input.kind, input.people ?? args.groupSize, starts, ends, args.createdBy],
  );
  return withStatus(r.rows[0]!);
}

/** Mark back (or cancel a planned one). Scope: the guest themselves, or the guest's lodge. */
export async function endActivity(db: Queryable, id: number, scope: { touristId?: number; lodgeId?: string }, how: 'returned' | 'cancelled' = 'returned'): Promise<void> {
  const r = await db.query(
    `UPDATE guest_activities SET ${how === 'returned' ? 'returned_at' : 'cancelled_at'} = now()
      WHERE id = $1 AND returned_at IS NULL AND cancelled_at IS NULL
        AND ($2::bigint IS NULL OR tourist_id = $2) AND ($3::text IS NULL OR lodge_id = $3)`,
    [id, scope.touristId ?? null, scope.lodgeId ?? null],
  );
  if (!r.rowCount) throw new DomainError(404, 'not_found', 'This activity is no longer open.');
}

/** Groups out in an area now (started, not back, at most 3 hours past their return time). Used by the risk engine and the map. */
export async function liveActivities(db: Queryable, areaId: string | null) {
  return (
    await db.query<ActivityRow & { zone_name: string; tourist_name: string; lodge_name: string | null }>(
      `SELECT a.*, z.name AS zone_name, t.name AS tourist_name, l.name AS lodge_name
         FROM guest_activities a JOIN safety_zones z ON z.id = a.zone_id JOIN tourists t ON t.id = a.tourist_id LEFT JOIN lodges l ON l.id = a.lodge_id
        WHERE ($1::text IS NULL OR a.area_id = $1) AND a.returned_at IS NULL AND a.cancelled_at IS NULL
          AND a.starts_at <= now() AND a.ends_at > now() - interval '3 hours'
        ORDER BY a.ends_at`,
      [areaId],
    )
  ).rows.map(withStatus);
}

export async function touristActivity(db: Queryable, touristId: number) {
  const r = await db.query<ActivityRow & { zone_name: string }>(
    `SELECT a.*, z.name AS zone_name FROM guest_activities a JOIN safety_zones z ON z.id = a.zone_id
      WHERE a.tourist_id = $1 AND a.cancelled_at IS NULL AND (a.returned_at IS NULL OR a.returned_at > now() - interval '1 hour')
      ORDER BY a.created_at DESC LIMIT 1`,
    [touristId],
  );
  return r.rows[0] ? withStatus(r.rows[0]) : null;
}

export async function lodgeActivities(db: Queryable, lodgeId: string) {
  return (
    await db.query<ActivityRow & { zone_name: string; name: string; phone: string }>(
      `SELECT a.*, z.name AS zone_name, t.name, t.phone
         FROM guest_activities a JOIN safety_zones z ON z.id = a.zone_id JOIN tourists t ON t.id = a.tourist_id
        WHERE a.lodge_id = $1 AND a.cancelled_at IS NULL
          AND ((a.returned_at IS NULL AND a.ends_at > now() - interval '12 hours') OR a.returned_at > now() - interval '3 hours')
        ORDER BY a.returned_at IS NOT NULL, a.ends_at`,
      [lodgeId],
    )
  ).rows.map(withStatus);
}
