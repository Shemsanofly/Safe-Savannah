import { describe, expect, it } from 'vitest';
import { computeLetterbox } from '../src/vision/frameSource.js';
import { decodeYolo, rgbToChwFloat, unletterbox } from '../src/vision/yolo.js';

const labels = ['person', 'cow', 'elephant'];

/** Build a fake [1, 4+nc, N] output tensor. */
function fakeOutput(anchors: { cx: number; cy: number; w: number; h: number; scores: number[] }[]) {
  const n = anchors.length;
  const c = 4 + labels.length;
  const out = new Float32Array(c * n);
  anchors.forEach((a, i) => {
    out[i] = a.cx;
    out[n + i] = a.cy;
    out[2 * n + i] = a.w;
    out[3 * n + i] = a.h;
    a.scores.forEach((s, k) => (out[(4 + k) * n + i] = s));
  });
  return { out, dims: [1, c, n] };
}

describe('letterbox', () => {
  it('fits 1280x720 into 640x640 with vertical padding', () => {
    const lb = computeLetterbox(1280, 720, 640);
    expect(lb).toMatchObject({ scaledW: 640, scaledH: 360, padX: 0, padY: 140 });
    // centre of the model input maps to the centre of the original frame
    const box = unletterbox(320 - 64, 320 - 36, 320 + 64, 320 + 36, lb);
    expect(box.x1).toBeCloseTo(0.4);
    expect(box.x2).toBeCloseTo(0.6);
    expect(box.y1).toBeCloseTo(0.4);
    expect(box.y2).toBeCloseTo(0.6);
  });

  it('clamps boxes that extend into the padding', () => {
    const lb = computeLetterbox(1280, 720, 640);
    const box = unletterbox(0, 100, 50, 600, lb);
    expect(box.y1).toBe(0);
    expect(box.y2).toBe(1);
  });
});

describe('decodeYolo', () => {
  const lb = computeLetterbox(640, 640, 640);

  it('decodes, filters by confidence and class, and resolves labels', () => {
    const { out, dims } = fakeOutput([
      { cx: 320, cy: 320, w: 100, h: 200, scores: [0.1, 0.2, 0.9] },
      { cx: 100, cy: 100, w: 50, h: 50, scores: [0.95, 0, 0] },
      { cx: 500, cy: 500, w: 50, h: 50, scores: [0, 0, 0.2] },
    ]);
    const dets = decodeYolo(out, dims, lb, { labels, minConfidence: 0.25, iouThreshold: 0.45, classIds: new Set([2]) });
    expect(dets).toHaveLength(1);
    expect(dets[0]!.label).toBe('elephant');
    expect(dets[0]!.confidence).toBeCloseTo(0.9);
    expect(dets[0]!.box.y2).toBeCloseTo(420 / 640);
  });

  it('applies non-maximum suppression per class', () => {
    const { out, dims } = fakeOutput([
      { cx: 320, cy: 320, w: 100, h: 100, scores: [0, 0, 0.9] },
      { cx: 325, cy: 322, w: 100, h: 100, scores: [0, 0, 0.8] },
      { cx: 100, cy: 100, w: 60, h: 60, scores: [0, 0, 0.7] },
    ]);
    const dets = decodeYolo(out, dims, lb, { labels, minConfidence: 0.25, iouThreshold: 0.45 });
    expect(dets.map((d) => d.confidence.toFixed(1))).toEqual(['0.9', '0.7']);
  });

  it('rejects a model whose class count does not match the manifest', () => {
    const { out, dims } = fakeOutput([{ cx: 1, cy: 1, w: 1, h: 1, scores: [0, 0, 0] }]);
    expect(() => decodeYolo(out, dims, lb, { labels: ['a', 'b'], minConfidence: 0.1, iouThreshold: 0.5 })).toThrow(/classes/);
  });
});

describe('rgbToChwFloat', () => {
  it('converts HWC uint8 to normalized CHW', () => {
    const rgb = new Uint8Array([255, 0, 51, 0, 255, 102, 0, 0, 0, 255, 255, 255]); // 2x2
    const chw = rgbToChwFloat(rgb, 2);
    expect(Array.from(chw.slice(0, 4))).toEqual([1, 0, 0, 1]); // R plane
    expect(chw[4 + 1]).toBe(1); // G of pixel 1
    expect(chw[8]).toBeCloseTo(0.2); // B of pixel 0
  });
});
