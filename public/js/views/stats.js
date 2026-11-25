// Admin dashboard: wildlife activity and incident statistics derived from stored records.
import { api, clear, el, fmtDuration, icon } from '../lib.js';

export function mount(main, ctx) {
  let days = Number(ctx.params.days) || 14;
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' });
  const body = el('div', { 'aria-live': 'polite' });
  main.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Dashboard'), el('p', { class: 'sub' }, 'Activity at a glance.')),
      el('div', { class: 'page-actions' }, seg, el('a', { class: 'btn', href: '#/tourism' }, icon('home'), 'Tourism'), el('a', { class: 'btn', href: '#/history' }, icon('note'), 'Reports'))),
    body);

  const renderSeg = () => clear(seg, [7, 14, 30, 90].map((d) => el('button', { type: 'button', 'aria-pressed': String(days === d), onclick: () => { days = d; renderSeg(); load(); } }, `${d} days`)));
  renderSeg();

  async function load() {
    clear(body, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Calculating…'));
    try {
      const s = await api.get(`/api/stats?days=${days}`);
      render(s);
    } catch (err) {
      clear(body, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), `Could not load statistics: ${err.message}`));
    }
  }

  function render(s) {
    const det = s.detectionsBySpecies.reduce((a, r) => a + r.n, 0);
    const high = s.detectionsByRisk.filter((r) => r.risk_level === 'high' || r.risk_level === 'critical').reduce((a, r) => a + r.n, 0);
    const simulated = s.detectionsBySource.filter((r) => r.analysis === 'simulated').reduce((a, r) => a + r.n, 0);
    const inc = (kind) => s.incidentsByKindStatus.filter((r) => r.kind === kind).reduce((a, r) => a + r.n, 0);
    const open = s.incidentsByKindStatus.filter((r) => r.status === 'open' || r.status === 'acknowledged').reduce((a, r) => a + r.n, 0);
    const resp = (kind) => s.response.find((r) => r.kind === kind);
    const t = s.totals;
    const maxSpecies = Math.max(1, ...s.detectionsBySpecies.map((r) => r.n));
    clear(body,
      el('div', { class: 'tiles section' },
        tile('users', 'Tourists today', t.tourists_on_trip, null, null),
        tile('user', 'Rangers on duty', t.rangers_on_duty, null, null),
        tile('paw', 'Detections', det, null, simulated ? `${high} high risk · ${simulated} simulated` : `${high} high risk`),
        tile('siren', 'SOS reports', inc('sos'), null, null, inc('sos') ? 'warn' : ''),
        tile('clock', 'Still open', open, null, null, open ? 'urgent' : '')),
      el('div', { class: 'cols-2 section' },
        panel('Response times', 'clock', el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
          el('thead', {}, el('tr', {}, ['Type', 'Handled', 'Time to respond', 'Time to resolve'].map((h) => el('th', { scope: 'col' }, h)))),
          el('tbody', {}, ['sos', 'wildlife', 'zone_alert'].map((k) => {
            const r = resp(k);
            return el('tr', {}, el('td', {}, { sos: 'SOS', wildlife: 'Wildlife risk', zone_alert: 'Gate camera' }[k]),
              el('td', {}, r ? String(r.responded) : '0'), el('td', {}, r?.median_response_s != null ? fmtDuration(r.median_response_s) : '—'),
              el('td', {}, r?.median_resolve_s != null ? fmtDuration(r.median_resolve_s) : '—'));
          })))), null),
        panel('Detections by species', 'paw', s.detectionsBySpecies.length
          ? el('div', { class: 'bar-list' }, s.detectionsBySpecies.map((r) => el('div', { class: 'bar-row compact' },
              el('span', { class: 'strong' }, r.species === 'none' ? 'No wildlife' : r.species[0].toUpperCase() + r.species.slice(1)),
              el('span', { class: 'bar-track', title: `${r.high} high or critical` }, sized(el('span', { class: `bar-fill ${r.high ? 'is-high' : ''}` }), r.n / maxSpecies)),
              el('span', { class: 'num strong' }, String(r.n)))))
          : el('p', { class: 'muted' }, 'No detections in this range.'))));
  }

  load();
  return {};
}

function panel(title, iconId, ...children) {
  return el('section', { class: 'panel' }, el('div', { class: 'panel-head' }, el('h2', {}, icon(iconId), title)), el('div', { class: 'panel-body stack' }, ...children));
}
function tile(iconId, label, value, unit, note, tone = '') {
  return el('div', { class: `tile ${tone ? `is-${tone}` : ''}` }, el('span', { class: 'tile-label' }, icon(iconId, 'icon icon-sm'), label),
    el('span', { class: 'tile-value' }, String(value ?? 0), unit ? el('span', { class: 'unit' }, unit) : null), note ? el('span', { class: 'tile-note' }, note) : null);
}
function sized(n, frac) {
  n.style.width = `${Math.max(2, Math.round(frac * 100))}%`;
  return n;
}
