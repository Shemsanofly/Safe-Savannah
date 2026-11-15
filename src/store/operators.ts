import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Queryable } from '../db/pool.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export interface Operator {
  id: string;
  name: string;
  active: boolean;
}

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

export async function upsertOperator(db: Queryable, op: { id: string; name: string; pin: string }): Promise<void> {
  if (!/^[a-z0-9_-]{2,32}$/i.test(op.id)) throw new Error('operator id: 2-32 letters, digits, _ or -');
  if (!/^\d{4,12}$/.test(op.pin)) throw new Error('PIN must be 4-12 digits');
  await db.query(
    `INSERT INTO operators (id, name, pin_hash) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, pin_hash = EXCLUDED.pin_hash, active = true`,
    [op.id, op.name, await hashPin(op.pin)],
  );
}

// Used for unknown ids so a failed login costs the same scrypt work either way.
let dummyHash: Promise<string> | null = null;

export async function authenticate(db: Queryable, id: string, pin: string): Promise<Operator | null> {
  const r = await db.query<Operator & { pin_hash: string }>('SELECT id, name, active, pin_hash FROM operators WHERE id = $1', [id]);
  const row = r.rows[0];
  dummyHash ??= hashPin('000000');
  const ok = await verifyPin(pin, row?.pin_hash ?? (await dummyHash));
  if (!row || !row.active || !ok) return null;
  return { id: row.id, name: row.name, active: row.active };
}

export async function getOperator(db: Queryable, id: string): Promise<Operator | null> {
  const r = await db.query<Operator>('SELECT id, name, active FROM operators WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}
