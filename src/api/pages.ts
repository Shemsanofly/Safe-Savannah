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
const icon = (id: string, cls = 'icon') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#${id}"></use></svg>`;

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
      <h1 id="brand-title">Duty operations centre</h1>
      <p class="lede">Early warning when an elephant enters a marked guest approach. Verify every alert, then follow your radio procedure.</p>
      <ul class="login-points">
        <li>${icon('camera')} One fixed camera, one marked zone</li>
        <li>${icon('sms')} One SMS to the duty phone per alert</li>
        <li>${icon('radio')} Every acknowledgement and handoff is logged</li>
      </ul>
    </div>
    ${landscape}
  </section>
  <section class="login-panel">
    <form method="post" action="/login" class="login-card" novalidate data-login>
      <h2>Sign in</h2>
      <p class="muted">Use the operator ID and PIN issued by your duty manager.</p>
      ${error ? `<div class="alert alert-error" role="alert" id="login-error">${icon('alert')}<span>${esc(error)}</span></div>` : ''}
      <div class="field">
        <label for="operatorId">Operator ID</label>
        <input id="operatorId" name="operatorId" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${esc(operatorId)}" ${error ? 'aria-describedby="login-error"' : ''} ${operatorId ? '' : 'autofocus'}>
      </div>
      <div class="field">
        <label for="pin">PIN</label>
        <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required ${operatorId ? 'autofocus' : ''}>
        <p class="hint">4–12 digits. Ask a supervisor if you have forgotten it.</p>
      </div>
      <button type="submit" class="btn btn-primary btn-block">${icon('login')}<span>Sign in</span></button>
      <p class="login-foot muted small">${icon('shield', 'icon icon-sm')} Sessions end after a shift or when a supervisor resets your PIN.</p>
    </form>
  </section>
</main>
<script type="module" src="/static/js/login.js"></script>`,
    'page-login',
  );
}

const NAV: { route: string; label: string; short: string; icon: string }[] = [
  { route: 'overview', label: 'Overview', short: 'Overview', icon: 'overview' },
  { route: 'incidents', label: 'Incidents', short: 'Incidents', icon: 'incident' },
  { route: 'history', label: 'History & reports', short: 'Reports', icon: 'chart' },
  { route: 'notifications', label: 'SMS notifications', short: 'SMS', icon: 'sms' },
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
  const navLinks = NAV.map(
    (n) => `<a href="#/${n.route}" data-route="${n.route}" class="nav-link">${icon(n.icon)}<span class="nav-label">${n.label}</span><span class="nav-short">${n.short}</span>${
      n.route === 'incidents' ? '<span class="nav-badge" data-badge="unack" hidden></span>' : ''
    }</a>`,
  ).join('');
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
          <p class="menu-head"><strong>${esc(opts.operator.name)}</strong><span class="muted small">${esc(opts.operator.id)} · ${opts.operator.role === 'supervisor' ? 'Supervisor' : 'Duty officer'}</span></p>
          <form method="post" action="/logout"><button type="submit" class="btn btn-ghost btn-block">${icon('logout')}<span>Sign out</span></button></form>
        </div>
      </details>
    </div>
  </header>
  <nav class="sidenav" aria-label="Main">${navLinks}</nav>
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
