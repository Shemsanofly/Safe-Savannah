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

export function loginPage({ error, operatorId = '' }: { error: string | null; operatorId?: string }): string {
  return layout(
    'Sign in · Safe Savannah',
    `<main class="login">
  <img class="login-scene" src="/static/img/savanna.svg" alt="" aria-hidden="true">
  <div class="login-scrim" aria-hidden="true"></div>
  <section class="login-brand" aria-labelledby="brand-title">
    <p class="brand-mark">${icon('logo', 'logo')}<span>Safe Savannah <em>AI</em></span></p>
    <p class="eyebrow">Tanzania · National parks &amp; safari lodges</p>
    <h1 id="brand-title">See wildlife risk early.<br>Respond together.</h1>
    <p class="lede">AI camera alerts, geofenced safety zones and tourist SOS in one place — working alongside, never instead of, your radio procedure.</p>
    <ul class="login-points">
      <li>${icon('cpu')}<span><strong>Smart detection</strong>Risk scored by species, distance and who is nearby</span></li>
      <li>${icon('siren')}<span><strong>Tourist SOS</strong>From the app, a basic phone (USSD) or a call</span></li>
      <li>${icon('map')}<span><strong>One live map</strong>Every alert and emergency, where it happens</span></li>
    </ul>
  </section>
  <section class="login-panel">
    <form method="post" action="/login" class="login-card" novalidate data-login>
      <div class="login-card-head">
        <span class="login-badge">${icon('shield', 'icon icon-sm')} Staff</span>
        <h2>Welcome back</h2>
        <p class="muted">Rangers and administrators sign in with the ID and PIN from your park admin.</p>
      </div>
      ${error ? `<div class="alert alert-error" role="alert" id="login-error">${icon('alert')}<span>${esc(error)}</span></div>` : ''}
      <div class="field">
        <label for="operatorId">Staff ID</label>
        <div class="input-icon">${icon('user')}<input id="operatorId" name="operatorId" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${esc(operatorId)}" ${error ? 'aria-describedby="login-error"' : ''} ${operatorId ? '' : 'autofocus'}></div>
      </div>
      <div class="field">
        <label for="pin">PIN</label>
        <div class="input-icon">${icon('key')}<input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required ${operatorId ? 'autofocus' : ''}></div>
        <p class="hint">4–12 digits. Forgotten it? Ask an admin to reset it.</p>
      </div>
      <button type="submit" class="btn btn-primary btn-lg btn-block">${icon('login')}<span>Sign in</span></button>
      <a class="traveller-link" href="/t">
        <span class="traveller-icon">${icon('globe')}</span>
        <span><strong>Travelling with us?</strong><small>Open the traveller safety app — alerts, SOS and guidance in English &amp; Kiswahili</small></span>
        ${icon('chevron-right')}
      </a>
    </form>
    <p class="login-foot">${icon('shield', 'icon icon-sm')} Sessions end after a shift or when an admin resets your PIN.</p>
  </section>
</main>
<script type="module" src="/static/js/login.js"></script>`,
    'page-login',
  );
}

const NAV: { route: string; label: string; short: string; icon: string; admin?: boolean; primary?: boolean }[] = [
  { route: 'ops', label: 'Live map', short: 'Map', icon: 'map', primary: true },
  { route: 'incidents', label: 'Incidents', short: 'Incidents', icon: 'incident', primary: true },
  { route: 'detections', label: 'Detections', short: 'Detections', icon: 'paw' },
  { route: 'ai', label: 'Check a photo', short: 'Photo', icon: 'cpu', primary: true },
  { route: 'overview', label: 'Gate camera', short: 'Camera', icon: 'camera' },
  { route: 'stats', label: 'Dashboard', short: 'Stats', icon: 'chart', admin: true },
  { route: 'zones', label: 'Safety zones', short: 'Zones', icon: 'zone', admin: true },
  { route: 'people', label: 'People', short: 'People', icon: 'users', admin: true },
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
          <label class="duty-toggle"><input type="checkbox" id="duty-toggle"> <span>On duty — receive alerts</span></label>
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
    <div class="t-top-inner">
      <a class="t-brand" href="#/">${icon('logo', 'logo')}<span>Safe Savannah</span></a>
      <nav class="t-nav" id="t-nav" aria-label="Main" hidden></nav>
      <div class="t-lang" role="group" aria-label="Language / Lugha">
        <button type="button" data-lang="en" aria-pressed="true">EN</button>
        <button type="button" data-lang="sw" aria-pressed="false">SW</button>
      </div>
    </div>
  </header>
  <div class="conn-banner t-conn" id="conn-banner" role="alert" hidden></div>
  <main id="t-main" class="t-main" tabindex="-1"><div class="view-loading"><span class="spinner" aria-hidden="true"></span> Loading…</div></main>
</div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script type="application/json" id="ss-boot">${boot}</script>
<script type="module" src="/static/js/tourist/app.js"></script>`,
    'page-tourist',
  );
}
