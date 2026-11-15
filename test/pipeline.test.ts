import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZoneMonitor } from '../src/domain/zoneMonitor.js';
import { loadZones } from '../src/domain/zones.js';
import { ffmpegFrames } from '../src/vision/frameSource.js';
import { boxAt, loadTimeline, ScriptedDetector } from '../src/vision/scriptedDetector.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

describe('scripted timeline', () => {
  it('interpolates and hides between null keyframes', async () => {
    const tl = await loadTimeline('fixtures/synthetic-crossing.timeline.json');
    expect(boxAt(tl, 0)).toMatchObject({ x1: 0.03, y2: 0.42 });
    const mid = boxAt(tl, 11)!;
    expect(mid.x1).toBeGreaterThan(0.08);
    expect(mid.x1).toBeLessThan(0.38);
    expect(boxAt(tl, 30)).toBeNull();
    expect(boxAt(tl, 40)).toMatchObject({ x1: 0.03 }); // loops
  });
});

describe.skipIf(!hasFfmpeg)('offline pipeline on a generated clip (ffmpeg)', () => {
  it('ffmpeg frames → scripted detector → zone rule opens exactly one alert at the crossing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ss-'));
    const clip = path.join(dir, 'clip.mp4');
    // 40 s, 1280x720: content is irrelevant to the scripted detector; dimensions and timing are what matter.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=1280x720:r=5:d=40', '-c:v', 'libx264', '-preset', 'ultrafast', clip]);

    const tl = await loadTimeline('fixtures/synthetic-crossing.timeline.json');
    const zone = (await loadZones('config/zones.json'))[0]!;
    const det = new ScriptedDetector(tl);
    const monitor = new ZoneMonitor(zone, { targetClass: 'elephant', confidenceThreshold: 0.45, consecutiveFrames: 3, clearMs: 10_000, maxFrameGapMs: 1_500 });
    const opens: number[] = [];
    let frames = 0;
    let lb;
    for await (const f of ffmpegFrames({ source: clip, fps: 5, size: 640, loop: false, realtime: false })) {
      frames += 1;
      lb = f.letterbox;
      expect(f.data.length).toBe(640 * 640 * 3);
      const d = monitor.processFrame({ ts: f.mediaMs, detections: await det.detect(f), eventActive: false });
      if (d.action.kind === 'open') opens.push(f.mediaMs / 1000);
    }
    expect(frames).toBeGreaterThanOrEqual(199);
    expect(lb).toMatchObject({ srcW: 1280, srcH: 720, padY: 140 });
    expect(opens).toHaveLength(1);
    // The block's feet enter Guest path A at ~10.9 s; 3 frames at 5 fps later the alert opens.
    expect(opens[0]).toBeGreaterThan(10.5);
    expect(opens[0]).toBeLessThan(12.5);
  });
});
