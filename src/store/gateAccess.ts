import { withTx, type Db, type Queryable } from '../db/pool.js';
import { DomainError } from './events.js';
import { authenticate } from './operators.js';

export interface GateAttempt {
  id: number;
  zone_id: number;
  claimed_staff_id: string;
  staff_id: string | null;
  checked_by: string;
  decision: 'allowed' | 'denied';
  reason: 'authorized' | 'invalid_credentials' | 'no_permission' | 'identity_unconfirmed';
  identity_confirmed: boolean;
  created_at: Date;
  reviewed_at: Date | null;
}

async function activeZone(db: Queryable, zoneId: number, requireActive = true): Promise<void> {
  const r = await db.query('SELECT id FROM safety_zones WHERE id = $1 AND (active OR NOT $2) FOR SHARE', [zoneId, requireActive]);
  if (!r.rowCount) throw new DomainError(404, 'zone_unavailable', 'This zone is unavailable. Keep entry closed and contact an admin.');
}

export async function setGatePermission(db: Db, actorId: string, input: {
  staffId: string; zoneId: number; active: boolean; expiresAt: string | null;
}): Promise<void> {
  await withTx(db, async (c) => {
    const actor = (await c.query<{ active: boolean; role: string }>('SELECT active, role FROM operators WHERE id = $1 FOR SHARE', [actorId])).rows[0];
    if (!actor?.active || actor.role !== 'admin') throw new DomainError(403, 'forbidden', 'Only an active admin may change gate permissions.');
    await activeZone(c, input.zoneId, input.active);
    const staff = (await c.query<{ active: boolean }>('SELECT active FROM operators WHERE id = $1 FOR SHARE', [input.staffId])).rows[0];
    if (!staff || (input.active && !staff.active)) throw new DomainError(400, 'staff_unavailable', 'Choose an active staff account.');
    if (input.active && input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
      throw new DomainError(400, 'invalid_expiry', 'Access must expire in the future.');
    }
    await c.query(
      `INSERT INTO staff_gate_permissions (staff_id, zone_id, active, expires_at, updated_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (staff_id, zone_id) DO UPDATE
       SET active = EXCLUDED.active, expires_at = EXCLUDED.expires_at, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [input.staffId, input.zoneId, input.active, input.expiresAt, actorId],
    );
    await c.query('INSERT INTO gate_permission_audit (staff_id, zone_id, active, expires_at, actor_id) VALUES ($1,$2,$3,$4,$5)',
      [input.staffId, input.zoneId, input.active, input.expiresAt, actorId]);
  });
}

/** A guard's visual check plus credentials and a current explicit grant. No facial recognition or barrier command. */
export async function checkGateAccess(db: Db, actorId: string, input: {
  staffId: string; pin: string; zoneId: number; identityConfirmed: boolean;
}): Promise<GateAttempt> {
  return withTx(db, async (c) => {
    // Persistent limits survive restarts; locks prevent concurrent requests bypassing them.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('gate-guard:' || $1, 0))", [actorId]);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('gate-subject:' || $1, 0))", [input.staffId]);
    const actor = (await c.query<{ active: boolean }>('SELECT active FROM operators WHERE id = $1 FOR SHARE', [actorId])).rows[0];
    if (!actor?.active) throw new DomainError(403, 'forbidden', 'An active gate attendant account is required.');
    const limits = (await c.query<{ guard_count: string; failures: string }>(
      `SELECT
       (SELECT count(*) FROM gate_access_attempts WHERE checked_by = $1 AND created_at > now() - interval '1 minute') AS guard_count,
       (SELECT count(*) FROM gate_access_attempts WHERE claimed_staff_id = $2 AND reason = 'invalid_credentials'
        AND created_at > now() - interval '15 minutes') AS failures`, [actorId, input.staffId],
    )).rows[0]!;
    if (Number(limits.guard_count) >= 30) {
      throw new DomainError(429, 'gate_rate_limit', 'Too many checks at this station. Keep entry closed and retry after one minute.');
    }
    if (input.staffId && Number(limits.failures) >= 5) {
      throw new DomainError(429, 'gate_rate_limit', 'Too many checks. Keep entry closed and contact an admin; retry after 15 minutes.');
    }
    await activeZone(c, input.zoneId);
    // Prevent deactivation/PIN changes during this authorization decision.
    await c.query('SELECT id FROM operators WHERE id = $1 FOR SHARE', [input.staffId]);
    const staff = await authenticate(c, input.staffId, input.pin);
    const grant = staff ? await c.query(
      `SELECT staff_id FROM staff_gate_permissions WHERE staff_id = $1 AND zone_id = $2 AND active
       AND (expires_at IS NULL OR expires_at > clock_timestamp()) FOR SHARE`, [staff.id, input.zoneId],
    ) : null;
    const reason: GateAttempt['reason'] = !staff ? 'invalid_credentials' : !grant?.rowCount ? 'no_permission'
      : !input.identityConfirmed ? 'identity_unconfirmed' : 'authorized';
    const decision = reason === 'authorized' ? 'allowed' : 'denied';
    const r = await c.query<GateAttempt>(
      `INSERT INTO gate_access_attempts (zone_id, claimed_staff_id, staff_id, checked_by, decision, reason, identity_confirmed)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.zoneId, input.staffId, staff?.id ?? null, actorId, decision, reason, input.identityConfirmed],
    );
    return r.rows[0]!;
  });
}

export async function gateOverview(db: Db, admin: boolean, pendingOnly: boolean) {
  const zones = (await db.query(`SELECT z.id, z.name, a.name AS area_name FROM safety_zones z JOIN areas a ON a.id = z.area_id
    WHERE z.active ORDER BY a.name, z.name`)).rows;
  const attempts = admin ? (await db.query(`SELECT g.*, z.name AS zone_name, o.name AS staff_name, c.name AS checked_by_name,
    cmd.status AS gate_command_status, cmd.mode AS gate_command_mode
    FROM gate_access_attempts g JOIN safety_zones z ON z.id = g.zone_id LEFT JOIN operators o ON o.id = g.staff_id
    JOIN operators c ON c.id = g.checked_by
    LEFT JOIN gate_open_commands cmd ON cmd.attempt_id = g.id
    ${pendingOnly ? "WHERE g.decision = 'denied' AND g.reviewed_at IS NULL" : ''}
    ORDER BY g.created_at DESC, g.id DESC LIMIT 50`)).rows : [];
  const pending = admin ? Number((await db.query("SELECT count(*) AS n FROM gate_access_attempts WHERE decision = 'denied' AND reviewed_at IS NULL")).rows[0].n) : 0;
  const permissions = admin ? (await db.query(`SELECT p.*, o.name AS staff_name, o.active AS staff_active, z.name AS zone_name,
    (p.active AND o.active AND z.active AND (p.expires_at IS NULL OR p.expires_at > now())) AS effective
    FROM staff_gate_permissions p JOIN operators o ON o.id = p.staff_id JOIN safety_zones z ON z.id = p.zone_id
    ORDER BY p.active DESC, o.name, z.name`)).rows : [];
  const staff = admin ? (await db.query('SELECT id, name, demo FROM operators WHERE active ORDER BY name')).rows : [];
  return { zones, attempts, pending, permissions, staff, serverTime: new Date().toISOString() };
}

export async function reviewGateAttempt(db: Db, id: number, actorId: string, note: string): Promise<void> {
  const r = await db.query(`UPDATE gate_access_attempts SET reviewed_by = $2, reviewed_at = now(), review_note = $3
    WHERE id = $1 AND decision = 'denied' AND reviewed_at IS NULL RETURNING id`, [id, actorId, note]);
  if (!r.rowCount) throw new DomainError(409, 'review_unavailable', 'This denial was already reviewed or cannot be reviewed. Refresh the list.');
}
