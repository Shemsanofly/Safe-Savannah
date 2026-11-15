/**
 * Demo data: three Tanzanian destinations with safety zones, camera stations,
 * rangers, tourists on current trips, and 14 days of history.
 *
 * Everything created here is flagged demo=true and shown as "Demo" in the UI.
 * Coordinates are approximate and zone outlines are illustrative — redraw them
 * with the site team before any real use. Demo phone numbers are made up; the
 * app never sends to demo people through a LIVE SMS account.
 *
 *   npm run seed            (idempotent: safe to run again)
 */
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool, type Db } from '../db/pool.js';
import type { LatLng } from '../domain/geo.js';
import { assessRisk, speciesProfile } from '../domain/risk.js';
import { offset } from '../sim/simulator.js';
import { hashPin } from '../store/operators.js';
import { listZones } from '../store/platform.js';

const AREAS = [
  { id: 'serengeti-seronera', name: 'Serengeti NP — Seronera', region: 'Mara / Simiyu', c: [-2.453, 34.825] as LatLng, zoom: 14 },
  { id: 'ngorongoro-crater', name: 'Ngorongoro — Crater rim', region: 'Arusha', c: [-3.208, 35.515] as LatLng, zoom: 14 },
  { id: 'tarangire-river', name: 'Tarangire NP — Tarangire River', region: 'Manyara', c: [-3.84, 36.0] as LatLng, zoom: 14 },
];

/** Rectangle w×h metres centred at c (rotated slightly so outlines look hand-drawn). */
function rect(c: LatLng, w: number, h: number, rot = 12): LatLng[] {
  const d = Math.hypot(w, h) / 2;
  const a = (Math.atan2(w, h) * 180) / Math.PI;
  return [offset(c, d, -a + rot), offset(c, d, a + rot), offset(c, d, 180 - a + rot), offset(c, d, 180 + a + rot)];
}

const ZONES: { area: string; name: string; kind: string; sensitivity: string; occupancy: string; buffer: number; at: [number, number]; w: number; h: number }[] = [
  { area: 'serengeti-seronera', name: 'Seronera tented camp', kind: 'camp', sensitivity: 'high', occupancy: 'always', buffer: 300, at: [300, 0], w: 220, h: 160 },
  { area: 'serengeti-seronera', name: 'Visitor centre & picnic site', kind: 'picnic', sensitivity: 'high', occupancy: 'daytime', buffer: 200, at: [500, 90], w: 180, h: 140 },
  { area: 'serengeti-seronera', name: 'Kopjes walking trail', kind: 'trail', sensitivity: 'medium', occupancy: 'daytime', buffer: 150, at: [700, 180], w: 80, h: 900 },
  { area: 'serengeti-seronera', name: 'Seronera main road', kind: 'road', sensitivity: 'medium', occupancy: 'daytime', buffer: 80, at: [0, 0], w: 1600, h: 40 },
  { area: 'ngorongoro-crater', name: 'Crater-rim lodge', kind: 'lodge', sensitivity: 'high', occupancy: 'always', buffer: 250, at: [200, 300], w: 260, h: 180 },
  { area: 'ngorongoro-crater', name: 'Rim walking trail', kind: 'trail', sensitivity: 'medium', occupancy: 'daytime', buffer: 150, at: [600, 60], w: 70, h: 1000 },
  { area: 'ngorongoro-crater', name: 'Crater descent road', kind: 'road', sensitivity: 'medium', occupancy: 'daytime', buffer: 100, at: [700, 200], w: 40, h: 1400 },
  { area: 'tarangire-river', name: 'Riverside lodge grounds', kind: 'lodge', sensitivity: 'high', occupancy: 'always', buffer: 250, at: [250, 330], w: 280, h: 200 },
  { area: 'tarangire-river', name: 'River picnic site', kind: 'picnic', sensitivity: 'high', occupancy: 'daytime', buffer: 200, at: [650, 120], w: 150, h: 120 },
  { area: 'tarangire-river', name: 'Staff housing', kind: 'camp', sensitivity: 'high', occupancy: 'night', buffer: 200, at: [300, 200], w: 140, h: 120 },
  { area: 'tarangire-river', name: 'Game-drive road', kind: 'road', sensitivity: 'medium', occupancy: 'daytime', buffer: 80, at: [0, 0], w: 40, h: 1800 },
];

const CAMERAS: { id: string; label: string; area: string; at: [number, number]; kind: string }[] = [
  { id: 'sim-ser-1', label: 'Seronera camp approach (sim)', area: 'serengeti-seronera', at: [420, 350], kind: 'simulated' },
  { id: 'sim-ser-2', label: 'Kopjes trail head (sim)', area: 'serengeti-seronera', at: [500, 170], kind: 'simulated' },
  { id: 'sim-ngo-1', label: 'Rim lodge east fence (sim)', area: 'ngorongoro-crater', at: [380, 60], kind: 'simulated' },
  { id: 'sim-ngo-2', label: 'Descent road gate (sim)', area: 'ngorongoro-crater', at: [900, 220], kind: 'simulated' },
  { id: 'sim-tar-1', label: 'Lodge riverbank (sim)', area: 'tarangire-river', at: [420, 300], kind: 'simulated' },
  { id: 'sim-tar-2', label: 'Picnic site track (sim)', area: 'tarangire-river', at: [800, 130], kind: 'simulated' },
];

const RANGERS = [
  { id: 'juma', name: 'Juma Mussa', area: 'serengeti-seronera', phone: '+255754000101' },
  { id: 'neema', name: 'Neema Lyimo', area: 'serengeti-seronera', phone: '+255754000102' },
  { id: 'baraka', name: 'Baraka Mollel', area: 'ngorongoro-crater', phone: '+255754000103' },
  { id: 'rehema', name: 'Rehema Massawe', area: 'tarangire-river', phone: '+255754000104' },
  { id: 'saning', name: "Saning'o Laizer", area: null, phone: '+255754000105' },
];

const TOURISTS = [
  { name: 'Emma Schultz', phone: '+255765000201', lang: 'en', nat: 'Germany', area: 'serengeti-seronera', lodge: 'Seronera tented camp', group: 2 },
  { name: 'Daniel Okafor', phone: '+255765000202', lang: 'en', nat: 'Nigeria', area: 'serengeti-seronera', lodge: 'Seronera tented camp', group: 4 },
  { name: 'Amina Hassan', phone: '+255765000203', lang: 'sw', nat: 'Tanzania', area: 'tarangire-river', lodge: 'Riverside lodge', group: 3 },
  { name: 'Liam Chen', phone: '+255765000204', lang: 'en', nat: 'Canada', area: 'tarangire-river', lodge: 'Riverside lodge', group: 1 },
  { name: 'Grace Wanjiru', phone: '+255765000205', lang: 'sw', nat: 'Kenya', area: 'ngorongoro-crater', lodge: 'Crater-rim lodge', group: 2 },
  { name: 'Sofia Rossi', phone: '+255765000206', lang: 'en', nat: 'Italy', area: 'ngorongoro-crater', lodge: 'Crater-rim lodge', group: 5 },
];

const SPECIES_MIX: Record<string, string[]> = {
  'serengeti-seronera': ['wildebeest', 'wildebeest', 'zebra', 'zebra', 'lion', 'elephant', 'buffalo', 'giraffe', 'hyena', 'cheetah'],
  'ngorongoro-crater': ['buffalo', 'zebra', 'wildebeest', 'wildebeest', 'lion', 'hyena', 'elephant', 'rhino', 'baboon'],
  'tarangire-river': ['elephant', 'elephant', 'elephant', 'giraffe', 'zebra', 'buffalo', 'baboon', 'lion', 'hippo'],
};

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pickOne = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

export async function seed(db: Db, timeZone: string): Promise<string[]> {
  const log: string[] = [];
  for (const a of AREAS) {
    await db.query(
      `INSERT INTO areas (id, name, region, center_lat, center_lng, zoom) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [a.id, a.name, a.region, a.c[0], a.c[1], a.zoom],
    );
  }
  if (!(await db.query('SELECT 1 FROM safety_zones LIMIT 1')).rowCount) {
    for (const z of ZONES) {
      const area = AREAS.find((a) => a.id === z.area)!;
      const centre = offset(offset(area.c, z.at[0], 0), z.at[1], 90);
      await db.query(
        `INSERT INTO safety_zones (area_id, name, kind, sensitivity, occupancy, buffer_m, geometry, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Demo outline — redraw with the site team before real use','seed')`,
        [z.area, z.name, z.kind, z.sensitivity, z.occupancy, z.buffer, JSON.stringify(rect(centre, z.w, z.h))],
      );
    }
    log.push(`${ZONES.length} safety zones`);
  }
  for (const c of CAMERAS) {
    const area = AREAS.find((a) => a.id === c.area)!;
    const p = offset(offset(area.c, c.at[0], 0), c.at[1], 90);
    await db.query(
      `INSERT INTO cameras (id, label, lat, lng, area_id, station_kind, description, source_kind, detector)
       VALUES ($1,$2,$3,$4,$5,$6,'Simulated camera station (demo)','none','simulated:simulator') ON CONFLICT (id) DO NOTHING`,
      [c.id, c.label, p[0], p[1], c.area, c.kind],
    );
  }
  // The real fixed camera (vision worker) sits at the Seronera tented camp approach.
  const camp = offset(AREAS[0]!.c, 410, 0);
  await db.query(
    `INSERT INTO cameras (id, label, lat, lng, area_id, station_kind, source_kind, detector) VALUES ('cam-1','Approach camera 1',$1,$2,'serengeti-seronera','live','none','none')
     ON CONFLICT (id) DO UPDATE SET lat = COALESCE(cameras.lat, EXCLUDED.lat), lng = COALESCE(cameras.lng, EXCLUDED.lng), area_id = COALESCE(cameras.area_id, EXCLUDED.area_id)`,
    [camp[0], camp[1]],
  );

  const rangerPin = await hashPin('2468');
  for (const r of RANGERS) {
    await db.query(
      `INSERT INTO operators (id, name, pin_hash, role, phone, area_id, demo) VALUES ($1,$2,$3,'ranger',$4,$5,true) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.name, rangerPin, r.phone, r.area],
    );
  }
  if (!(await db.query(`SELECT 1 FROM operators WHERE role = 'admin' AND active`)).rowCount) {
    await db.query(`INSERT INTO operators (id, name, pin_hash, role, demo) VALUES ('admin','Park admin (demo)',$1,'admin',true) ON CONFLICT (id) DO NOTHING`, [await hashPin('1357')]);
    log.push('admin account "admin" / PIN 1357');
  }
  const touristPin = await hashPin('1234');
  for (const [i, t] of TOURISTS.entries()) {
    await db.query(
      `INSERT INTO tourists (name, phone, pin_hash, language, nationality, area_id, lodge, trip_start, trip_end, group_size, emergency_contact, demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Family contact (demo)',true) ON CONFLICT (phone) DO NOTHING`,
      [t.name, t.phone, touristPin, t.lang, t.nat, t.area, t.lodge, day(-1 - (i % 3)), day(3 + (i % 4)), t.group],
    );
  }

  const seeded = await db.query(`SELECT 1 FROM app_flags WHERE key = 'demo_history_seeded'`);
  if (!seeded.rowCount) {
    const n = await seedHistory(db, timeZone);
    await db.query(`INSERT INTO app_flags (key, value) VALUES ('demo_history_seeded', 'true')`);
    log.push(`${n.detections} past detections, ${n.incidents} past incidents, ${n.sos} past SOS`);
  }
  log.push(`${RANGERS.length} demo rangers (PIN 2468), ${TOURISTS.length} demo tourists (PIN 1234)`);
  return log;
}

async function seedHistory(db: Db, timeZone: string) {
  let detections = 0;
  let incidents = 0;
  const rangers = RANGERS.map((r) => r.id);
  for (let d = 14; d >= 1; d--) {
    for (const area of AREAS) {
      const zones = await listZones(db, { areaId: area.id });
      const cams = CAMERAS.filter((c) => c.area === area.id);
      const count = Math.floor(rnd(3, 9));
      for (let i = 0; i < count; i++) {
        const at = new Date(Date.now() - d * 86_400_000 + rnd(-10, 10) * 3_600_000);
        const cam = pickOne(cams);
        const species = pickOne(SPECIES_MIX[area.id]!);
        const base = offset(offset(area.c, cam.at[0], 0), cam.at[1], 90);
        const p = offset(base, Math.random() < 0.25 ? rnd(0, 150) : rnd(150, 1300), rnd(0, 360));
        const conf = Math.round(rnd(0.5, 0.95) * 100) / 100;
        const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(at));
        const risk = assessRisk({
          species, confidence: conf, location: p, localHour: hour,
          zones: zones.map((z) => ({ id: z.id, name: z.name, sensitivity: z.sensitivity, occupancy: z.occupancy, buffer_m: z.buffer_m, geometry: z.geometry })),
        });
        const det = await db.query<{ id: number }>(
          `INSERT INTO detections (camera_id, area_id, captured_at, received_at, input, analysis, model, species, confidence, lat, lng, safety_zone_id,
                                   distance_m, inside_zone, risk_level, risk_score, risk_reasons, demo)
           VALUES ($1,$2,$3,$3,'simulated_camera','simulated','simulator',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true) RETURNING id`,
          [cam.id, area.id, at, species, conf, p[0], p[1], risk.zone?.id ?? null, risk.distanceM, risk.inside, risk.level, risk.score, JSON.stringify(risk.reasons)],
        );
        detections++;
        if ((risk.level === 'medium' || risk.level === 'high' || risk.level === 'critical') && risk.zone) {
          const sp = speciesProfile(species);
          const ack = new Date(at.getTime() + rnd(1, 14) * 60_000);
          const closed = new Date(ack.getTime() + rnd(8, 90) * 60_000);
          const falseAlarm = Math.random() < 0.15;
          const ranger = pickOne(rangers);
          const ev = await db.query<{ id: number }>(
            `INSERT INTO events (kind, camera_id, zone_label, class_label, confidence, first_seen_at, last_seen_at, opened_at, source, model, risk_level,
                                 area_id, lat, lng, title, safety_zone_id, risk_reasons, detection_id, demo, status, acknowledged_by, acknowledged_at,
                                 closed_by, closed_at, close_reason)
             VALUES ('wildlife',$1,$2,$3,$4,$5,$5,$5,'simulated','simulator',$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15,$16,$15,$17,$18) RETURNING id`,
            [cam.id, risk.zone.name, species, conf, at, risk.level, area.id, p[0], p[1], `${sp.name_en} ${risk.inside ? 'inside' : 'near'} ${risk.zone.name}`,
              risk.zone.id, JSON.stringify(risk.reasons), det.rows[0]!.id, falseAlarm ? 'false_alert' : 'closed', ranger, ack, closed,
              falseAlarm ? 'Other animal: not the species reported (demo)' : `${sp.name_en} moved away; guests informed by radio (demo)`],
          );
          const id = ev.rows[0]!.id;
          await db.query('UPDATE detections SET event_id = $2 WHERE id = $1', [det.rows[0]!.id, id]);
          await db.query(
            `INSERT INTO event_actions (event_id, actor, action, channel, note, created_at) VALUES
               ($1,'system:ai','opened',NULL,$2,$3), ($1,$4,'acknowledged','dashboard',NULL,$5),
               ($1,$4,'handoff','radio','Guides and lodge informed on channel 3 (demo)',$6), ($1,$4,$7,NULL,$8,$9)`,
            [id, `${sp.name_en} ${risk.level.toUpperCase()} risk (SIMULATED demo history)`, at, ranger, ack, new Date(ack.getTime() + 120_000),
              falseAlarm ? 'dismissed' : 'closed', falseAlarm ? 'Other animal: not the species reported (demo)' : `${sp.name_en} moved away (demo)`, closed],
          );
          incidents++;
        }
      }
    }
  }
  // A few resolved SOS reports from demo tourists.
  const tourists = (await db.query<{ id: number; name: string; area_id: string; phone: string; lodge: string }>('SELECT id, name, area_id, phone, lodge FROM tourists WHERE demo')).rows;
  const SOS: [string, string, number][] = [['medical', 'Guest fainted in the heat', 11], ['vehicle', 'Flat tyre on the main road', 8], ['wildlife', 'Buffalo standing next to our tent', 5], ['personal', 'Lost from walking group', 2]];
  let sos = 0;
  for (const [type, desc, daysAgo] of SOS) {
    const t = tourists[sos % tourists.length];
    if (!t) break;
    const area = AREAS.find((a) => a.id === t.area_id)!;
    const at = new Date(Date.now() - daysAgo * 86_400_000);
    const ack = new Date(at.getTime() + rnd(1, 6) * 60_000);
    const closed = new Date(ack.getTime() + rnd(20, 70) * 60_000);
    const ranger = pickOne(rangers);
    const label = { medical: 'Medical emergency', vehicle: 'Vehicle breakdown', wildlife: 'Dangerous wildlife', personal: 'Personal safety' }[type]!;
    const ev = await db.query<{ id: number }>(
      `INSERT INTO events (kind, source, first_seen_at, last_seen_at, opened_at, risk_level, area_id, lat, lng, title, description, tourist_id, emergency_type,
                           reporter_phone, report_channel, demo, zone_label, status, acknowledged_by, acknowledged_at, closed_by, closed_at, close_reason)
       VALUES ('sos','report',$1,$1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'app',true,$11,'closed',$12,$13,$12,$14,'Assisted by ranger team (demo)') RETURNING id`,
      [at, type === 'medical' || type === 'wildlife' ? 'critical' : 'high', t.area_id, area.c[0], area.c[1], `${label} — ${t.name}`, desc, t.id, type, t.phone,
        `${t.lodge}, ${area.name}`, ranger, ack, closed],
    );
    await db.query(
      `INSERT INTO event_actions (event_id, actor, action, channel, note, created_at) VALUES ($1,$2,'opened','dashboard',$3,$4), ($1,$5,'acknowledged','dashboard',NULL,$6), ($1,$5,'closed',NULL,'Assisted by ranger team (demo)',$7)`,
      [ev.rows[0]!.id, `tourist:${t.id}`, `SOS via APP: ${label}. "${desc}" (demo)`, at, ranger, ack, closed],
    );
    sos++;
  }
  return { detections, incidents, sos };
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  const cfg = loadConfig();
  const db = createPool(cfg.DATABASE_URL, 2);
  try {
    await migrate(db);
    const log = await seed(db, cfg.TIMEZONE);
    console.log(['Demo data ready:', ...log.map((l) => ` - ${l}`)].join('\n'));
  } finally {
    await db.end();
  }
}
