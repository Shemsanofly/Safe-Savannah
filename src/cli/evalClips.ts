/**
 * Offline clip evaluation: runs the real detector + zone rule over each clip
 * (every sampled frame, no dropping, video-time clock) and reports alerts,
 * misses and false alerts PER CLIP against manual annotations.
 *
 *   npm run eval -- --annotations fixtures/local/inside.json --annotations fixtures/local/outside.json
 *
 * Annotation file:
 *   {
 *     "clip": "inside-crossing.mp4",          // relative to the annotation file
 *     "zoneId": "guest-path-a",
 *     "crossings": [12.4],                    // seconds the elephant's feet enter the zone; [] = no alert expected
 *     "notes": "daylight, single adult"
 *   }
 *
 * Assumes an operator closes each alert immediately, so re-arming depends only
 * on the clear window. Results describe these clips only — not field accuracy.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { ZoneMonitor } from '../domain/zoneMonitor.js';
import { loadZones } from '../domain/zones.js';
import { ffmpegFrames } from '../vision/frameSource.js';
import { createDetector, MODEL_INPUT_SIZE } from '../vision/worker.js';
import { flag, parseArgs } from './args.js';

const AnnotationSchema = z.object({
  clip: z.string(),
  zoneId: z.string(),
  crossings: z.array(z.number().min(0)),
  notes: z.string().optional(),
});

const cfg = loadConfig();
const { flags } = parseArgs();
const files = flags.get('annotations') ?? [];
if (files.length === 0) {
  console.error('Usage: npm run eval -- --annotations <file.json> [--annotations <file2.json> ...] [--max-latency 10] [--json]');
  process.exit(2);
}
const maxLatency = Number(flag(flags, 'max-latency') ?? 10);
const earlyTolerance = 1;
const zones = await loadZones(cfg.ZONES_FILE);
const detector = await createDetector(cfg);

interface ClipResult {
  annotation: string;
  clip: string;
  notes?: string;
  frames: number;
  meanInferenceMs: number;
  alertsAt: number[];
  matched: { crossingAt: number; alertAt: number; latencyS: number }[];
  missed: number[];
  falseAlerts: number[];
}

const results: ClipResult[] = [];
for (const file of files) {
  const ann = AnnotationSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const zone = zones.find((z) => z.id === ann.zoneId);
  if (!zone) throw new Error(`${file}: unknown zone ${ann.zoneId}`);
  const clip = path.resolve(path.dirname(file), ann.clip);
  const monitor = new ZoneMonitor(zone, {
    targetClass: cfg.TARGET_CLASS,
    confidenceThreshold: cfg.CONFIDENCE_THRESHOLD,
    consecutiveFrames: cfg.CONSECUTIVE_FRAMES,
    clearMs: cfg.CLEAR_SECONDS * 1000,
    maxFrameGapMs: cfg.MAX_FRAME_GAP_MS,
  });
  const alertsAt: number[] = [];
  let frames = 0;
  let inferMs = 0;
  for await (const frame of ffmpegFrames({ source: clip, fps: cfg.SAMPLE_FPS, size: MODEL_INPUT_SIZE, loop: false, realtime: false })) {
    const t0 = performance.now();
    const detections = await detector.detect(frame);
    inferMs += performance.now() - t0;
    frames += 1;
    // eventActive=false: the alert is treated as closed straight away (see header).
    const d = monitor.processFrame({ ts: frame.mediaMs, detections, eventActive: false });
    if (d.action.kind === 'open') alertsAt.push(frame.mediaMs / 1000);
  }

  const unmatched = new Set(alertsAt);
  const matched: ClipResult['matched'] = [];
  const missed: number[] = [];
  for (const c of ann.crossings) {
    const hit = alertsAt.find((a) => unmatched.has(a) && a >= c - earlyTolerance && a <= c + maxLatency);
    if (hit === undefined) missed.push(c);
    else {
      unmatched.delete(hit);
      matched.push({ crossingAt: c, alertAt: hit, latencyS: +(hit - c).toFixed(2) });
    }
  }
  results.push({
    annotation: file,
    clip: ann.clip,
    notes: ann.notes,
    frames,
    meanInferenceMs: frames ? +(inferMs / frames).toFixed(1) : 0,
    alertsAt,
    matched,
    missed,
    falseAlerts: [...unmatched],
  });
}
await detector.close?.();

if (flag(flags, 'json')) {
  console.log(JSON.stringify({ detector: detector.modelId, source: detector.source, results }, null, 2));
} else {
  console.log(`Detector: ${detector.modelId} (${detector.source}) · threshold ${cfg.CONFIDENCE_THRESHOLD} · ${cfg.CONSECUTIVE_FRAMES} consecutive frames @ ${cfg.SAMPLE_FPS} fps`);
  console.log('Per-clip results (not a field-accuracy claim):\n');
  for (const r of results) {
    console.log(`• ${r.clip}${r.notes ? ` — ${r.notes}` : ''}`);
    console.log(`  frames ${r.frames}, mean inference ${r.meanInferenceMs} ms, alerts at [${r.alertsAt.map((a) => a.toFixed(1)).join(', ')}] s`);
    for (const m of r.matched) console.log(`  ✓ crossing ${m.crossingAt}s → alert ${m.alertAt.toFixed(1)}s (latency ${m.latencyS}s)`);
    for (const m of r.missed) console.log(`  ✗ MISSED crossing at ${m}s`);
    for (const f of r.falseAlerts) console.log(`  ✗ FALSE ALERT at ${f.toFixed(1)}s`);
  }
  const tot = results.reduce((a, r) => ({ m: a.m + r.missed.length, f: a.f + r.falseAlerts.length, c: a.c + r.matched.length }), { m: 0, f: 0, c: 0 });
  console.log(`\nTotals over ${results.length} clip(s): ${tot.c} detected crossings, ${tot.m} missed, ${tot.f} false alerts.`);
}
