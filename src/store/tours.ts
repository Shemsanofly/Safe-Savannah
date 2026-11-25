// Tour operators, guides and tour groups. A group is planned by a tour operator for a day, with a guide
// and registered travellers. When the guide is verified at an attraction gate (or radios in), the group
// is "in the park" there: its travellers are checked out on the activity, so the risk engine, the ranger
// map and their lodges know people are out, and the tour operator sees where their guests are.
import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { DomainError } from './events.js';
import { ACTIVITY_KINDS, OVERDUE_MINUTES, activityPlaces } from './guestPlans.js';
import { normalizePhone } from './platform.js';

export const TOUR_OPERATOR_ID_RE = /^[a-z0-9-]{2,40}$/;

export const TourOperatorInputSchema = z.object({
  id: z.string().trim().toLowerCase().regex(TOUR_OPERATOR_ID_RE, 'Use 2–40 lowercase letters, numbers or dashes'),
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().max(20).optional().nullable(),
});

export const GroupInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  guide_id: z.string().trim().min(2).max(32).nullable().optional(),
  area_id: z.string().trim().min(1),
  zone_id: z.coerce.number().int().positive().nullable().optional(),
  kind: z.enum(ACTIVITY_KINDS),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date'),
  back_by: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Choose a time'),
  members: z.array(z.string().trim().min(6).max(20)).max(60).default([]),
});

/** Who a console request may see: a tour operator's office, a guide (own groups), or an admin. */
export interface TourScope { operatorId: string | null; guideId: string | null; }

export async function scopeFor(db: Queryable, op: { id: string; role: string }, requestedOperator?: string | null): Promise<TourScope> {
  if (op.role === 'admin') return { operatorId: requestedOperator || null, guideId: null };
  const row = (await db.query<{ tour_operator_id: string | null }>('SELECT tour_operator_id FROM operators WHERE id = $1', [op.id])).rows[0];
  if (!row?.tour_operator_id) throw new DomainError(403, 'forbidden', 'This account is not linked to a tour operator.');
  return op.role === 'guide' ? { operatorId: row.tour_operator_id, guideId: op.id } : { operatorId: row.tour_operator_id, guideId: null };
}

export async function listTourOperators(db: Queryable) {
  return (
    await db.query(
      `SELECT o.*, (SELECT count(*)::int FROM operators g WHERE g.tour_operator_id = o.id AND g.role = 'guide' AND g.active) AS guides,
              (SELECT count(*)::int FROM operators g WHERE g.tour_operator_id = o.id AND g.role = 'agency' AND g.active) AS desks,
              (SELECT count(*)::int FROM tour_groups t WHERE t.tour_operator_id = o.id AND t.status <> 'cancelled' AND t.day > current_date - 30) AS groups_30d
         FROM tour_operators o ORDER BY o.active DESC, o.name`,
    )
  ).rows;
}

export async function createTourOperator(db: Queryable, input: z.infer<typeof TourOperatorInputSchema>) {
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (input.phone && !phone) throw new DomainError(400, 'invalid_phone', 'Enter the phone number with its country code');
  const r = await db.query(`INSERT INTO tour_operators (id, name, phone) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING RETURNING *`, [input.id, input.name, phone]);
  if (!r.rowCount) throw new DomainError(409, 'exists', 'A tour operator with this ID already exists');
  return r.rows[0];
}

interface GroupRow {
  id: number; tour_operator_id: string; name: string; guide_id: string | null; area_id: string; zone_id: number | null; kind: string;
  day: string; ends_at: Date; status: 'planned' | 'in_park' | 'back' | 'cancelled'; entered_at: Date | null; entry_zone_id: number | null;
  entry_method: string | null; declared_count: number | null; returned_at: Date | null; created_at: Date; demo: boolean;
}

const GROUP_SELECT = `SELECT g.id, g.tour_operator_id, g.name, g.guide_id, g.area_id, g.zone_id, g.kind, to_char(g.day, 'YYYY-MM-DD') AS day, g.ends_at,
    g.status, g.entered_at, g.entry_zone_id, g.entry_method, g.declared_count, g.returned_at, g.created_at, g.demo,
    o.name AS operator_name, a.name AS area_name, gd.name AS guide_name, gd.phone AS guide_phone,
    z.name AS zone_name, ez.name AS entry_zone_name
  FROM tour_groups g JOIN tour_operators o ON o.id = g.tour_operator_id JOIN areas a ON a.id = g.area_id
  LEFT JOIN operators gd ON gd.id = g.guide_id LEFT JOIN safety_zones z ON z.id = g.zone_id LEFT JOIN safety_zones ez ON ez.id = g.entry_zone_id`;

/** "overdue" = in the park more than 30 minutes past the time they should be out. */
export function groupState(g: Pick<GroupRow, 'status' | 'ends_at'>, now = Date.now()): GroupRow['status'] | 'overdue' {
  if (g.status === 'in_park' && now > new Date(g.ends_at).getTime() + OVERDUE_MINUTES * 60_000) return 'overdue';
  return g.status;
}

async function membersOf(db: Queryable, groupIds: number[]) {
  if (!groupIds.length) return new Map<number, unknown[]>();
  const r = await db.query(
    `SELECT m.group_id, t.id, t.name, t.phone, t.language, t.group_size, t.nationality, l.name AS lodge_name,
            (SELECT e.id FROM events e WHERE e.tourist_id = t.id AND e.kind = 'sos' AND e.status IN ('open','acknowledged') ORDER BY e.opened_at DESC LIMIT 1) AS open_sos_id,
            (SELECT r.status FROM guest_check_responses r JOIN guest_checks c ON c.id = r.check_id
              WHERE r.tourist_id = t.id AND c.closed_at IS NULL ORDER BY c.started_at DESC LIMIT 1) AS roll_call
       FROM tour_group_members m JOIN tourists t ON t.id = m.tourist_id LEFT JOIN lodges l ON l.id = t.lodge_id
      WHERE m.group_id = ANY($1::bigint[]) AND m.left_at IS NULL ORDER BY t.name`,
    [groupIds],
  );
  const by = new Map<number, unknown[]>();
  for (const row of r.rows) {
    const list = by.get(Number(row.group_id)) ?? [];
    list.push({ id: Number(row.id), name: row.name, phone: row.phone, language: row.language, group_size: row.group_size, nationality: row.nationality,
      lodge_name: row.lodge_name, open_sos_id: row.open_sos_id ? Number(row.open_sos_id) : null, roll_call: row.roll_call });
    by.set(Number(row.group_id), list);
  }
  return by;
}

const shapeGroup = (g: GroupRow & Record<string, unknown>, members: unknown[]) => ({
  ...g, id: Number(g.id), zone_id: g.zone_id == null ? null : Number(g.zone_id), entry_zone_id: g.entry_zone_id == null ? null : Number(g.entry_zone_id),
  state: groupState(g), members,
});

/** The tour operator console: groups from two days ago to two weeks ahead (and any still in the park). */
export async function toursConsole(db: Queryable, scope: TourScope, timeZone: string) {
  const groups = (
    await db.query<GroupRow & Record<string, unknown>>(
      `${GROUP_SELECT}
        WHERE ($1::text IS NULL OR g.tour_operator_id = $1) AND ($2::text IS NULL OR g.guide_id = $2)
          AND (g.status = 'in_park' OR g.day BETWEEN (now() AT TIME ZONE $3)::date - 2 AND (now() AT TIME ZONE $3)::date + 14)
        ORDER BY g.day, g.status = 'cancelled', g.ends_at`,
      [scope.operatorId, scope.guideId, timeZone],
    )
  ).rows;
  const members = await membersOf(db, groups.map((g) => Number(g.id)));
  const shaped = groups.map((g) => shapeGroup(g, members.get(Number(g.id)) ?? []));
  // Open wildlife incidents where a group is in the park now (same zone first, then same area).
  const live = shaped.filter((g) => g.status === 'in_park');
  const alerts = live.length
    ? (
        await db.query(
          `SELECT e.id, e.title, e.risk_level, e.status, e.opened_at, e.area_id, e.safety_zone_id, z.name AS zone_name
             FROM events e LEFT JOIN safety_zones z ON z.id = e.safety_zone_id
            WHERE e.kind = 'wildlife' AND e.status IN ('open','acknowledged') AND e.area_id = ANY($1::text[])
            ORDER BY e.opened_at DESC LIMIT 30`,
          [[...new Set(live.map((g) => g.area_id))]],
        )
      ).rows.map((e) => ({
        ...e, id: Number(e.id), safety_zone_id: e.safety_zone_id == null ? null : Number(e.safety_zone_id),
        groups: live.filter((g) => g.area_id === e.area_id).map((g) => ({ id: g.id, name: g.name, same_zone: g.entry_zone_id === Number(e.safety_zone_id) })),
      }))
    : [];
  const operators = scope.operatorId
    ? (await db.query('SELECT id, name, phone FROM tour_operators WHERE id = $1', [scope.operatorId])).rows
    : (await db.query('SELECT id, name, phone FROM tour_operators WHERE active ORDER BY name')).rows;
  const guides = (
    await db.query(
      `SELECT o.id, o.name, o.phone, o.tour_operator_id,
              (SELECT array_agg(p.zone_id) FROM staff_gate_permissions p WHERE p.staff_id = o.id AND p.active AND (p.expires_at IS NULL OR p.expires_at > now())) AS gate_zones,
              (SELECT array_agg(z.name ORDER BY z.name) FROM staff_gate_permissions p JOIN safety_zones z ON z.id = p.zone_id
                WHERE p.staff_id = o.id AND p.active AND (p.expires_at IS NULL OR p.expires_at > now())) AS gate_zone_names,
              EXISTS (SELECT 1 FROM staff_face_profiles f WHERE f.staff_id = o.id AND f.active) AS face_enrolled
         FROM operators o WHERE o.active AND o.role = 'guide' AND ($1::text IS NULL OR o.tour_operator_id = $1) ORDER BY o.name`,
      [scope.operatorId],
    )
  ).rows.map((g) => ({ ...g, gate_zones: (g.gate_zones ?? []).map(Number), gate_zone_names: g.gate_zone_names ?? [] }));
  const areas = (await db.query('SELECT id, name FROM areas ORDER BY name')).rows;
  const places: Record<string, unknown[]> = {};
  for (const a of areas) places[a.id] = await activityPlaces(db, a.id);
  const today = (await db.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [timeZone])).rows[0]!.d;
  return { today, operators, groups: shaped, alerts, guides, areas, places, canPlan: !scope.guideId };
}

async function loadGroup(db: Queryable, id: number, scope: TourScope, lock = false) {
  const g = (
    await db.query<GroupRow>(
      `SELECT * FROM tour_groups WHERE id = $1 AND ($2::text IS NULL OR tour_operator_id = $2) AND ($3::text IS NULL OR guide_id = $3)${lock ? ' FOR UPDATE' : ''}`,
      [id, scope.operatorId, scope.guideId],
    )
  ).rows[0];
  if (!g) throw new DomainError(404, 'not_found', 'Tour group not found');
  return g;
}

async function touristsByPhone(db: Queryable, phones: string[]) {
  const found: { id: number; phone: string }[] = [];
  const missing: string[] = [];
  for (const raw of phones) {
    const phone = normalizePhone(raw);
    const t = phone ? (await db.query<{ id: string }>('SELECT id FROM tourists WHERE phone = $1 AND active', [phone])).rows[0] : null;
    if (t) found.push({ id: Number(t.id), phone: phone! });
    else missing.push(raw);
  }
  return { found, missing };
}

export async function createGroup(db: Queryable, scope: TourScope, actor: string, input: z.infer<typeof GroupInputSchema>, timeZone: string) {
  if (scope.guideId) throw new DomainError(403, 'forbidden', 'Only the tour operator’s office plans groups.');
  const operatorId = scope.operatorId;
  if (!operatorId) throw new DomainError(400, 'operator_required', 'Choose a tour operator');
  if (!(await db.query('SELECT 1 FROM areas WHERE id = $1', [input.area_id])).rowCount) throw new DomainError(400, 'unknown_area', 'Choose a park area');
  if (input.zone_id) {
    const z1 = (await db.query('SELECT area_id FROM safety_zones WHERE id = $1 AND active', [input.zone_id])).rows[0];
    if (!z1 || z1.area_id !== input.area_id) throw new DomainError(400, 'unknown_place', 'Choose a place in that park area');
  }
  if (input.guide_id) {
    const g = (await db.query(`SELECT 1 FROM operators WHERE id = $1 AND active AND role = 'guide' AND tour_operator_id = $2`, [input.guide_id, operatorId])).rowCount;
    if (!g) throw new DomainError(400, 'unknown_guide', 'Choose one of your guides');
  }
  const days = (await db.query<{ diff: number }>(`SELECT ($1::date - (now() AT TIME ZONE $2)::date) AS diff`, [input.day, timeZone])).rows[0]!.diff;
  if (days < 0 || days > 60) throw new DomainError(400, 'invalid_day', 'Choose a date from today up to 60 days ahead');
  const { found, missing } = await touristsByPhone(db, [...new Set(input.members)]);
  const g = (
    await db.query<{ id: string }>(
      `INSERT INTO tour_groups (tour_operator_id, name, guide_id, area_id, zone_id, kind, day, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,($7::date + $8::time) AT TIME ZONE $9,$10) RETURNING id`,
      [operatorId, input.name, input.guide_id || null, input.area_id, input.zone_id || null, input.kind, input.day, input.back_by, timeZone, actor],
    )
  ).rows[0]!;
  for (const t of found) await db.query('INSERT INTO tour_group_members (group_id, tourist_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g.id, t.id]);
  return { id: Number(g.id), added: found.length, missing };
}

export async function addMember(db: Queryable, scope: TourScope, groupId: number, phoneRaw: string) {
  const g = await loadGroup(db, groupId, scope);
  if (g.status === 'back' || g.status === 'cancelled') throw new DomainError(409, 'group_closed', 'This group has finished.');
  const { found } = await touristsByPhone(db, [phoneRaw]);
  if (!found.length) throw new DomainError(404, 'no_traveller', 'No traveller has registered with that number. Ask them to sign up in the Safe Savannah app first.');
  await db.query(
    `INSERT INTO tour_group_members (group_id, tourist_id) VALUES ($1,$2)
     ON CONFLICT (group_id, tourist_id) DO UPDATE SET left_at = NULL, added_at = now()`,
    [groupId, found[0]!.id],
  );
}

export async function removeMember(db: Queryable, scope: TourScope, groupId: number, touristId: number) {
  await loadGroup(db, groupId, scope);
  await db.query('DELETE FROM tour_group_members WHERE group_id = $1 AND tourist_id = $2', [groupId, touristId]);
}

/**
 * Put a group "in the park" at a zone and check its travellers out on the activity. Travellers who
 * already have an open activity keep it. Extra people declared at the gate are added to the first row.
 */
async function enterPark(
  db: Queryable,
  g: GroupRow,
  entry: { zoneId: number; method: 'face' | 'credentials' | 'manual'; attemptId: number | null; declared: number | null; actor: string },
) {
  const zone = (await db.query<{ area_id: string }>('SELECT area_id FROM safety_zones WHERE id = $1', [entry.zoneId])).rows[0];
  if (!zone) throw new DomainError(400, 'unknown_place', 'Unknown place');
  await db.query(
    `UPDATE tour_groups SET status = 'in_park', entered_at = now(), entry_zone_id = $2, entry_method = $3, entry_attempt_id = $4, declared_count = $5
      WHERE id = $1`,
    [g.id, entry.zoneId, entry.method, entry.attemptId, entry.declared],
  );
  const members = (
    await db.query<{ id: string; lodge_id: string | null }>(
      `SELECT t.id, t.lodge_id FROM tour_group_members m JOIN tourists t ON t.id = m.tourist_id
        WHERE m.group_id = $1 AND m.left_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM guest_activities a WHERE a.tourist_id = t.id AND a.returned_at IS NULL AND a.cancelled_at IS NULL
                          AND a.ends_at > now() - interval '12 hours')
        ORDER BY t.id`,
      [g.id],
    )
  ).rows;
  const memberCount = Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM tour_group_members WHERE group_id = $1 AND left_at IS NULL', [g.id])).rows[0]!.n);
  const extra = Math.max(0, (entry.declared ?? 0) - memberCount);
  const endsAt = new Date(g.ends_at).getTime() > Date.now() + 15 * 60_000 ? new Date(g.ends_at) : new Date(Date.now() + 3 * 3_600_000);
  const insert = (touristId: number | null, lodgeId: string | null, people: number) =>
    db.query(
      `INSERT INTO guest_activities (tourist_id, lodge_id, area_id, zone_id, kind, people, ends_at, created_by, tour_group_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [touristId, lodgeId, zone.area_id, entry.zoneId, g.kind, Math.min(60, people), endsAt, entry.actor, g.id],
    );
  if (members.length) {
    for (const [i, m] of members.entries()) await insert(Number(m.id), m.lodge_id, 1 + (i === 0 ? extra : 0));
  } else if (extra > 0 || memberCount === 0) {
    await insert(null, null, Math.max(1, entry.declared ?? 1));
  }
}

/**
 * Called inside the gate transaction after a guide is allowed through. Finds the guide's group for
 * today and records the entry. Returns a short summary for the gate screen, or null.
 */
export async function recordGuideEntry(
  db: Queryable,
  e: { staffId: string; zoneId: number; attemptId: number; declared: number; method: 'face' | 'credentials'; timeZone: string },
) {
  await db.query('SAVEPOINT tour_entry');
  try {
    const g = (
      await db.query<GroupRow>(
        `SELECT * FROM tour_groups WHERE guide_id = $1 AND status = 'planned' AND day = (now() AT TIME ZONE $2)::date
          ORDER BY (zone_id = $3) DESC NULLS LAST, ends_at LIMIT 1 FOR UPDATE`,
        [e.staffId, e.timeZone, e.zoneId],
      )
    ).rows[0];
    if (!g) {
      await db.query('RELEASE SAVEPOINT tour_entry');
      return null;
    }
    await enterPark(db, g, { zoneId: e.zoneId, method: e.method, attemptId: e.attemptId, declared: e.declared, actor: `gate:${e.staffId}` });
    const registered = Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM tour_group_members WHERE group_id = $1 AND left_at IS NULL', [g.id])).rows[0]!.n);
    const operator = (await db.query<{ name: string }>('SELECT name FROM tour_operators WHERE id = $1', [g.tour_operator_id])).rows[0];
    await db.query('RELEASE SAVEPOINT tour_entry');
    return { id: Number(g.id), name: g.name, operator: operator?.name ?? '', registered, declared: e.declared };
  } catch {
    // Never let the tour record block a verified gate entry.
    await db.query('ROLLBACK TO SAVEPOINT tour_entry');
    await db.query('RELEASE SAVEPOINT tour_entry');
    return null;
  }
}

/** The guide radios in from a gate with no camera, or the office records the entry. */
export async function markEntered(db: Queryable, scope: TourScope, groupId: number, input: { zone_id: number; declared?: number | null }, actor: string) {
  const g = await loadGroup(db, groupId, scope, true);
  if (g.status !== 'planned') throw new DomainError(409, 'not_planned', g.status === 'in_park' ? 'This group is already in the park.' : 'This group has finished.');
  const zone = (await db.query('SELECT area_id FROM safety_zones WHERE id = $1 AND active', [input.zone_id])).rows[0];
  if (!zone || zone.area_id !== g.area_id) throw new DomainError(400, 'unknown_place', 'Choose a place in the group’s park area');
  await enterPark(db, g, { zoneId: input.zone_id, method: 'manual', attemptId: null, declared: input.declared ?? null, actor });
}

export async function finishGroup(db: Queryable, scope: TourScope, groupId: number, how: 'back' | 'cancelled') {
  const g = await loadGroup(db, groupId, scope, true);
  if (how === 'back' && g.status !== 'in_park') throw new DomainError(409, 'not_in_park', 'Only a group in the park can be marked back.');
  if (how === 'cancelled' && g.status !== 'planned') throw new DomainError(409, 'not_planned', 'Only a planned group can be cancelled.');
  await db.query(`UPDATE tour_groups SET status = $2, returned_at = CASE WHEN $2 = 'back' THEN now() ELSE returned_at END WHERE id = $1`, [groupId, how]);
  if (how === 'back') {
    await db.query(`UPDATE guest_activities SET returned_at = now() WHERE tour_group_id = $1 AND returned_at IS NULL AND cancelled_at IS NULL`, [groupId]);
  }
}

/** The traveller's group today (planned or in the park), or one that came back in the last two hours. */
export async function touristTourGroup(db: Queryable, touristId: number, timeZone: string) {
  const g = (
    await db.query<GroupRow & Record<string, unknown>>(
      `${GROUP_SELECT} JOIN tour_group_members m ON m.group_id = g.id AND m.tourist_id = $1 AND m.left_at IS NULL
        WHERE (g.status IN ('planned','in_park') AND g.day >= (now() AT TIME ZONE $2)::date - 1)
           OR (g.status = 'back' AND g.returned_at > now() - interval '2 hours')
        ORDER BY g.status = 'in_park' DESC, g.day, g.ends_at LIMIT 1`,
      [touristId, timeZone],
    )
  ).rows[0];
  if (!g) return null;
  return {
    id: Number(g.id), name: g.name, operator_name: g.operator_name, guide_name: g.guide_name ?? null, guide_phone: g.guide_phone ?? null,
    kind: g.kind, day: g.day, ends_at: g.ends_at, status: g.status, state: groupState(g),
    place: (g.entry_zone_name ?? g.zone_name ?? g.area_name) as string,
  };
}

export async function leaveGroup(db: Queryable, touristId: number, groupId: number) {
  const r = await db.query('UPDATE tour_group_members SET left_at = now() WHERE group_id = $1 AND tourist_id = $2 AND left_at IS NULL', [groupId, touristId]);
  if (!r.rowCount) throw new DomainError(404, 'not_found', 'You are not in this group.');
}

/** Tour groups in the park in an area now (for rangers: who to call). */
export async function groupsInArea(db: Queryable, areaId: string | null) {
  const rows = (
    await db.query<GroupRow & Record<string, unknown>>(`${GROUP_SELECT} WHERE g.status = 'in_park' AND ($1::text IS NULL OR g.area_id = $1) ORDER BY g.entered_at`, [areaId])
  ).rows;
  const members = await membersOf(db, rows.map((g) => Number(g.id)));
  return rows.map((g) => ({
    id: Number(g.id), name: g.name, operator_name: g.operator_name, guide_name: g.guide_name, guide_phone: g.guide_phone,
    entry_zone_id: g.entry_zone_id == null ? null : Number(g.entry_zone_id), entry_zone_name: g.entry_zone_name, kind: g.kind,
    people: Math.max(g.declared_count ?? 0, (members.get(Number(g.id)) ?? []).length), ends_at: g.ends_at, state: groupState(g),
  }));
}

/** Header status for tour operator and guide accounts (polled). */
export async function tourPulse(db: Queryable, scope: TourScope, timeZone: string) {
  const r = (
    await db.query(
      `WITH g AS (
         SELECT * FROM tour_groups WHERE ($1::text IS NULL OR tour_operator_id = $1) AND ($2::text IS NULL OR guide_id = $2)
            AND (status = 'in_park' OR (status = 'planned' AND day = (now() AT TIME ZONE $3)::date))
       ), m AS (
         SELECT DISTINCT tm.tourist_id FROM tour_group_members tm JOIN g ON g.id = tm.group_id WHERE tm.left_at IS NULL
       )
       SELECT (SELECT count(*)::int FROM g WHERE status = 'in_park') AS in_park,
              (SELECT count(*)::int FROM g WHERE status = 'planned') AS planned,
              (SELECT count(*)::int FROM g WHERE status = 'in_park' AND now() > ends_at + ($4::int * interval '1 minute')) AS overdue,
              (SELECT count(*)::int FROM events e WHERE e.kind = 'wildlife' AND e.status IN ('open','acknowledged')
                  AND e.area_id IN (SELECT area_id FROM g WHERE status = 'in_park')) AS alerts,
              (SELECT count(*)::int FROM events e WHERE e.kind = 'sos' AND e.status IN ('open','acknowledged') AND e.tourist_id IN (SELECT tourist_id FROM m)) AS sos_open`,
      [scope.operatorId, scope.guideId, timeZone, OVERDUE_MINUTES],
    )
  ).rows[0];
  return { serverTime: new Date().toISOString(), inPark: r.in_park, planned: r.planned, overdue: r.overdue, alerts: r.alerts, sosOpen: r.sos_open };
}
