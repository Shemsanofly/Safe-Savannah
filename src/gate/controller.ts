import { createHash, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { withTx, type Db, type Queryable } from '../db/pool.js';
import { DomainError } from '../store/events.js';

export interface GateCommand {
  id: string; challenge_id: string; attempt_id: number; zone_id: number; staff_id: string;
  actor_id: string; profile_version: string; tourist_count: number; mode: 'simulated' | 'http';
  status: string; not_after: Date; close_after: Date | null;
}
export interface GateTransport { pulse(command: GateCommand, cfg: AppConfig): Promise<void>; }
export const httpGateTransport: GateTransport = {
  async pulse(command, cfg) {
    const response = await fetch(cfg.GATE_CONTROLLER_URL!, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2500),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.GATE_CONTROLLER_TOKEN}`, 'Idempotency-Key': command.id },
      body: JSON.stringify({ requestId: command.id, gateId: cfg.GATE_CONTROLLER_GATE_ID, action: 'pulse_open',
        pulseMs: cfg.GATE_PULSE_MS, guideId: command.staff_id, touristCount: command.tourist_count, expiresAt: command.not_after.toISOString() }),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('controller_unconfirmed'); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 4096) { await reader.cancel(); throw new Error('controller_unconfirmed'); }
      chunks.push(chunk.value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const reply = JSON.parse(text) as { accepted?: boolean; requestId?: string };
    if (reply.accepted !== true || reply.requestId !== command.id) throw new Error('controller_unconfirmed');
  },
};

export function controllerAuthenticated(header: string | undefined, cfg: AppConfig): boolean {
  if (cfg.GATE_CONTROLLER_MODE !== 'http' || !cfg.GATE_CONTROLLER_TOKEN || !header?.startsWith('Bearer ')) return false;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(header.slice(7)), hash(cfg.GATE_CONTROLLER_TOKEN));
}

export async function expireSimulatedCycles(db: Queryable, zoneId: number): Promise<void> {
  await db.query("UPDATE gate_open_commands SET status = 'closed', closed_at = close_after WHERE zone_id = $1 AND mode = 'simulated' AND status = 'open' AND close_after <= clock_timestamp()", [zoneId]);
  // A crashed process never retries a possibly delivered pulse.
  await db.query("UPDATE gate_open_commands SET status = 'unknown', error_code = 'dispatch_interrupted' WHERE zone_id = $1 AND status IN ('reserved','sending') AND not_after < clock_timestamp()", [zoneId]);
}

export async function verifyCurrentAuthorization(c: Queryable, command: Pick<GateCommand, 'staff_id' | 'zone_id' | 'profile_version' | 'actor_id'>, allowDemoPhoto = false) {
  const staff = (await c.query<{ active: boolean }>('SELECT active FROM operators WHERE id = $1 FOR SHARE', [command.staff_id])).rows[0];
  const actor = (await c.query<{ active: boolean }>('SELECT active FROM operators WHERE id = $1 FOR SHARE', [command.actor_id])).rows[0];
  const zone = (await c.query<{ active: boolean }>('SELECT active FROM safety_zones WHERE id = $1 FOR SHARE', [command.zone_id])).rows[0];
  const profile = (await c.query("SELECT staff_id FROM staff_face_profiles WHERE staff_id = $1 AND version = $2 AND active AND (enrollment_kind IN ('live','reference_photo') OR $3) FOR SHARE", [command.staff_id, command.profile_version, allowDemoPhoto])).rowCount;
  const permission = (await c.query(`SELECT staff_id FROM staff_gate_permissions WHERE staff_id = $1 AND zone_id = $2 AND active
    AND (expires_at IS NULL OR expires_at > clock_timestamp()) FOR SHARE`, [command.staff_id, command.zone_id])).rowCount;
  if (!staff?.active || !actor?.active || !zone?.active || !profile || !permission) throw new DomainError(403, 'face_access_revoked', 'Guide access is no longer valid. The gate remains closed.');
}

export async function gateState(db: Db, cfg: AppConfig, zoneId: number) {
  await expireSimulatedCycles(db, zoneId);
  const last = (await db.query(`SELECT id, status, staff_id, tourist_count, mode, accepted_at, opened_at, closed_at, close_after, error_code
    FROM gate_open_commands WHERE zone_id = $1 ORDER BY created_at DESC LIMIT 1`, [zoneId])).rows[0] ?? null;
  const physical = (await db.query('SELECT state, safety_ready, updated_at FROM gate_controller_state WHERE zone_id = $1', [zoneId])).rows[0];
  const fresh = physical?.updated_at instanceof Date && Date.now() - physical.updated_at.getTime() <= 10000;
  return { mode: cfg.GATE_CONTROLLER_MODE, lastCommand: last,
    state: cfg.GATE_CONTROLLER_MODE === 'simulated' ? last?.status === 'open' ? 'open' : last && ['reserved', 'sending', 'accepted', 'unknown'].includes(last.status) ? 'unknown' : 'closed'
      : !fresh ? 'unknown' : physical.state === 'closed' && last && ['reserved', 'sending', 'accepted', 'unknown'].includes(last.status) ? 'unknown' : physical.state,
    safetyReady: cfg.GATE_CONTROLLER_MODE === 'simulated' || !!(fresh && physical.safety_ready),
  };
}

/** Mark sending durably before I/O. Retrying this method never resends a command. */
export async function dispatchGate(db: Db, cfg: AppConfig, commandId: string, transport: GateTransport) {
  const command = (await db.query<GateCommand>(`UPDATE gate_open_commands SET status = 'sending'
    WHERE id = $1 AND status = 'reserved' AND not_after > clock_timestamp() RETURNING *`, [commandId])).rows[0];
  if (!command) return;
  try {
    await withTx(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('physical-gate:' || $1::text, 0))", [command.zone_id]);
      await verifyCurrentAuthorization(c, command, cfg.GATE_CONTROLLER_MODE === 'simulated');
      if (cfg.GATE_CONTROLLER_MODE === 'simulated') {
        await c.query("UPDATE gate_open_commands SET status = 'open', accepted_at = now(), opened_at = now(), close_after = now() + interval '8 seconds' WHERE id = $1", [command.id]);
        return;
      }
      if (command.zone_id !== cfg.GATE_CONTROLLER_ZONE_ID || command.actor_id !== cfg.GATE_STATION_OPERATOR_ID) throw new DomainError(403, 'wrong_station', 'This station is not configured to operate that gate.');
      const physical = (await c.query<{ state: string; safety_ready: boolean; fresh: boolean }>(`SELECT state, safety_ready,
        updated_at > clock_timestamp() - interval '10 seconds' AS fresh FROM gate_controller_state WHERE zone_id = $1`, [command.zone_id])).rows[0];
      const live = (await c.query(`SELECT id FROM face_gate_challenges WHERE id = $1 AND trusted_liveness_at > clock_timestamp() - interval '5 seconds'`, [command.challenge_id])).rowCount;
      if (!physical?.fresh || physical.state !== 'closed' || !physical.safety_ready || !live || command.not_after.getTime() <= Date.now()) {
        throw new DomainError(409, 'controller_not_ready', 'The gate controller or liveness sensor is not ready. No opening command was sent.');
      }
      await transport.pulse(command, cfg);
      // Accepted is not proof of physical movement. Only the authenticated sensor callback can report open/closed.
      await c.query("UPDATE gate_open_commands SET status = CASE WHEN status = 'sending' THEN 'accepted' ELSE status END, accepted_at = now() WHERE id = $1", [command.id]);
    });
  } catch (error) {
    const safeFailure = error instanceof DomainError;
    await db.query("UPDATE gate_open_commands SET status = $2, error_code = $3 WHERE id = $1 AND status IN ('reserved','sending','accepted')",
      [command.id, safeFailure ? 'failed' : 'unknown', safeFailure ? 'authorization_or_sensor_not_ready' : 'controller_unconfirmed']);
  }
}

export async function controllerEvent(db: Db, cfg: AppConfig, input: { gateId: string; requestId?: string; state: 'closed' | 'open' | 'fault'; safetyReady: boolean; observedAt: string }) {
  if (input.gateId !== cfg.GATE_CONTROLLER_GATE_ID) throw new DomainError(403, 'wrong_gate', 'Wrong gate identifier.');
  const age = Date.now() - Date.parse(input.observedAt);
  if (age < -2000 || age > 5000) throw new DomainError(400, 'stale_gate_event', 'The controller observation is stale.');
  await withTx(db, async (c) => {
    const applied = await c.query(`INSERT INTO gate_controller_state (zone_id,state,safety_ready,observed_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT (zone_id) DO UPDATE SET state = EXCLUDED.state, safety_ready = EXCLUDED.safety_ready,
      observed_at = EXCLUDED.observed_at, updated_at = now() WHERE EXCLUDED.observed_at >= gate_controller_state.observed_at RETURNING zone_id`,
      [cfg.GATE_CONTROLLER_ZONE_ID, input.state, input.safetyReady, input.observedAt]);
    if (!applied.rowCount) throw new DomainError(409, 'out_of_order_event', 'A newer controller observation is already recorded.');
    if (input.requestId) {
      const command = (await c.query<GateCommand>('SELECT * FROM gate_open_commands WHERE id = $1 AND zone_id = $2 AND mode = $3 FOR UPDATE', [input.requestId, cfg.GATE_CONTROLLER_ZONE_ID, 'http'])).rows[0];
      if (!command || ['reserved', 'failed'].includes(command.status) || (command.status === 'closed' && input.state !== 'closed')) throw new DomainError(409, 'invalid_gate_event', 'This command cannot accept that event.');
      await c.query(`UPDATE gate_open_commands SET status = $2,
        opened_at = CASE WHEN $2 = 'open' THEN COALESCE(opened_at,now()) ELSE opened_at END,
        closed_at = CASE WHEN $2 = 'closed' THEN COALESCE(closed_at,now()) ELSE closed_at END WHERE id = $1`,
        [command.id, input.state === 'fault' ? 'unknown' : input.state]);
    }
  });
}
