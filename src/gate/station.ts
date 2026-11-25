import type { AppConfig } from '../config.js';
import { withTx, type Db } from '../db/pool.js';
import { DomainError } from '../store/events.js';

export async function getGateStation(db: Db, cfg: AppConfig) {
  let zoneId = cfg.GATE_CONTROLLER_MODE === 'http' ? cfg.GATE_CONTROLLER_ZONE_ID : undefined;
  if (!zoneId) {
    const saved = (await db.query<{ value: unknown }>("SELECT value FROM app_flags WHERE key = 'gate_station'")).rows[0];
    if (saved) {
      try {
        const config: unknown = typeof saved.value === 'string' ? JSON.parse(saved.value) : saved.value;
        const id = config && typeof config === 'object' ? (config as { zoneId?: unknown }).zoneId : undefined;
        if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) zoneId = id;
      } catch { /* unconfigured */ }
    }
  }
  const zone = zoneId ? (await db.query(`SELECT z.id,z.name,a.name AS area_name FROM safety_zones z JOIN areas a ON a.id=z.area_id WHERE z.id=$1 AND z.active`, [zoneId])).rows[0] ?? null : null;
  return { zone, configured: !!zone, hardwareBound: cfg.GATE_CONTROLLER_MODE === 'http' };
}
export async function configureGateStation(db: Db, cfg: AppConfig, actorId: string, zoneId: number) {
  if (cfg.GATE_CONTROLLER_MODE === 'http' && cfg.GATE_CONTROLLER_ZONE_ID !== zoneId) throw new DomainError(409, 'hardware_gate_fixed', 'The physical controller is bound to another gate. Update its server configuration first.');
  await withTx(db, async (c) => {
    const actor = (await c.query<{ role: string; active: boolean }>('SELECT role,active FROM operators WHERE id=$1 FOR SHARE', [actorId])).rows[0];
    if (!actor?.active || actor.role !== 'admin') throw new DomainError(403, 'forbidden', 'Only an admin may choose the gate station.');
    if (!(await c.query('SELECT id FROM safety_zones WHERE id=$1 AND active FOR SHARE', [zoneId])).rowCount) throw new DomainError(400, 'zone_unavailable', 'Choose an active gate location.');
    await c.query("INSERT INTO app_flags (key,value) VALUES ('gate_station',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()", [JSON.stringify({ zoneId })]);
    await c.query('INSERT INTO gate_station_audit (zone_id,actor_id) VALUES ($1,$2)', [zoneId, actorId]);
    await c.query("UPDATE face_gate_challenges SET phase='denied' WHERE zone_id<>$1 AND phase IN ('approach','turn','return')", [zoneId]);
  });
}
