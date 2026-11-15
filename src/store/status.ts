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
  frameWidth?: number | null;
  frameHeight?: number | null;
}

/**
 * Worker heartbeat. Passing lastFrameAt means frames are flowing, so the
 * connection is marked 'streaming' and any reconnect counters are cleared.
 */
export async function upsertCamera(db: Queryable, hb: CameraHeartbeat): Promise<void> {
  const streaming = !!hb.lastFrameAt;
  await db.query(
    `INSERT INTO cameras (id, label, source_kind, detector, last_frame_at, last_inference_ms, processed_fps, dropped_frames,
                          frame_width, frame_height, connection_state, worker_seen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $11 THEN 'streaming' ELSE 'connecting' END, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       label = EXCLUDED.label, source_kind = EXCLUDED.source_kind, detector = EXCLUDED.detector,
       last_frame_at = COALESCE(EXCLUDED.last_frame_at, cameras.last_frame_at),
       last_inference_ms = COALESCE(EXCLUDED.last_inference_ms, cameras.last_inference_ms),
       processed_fps = COALESCE(EXCLUDED.processed_fps, cameras.processed_fps),
       dropped_frames = EXCLUDED.dropped_frames,
       frame_width = COALESCE(EXCLUDED.frame_width, cameras.frame_width),
       frame_height = COALESCE(EXCLUDED.frame_height, cameras.frame_height),
       connection_state = CASE WHEN $11 THEN 'streaming' ELSE EXCLUDED.connection_state END,
       reconnect_attempts = CASE WHEN $11 THEN 0 ELSE cameras.reconnect_attempts END,
       next_retry_at = CASE WHEN $11 THEN NULL ELSE cameras.next_retry_at END,
       worker_seen_at = now(),
       updated_at = now()`,
    [
      hb.id,
      hb.label,
      hb.sourceKind,
      hb.detector,
      hb.lastFrameAt ?? null,
      hb.lastInferenceMs ?? null,
      hb.processedFps ?? null,
      hb.droppedFrames ?? 0,
      hb.frameWidth ?? null,
      hb.frameHeight ?? null,
      streaming,
    ],
  );
}

/** The worker is alive but has no new frame to report (keeps "reconnecting" distinct from "offline"). */
export async function cameraWorkerHeartbeat(db: Queryable, cameraId: string): Promise<void> {
  await db.query(`UPDATE cameras SET worker_seen_at = now() WHERE id = $1`, [cameraId]);
}

/** Source failed; the worker will retry. Records the error and the retry plan. */
export async function recordCameraError(
  db: Queryable,
  cameraId: string,
  error: string,
  retry?: { attempt: number; retryInMs: number },
): Promise<void> {
  await db.query(
    `UPDATE cameras SET last_error = $2, last_error_at = now(), updated_at = now(), worker_seen_at = now(),
            connection_state = CASE WHEN $3::int IS NULL THEN connection_state ELSE 'reconnecting' END,
            reconnect_attempts = COALESCE($3::int, reconnect_attempts),
            next_retry_at = CASE WHEN $4::int IS NULL THEN next_retry_at ELSE now() + ($4::int * interval '1 millisecond') END
      WHERE id = $1`,
    [cameraId, error.slice(0, 500), retry?.attempt ?? null, retry?.retryInMs ?? null],
  );
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
