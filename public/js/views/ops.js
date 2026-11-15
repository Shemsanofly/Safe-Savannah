// Operations: live map + prioritised incident queue for rangers.
import { createMap, legend } from '../map.js';
import { age, api, BOOT, clear, el, fmtTime, icon, qs, runAction, toast } from '../lib.js';
import { EMERGENCY, incidentBadge, kindBadge, riskBadge, demoBadge } from '../status.js';
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
  const detBtn = el('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': 'true' }, icon('paw', 'icon icon-sm'), 'Detections (6 h)');
  const soundBtn = el('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': 'false', title: 'Play a short tone when a new SOS or critical alert arrives' }, icon('siren', 'icon icon-sm'), 'Alert sound');
  const mapBox = el('div', {});
  const queue = el('div', { class: 'queue-list', 'aria-live': 'polite' });
  const queueCount = el('span', { class: 'muted small' });
  const scenarioBox = el('div', {});

  main.append(
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Operations'), el('p', { class: 'sub' }, 'Live wildlife risk and tourist emergencies across your parks.')),
      el('div', { class: 'page-actions' }, areaSel)),
    el('div', { class: 'radio-reminder' }, icon('radio'), el('span', {}, el('strong', {}, 'Radio first. '), 'Use this screen alongside your radio and phone procedures. Verify every alert on the ground; a quiet map never means an area is safe.')),
    el('div', { class: 'ops-grid' },
      el('section', { class: 'panel', 'aria-labelledby': 'map-title' },
        el('div', { class: 'panel-head' }, el('h2', { id: 'map-title' }, icon('map'), 'Map'), el('div', { class: 'row' }, detBtn, soundBtn)),
        el('div', { class: 'panel-body' }, mapBox, legend())),
      el('section', { class: 'panel queue', 'aria-labelledby': 'q-title' },
        el('div', { class: 'panel-head' }, el('h2', { id: 'q-title' }, icon('incident'), 'Active incidents'), queueCount),
        el('div', { class: 'panel-body stack' }, kindSeg, queue))),
    scenarioBox,
  );
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

  function draw(force = false) {
    if (!mapApi || !data) return;
    const zk = JSON.stringify([area, data.zones.map((z) => z.id + z.updated_at)]);
    if (zk !== zonesKey || force) {
      mapApi.drawZones(data.zones);
      mapApi.drawCameras(data.cameras.filter((c) => !area || c.area_id === area));
      if (zk !== zonesKey) {
        const pts = data.zones.flatMap((z) => z.geometry).concat(data.cameras.filter((c) => c.lat !== null && (!area || c.area_id === area)).map((c) => [c.lat, c.lng]));
        if (area || !zonesKey) mapApi.fitTo(pts);
      }
      zonesKey = zk;
    }
    mapApi.drawDetections(showDetections ? data.detections : []);
    mapApi.drawIncidents(data.incidents.filter((i) => !kind || i.kind === kind));
  }

  function renderQueue() {
    if (!data) return;
    const list = data.incidents.filter((i) => !kind || i.kind === kind).sort((a, b) => priority(b) - priority(a) || Date.parse(b.opened_at) - Date.parse(a.opened_at));
    queueCount.textContent = `${list.length} active`;
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
      const respond = el('button', { type: 'button', class: `btn btn-sm ${i.kind === 'sos' || i.risk_level === 'critical' ? 'btn-urgent' : 'btn-primary'}` }, icon('user', 'icon icon-sm'), el('span', {}, "I'm responding"));
      const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
      respond.addEventListener('click', () => runAction(respond, status, async () => {
        const r = await api.post(`/api/incidents/${i.id}/status`, { status: 'responding' });
        if (r.alreadyResponding) throw new Error(`${r.event.acknowledged_by} is already responding.`);
        await Promise.all([load(), store.refresh()]);
      }, { success: `You are responding to ${i.ref}. Coordinate by radio.` }));
      const em = i.emergency_type ? EMERGENCY[i.emergency_type] : null;
      return el('article', { class: `q-item r-${i.risk_level || 'none'} ${i.kind === 'sos' ? 'is-sos' : ''} ${i.status === 'open' ? 'is-open' : ''}` },
        el('div', { class: 'row' }, el('a', { href: `#/incidents/${i.id}`, class: 'inc-ref' }, i.ref), kindBadge(i.kind), riskBadge(i.risk_level), incidentBadge(i.status),
          i.source === 'simulated' ? el('span', { class: 'badge tone-sim' }, icon('flask'), 'Simulated') : null, i.demo ? demoBadge() : null),
        el('p', { class: 'q-title' }, em ? [icon(em.icon, 'icon icon-sm'), ' '] : null, i.title || i.zone_label || 'Incident'),
        el('p', { class: 'small muted' }, `${data.areas.find((a) => a.id === i.area_id)?.name || 'Area unknown'} · opened ${fmtTime(i.opened_at, false)} (${age(i.opened_at)} ago)${i.report_channel ? ` · via ${i.report_channel.toUpperCase()}` : ''}`),
        i.acknowledged_by_name ? el('p', { class: 'small strong' }, icon('user', 'icon icon-sm'), ` ${i.acknowledged_by_name} is responding`) : null,
        el('div', { class: 'row' }, i.status === 'open' ? respond : null, el('a', { class: 'btn btn-sm', href: `#/incidents/${i.id}` }, 'Details', icon('chevron-right', 'icon icon-sm')), status));
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
        el('summary', { class: 'panel-head' }, el('h2', {}, icon('flask'), 'Demo scenarios (simulated)'), el('span', { class: 'badge tone-sim' }, 'Creates SIMULATED detections')),
        el('div', { class: 'panel-body stack' },
          el('p', { class: 'small' }, 'Each scenario feeds a labelled simulated detection through the real risk engine, alerting and messaging. Harmless species near people stay low risk on purpose.'),
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
            return el('div', { class: 'gloss-item' }, el('div', { class: 'stack' }, b), el('div', {}, el('strong', {}, sc.label), el('p', { class: 'small muted' }, sc.description), st));
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
