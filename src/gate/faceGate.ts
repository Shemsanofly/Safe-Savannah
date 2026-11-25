import { randomInt, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { AppConfig } from '../config.js';
import { withTx, type Db, type DbClient } from '../db/pool.js';
import { DomainError } from '../store/events.js';
import { recordGuideEntry } from '../store/tours.js';
import { demoFacePortraitPath } from '../paths.js';
import { cosine, decryptFace, encryptFace, enrollmentVector, FACE_MODEL_ID, rankFaces } from './biometrics.js';
import { dispatchGate, expireSimulatedCycles, gateState, verifyCurrentAuthorization, type GateCommand, type GateTransport } from './controller.js';
import type { FaceExtractor, FaceObservation } from './faceRuntime.js';

interface Profile { staff_id: string; name: string; version: string; encrypted_template: string; }
interface Challenge {
  id: string; actor_id: string; zone_id: number; tourist_count: number; direction: number;
  phase: 'approach' | 'turn' | 'return' | 'complete' | 'denied'; staff_id: string | null; profile_version: string | null;
  base_yaw: number | null; last_frame_at: Date | null; frame_hashes: string[]; frames: number;
  minimum_similarity: number | null; trusted_liveness_at: Date | null; trusted_liveness_hash: string | null; expires_at: Date;
}

export class FaceGateService {
  constructor(private db: Db, private cfg: AppConfig, private faces: FaceExtractor, private transport: GateTransport) {}
  private key() {
    if (!this.cfg.FACE_TEMPLATE_KEY) throw new DomainError(503, 'face_key_missing', 'Face enrollment is not configured. An admin must set FACE_TEMPLATE_KEY; the gate stays closed.');
    return this.cfg.FACE_TEMPLATE_KEY;
  }
  private async actor(c: DbClient, id: string, admin = false) {
    const row = (await c.query<{ active: boolean; role: string }>('SELECT active, role FROM operators WHERE id = $1 FOR SHARE', [id])).rows[0];
    if (!row?.active || (admin && row.role !== 'admin')) throw new DomainError(403, 'forbidden', 'An active authorized staff session is required.');
  }
  private async profiles(c: DbClient) {
    return (await c.query<Profile>(`SELECT p.staff_id, o.name, p.version, p.encrypted_template FROM staff_face_profiles p
      JOIN operators o ON o.id = p.staff_id WHERE p.active AND o.active AND p.model_id = $1
      AND (p.enrollment_kind IN ('live','reference_photo') OR $2)`, [FACE_MODEL_ID, this.cfg.GATE_CONTROLLER_MODE === 'simulated'])).rows;
  }
  async status(admin: boolean, zoneId?: number) {
    let available = false;
    let reason: string | null = null;
    try { this.key(); await this.faces.ready(); available = true; } catch (error) { reason = error instanceof DomainError ? error.message : 'The local face-recognition runtime is unavailable.'; }
    const profiles = admin ? (await this.db.query(`SELECT p.staff_id, o.name, p.active, o.active AS staff_active, p.updated_at, p.enrollment_kind
      FROM staff_face_profiles p JOIN operators o ON o.id = p.staff_id ORDER BY o.name`)).rows.map((p) => ({ ...p,
        portraitUrl: p.active ? `/api/gate/face/${encodeURIComponent(p.staff_id)}/portrait` : null })) : [];
    return { available, reason, model: FACE_MODEL_ID, profiles, mode: this.cfg.GATE_CONTROLLER_MODE,
      trustedLivenessRequired: this.cfg.GATE_CONTROLLER_MODE === 'http', gate: zoneId ? await gateState(this.db, this.cfg, zoneId) : null };
  }
  async enroll(actorId: string, staffId: string, images: string[], consent: boolean) {
    this.key();
    if (!consent) throw new DomainError(400, 'face_consent', 'Confirm the staff member agreed to face enrollment.');
    const samples: FaceObservation[] = [];
    for (const image of images) samples.push(await this.faces.extract(image));
    if (samples.some((s) => s.count !== 1 || !s.embedding) || new Set(samples.map((s) => s.hash)).size !== 3) {
      throw new DomainError(422, 'face_samples', 'Capture three different live frames showing only this staff member’s face.');
    }
    const vector = enrollmentVector(samples.map((s) => s.embedding!), this.cfg.GATE_FACE_THRESHOLD);
    await this.saveEnrollment(actorId, staffId, vector, 'live');
    return { faceBox: samples[0]!.box };
  }
  async enrollDemoPhoto(actorId: string, staffId: string, image: string) {
    if (this.cfg.GATE_CONTROLLER_MODE !== 'simulated' || !this.cfg.DEMO_CONTROLS) {
      throw new DomainError(403, 'demo_photo_disabled', 'Reference-photo enrollment is available only in the simulated demo.');
    }
    const observation = await this.faces.extract(image);
    if (observation.count !== 1 || !observation.embedding) throw new DomainError(422, 'face_samples', 'The reference photo must contain exactly one clear face.');
    await this.saveEnrollment(actorId, staffId, observation.embedding, 'demo_photo');
    return { faceBox: observation.box };
  }
  async enrollReferencePhoto(actorId: string, staffId: string, image: string, consent: boolean) {
    if (!consent) throw new DomainError(400, 'face_consent', 'Confirm that the staff member authorized use of this reference photo.');
    const observation = await this.faces.extract(image);
    if (observation.count !== 1 || !observation.embedding) throw new DomainError(422, 'face_samples', 'The reference must contain exactly one clear face.');
    await this.saveEnrollment(actorId, staffId, observation.embedding, 'reference_photo');
    return { faceBox: observation.box };
  }
  /** Admin diagnostic only: never reserves or dispatches an opening command. */
  async compareReference(actorId: string, zoneId: number, image: string) {
    if (this.cfg.GATE_CONTROLLER_MODE !== 'simulated' || !this.cfg.DEMO_CONTROLS) throw new DomainError(403, 'demo_disabled', 'Photo demonstration is available only in simulated mode.');
    const observation = await this.faces.extract(image);
    return withTx(this.db, async (c) => {
      await this.actor(c, actorId, true);
      if (observation.count !== 1 || !observation.embedding) return { recognized: false, authorized: false, reason: observation.count ? 'multiple_faces' : 'no_face', instruction: 'Use a picture with one clear, front-facing face.', gateCommandSent: false };
      const profiles = await this.profiles(c);
      const result = rankFaces(observation.embedding, profiles.map((p) => ({ staffId: p.staff_id, vector: decryptFace(p.staff_id, p.encrypted_template, this.key()) })), this.cfg.GATE_FACE_THRESHOLD, this.cfg.GATE_FACE_MARGIN);
      if (!result.match) return { recognized: false, authorized: false, reason: result.reason, instruction: 'This face did not match an enrolled staff reference.', gateCommandSent: false };
      const staff = profiles.find((p) => p.staff_id === result.match!.staffId)!;
      let authorized = true;
      try { await verifyCurrentAuthorization(c, { staff_id: staff.staff_id, profile_version: staff.version, actor_id: actorId, zone_id: zoneId }, true); }
      catch (error) { if (!(error instanceof DomainError)) throw error; authorized = false; }
      const allowed = (await c.query<{ id: number; name: string }>(`SELECT z.id,z.name FROM staff_gate_permissions p JOIN safety_zones z ON z.id=p.zone_id
        WHERE p.staff_id=$1 AND p.active AND z.active AND (p.expires_at IS NULL OR p.expires_at > clock_timestamp())`, [staff.staff_id])).rows;
      return { recognized: true, authorized, staff: { id: staff.staff_id, name: staff.name }, similarity: result.match.similarity, reason: authorized ? 'authorized' : 'no_permission',
        authorizedAttractions: allowed, instruction: authorized ? `Face matched ${staff.name}. Access is authorized for this attraction.`
          : `Face matched ${staff.name}, but this attraction is not authorized.${allowed.length ? ` Authorized locations: ${allowed.map((z) => z.name).join(', ')}.` : ''}`, gateCommandSent: false };
    });
  }
  private async saveEnrollment(actorId: string, staffId: string, vector: number[], kind: 'live' | 'reference_photo' | 'demo_photo') {
    const key = this.key();
    await withTx(this.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(727277)');
      await this.actor(c, actorId, true);
      const staff = (await c.query<{ active: boolean; demo: boolean }>('SELECT active, demo FROM operators WHERE id = $1 FOR SHARE', [staffId])).rows[0];
      if (!staff?.active) throw new DomainError(400, 'staff_unavailable', 'Choose an active staff account to enroll.');
      if (kind === 'demo_photo' && (!staff.demo || this.cfg.GATE_CONTROLLER_MODE !== 'simulated' || !this.cfg.DEMO_CONTROLS)) {
        throw new DomainError(403, 'demo_account_required', 'Reference photos can enroll only a demo staff account in simulated mode.');
      }
      for (const profile of await this.profiles(c)) {
        if (profile.staff_id !== staffId && cosine(vector, decryptFace(profile.staff_id, profile.encrypted_template, key)) >= this.cfg.GATE_FACE_THRESHOLD) {
          throw new DomainError(409, 'duplicate_face', 'This face is too similar to another enrolled staff member. Resolve the enrollment with an admin.');
        }
      }
      await c.query(`INSERT INTO staff_face_profiles (staff_id,version,model_id,encrypted_template,consent_at,enrolled_by,enrollment_kind)
        VALUES ($1,$2,$3,$4,CASE WHEN $6 <> 'demo_photo' THEN now() ELSE NULL END,$5,$6) ON CONFLICT (staff_id) DO UPDATE SET version = EXCLUDED.version, model_id = EXCLUDED.model_id,
        encrypted_template = EXCLUDED.encrypted_template, active = true, consent_at = EXCLUDED.consent_at, enrolled_by = EXCLUDED.enrolled_by, updated_at = now(), enrollment_kind = EXCLUDED.enrollment_kind`,
        [staffId, randomUUID(), FACE_MODEL_ID, encryptFace(staffId, vector, key), actorId, kind]);
      await c.query("INSERT INTO staff_face_audit (staff_id,actor_id,action,enrollment_kind) VALUES ($1,$2,'enrolled',$3)", [staffId, actorId, kind]);
    });
    if (kind !== 'demo_photo') await unlink(demoFacePortraitPath(this.cfg.DATA_DIR, staffId)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  async erase(actorId: string, staffId: string) {
    const erasedKind = await withTx(this.db, async (c) => {
      await this.actor(c, actorId, true);
      const r = await c.query('UPDATE staff_face_profiles SET active = false, encrypted_template = NULL, version = $2, updated_at = now() WHERE staff_id = $1 RETURNING enrollment_kind', [staffId, randomUUID()]);
      if (!r.rowCount) throw new DomainError(404, 'face_not_enrolled', 'No face enrollment exists for this staff member.');
      await c.query("INSERT INTO staff_face_audit (staff_id,actor_id,action) VALUES ($1,$2,'erased')", [staffId, actorId]);
      return r.rows[0].enrollment_kind;
    });
    if (erasedKind) await unlink(demoFacePortraitPath(this.cfg.DATA_DIR, staffId)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  async begin(actorId: string, zoneId: number, touristCount: number) {
    this.key();
    await this.faces.ready();
    if (this.cfg.GATE_CONTROLLER_MODE === 'http' && (zoneId !== this.cfg.GATE_CONTROLLER_ZONE_ID || actorId !== this.cfg.GATE_STATION_OPERATOR_ID)) {
      throw new DomainError(403, 'wrong_station', 'This signed-in station is not configured for that physical gate.');
    }
    return withTx(this.db, async (c) => {
      await this.actor(c, actorId);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('face-station:' || $1, 0))", [actorId]);
      if (!(await c.query('SELECT id FROM safety_zones WHERE id = $1 AND active FOR SHARE', [zoneId])).rowCount) throw new DomainError(404, 'zone_unavailable', 'Choose an active attraction zone.');
      const recent = Number((await c.query("SELECT count(*) AS n FROM face_gate_challenges WHERE actor_id = $1 AND created_at > now() - interval '5 minutes'", [actorId])).rows[0].n);
      if (recent >= 30) throw new DomainError(429, 'face_rate_limit', 'Too many gate sessions. Keep the gate closed and ask an attendant to review.');
      await expireSimulatedCycles(c, zoneId);
      if ((await c.query("SELECT id FROM gate_open_commands WHERE zone_id = $1 AND status IN ('reserved','sending','accepted','open','unknown') LIMIT 1", [zoneId])).rowCount) {
        throw new DomainError(409, 'gate_cycle_active', 'The previous gate cycle is still active or unconfirmed. Wait for the gate to close; contact the attendant if its state is unknown.');
      }
      await c.query("UPDATE face_gate_challenges SET phase = 'denied' WHERE actor_id = $1 AND phase IN ('approach','turn','return')", [actorId]);
      await c.query("DELETE FROM face_gate_challenges WHERE expires_at < now() - interval '1 day'");
      const id = randomUUID();
      await c.query('INSERT INTO face_gate_challenges (id,actor_id,zone_id,tourist_count,direction) VALUES ($1,$2,$3,$4,$5)', [id, actorId, zoneId, touristCount, randomInt(2) ? 1 : -1]);
      return { challengeId: id, state: 'waiting_face', instruction: 'The guide should face the camera. Accompanying tourists should stand behind the guide.' };
    });
  }
  private async deny(c: DbClient, challenge: Challenge, reason: string, staffId: string | null = challenge.staff_id) {
    await c.query("UPDATE face_gate_challenges SET phase = 'denied' WHERE id = $1", [challenge.id]);
    const attempt = (await c.query(`INSERT INTO gate_access_attempts
      (zone_id,claimed_staff_id,staff_id,checked_by,decision,reason,identity_confirmed,method,tourist_count,face_similarity)
      VALUES ($1,$2,$3,$4,'denied',$5,false,'face',$6,$7) RETURNING id`,
      [challenge.zone_id, staffId ?? '', staffId, challenge.actor_id, reason, challenge.tourist_count, challenge.minimum_similarity])).rows[0];
    if (reason === 'no_permission' && staffId) {
      const staff = (await c.query<{ name: string }>('SELECT name FROM operators WHERE id=$1', [staffId])).rows[0];
      const zone = (await c.query<{ name: string }>('SELECT name FROM safety_zones WHERE id=$1', [challenge.zone_id])).rows[0];
      const allowed = (await c.query<{ id: number; name: string }>(`SELECT z.id,z.name FROM staff_gate_permissions p JOIN safety_zones z ON z.id=p.zone_id
        WHERE p.staff_id=$1 AND p.active AND z.active AND (p.expires_at IS NULL OR p.expires_at > clock_timestamp())`, [staffId])).rows;
      return { state: 'denied', reason, faceMatched: true, guide: { staffId, name: staff?.name ?? staffId }, authorizedAttractions: allowed, attemptId: attempt.id,
        instruction: `Face matched ${staff?.name ?? staffId}, but access is not granted for ${zone?.name ?? 'this gate'}.${allowed.length ? ` Authorized locations: ${allowed.map((z) => z.name).join(', ')}.` : ''} Ask an admin to update the attraction permission.` };
    }
    const instruction = reason === 'face_not_enrolled' ? 'No active staff reference pictures are enrolled. Ask an admin to add staff in Staff management.'
      : reason === 'face_ambiguous' ? 'The face match is ambiguous. Use a clear, front-facing view and ask an admin to review the reference picture.'
      : reason === 'face_changed' ? 'The person or reference picture changed during verification. Start a fresh check.' : 'Face not recognized. The gate stays closed. Ask an admin to check the reference picture.';
    return { state: 'denied', reason, faceMatched: false, attemptId: attempt.id, instruction };
  }
  async scan(actorId: string, challengeId: string, image: string) {
    this.key();
    const existing = (await this.db.query<Challenge>('SELECT * FROM face_gate_challenges WHERE id = $1 AND actor_id = $2', [challengeId, actorId])).rows[0];
    if (!existing) throw new DomainError(404, 'challenge_missing', 'Start a new gate session.');
    if (existing.phase === 'complete') return { state: 'complete', gate: await gateState(this.db, this.cfg, existing.zone_id) };
    if (existing.phase === 'denied' || existing.expires_at.getTime() <= Date.now()) throw new DomainError(410, 'challenge_expired', 'This recognition session ended. Start again.');
    if (existing.frames >= 60 || (existing.last_frame_at && Date.now() - existing.last_frame_at.getTime() < 250)) throw new DomainError(429, 'face_scan_limit', 'Wait before sending another camera frame.');
    const observation = await this.faces.extract(image);
    const outcome = await withTx(this.db, async (c) => {
      const challenge = (await c.query<Challenge>('SELECT * FROM face_gate_challenges WHERE id = $1 AND actor_id = $2 FOR UPDATE', [challengeId, actorId])).rows[0]!;
      await this.actor(c, actorId);
      if (challenge.phase === 'complete') return { state: 'complete', commandId: (await c.query('SELECT id FROM gate_open_commands WHERE challenge_id = $1', [challenge.id])).rows[0]?.id as string | undefined };
      if (challenge.phase === 'denied' || challenge.expires_at.getTime() <= Date.now()) throw new DomainError(410, 'challenge_expired', 'This recognition session ended. Start again.');
      if (challenge.frames >= 60 || (challenge.last_frame_at && Date.now() - challenge.last_frame_at.getTime() < 250)) throw new DomainError(429, 'face_scan_limit', 'Wait before sending another camera frame.');
      await c.query('UPDATE face_gate_challenges SET frames = frames + 1, last_frame_at = now() WHERE id = $1', [challenge.id]);
      if (observation.count !== 1) return { state: 'waiting_face', instruction: observation.count ? 'More than one face is visible. Only the guide should stand in the recognition area.' : 'Waiting for the guide’s face. Look toward the camera.' };
      const verifiedSensorFrame = this.cfg.GATE_CONTROLLER_MODE === 'http' && challenge.phase === 'return' &&
        challenge.trusted_liveness_hash === observation.hash && challenge.trusted_liveness_at && Date.now() - challenge.trusted_liveness_at.getTime() <= 5000;
      if (challenge.frame_hashes.includes(observation.hash) && !verifiedSensorFrame) {
        const awaitingThisFrame = this.cfg.GATE_CONTROLLER_MODE === 'http' && challenge.phase === 'return' &&
          challenge.frame_hashes.at(-1) === observation.hash && Math.abs(observation.yaw! - challenge.base_yaw!) <= .08;
        return awaitingThisFrame
          ? { state: 'waiting_sensor', challengeId, frameHash: observation.hash, instruction: 'Waiting for the gate camera’s trusted anti-spoof check. The barrier remains closed.' }
          : { state: 'waiting_motion', instruction: 'A new live camera frame is required. Move naturally and follow the prompt.' };
      }
      const profiles = await this.profiles(c);
      const ranked = rankFaces(observation.embedding!, profiles.map((p) => ({ staffId: p.staff_id, vector: decryptFace(p.staff_id, p.encrypted_template, this.key()) })), this.cfg.GATE_FACE_THRESHOLD, this.cfg.GATE_FACE_MARGIN);
      if (!ranked.match) return this.deny(c, challenge, profiles.length ? ranked.reason! : 'face_not_enrolled');
      const profile = profiles.find((p) => p.staff_id === ranked.match!.staffId)!;
      if (challenge.staff_id && (challenge.staff_id !== profile.staff_id || challenge.profile_version !== profile.version)) return this.deny(c, challenge, 'face_changed');
      const identity = { staff_id: profile.staff_id, zone_id: challenge.zone_id, profile_version: profile.version, actor_id: actorId };
      challenge.minimum_similarity = Math.min(challenge.minimum_similarity ?? 1, ranked.match.similarity);
      try { await verifyCurrentAuthorization(c, identity, this.cfg.GATE_CONTROLLER_MODE === 'simulated'); } catch (error) {
        if (error instanceof DomainError) return this.deny(c, challenge, 'no_permission', profile.staff_id);
        throw error;
      }
      const yaw = observation.yaw!;
      const guide = { staffId: profile.staff_id, name: profile.name };
      const hashList = [...new Set([...challenge.frame_hashes, observation.hash])];
      const similarity = Math.min(challenge.minimum_similarity ?? 1, ranked.match.similarity);
      await c.query('UPDATE face_gate_challenges SET frame_hashes = $2, minimum_similarity = $3 WHERE id = $1', [challenge.id, JSON.stringify(hashList), similarity]);
      if (challenge.phase === 'approach') {
        if (Math.abs(yaw) > 0.2) return { state: 'waiting_face', instruction: 'Look straight at the camera to begin.', guide };
        const nextPhase = this.cfg.GATE_CONTROLLER_MODE === 'http' ? 'return' : 'turn';
        await c.query('UPDATE face_gate_challenges SET phase = $5, staff_id = $2, profile_version = $3, base_yaw = $4 WHERE id = $1', [challenge.id, profile.staff_id, profile.version, yaw, nextPhase]);
        if (nextPhase === 'turn') return { state: 'turn', direction: challenge.direction, guide, instruction: `Turn slightly so your nose moves toward the ${challenge.direction === 1 ? 'right' : 'left'} side of the preview.` };
        // A trusted physical PAD camera can verify the arrival passively; no per-arrival PIN or head turn is required.
        challenge.phase = 'return';
        challenge.base_yaw = yaw;
        challenge.staff_id = profile.staff_id;
        challenge.profile_version = profile.version;
      }
      if (challenge.phase === 'turn') {
        if ((yaw - challenge.base_yaw!) * challenge.direction < 0.14) return { state: 'turn', direction: challenge.direction, guide, instruction: `Move your nose toward the ${challenge.direction === 1 ? 'right' : 'left'} side of the preview.` };
        await c.query("UPDATE face_gate_challenges SET phase = 'return' WHERE id = $1", [challenge.id]);
        return { state: 'return', guide, instruction: 'Now look straight at the camera again.' };
      }
      if (Math.abs(yaw - challenge.base_yaw!) > 0.08) return { state: 'return', guide, instruction: 'Look straight at the camera again.' };
      if (this.cfg.GATE_CONTROLLER_MODE === 'http' && (!challenge.trusted_liveness_at || Date.now() - challenge.trusted_liveness_at.getTime() > 5000 || challenge.trusted_liveness_hash !== observation.hash)) {
        return { state: 'waiting_sensor', guide, challengeId, frameHash: observation.hash, instruction: 'Waiting for the gate camera’s trusted anti-spoof check. The barrier remains closed.' };
      }
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('physical-gate:' || $1::text, 0))", [challenge.zone_id]);
      await expireSimulatedCycles(c, challenge.zone_id);
      const busy = (await c.query(`SELECT id FROM gate_open_commands WHERE zone_id = $1 AND
        (status IN ('reserved','sending','accepted','open','unknown') OR (staff_id = $2 AND created_at > clock_timestamp() - interval '30 seconds')) LIMIT 1`, [challenge.zone_id, profile.staff_id])).rowCount;
      if (busy) throw new DomainError(409, 'gate_cycle_active', 'A gate cycle or guide cooldown is active. Wait for the attendant before starting another entry.');
      // Recheck while the command is reserved; these locks also serialize revocation against authorization.
      await verifyCurrentAuthorization(c, identity, this.cfg.GATE_CONTROLLER_MODE === 'simulated');
      const attemptId = (await c.query(`INSERT INTO gate_access_attempts
        (zone_id,claimed_staff_id,staff_id,checked_by,decision,reason,identity_confirmed,method,tourist_count,face_similarity)
        VALUES ($1,$2,$2,$3,'allowed','face_authorized',true,'face',$4,$5) RETURNING id`, [challenge.zone_id, profile.staff_id, actorId, challenge.tourist_count, similarity])).rows[0].id;
      const commandId = randomUUID();
      await c.query(`INSERT INTO gate_open_commands (id,challenge_id,attempt_id,zone_id,staff_id,profile_version,actor_id,tourist_count,mode)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [commandId, challenge.id, attemptId, challenge.zone_id, profile.staff_id, profile.version, actorId, challenge.tourist_count, this.cfg.GATE_CONTROLLER_MODE]);
      await c.query("UPDATE face_gate_challenges SET phase = 'complete' WHERE id = $1", [challenge.id]);
      // Link the entry to the guide's tour group for today, if any (never blocks the entry).
      const tourGroup = await recordGuideEntry(c, { staffId: profile.staff_id, zoneId: challenge.zone_id, attemptId: Number(attemptId), declared: challenge.tourist_count, method: 'face', timeZone: this.cfg.TIMEZONE });
      return { state: 'complete', commandId, guide, touristCount: challenge.tourist_count, tourGroup, instruction: 'Guide recognized and attraction access verified.' };
    });
    if ('commandId' in outcome && outcome.commandId) await dispatchGate(this.db, this.cfg, outcome.commandId, this.transport);
    return { ...outcome, faceBox: observation.box ?? null, gate: await gateState(this.db, this.cfg, existing.zone_id) };
  }
  async cancel(actorId: string, challengeId: string) {
    await this.db.query("UPDATE face_gate_challenges SET phase = 'denied' WHERE id = $1 AND actor_id = $2 AND phase IN ('approach','turn','return')", [challengeId, actorId]);
  }
  async attestLiveness(challengeId: string, hash: string, passed: boolean, capturedAt: string) {
    const age = Date.now() - Date.parse(capturedAt);
    if (age < -2000 || age > 5000) throw new DomainError(400, 'stale_liveness', 'The liveness observation is stale.');
    return withTx(this.db, async (c) => {
      const challenge = (await c.query<Challenge>('SELECT * FROM face_gate_challenges WHERE id = $1 FOR UPDATE', [challengeId])).rows[0];
      if (!challenge || challenge.zone_id !== this.cfg.GATE_CONTROLLER_ZONE_ID || challenge.actor_id !== this.cfg.GATE_STATION_OPERATOR_ID || ['complete', 'denied'].includes(challenge.phase) || challenge.expires_at.getTime() <= Date.now()) {
        throw new DomainError(409, 'liveness_session', 'This liveness session is unavailable.');
      }
      if (!passed) return this.deny(c, challenge, 'face_liveness_failed');
      await c.query('UPDATE face_gate_challenges SET trusted_liveness_at = now(), trusted_liveness_hash = $2 WHERE id = $1', [challenge.id, hash]);
      return { ok: true };
    });
  }
}
