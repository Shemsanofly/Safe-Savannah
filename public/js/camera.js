// Live camera panel: latest frame with toggleable zone/detection overlays and explicit feed states.
import { api, clear, el, icon, fmtDuration, secondsSince, until, ago } from './lib.js';
import { FEED, ZONE, feedBadge, zoneBadge } from './status.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  return n;
};

export function createCameraFeed() {
  const prefs = { paused: false, zones: true, detections: true };
  let camera = null;
  let zones = [];
  let meta = null;
  let lastFrameAt = null;
  let imgError = false;
  let loading = false;
  let timer = null;
  let destroyed = false;

  const img = el('img', { alt: '', decoding: 'async' });
  const overlay = svg('svg', { class: 'overlay', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
  const stateBox = el('div', { class: 'feed-state', hidden: true });
  const badges = el('div', { class: 'feed-badge' });
  const timeChip = el('div', { class: 'feed-time', hidden: true });
  const feed = el('div', { class: 'feed', role: 'img', 'aria-label': 'Camera view' }, img, overlay, badges, timeChip, stateBox);

  const mkToggle = (key, iconId, label, title) => {
    const b = el('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': String(prefs[key] === (key !== 'paused') ? true : false), title },
      icon(iconId, 'icon icon-sm'), el('span', {}, label));
    return b;
  };
  const pauseBtn = el('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': 'false', title: 'Freeze this view. Detection and alerts continue in the background.' },
    icon('pause', 'icon icon-sm'), el('span', {}, 'Pause view'));
  const zoneBtn = mkToggle('zones', 'zone', 'Zone', 'Show or hide the marked zone outline');
  const detBtn = mkToggle('detections', 'box', 'Detections', 'Show or hide detection boxes');
  const refreshBtn = el('button', { type: 'button', class: 'btn btn-sm btn-icon', 'aria-label': 'Load the newest frame now', title: 'Load the newest frame now' }, icon('refresh', 'icon icon-sm'));
  const fsBtn = el('button', { type: 'button', class: 'btn btn-sm btn-icon', 'aria-label': 'Show camera full screen', title: 'Full screen' }, icon('expand', 'icon icon-sm'));
  if (!document.fullscreenEnabled) fsBtn.hidden = true;

  const title = el('h2', { id: 'cam-title' }, icon('camera'), el('span', {}, 'Camera'));
  const headBadges = el('div', { class: 'row' });
  const meta1 = el('dl', { class: 'feed-meta' });
  const zoneLine = el('div', { class: 'zone-line' });

  const root = el('section', { class: 'panel camera-panel', 'aria-labelledby': 'cam-title' },
    el('div', { class: 'panel-head' }, el('div', { class: 'row' }, title, headBadges),
      el('div', { class: 'feed-toolbar', role: 'toolbar', 'aria-label': 'Camera view controls' }, pauseBtn, zoneBtn, detBtn, refreshBtn, fsBtn)),
    el('div', { class: 'panel-body' }, feed, meta1, zoneLine),
  );

  pauseBtn.addEventListener('click', () => {
    prefs.paused = !prefs.paused;
    pauseBtn.setAttribute('aria-pressed', String(prefs.paused));
    clear(pauseBtn, icon(prefs.paused ? 'play' : 'pause', 'icon icon-sm'), el('span', {}, prefs.paused ? 'Resume view' : 'Pause view'));
    if (!prefs.paused) poll(true);
    render();
  });
  zoneBtn.addEventListener('click', () => {
    prefs.zones = !prefs.zones;
    zoneBtn.setAttribute('aria-pressed', String(prefs.zones));
    drawOverlay();
  });
  detBtn.addEventListener('click', () => {
    prefs.detections = !prefs.detections;
    detBtn.setAttribute('aria-pressed', String(prefs.detections));
    drawOverlay();
  });
  refreshBtn.addEventListener('click', () => poll(true));
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else feed.requestFullscreen?.().catch(() => undefined);
  });
  const onFs = () => {
    const on = document.fullscreenElement === feed;
    fsBtn.setAttribute('aria-label', on ? 'Exit full screen' : 'Show camera full screen');
    clear(fsBtn, icon(on ? 'shrink' : 'expand', 'icon icon-sm'));
  };
  document.addEventListener('fullscreenchange', onFs);

  async function poll(force = false) {
    if (destroyed || !camera || loading) return;
    if (prefs.paused && !force) return;
    loading = true;
    try {
      const m = await api.get(`/api/cameras/${encodeURIComponent(camera.id)}/live.json`);
      if (force || m.frameAt !== lastFrameAt) {
        await loadImage(`/api/cameras/${encodeURIComponent(camera.id)}/live.jpg?t=${encodeURIComponent(m.frameAt)}`);
        meta = m;
        lastFrameAt = m.frameAt;
        imgError = false;
      }
    } catch (err) {
      if (err.status === 404) meta = null;
      imgError = err.status !== 404;
    } finally {
      loading = false;
      render();
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => {
        img.src = src;
        resolve();
      };
      probe.onerror = () => reject(new Error('image failed'));
      probe.src = src;
    });
  }

  function schedule() {
    clearInterval(timer);
    const live = camera?.feedState === 'live';
    timer = setInterval(() => {
      if (!document.hidden) poll();
    }, live ? 1000 : 4000);
  }

  function drawOverlay() {
    overlay.replaceChildren();
    if (!meta) return;
    const W = meta.width;
    const H = meta.height;
    overlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const fs = Math.max(12, Math.round(W / 55));
    const label = (x, y, text, cls) => {
      const t = svg('text', { x, y, class: `lbl ${cls}`, 'font-size': fs });
      t.textContent = text;
      return t;
    };
    if (prefs.zones) {
      for (const z of zones) {
        if (!z.polygon) continue;
        const pts = z.polygon.map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(' ');
        overlay.append(svg('polygon', { points: pts, class: `zone-shape ${z.displayState === 'alerting' ? 'is-alert' : ''}` }));
        const [lx, ly] = z.polygon.reduce((a, p) => (p[1] < a[1] ? p : a));
        overlay.append(label(lx * W + 6, ly * H - 8, z.label, 'zone-lbl'));
      }
    }
    if (prefs.detections) {
      for (const d of meta.detections) {
        const cls = d.inZone ? 'det-hit' : d.countsForAlert ? 'det-counts' : 'det-weak';
        const x = d.box.x1 * W;
        const y = d.box.y1 * H;
        const w = (d.box.x2 - d.box.x1) * W;
        const h = (d.box.y2 - d.box.y1) * H;
        overlay.append(svg('rect', { x, y, width: w, height: h, rx: 3, class: `det ${cls}` }));
        overlay.append(svg('circle', { cx: x + w / 2, cy: y + h, r: Math.max(4, fs / 3), class: `det-foot ${cls}` }));
        overlay.append(label(x + 2, Math.max(fs, y - 6), `${d.label} ${Math.round(d.confidence * 100)}%${d.inZone ? ' · in zone' : ''}`, cls));
      }
    }
  }

  function render() {
    if (!camera) {
      title.lastChild.textContent = 'Camera';
      clear(headBadges);
      setState('camera-off', 'No camera has reported yet', 'The camera worker has not started or cannot reach the database. Zone status is UNKNOWN.');
      clear(meta1);
      clear(zoneLine);
      return;
    }
    title.lastChild.textContent = camera.label;
    feed.setAttribute('aria-label', `Latest frame from ${camera.label}. Feed ${FEED[camera.feedState].label}.`);
    clear(headBadges, feedBadge(camera.feedState, { pill: true }),
      camera.detectorKind === 'simulated'
        ? el('span', { class: 'pill tone-sim', title: 'The scripted demo detector draws boxes from a timeline. It is not a real model.' }, icon('flask'), 'Simulated detector')
        : camera.detectorKind === 'inference'
          ? el('span', { class: 'pill tone-real', title: 'Boxes come from the detection model running on this camera.' }, icon('cpu'), 'Real detection')
          : null);

    const frameAge = meta ? secondsSince(meta.frameAt) : Infinity;
    clear(badges,
      camera.feedState === 'live' && !prefs.paused ? el('span', { class: 'badge tone-urgent' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), 'LIVE') : null,
      prefs.paused ? el('span', { class: 'badge tone-warn' }, icon('pause'), 'View paused') : null,
      meta?.source === 'simulated' ? el('span', { class: 'badge tone-sim' }, icon('flask'), 'Simulated footage') : null);
    timeChip.hidden = !meta;
    if (meta) timeChip.textContent = Number.isFinite(frameAge) ? `Frame ${fmtDuration(frameAge)} old` : '';

    feed.classList.toggle('is-degraded', camera.feedState !== 'live');
    const f = FEED[camera.feedState];
    if (camera.feedState === 'reconnecting') {
      setState('refresh', 'Reconnecting to the camera',
        `${camera.reconnectAttempts ? `Attempt ${camera.reconnectAttempts}` : 'Starting'}${camera.nextRetryAt ? `, next try ${until(camera.nextRetryAt)}` : ''}. Zone status is UNKNOWN until frames return.${camera.lastError ? ` ${camera.lastError}` : ''}`);
    } else if (camera.feedState === 'stale') {
      setState('clock', 'Camera feed is stale', `No new frame for ${ago(camera.lastFrameAt).replace(' ago', '')}. Zone status is UNKNOWN.`);
    } else if (camera.feedState === 'offline') {
      setState('camera-off', 'Camera offline', `The camera worker has not reported ${camera.workerSeenAt ? `for ${ago(camera.workerSeenAt).replace(' ago', '')}` : 'yet'}. Zone status is UNKNOWN.`);
    } else if (imgError) {
      setState('image-off', 'Could not load the latest frame', 'The camera is live but the image did not load. Retrying automatically.', true);
    } else if (!meta) {
      setState('camera', 'Waiting for the first frame…', 'This usually takes a few seconds after the camera starts.');
    } else {
      stateBox.hidden = true;
    }
    if (!stateBox.hidden) stateBox.dataset.tone = f.tone;

    clear(meta1,
      metaItem('Feed', f.label, f.explain),
      metaItem('Last frame', camera.lastFrameAt ? ago(camera.lastFrameAt) : 'none yet', 'When the vision worker last processed a frame.'),
      metaItem('Processing rate', camera.processedFps ? `${camera.processedFps.toFixed(1)} frames/s` : '—', 'Frames analysed per second.'),
      metaItem('Detection time', camera.detectorKind === 'simulated' ? 'n/a (simulated)' : camera.inferenceMs ? `${Math.round(camera.inferenceMs)} ms per frame` : '—', 'Time the detector takes per frame.'),
      metaItem('Frames skipped', String(camera.droppedFrames ?? 0), 'Older frames are skipped when the detector falls behind, so alerts are never delayed by a backlog.'));

    const z = zones[0];
    if (z) {
      const def = ZONE[z.displayState] || ZONE.unknown;
      zoneLine.className = `zone-line tone-${def.tone === 'ok' ? '' : def.tone}`;
      clear(zoneLine, icon(def.icon),
        el('div', {}, el('div', { class: 'row' }, el('strong', {}, z.label), zoneBadge(z.displayState)),
          el('p', { class: 'small' }, def.explain)));
    } else clear(zoneLine);
    drawOverlay();
  }

  function setState(iconId, heading, text, withRetry = false) {
    stateBox.hidden = false;
    clear(stateBox, icon(iconId), el('strong', {}, heading), el('p', {}, text),
      withRetry ? el('button', { type: 'button', class: 'btn btn-sm', onclick: () => poll(true) }, icon('refresh', 'icon icon-sm'), 'Try again') : null);
  }

  function metaItem(k, v, title) {
    return el('div', { class: 'meta', title }, el('dt', {}, k), el('dd', {}, v));
  }

  return {
    root,
    update(cam, zoneStates) {
      const changedState = cam?.feedState !== camera?.feedState || cam?.id !== camera?.id;
      camera = cam;
      zones = (zoneStates || []).filter((z) => z.cameraId === cam?.id);
      if (changedState) schedule();
      if (!lastFrameAt && cam) poll(true);
      render();
    },
    destroy() {
      destroyed = true;
      clearInterval(timer);
      document.removeEventListener('fullscreenchange', onFs);
    },
  };
}
