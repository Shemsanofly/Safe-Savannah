import { z } from 'zod';
import { withTx, type Db, type DbClient, type Queryable } from '../db/pool.js';
import { eventRef } from '../domain/eventRef.js';
import { haversineM, isValidPolygon, type LatLng } from '../domain/geo.js';
import { assessRisk, speciesProfile, type RiskLevel, type ZoneInput } from '../domain/risk.js';
import { DomainError, type EventRow } from './events.js';
import { hashPin, verifyPin } from './operators.js';
import { enqueue, type Job } from './outboxJobs.js';
import { rollCallReasons, rollCallsForIncident, touristChecks } from './hospitality.js';
import { alertContent, catalog, LANGS, speciesName } from '../domain/i18n.js';
import { ACTIVITY_LABEL, liveActivities, touristActivity, touristEscort } from './guestPlans.js';

// ============================================================ places
export interface AreaRow { id: string; name: string; region: string; center_lat: number; center_lng: number; zoom: number }
export interface ZoneRow {
  id: number; area_id: string; name: string; kind: string; sensitivity: 'high' | 'medium' | 'low';
  occupancy: 'always' | 'daytime' | 'night' | 'rarely'; buffer_m: number; geometry: LatLng[]; active: boolean; notes: string | null;
  created_by: string | null; created_at: Date; updated_at: Date;
}
export interface CameraGeoRow {
  id: string; label: string; lat: number | null; lng: number | null; area_id: string | null; station_kind: string; description: string | null;
  last_frame_at: Date | null; worker_seen_at: Date | null; connection_state: string; detector: string;
}

export const listAreas = async (db: Queryable) => (await db.query<AreaRow>('SELECT * FROM areas ORDER BY name')).rows;

export async function listZones(db: Queryable, opts: { areaId?: string; includeInactive?: boolean } = {}): Promise<ZoneRow[]> {
  const r = await db.query<ZoneRow>(
    `SELECT * FROM safety_zones WHERE ($1::text IS NULL OR area_id = $1) AND ($2 OR active) ORDER BY area_id, name`,
    [opts.areaId ?? null, !!opts.includeInactive],
  );
  return r.rows;
}

export const ZoneInputSchema = z.object({
  area_id: z.string().min(1).max(40),
  name: z.string().trim().min(2).max(80),
  kind: z.enum(['lodge', 'camp', 'picnic', 'trail', 'road', 'gate', 'viewpoint', 'water', 'other']),
  sensitivity: z.enum(['high', 'medium', 'low']),
  occupancy: z.enum(['always', 'daytime', 'night', 'rarely']),
  buffer_m: z.coerce.number().int().min(0).max(5000),
  geometry: z.array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])).min(3).max(200),
  notes: z.string().trim().max(300).optional().nullable(),
  active: z.boolean().optional(),
});

export async function createZone(db: Queryable, actor: string, input: z.infer<typeof ZoneInputSchema>): Promise<ZoneRow> {
  if (!isValidPolygon(input.geometry)) throw new DomainError(400, 'invalid_geometry', 'A zone needs at least 3 valid points');
  await assertArea(db, input.area_id);
  const r = await db.query<ZoneRow>(
    `INSERT INTO safety_zones (area_id, name, kind, sensitivity, occupancy, buffer_m, geometry, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [input.area_id, input.name, input.kind, input.sensitivity, input.occupancy, input.buffer_m, JSON.stringify(input.geometry), input.notes ?? null, actor],
  );
  return r.rows[0]!;
}

export async function updateZone(db: Queryable, id: number, patch: Partial<z.infer<typeof ZoneInputSchema>>): Promise<ZoneRow> {
  const cur = (await db.query<ZoneRow>('SELECT * FROM safety_zones WHERE id = $1', [id])).rows[0];
  if (!cur) throw new DomainError(404, 'not_found', 'Safety zone not found');
  const next = { ...cur, ...patch };
  if (!isValidPolygon(next.geometry)) throw new DomainError(400, 'invalid_geometry', 'A zone needs at least 3 valid points');
  if (patch.area_id) await assertArea(db, patch.area_id);
  const r = await db.query<ZoneRow>(
    `UPDATE safety_zones SET area_id=$2, name=$3, kind=$4, sensitivity=$5, occupancy=$6, buffer_m=$7, geometry=$8, notes=$9, active=$10, updated_at=now()
      WHERE id = $1 RETURNING *`,
    [id, next.area_id, next.name, next.kind, next.sensitivity, next.occupancy, next.buffer_m, JSON.stringify(next.geometry), next.notes ?? null, next.active],
  );
  return r.rows[0]!;
}

async function assertArea(db: Queryable, id: string) {
  if (!(await db.query('SELECT 1 FROM areas WHERE id = $1', [id])).rowCount) throw new DomainError(400, 'unknown_area', `Unknown area "${id}"`);
}

export async function listCameras(db: Queryable): Promise<CameraGeoRow[]> {
  return (
    await db.query<CameraGeoRow>(
      `SELECT id, label, lat, lng, area_id, station_kind, description, last_frame_at, worker_seen_at, connection_state, detector FROM cameras ORDER BY id`,
    )
  ).rows;
}

export const CameraInputSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{2,40}$/),
  label: z.string().trim().min(2).max(80),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  area_id: z.string().min(1),
  station_kind: z.enum(['live', 'trap', 'simulated']),
  description: z.string().trim().max(300).optional().nullable(),
});

export async function upsertCameraStation(db: Queryable, c: z.infer<typeof CameraInputSchema>): Promise<void> {
  await assertArea(db, c.area_id);
  await db.query(
    `INSERT INTO cameras (id, label, lat, lng, area_id, station_kind, description, source_kind, detector)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'none','none')
     ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, lat=EXCLUDED.lat, lng=EXCLUDED.lng, area_id=EXCLUDED.area_id,
       station_kind=EXCLUDED.station_kind, description=EXCLUDED.description, updated_at=now()`,
    [c.id, c.label, c.lat, c.lng, c.area_id, c.station_kind, c.description ?? null],
  );
}

// ============================================================ tourists
export interface TouristRow {
  id: number; name: string; phone: string; language: string; nationality: string | null; area_id: string; lodge: string | null; lodge_id: string | null;
  trip_start: string; trip_end: string; group_size: number; emergency_contact: string | null; sms_alerts: boolean;
  last_lat: number | null; last_lng: number | null; last_located_at: Date | null; active: boolean; demo: boolean; created_at: Date;
}
const TOURIST_COLS = `id, name, phone, language, nationality, area_id, lodge, lodge_id, to_char(trip_start, 'YYYY-MM-DD') AS trip_start,
  to_char(trip_end, 'YYYY-MM-DD') AS trip_end, group_size, emergency_contact, sms_alerts, last_lat, last_lng, last_located_at, active, demo, created_at`;

/** Accepts +255…, 255…, or 0… (Tanzanian local) and returns E.164. */
export function normalizePhone(raw: string): string | null {
  const s = raw.replace(/[\s()-]/g, '');
  if (/^\+\d{9,15}$/.test(s)) return s;
  if (/^255\d{9}$/.test(s)) return `+${s}`;
  if (/^0[67]\d{8}$/.test(s)) return `+255${s.slice(1)}`;
  return null;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const TouristRegisterSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your name').max(80),
    phone: z.string().trim().min(6).max(20),
    pin: z.string().trim().regex(/^\d{4,12}$/, 'PIN must be 4–12 digits'),
    language: z.enum(LANGS).default('en'),
    nationality: z.string().trim().max(60).optional().nullable(),
    area_id: z.string().min(1, 'Choose your destination'),
    lodge: z.string().trim().max(100).optional().nullable(),
    trip_start: isoDate,
    trip_end: isoDate,
    group_size: z.coerce.number().int().min(1).max(60).default(1),
    emergency_contact: z.string().trim().max(100).optional().nullable(),
    sms_alerts: z.boolean().default(true),
  })
  .refine((t) => t.trip_end >= t.trip_start, { message: 'Trip end must be on or after the start date', path: ['trip_end'] });

export async function registerTourist(db: Queryable, input: z.infer<typeof TouristRegisterSchema>, demo = false): Promise<TouristRow> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new DomainError(400, 'invalid_phone', 'Enter a phone number like +255 712 345 678');
  await assertArea(db, input.area_id);
  const r = await db.query<TouristRow>(
    `INSERT INTO tourists (name, phone, pin_hash, language, nationality, area_id, lodge, trip_start, trip_end, group_size, emergency_contact, sms_alerts, demo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (phone) DO NOTHING RETURNING ${TOURIST_COLS}`,
    [input.name, phone, await hashPin(input.pin), input.language, input.nationality ?? null, input.area_id, input.lodge ?? null,
      input.trip_start, input.trip_end, input.group_size, input.emergency_contact ?? null, input.sms_alerts, demo],
  );
  if (!r.rows[0]) throw new DomainError(409, 'phone_registered', 'This phone number is already registered. Sign in instead.');
  return r.rows[0];
}

let dummy: Promise<string> | null = null;
export async function authenticateTourist(db: Queryable, phoneRaw: string, pin: string): Promise<TouristRow | null> {
  const phone = normalizePhone(phoneRaw) ?? phoneRaw;
  const r = await db.query<TouristRow & { pin_hash: string }>(`SELECT ${TOURIST_COLS}, pin_hash FROM tourists WHERE phone = $1`, [phone]);
  dummy ??= hashPin('000000');
  const row = r.rows[0];
  const ok = await verifyPin(pin, row?.pin_hash ?? (await dummy));
  if (!row || !row.active || !ok) return null;
  const { pin_hash: _p, ...t } = row;
  return t;
}

export async function getTourist(db: Queryable, id: number): Promise<(TouristRow & { sessions_valid_after: Date }) | null> {
  return (await db.query<TouristRow & { sessions_valid_after: Date }>(`SELECT ${TOURIST_COLS}, sessions_valid_after FROM tourists WHERE id = $1`, [id])).rows[0] ?? null;
}
export async function getTouristByPhone(db: Queryable, phone: string): Promise<TouristRow | null> {
  return (await db.query<TouristRow>(`SELECT ${TOURIST_COLS} FROM tourists WHERE phone = $1 AND active`, [phone])).rows[0] ?? null;
}

export const TouristUpdateSchema = z.object({
  language: z.enum(LANGS).optional(),
  area_id: z.string().optional(),
  lodge: z.string().trim().max(100).optional().nullable(),
  trip_start: isoDate.optional(),
  trip_end: isoDate.optional(),
  group_size: z.coerce.number().int().min(1).max(60).optional(),
  emergency_contact: z.string().trim().max(100).optional().nullable(),
  sms_alerts: z.boolean().optional(),
});

export async function updateTourist(db: Queryable, id: number, patch: z.infer<typeof TouristUpdateSchema>): Promise<TouristRow> {
  const cur = await getTourist(db, id);
  if (!cur) throw new DomainError(404, 'not_found', 'Tourist not found');
  const next = { ...cur, ...patch };
  if (next.trip_end < next.trip_start) throw new DomainError(400, 'invalid_dates', 'Trip end must be on or after the start date');
  if (patch.area_id) await assertArea(db, patch.area_id);
  const r = await db.query<TouristRow>(
    `UPDATE tourists SET language=$2, area_id=$3, lodge=$4, trip_start=$5, trip_end=$6, group_size=$7, emergency_contact=$8, sms_alerts=$9
      WHERE id=$1 RETURNING ${TOURIST_COLS}`,
    [id, next.language, next.area_id, next.lodge, next.trip_start, next.trip_end, next.group_size, next.emergency_contact, next.sms_alerts],
  );
  return r.rows[0]!;
}

export async function shareTouristLocation(db: Queryable, id: number, lat: number, lng: number): Promise<void> {
  await db.query('UPDATE tourists SET last_lat=$2, last_lng=$3, last_located_at=now() WHERE id=$1', [id, lat, lng]);
}

export async function setTouristActive(db: Queryable, id: number, active: boolean): Promise<void> {
  const r = await db.query(`UPDATE tourists SET active=$2, sessions_valid_after = CASE WHEN $2 THEN sessions_valid_after ELSE now() END WHERE id=$1`, [id, active]);
  if (!r.rowCount) throw new DomainError(404, 'not_found', 'Tourist not found');
}

export async function listTourists(db: Queryable, opts: { q?: string; areaId?: string; onTripOnly?: boolean; limit?: number } = {}) {
  const r = await db.query<TouristRow & { sos_count: number }>(
    `SELECT ${TOURIST_COLS},
            (SELECT count(*)::int FROM events e WHERE e.tourist_id = tourists.id AND e.kind = 'sos') AS sos_count
       FROM tourists
      WHERE ($1::text IS NULL OR tourists.name ILIKE '%' || $1 || '%' OR tourists.phone ILIKE '%' || $1 || '%' OR tourists.lodge ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR tourists.area_id = $2)
        AND (NOT $3 OR current_date BETWEEN tourists.trip_start AND tourists.trip_end)
      ORDER BY tourists.trip_start DESC, tourists.name LIMIT $4`,
    [opts.q || null, opts.areaId || null, !!opts.onTripOnly, opts.limit ?? 200],
  );
  return r.rows;
}

/** Tourists to message about an area today (active, on trip, opted in to SMS). */
async function touristsForAlert(c: Queryable, areaId: string, includeDemo: boolean): Promise<TouristRow[]> {
  return (
    await c.query<TouristRow>(
      `SELECT ${TOURIST_COLS} FROM tourists WHERE active AND sms_alerts AND area_id = $1 AND current_date BETWEEN trip_start AND trip_end
         AND ($2 OR NOT demo)`,
      [areaId, includeDemo],
    )
  ).rows;
}

async function rangersForArea(c: Queryable, areaId: string | null, includeDemo: boolean): Promise<{ id: string; name: string; phone: string }[]> {
  return (
    await c.query<{ id: string; name: string; phone: string }>(
      `SELECT id, name, phone FROM operators WHERE active AND on_duty AND phone IS NOT NULL AND role = 'ranger'
         AND ($1::text IS NULL OR area_id IS NULL OR area_id = $1) AND ($2 OR NOT demo) ORDER BY id`,
      [areaId, includeDemo],
    )
  ).rows;
}

// ============================================================ messaging helpers
const LEVEL_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
export const riskAtLeast = (a: string | null | undefined, b: RiskLevel) => LEVEL_RANK[a ?? 'none']! >= LEVEL_RANK[b]!;

function localHour(timeZone: string, at: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(at));
}

// ============================================================ detections → risk → incidents
export interface DetectionInput {
  cameraId: string | null;
  areaId?: string | null;
  lat?: number | null;
  lng?: number | null;
  capturedAt: Date;
  input: 'camera' | 'simulated_camera' | 'upload';
  analysis: 'model' | 'simulated';
  model?: string | null;
  species: string | null;
  confidence: number | null;
  bbox?: unknown;
  others?: unknown;
  imagePath?: string | null;
  uploadedBy?: string | null;
  demo?: boolean;
}

export interface MessagingOpts {
  timeZone: string;
  emergencyLine: string;
  testMode: boolean;
  /** Seeded demo people have made-up numbers: message them only via sandbox/simulation, never a live account. */
  includeDemoRecipients?: boolean;
}

export interface ProcessedDetection {
  detectionId: number;
  risk: ReturnType<typeof assessRisk>;
  incident: EventRow | null;
  incidentCreated: boolean;
  escalated: boolean;
}

/** Store a detection, assess risk, and open/refresh a wildlife incident with notifications — all in one transaction. */
export async function processDetection(db: Db, d: DetectionInput, opts: MessagingOpts): Promise<ProcessedDetection> {
  return withTx(db, async (c) => {
    const cam = d.cameraId
      ? (await c.query<CameraGeoRow>('SELECT id, label, lat, lng, area_id FROM cameras WHERE id = $1', [d.cameraId])).rows[0]
      : undefined;
    if (d.cameraId && !cam) throw new DomainError(400, 'unknown_camera', `Unknown camera "${d.cameraId}"`);
    const lat = d.lat ?? cam?.lat ?? null;
    const lng = d.lng ?? cam?.lng ?? null;
    const areaId = d.areaId ?? cam?.area_id ?? null;
    const location: LatLng | null = lat !== null && lng !== null ? [lat, lng] : null;
    const zones = areaId ? await listZones(c, { areaId }) : [];
    let peopleNearby = 0;
    if (location && areaId) {
      const located = await c.query<{ last_lat: number; last_lng: number }>(
        `SELECT last_lat, last_lng FROM tourists WHERE active AND area_id = $1 AND last_located_at > now() - interval '30 minutes'`,
        [areaId],
      );
      peopleNearby = located.rows.filter((t) => haversineM(location, [t.last_lat, t.last_lng]) <= 300).length;
    }
    // Guests checked in to an activity (walking safari, game drive…) are really there, whatever the usual occupancy.
    const guestsOut: Record<number, { people: number; label: string }> = {};
    if (areaId) {
      const until = (t: Date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: opts.timeZone }).format(t);
      for (const a of await liveActivities(c, areaId)) {
        const cur = guestsOut[a.zone_id] ?? { people: 0, label: '' };
        cur.people += a.people;
        cur.label = `${cur.people} guest${cur.people === 1 ? '' : 's'} out here now on a ${ACTIVITY_LABEL[a.kind as keyof typeof ACTIVITY_LABEL] ?? 'activity'}, back by ${until(a.ends_at)}`;
        guestsOut[a.zone_id] = cur;
      }
    }
    const risk = assessRisk({
      species: d.species,
      confidence: d.confidence,
      location,
      zones: zones.map<ZoneInput>((z) => ({ id: z.id, name: z.name, sensitivity: z.sensitivity, occupancy: z.occupancy, buffer_m: z.buffer_m, geometry: z.geometry })),
      localHour: localHour(opts.timeZone, d.capturedAt),
      peopleNearby,
      guestsOut,
    });

    const det = await c.query<{ id: number }>(
      `INSERT INTO detections (camera_id, area_id, captured_at, input, analysis, model, species, confidence, bbox, other_detections, image_path,
                               lat, lng, safety_zone_id, distance_m, inside_zone, risk_level, risk_score, risk_reasons, uploaded_by, demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      [d.cameraId, areaId, d.capturedAt, d.input, d.analysis, d.model ?? null, d.species, d.confidence, d.bbox ? JSON.stringify(d.bbox) : null,
        d.others ? JSON.stringify(d.others) : null, d.imagePath ?? null, lat, lng, risk.zone?.id ?? null, risk.distanceM, risk.inside,
        risk.level, risk.score, JSON.stringify(risk.reasons), d.uploadedBy ?? null, !!d.demo],
    );
    const detectionId = det.rows[0]!.id;
    if (!riskAtLeast(risk.level, 'medium') || !risk.zone) {
      return { detectionId, risk, incident: null, incidentCreated: false, escalated: false };
    }

    const sp = speciesProfile(d.species);
    const zone = risk.zone;
    const where = risk.inside ? `inside ${zone.name}` : `${risk.distanceM} m from ${zone.name}`;
    const title = `${sp.name_en} ${risk.inside ? 'inside' : 'near'} ${zone.name}`;
    const source = d.analysis === 'model' ? 'inference' : 'simulated';

    const ins = await c.query<EventRow>(
      `INSERT INTO events (kind, camera_id, zone_label, class_label, confidence, bbox, first_seen_at, last_seen_at, source, model,
                           risk_level, area_id, lat, lng, title, safety_zone_id, risk_reasons, detection_id, demo, snapshot_path)
       VALUES ('wildlife',$1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (camera_id, safety_zone_id) WHERE kind = 'wildlife' AND status IN ('open', 'acknowledged') DO NOTHING
       RETURNING *`,
      [d.cameraId, zone.name, d.species, d.confidence ?? 0, d.bbox ? JSON.stringify(d.bbox) : null, d.capturedAt, source, d.model ?? null,
        risk.level, areaId, lat, lng, title, zone.id, JSON.stringify(risk.reasons), detectionId, !!d.demo, d.imagePath ?? null],
    );
    let incident = ins.rows[0] ?? null;
    let created = !!incident;
    let escalated = false;

    if (!incident) {
      // Same camera + zone already has an active incident: update it rather than alerting again.
      const cur = (
        await c.query<EventRow & { risk_level: string }>(
          `SELECT * FROM events WHERE kind='wildlife' AND camera_id IS NOT DISTINCT FROM $1 AND safety_zone_id = $2 AND status IN ('open','acknowledged') FOR UPDATE`,
          [d.cameraId, zone.id],
        )
      ).rows[0];
      if (!cur) throw new Error('wildlife incident conflict without an active row');
      escalated = LEVEL_RANK[risk.level]! > LEVEL_RANK[cur.risk_level ?? 'none']!;
      incident = (
        await c.query<EventRow>(
          `UPDATE events SET last_seen_at = GREATEST(last_seen_at, $2), confidence = GREATEST(confidence, $3),
                  risk_level = CASE WHEN $4 THEN $5 ELSE risk_level END, risk_reasons = CASE WHEN $4 THEN $6 ELSE risk_reasons END,
                  title = CASE WHEN $4 THEN $7 ELSE title END, detection_id = $8, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [cur.id, d.capturedAt, d.confidence ?? 0, escalated, risk.level, JSON.stringify(risk.reasons), title, detectionId],
        )
      ).rows[0]!;
      if (escalated) {
        await c.query(`INSERT INTO event_actions (event_id, actor, action, note) VALUES ($1, 'system:ai', 'note', $2)`, [
          incident.id,
          `Risk escalated to ${risk.level.toUpperCase()}: ${sp.name_en} ${where}`,
        ]);
      }
    } else {
      await c.query(`INSERT INTO event_actions (event_id, actor, action, note) VALUES ($1, 'system:ai', 'opened', $2)`, [
        incident.id,
        `${sp.name_en} ${d.confidence !== null ? `${Math.round(d.confidence * 100)}% ` : ''}${where} · risk ${risk.level.toUpperCase()} (${source === 'simulated' ? 'SIMULATED detection' : 'model detection'})`,
      ]);
    }
    await c.query('UPDATE detections SET event_id = $2 WHERE id = $1', [detectionId, incident.id]);

    if (created || escalated) {
      await notifyWildlife(c, incident, risk.level, sp, where, zone.name, areaId, source === 'simulated', opts, escalated);
    } else if (riskAtLeast(incident.risk_level, 'high') && !(await c.query('SELECT 1 FROM guest_checks WHERE event_id = $1', [incident.id])).rowCount) {
      // A lodge that has not checked on its guests for this incident yet (e.g. it opened before the lodge joined) does so now.
      await rollCallsForIncident(c, incident, rollCallReasons(sp.key, zone.name), source === 'simulated', opts);
    }
    return { detectionId, risk, incident, incidentCreated: created, escalated };
  });
}

async function notifyWildlife(
  c: DbClient, e: EventRow, level: RiskLevel, sp: ReturnType<typeof speciesProfile>, where: string, place: string,
  areaId: string | null, simulated: boolean, opts: MessagingOpts, escalated: boolean,
) {
  const ref = eventRef(e.id);
  const tag = opts.testMode || simulated ? ' TEST' : '';
  const sim = simulated ? ' (SIMULATED)' : '';
  const suffix = escalated ? `-esc-${level}` : '';
  const jobs: Job[] = [];
  for (const r of await rangersForArea(c, areaId, opts.includeDemoRecipients !== false)) {
    jobs.push({
      kind: `alert${suffix}`, alias: `ranger:${r.id}`, to: r.phone, recipientKind: 'ranger',
      body: `Safe Savannah${tag} ${ref}${sim} ${level.toUpperCase()}: ${sp.name_en} ${where}. Verify, then coordinate by radio. Update status on the dashboard.`,
    });
    if (level === 'critical') {
      jobs.push({
        kind: `voice_alert${suffix}`, alias: `ranger:${r.id}`, to: r.phone, recipientKind: 'ranger', channel: 'voice',
        body: `Safe Savannah urgent wildlife alert${simulated ? ', simulated test' : ''}. ${sp.name_en} ${where}. Incident ${ref.replace('-', ' ')}. Please verify and coordinate by radio.`,
      });
    }
  }
  if (areaId && riskAtLeast(level, 'medium')) {
    const lvl = level === 'critical' ? 'danger' : level === 'high' ? 'warning' : 'advisory';
    // Stored in every guest language; title_en/title_sw stay for staff views and older clients.
    const content = alertContent(sp.key, place, simulated);
    await c.query(
      `INSERT INTO tourist_alerts (area_id, event_id, level, title_en, title_sw, body_en, body_sw, actions_en, actions_sw, content, place, expires_at, demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + interval '6 hours', $12)`,
      [areaId, e.id, lvl, content.en.title, content.sw.title, content.en.body, content.sw.body,
        JSON.stringify(content.en.actions), JSON.stringify(content.sw.actions), JSON.stringify(content), place, e.demo],
    );
    if (riskAtLeast(level, 'high')) {
      // Lodges whose own zone is at risk ask every guest "Are you safe?"; that SMS replaces the general warning for them.
      const inRollCall = await rollCallsForIncident(c, e, rollCallReasons(sp.key, place), simulated, opts);
      for (const t of await touristsForAlert(c, areaId, opts.includeDemoRecipients !== false)) {
        if (inRollCall.has(t.id)) continue;
        jobs.push({
          kind: `alert${suffix}`, alias: `tourist:${t.id}`, to: t.phone, recipientKind: 'tourist',
          body: catalog(t.language).alertSms({ tag, simulated, animal: speciesName(t.language, sp.key), place, line: opts.emergencyLine }),
        });
      }
    }
  }
  await enqueue(c, e.id, jobs);
}

// ============================================================ SOS
export const EMERGENCY_TYPES = ['medical', 'wildlife', 'vehicle', 'personal'] as const;
export type EmergencyType = (typeof EMERGENCY_TYPES)[number];
export const EMERGENCY_LABEL: Record<EmergencyType, { en: string; sw: string }> = {
  medical: { en: 'Medical emergency', sw: 'Dharura ya kiafya' },
  wildlife: { en: 'Dangerous wildlife', sw: 'Mnyama hatari' },
  vehicle: { en: 'Vehicle breakdown', sw: 'Gari limeharibika' },
  personal: { en: 'Personal safety', sw: 'Usalama binafsi' },
};

export interface SosInput {
  touristId?: number | null;
  phone?: string | null;
  type: EmergencyType;
  description?: string | null;
  lat?: number | null;
  lng?: number | null;
  channel: 'app' | 'ussd' | 'voice' | 'sms';
  areaId?: string | null;
  demo?: boolean;
}

/** Create an SOS incident and alert rangers (SMS + voice). A repeat press within 2 minutes returns the same incident. */
export async function createSos(db: Db, input: SosInput, opts: MessagingOpts): Promise<{ incident: EventRow; duplicate: boolean }> {
  return withTx(db, async (c) => {
    const tourist = input.touristId ? (await c.query<TouristRow>(`SELECT ${TOURIST_COLS} FROM tourists WHERE id = $1`, [input.touristId])).rows[0] : undefined;
    const phone = tourist?.phone ?? (input.phone ? normalizePhone(input.phone) ?? input.phone : null);
    if (!tourist && !phone) throw new DomainError(400, 'unknown_reporter', 'An SOS needs a registered tourist or a phone number');
    // Serialize per reporter so a double-press cannot create two incidents.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sos:${tourist?.id ?? phone}`]);
    const dup = await c.query<EventRow>(
      `SELECT * FROM events WHERE kind = 'sos' AND status IN ('open','acknowledged') AND emergency_type = $1
         AND (tourist_id = $2 OR ($2::bigint IS NULL AND reporter_phone = $3)) AND opened_at > now() - interval '2 minutes'
       ORDER BY id DESC LIMIT 1`,
      [input.type, tourist?.id ?? null, phone],
    );
    if (dup.rows[0]) return { incident: dup.rows[0], duplicate: true };

    const areaId = tourist?.area_id ?? input.areaId ?? null;
    const lat = input.lat ?? (tourist?.last_located_at && Date.now() - tourist.last_located_at.getTime() < 3_600_000 ? tourist.last_lat : null);
    const lng = input.lng ?? (lat !== null && tourist ? tourist.last_lng : null);
    const label = EMERGENCY_LABEL[input.type].en;
    const who = tourist ? `${tourist.name}${tourist.group_size > 1 ? ` (group of ${tourist.group_size})` : ''}` : `caller ${phone}`;
    const area = areaId ? (await c.query<AreaRow>('SELECT * FROM areas WHERE id = $1', [areaId])).rows[0] : undefined;
    const place = [tourist?.lodge, area?.name].filter(Boolean).join(', ') || 'location not given';
    const risk = input.type === 'medical' || input.type === 'wildlife' ? 'critical' : 'high';
    const e = (
      await c.query<EventRow>(
        `INSERT INTO events (kind, source, first_seen_at, last_seen_at, risk_level, area_id, lat, lng, title, description, tourist_id,
                             emergency_type, reporter_phone, report_channel, demo, zone_label, class_label, confidence)
         VALUES ('sos','report',now(),now(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,NULL) RETURNING *`,
        [risk, areaId, lat ?? (area?.center_lat ?? null), lng ?? (area?.center_lng ?? null), `${label} — ${who}`, input.description?.trim() || null,
          tourist?.id ?? null, input.type, phone, input.channel, !!input.demo, place],
      )
    ).rows[0]!;
    const actor = tourist ? `tourist:${tourist.id}` : `${input.channel}:${phone}`;
    await c.query(`INSERT INTO event_actions (event_id, actor, action, channel, note) VALUES ($1,$2,'opened',$3,$4)`, [
      e.id, actor, input.channel === 'app' ? 'dashboard' : input.channel === 'voice' ? 'phone' : input.channel,
      `SOS via ${input.channel.toUpperCase()}: ${label}. ${input.description?.trim() ? `"${input.description.trim()}". ` : ''}Location: ${lat !== null && lat !== undefined ? 'shared by phone' : `registered area (${place})`}.`,
    ]);

    const ref = eventRef(e.id);
    const tag = opts.testMode ? ' TEST' : '';
    const jobs: Job[] = [];
    for (const r of await rangersForArea(c, areaId, opts.includeDemoRecipients !== false)) {
      jobs.push({ kind: 'alert', alias: `ranger:${r.id}`, to: r.phone, recipientKind: 'ranger',
        body: `Safe Savannah${tag} SOS ${ref}: ${label} — ${who}, ${place}${phone ? `, tel ${phone}` : ''}. Open the dashboard and coordinate by radio.` });
      jobs.push({ kind: 'voice_alert', alias: `ranger:${r.id}`, to: r.phone, recipientKind: 'ranger', channel: 'voice',
        body: `Safe Savannah emergency. ${label} reported by ${who} at ${place}. Incident ${ref.replace('-', ' ')}. Please respond and coordinate by radio.` });
    }
    if (phone && (opts.includeDemoRecipients !== false || !tourist?.demo)) {
      jobs.push({ kind: 'sos_received', alias: tourist ? `tourist:${tourist.id}` : `caller:${phone}`, to: phone, recipientKind: 'tourist',
        body: catalog(tourist?.language).sosReceived(ref, opts.emergencyLine) });
    }
    await enqueue(c, e.id, jobs);
    return { incident: e, duplicate: false };
  });
}

/** After a ranger changes an SOS status, tell the reporter by SMS. */
export async function notifyReporterOfStatus(db: Db, eventId: number, status: 'responding' | 'resolved', rangerName: string): Promise<void> {
  await withTx(db, async (c) => {
    const e = (await c.query<EventRow & { kind: string; reporter_phone: string | null; tourist_id: number | null }>('SELECT * FROM events WHERE id = $1', [eventId])).rows[0];
    if (!e || e.kind !== 'sos' || !e.reporter_phone) return;
    const lang = e.tourist_id ? (await c.query<{ language: string }>('SELECT language FROM tourists WHERE id = $1', [e.tourist_id])).rows[0]?.language : 'en';
    const ref = eventRef(e.id);
    const body = status === 'responding' ? catalog(lang).sosResponding(ref, rangerName) : catalog(lang).sosResolved(ref, rangerName);
    await enqueue(c, eventId, [{ kind: `status_${status}`, alias: e.tourist_id ? `tourist:${e.tourist_id}` : `caller:${e.reporter_phone}`, to: e.reporter_phone, recipientKind: 'tourist', body }]);
  });
}

// ============================================================ read models
export async function mapData(db: Queryable, opts: { areaId?: string; hours?: number } = {}) {
  const [areas, zones, cameras, incidents, detections, groupsOut] = await Promise.all([
    listAreas(db),
    listZones(db, { areaId: opts.areaId }),
    listCameras(db),
    db.query(
      `SELECT e.id, e.kind, e.status, e.risk_level, e.title, e.class_label, e.zone_label, e.lat, e.lng, e.area_id, e.opened_at, e.last_seen_at,
              e.source, e.emergency_type, e.acknowledged_by, o.name AS acknowledged_by_name, e.camera_id, e.demo, e.report_channel
         FROM events e LEFT JOIN operators o ON o.id = e.acknowledged_by
        WHERE e.status IN ('open','acknowledged') AND ($1::text IS NULL OR e.area_id = $1 OR e.area_id IS NULL)
        ORDER BY (e.kind = 'sos') DESC, e.status = 'open' DESC, e.opened_at DESC`,
      [opts.areaId ?? null],
    ),
    db.query(
      `SELECT d.id, d.camera_id, d.captured_at, d.species, d.confidence, d.lat, d.lng, d.area_id, d.risk_level, d.input, d.analysis, d.event_id,
              d.distance_m, d.inside_zone, z.name AS zone_name, d.demo
         FROM detections d LEFT JOIN safety_zones z ON z.id = d.safety_zone_id
        WHERE d.captured_at > now() - ($1::int * interval '1 hour') AND ($2::text IS NULL OR d.area_id = $2)
        ORDER BY d.captured_at DESC LIMIT 300`,
      [opts.hours ?? 6, opts.areaId ?? null],
    ),
    liveActivities(db, opts.areaId ?? null),
  ]);
  return {
    areas, zones, cameras, incidents: incidents.rows.map((i: { id: number }) => ({ ...i, ref: eventRef(i.id) })), detections: detections.rows,
    // Guests checked in to an activity (shown to rangers as groups on the map; names stay with the lodge).
    groupsOut: groupsOut.map((a) => ({ id: a.id, zone_id: a.zone_id, zone_name: a.zone_name, kind: a.kind, people: a.people, ends_at: a.ends_at, status: a.status, lodge_name: a.lodge_name })),
  };
}

export const DetectionFiltersSchema = z.object({
  species: z.string().max(40).optional(),
  risk: z.enum(['none', 'low', 'medium', 'high', 'critical']).optional(),
  analysis: z.enum(['model', 'simulated']).optional(),
  area: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
});

export async function listDetections(db: Queryable, f: z.infer<typeof DetectionFiltersSchema>) {
  const where = `WHERE ($1::text IS NULL OR d.species = $1) AND ($2::text IS NULL OR d.risk_level = $2) AND ($3::text IS NULL OR d.analysis = $3)
                   AND ($4::text IS NULL OR d.area_id = $4)`;
  const params = [f.species ?? null, f.risk ?? null, f.analysis ?? null, f.area ?? null];
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) n FROM detections d ${where}`, params)).rows[0]!.n);
  const pages = Math.max(1, Math.ceil(total / f.pageSize));
  const page = Math.min(f.page, pages);
  const r = await db.query(
    `SELECT d.*, z.name AS zone_name, c.label AS camera_label, a.name AS area_name
       FROM detections d LEFT JOIN safety_zones z ON z.id = d.safety_zone_id LEFT JOIN cameras c ON c.id = d.camera_id LEFT JOIN areas a ON a.id = d.area_id
       ${where} ORDER BY d.captured_at DESC LIMIT ${f.pageSize} OFFSET ${(page - 1) * f.pageSize}`,
    params,
  );
  return { items: r.rows.map((d: { image_path: string | null; id: number }) => ({ ...d, image_path: undefined, imageUrl: d.image_path ? `/api/detections/${d.id}/image` : null })), total, page, pages };
}

/** Everything a tourist's home screen needs. */
export async function touristFeed(db: Queryable, t: TouristRow) {
  const [area, alerts, active, sos, checks, escort, activity] = await Promise.all([
    db.query<AreaRow>('SELECT * FROM areas WHERE id = $1', [t.area_id]),
    db.query(
      `SELECT a.id, a.level, a.title_en, a.title_sw, a.body_en, a.body_sw, a.actions_en, a.actions_sw, a.place, a.created_at, a.expires_at, a.event_id,
              e.status AS incident_status, a.demo
         FROM tourist_alerts a LEFT JOIN events e ON e.id = a.event_id
        WHERE a.area_id = $1 AND (a.tourist_id IS NULL OR a.tourist_id = $2) AND a.created_at > now() - interval '48 hours'
        ORDER BY a.created_at DESC LIMIT 30`,
      [t.area_id, t.id],
    ),
    db.query<{ n: number }>(`SELECT count(*)::int n FROM events WHERE kind='wildlife' AND area_id=$1 AND status IN ('open','acknowledged') AND risk_level IN ('medium','high','critical')`, [t.area_id]),
    db.query(
      `SELECT e.id, e.emergency_type, e.status, e.opened_at, e.acknowledged_at, e.closed_at, e.description, e.report_channel, o.name AS ranger_name,
              (SELECT json_agg(json_build_object('at', a.created_at, 'action', a.action, 'channel', a.channel, 'note', CASE WHEN a.action IN ('opened','handoff') THEN NULL ELSE a.note END) ORDER BY a.created_at)
                 FROM event_actions a WHERE a.event_id = e.id AND a.action IN ('opened','acknowledged','closed','dismissed')) AS updates
         FROM events e LEFT JOIN operators o ON o.id = e.acknowledged_by
        WHERE e.kind = 'sos' AND e.tourist_id = $1 ORDER BY e.opened_at DESC LIMIT 20`,
      [t.id],
    ),
    touristChecks(db, t.id),
    touristEscort(db, t.id),
    touristActivity(db, t.id),
  ]);
  return {
    area: area.rows[0] ?? null,
    alerts: alerts.rows.map((a: { incident_status: string | null; expires_at: Date | null }) => ({
      ...a,
      active: (a.incident_status === 'open' || a.incident_status === 'acknowledged') && (!a.expires_at || a.expires_at.getTime() > Date.now()),
    })),
    activeWildlifeIncidents: active.rows[0]!.n,
    sos: sos.rows.map((s: { id: number }) => ({ ...s, ref: eventRef(s.id) })),
    // Open "Are you safe?" requests from the traveller's lodge.
    checks,
    escort,
    activity,
  };
}

export async function platformStats(db: Queryable, days: number, timeZone: string) {
  const since = `now() - (${Math.max(1, Math.min(366, days))} * interval '1 day')`;
  const [bySpecies, byRisk, byInput, incidents, response, perDay, sosTypes] = await Promise.all([
    db.query(`SELECT COALESCE(species,'none') species, count(*)::int n, count(*) FILTER (WHERE risk_level IN ('high','critical'))::int high FROM detections WHERE captured_at > ${since} GROUP BY 1 ORDER BY n DESC`),
    db.query(`SELECT risk_level, count(*)::int n FROM detections WHERE captured_at > ${since} GROUP BY 1`),
    db.query(`SELECT analysis, input, count(*)::int n FROM detections WHERE captured_at > ${since} GROUP BY 1,2`),
    db.query(`SELECT kind, status, count(*)::int n FROM events WHERE opened_at > ${since} GROUP BY 1,2`),
    db.query(
      `SELECT kind, count(acknowledged_at)::int responded,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM acknowledged_at - opened_at)) AS median_response_s,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM closed_at - opened_at)) AS median_resolve_s
         FROM events WHERE opened_at > ${since} GROUP BY kind`,
    ),
    db.query(
      `SELECT to_char(date_trunc('day', ts AT TIME ZONE $1), 'YYYY-MM-DD') AS day, sum(det)::int detections, sum(inc)::int incidents, sum(sos)::int sos
         FROM (SELECT captured_at ts, 1 det, 0 inc, 0 sos FROM detections WHERE captured_at > ${since}
               UNION ALL SELECT opened_at, 0, CASE WHEN kind <> 'sos' THEN 1 ELSE 0 END, CASE WHEN kind = 'sos' THEN 1 ELSE 0 END FROM events WHERE opened_at > ${since}) x
        GROUP BY 1 ORDER BY 1`,
      [timeZone],
    ),
    db.query(`SELECT emergency_type, count(*)::int n FROM events WHERE kind='sos' AND opened_at > ${since} GROUP BY 1`),
  ]);
  const totals = await db.query<{ tourists_on_trip: number; rangers_on_duty: number; zones: number; cameras: number }>(
    `SELECT (SELECT count(*)::int FROM tourists WHERE active AND current_date BETWEEN trip_start AND trip_end) tourists_on_trip,
            (SELECT count(*)::int FROM operators WHERE active AND on_duty AND role='ranger') rangers_on_duty,
            (SELECT count(*)::int FROM safety_zones WHERE active) zones,
            (SELECT count(*)::int FROM cameras WHERE lat IS NOT NULL) cameras`,
  );
  return {
    days,
    timeZone,
    totals: totals.rows[0],
    detectionsBySpecies: bySpecies.rows,
    detectionsByRisk: byRisk.rows,
    detectionsBySource: byInput.rows,
    incidentsByKindStatus: incidents.rows,
    response: response.rows,
    perDay: perDay.rows,
    sosByType: sosTypes.rows,
  };
}
