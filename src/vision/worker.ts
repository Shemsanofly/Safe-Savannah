import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import type { Detection, ZoneConfig } from '../domain/types.js';
import { ZoneMonitor, type FrameDecision } from '../domain/zoneMonitor.js';
import { loadZones } from '../domain/zones.js';
import { errMsg, type Logger } from '../log.js';
import { activeEventFor, openEvent, refreshEvent } from '../store/events.js';
import { cameraWorkerHeartbeat, recordCameraError, upsertCamera, upsertZoneStatus } from '../store/status.js';
import { liveFramePath, liveMetaPath } from '../paths.js';
import { annotateFrame, frameJpeg, writeAtomic } from './annotate.js';
import type { Detector } from './detector.js';
import { ffmpegFrames, LatestFrameSlot, sourceKind, type Frame } from './frameSource.js';
import { OnnxYoloDetector } from './onnxDetector.js';
import { loadTimeline, ScriptedDetector } from './scriptedDetector.js';

export const MODEL_INPUT_SIZE = 640;

export async function createDetector(cfg: AppConfig): Promise<Detector> {
  if (cfg.DETECTOR === 'scripted') return new ScriptedDetector(await loadTimeline(cfg.SCRIPTED_TIMELINE));
  return OnnxYoloDetector.create({
    manifestPath: cfg.MODEL_MANIFEST,
    classes: [cfg.TARGET_CLASS],
    // Decode a little below the alert threshold so near-misses are visible on the live view.
    minConfidence: Math.min(0.25, cfg.CONFIDENCE_THRESHOLD),
    threads: cfg.ORT_THREADS || undefined,
  });
}


/** Pump frames from ffmpeg into the slot forever, restarting ffmpeg on failure. */
async function pumpFrames(cfg: AppConfig, slot: LatestFrameSlot, db: Db, log: Logger, signal: AbortSignal): Promise<void> {
  let backoff = 1_000;
  let attempt = 0;
  while (!signal.aborted) {
    try {
      for await (const frame of ffmpegFrames(
        {
          source: cfg.CAMERA_SOURCE,
          fps: cfg.SAMPLE_FPS,
          size: MODEL_INPUT_SIZE,
          loop: cfg.CAMERA_LOOP,
          realtime: cfg.CAMERA_REALTIME,
          extraInputArgs: cfg.CAMERA_INPUT_ARGS.split(/\s+/).filter(Boolean),
        },
        signal,
      )) {
        slot.put(frame);
        backoff = 1_000;
        attempt = 0;
      }
      if (!signal.aborted) throw new Error('video source ended');
    } catch (err) {
      if (signal.aborted) return;
      attempt += 1;
      log.warn('camera source failed; retrying', { error: errMsg(err), retryInMs: backoff, attempt });
      await recordCameraError(db, cfg.CAMERA_ID, errMsg(err), { attempt, retryInMs: backoff }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    }
  }
}

interface ZoneRuntime {
  zone: ZoneConfig;
  monitor: ZoneMonitor;
  activeEventId: number | null;
  lastRefreshAt: number;
  lastStatusAt: number;
}

export async function runVisionWorker(cfg: AppConfig, db: Db, log: Logger, signal: AbortSignal): Promise<void> {
  const zones = (await loadZones(cfg.ZONES_FILE)).filter((z) => z.cameraId === cfg.CAMERA_ID);
  if (zones.length === 0) throw new Error(`No zones configured for camera ${cfg.CAMERA_ID} in ${cfg.ZONES_FILE}`);
  const detector = await createDetector(cfg);
  log.info('detector ready', { model: detector.modelId, source: detector.source, zones: zones.map((z) => z.id) });

  const kind = sourceKind(cfg.CAMERA_SOURCE);
  await upsertCamera(db, { id: cfg.CAMERA_ID, label: cfg.CAMERA_LABEL, sourceKind: kind, detector: `${detector.source}:${detector.modelId}` });

  const monitorCfg = {
    targetClass: cfg.TARGET_CLASS,
    confidenceThreshold: cfg.CONFIDENCE_THRESHOLD,
    consecutiveFrames: cfg.CONSECUTIVE_FRAMES,
    clearMs: cfg.CLEAR_SECONDS * 1000,
    maxFrameGapMs: cfg.MAX_FRAME_GAP_MS,
  };
  const runtimes: ZoneRuntime[] = [];
  for (const zone of zones) {
    const active = await activeEventFor(db, zone.cameraId, zone.id);
    runtimes.push({
      zone,
      monitor: new ZoneMonitor(zone, monitorCfg, { eventActive: !!active }),
      activeEventId: active?.id ?? null,
      lastRefreshAt: 0,
      lastStatusAt: 0,
    });
  }

  const recipients = cfg.recipients.map((r) => r.alias);
  const slot = new LatestFrameSlot();
  const pump = pumpFrames(cfg, slot, db, log, signal);

  let lastActiveSync = 0;
  let lastLive = 0;
  let lastHeartbeat = 0;
  let processedSinceHeartbeat = 0;
  let inferenceMsTotal = 0;
  const banner = detector.source === 'simulated' ? 'SIMULATED DETECTOR — scripted boxes, not model output' : undefined;

  while (!signal.aborted) {
    const frame = await slot.take(1_000);
    const now = Date.now();
    if (!frame) {
      // No frame: do not touch last_frame_at; the dashboard shows the feed as stale / zone UNKNOWN.
      // Still report that the worker itself is alive, so "reconnecting" is distinguishable from "offline".
      await cameraWorkerHeartbeat(db, cfg.CAMERA_ID).catch(() => undefined);
      continue;
    }

    const t0 = performance.now();
    let detections: Detection[];
    try {
      detections = await detector.detect(frame);
    } catch (err) {
      log.error('inference failed', { error: errMsg(err) });
      await recordCameraError(db, cfg.CAMERA_ID, `inference: ${errMsg(err)}`).catch(() => undefined);
      continue;
    }
    const inferenceMs = performance.now() - t0;
    inferenceMsTotal += inferenceMs;
    processedSinceHeartbeat += 1;

    try {
      if (now - lastActiveSync > 1_000) {
        // Operators close alerts in the API process; pick that up within ~1s.
        for (const rt of runtimes) rt.activeEventId = (await activeEventFor(db, rt.zone.cameraId, rt.zone.id))?.id ?? null;
        lastActiveSync = now;
      }

      const allHits: Detection[] = [];
      for (const rt of runtimes) {
        const decision = rt.monitor.processFrame({ ts: frame.receivedAt, detections, eventActive: rt.activeEventId !== null });
        allHits.push(...decision.hits);
        await handleDecision(rt, decision, frame, detections);
        if (now - rt.lastStatusAt > 1_000 || decision.action.kind === 'open') {
          await upsertZoneStatus(db, {
            cameraId: rt.zone.cameraId,
            zoneId: rt.zone.id,
            zoneLabel: rt.zone.label,
            state: decision.state,
            inZone: decision.inZone,
            streak: decision.streak,
            clearMs: decision.clearMs,
          });
          rt.lastStatusAt = now;
        }
      }

      if (now - lastLive > 500) {
        lastLive = now;
        // Clean frame + detection metadata; the dashboard draws zone and box overlays (toggleable).
        const hitSet = new Set(allHits);
        const meta = {
          cameraId: cfg.CAMERA_ID,
          frameAt: new Date(frame.receivedAt).toISOString(),
          width: frame.letterbox.srcW,
          height: frame.letterbox.srcH,
          source: detector.source,
          detections: detections.map((d) => ({
            label: d.label,
            confidence: Math.round(d.confidence * 1000) / 1000,
            box: d.box,
            inZone: hitSet.has(d),
            countsForAlert: d.label === cfg.TARGET_CLASS && d.confidence >= cfg.CONFIDENCE_THRESHOLD,
          })),
        };
        await writeAtomic(liveFramePath(cfg.DATA_DIR, cfg.CAMERA_ID), await frameJpeg(frame));
        await writeAtomic(liveMetaPath(cfg.DATA_DIR, cfg.CAMERA_ID), Buffer.from(JSON.stringify(meta)));
      }

      if (now - lastHeartbeat > 1_000) {
        const elapsed = lastHeartbeat ? (now - lastHeartbeat) / 1000 : 1;
        await upsertCamera(db, {
          id: cfg.CAMERA_ID,
          label: cfg.CAMERA_LABEL,
          sourceKind: kind,
          detector: `${detector.source}:${detector.modelId}`,
          lastFrameAt: new Date(frame.receivedAt),
          lastInferenceMs: inferenceMsTotal / processedSinceHeartbeat,
          processedFps: processedSinceHeartbeat / elapsed,
          droppedFrames: slot.dropped,
          frameWidth: frame.letterbox.srcW,
          frameHeight: frame.letterbox.srcH,
        });
        lastHeartbeat = now;
        processedSinceHeartbeat = 0;
        inferenceMsTotal = 0;
      }
    } catch (err) {
      // Database or disk unavailable: keep processing frames; alerts will be retried by re-arming.
      log.error('vision loop error', { error: errMsg(err) });
    }
  }

  await pump.catch(() => undefined);
  await detector.close?.();

  async function handleDecision(rt: ZoneRuntime, d: FrameDecision, frame: Frame, detections: Detection[]): Promise<void> {
    const action = d.action;
    if (action.kind === 'open') {
      try {
        const stamp = new Date(frame.receivedAt).toISOString().replace(/[:.]/g, '-');
        const rel = path.join('snapshots', rt.zone.cameraId, `${stamp}-${rt.zone.id}.jpg`);
        const jpeg = await annotateFrame(frame, {
          zones: [rt.zone],
          detections,
          hits: d.hits,
          targetClass: cfg.TARGET_CLASS,
          banner: banner ?? `Possible ${cfg.TARGET_CLASS} in ${rt.zone.label} — verify`,
        });
        await writeAtomic(path.join(cfg.DATA_DIR, rel), jpeg);
        const { event, created } = await openEvent(
          db,
          {
            cameraId: rt.zone.cameraId,
            zoneId: rt.zone.id,
            zoneLabel: rt.zone.label,
            classLabel: action.hit.label,
            confidence: action.hit.confidence,
            bbox: action.hit.box,
            firstSeenAt: new Date(action.firstSeenTs),
            lastSeenAt: new Date(frame.receivedAt),
            snapshotPath: rel,
            source: detector.source,
            model: detector.modelId,
          },
          recipients,
        );
        rt.activeEventId = event.id;
        rt.lastRefreshAt = Date.now();
        log.info(created ? 'alert opened' : 'alert already active', { eventId: event.id, zone: rt.zone.id, confidence: action.hit.confidence });
      } catch (err) {
        rt.monitor.openFailed();
        throw err;
      }
    } else if (action.kind === 'refresh' && rt.activeEventId !== null && Date.now() - rt.lastRefreshAt > 1_000) {
      await refreshEvent(db, rt.activeEventId, new Date(frame.receivedAt), action.hit.confidence);
      rt.lastRefreshAt = Date.now();
    }
  }
}
