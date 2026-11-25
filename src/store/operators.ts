import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { withTx, type Db, type Queryable } from '../db/pool.js';
import { DomainError } from './events.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * ranger: field staff · admin: manages the system · host: lodge front desk (sees only their own lodge) ·
 * agency: a tour operator's office · guide: a tour guide (both see only their tour operator's groups).
 */
export type Role = 'ranger' | 'admin' | 'host' | 'agency' | 'guide';
export const ROLES: readonly Role[] = ['ranger', 'admin', 'host', 'agency', 'guide'];
/** Roles limited to one partner's screen (no ranger data). */
export const PARTNER_ROLES: readonly Role[] = ['host', 'agency', 'guide'];

export interface Operator {
  id: string;
  name: string;
  role: Role;
  active: boolean;
}

export interface SessionOperator extends Operator {
  sessions_valid_after: Date;
}

export interface OperatorRow extends Operator {
  created_at: Date;
  updated_at: Date;
  phone?: string | null;
  area_id?: string | null;
  on_duty?: boolean;
  demo?: boolean;
  lodge_id?: string | null;
  tour_operator_id?: string | null;
}

export const OPERATOR_ID_RE = /^[a-z0-9_-]{2,32}$/i;
export const PIN_RE = /^\d{4,12}$/;

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pin, salt, 32);
  return ['scrypt', salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(pin, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

function validateId(id: string): void {
  if (!OPERATOR_ID_RE.test(id)) throw new DomainError(400, 'invalid_operator_id', 'Operator ID: 2–32 letters, digits, _ or -');
}
function validatePin(pin: string): void {
  if (!PIN_RE.test(pin)) throw new DomainError(400, 'invalid_pin', 'PIN must be 4–12 digits');
}
function validateName(name: string): string {
  const n = name.trim();
  if (n.length < 2 || n.length > 60) throw new DomainError(400, 'invalid_name', 'Name must be 2–60 characters');
  return n;
}

/** CLI helper: create or update an operator (re-activates and resets the PIN). */
export async function upsertOperator(db: Queryable, op: { id: string; name: string; pin: string; role?: Role }): Promise<void> {
  validateId(op.id);
  validatePin(op.pin);
  const name = validateName(op.name);
  await db.query(
    `INSERT INTO operators (id, name, pin_hash, role) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, pin_hash = EXCLUDED.pin_hash, active = true,
       role = COALESCE($5, operators.role), updated_at = now(), sessions_valid_after = now()`,
    [op.id, name, await hashPin(op.pin), op.role ?? 'ranger', op.role ?? null],
  );
}

export async function countActiveAdmins(db: Queryable): Promise<number> {
  const r = await db.query<{ n: string }>(`SELECT count(*) AS n FROM operators WHERE active AND role = 'admin'`);
  return Number(r.rows[0]?.n ?? 0);
}

// Used for unknown ids so a failed login costs the same scrypt work either way.
let dummyHash: Promise<string> | null = null;

export async function authenticate(db: Queryable, id: string, pin: string): Promise<Operator | null> {
  const r = await db.query<Operator & { pin_hash: string }>('SELECT id, name, role, active, pin_hash FROM operators WHERE id = $1', [id]);
  const row = r.rows[0];
  dummyHash ??= hashPin('000000');
  const ok = await verifyPin(pin, row?.pin_hash ?? (await dummyHash));
  if (!row || !row.active || !ok) return null;
  return { id: row.id, name: row.name, role: row.role, active: row.active };
}

export async function getOperator(db: Queryable, id: string): Promise<Operator | null> {
  const r = await db.query<Operator>('SELECT id, name, role, active FROM operators WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

/** Operator plus the cutoff before which their sessions are no longer valid. */
export async function getSessionOperator(db: Queryable, id: string): Promise<SessionOperator | null> {
  const r = await db.query<SessionOperator>('SELECT id, name, role, active, sessions_valid_after FROM operators WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

export async function listOperators(db: Queryable): Promise<OperatorRow[]> {
  const r = await db.query<OperatorRow>('SELECT id, name, role, active, created_at, updated_at, phone, area_id, on_duty, demo, lodge_id, tour_operator_id FROM operators ORDER BY active DESC, role, name');
  return r.rows;
}

export async function createOperator(db: Queryable, op: { id: string; name: string; pin: string; role: Role; lodge_id?: string | null; tour_operator_id?: string | null }): Promise<OperatorRow> {
  validateId(op.id);
  validatePin(op.pin);
  const name = validateName(op.name);
  if (op.role === 'host' && !op.lodge_id) throw new DomainError(400, 'lodge_required', 'Choose the lodge this front-desk account works at');
  const touring = op.role === 'agency' || op.role === 'guide';
  if (touring && !op.tour_operator_id) throw new DomainError(400, 'tour_operator_required', 'Choose the tour operator this account works for');
  if (touring && !(await db.query('SELECT 1 FROM tour_operators WHERE id = $1 AND active', [op.tour_operator_id])).rowCount) {
    throw new DomainError(400, 'unknown_tour_operator', 'Unknown tour operator');
  }
  const r = await db.query<OperatorRow>(
    `INSERT INTO operators (id, name, pin_hash, role, lodge_id, tour_operator_id) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, name, role, active, created_at, updated_at, lodge_id, tour_operator_id`,
    [op.id, name, await hashPin(op.pin), op.role, op.role === 'host' ? op.lodge_id : null, touring ? op.tour_operator_id : null],
  );
  if (!r.rows[0]) throw new DomainError(409, 'operator_exists', `Operator ID "${op.id}" is already taken`);
  return r.rows[0];
}

/**
 * Change name, role or active flag. Refuses changes that would leave nobody able
 * to manage operators, and refuses an admin deactivating or demoting themselves.
 */
export async function updateOperator(
  db: Db,
  actorId: string,
  id: string,
  patch: { name?: string; role?: Role; active?: boolean },
): Promise<OperatorRow> {
  return withTx(db, async (c) => {
    // Serialize admin changes so two concurrent demotions cannot both pass the guard.
    await c.query('SELECT pg_advisory_xact_lock(727275)');
    const cur = (await c.query<OperatorRow>('SELECT id, name, role, active, created_at, updated_at, lodge_id, tour_operator_id FROM operators WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new DomainError(404, 'not_found', 'Operator not found');
    const next = {
      name: patch.name !== undefined ? validateName(patch.name) : cur.name,
      role: patch.role ?? cur.role,
      active: patch.active ?? cur.active,
    };
    if (id === actorId && (!next.active || next.role !== 'admin')) {
      throw new DomainError(409, 'self_lockout', 'You cannot deactivate or demote your own account');
    }
    if (next.role === 'host' && !cur.lodge_id) throw new DomainError(400, 'lodge_required', 'Choose a lodge before making this a front-desk account');
    if ((next.role === 'agency' || next.role === 'guide') && !cur.tour_operator_id) {
      throw new DomainError(400, 'tour_operator_required', 'Choose a tour operator before making this a tour operator or guide account');
    }
    const losingAdmin = cur.role === 'admin' && cur.active && (next.role !== 'admin' || !next.active);
    if (losingAdmin && (await countActiveAdmins(c)) <= 1) {
      throw new DomainError(409, 'last_admin', 'At least one active admin is required');
    }
    const r = await c.query<OperatorRow>(
      `UPDATE operators SET name = $2, role = $3, active = $4, updated_at = now(),
              sessions_valid_after = CASE WHEN $5 THEN now() ELSE sessions_valid_after END
        WHERE id = $1
       RETURNING id, name, role, active, created_at, updated_at`,
      [id, next.name, next.role, next.active, next.role !== cur.role || next.active !== cur.active],
    );
    return r.rows[0]!;
  });
}

export async function setOperatorPin(db: Queryable, id: string, pin: string): Promise<void> {
  validatePin(pin);
  const r = await db.query('UPDATE operators SET pin_hash = $2, updated_at = now(), sessions_valid_after = now() WHERE id = $1', [
    id,
    await hashPin(pin),
  ]);
  if (!r.rowCount) throw new DomainError(404, 'not_found', 'Operator not found');
}

/** Contact and duty details used for alert routing (phone, home area, on duty). */
export async function setOperatorContact(
  db: Queryable,
  id: string,
  patch: { phone?: string | null; area_id?: string | null; on_duty?: boolean; lodge_id?: string | null; tour_operator_id?: string | null },
): Promise<void> {
  if (patch.lodge_id && !(await db.query('SELECT 1 FROM lodges WHERE id = $1', [patch.lodge_id])).rowCount) throw new DomainError(400, 'unknown_lodge', 'Unknown lodge');
  if (patch.tour_operator_id && !(await db.query('SELECT 1 FROM tour_operators WHERE id = $1', [patch.tour_operator_id])).rowCount) {
    throw new DomainError(400, 'unknown_tour_operator', 'Unknown tour operator');
  }
  const r = await db.query(
    `UPDATE operators SET phone = CASE WHEN $2 THEN $3 ELSE phone END, area_id = CASE WHEN $4 THEN $5 ELSE area_id END,
            on_duty = COALESCE($6, on_duty), lodge_id = CASE WHEN $7 THEN $8 ELSE lodge_id END,
            tour_operator_id = CASE WHEN $9 THEN $10 ELSE tour_operator_id END, updated_at = now() WHERE id = $1`,
    [id, patch.phone !== undefined, patch.phone ?? null, patch.area_id !== undefined, patch.area_id ?? null, patch.on_duty ?? null,
      patch.lodge_id !== undefined, patch.lodge_id ?? null, patch.tour_operator_id !== undefined, patch.tour_operator_id ?? null],
  );
  if (!r.rowCount) throw new DomainError(404, 'not_found', 'Operator not found');
}
