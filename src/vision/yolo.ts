import { iou } from '../domain/geometry.js';
import type { Box, Detection } from '../domain/types.js';
import type { Letterbox } from './frameSource.js';

/** RGB24 HWC uint8 → CHW float32 in [0, 1]. */
export function rgbToChwFloat(rgb: Uint8Array, size: number): Float32Array {
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let i = 0, p = 0; p < plane; p++, i += 3) {
    out[p] = rgb[i]! / 255;
    out[p + plane] = rgb[i + 1]! / 255;
    out[p + 2 * plane] = rgb[i + 2]! / 255;
  }
  return out;
}

/** Map a box from model-input pixels back to normalized coordinates of the original frame. */
export function unletterbox(x1: number, y1: number, x2: number, y2: number, lb: Letterbox): Box {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const sx = lb.scaledW;
  const sy = lb.scaledH;
  return {
    x1: clamp((x1 - lb.padX) / sx),
    y1: clamp((y1 - lb.padY) / sy),
    x2: clamp((x2 - lb.padX) / sx),
    y2: clamp((y2 - lb.padY) / sy),
  };
}

export interface DecodeOptions {
  labels: readonly string[];
  minConfidence: number;
  iouThreshold: number;
  /** Only decode these class ids (undefined = all). */
  classIds?: ReadonlySet<number>;
  maxDetections?: number;
}

/**
 * Decode an Ultralytics YOLOv8/YOLO11 detect head output of shape
 * [1, 4 + numClasses, numAnchors] (cx, cy, w, h in input pixels, then class scores),
 * followed by per-class non-maximum suppression.
 */
export function decodeYolo(output: Float32Array, dims: readonly number[], lb: Letterbox, opts: DecodeOptions): Detection[] {
  const [, channels, anchors] = dims as [number, number, number];
  const numClasses = channels - 4;
  if (numClasses !== opts.labels.length) {
    throw new Error(`Model output has ${numClasses} classes but manifest lists ${opts.labels.length} labels`);
  }
  const candidates: Detection[] = [];
  for (let a = 0; a < anchors; a++) {
    let bestScore = 0;
    let bestClass = -1;
    for (let c = 0; c < numClasses; c++) {
      if (opts.classIds && !opts.classIds.has(c)) continue;
      const s = output[(4 + c) * anchors + a]!;
      if (s > bestScore) {
        bestScore = s;
        bestClass = c;
      }
    }
    if (bestClass < 0 || bestScore < opts.minConfidence) continue;
    const cx = output[a]!;
    const cy = output[anchors + a]!;
    const w = output[2 * anchors + a]!;
    const h = output[3 * anchors + a]!;
    const box = unletterbox(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, lb);
    if (box.x2 <= box.x1 || box.y2 <= box.y1) continue;
    candidates.push({ label: opts.labels[bestClass]!, classId: bestClass, confidence: bestScore, box });
  }
  return nms(candidates, opts.iouThreshold, opts.maxDetections ?? 100);
}

export function nms(dets: Detection[], iouThreshold: number, max: number): Detection[] {
  const sorted = [...dets].sort((a, b) => b.confidence - a.confidence);
  const kept: Detection[] = [];
  for (const d of sorted) {
    if (kept.length >= max) break;
    if (kept.some((k) => k.classId === d.classId && iou(k.box, d.box) > iouThreshold)) continue;
    kept.push(d);
  }
  return kept;
}
