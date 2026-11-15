import { describe, expect, it } from 'vitest';
import { bottomCenter, iou, pointInPolygon } from '../src/domain/geometry.js';
import type { Point } from '../src/domain/types.js';

const trapezoid: Point[] = [
  [0.35, 0.55],
  [0.65, 0.55],
  [0.8, 0.98],
  [0.2, 0.98],
];

describe('geometry', () => {
  it('uses the bottom-centre of the box as the ground-contact proxy', () => {
    expect(bottomCenter({ x1: 0.2, y1: 0.1, x2: 0.4, y2: 0.6 })).toEqual([0.30000000000000004, 0.6]);
  });

  it('point in polygon', () => {
    expect(pointInPolygon([0.5, 0.7], trapezoid)).toBe(true);
    expect(pointInPolygon([0.5, 0.5], trapezoid)).toBe(false); // above the zone
    expect(pointInPolygon([0.22, 0.6], trapezoid)).toBe(false); // left of the slanted edge
    expect(pointInPolygon([0.25, 0.95], trapezoid)).toBe(true);
  });

  it('a tall box whose body overlaps the zone but whose feet are outside is NOT in the zone', () => {
    const box = { x1: 0.4, y1: 0.3, x2: 0.6, y2: 0.52 };
    expect(pointInPolygon(bottomCenter(box), trapezoid)).toBe(false);
  });

  it('iou', () => {
    expect(iou({ x1: 0, y1: 0, x2: 1, y2: 1 }, { x1: 0, y1: 0, x2: 1, y2: 1 })).toBe(1);
    expect(iou({ x1: 0, y1: 0, x2: 0.5, y2: 1 }, { x1: 0.5, y1: 0, x2: 1, y2: 1 })).toBe(0);
    expect(iou({ x1: 0, y1: 0, x2: 1, y2: 1 }, { x1: 0.5, y1: 0, x2: 1.5, y2: 1 })).toBeCloseTo(1 / 3);
  });
});
