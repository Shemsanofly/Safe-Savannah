/**
 * Scripted wildlife-camera simulator. Every detection it produces is stored with
 * analysis='simulated' and input='simulated_camera' and is labelled SIMULATED in
 * every interface and message. It exists so the full workflow can be demonstrated
 * before real cameras and models are installed.
 */
import type { Db } from '../db/pool.js';
import { polygonCentroid, type LatLng } from '../domain/geo.js';
import { listCameras, listZones, processDetection, type MessagingOpts, type ProcessedDetection, type ZoneRow } from '../store/platform.js';

const AREA_SPECIES: Record<string, [string, number][]> = {
  'serengeti-seronera': [['wildebeest', 30], ['zebra', 20], ['giraffe', 8], ['lion', 10], ['elephant', 8], ['buffalo', 8], ['hyena', 8], ['cheetah', 4], ['baboon', 4]],
  'ngorongoro-crater': [['buffalo', 18], ['zebra', 20], ['wildebeest', 20], ['lion', 8], ['hyena', 10], ['elephant', 10], ['rhino', 4], ['hippo', 4], ['baboon', 6]],
  'tarangire-river': [['elephant', 30], ['giraffe', 12], ['zebra', 14], ['buffalo', 12], ['lion', 8], ['baboon', 8], ['wildebeest', 8], ['hippo', 4], ['leopard', 4]],
};

function pick<T>(weighted: [T, number][]): T {
  const total = weighted.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of weighted) if ((r -= w) <= 0) return v;
  return weighted[0]![0];
}

/** Move a point by metres along a bearing (degrees). */
export function offset([lat, lng]: LatLng, metres: number, bearingDeg: number): LatLng {
  const b = (bearingDeg * Math.PI) / 180;
  const dLat = (metres * Math.cos(b)) / 111_320;
  const dLng = (metres * Math.sin(b)) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lng + dLng];
}

/** Rough radius of a polygon around its centroid, metres. */
function radiusM(z: ZoneRow): number {
  const c = polygonCentroid(z.geometry);
  return Math.max(...z.geometry.map(([la, ln]) => Math.hypot((la - c[0]) * 111_320, (ln - c[1]) * 111_320 * Math.cos((c[0] * Math.PI) / 180))));
}

export interface Scenario {
  id: string;
  label: string;
  description: string;
  area: string;
  zoneKind: string;
  species: string;
  confidence: number;
  /** Metres outside the zone edge (0 = inside at the centre). */
  outsideM: number;
}

export const SCENARIOS: Scenario[] = [
  { id: 'lion_camp', label: 'Lion near tented camp', description: 'A lion 60 m from the Seronera tented camp — expect a HIGH/CRITICAL alert, ranger SMS + voice and tourist SMS.', area: 'serengeti-seronera', zoneKind: 'camp', species: 'lion', confidence: 0.86, outsideM: 60 },
  { id: 'elephant_lodge', label: 'Elephant inside lodge grounds', description: 'An elephant inside the Tarangire lodge guest area.', area: 'tarangire-river', zoneKind: 'lodge', species: 'elephant', confidence: 0.91, outsideM: 0 },
  { id: 'buffalo_trail', label: 'Buffalo on walking trail', description: 'A buffalo on the crater-rim walking trail (daytime use).', area: 'ngorongoro-crater', zoneKind: 'trail', species: 'buffalo', confidence: 0.74, outsideM: 0 },
  { id: 'hippo_picnic', label: 'Hippo near river picnic site', description: 'A hippo 80 m from the Tarangire river picnic site.', area: 'tarangire-river', zoneKind: 'picnic', species: 'hippo', confidence: 0.68, outsideM: 80 },
  { id: 'giraffe_lodge', label: 'Giraffe walks through lodge', description: 'A giraffe inside the lodge grounds — logged as LOW risk, no alert. Shows that crossing a boundary is not automatically dangerous.', area: 'tarangire-river', zoneKind: 'lodge', species: 'giraffe', confidence: 0.93, outsideM: 0 },
  { id: 'zebra_road', label: 'Zebra crossing the road', description: 'Zebras on the Seronera road — low risk, no alert.', area: 'serengeti-seronera', zoneKind: 'road', species: 'zebra', confidence: 0.88, outsideM: 0 },
  { id: 'elephant_far', label: 'Elephant far from people', description: 'An elephant 2 km from any safety zone — logged, no alert.', area: 'tarangire-river', zoneKind: 'lodge', species: 'elephant', confidence: 0.9, outsideM: 2000 },
];

export async function runScenario(db: Db, id: string, opts: MessagingOpts): Promise<ProcessedDetection & { scenario: Scenario }> {
  const sc = SCENARIOS.find((s) => s.id === id);
  if (!sc) throw Object.assign(new Error(`Unknown scenario "${id}"`), { status: 400 });
  const zones = await listZones(db, { areaId: sc.area });
  const zone = zones.find((z) => z.kind === sc.zoneKind) ?? zones[0];
  if (!zone) throw Object.assign(new Error(`No safety zones in ${sc.area}. Run "npm run seed" first.`), { status: 409 });
  const cams = (await listCameras(db)).filter((c) => c.area_id === sc.area && c.lat !== null);
  const centre = polygonCentroid(zone.geometry);
  const point = sc.outsideM === 0 ? centre : offset(centre, radiusM(zone) + sc.outsideM, Math.random() * 360);
  const result = await processDetection(
    db,
    {
      cameraId: cams.find((c) => c.station_kind === 'simulated')?.id ?? cams[0]?.id ?? null,
      areaId: sc.area,
      lat: point[0],
      lng: point[1],
      capturedAt: new Date(),
      input: 'simulated_camera',
      analysis: 'simulated',
      model: 'scenario:' + sc.id,
      species: sc.species,
      confidence: sc.confidence,
    },
    opts,
  );
  return { ...result, scenario: sc };
}

/** One random background detection from a random simulated camera. */
export async function randomTick(db: Db, opts: MessagingOpts): Promise<ProcessedDetection | null> {
  const cams = (await listCameras(db)).filter((c) => c.station_kind === 'simulated' && c.lat !== null && c.area_id);
  if (!cams.length) return null;
  const cam = cams[Math.floor(Math.random() * cams.length)]!;
  const species = pick(AREA_SPECIES[cam.area_id!] ?? [['zebra', 1]]);
  // Animals are usually some distance from the camera's mid-point; occasionally very close.
  const dist = Math.random() < 0.2 ? Math.random() * 150 : 150 + Math.random() * 1200;
  const [lat, lng] = offset([cam.lat!, cam.lng!], dist, Math.random() * 360);
  return processDetection(
    db,
    {
      cameraId: cam.id,
      areaId: cam.area_id,
      lat,
      lng,
      capturedAt: new Date(),
      input: 'simulated_camera',
      analysis: 'simulated',
      model: 'simulator',
      species,
      confidence: Math.round((0.45 + Math.random() * 0.5) * 100) / 100,
    },
    opts,
  );
}

export async function simulatorPaused(db: Db): Promise<boolean> {
  const r = await db.query<{ value: boolean }>(`SELECT value FROM app_flags WHERE key = 'simulator_paused'`);
  return r.rows[0]?.value === true;
}

export async function setSimulatorPaused(db: Db, paused: boolean): Promise<void> {
  await db.query(
    `INSERT INTO app_flags (key, value, updated_at) VALUES ('simulator_paused', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(paused)],
  );
}
