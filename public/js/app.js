// App shell: hash router, status strip, nav badge, "last updated", connection-loss banner.
import { BOOT, clear, el, icon, fmtTime } from './lib.js';
import { FEED } from './status.js';
import * as store from './store.js';

const VIEWS = {
  overview: () => import('./views/overview.js'),
  incidents: () => import('./views/incidents.js'),
  incident: () => import('./views/incident.js'),
  history: () => import('./views/history.js'),
  notifications: () => import('./views/notifications.js'),
  settings: () => import('./views/settings.js'),
  help: () => import('./views/help.js'),
};

const main = document.getElementById('main');
let current = null; // { name, instance }
let routeSeq = 0;

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(query));
  if (parts[0] === 'incidents' && parts[1]) return { name: 'incident', nav: 'incidents', id: Number(parts[1]), params };
  const name = VIEWS[parts[0]] && parts[0] !== 'incident' ? parts[0] : 'overview';
  return { name, nav: name, params };
}

export function navigate(hash, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  route();
}

async function route() {
  const r = parseHash();
  const seq = ++routeSeq;
  // Same view, only the query changed (e.g. filters): let the view handle it without remounting.
  if (current && current.name === r.name && r.name !== 'incident' && current.instance.onParams) {
    current.instance.onParams(r.params);
    return;
  }
  current?.instance?.destroy?.();
  current = null;
  document.querySelectorAll('.nav-link').forEach((a) => {
    if (a.dataset.route === r.nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  clear(main, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'));
  let mod;
  try {
    mod = await VIEWS[r.name]();
  } catch (err) {
    clear(main, el('div', { class: 'alert alert-error' }, icon('alert'), 'This screen could not be loaded. Reload the page to try again.'));
    return;
  }
  if (seq !== routeSeq) return;
  clear(main);
  const instance = mod.mount(main, { ...r, navigate, boot: BOOT }) || {};
  current = { name: r.name, instance };
  if (store.state.overview) instance.update?.(store.state);
  // Move focus to the new screen's heading for keyboard and screen-reader users.
  const h1 = main.querySelector('h1');
  if (h1) {
    h1.setAttribute('tabindex', '-1');
    h1.focus({ preventScroll: true });
    document.title = `${h1.textContent} · Safe Savannah`;
  }
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- shell status
const strip = document.getElementById('status-strip');
const updated = document.getElementById('updated');
const banner = document.getElementById('conn-banner');
const badge = document.querySelector('[data-badge="unack"]');

function pill(href, tone, iconId, text, opts = {}) {
  return el('a', { class: `pill tone-${tone}`, href, title: opts.title || null },
    opts.dot ? el('span', { class: `dot ${opts.pulse ? 'dot-pulse' : ''}`, 'aria-hidden': 'true' }) : icon(iconId), text);
}

function renderShell(s) {
  const o = s.overview;
  if (o) {
    const pills = [];
    const { unacknowledged, active } = o.counts;
    if (unacknowledged > 0) pills.push(pill('#/incidents?status=open', 'urgent', 'incident', `${unacknowledged} need${unacknowledged === 1 ? 's' : ''} acknowledgement`, { dot: true, pulse: true }));
    else if (active > 0) pills.push(pill('#/incidents?status=active', 'warn', 'incident', `${active} active incident${active === 1 ? '' : 's'}`));
    else pills.push(pill('#/incidents', 'ok', 'check-circle', 'No active incidents', { title: 'No incident is open. This does not mean the path is safe.' }));
    for (const c of o.cameras) {
      const f = FEED[c.feedState];
      pills.push(pill('#/overview', f.tone, f.icon, `Camera ${f.label.toLowerCase()}`, { title: f.explain }));
      if (c.detectorKind === 'simulated') pills.push(pill('#/settings', 'sim', 'flask', 'Simulated footage', { title: 'The detector is the scripted demo, not a real model.' }));
    }
    if (o.cameras.length === 0) pills.push(pill('#/overview', 'bad', 'camera-off', 'No camera reporting'));
    if (o.zones.some((z) => z.displayState === 'unknown')) pills.push(pill('#/overview', 'unknown', 'alert', 'Zone UNKNOWN', { title: 'No live frames: the system cannot tell what is in the zone.' }));
    const sms = o.sms;
    if (sms.needsAttention > 0) pills.push(pill('#/notifications?group=problem', 'bad', 'sms', `SMS: ${sms.needsAttention} need${sms.needsAttention === 1 ? 's' : ''} attention`));
    else if (sms.queued > 0) pills.push(pill('#/notifications?group=queued', 'warn', 'sms', `SMS: ${sms.queued} queued`));
    if (sms.mode === 'mock') pills.push(pill('#/notifications', 'mock', 'sms', 'Mock SMS — no real messages'));
    else if (sms.mode === 'sandbox') pills.push(pill('#/notifications', 'mock', 'sms', 'SMS sandbox'));
    // When the server cannot be reached, keep the last known status but mark it clearly as out of date.
    const outdated = !!s.error && s.failures >= 2;
    strip.classList.toggle('is-stale', outdated);
    if (outdated) pills.unshift(el('span', { class: 'pill pill-outdated' }, icon('wifi-off'), `Status as of ${fmtTime(new Date(s.lastOkAt).toISOString())}`));
    clear(strip, pills);

    badge.hidden = unacknowledged === 0;
    badge.textContent = String(unacknowledged);
    badge.setAttribute('aria-label', `${unacknowledged} incidents need acknowledgement`);
  }
  tickUpdated();
}

function tickUpdated() {
  const s = store.state;
  if (!s.lastOkAt) {
    updated.textContent = s.error ? 'Not connected' : 'Connecting…';
  } else {
    const secs = Math.round((Date.now() - s.lastOkAt) / 1000);
    updated.textContent = secs < 3 ? 'Updated just now' : `Updated ${secs} s ago`;
    updated.classList.toggle('is-stale', secs > 10);
  }
  if (s.error && s.failures >= 2) {
    clear(banner, icon('wifi-off'),
      el('span', {}, s.lastOkAt
        ? `Lost connection to the Safe Savannah server at ${fmtTime(new Date(s.lastOkAt).toISOString())}. What you see may be out of date — use your radio procedure.`
        : 'Cannot reach the Safe Savannah server. Use your radio procedure.'));
    banner.hidden = false;
  } else banner.hidden = true;
}

store.subscribe((s) => {
  renderShell(s);
  current?.instance?.update?.(s);
});
setInterval(tickUpdated, 1000);

// Close the account menu on outside click / Escape.
const menu = document.querySelector('.user-menu');
document.addEventListener('click', (e) => {
  if (menu?.open && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menu?.open) {
    menu.open = false;
    menu.querySelector('summary').focus();
  }
});

window.addEventListener('hashchange', route);
if (!location.hash) history.replaceState(null, '', '#/overview');
store.start();
route();
// Fetch every screen once up front so navigation still works if the server drops out briefly.
setTimeout(() => Object.values(VIEWS).forEach((load) => load().catch(() => undefined)), 1500);
