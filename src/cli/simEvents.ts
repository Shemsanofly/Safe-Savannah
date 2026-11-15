/**
 * Inject SYNTHETIC alerts (source='synthetic') so the dashboard and SMS path
 * can be built and tested without the vision pipeline. They are labelled
 * "SYNTHETIC TEST" on the dashboard and in the SMS.
 */
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { eventRef } from '../domain/eventRef.js';
import { loadZones } from '../domain/zones.js';
import { openEvent } from '../store/events.js';
import { flag, parseArgs } from './args.js';

const cfg = loadConfig();
const { flags } = parseArgs();
const zones = await loadZones(cfg.ZONES_FILE);
const zoneId = flag(flags, 'zone') ?? zones[0]!.id;
const zone = zones.find((z) => z.id === zoneId);
if (!zone) throw new Error(`Unknown zone ${zoneId}`);

const db = createPool(cfg.DATABASE_URL, 2);
try {
  await migrate(db);
  const now = Date.now();
  const { event, created } = await openEvent(
    db,
    {
      cameraId: zone.cameraId,
      zoneId: zone.id,
      zoneLabel: zone.label,
      classLabel: cfg.TARGET_CLASS,
      confidence: Number(flag(flags, 'confidence') ?? 0.71),
      bbox: { x1: 0.4, y1: 0.55, x2: 0.6, y2: 0.85 },
      firstSeenAt: new Date(now - 600),
      lastSeenAt: new Date(now),
      snapshotPath: null,
      source: 'synthetic',
      model: 'synthetic',
    },
    cfg.recipients.map((r) => r.alias),
  );
  console.log(created ? `Opened synthetic alert ${eventRef(event.id)} in ${zone.label}` : `Zone already has active alert ${eventRef(event.id)}; nothing created`);
} finally {
  await db.end();
}
