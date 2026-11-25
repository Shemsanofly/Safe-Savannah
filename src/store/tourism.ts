// Lodge and tourism report: how many guests each partner lodge looked after, the wildlife alerts and
// roll calls they handled, how fast guests were accounted for, escorts, activities and guest SOS, plus
// the guest mix (languages, countries, areas) and tour groups. Admins see every lodge; a front desk its own.
import type { Queryable } from '../db/pool.js';
import { OVERDUE_MINUTES } from './guestPlans.js';

export interface TourismOpts { days: number; timeZone: string; lodgeId?: string | null }

const median = (col: string) => `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${col})`;

export async function tourismReport(db: Queryable, opts: TourismOpts) {
  const days = Math.max(1, Math.min(366, Math.round(opts.days)));
  const lodge = opts.lodgeId ?? null;
  const p = [days, opts.timeZone, lodge, OVERDUE_MINUTES];
  // $1 days · $2 time zone · $3 lodge (or all) · $4 overdue minutes
  const since = `now() - ($1::int * interval '1 day')`;
  const today = `(now() AT TIME ZONE $2)::date`;
  const [lodges, rollCalls, mix, tours, recent] = await Promise.all([
    db.query(
      `SELECT l.id, l.name, a.name AS area_name, z.name AS zone_name,
          -- guests and guest-nights (people × nights of their stay that fall in the period)
          (SELECT COALESCE(sum(t.group_size), 0)::int FROM tourists t WHERE t.lodge_id = l.id AND t.active AND ${today} BETWEEN t.trip_start AND t.trip_end) AS people_now,
          (SELECT count(*)::int FROM tourists t WHERE t.lodge_id = l.id AND t.trip_start > ${today} - $1::int AND t.trip_start <= ${today}) AS arrivals,
          (SELECT COALESCE(sum(t.group_size * GREATEST(0, LEAST(t.trip_end, ${today}) - GREATEST(t.trip_start, ${today} - $1::int))), 0)::int
             FROM tourists t WHERE t.lodge_id = l.id) AS guest_nights,
          -- wildlife at the property and in its park area
          (SELECT count(*)::int FROM events e WHERE e.kind = 'wildlife' AND e.safety_zone_id = l.zone_id AND e.opened_at > ${since}) AS alerts_at_lodge,
          (SELECT count(*)::int FROM events e WHERE e.kind = 'wildlife' AND e.area_id = l.area_id AND e.risk_level IN ('high','critical') AND e.opened_at > ${since}) AS alerts_area,
          -- roll calls: how many, guests asked, accounted for (safe or asked for help), time until everyone answered
          (SELECT count(*)::int FROM guest_checks c WHERE c.lodge_id = l.id AND c.started_at > ${since}) AS roll_calls,
          (SELECT count(*)::int FROM guest_check_responses r JOIN guest_checks c ON c.id = r.check_id WHERE c.lodge_id = l.id AND c.started_at > ${since}) AS asked,
          (SELECT count(*)::int FROM guest_check_responses r JOIN guest_checks c ON c.id = r.check_id WHERE c.lodge_id = l.id AND c.started_at > ${since} AND r.status <> 'pending') AS accounted,
          (SELECT count(*)::int FROM guest_check_responses r JOIN guest_checks c ON c.id = r.check_id WHERE c.lodge_id = l.id AND c.started_at > ${since} AND r.status = 'help') AS needed_help,
          (SELECT ${median('EXTRACT(EPOCH FROM c.completed_at - c.started_at)')} FROM guest_checks c WHERE c.lodge_id = l.id AND c.started_at > ${since} AND c.completed_at IS NOT NULL) AS median_all_answered_s,
          -- guest requests
          (SELECT count(*)::int FROM escort_requests x WHERE x.lodge_id = l.id AND x.created_at > ${since}) AS escorts,
          (SELECT ${median('EXTRACT(EPOCH FROM x.accepted_at - x.created_at)')} FROM escort_requests x WHERE x.lodge_id = l.id AND x.created_at > ${since} AND x.accepted_at IS NOT NULL) AS median_escort_accept_s,
          (SELECT count(*)::int FROM guest_activities g WHERE g.lodge_id = l.id AND g.cancelled_at IS NULL AND g.created_at > ${since}) AS activities,
          (SELECT count(*)::int FROM guest_activities g WHERE g.lodge_id = l.id AND g.cancelled_at IS NULL AND g.created_at > ${since}
              AND COALESCE(g.returned_at, now()) > g.ends_at + ($4::int * interval '1 minute')) AS activities_late,
          -- guest SOS and how fast a ranger responded
          (SELECT count(*)::int FROM events e JOIN tourists t ON t.id = e.tourist_id WHERE e.kind = 'sos' AND t.lodge_id = l.id AND e.opened_at > ${since}) AS sos,
          (SELECT ${median('EXTRACT(EPOCH FROM e.acknowledged_at - e.opened_at)')} FROM events e JOIN tourists t ON t.id = e.tourist_id
             WHERE e.kind = 'sos' AND t.lodge_id = l.id AND e.opened_at > ${since} AND e.acknowledged_at IS NOT NULL) AS median_sos_response_s
         FROM lodges l JOIN areas a ON a.id = l.area_id LEFT JOIN safety_zones z ON z.id = l.zone_id
        WHERE l.active AND ($3::text IS NULL OR l.id = $3)
        ORDER BY l.name`,
      p,
    ),
    db.query(
      `SELECT c.id, c.lodge_id, l.name AS lodge_name, c.reason, c.started_at, c.completed_at, c.closed_at, c.closed_reason, c.started_by = 'system' AS automatic, c.demo,
              count(r.*)::int AS asked, count(r.*) FILTER (WHERE r.status = 'safe')::int AS safe, count(r.*) FILTER (WHERE r.status = 'help')::int AS help,
              count(r.*) FILTER (WHERE r.channel = 'sms')::int AS by_sms, count(r.*) FILTER (WHERE r.channel = 'host')::int AS by_desk
         FROM guest_checks c JOIN lodges l ON l.id = c.lodge_id LEFT JOIN guest_check_responses r ON r.check_id = c.id
        WHERE c.started_at > ${since} AND ($2::text IS NULL OR c.lodge_id = $2)
        GROUP BY c.id, l.name ORDER BY c.started_at DESC LIMIT 12`,
      [days, lodge],
    ),
    // Guest mix: travellers whose stay overlaps the period (at this lodge, or anywhere for admins).
    db.query(
      `WITH g AS (
         SELECT t.* FROM tourists t WHERE t.trip_end >= ${today} - $1::int AND t.trip_start <= ${today} AND ($3::text IS NULL OR t.lodge_id = $3)
       )
       SELECT 'language' AS dim, language AS key, count(*)::int AS n, sum(group_size)::int AS people FROM g GROUP BY language
       UNION ALL SELECT 'nationality', COALESCE(NULLIF(nationality, ''), 'Not given'), count(*)::int, sum(group_size)::int FROM g GROUP BY 2
       UNION ALL SELECT 'area', a.name, count(*)::int, sum(g.group_size)::int FROM g JOIN areas a ON a.id = g.area_id GROUP BY a.name
       UNION ALL SELECT 'activity', ga.kind, count(*)::int, sum(ga.people)::int FROM guest_activities ga
                  WHERE ga.cancelled_at IS NULL AND ga.created_at > ${since} AND ($3::text IS NULL OR ga.lodge_id = $3) GROUP BY ga.kind`,
      [days, opts.timeZone, lodge],
    ),
    // Tour operators' groups (park-wide; a lodge sees groups its own guests were in).
    db.query(
      `SELECT o.name AS operator, count(*)::int AS groups,
              count(*) FILTER (WHERE g.entered_at IS NOT NULL)::int AS entered,
              count(*) FILTER (WHERE g.entry_method = 'face')::int AS by_face,
              count(*) FILTER (WHERE g.entry_method = 'credentials')::int AS by_badge,
              count(*) FILTER (WHERE g.entry_method = 'manual')::int AS by_radio,
              COALESCE(sum(g.declared_count), 0)::int AS declared,
              count(*) FILTER (WHERE g.status = 'back' AND g.returned_at > g.ends_at + ($4::int * interval '1 minute'))::int AS late
         FROM tour_groups g JOIN tour_operators o ON o.id = g.tour_operator_id
        WHERE g.day > ${today} - $1::int AND g.day <= ${today} AND g.status <> 'cancelled'
          AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM tour_group_members m JOIN tourists t ON t.id = m.tourist_id WHERE m.group_id = g.id AND t.lodge_id = $3))
        GROUP BY o.name ORDER BY groups DESC`,
      p,
    ),
    db.query(`SELECT to_char(${today} - $1::int + 1, 'YYYY-MM-DD') AS from_day, to_char(${today}, 'YYYY-MM-DD') AS to_day`, [days, opts.timeZone]),
  ]);
  const num = (v: unknown) => (v == null ? null : Number(v));
  const lodgeRows = lodges.rows.map((l) => ({
    ...l,
    accounted_pct: l.asked ? Math.round((l.accounted / l.asked) * 100) : null,
    median_all_answered_s: num(l.median_all_answered_s), median_escort_accept_s: num(l.median_escort_accept_s), median_sos_response_s: num(l.median_sos_response_s),
  }));
  const sum = (k: string) => lodgeRows.reduce((a, l) => a + (Number(l[k]) || 0), 0);
  const asked = sum('asked');
  const groupMix = (dim: string) => mix.rows.filter((r) => r.dim === dim).map(({ key, n, people }) => ({ key, n, people })).sort((a, b) => b.people - a.people);
  return {
    days, lodgeId: lodge, ...recent.rows[0],
    totals: {
      lodges: lodgeRows.length, people_now: sum('people_now'), arrivals: sum('arrivals'), guest_nights: sum('guest_nights'),
      alerts_at_lodge: sum('alerts_at_lodge'), roll_calls: sum('roll_calls'), asked, accounted: sum('accounted'),
      accounted_pct: asked ? Math.round((sum('accounted') / asked) * 100) : null, needed_help: sum('needed_help'),
      escorts: sum('escorts'), activities: sum('activities'), activities_late: sum('activities_late'), sos: sum('sos'),
    },
    lodges: lodgeRows,
    rollCalls: rollCalls.rows.map((c) => ({ ...c, id: Number(c.id), all_answered_s: c.completed_at ? (new Date(c.completed_at).getTime() - new Date(c.started_at).getTime()) / 1000 : null })),
    mix: { language: groupMix('language'), nationality: groupMix('nationality').slice(0, 8), area: groupMix('area'), activity: groupMix('activity') },
    tours: tours.rows,
  };
}

/** One row per lodge, for spreadsheets. */
export function tourismCsvRows(r: Awaited<ReturnType<typeof tourismReport>>) {
  const header = ['Lodge', 'Area', 'Guests now (people)', 'Arrivals', 'Guest-nights', 'Wildlife alerts at lodge', 'High/critical alerts in area',
    'Roll calls', 'Guests asked', 'Accounted for', 'Accounted %', 'Needed help', 'Median time until all answered (s)',
    'Night escorts', 'Median time to accept escort (s)', 'Activities', 'Activities late', 'Guest SOS', 'Median SOS response (s)'];
  const round = (v: number | null) => (v == null ? '' : Math.round(v));
  const rows = r.lodges.map((l: Record<string, any>) => [l.name, l.area_name, l.people_now, l.arrivals, l.guest_nights, l.alerts_at_lodge, l.alerts_area, l.roll_calls, l.asked, l.accounted,
    l.accounted_pct ?? '', l.needed_help, round(l.median_all_answered_s), l.escorts, round(l.median_escort_accept_s), l.activities, l.activities_late, l.sos, round(l.median_sos_response_s)]);
  return { header, rows };
}
