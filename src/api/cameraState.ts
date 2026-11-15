import type { CameraRow } from '../store/dashboard.js';

/**
 * live         – frames are fresh
 * reconnecting – the camera worker is running and retrying a failed source
 * stale        – the worker is running and thinks the source is connected, but no fresh frame has arrived
 * offline      – the worker is not reporting at all (or has never produced a frame and is not trying)
 *
 * Every state except "live" means the zone status is UNKNOWN.
 */
export type CameraFeedState = 'live' | 'reconnecting' | 'stale' | 'offline';

/** Worker heartbeats older than this mean the camera worker itself is not running. */
export const WORKER_ALIVE_MS = 15_000;

export function cameraFeedState(
  c: Pick<CameraRow, 'last_frame_at'> & { worker_seen_at: Date | null; connection_state: string },
  staleSeconds: number,
  now = Date.now(),
): CameraFeedState {
  if (c.last_frame_at && now - c.last_frame_at.getTime() <= staleSeconds * 1000) return 'live';
  const workerAlive = !!c.worker_seen_at && now - c.worker_seen_at.getTime() <= WORKER_ALIVE_MS;
  if (!workerAlive) return 'offline';
  if (c.connection_state === 'reconnecting' || c.connection_state === 'connecting') return 'reconnecting';
  return 'stale';
}

/** "inference:yolo11n@399c995c" → { kind, model } */
export function parseDetector(detector: string): { kind: 'inference' | 'simulated' | 'unknown'; model: string } {
  const idx = detector.indexOf(':');
  const kind = idx > 0 ? detector.slice(0, idx) : '';
  const model = idx > 0 ? detector.slice(idx + 1) : detector;
  return { kind: kind === 'inference' || kind === 'simulated' ? kind : 'unknown', model };
}
