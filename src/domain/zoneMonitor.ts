import { bottomCenter, pointInPolygon } from './geometry.js';
import type { Detection, ZoneConfig } from './types.js';

export interface MonitorConfig {
  targetClass: string;
  confidenceThreshold: number;
  /** Consecutive in-zone frames required before an alert opens. */
  consecutiveFrames: number;
  /** Continuous milliseconds of VALID frames with no in-zone detection before the zone counts as clear. */
  clearMs: number;
  /** A gap between frames larger than this is an outage: streak and clear timer reset. */
  maxFrameGapMs: number;
}

/**
 * armed           – no active alert; counting consecutive in-zone frames
 * alerting        – alert active, target recently in zone (or not yet clear long enough)
 * awaiting_close  – zone has been clear for clearMs, but an operator has not closed the alert
 * awaiting_clear  – operator closed the alert, but the zone has not yet been clear for clearMs
 *
 * "Unknown" (stale camera) is derived from frame timestamps by the dashboard, never from this machine:
 * the monitor simply never counts missing frames as clear.
 */
export type ZoneState = 'armed' | 'alerting' | 'awaiting_close' | 'awaiting_clear';

export interface FrameInput {
  /** Frame timestamp in ms (wall clock for live, video time for offline evaluation). */
  ts: number;
  detections: Detection[];
  /** Whether the store currently holds an active (open/acknowledged) event for this zone. */
  eventActive: boolean;
}

export type MonitorAction =
  | { kind: 'none' }
  | { kind: 'open'; firstSeenTs: number; hit: Detection }
  | { kind: 'refresh'; hit: Detection };

export interface FrameDecision {
  state: ZoneState;
  inZone: boolean;
  /** Target detections whose bottom-centre is inside the polygon. */
  hits: Detection[];
  streak: number;
  clearMs: number;
  gap: boolean;
  action: MonitorAction;
}

export class ZoneMonitor {
  private lastTs: number | null = null;
  private streak = 0;
  private streakStartTs: number | null = null;
  private clearMs = 0;
  /** True from the moment an alert opens until the zone is re-armed. */
  private latched: boolean;

  constructor(
    readonly zone: ZoneConfig,
    private readonly cfg: MonitorConfig,
    initial: { eventActive: boolean } = { eventActive: false },
  ) {
    // After a restart with an alert still active, do not open a duplicate.
    this.latched = initial.eventActive;
  }

  inZoneHits(detections: Detection[]): Detection[] {
    return detections.filter(
      (d) =>
        d.label === this.cfg.targetClass &&
        d.confidence >= this.cfg.confidenceThreshold &&
        pointInPolygon(bottomCenter(d.box), this.zone.polygon),
    );
  }

  processFrame(frame: FrameInput): FrameDecision {
    const gap = this.lastTs !== null && frame.ts - this.lastTs > this.cfg.maxFrameGapMs;
    const dt = this.lastTs === null || gap ? 0 : Math.max(0, frame.ts - this.lastTs);
    this.lastTs = frame.ts;

    if (gap) {
      // Outage: we do not know what happened in between.
      this.streak = 0;
      this.streakStartTs = null;
      this.clearMs = 0;
    }

    const hits = this.inZoneHits(frame.detections);
    const inZone = hits.length > 0;
    const best = inZone ? hits.reduce((a, b) => (b.confidence > a.confidence ? b : a)) : undefined;

    if (inZone) this.clearMs = 0;
    else this.clearMs += dt;

    let action: MonitorAction = { kind: 'none' };

    if (!this.latched) {
      if (inZone) {
        if (this.streak === 0) this.streakStartTs = frame.ts;
        this.streak += 1;
      } else {
        this.streak = 0;
        this.streakStartTs = null;
      }
      if (this.streak >= this.cfg.consecutiveFrames && best) {
        action = { kind: 'open', firstSeenTs: this.streakStartTs ?? frame.ts, hit: best };
        this.latched = true;
        this.streak = 0;
        this.streakStartTs = null;
      }
    } else {
      if (best && frame.eventActive) action = { kind: 'refresh', hit: best };
      const clear = this.clearMs >= this.cfg.clearMs;
      if (clear && !frame.eventActive) {
        // Both conditions met: zone clear for the full window AND operator closed the alert.
        this.latched = false;
        this.streak = 0;
        this.streakStartTs = null;
      }
    }

    return {
      state: action.kind === 'open' ? 'alerting' : this.state(frame.eventActive),
      inZone,
      hits,
      streak: this.streak,
      clearMs: this.clearMs,
      gap,
      action,
    };
  }

  /** The store could not persist the alert (e.g. database down): re-arm so persistence is retried. */
  openFailed(): void {
    this.latched = false;
    this.streak = 0;
    this.streakStartTs = null;
  }

  private state(eventActive: boolean): ZoneState {
    if (!this.latched) return 'armed';
    if (!eventActive) return 'awaiting_clear';
    return this.clearMs >= this.cfg.clearMs ? 'awaiting_close' : 'alerting';
  }
}
