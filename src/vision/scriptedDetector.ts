import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Box, Detection } from '../domain/types.js';
import type { Detector } from './detector.js';
import type { Frame } from './frameSource.js';

/**
 * Stand-in detector for the synthetic clip: returns the box from a keyframed
 * timeline, keyed by the frame's position in the clip. Events it produces are
 * stored with source='simulated' and labelled SIMULATED on the dashboard.
 */
const KeyframeSchema = z.object({
  t: z.number().min(0),
  /** [x1, y1, x2, y2] normalized; null = target not visible. */
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
});
export const TimelineSchema = z.object({
  description: z.string().optional(),
  durationSeconds: z.number().positive(),
  label: z.string().default('elephant'),
  confidence: z.number().min(0).max(1).default(0.8),
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(720),
  keyframes: z.array(KeyframeSchema).min(1),
});
export type Timeline = z.infer<typeof TimelineSchema>;

export async function loadTimeline(file: string): Promise<Timeline> {
  return TimelineSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

/** Piecewise-linear interpolation; a null keyframe hides the target until the next keyframe. */
export function boxAt(timeline: Timeline, tSeconds: number): Box | null {
  const t = ((tSeconds % timeline.durationSeconds) + timeline.durationSeconds) % timeline.durationSeconds;
  const kfs = timeline.keyframes;
  let prev = kfs[0]!;
  if (t < prev.t) return null;
  for (let i = 1; i < kfs.length; i++) {
    const next = kfs[i]!;
    if (t < next.t) {
      if (!prev.box) return null;
      if (!next.box) return toBox(prev.box);
      const f = (t - prev.t) / (next.t - prev.t);
      const lerp = (a: number, b: number) => a + (b - a) * f;
      return toBox([lerp(prev.box[0], next.box[0]), lerp(prev.box[1], next.box[1]), lerp(prev.box[2], next.box[2]), lerp(prev.box[3], next.box[3])]);
    }
    prev = next;
  }
  return prev.box ? toBox(prev.box) : null;
}

function toBox([x1, y1, x2, y2]: [number, number, number, number]): Box | null {
  const c = (v: number) => Math.min(1, Math.max(0, v));
  const box = { x1: c(x1), y1: c(y1), x2: c(x2), y2: c(y2) };
  return box.x2 - box.x1 > 0.01 && box.y2 - box.y1 > 0.01 ? box : null;
}

export class ScriptedDetector implements Detector {
  readonly source = 'simulated' as const;
  readonly modelId = 'scripted-timeline';
  constructor(private readonly timeline: Timeline) {}

  async detect(frame: Frame): Promise<Detection[]> {
    const box = boxAt(this.timeline, frame.mediaMs / 1000);
    return box ? [{ label: this.timeline.label, classId: -1, confidence: this.timeline.confidence, box }] : [];
  }
}
