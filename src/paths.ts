import path from 'node:path';

/** Latest annotated frame for the dashboard live view (overwritten ~2x per second). */
export function liveFramePath(dataDir: string, cameraId: string): string {
  return path.join(dataDir, 'live', `${cameraId}.jpg`);
}

/** Detections for the latest live frame, drawn as an overlay by the dashboard. */
export function liveMetaPath(dataDir: string, cameraId: string): string {
  return path.join(dataDir, 'live', `${cameraId}.json`);
}
