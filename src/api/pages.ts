import type { Operator } from '../store/operators.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(title: string, body: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/dashboard.css">
${extraHead}
</head>
<body>
${body}
</body>
</html>`;
}

export function loginPage({ error }: { error: string | null }): string {
  return layout(
    'Safe Savannah · Sign in',
    `<main class="login">
  <h1>Safe Savannah</h1>
  <p class="muted">Duty dashboard. Sign in with your operator ID and PIN.</p>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
  <form method="post" action="/login">
    <label>Operator ID <input name="operatorId" autocomplete="username" required autofocus></label>
    <label>PIN <input name="pin" type="password" inputmode="numeric" autocomplete="current-password" required></label>
    <button type="submit" class="primary">Sign in</button>
  </form>
</main>`,
  );
}

export function dashboardPage(opts: {
  operator: Operator;
  provider: string;
  demoControls: boolean;
  staleSeconds: number;
  timeZone: string;
}): string {
  const boot = JSON.stringify({
    operator: { id: opts.operator.id, name: opts.operator.name },
    provider: opts.provider,
    demoControls: opts.demoControls,
    staleSeconds: opts.staleSeconds,
    timeZone: opts.timeZone,
  }).replace(/</g, '\\u003c');
  return layout(
    'Safe Savannah · Duty dashboard',
    `<header class="topbar">
  <div class="brand">Safe Savannah <span class="muted">duty dashboard</span></div>
  <div class="who">Signed in as <strong>${esc(opts.operator.name)}</strong>
    <form method="post" action="/logout" class="inline"><button type="submit" class="link">Sign out</button></form>
  </div>
</header>
<div id="conn" class="banner hidden" role="status"></div>
<main class="grid">
  <section class="panel status" aria-labelledby="h-status">
    <h2 id="h-status">System status</h2>
    <div id="status"></div>
    <div id="demo"></div>
  </section>
  <section class="panel live" aria-labelledby="h-live">
    <h2 id="h-live">Camera view</h2>
    <div id="live"></div>
  </section>
  <section class="panel events" aria-labelledby="h-active">
    <h2 id="h-active">Active alerts</h2>
    <p class="muted small">An alert means <em>possible</em> elephant in the marked zone. Verify before acting and follow your radio procedure. No alert never means the path is safe.</p>
    <div id="active"></div>
  </section>
  <section class="panel history" aria-labelledby="h-recent">
    <h2 id="h-recent">Recently closed</h2>
    <div id="recent"></div>
  </section>
</main>
<script>window.SS_BOOT = ${boot};</script>
<script src="/static/dashboard.js" defer></script>`,
  );
}
