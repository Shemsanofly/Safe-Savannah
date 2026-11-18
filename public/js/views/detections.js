// Wildlife detections log: every camera sighting and uploaded photo, with risk and source clearly labelled.
import { api, clear, el, fmtDateTime, icon, qs } from '../lib.js';
import { demoBadge, riskBadge, RISK } from '../status.js';

export function mount(main, ctx) {
  let params = { ...ctx.params };
  const species = el('select', { id: 'd-species' }, el('option', { value: '' }, 'Any species'));
  const risk = el('select', { id: 'd-risk' }, [['', 'Any risk'], ['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['none', 'No risk']].map(([v, l]) => el('option', { value: v }, l)));
  const analysis = el('select', { id: 'd-analysis' }, [['', 'Real and simulated'], ['model', 'Real AI model only'], ['simulated', 'Simulated only']].map(([v, l]) => el('option', { value: v }, l)));
  const area = el('select', { id: 'd-area' }, el('option', { value: '' }, 'All areas'));
  const results = el('div', { 'aria-live': 'polite' });
  const pager = el('nav', { class: 'pager', 'aria-label': 'Pages' });
  const field = (id, label, c) => el('div', { class: 'field' }, el('label', { for: id }, label), c);

  main.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Wildlife detections'),
      el('p', { class: 'sub' }, 'Every animal sighting and its risk.'))),
    el('div', { class: 'filters' }, el('div', { class: 'filters-row' },
      field('d-species', 'Species', species), field('d-risk', 'Risk', risk), field('d-analysis', 'Detection source', analysis), field('d-area', 'Area', area))),
    results, pager);

  for (const s of ['lion', 'leopard', 'buffalo', 'hippo', 'elephant', 'rhino', 'crocodile', 'hyena', 'cheetah', 'baboon', 'giraffe', 'zebra', 'wildebeest', 'antelope']) species.append(el('option', { value: s }, s[0].toUpperCase() + s.slice(1)));
  api.get('/api/areas').then(({ areas }) => {
    for (const a of areas) area.append(el('option', { value: a.id }, a.name));
    area.value = params.area || '';
  }).catch(() => undefined);
  species.value = params.species || '';
  risk.value = params.risk || '';
  analysis.value = params.analysis || '';
  const go = (patch) => {
    params = { ...params, ...patch };
    ctx.navigate(`#/detections${qs(params)}`, { replace: true });
  };
  species.addEventListener('change', () => go({ species: species.value, page: '' }));
  risk.addEventListener('change', () => go({ risk: risk.value, page: '' }));
  analysis.addEventListener('change', () => go({ analysis: analysis.value, page: '' }));
  area.addEventListener('change', () => go({ area: area.value, page: '' }));

  async function load() {
    try {
      const d = await api.get(`/api/detections${qs(params)}`);
      if (!d.items.length) {
        clear(results, el('div', { class: 'panel' }, el('div', { class: 'empty' }, icon('paw'), el('strong', {}, 'No detections match'), el('p', {}, 'Try another filter, run a demo scenario, or upload a photo in AI monitor.'))));
        clear(pager);
        return;
      }
      // Phones: one compact card per sighting. Wider screens: the table.
      const name = (x) => (x.species ? x.species[0].toUpperCase() + x.species.slice(1) : 'No wildlife recognised');
      const cards = el('div', { class: 'inc-list' }, d.items.map((x) => el('article', { class: `inc-item lv-${x.risk_level || 'none'}` },
        el('span', { class: 'inc-icon', 'aria-hidden': 'true' }, icon('paw')),
        el('div', { class: 'inc-body' },
          el('div', { class: 'inc-meta' }, el('span', {}, fmtDateTime(x.captured_at)), x.confidence !== null ? el('span', {}, `${Math.round(x.confidence * 100)}% sure`) : null),
          el('strong', { class: 'inc-name' }, name(x)),
          el('div', { class: 'inc-sub' },
            x.risk_level ? el('span', { class: 'inc-risk' }, RISK[x.risk_level]?.label || x.risk_level) : null,
            el('span', {}, x.zone_name ? `${x.inside_zone ? 'Inside' : `${Math.round(x.distance_m)} m from`} ${x.zone_name}` : x.camera_label || x.area_name || ''),
            x.analysis === 'simulated' ? el('span', { class: 'inc-tag' }, 'Simulated') : null)),
        x.event_id ? el('a', { class: 'inc-status tone-muted', href: `#/incidents/${x.event_id}` }, `SS-${String(x.event_id).padStart(3, '0')}`) : null)));
      clear(results, cards, el('div', { class: 'table-wrap inc-table' }, el('table', { class: 'data table-cards' },
        el('caption', { class: 'sr-only' }, 'Wildlife detections'),
        el('thead', {}, el('tr', {}, ['Time', 'Animal', 'Where', 'Nearest zone', 'Risk', 'Source', 'Incident'].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, d.items.map((x) => el('tr', {},
          el('td', { 'data-label': 'Time' }, fmtDateTime(x.captured_at)),
          el('td', { 'data-label': 'Animal' }, el('div', { class: 'cell-stack' }, el('strong', {}, x.species ? x.species[0].toUpperCase() + x.species.slice(1) : 'No wildlife recognised'),
            el('span', { class: 'muted small' }, x.confidence !== null ? `${Math.round(x.confidence * 100)}% confidence` : '—'))),
          el('td', { 'data-label': 'Where' }, el('div', { class: 'cell-stack' }, x.camera_label || 'No camera', el('span', { class: 'muted small' }, x.area_name || ''))),
          el('td', { 'data-label': 'Nearest zone' }, x.zone_name ? `${x.inside_zone ? 'Inside' : `${Math.round(x.distance_m)} m from`} ${x.zone_name}` : '—'),
          el('td', { 'data-label': 'Risk' }, riskBadge(x.risk_level)),
          el('td', { 'data-label': 'Source' }, el('div', { class: 'row' },
            x.analysis === 'simulated' ? el('span', { class: 'badge tone-sim' }, icon('flask'), 'Simulated') : el('span', { class: 'badge tone-real' }, icon('cpu'), 'Real model'),
            x.demo ? demoBadge() : null,
            x.imageUrl ? el('a', { href: x.imageUrl, target: '_blank', rel: 'noopener', class: 'small' }, 'Photo') : null)),
          el('td', { 'data-label': 'Incident' }, x.event_id ? el('a', { href: `#/incidents/${x.event_id}`, class: 'strong' }, `SS-${String(x.event_id).padStart(3, '0')}`) : el('span', { class: 'muted' }, 'none'))))))));
      clear(pager, d.pages > 1 ? [
        el('button', { type: 'button', class: 'btn btn-sm', disabled: d.page <= 1, onclick: () => go({ page: String(d.page - 1) }) }, icon('chevron-left', 'icon icon-sm'), 'Previous'),
        el('span', { class: 'small strong' }, `Page ${d.page} of ${d.pages} · ${d.total} detections`),
        el('button', { type: 'button', class: 'btn btn-sm', disabled: d.page >= d.pages, onclick: () => go({ page: String(d.page + 1) }) }, 'Next', icon('chevron-right', 'icon icon-sm')),
      ] : el('span', { class: 'small muted' }, `${d.total} detection${d.total === 1 ? '' : 's'}`));
    } catch (err) {
      clear(results, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), `Could not load detections: ${err.message}`));
    }
  }
  load();
  const timer = setInterval(() => !document.hidden && load(), 10_000);
  return { onParams(p) { params = { ...p }; load(); }, destroy() { clearInterval(timer); } };
}
