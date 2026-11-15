// Overview: what a duty officer needs at a glance — incidents needing action, camera, zone, SMS.
import { createCameraFeed } from '../camera.js';
import { api, age, ago, clear, el, fmtDateTime, fmtTime, icon, runAction } from '../lib.js';
import { FEED, INCIDENT, SMS, incidentBadge, smsBadge, sourceBadge, summarizeSms } from '../status.js';
import * as store from '../store.js';

export function mount(main) {
  const attention = el('div', { class: 'attention', role: 'alert', hidden: true });
  const tiles = el('div', { class: 'tiles', 'aria-label': 'Key figures' });
  const camera = createCameraFeed();
  const incList = el('div', { class: 'inc-list', 'aria-live': 'polite' });
  const incCount = el('span', { class: 'muted small' });
  const incidentsPanel = el('section', { class: 'panel incidents-panel', 'aria-labelledby': 'active-title' },
    el('div', { class: 'panel-head' },
      el('h2', { id: 'active-title' }, icon('incident'), 'Active incidents'),
      el('div', { class: 'row' }, incCount, el('a', { href: '#/incidents?status=active', class: 'btn btn-sm btn-ghost' }, 'View all', icon('chevron-right', 'icon icon-sm')))),
    el('div', { class: 'panel-body' },
      el('p', { class: 'muted small', style: null }, 'Each alert means a ', el('em', {}, 'possible'), ' elephant in the marked zone. Verify before acting. No alert never means the path is safe.'),
      el('div', { class: 'divider', 'aria-hidden': 'true' }),
      incList));
  const grid = el('div', { class: 'overview-grid' }, camera.root, incidentsPanel);
  const recent = el('div', {});

  main.append(
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Overview'), el('p', { class: 'sub' }, 'Camera, marked zone, incidents and SMS at a glance. Refreshes automatically.'))),
    attention,
    tiles,
    grid,
    el('section', { class: 'section', 'aria-labelledby': 'recent-title' },
      el('div', { class: 'section-head' }, el('h2', { id: 'recent-title' }, 'Recently closed'),
        el('a', { href: '#/history', class: 'btn btn-sm btn-ghost' }, 'History & reports', icon('chevron-right', 'icon icon-sm'))),
      recent),
  );
  clear(incList, el('div', { class: 'skeleton', style: null, 'aria-hidden': 'true' }));
  clear(recent, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'));

  const cards = new Map(); // id -> { node, key }
  let lastActiveKey = '';

  function tile({ href, tone, iconId, label, value, unit, note, title }) {
    return el(href ? 'a' : 'div', { class: `tile ${tone ? `is-${tone}` : ''}`, href, title },
      el('span', { class: 'tile-label' }, icon(iconId, 'icon icon-sm'), label),
      el('span', { class: 'tile-value' }, value, unit ? el('span', { class: 'unit' }, unit) : null),
      note ? el('span', { class: 'tile-note' }, note) : null);
  }

  function renderTiles(o) {
    const cam = o.cameras[0];
    const f = cam ? FEED[cam.feedState] : FEED.offline;
    const zoneUnknown = o.zones.some((z) => z.displayState === 'unknown') || !cam;
    const s = o.sms;
    let smsValue = 'Ready';
    let smsTone = '';
    let smsNote = s.lastProviderResult ? `Last provider result: ${s.lastProviderResult.outcome} ${ago(s.lastProviderResult.at)}` : 'No messages sent yet';
    if (s.needsAttention) {
      smsValue = `${s.needsAttention} problem${s.needsAttention === 1 ? '' : 's'}`;
      smsTone = 'urgent';
      smsNote = 'Open SMS notifications to see what to do';
    } else if (s.queued) {
      smsValue = `${s.queued} queued`;
      smsTone = 'warn';
      smsNote = s.retrying ? 'Provider unreachable — retrying automatically' : 'Sending shortly';
    }
    clear(tiles,
      tile({ href: '#/incidents?status=open', tone: o.counts.unacknowledged ? 'urgent' : '', iconId: 'incident', label: 'Need acknowledgement',
        value: String(o.counts.unacknowledged), note: o.counts.unacknowledged ? 'Take ownership now' : 'Nothing waiting' }),
      tile({ href: '#/incidents?status=active', tone: o.counts.active ? 'warn' : '', iconId: 'user', label: 'Active incidents',
        value: String(o.counts.active), note: `${o.counts.acknowledged} acknowledged, not yet closed` }),
      tile({ href: '#/overview', tone: cam?.feedState === 'live' ? '' : 'unknown', iconId: f.icon, label: 'Camera feed',
        value: f.label, note: zoneUnknown ? 'Zone status UNKNOWN' : `Last frame ${ago(cam.lastFrameAt)}`, title: f.explain }),
      tile({ href: '#/notifications', tone: smsTone, iconId: 'sms', label: s.mode === 'mock' ? 'SMS (mock — no real messages)' : s.mode === 'sandbox' ? 'SMS (sandbox)' : 'SMS',
        value: smsValue, note: smsNote }),
    );
  }

  function renderAttention(o) {
    const open = o.activeIncidents.filter((e) => e.status === 'open');
    attention.hidden = open.length === 0;
    grid.classList.toggle('has-urgent', open.length > 0);
    if (!open.length) return;
    const first = open[open.length - 1];
    clear(attention, icon('incident', 'icon icon-lg'),
      el('div', { class: 'grow' },
        el('strong', {}, open.length === 1 ? `${first.ref}: possible elephant at ${first.zone_label}` : `${open.length} incidents need acknowledgement`),
        el('p', { class: 'small' }, `Waiting ${age(first.opened_at)}. Acknowledge to take ownership, then verify and follow your radio procedure.`)),
      el('a', { class: 'btn', href: open.length === 1 ? `#/incidents/${first.id}` : '#/incidents?status=open' }, open.length === 1 ? 'Open incident' : 'Review'));
  }

  function card(e) {
    const ack = el('button', { type: 'button', class: 'btn btn-urgent' }, icon('user'), el('span', {}, 'Acknowledge'));
    const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
    ack.addEventListener('click', () =>
      runAction(ack, status, async () => {
        const r = await api.post(`/api/events/${e.id}/acknowledge`);
        await store.refresh();
        return r;
      }, { success: `${e.ref} acknowledged — you own it now.` }));
    const sms = summarizeSms(e.notifications?.map((j) => j.status));
    const ageEl = el('span', { 'data-age': e.opened_at }, icon('clock', 'icon icon-sm'), `Open ${age(e.opened_at)}`);
    const node = el('article', { class: `inc-card is-${e.status}`, 'aria-labelledby': `inc-${e.id}` },
      el('div', { class: 'inc-card-head' },
        el('a', { class: 'inc-ref', id: `inc-${e.id}`, href: `#/incidents/${e.id}` }, e.ref),
        el('span', { class: 'inc-zone' }, e.zone_label),
        incidentBadge(e.status, { short: false }),
        e.source !== 'inference' ? sourceBadge(e.source) : null),
      e.status === 'open' ? el('p', { class: 'inc-headline' }, `Possible ${e.class_label} in zone — verify before acting.`) : null,
      el('div', { class: 'inc-facts' },
        ageEl,
        el('span', {}, icon('eye', 'icon icon-sm'), `Last seen ${fmtTime(e.last_seen_at)}`),
        e.acknowledged_by ? el('span', {}, icon('user', 'icon icon-sm'), `Owner: ${e.acknowledged_by}`) : null,
        sms ? el('span', { title: SMS[sms]?.explain }, smsBadge(sms)) : el('span', {}, 'No SMS job')),
      el('div', { class: 'inc-actions' },
        e.status === 'open' ? ack : null,
        el('a', { class: `btn ${e.status === 'open' ? '' : 'btn-primary'}`, href: `#/incidents/${e.id}` },
          e.status === 'open' ? 'Details' : 'Log handoff or close', icon('chevron-right', 'icon icon-sm')),
        status));
    return node;
  }

  function renderIncidents(o) {
    const list = o.activeIncidents;
    incCount.textContent = list.length ? `${list.length} active` : '';
    if (!list.length) {
      cards.clear();
      clear(incList, el('div', { class: 'empty' }, icon('check-circle'), el('strong', {}, 'No active incidents'),
        el('p', {}, 'Nothing is open right now. This does not mean the path is safe — the camera can miss animals, and a camera that is not live cannot see anything.')));
      return;
    }
    // Rebuild a card only when its data changed, so buttons in progress are not replaced mid-click.
    const nodes = list.map((e) => {
      const key = JSON.stringify([e.status, e.acknowledged_by, e.last_seen_at, e.notifications?.map((j) => [j.status, j.next_attempt_at])]);
      const cached = cards.get(e.id);
      if (cached && cached.key === key) return cached.node;
      if (cached?.node.querySelector('[aria-busy="true"]')) return cached.node;
      const node = card(e);
      cards.set(e.id, { key, node });
      return node;
    });
    for (const id of cards.keys()) if (!list.some((e) => e.id === id)) cards.delete(id);
    if (nodes.some((n, i) => incList.children[i] !== n) || incList.children.length !== nodes.length) {
      const focused = document.activeElement;
      incList.replaceChildren(...nodes);
      if (focused && document.contains(focused)) focused.focus({ preventScroll: true });
    }
    for (const a of incList.querySelectorAll('[data-age]')) a.lastChild.textContent = `Open ${age(a.dataset.age)}`;
  }

  async function loadRecent() {
    try {
      const r = await api.get('/api/incidents?status=closed,false_alert&pageSize=5&sort=opened_at&order=desc');
      if (!r.items.length) {
        clear(recent, el('div', { class: 'panel' }, el('div', { class: 'empty' }, icon('note'), el('strong', {}, 'No closed incidents yet'),
          el('p', {}, 'Incidents appear here once an officer closes them or records them as false alerts.'))));
        return;
      }
      clear(recent, el('div', { class: 'table-wrap' }, el('table', { class: 'data table-cards' },
        el('caption', { class: 'sr-only' }, 'Five most recently opened closed incidents'),
        el('thead', {}, el('tr', {}, ['Incident', 'Outcome', 'Opened', 'Closed by', 'Note'].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, r.items.map((i) => el('tr', {},
          el('td', { 'data-label': 'Incident' }, el('a', { href: `#/incidents/${i.id}`, class: 'strong' }, i.ref), ' ', el('span', { class: 'muted' }, i.zone_label)),
          el('td', { 'data-label': 'Outcome' }, incidentBadge(i.status)),
          el('td', { 'data-label': 'Opened' }, fmtDateTime(i.opened_at)),
          el('td', { 'data-label': 'Closed by' }, i.closed_by_name || i.closed_by || '—'),
          el('td', { 'data-label': 'Note' }, i.close_reason || '—')))))));
    } catch (err) {
      clear(recent, el('div', { class: 'alert alert-error' }, icon('alert'), `Could not load recent incidents: ${err.message}`));
    }
  }
  loadRecent();
  const recentTimer = setInterval(loadRecent, 20_000);

  return {
    update(s) {
      const o = s.overview;
      if (!o) return;
      renderAttention(o);
      renderTiles(o);
      camera.update(o.cameras[0] || null, o.zones);
      renderIncidents(o);
      const key = o.activeIncidents.map((e) => `${e.id}:${e.status}`).join(',');
      if (lastActiveKey && key !== lastActiveKey) loadRecent();
      lastActiveKey = key;
    },
    destroy() {
      camera.destroy();
      clearInterval(recentTimer);
    },
  };
}
