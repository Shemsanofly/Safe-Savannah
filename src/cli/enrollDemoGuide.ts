/** Import a user-selected reference photo into the simulated gate, never physical-gate enrollment. */
import { randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool, withTx } from '../db/pool.js';
import { decryptFace, FACE_MODEL_ID, rankFaces } from '../gate/biometrics.js';
import { httpGateTransport } from '../gate/controller.js';
import { FaceGateService } from '../gate/faceGate.js';
import { LocalFaceRuntime } from '../gate/faceRuntime.js';
import { demoFacePortraitPath } from '../paths.js';
import { setGatePermission } from '../store/gateAccess.js';
import { hashPin, OPERATOR_ID_RE } from '../store/operators.js';
import { flag, parseArgs } from './args.js';

const { flags } = parseArgs();
const photo = flag(flags, 'photo');
const zoneId = Number(flag(flags, 'zone'));
const staffId = flag(flags, 'id') ?? 'demo-guide';
const name = flag(flags, 'name')?.trim() ?? 'Demo guide';
const adminId = flag(flags, 'admin') ?? 'admin';
if (!photo || !Number.isSafeInteger(zoneId) || zoneId <= 0 || !OPERATOR_ID_RE.test(staffId) || name.length < 2 || name.length > 60) {
  throw new Error('Use --photo <local JPEG> --zone <zone ID> [--id demo-guide] [--name "Demo guide"] [--admin admin]');
}
const cfg = loadConfig();
if (cfg.GATE_CONTROLLER_MODE !== 'simulated' || !cfg.DEMO_CONTROLS) throw new Error('Photo samples are available only in simulated gate mode with demo controls enabled.');
const db = createPool(cfg.DATABASE_URL, 2);
const faces = new LocalFaceRuntime(cfg);
try {
  await migrate(db);
  const admin = (await db.query("SELECT id FROM operators WHERE id = $1 AND role = 'admin' AND active", [adminId])).rows[0];
  const zone = (await db.query('SELECT id,name,area_id FROM safety_zones WHERE id = $1 AND active', [zoneId])).rows[0];
  if (!admin || !zone) throw new Error('Choose an active admin and active attraction zone.');
  const jpeg = await sharp(await readFile(photo), { limitInputPixels: 40_000_000 }).rotate()
    .resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  const observation = await faces.extract(jpeg.toString('base64'));
  if (observation.count !== 1 || !observation.embedding || !observation.box) throw new Error('The sample must contain one clear face.');
  const privatePin = await hashPin(String(randomInt(10000000, 100000000)));
  await withTx(db, async (c) => {
    await c.query(`INSERT INTO operators (id,name,pin_hash,role,demo,on_duty,area_id)
      VALUES ($1,$2,$3,'ranger',true,false,$4) ON CONFLICT (id) DO NOTHING`, [staffId, name, privatePin, zone.area_id]);
    const staff = (await c.query<{ active: boolean; demo: boolean }>('SELECT active,demo FROM operators WHERE id = $1 FOR UPDATE', [staffId])).rows[0];
    if (!staff?.active || !staff.demo) throw new Error('That ID belongs to a non-demo or inactive account. Choose a different demo ID.');
    await c.query('UPDATE operators SET name = $2 WHERE id = $1', [staffId, name]);
  });
  const service = new FaceGateService(db, cfg, faces, httpGateTransport);
  await service.enrollDemoPhoto(adminId, staffId, jpeg.toString('base64'));
  const meta = await sharp(jpeg).metadata();
  const [x, y, w, h] = observation.box;
  const left = Math.max(0, Math.floor((x! - w! * .25) * meta.width!));
  const top = Math.max(0, Math.floor((y! - h! * .3) * meta.height!));
  const right = Math.min(meta.width!, Math.ceil((x! + w! * 1.25) * meta.width!));
  const bottom = Math.min(meta.height!, Math.ceil((y! + h! * 1.15) * meta.height!));
  const portrait = await sharp(jpeg).extract({ left, top, width: right - left, height: bottom - top }).resize({ width: 240 }).jpeg({ quality: 85 }).toBuffer();
  const portraitPath = demoFacePortraitPath(cfg.DATA_DIR, staffId);
  await mkdir(path.dirname(portraitPath), { recursive: true });
  await writeFile(portraitPath, portrait, { mode: 0o600 });
  await setGatePermission(db, adminId, { staffId, zoneId, active: true, expiresAt: null });
  const probe = await faces.extract((await sharp(jpeg).rotate(3).jpeg({ quality: 82 }).toBuffer()).toString('base64'));
  const profiles = (await db.query(`SELECT p.staff_id,p.encrypted_template FROM staff_face_profiles p JOIN operators o ON o.id=p.staff_id
    WHERE p.active AND o.active AND p.model_id=$1`, [FACE_MODEL_ID])).rows;
  const match = probe.embedding ? rankFaces(probe.embedding, profiles.map((p) => ({ staffId: p.staff_id, vector: decryptFace(p.staff_id, p.encrypted_template, cfg.FACE_TEMPLATE_KEY!) })), cfg.GATE_FACE_THRESHOLD, cfg.GATE_FACE_MARGIN) : null;
  if (match?.match?.staffId !== staffId) throw new Error('The enrolled reference did not pass the independent transformed-image match check.');
  console.log(`Enrolled ${name} (${staffId}) from the supplied reference photo. Authorized demo attraction: ${zone.name} (zone ${zoneId}).`);
  console.log(`Verified face match (${match.match.similarity.toFixed(3)} similarity). Enrollment is simulation-only; no physical gate command was issued.`);
} finally { faces.close(); await db.end(); }
