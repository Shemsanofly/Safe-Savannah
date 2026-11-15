// Admin dashboard: wildlife activity and incident statistics derived from stored records.
import { api, BOOT, clear, el, fmtDuration, icon } from '../lib.js';

export function mount(main, ctx) {
  let days = Number(ctx.params.days) || 14;
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' });
  const body = el('div', { 'aria-live': 'polite' });
  main.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Dashboard'), el('p', { class: 'sub' }, 'Wildlife activity and incident response, calculated from the records stored on this system.')),
      el('div', { class: 'page-actions' }, seg, el('a', { class: 'btn', href: '#/history' }, icon('note'), 'Reports & CSV'))),
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
    const real = det - simulated;
    const inc = (kind) => s.incidentsByKindStatus.filter((r) => r.kind === kind).reduce((a, r) => a + r.n, 0);
    const open = s.incidentsByKindStatus.filter((r) => r.status === 'open' || r.status === 'acknowledged').reduce((a, r) => a + r.n, 0);
    const resp = (kind) => s.response.find((r) => r.kind === kind);
    const t = s.totals;
    const range = `last ${s.days} days (${s.timeZone})`;
    const perDayMax = Math.max(1, ...s.perDay.map((d) => d.detections));
    const maxSpecies = Math.max(1, ...s.detectionsBySpecies.map((r) => r.n));
    clear(body,
      simulated > 0 ? el('div', { class: 'alert alert-info' }, icon('flask'), el('div', { class: 'grow' }, el('strong', {}, `${simulated} of ${det} detections in this range are simulated. `), 'They come from the camera simulator, demo scenarios or seeded demo history — not real animals. Real model detections: ', el('strong', {}, String(real)), '.')) : null,
      el('div', { class: 'tiles section' },
        tile('users', 'Tourists on trip today', t.tourists_on_trip, null, 'Registered, trip dates include today'),
        tile('user', 'Rangers on duty', t.rangers_on_duty, null, 'Receive alert SMS and calls'),
        tile('zone', 'Active safety zones', t.zones, null, 'Geofenced areas'),
        tile('camera', 'Camera stations', t.cameras, null, 'With a map position'),
        tile('paw', 'Detections', det, null, `${range}; ${high} high or critical`),
        tile('incident', 'Wildlife incidents', inc('wildlife') + inc('zone_alert'), null, `${range}`),
        tile('siren', 'SOS reports', inc('sos'), null, `${range}`, inc('sos') ? 'warn' : ''),
        tile('clock', 'Still active', open, null, 'Opened in range, not yet resolved', open ? 'urgent' : '')),
      el('div', { class: 'cols-2 section' },
        panel('Response times', 'clock', el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
          el('thead', {}, el('tr', {}, ['Incident type', 'Responded', 'Median time to respond', 'Median time to resolve'].map((h) => el('th', { scope: 'col' }, h)))),
          el('tbody', {}, ['sos', 'wildlife', 'zone_alert'].map((k) => {
            const r = resp(k);
            return el('tr', {}, el('td', {}, { sos: 'SOS', wildlife: 'Wildlife risk', zone_alert: 'Gate camera' }[k]),
              el('td', {}, r ? String(r.responded) : '0'), el('td', {}, r?.median_response_s != null ? fmtDuration(r.median_response_s) : '—'),
              el('td', {}, r?.median_resolve_s != null ? fmtDuration(r.median_resolve_s) : '—'));
          })))), el('p', { class: 'hint' }, 'From incident opening. "—" means no incidents of that type reached that stage in this range.')),
        panel('Detections by species', 'paw', s.detectionsBySpecies.length
          ? el('div', { class: 'bar-list' }, s.detectionsBySpecies.map((r) => el('div', { class: 'bar-row compact' },
              el('span', { class: 'strong' }, r.species === 'none' ? 'No wildlife' : r.species[0].toUpperCase() + r.species.slice(1)),
              el('span', { class: 'bar-track', title: `${r.high} high or critical` }, sized(el('span', { class: `bar-fill ${r.high ? 'is-high' : ''}` }), r.n / maxSpecies)),
              el('span', { class: 'num strong' }, String(r.n)))))
          : el('p', { class: 'muted' }, 'No detections in this range.'), el('p', { class: 'hint' }, 'Orange bars include at least one high or critical detection.'))),
      el('div', { class: 'cols-2 section' },
        panel('Activity per day', 'chart', s.perDay.length
          ? el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
              el('caption', { class: 'sr-only' }, 'Detections, incidents and SOS per day'),
              el('thead', {}, el('tr', {}, [`Day (${BOOT.timeZone})`, 'Detections', '', 'Incidents', 'SOS'].map((h) => el('th', { scope: 'col' }, h)))),
              el('tbody', {}, s.perDay.map((d) => el('tr', {}, el('td', {}, d.day), el('td', { class: 'num' }, String(d.detections)),
                el('td', { 'aria-hidden': 'true' }, el('span', { class: 'bar-track' }, sized(el('span', { class: 'bar-fill' }), d.detections / perDayMax))),
                el('td', { class: 'num' }, String(d.incidents)), el('td', { class: 'num' }, String(d.sos)))))))
          : el('p', { class: 'muted' }, 'No activity recorded in this range.')),
        panel('SOS by type', 'siren', s.sosByType.length
          ? el('ul', {}, s.sosByType.map((r) => el('li', {}, `${{ medical: 'Medical', wildlife: 'Dangerous wildlife', vehicle: 'Vehicle breakdown', personal: 'Personal safety' }[r.emergency_type] || r.emergency_type}: ${r.n}`)))
          : el('p', { class: 'muted' }, 'No SOS reports in this range.'),
          el('p', { class: 'hint' }, 'Counts describe recorded activity only. They do not measure detection accuracy: animals the cameras miss never appear here.'))));
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
