import { describe, expect, it } from 'vitest';
import type { Detection, ZoneConfig } from '../src/domain/types.js';
import { ZoneMonitor, type MonitorConfig } from '../src/domain/zoneMonitor.js';

const zone: ZoneConfig = {
  id: 'guest-path-a',
  cameraId: 'cam-1',
  label: 'Guest path A',
  polygon: [
    [0.3, 0.5],
    [0.7, 0.5],
    [0.7, 1],
    [0.3, 1],
  ],
};
const cfg: MonitorConfig = { targetClass: 'elephant', confidenceThreshold: 0.45, consecutiveFrames: 3, clearMs: 10_000, maxFrameGapMs: 1_500 };
const STEP = 200; // 5 fps

const inside = (conf = 0.8): Detection => ({ label: 'elephant', classId: 20, confidence: conf, box: { x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.8 } });
const outside = (conf = 0.8): Detection => ({ label: 'elephant', classId: 20, confidence: conf, box: { x1: 0.0, y1: 0.1, x2: 0.2, y2: 0.4 } });
const cow: Detection = { label: 'cow', classId: 19, confidence: 0.9, box: { x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.8 } };

/** Feed frames; eventActive follows "an alert was opened and not yet closed". */
function run(monitor: ZoneMonitor, frames: Detection[][], opts: { start?: number; eventActive?: () => boolean } = {}) {
  let t = opts.start ?? 0;
  return frames.map((dets) => {
    const d = monitor.processFrame({ ts: t, detections: dets, eventActive: opts.eventActive?.() ?? false });
    t += STEP;
    return d;
  });
}
const rep = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

describe('ZoneMonitor', () => {
  it('outside-zone detections never open an alert', () => {
    const m = new ZoneMonitor(zone, cfg);
    const out = run(m, rep(50, [outside()]));
    expect(out.filter((d) => d.action.kind === 'open')).toHaveLength(0);
    expect(out.every((d) => d.state === 'armed')).toBe(true);
  });

  it('ignores other classes and low-confidence elephants', () => {
    const m = new ZoneMonitor(zone, cfg);
    const out = run(m, [...rep(10, [cow]), ...rep(10, [inside(0.3)])]);
    expect(out.some((d) => d.action.kind === 'open')).toBe(false);
  });

  it('opens exactly one alert after 3 consecutive in-zone frames, then only refreshes', () => {
    const m = new ZoneMonitor(zone, cfg);
    let active = false;
    const results = [];
    let t = 0;
    for (let i = 0; i < 40; i++) {
      const d = m.processFrame({ ts: t, detections: [inside()], eventActive: active });
      if (d.action.kind === 'open') active = true;
      results.push(d);
      t += STEP;
    }
    const opens = results.filter((d) => d.action.kind === 'open');
    expect(opens).toHaveLength(1);
    expect(results.findIndex((d) => d.action.kind === 'open')).toBe(2);
    // firstSeen is the first frame of the streak
    expect(opens[0]!.action.kind === 'open' && opens[0]!.action.firstSeenTs).toBe(0);
    expect(results.slice(3).every((d) => d.action.kind === 'refresh')).toBe(true);
  });

  it('a broken streak resets the count', () => {
    const m = new ZoneMonitor(zone, cfg);
    const out = run(m, [[inside()], [inside()], [], [inside()], [inside()], []]);
    expect(out.some((d) => d.action.kind === 'open')).toBe(false);
  });

  it('a frame gap (camera outage) resets the streak', () => {
    const m = new ZoneMonitor(zone, cfg);
    m.processFrame({ ts: 0, detections: [inside()], eventActive: false });
    m.processFrame({ ts: 200, detections: [inside()], eventActive: false });
    const afterGap = m.processFrame({ ts: 5_000, detections: [inside()], eventActive: false });
    expect(afterGap.gap).toBe(true);
    expect(afterGap.action.kind).toBe('none');
    expect(afterGap.streak).toBe(1);
  });

  it('re-arms only after BOTH 10 s of valid empty frames AND the operator closing the alert', () => {
    const m = new ZoneMonitor(zone, cfg);
    let active = false;
    let t = 0;
    const step = (dets: Detection[]) => {
      const d = m.processFrame({ ts: t, detections: dets, eventActive: active });
      if (d.action.kind === 'open') active = true;
      t += STEP;
      return d;
    };
    for (let i = 0; i < 5; i++) step([inside()]);
    expect(active).toBe(true);

    // Zone clears for 12 s, but the alert is still open → awaiting_close, no new alert possible.
    let d = step([]);
    for (let i = 0; i < 60; i++) d = step([]);
    expect(d.state).toBe('awaiting_close');

    // Elephant returns while the alert is still open → refresh, not a second alert.
    d = step([inside()]);
    expect(d.action.kind).toBe('refresh');
    expect(d.state).toBe('alerting');

    // Operator closes while the elephant is still there → awaiting_clear.
    active = false;
    for (let i = 0; i < 10; i++) d = step([inside()]);
    expect(d.state).toBe('awaiting_clear');
    expect(d.action.kind).toBe('none');

    // Needs a full clear window before re-arming.
    for (let i = 0; i < 49; i++) d = step([]);
    expect(d.state).toBe('awaiting_clear');
    for (let i = 0; i < 2; i++) d = step([]);
    expect(d.state).toBe('armed');

    // And then a new crossing opens a new alert.
    const out = [step([inside()]), step([inside()]), step([inside()])];
    expect(out[2]!.action.kind).toBe('open');
  });

  it('a camera outage is not counted as clear time', () => {
    const m = new ZoneMonitor(zone, cfg);
    let t = 0;
    for (let i = 0; i < 3; i++, t += STEP) m.processFrame({ ts: t, detections: [inside()], eventActive: false });
    // operator closed it (eventActive=false); 5 s of empty frames, then a 60 s outage, then 5 s more.
    let d;
    for (let i = 0; i < 25; i++, t += STEP) d = m.processFrame({ ts: t, detections: [], eventActive: false });
    t += 60_000;
    for (let i = 0; i < 25; i++, t += STEP) d = m.processFrame({ ts: t, detections: [], eventActive: false });
    expect(d!.state).toBe('awaiting_clear');
    for (let i = 0; i < 30; i++, t += STEP) d = m.processFrame({ ts: t, detections: [], eventActive: false });
    expect(d!.state).toBe('armed');
  });

  it('starts latched when the store already has an active alert (restart safety)', () => {
    const m = new ZoneMonitor(zone, cfg, { eventActive: true });
    const out = run(m, rep(10, [inside()]), { eventActive: () => true });
    expect(out.some((d) => d.action.kind === 'open')).toBe(false);
    expect(out.every((d) => d.action.kind === 'refresh')).toBe(true);
  });

  it('openFailed() re-arms so a failed write is retried on the next streak', () => {
    const m = new ZoneMonitor(zone, cfg);
    const out = run(m, rep(3, [inside()]));
    expect(out[2]!.action.kind).toBe('open');
    m.openFailed();
    const again = run(m, rep(3, [inside()]), { start: 600 });
    expect(again[2]!.action.kind).toBe('open');
  });
});
