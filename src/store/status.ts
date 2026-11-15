import type { Queryable } from '../db/pool.js';

export interface CameraHeartbeat {
  id: string;
  label: string;
  sourceKind: string;
  detector: string;
  lastFrameAt?: Date | null;
  lastInferenceMs?: number | null;
  processedFps?: number | null;
  droppedFrames?: number;
}

export async function upsertCamera(db: Queryable, hb: CameraHeartbeat): Promise<void> {
  await db.query(
    `INSERT INTO cameras (id, label, source_kind, detector, last_frame_at, last_inference_ms, processed_fps, dropped_frames, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (id) DO UPDATE SET
       label = EXCLUDED.label, source_kind = EXCLUDED.source_kind, detector = EXCLUDED.detector,
       last_frame_at = COALESCE(EXCLUDED.last_frame_at, cameras.last_frame_at),
       last_inference_ms = COALESCE(EXCLUDED.last_inference_ms, cameras.last_inference_ms),
       processed_fps = COALESCE(EXCLUDED.processed_fps, cameras.processed_fps),
       dropped_frames = EXCLUDED.dropped_frames,
       updated_at = now()`,
    [hb.id, hb.label, hb.sourceKind, hb.detector, hb.lastFrameAt ?? null, hb.lastInferenceMs ?? null, hb.processedFps ?? null, hb.droppedFrames ?? 0],
  );
}

export async function recordCameraError(db: Queryable, cameraId: string, error: string): Promise<void> {
  await db.query(`UPDATE cameras SET last_error = $2, last_error_at = now(), updated_at = now() WHERE id = $1`, [cameraId, error.slice(0, 500)]);
}

export interface ZoneStatusUpdate {
  cameraId: string;
  zoneId: string;
  zoneLabel: string;
  state: string;
  inZone: boolean;
  streak: number;
  clearMs: number;
}

export async function upsertZoneStatus(db: Queryable, z: ZoneStatusUpdate): Promise<void> {
  await db.query(
    `INSERT INTO zone_status (camera_id, zone_id, zone_label, state, in_zone, streak, clear_ms, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (camera_id, zone_id) DO UPDATE SET
       zone_label = EXCLUDED.zone_label, state = EXCLUDED.state, in_zone = EXCLUDED.in_zone,
       streak = EXCLUDED.streak, clear_ms = EXCLUDED.clear_ms, updated_at = now()`,
    [z.cameraId, z.zoneId, z.zoneLabel, z.state, z.inZone, z.streak, Math.min(z.clearMs, 2_000_000_000)],
  );
}
