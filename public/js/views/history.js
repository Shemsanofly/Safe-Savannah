// History & reports: summaries derived only from stored records, per-day chart with table view, CSV export.
import { api, BOOT, clear, el, fmtDuration, icon, lodgeToday, qs } from '../lib.js';

const PRESETS = [
  { id: 'today', label: 'Today', days: 0 },
  { id: '7', label: 'Last 7 days', days: 6 },
  { id: '30', label: 'Last 30 days', days: 29 },
  { id: '90', label: 'Last 90 days', days: 89 },
];
const SOURCES = [
  { value: '', label: 'All sources' },
  { value: 'inference', label: 'Real detections only' },
  { value: 'simulated,synthetic', label: 'Simulated & test only' },
];

export function mount(main, ctx) {
  let range = initialRange(ctx.params);
  let controller = null;
  let summary = null;

  const presetSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Date range' });
  const fromIn = el('input', { type: 'date', id: 'h-from', value: range.from, max: lodgeToday() });
  const toIn = el('input', { type: 'date', id: 'h-to', value: range.to, max: lodgeToday() });
  const sourceSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Detection source' });
  const rangeErr = el('p', { class: 'field-error', hidden: true, role: 'alert' });
  const body = el('div', { 'aria-live': 'polite' });
  const actions = el('div', { class: 'page-actions' });

  main.append(
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', {}, 'History & reports'), el('p', { class: 'sub' }, 'Summaries calculated from the incidents stored on this system.')),
      actions),
    el('div', { class: 'filters' },
      el('div', { class: 'filters-row' }, presetSeg),
      el('div', { class: 'filters-row' },
        el('div', { class: 'field' }, el('label', { for: 'h-from' }, 'From (inclusive)'), fromIn),
        el('div', { class: 'field' }, el('label', { for: 'h-to' }, 'To (inclusive)'), toIn),
        el('div', { class: 'field grow' }, el('span', { class: 'label' }, 'Detection source'), sourceSeg)),
      rangeErr,
      el('p', { class: 'hint' }, `Days run midnight to midnight in lodge time (${BOOT.timeZone}).`)),
    body,
  );

  function renderControls() {
    clear(presetSeg, PRESETS.map((p) => el('button', {
      type: 'button', 'aria-pressed': String(range.preset === p.id),
      onclick: () => setRange({ preset: p.id, from: lodgeToday(-p.days), to: lodgeToday() }),
    }, icon('calendar', 'icon icon-sm'), p.label)));
    clear(sourceSeg, SOURCES.map((s) => el('button', { type: 'button', 'aria-pressed': String(range.source === s.value), onclick: () => setRange({ source: s.value }) }, s.label)));
    fromIn.value = range.from;
    toIn.value = range.to;
    const listQs = qs({ from: range.from, to: range.to, source: range.source });
    clear(actions,
      el('a', { class: 'btn', href: `#/incidents${listQs}` }, icon('incident'), 'Open in incident list'),
      BOOT.permissions?.canExport ? el('a', { class: 'btn btn-primary', href: `/api/incidents/export.csv${listQs}`, download: '' }, icon('download'), 'Export CSV') : null);
  }

  for (const d of [fromIn, toIn]) d.addEventListener('change', () => setRange({ preset: 'custom', from: fromIn.value, to: toIn.value }));

  function setRange(patch) {
    const next = { ...range, ...patch };
    if (!next.from || !next.to || next.from > next.to) {
      rangeErr.hidden = false;
      clear(rangeErr, icon('alert', 'icon icon-sm'), 'Choose a start date on or before the end date.');
      fromIn.setAttribute('aria-invalid', 'true');
      return;
    }
    rangeErr.hidden = true;
    fromIn.removeAttribute('aria-invalid');
    range = next;
    ctx.navigate(`#/history${qs({ from: range.from, to: range.to, source: range.source, preset: range.preset })}`, { replace: true });
  }

  async function load() {
    renderControls();
    controller?.abort();
    controller = new AbortController();
    clear(body, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Calculating…'));
    try {
      summary = await api.get(`/api/reports/summary${qs({ from: range.from, to: range.to, source: range.source })}`, { signal: controller.signal });
      render();
    } catch (err) {
      if (err.name === 'AbortError') return;
      clear(body, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), el('div', { class: 'grow' }, el('strong', {}, 'Could not load the report. '), err.message),
        el('button', { type: 'button', class: 'btn btn-sm', onclick: load }, 'Try again')));
    }
  }

  function render() {
    const s = summary;
    const rangeLabel = `${fmtDay(s.range.from)} – ${fmtDay(s.range.to)}`;
    const sourceLabel = SOURCES.find((x) => x.value === (range.source || ''))?.label || 'All sources';
    const caveat = el('div', { class: 'alert alert-info' }, icon('info'), el('div', { class: 'grow' },
      el('strong', {}, 'How to read these numbers. '),
      'They count records stored on this system for the selected days',
      range.source ? '' : ', including simulated and test incidents',
      '. They describe this workflow, not detection accuracy: missed elephants never appear here, so a low count does not mean the area was safe.'));

    if (s.totals.incidents === 0) {
      clear(body, caveat, el('div', { class: 'panel', style: null }, el('div', { class: 'empty' }, icon('chart'),
        el('strong', {}, 'No incidents were opened in this range'),
        el('p', {}, `${rangeLabel} · ${sourceLabel}. There is nothing to summarise, so no averages are shown.`))));
      return;
    }
    const t = s.totals;
    const a = s.acknowledgement;

    const tiles = el('div', { class: 'tiles' },
      tile('incident', 'Incidents opened', String(t.incidents), null, `${rangeLabel}`),
      tile('check-circle', 'Closed — verified', String(t.closed), null, pct(t.closed, t.incidents)),
      tile('x', 'False alerts', String(t.falseAlerts), null, pct(t.falseAlerts, t.incidents)),
      tile('clock', 'Still active', String(t.open + t.acknowledged), null, `${t.open} not yet acknowledged`, t.open ? 'urgent' : ''),
      a.count
        ? tile('user', 'Median time to acknowledge', ...durParts(a.medianSeconds), `From alert opening · ${a.count} acknowledged · mean ${fmtDuration(a.meanSeconds)}, longest ${fmtDuration(a.maxSeconds)}`)
        : tile('user', 'Median time to acknowledge', '—', null, 'No acknowledged incidents in this range'),
      s.resolution.count
        ? tile('check', 'Median time to close', ...durParts(s.resolution.medianSeconds), `From alert opening · ${s.resolution.count} closed or dismissed`)
        : tile('check', 'Median time to close', '—', null, 'No closed incidents in this range'),
    );

    const days = fillDays(s.range.from, s.range.to, s.perDay);
    const chartBox = el('div', { class: 'chart' });
    const tableView = el('details', {}, el('summary', { class: 'small strong' }, 'Show as table'),
      el('div', { class: 'table-wrap', style: null }, el('table', { class: 'data' },
        el('caption', { class: 'sr-only' }, 'Incidents opened per day'),
        el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, `Day (${BOOT.timeZone})`), el('th', { scope: 'col', class: 'num' }, 'Incidents opened'), el('th', { scope: 'col', class: 'num' }, 'Of which false alerts'))),
        el('tbody', {}, days.map((d) => el('tr', {}, el('td', {}, fmtDay(d.day)), el('td', { class: 'num' }, d.incidents), el('td', { class: 'num' }, d.falseAlerts)))))));

    const maxZone = Math.max(...s.byZone.map((z) => z.n), 1);
    const bySource = Object.entries(s.bySource).map(([k, n]) => `${{ inference: 'Real detection', simulated: 'Simulated', synthetic: 'Test data' }[k] || k}: ${n}`).join(' · ');

    clear(body, caveat, el('div', { class: 'section' }, tiles),
      el('div', { class: 'cols-2 section' },
        el('section', { class: 'panel', 'aria-labelledby': 'perday-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'perday-title' }, 'Incidents opened per day'), el('span', { class: 'muted small' }, `${rangeLabel} · ${sourceLabel}`)),
          el('div', { class: 'panel-body stack' }, chartBox, tableView)),
        el('section', { class: 'panel', 'aria-labelledby': 'zone-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'zone-title' }, 'Incidents by zone')),
          el('div', { class: 'panel-body stack' },
            el('div', { class: 'bar-list' }, s.byZone.map((z) => el('div', { class: 'bar-row' },
              el('span', { class: 'strong' }, z.zone_label),
              el('span', { class: 'bar-track', 'aria-hidden': 'true' }, sized(el('span', { class: 'bar-fill' }), z.n / maxZone)),
              el('span', { class: 'num strong' }, String(z.n))))),
            el('p', { class: 'small muted' }, `By detection source — ${bySource}.`)))));
    drawChart(chartBox, days);
  }

  // Per-day bar chart. Single series → no legend; the panel title names it.
  function drawChart(box, days) {
    const draw = () => {
      const W = Math.max(280, box.clientWidth || 600);
      const H = 220;
      const pad = { l: 34, r: 8, t: 12, b: 28 };
      const max = Math.max(1, ...days.map((d) => d.incidents));
      const step = niceStep(max);
      const top = Math.ceil(max / step) * step;
      const plotW = W - pad.l - pad.r;
      const plotH = H - pad.t - pad.b;
      const slot = plotW / days.length;
      const gap = Math.min(2 + slot * 0.25, 10);
      const bw = Math.max(1, slot - gap);
      const ns = 'http://www.w3.org/2000/svg';
      const svgEl = document.createElementNS(ns, 'svg');
      svgEl.setAttribute('class', 'chart-svg');
      svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svgEl.setAttribute('role', 'img');
      svgEl.setAttribute('aria-label', `Bar chart of incidents opened per day. Highest: ${max} in a day. Use the table view for exact values.`);
      const mk = (tag, attrs, text) => {
        const n = document.createElementNS(ns, tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
        if (text !== undefined) n.textContent = text;
        svgEl.append(n);
        return n;
      };
      for (let v = 0; v <= top; v += step) {
        const y = pad.t + plotH - (v / top) * plotH;
        mk('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'grid' });
        mk('text', { x: pad.l - 6, y: y + 4, 'text-anchor': 'end', class: 'axis-label' }, String(v));
      }
      const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor(plotW / 64)));
      const tip = el('div', { class: 'chart-tip', hidden: true, role: 'status' });
      days.forEach((d, i) => {
        const x = pad.l + i * slot + gap / 2;
        const h = (d.incidents / top) * plotH;
        const base = pad.t + plotH;
        let bar = null;
        if (h > 0) {
          const r = Math.min(4, bw / 2, h);
          bar = mk('path', { class: 'bar', d: `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + bw - r} Q${x + bw},${base - h} ${x + bw},${base - h + r} V${base} Z` });
        }
        if (i % labelEvery === 0) mk('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle', class: 'axis-label' }, shortDay(d.day));
        const hit = mk('rect', { x: pad.l + i * slot, y: pad.t, width: slot, height: plotH, class: 'bar-hit', tabindex: '0',
          'aria-label': `${fmtDay(d.day)}: ${d.incidents} incident${d.incidents === 1 ? '' : 's'}, ${d.falseAlerts} false alert${d.falseAlerts === 1 ? '' : 's'}` });
        const show = () => {
          bar?.classList.add('is-hover');
          tip.hidden = false;
          tip.textContent = `${fmtDay(d.day)} · ${d.incidents} incident${d.incidents === 1 ? '' : 's'}${d.falseAlerts ? ` (${d.falseAlerts} false)` : ''}`;
          const scale = box.clientWidth / W;
          tip.style.left = `${(x + bw / 2) * scale}px`;
          tip.style.top = `${(base - h) * scale}px`;
        };
        const hide = () => {
          bar?.classList.remove('is-hover');
          tip.hidden = true;
        };
        hit.addEventListener('mouseenter', show);
        hit.addEventListener('focus', show);
        hit.addEventListener('mouseleave', hide);
        hit.addEventListener('blur', hide);
      });
      mk('line', { x1: pad.l, x2: W - pad.r, y1: pad.t + plotH, y2: pad.t + plotH, class: 'grid' });
      box.replaceChildren(svgEl, tip);
    };
    draw();
    resizeObs?.disconnect();
    let lastW = box.clientWidth;
    resizeObs = new ResizeObserver(() => {
      if (Math.abs(box.clientWidth - lastW) > 4) {
        lastW = box.clientWidth;
        draw();
      }
    });
    resizeObs.observe(box);
  }
  let resizeObs = null;

  load();
  return {
    onParams(p) {
      range = initialRange(p);
      load();
    },
    destroy() {
      controller?.abort();
      resizeObs?.disconnect();
    },
  };
}

function initialRange(p) {
  const valid = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if (valid(p.from) && valid(p.to)) return { from: p.from, to: p.to, source: p.source || '', preset: p.preset || 'custom' };
  return { from: lodgeToday(-6), to: lodgeToday(), source: p.source || '', preset: '7' };
}

function fillDays(from, to, perDay) {
  const map = new Map(perDay.map((d) => [d.day, d]));
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(map.get(day) || { day, incidents: 0, falseAlerts: 0 });
  }
  return out;
}
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}% of incidents opened` : '');
function niceStep(max) {
  if (max <= 5) return 1;
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
}
function durParts(seconds) {
  if (seconds < 1) return ['< 1', 'second'];
  if (seconds < 10) return [seconds.toFixed(1), 'seconds'];
  if (seconds < 60) return [String(Math.round(seconds)), 'seconds'];
  if (seconds < 3600) return [(seconds / 60).toFixed(1), 'minutes'];
  return [(seconds / 3600).toFixed(1), 'hours'];
}
function tile(iconId, label, value, unit, note, tone = '') {
  return el('div', { class: `tile ${tone ? `is-${tone}` : ''}` },
    el('span', { class: 'tile-label' }, icon(iconId, 'icon icon-sm'), label),
    el('span', { class: 'tile-value' }, value, unit ? el('span', { class: 'unit' }, unit) : null),
    note ? el('span', { class: 'tile-note' }, note) : null);
}
function sized(node, frac) {
  node.style.width = `${Math.max(2, Math.round(frac * 100))}%`;
  return node;
}
