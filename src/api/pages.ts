import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operator } from '../store/operators.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The icon sprite is inlined into every page so icons keep rendering even when
 * the server is unreachable (an external sprite would need re-fetching).
 */
function loadSprite(): string {
  for (const c of [path.resolve(here, '../../public/icons.svg'), path.resolve(here, '../../../public/icons.svg')]) {
    try {
      return readFileSync(c, 'utf8').replace('<svg xmlns="http://www.w3.org/2000/svg">', '<svg xmlns="http://www.w3.org/2000/svg" class="sprite" aria-hidden="true" focusable="false">');
    } catch {
      /* try next */
    }
  }
  return '';
}
const SPRITE = loadSprite();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (id: string, cls = 'icon') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${id}"></use></svg>`;

function layout(title: string, body: string, bodyClass: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#173a2c">
<title>${esc(title)}</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/css/app.css">
</head>
<body class="${bodyClass}">
${SPRITE}
${body}
</body>
</html>`;
}

const landscape = `<svg class="login-art" viewBox="0 0 480 260" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMax meet">
  <circle cx="352" cy="118" r="34" fill="#e2a33b" opacity=".9"/>
  <path d="M0 196 C 80 176 150 184 230 172 S 380 160 480 176 V260 H0Z" fill="#24543f"/>
  <path d="M0 220 C 110 204 210 214 300 204 S 420 196 480 206 V260 H0Z" fill="#1c4433"/>
  <g fill="#0f2a1f">
    <path d="M118 176 l3 -44 h4 l3 44z"/>
    <path d="M123 136 c -10 -6 -26 -8 -40 -6 c 10 -10 30 -16 46 -12 c 14 -6 34 -6 48 2 c -14 0 -30 4 -40 12z"/>
    <path d="M70 128 c 22 -14 92 -16 116 -2 c -10 6 -96 8 -116 2z"/>
    <path d="M396 186 l2 -24 h3 l2 24z"/>
    <path d="M374 162 c 12 -8 46 -8 58 0 c -8 4 -50 4 -58 0z"/>
  </g>
  <g fill="#0f2a1f" opacity=".85">
    <path d="M250 190 c 0 -14 8 -24 22 -26 c 8 -6 22 -6 30 2 c 8 2 12 10 12 18 l -2 18 h-6 l -1 -12 h-4 l -1 12 h-6 l -1 -10 h-18 l -2 10 h-6 l -1 -12 c -4 2 -6 6 -6 10 c -4 -2 -6 -6 -6 -10z"/>
    <path d="M316 176 c 6 2 8 10 6 16 c -1 4 -3 6 -6 6 c 2 -6 2 -12 0 -16z"/>
  </g>
</svg>`;

export function loginPage({ error, operatorId = '' }: { error: string | null; operatorId?: string }): string {
  return layout(
    'Sign in · Safe Savannah',
    `<main class="login">
  <section class="login-brand" aria-labelledby="brand-title">
    <div class="login-brand-inner">
      <p class="brand-mark">${icon('logo', 'logo')}<span>Safe Savannah</span></p>
      <h1 id="brand-title">Wildlife monitoring &amp; tourist safety</h1>
      <p class="lede">AI camera alerts, geofenced safety zones and tourist SOS for Tanzania's parks and lodges — alongside, never instead of, your radio procedure.</p>
      <ul class="login-points">
        <li>${icon('cpu')} Camera detections scored by species, distance and who is nearby</li>
        <li>${icon('incident')} Tourist SOS by app, USSD or voice call</li>
        <li>${icon('sms')} Ranger and tourist alerts via Africa's Talking</li>
      </ul>
    </div>
    ${landscape}
  </section>
  <section class="login-panel">
    <form method="post" action="/login" class="login-card" novalidate data-login>
      <h2>Staff sign in</h2>
      <p class="muted">Rangers and administrators: use the ID and PIN issued by your park admin.</p>
      ${error ? `<div class="alert alert-error" role="alert" id="login-error">${icon('alert')}<span>${esc(error)}</span></div>` : ''}
      <div class="field">
        <label for="operatorId">Operator ID</label>
        <input id="operatorId" name="operatorId" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${esc(operatorId)}" ${error ? 'aria-describedby="login-error"' : ''} ${operatorId ? '' : 'autofocus'}>
      </div>
      <div class="field">
        <label for="pin">PIN</label>
        <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required ${operatorId ? 'autofocus' : ''}>
        <p class="hint">4–12 digits. Ask an admin if you have forgotten it.</p>
      </div>
      <button type="submit" class="btn btn-primary btn-block">${icon('login')}<span>Sign in</span></button>
      <p class="login-alt">Travelling? <a href="/t">Open the tourist safety app</a></p>
      <p class="login-foot muted small">${icon('shield', 'icon icon-sm')} Sessions end after a shift or when an admin resets your PIN.</p>
    </form>
  </section>
</main>
<script type="module" src="/static/js/login.js"></script>`,
    'page-login',
  );
}

const NAV: { route: string; label: string; short: string; icon: string; admin?: boolean; primary?: boolean }[] = [
  { route: 'ops', label: 'Operations map', short: 'Map', icon: 'map', primary: true },
  { route: 'incidents', label: 'Incidents', short: 'Incidents', icon: 'incident', primary: true },
  { route: 'detections', label: 'Wildlife detections', short: 'Detections', icon: 'paw' },
  { route: 'ai', label: 'AI monitor', short: 'AI', icon: 'cpu', primary: true },
  { route: 'overview', label: 'Gate camera', short: 'Camera', icon: 'camera' },
  { route: 'comms', label: 'Messages', short: 'Messages', icon: 'sms' },
  { route: 'stats', label: 'Dashboard', short: 'Stats', icon: 'chart', admin: true },
  { route: 'zones', label: 'Safety zones', short: 'Zones', icon: 'zone', admin: true },
  { route: 'people', label: 'People', short: 'People', icon: 'users', admin: true },
  { route: 'history', label: 'Reports', short: 'Reports', icon: 'note', admin: true },
  { route: 'settings', label: 'Settings', short: 'Settings', icon: 'settings' },
  { route: 'help', label: 'Guide', short: 'Guide', icon: 'help' },
];

export function appPage(opts: {
  operator: Operator;
  permissions: Record<string, boolean>;
  timeZone: string;
  staleSeconds: number;
}): string {
  const boot = JSON.stringify({
    operator: { id: opts.operator.id, name: opts.operator.name, role: opts.operator.role },
    permissions: opts.permissions,
    timeZone: opts.timeZone,
    staleSeconds: opts.staleSeconds,
  }).replace(/</g, '\\u003c');
  const isAdmin = opts.operator.role === 'admin';
  const navLinks =
    NAV.filter((n) => !n.admin || isAdmin)
      .map(
        (n) => `<a href="#/${n.route}" data-route="${n.route}" class="nav-link"${n.primary ? ' data-primary' : ''}>${icon(n.icon)}<span class="nav-label">${n.label}</span><span class="nav-short">${n.short}</span>${
          n.route === 'incidents' ? '<span class="nav-badge" data-badge="unack" hidden></span>' : ''
        }</a>`,
      )
      .join('') + `<button type="button" class="nav-link nav-more" aria-expanded="false" aria-controls="sidenav">${icon('overview')}<span class="nav-short">More</span></button>`;
  return layout(
    'Safe Savannah · Duty operations',
    `<a class="skip-link" href="#main">Skip to main content</a>
<div class="shell">
  <header class="topbar">
    <a class="brand" href="#/overview" aria-label="Safe Savannah overview">${icon('logo', 'logo')}<span class="brand-name">Safe Savannah</span></a>
    <div class="status-strip" id="status-strip" aria-live="polite" aria-label="System status">
      <span class="pill pill-muted"><span class="spinner" aria-hidden="true"></span>Loading status…</span>
    </div>
    <div class="topbar-right">
      <span class="updated muted small" id="updated" aria-live="off">Connecting…</span>
      <details class="user-menu">
        <summary aria-label="Account menu for ${esc(opts.operator.name)}">${icon('user')}<span class="user-name">${esc(opts.operator.name)}</span>${icon('chevron-down', 'icon icon-sm')}</summary>
        <div class="menu-panel">
          <p class="menu-head"><strong>${esc(opts.operator.name)}</strong><span class="muted small">${esc(opts.operator.id)} · ${opts.operator.role === 'admin' ? 'Admin' : 'Ranger'}</span></p>
          <label class="duty-toggle"><input type="checkbox" id="duty-toggle"> <span>On duty — receive alert SMS and calls</span></label>
          <a class="btn btn-ghost btn-block" href="/t" target="_blank" rel="noopener">${icon('external')}<span>Open tourist app</span></a>
          <form method="post" action="/logout"><button type="submit" class="btn btn-ghost btn-block">${icon('logout')}<span>Sign out</span></button></form>
        </div>
      </details>
    </div>
  </header>
  <nav class="sidenav" id="sidenav" aria-label="Main">${navLinks}</nav>
  <div class="conn-banner" id="conn-banner" role="alert" hidden></div>
  <main id="main" class="main" tabindex="-1">
    <div class="view-loading"><span class="spinner" aria-hidden="true"></span> Loading…</div>
  </main>
</div>
<div class="toasts" id="toasts" aria-live="polite" aria-atomic="false"></div>
<script type="application/json" id="ss-boot">${boot}</script>
<script type="module" src="/static/js/app.js"></script>`,
    'page-app',
  );
}

export function touristPage(opts: { emergencyLine: string }): string {
  const boot = JSON.stringify({ emergencyLine: opts.emergencyLine }).replace(/</g, '\\u003c');
  return layout(
    'Safe Savannah · Traveller safety',
    `<a class="skip-link" href="#t-main">Skip to main content</a>
<div class="t-shell">
  <header class="t-top">
    <span class="t-brand">${icon('logo', 'logo')}<span>Safe Savannah</span></span>
    <div class="t-lang" role="group" aria-label="Language / Lugha">
      <button type="button" data-lang="en" aria-pressed="true">EN</button>
      <button type="button" data-lang="sw" aria-pressed="false">SW</button>
    </div>
  </header>
  <div class="conn-banner t-conn" id="conn-banner" role="alert" hidden></div>
  <main id="t-main" class="t-main" tabindex="-1"><div class="view-loading"><span class="spinner" aria-hidden="true"></span> Loading…</div></main>
  <nav class="t-nav" id="t-nav" aria-label="Main" hidden></nav>
</div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script type="application/json" id="ss-boot">${boot}</script>
<script type="module" src="/static/js/tourist/app.js"></script>`,
    'page-tourist',
  );
}
