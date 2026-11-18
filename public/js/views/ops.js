// Operations: live map + prioritised incident queue for rangers.
import { createMap, legend } from '../map.js';
import { api, BOOT, clear, el, icon, qs, runAction, toast } from '../lib.js';
import { incidentItem } from '../status.js';
import * as store from '../store.js';

const RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const priority = (i) => (i.kind === 'sos' ? 100 : 0) + (i.status === 'open' ? 50 : 0) + (RANK[i.risk_level] || 0) * 10;

export function mount(main, ctx) {
  // Rangers start on their own assigned area; "All areas" is one choice away.
  let area = ctx.params.area ?? null;
  let kind = ctx.params.kind || '';
  let showDetections = true;
  let mapApi = null;
  let data = null;
  let seen = null;
  let sound = false;
  let zonesKey = '';

  const areaSel = el('select', { id: 'ops-area', 'aria-label': 'Area' }, el('option', { value: '' }, 'All areas'));
  const kindSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Incident type' });
  const detBtn = el('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': 'true', title: 'Show animal sightings from the last 6 hours' }, icon('paw', 'icon icon-sm'), 'Sightings');
  const soundBtn = el('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': 'false', title: 'Play a short tone when a new SOS or critical alert arrives' }, icon('siren', 'icon icon-sm'), 'Sound');
  // Phones show the list or the map, one at a time; larger screens show both.
  let view = 'list';
  const viewSeg = el('div', { class: 'seg ops-view-seg', role: 'group', 'aria-label': 'Show' });
  const grid = el('div', { class: 'ops-grid show-list' });
  const mapBox = el('div', {});
  const queue = el('div', { class: 'queue-list', 'aria-live': 'polite' });
  const queueCount = el('span', { class: 'muted small' });
  const scenarioBox = el('div', {});

  grid.append(
    el('section', { class: 'panel ops-map', 'aria-labelledby': 'map-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'map-title' }, icon('map'), 'Map'), el('div', { class: 'row' }, detBtn, soundBtn)),
      el('div', { class: 'panel-body' }, mapBox, legend())),
    el('section', { class: 'panel queue', 'aria-labelledby': 'q-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'q-title' }, icon('incident'), 'Active incidents'), queueCount),
      el('div', { class: 'panel-body stack' }, kindSeg, queue)));
  main.append(
    el('div', { class: 'page-head ops-head' },
      el('div', {}, el('h1', {}, 'Live map'), el('p', { class: 'sub' }, 'Open alerts and emergencies.')),
      el('div', { class: 'page-actions' }, areaSel)),
    el('div', { class: 'radio-reminder' }, icon('radio'), el('span', {}, el('strong', {}, 'Radio first. '), 'Always verify alerts on the ground.')),
    viewSeg, grid, scenarioBox,
  );

  function renderViewSeg(count) {
    clear(viewSeg, [['list', 'incident', count === undefined ? 'Incidents' : `Incidents (${count})`], ['map', 'map', 'Map']].map(([v, ic, l]) =>
      el('button', { type: 'button', 'aria-pressed': String(view === v), onclick: () => {
        view = v;
        grid.classList.toggle('show-list', v === 'list');
        grid.classList.toggle('show-map', v === 'map');
        renderViewSeg(count);
        // The map was laid out while hidden: resize it and re-fit the area now that it is visible.
        if (v === 'map') requestAnimationFrame(() => { mapApi?.map.invalidateSize(); fitArea(); });
      } }, icon(ic, 'icon icon-sm'), l)));
  }
  renderViewSeg();
  clear(queue, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'));

  function renderKindSeg() {
    clear(kindSeg, [['', 'All'], ['sos', 'SOS'], ['wildlife', 'Wildlife'], ['zone_alert', 'Gate camera']].map(([v, l]) =>
      el('button', { type: 'button', 'aria-pressed': String(kind === v), onclick: () => { kind = v; renderKindSeg(); renderQueue(); } }, l)));
  }
  renderKindSeg();

  areaSel.addEventListener('change', () => {
    area = areaSel.value;
    ctx.navigate(`#/ops${qs({ area })}`, { replace: true });
  });
  detBtn.addEventListener('click', () => {
    showDetections = !showDetections;
    detBtn.setAttribute('aria-pressed', String(showDetections));
    draw(true);
  });
  soundBtn.addEventListener('click', () => {
    sound = !sound;
    soundBtn.setAttribute('aria-pressed', String(sound));
    if (sound) beep();
  });

  async function load() {
    try {
      if (area === null) area = (await api.get('/api/me').catch(() => null))?.operator?.area_id || '';
      data = await api.get(`/api/map${qs({ area })}`);
      if (areaSel.options.length === 1) {
        for (const a of data.areas) areaSel.append(el('option', { value: a.id }, a.name));
        areaSel.value = area;
      }
      if (!mapApi) {
        const a = data.areas.find((x) => x.id === area);
        mapApi = await createMap(mapBox, a ? { center: [a.center_lat, a.center_lng], zoom: a.zoom } : {});
      }
      draw();
      renderQueue();
    } catch (err) {
      clear(queue, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), `Could not load operations data: ${err.message}`));
    }
  }

  function fitArea() {
    if (!mapApi || !data) return;
    const pts = data.zones.flatMap((z) => z.geometry).concat(data.cameras.filter((c) => c.lat !== null && (!area || c.area_id === area)).map((c) => [c.lat, c.lng]));
    if (pts.length) mapApi.fitTo(pts);
  }

  function draw(force = false) {
    if (!mapApi || !data) return;
    const zk = JSON.stringify([area, data.zones.map((z) => z.id + z.updated_at)]);
    if (zk !== zonesKey || force) {
      mapApi.drawZones(data.zones);
      mapApi.drawCameras(data.cameras.filter((c) => !area || c.area_id === area));
      if (zk !== zonesKey && (area || !zonesKey)) fitArea();
      zonesKey = zk;
    }
    mapApi.drawDetections(showDetections ? data.detections : []);
    mapApi.drawIncidents(data.incidents.filter((i) => !kind || i.kind === kind));
  }

  function renderQueue() {
    if (!data) return;
    const list = data.incidents.filter((i) => !kind || i.kind === kind).sort((a, b) => priority(b) - priority(a) || Date.parse(b.opened_at) - Date.parse(a.opened_at));
    queueCount.textContent = `${list.length} active`;
    renderViewSeg(list.length);
    // New urgent incidents: toast (+ optional tone).
    const urgent = data.incidents.filter((i) => i.status === 'open' && (i.kind === 'sos' || i.risk_level === 'critical'));
    if (seen) {
      for (const i of urgent) if (!seen.has(i.id)) {
        toast(`${i.kind === 'sos' ? 'New SOS' : 'Critical alert'}: ${i.ref} ${i.title || ''}`, 'error', 9000);
        if (sound) beep();
      }
    }
    seen = new Set(data.incidents.map((i) => i.id));
    if (!list.length) {
      clear(queue, el('div', { class: 'empty' }, icon('check-circle'), el('strong', {}, 'No active incidents'),
        el('p', {}, 'Nothing is pending or being responded to. Cameras can miss animals — keep normal patrols and radio checks.')));
      return;
    }
    clear(queue, list.map((i) => {
      let actions = null;
      if (i.status === 'open') {
        const respond = el('button', { type: 'button', class: `btn btn-sm ${i.kind === 'sos' || i.risk_level === 'critical' ? 'btn-urgent' : 'btn-primary'}` }, icon('user', 'icon icon-sm'), el('span', {}, "I'm responding"));
        const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
        respond.addEventListener('click', () => runAction(respond, status, async () => {
          const r = await api.post(`/api/incidents/${i.id}/status`, { status: 'responding' });
          if (r.alreadyResponding) throw new Error(`${r.event.acknowledged_by} is already responding.`);
          await Promise.all([load(), store.refresh()]);
        }, { success: `You are responding to ${i.ref}. Coordinate by radio.` }));
        actions = [respond, status];
      }
      return incidentItem(i, { areaName: area ? null : data.areas.find((a) => a.id === i.area_id)?.name, actions });
    }));
  }

  async function loadScenarios() {
    if (!BOOT.permissions?.canRunSimulations) return;
    try {
      const s = await api.get('/api/sim/scenarios');
      const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
      const pauseBtn = el('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': String(!s.paused) }, s.paused ? 'Background simulator: paused' : `Background simulator: on (every ${s.intervalSeconds} s)`);
      pauseBtn.addEventListener('click', () => runAction(pauseBtn, status, async () => {
        await api.post('/api/sim/state', { paused: !s.paused });
        await loadScenarios();
      }));
      clear(scenarioBox, el('details', { class: 'panel section' },
        el('summary', { class: 'panel-head' }, el('h2', {}, icon('flask'), 'Demo scenarios'), el('span', { class: 'badge tone-sim' }, 'Simulated')),
        el('div', { class: 'panel-body stack' },
          el('div', { class: 'row' }, pauseBtn, status),
          el('div', { class: 'glossary' }, s.scenarios.map((sc) => {
            const b = el('button', { type: 'button', class: 'btn btn-sm' }, icon('play', 'icon icon-sm'), el('span', {}, 'Run'));
            const st = el('span', { class: 'form-status', 'aria-live': 'polite' });
            b.addEventListener('click', () => runAction(b, st, async () => {
              const r = await api.post('/api/sim/scenario', { id: sc.id });
              st.className = 'form-status is-ok';
              clear(st, `Risk ${r.risk.level.toUpperCase()}${r.incident ? ` → ${r.incident.ref} ${r.incident.created ? 'opened' : r.incident.escalated ? 'escalated' : 'updated'}` : ' — logged, no alert'}`);
              await Promise.all([load(), store.refresh()]);
            }));
            return el('div', { class: 'gloss-item' }, el('div', { class: 'stack' }, b), el('div', {}, el('strong', {}, sc.label), el('div', {}, st)));
          })))));
    } catch {
      clear(scenarioBox);
    }
  }

  load();
  loadScenarios();
  const timer = setInterval(() => {
    if (!document.hidden) load();
  }, 5000);
  return {
    onParams(p) {
      area = p.area || '';
      areaSel.value = area;
      zonesKey = 'reset';
      load();
    },
    destroy() {
      clearInterval(timer);
      mapApi?.destroy();
    },
  };
}

let audioCtx = null;
function beep() {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.5);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.5);
  } catch {
    /* audio unavailable */
  }
}
