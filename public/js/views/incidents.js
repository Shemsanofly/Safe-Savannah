// Incidents: search, filter, sort and page through current and historical incidents.
import { api, BOOT, clear, debounce, el, fmtDateTime, fmtDuration, icon, qs, toast } from '../lib.js';
import { INCIDENT, SMS, incidentBadge, smsBadge, sourceBadge, summarizeSms } from '../status.js';

const STATUS_TABS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'open', label: 'Needs acknowledgement' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'closed', label: 'Closed' },
  { value: 'false_alert', label: 'False alerts' },
];
const SORTS = [
  { value: 'opened_at:desc', label: 'Newest first' },
  { value: 'opened_at:asc', label: 'Oldest first' },
  { value: 'last_seen_at:desc', label: 'Most recently seen' },
  { value: 'confidence:desc', label: 'Highest confidence' },
  { value: 'ack_seconds:desc', label: 'Slowest acknowledgement' },
  { value: 'ack_seconds:asc', label: 'Fastest acknowledgement' },
];
const FILTER_KEYS = ['q', 'status', 'source', 'zone', 'sms', 'owner', 'from', 'to', 'sort', 'order', 'page', 'pageSize'];

export function mount(main, ctx) {
  let params = pick(ctx.params);
  let controller = null;
  let zonesLoaded = false;

  // ---------- controls (built once; never re-rendered by refreshes) ----------
  const search = el('input', { type: 'search', id: 'f-q', placeholder: 'SS-014, zone, officer, or note text', autocomplete: 'off', value: params.q || '' });
  const statusSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Incident status' });
  const source = select('f-source', [['', 'Any source'], ['inference', 'Real detection'], ['simulated', 'Simulated'], ['synthetic', 'Test data'], ['simulated,synthetic', 'Simulated or test']], params.source);
  const zone = select('f-zone', [['', 'Any zone']], params.zone);
  const sms = select('f-sms', [['', 'Any SMS state'], ['queued', 'Queued or retrying'], ['accepted', 'Accepted by provider'], ['delivered', 'Delivered'], ['problem', 'Needs attention'], ['not_sent', 'Not sent (expired/closed)'], ['none', 'No SMS job']], params.sms);
  const owner = select('f-owner', [['', 'Anyone'], ['me', 'Acknowledged by me']], params.owner);
  const from = el('input', { type: 'date', id: 'f-from', value: params.from || '' });
  const to = el('input', { type: 'date', id: 'f-to', value: params.to || '' });
  const sort = select('f-sort', SORTS.map((s) => [s.value, s.label]), `${params.sort || 'opened_at'}:${params.order || 'desc'}`);
  const pageSize = selectCls('page-size', 'f-size', [['10', '10 per page'], ['20', '20 per page'], ['50', '50 per page'], ['100', '100 per page']], params.pageSize || '20');
  const reset = el('button', { type: 'button', class: 'btn btn-ghost' }, icon('x', 'icon icon-sm'), 'Clear filters');
  const dateError = el('p', { class: 'field-error', hidden: true, role: 'alert' });

  // On phones the less-used filters fold away; on larger screens they are always shown.
  const moreSummary = el('summary', {}, icon('filter', 'icon icon-sm'), el('span', {}, 'More filters'));
  const moreFilters = el('details', { class: 'more-filters', open: window.matchMedia('(min-width: 721px)').matches || undefined },
    moreSummary,
    el('div', { class: 'filters-row' },
      field('f-source', 'Detection source', source),
      field('f-zone', 'Zone', zone),
      field('f-sms', 'SMS', sms),
      field('f-owner', 'Owner', owner),
      field('f-from', 'Opened from', from),
      field('f-to', 'Opened to', to),
      el('div', { class: 'field shrink' }, el('span', { class: 'label', 'aria-hidden': 'true' }, ' '), reset)));

  const exportBtn = BOOT.permissions?.canExport
    ? el('a', { class: 'btn', href: '#', download: '' }, icon('download'), el('span', {}, 'Export CSV'))
    : null;

  const resultBar = el('div', { class: 'result-bar' });
  const loadingLine = el('div', { class: 'loading-line', hidden: true, 'aria-hidden': 'true' });
  const results = el('div', { 'aria-live': 'polite', 'aria-busy': 'false' });
  const pager = el('nav', { class: 'pager', 'aria-label': 'Pages' });

  main.append(
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Incidents'), el('p', { class: 'sub' }, 'Search and review every alert, current and past.')),
      el('div', { class: 'page-actions' }, exportBtn)),
    el('form', { class: 'filters', role: 'search', 'aria-label': 'Filter incidents', onsubmit: (e) => e.preventDefault() },
      el('div', { class: 'filters-row' },
        el('div', { class: 'field grow' }, el('label', { for: 'f-q' }, 'Search'), el('div', { class: 'input-icon' }, icon('search'), search)),
        field('f-sort', 'Sort', sort)),
      el('div', { class: 'filters-row' }, statusSeg),
      moreFilters,
      dateError,
      el('p', { class: 'hint' }, `Dates are in lodge time (${BOOT.timeZone}) and include the whole day.`)),
    resultBar, loadingLine, results, el('div', { class: 'row between' }, pageSize, pager),
  );
  pageSize.setAttribute('aria-label', 'Results per page');

  function renderStatusSeg() {
    clear(statusSeg, STATUS_TABS.map((t) =>
      el('button', { type: 'button', 'aria-pressed': String((params.status || '') === t.value), onclick: () => setParams({ status: t.value, page: '' }) }, t.label)));
  }
  renderStatusSeg();

  // ---------- wiring ----------
  search.addEventListener('input', debounce(() => setParams({ q: search.value.trim(), page: '' }), 300));
  source.addEventListener('change', () => setParams({ source: source.value, page: '' }));
  zone.addEventListener('change', () => setParams({ zone: zone.value, page: '' }));
  sms.addEventListener('change', () => setParams({ sms: sms.value, page: '' }));
  owner.addEventListener('change', () => setParams({ owner: owner.value, page: '' }));
  for (const d of [from, to]) d.addEventListener('change', () => setParams({ from: from.value, to: to.value, page: '' }));
  sort.addEventListener('change', () => {
    const [s, o] = sort.value.split(':');
    setParams({ sort: s, order: o, page: '' });
  });
  pageSize.addEventListener('change', () => setParams({ pageSize: pageSize.value, page: '' }));
  reset.addEventListener('click', () => {
    search.value = '';
    for (const s of [source, zone, sms, owner]) s.value = '';
    from.value = '';
    to.value = '';
    sort.value = 'opened_at:desc';
    setParams(Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])));
  });

  function setParams(patch) {
    params = pick({ ...params, ...patch });
    if (params.from && params.to && params.from > params.to) {
      dateError.hidden = false;
      clear(dateError, icon('alert', 'icon icon-sm'), '"Opened from" must be on or before "Opened to".');
      from.setAttribute('aria-invalid', 'true');
      return;
    }
    dateError.hidden = true;
    from.removeAttribute('aria-invalid');
    ctx.navigate(`#/incidents${qs(params)}`, { replace: true });
  }

  function remember() {
    try {
      sessionStorage.setItem('ss-last-incidents', `#/incidents${qs(params)}`);
    } catch {
      /* storage unavailable: the back link falls back to the unfiltered list */
    }
  }

  async function load({ quiet = false } = {}) {
    remember();
    controller?.abort();
    controller = new AbortController();
    if (!quiet) {
      loadingLine.hidden = false;
      results.setAttribute('aria-busy', 'true');
    }
    try {
      const data = await api.get(`/api/incidents${qs(params)}`, { signal: controller.signal });
      if (!zonesLoaded) {
        for (const z of data.zones) zone.append(el('option', { value: z.id }, z.label));
        zone.value = params.zone || '';
        zonesLoaded = true;
      }
      render(data);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!quiet) clear(results, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'),
        el('div', { class: 'grow' }, el('strong', {}, 'Could not load incidents. '), err.message),
        el('button', { type: 'button', class: 'btn btn-sm', onclick: () => load() }, 'Try again')));
    } finally {
      loadingLine.hidden = true;
      results.setAttribute('aria-busy', 'false');
    }
  }

  function render(data) {
    const first = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
    const last = Math.min(data.total, data.page * data.pageSize);
    const active = activeFilterCount();
    const hidden = ['source', 'zone', 'sms', 'owner', 'from', 'to'].filter((k) => params[k]).length;
    moreSummary.lastChild.textContent = hidden ? `More filters (${hidden} active)` : 'More filters';
    clear(resultBar,
      el('p', { class: 'strong' }, data.total === 0 ? 'No incidents' : `Showing ${first}–${last} of ${data.total} incident${data.total === 1 ? '' : 's'}`),
      active ? el('span', { class: 'muted small' }, `${active} filter${active === 1 ? '' : 's'} applied`) : null);
    if (exportBtn) {
      exportBtn.href = `/api/incidents/export.csv${qs({ ...params, page: '', pageSize: '' })}`;
      exportBtn.setAttribute('aria-disabled', String(data.total === 0));
      exportBtn.title = data.total === 0 ? 'Nothing to export with these filters' : `Download ${data.total} incident${data.total === 1 ? '' : 's'} as CSV (times in UTC)`;
    }

    if (data.total === 0) {
      clear(results, el('div', { class: 'panel' }, el('div', { class: 'empty' }, icon('search'),
        el('strong', {}, active ? 'No incidents match these filters' : 'No incidents recorded yet'),
        el('p', {}, active ? 'Try a wider date range or clear the filters.' : 'Alerts appear here as soon as the camera raises one.'),
        active ? el('button', { type: 'button', class: 'btn', onclick: () => reset.click() }, 'Clear filters') : null)));
      clear(pager);
      return;
    }

    const rows = data.items.map((i) => {
      const smsStatus = summarizeSms(i.sms_statuses);
      const tr = el('tr', { class: `is-row-link is-${i.status}` },
        el('td', { 'data-label': 'Incident' }, el('div', { class: 'cell-stack' },
          el('a', { href: `#/incidents/${i.id}`, class: 'strong' }, i.ref),
          el('span', { class: 'muted small' }, i.zone_label))),
        el('td', { 'data-label': 'Status' }, incidentBadge(i.status)),
        el('td', { 'data-label': 'Opened' }, el('div', { class: 'cell-stack' }, fmtDateTime(i.opened_at),
          el('span', { class: 'muted small' }, `Peak ${Math.round(i.confidence * 100)}% ${i.class_label}`))),
        el('td', { 'data-label': 'Time to acknowledge', class: 'num' }, i.ack_seconds === null ? el('span', { class: 'muted' }, i.status === 'open' ? 'waiting' : '—') : fmtDuration(i.ack_seconds)),
        el('td', { 'data-label': 'Owner' }, i.acknowledged_by_name || i.acknowledged_by || el('span', { class: 'muted' }, 'nobody yet'),
          i.handoff_count ? el('div', { class: 'muted small' }, `${i.handoff_count} handoff${i.handoff_count === 1 ? '' : 's'}`) : null),
        el('td', { 'data-label': 'SMS' }, smsStatus ? el('span', { title: SMS[smsStatus]?.explain }, smsBadge(smsStatus)) : el('span', { class: 'muted' }, 'none')),
        el('td', { 'data-label': 'Source' }, sourceBadge(i.source)));
      // Whole row is clickable for pointer users; the ref link is the keyboard target.
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a,button')) return;
        ctx.navigate(`#/incidents/${i.id}`);
      });
      return tr;
    });
    clear(results, el('div', { class: 'table-wrap' }, el('table', { class: 'data table-cards' },
      el('caption', { class: 'sr-only' }, 'Incidents matching the filters'),
      el('thead', {}, el('tr', {}, ['Incident', 'Status', 'Opened', 'Time to acknowledge', 'Owner', 'SMS', 'Source'].map((h) =>
        el('th', { scope: 'col', class: h === 'Time to acknowledge' ? 'num' : null }, h)))),
      el('tbody', {}, rows))));

    clear(pager,
      el('button', { type: 'button', class: 'btn btn-sm', disabled: data.page <= 1, onclick: () => setParams({ page: String(data.page - 1) }) }, icon('chevron-left', 'icon icon-sm'), 'Previous'),
      el('span', { class: 'small strong' }, `Page ${data.page} of ${data.pages}`),
      el('button', { type: 'button', class: 'btn btn-sm', disabled: data.page >= data.pages, onclick: () => setParams({ page: String(data.page + 1) }) }, 'Next', icon('chevron-right', 'icon icon-sm')));
  }

  function activeFilterCount() {
    return ['q', 'status', 'source', 'zone', 'sms', 'owner', 'from', 'to'].filter((k) => params[k]).length;
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', (e) => {
      if (exportBtn.getAttribute('aria-disabled') === 'true') {
        e.preventDefault();
        toast('Nothing to export with these filters.', 'error');
      } else toast('Preparing CSV export…');
    });
  }

  load();
  // Quiet refresh keeps results current without touching the filter controls or focus.
  const timer = setInterval(() => {
    if (!document.hidden) load({ quiet: true });
  }, 10_000);

  return {
    onParams(p) {
      params = pick(p);
      if (search !== document.activeElement) search.value = params.q || '';
      renderStatusSeg();
      load();
    },
    destroy() {
      clearInterval(timer);
      controller?.abort();
    },
  };
}

function pick(p) {
  const out = {};
  for (const k of FILTER_KEYS) if (p[k]) out[k] = String(p[k]);
  return out;
}

function selectCls(cls, id, options, value) {
  const s = select(id, options, value);
  s.classList.add(cls);
  return s;
}

function select(id, options, value) {
  const s = el('select', { id }, options.map(([v, l]) => el('option', { value: v }, l)));
  s.value = value || options[0][0];
  return s;
}

function field(id, label, control) {
  return el('div', { class: 'field' }, el('label', { for: id }, label), control);
}
