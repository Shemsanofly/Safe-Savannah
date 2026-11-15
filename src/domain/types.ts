/** Axis-aligned box in normalized image coordinates (0..1, origin top-left) of the ORIGINAL camera frame. */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Detection {
  label: string;
  classId: number;
  confidence: number;
  box: Box;
}

export type Point = [number, number];

export interface ZoneConfig {
  id: string;
  cameraId: string;
  label: string;
  /** Polygon vertices in normalized image coordinates. */
  polygon: Point[];
}
