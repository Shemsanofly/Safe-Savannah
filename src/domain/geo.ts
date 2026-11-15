/** Geographic helpers for geofencing. Coordinates are [lat, lng] in WGS84 degrees. */
export type LatLng = [number, number];

const R = 6_371_000; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM([lat1, lng1]: LatLng, [lat2, lng2]: LatLng): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Local equirectangular projection to metres around a reference point (accurate for park-sized areas). */
function project(p: LatLng, ref: LatLng): [number, number] {
  return [rad(p[1] - ref[1]) * Math.cos(rad(ref[0])) * R, rad(p[0] - ref[0]) * R];
}

export function pointInPolygonLatLng(p: LatLng, poly: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i]!;
    const [yj, xj] = poly[j]!;
    if (yi > p[0] !== yj > p[0] && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance in metres from a point to a polygon: 0 when inside, otherwise to the nearest edge. */
export function distanceToPolygonM(p: LatLng, poly: LatLng[]): number {
  if (poly.length < 3) return Infinity;
  if (pointInPolygonLatLng(p, poly)) return 0;
  const [px, py] = project(p, p);
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = project(poly[j]!, p);
    const [bx, by] = project(poly[i]!, p);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

export function polygonCentroid(poly: LatLng[]): LatLng {
  const lat = poly.reduce((a, p) => a + p[0], 0) / poly.length;
  const lng = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  return [lat, lng];
}

export function isValidPolygon(poly: unknown): poly is LatLng[] {
  return (
    Array.isArray(poly) &&
    poly.length >= 3 &&
    poly.length <= 200 &&
    poly.every((p) => Array.isArray(p) && p.length === 2 && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180 && p.every(Number.isFinite))
  );
}
