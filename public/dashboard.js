/* Safe Savannah duty dashboard — polls /api/events and renders with plain DOM APIs. */
(() => {
  'use strict';
  const BOOT = window.SS_BOOT;
  const POLL_MS = 2000;
  const $ = (id) => document.getElementById(id);
  let serverOffsetMs = 0;
  let lastData = null;
  let failures = 0;
  const forms = new Map(); // eventId -> persistent action panel (keeps typed text across polls)

  // ---------- helpers ----------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  const now = () => Date.now() + serverOffsetMs;
  const time = (iso) =>
    iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: BOOT.timeZone }) : '—';
  function ago(iso) {
    if (!iso) return 'never';
    const s = Math.max(0, Math.round((now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  }
  function age(iso) {
    const s = Math.max(0, Math.round((now() - new Date(iso).getTime()) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  function toast(msg, kind = 'error') {
    const t = el('div', { class: `toast ${kind}`, role: 'alert' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 5000);
  }
  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
    if (res.status === 401) location.href = '/login';
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    return data;
  }
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

  // ---------- wording (keep the distinctions explicit) ----------
  const STATUS_LABEL = { open: 'Open', acknowledged: 'Acknowledged', closed: 'Closed', false_alert: 'False alert' };

  function zoneText(z) {
    switch (z.displayState) {
      case 'unknown':
        return ['unknown', 'UNKNOWN — camera feed not live. Do not treat as clear.'];
      case 'alerting':
        return ['alert', z.in_zone ? 'ALERT — possible elephant in zone now' : 'ALERT — alert open, zone not yet quiet'];
      case 'awaiting_close':
        return ['warn', 'No detection in zone recently — alert still open until an officer closes it'];
      case 'awaiting_clear':
        return ['warn', 'Alert closed — waiting for the zone to stay empty before re-arming'];
      case 'armed':
        return ['ok', z.in_zone ? `Armed — detection in zone (${z.streak} frame streak)` : 'Armed — watching (this is not an all-clear)'];
      default:
        return ['unknown', z.displayState];
    }
  }

  function notificationText(j) {
    const a = `attempt ${j.attempts}`;
    switch (j.status) {
      case 'pending':
        return ['warn', 'Queued — waiting to send'];
      case 'sending':
        return ['warn', 'Sending…'];
      case 'retry_wait':
        return ['warn', `Queued — provider unreachable, retrying at ${time(j.next_attempt_at)} (${a}). ${j.last_error || ''}`];
      case 'accepted':
        return ['ok', `Accepted by provider at ${time(j.accepted_at)} (${j.provider_status || ''}). Not proof of delivery.`];
      case 'delivered':
        return ['ok', `Provider reports delivered at ${time(j.delivered_at)}. Does not mean anyone has read it.`];
      case 'delivery_failed':
        return ['bad', `Provider reports delivery failed: ${j.provider_status || ''}`];
      case 'unknown':
        return ['bad', `Outcome unknown — the message may or may not have gone out. Check the duty handset before resending. ${j.last_error || ''}`];
      case 'failed':
        return ['bad', `Failed: ${j.last_error || ''}`];
      case 'expired':
        return ['muted', `Not sent — ${j.last_error || 'alert was stale when the uplink returned'}`];
      case 'cancelled':
        return ['muted', 'Not sent — incident closed first'];
      default:
        return ['muted', j.status];
    }
  }

  function ownershipText(e) {
    switch (e.status) {
      case 'open':
        return 'Nobody has acknowledged this alert yet.';
      case 'acknowledged':
        return `Acknowledged by ${e.acknowledged_by} at ${time(e.acknowledged_at)} — ownership taken. This does not confirm a response has happened; log radio/phone handoffs below.`;
      case 'closed':
        return `Closed by ${e.closed_by} at ${time(e.closed_at)}: ${e.close_reason}`;
      case 'false_alert':
        return `Dismissed as false alert by ${e.closed_by} at ${time(e.closed_at)}: ${e.close_reason}`;
    }
    return '';
  }

  const ACTION_LABEL = {
    opened: 'Alert opened',
    acknowledged: 'Acknowledged',
    handoff: 'Handoff',
    note: 'Note',
    closed: 'Closed',
    dismissed: 'Dismissed (false alert)',
    sms_resend_requested: 'SMS resend requested',
  };

  // ---------- rendering ----------
  function renderStatus(d) {
    const box = $('status');
    box.replaceChildren();
    for (const c of d.cameras) {
      const cls = c.feedState === 'live' ? 'ok' : 'bad';
      box.append(
        el('div', { class: `stat ${cls}` },
          el('strong', {}, c.label),
          el('span', {}, c.feedState === 'live' ? ' Feed live' : c.feedState === 'stale' ? ' Feed STALE' : ' Feed OFFLINE'),
          el('div', { class: 'small' },
            `Last frame ${ago(c.last_frame_at)} · ${c.processed_fps ? c.processed_fps.toFixed(1) : '—'} fps · inference ${c.last_inference_ms ? Math.round(c.last_inference_ms) : '—'} ms · dropped ${c.dropped_frames}`),
          el('div', { class: 'small' }, `Detector: ${c.detector}`),
          c.last_error && c.feedState !== 'live' ? el('div', { class: 'small bad-text' }, `Last error ${ago(c.last_error_at)}: ${c.last_error}`) : null,
        ),
      );
    }
    if (d.cameras.length === 0) box.append(el('div', { class: 'stat bad' }, 'No camera has reported yet — vision worker not running?'));
    for (const z of d.zones) {
      const [cls, text] = zoneText(z);
      box.append(el('div', { class: `stat ${cls}` }, el('strong', {}, z.zone_label), el('div', { class: 'small' }, text)));
    }
    const n = d.notifications;
    const lp = n.lastProviderResult;
    box.append(
      el('div', { class: `stat ${n.queued ? 'warn' : 'ok'}` },
        el('strong', {}, `SMS: ${n.provider === 'mock' ? 'MOCK adapter (no real SMS)' : n.provider}`),
        n.mockUplink && n.mockUplink !== 'up' ? el('div', { class: 'small bad-text' }, `Simulated uplink: ${n.mockUplink.toUpperCase()}`) : null,
        el('div', { class: 'small' }, `${n.queued} queued · last provider result ${lp ? `${lp.outcome} ${ago(lp.at)}` : 'none yet'}`),
        el('div', { class: 'small' }, `Last operator action ${ago(d.lastOperatorActionAt)}`),
      ),
    );
    if (n.mockMessages.length) {
      box.append(
        el('details', { class: 'mock' },
          el('summary', {}, `MOCK SMS outbox (${n.mockMessages.length}) — not sent to any phone`),
          el('ul', {}, n.mockMessages.map((m) => el('li', { class: 'small' }, `${time(m.created_at)} → ${m.recipient_alias}: ${m.body}`))),
        ),
      );
    }
  }

  function renderDemo(d) {
    const box = $('demo');
    if (!BOOT.demoControls) return;
    box.replaceChildren(
      el('div', { class: 'demo' },
        el('span', { class: 'small' }, 'DEMO: simulate SMS uplink '),
        ['up', 'down', 'timeout'].map((s) =>
          el('button', {
            class: d.notifications.mockUplink === s ? 'chip active' : 'chip',
            onclick: () => post('/api/demo/uplink', { state: s }).then(refresh).catch((e) => toast(e.message)),
          }, s),
        ),
      ),
    );
  }

  let liveTimer = null;
  function renderLive(d) {
    const box = $('live');
    const cam = d.cameras[0];
    if (!cam) {
      box.replaceChildren(el('p', { class: 'muted' }, 'No camera yet.'));
      return;
    }
    let img = box.querySelector('img');
    let overlay = box.querySelector('.overlay');
    if (!img) {
      img = el('img', { alt: `Annotated live view from ${cam.label}`, class: 'liveimg' });
      overlay = el('div', { class: 'overlay hidden' });
      box.replaceChildren(el('div', { class: 'livewrap' }, img, overlay));
      img.addEventListener('error', () => overlay.classList.remove('hidden'));
    }
    overlay.textContent = cam.feedState === 'live' ? '' : `Feed ${cam.feedState.toUpperCase()} — image is old. Zone status UNKNOWN.`;
    overlay.classList.toggle('hidden', cam.feedState === 'live');
    if (!liveTimer) {
      const tick = () => {
        img.src = `/api/cameras/${encodeURIComponent(cam.id)}/live.jpg?t=${Date.now()}`;
      };
      tick();
      liveTimer = setInterval(tick, 1000);
    }
  }

  function actionPanel(e) {
    let panel = forms.get(e.id);
    if (panel) return panel;
    const handoffNote = el('input', { placeholder: 'Who was contacted, what was agreed', maxlength: '500' });
    const handoffChannel = el('select', {}, el('option', { value: 'radio' }, 'Radio'), el('option', { value: 'phone' }, 'Phone'), el('option', { value: 'in_person' }, 'In person'));
    const closeNote = el('input', { placeholder: 'What was verified (e.g. herd moved off path, guides informed)', maxlength: '500' });
    const dismissNote = el('input', { placeholder: 'Why it is a false alert (e.g. vehicle, shadow, staff)', maxlength: '500' });
    const run = (btn, body, input) => async () => {
      if (input && !input.value.trim()) {
        input.focus();
        toast('Please add a short note first.');
        return;
      }
      btn.disabled = true;
      try {
        await post(`/api/events/${e.id}/actions`, { ...body(), clientActionId: uid() });
        if (input) input.value = '';
        await refresh();
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
      }
    };
    const ackBtn = el('button', { class: 'primary big', 'data-role': 'ack' }, 'Acknowledge — I take ownership');
    ackBtn.addEventListener('click', async () => {
      ackBtn.disabled = true;
      try {
        const r = await post(`/api/events/${e.id}/acknowledge`);
        if (r.alreadyAcknowledged) toast(`Already acknowledged by ${r.event.acknowledged_by}`, 'info');
        await refresh();
      } catch (err) {
        toast(err.message);
      } finally {
        ackBtn.disabled = false;
      }
    });
    const hBtn = el('button', {}, 'Log handoff');
    hBtn.addEventListener('click', run(hBtn, () => ({ type: 'handoff', channel: handoffChannel.value, note: handoffNote.value }), handoffNote));
    const cBtn = el('button', { class: 'good' }, 'Close incident (verified)');
    cBtn.addEventListener('click', run(cBtn, () => ({ type: 'close', note: closeNote.value }), closeNote));
    const dBtn = el('button', { class: 'warnbtn' }, 'Dismiss as false alert');
    dBtn.addEventListener('click', run(dBtn, () => ({ type: 'dismiss', note: dismissNote.value }), dismissNote));
    panel = el('div', { class: 'actions' },
      el('div', { 'data-role': 'open-only' }, ackBtn),
      el('div', { 'data-role': 'ack-only' },
        el('div', { class: 'row' }, handoffChannel, handoffNote, hBtn),
        el('div', { class: 'row' }, closeNote, cBtn),
        el('div', { class: 'row' }, dismissNote, dBtn),
      ),
    );
    forms.set(e.id, panel);
    return panel;
  }

  function eventCard(e, active) {
    const card = el('article', { class: `card ${e.status}` });
    const sim = e.source !== 'inference';
    card.append(
      el('header', {},
        el('span', { class: 'ref' }, e.ref),
        el('span', { class: 'zone' }, e.zone_label),
        el('span', { class: `badge ${e.status}` }, STATUS_LABEL[e.status]),
        sim ? el('span', { class: 'badge sim' }, e.source === 'simulated' ? 'SIMULATED' : 'SYNTHETIC TEST') : null,
      ),
    );
    if (active) card.append(el('p', { class: 'headline' }, `Possible ${e.class_label} in zone — verify before acting.`));
    const body = el('div', { class: 'cardbody' });
    if (e.snapshotUrl) {
      body.append(el('a', { href: e.snapshotUrl, target: '_blank', rel: 'noopener' }, el('img', { src: e.snapshotUrl, alt: `Snapshot for ${e.ref}`, class: 'snap', loading: 'lazy' })));
    }
    body.append(
      el('dl', {},
        el('dt', {}, 'Alert age'), el('dd', {}, active ? age(e.opened_at) : `opened ${time(e.opened_at)}`),
        el('dt', {}, 'First seen'), el('dd', {}, time(e.first_seen_at)),
        el('dt', {}, 'Opened'), el('dd', {}, time(e.opened_at)),
        el('dt', {}, 'Last seen in zone'), el('dd', {}, `${time(e.last_seen_at)} (${ago(e.last_seen_at)})`),
        el('dt', {}, 'Peak confidence'), el('dd', {}, `${Math.round(e.confidence * 100)}% · ${e.model || ''}`),
      ),
    );
    card.append(body);

    card.append(el('p', { class: 'owner' }, ownershipText(e)));

    const notes = el('div', { class: 'notifs' }, el('h3', {}, 'Notifications'));
    if (!e.notifications.length) notes.append(el('p', { class: 'small muted' }, 'No SMS job for this alert.'));
    for (const j of e.notifications) {
      const [cls, text] = notificationText(j);
      const row = el('div', { class: `notif ${cls}` }, el('strong', {}, `SMS → ${j.recipient_alias}: `), text);
      if (['unknown', 'failed', 'expired', 'delivery_failed'].includes(j.status) && active) {
        const b = el('button', { class: 'small-btn' }, 'Resend');
        b.addEventListener('click', async () => {
          if (!confirm('Resend this SMS? If the first one did arrive, the duty phone gets a duplicate.')) return;
          try {
            await post(`/api/notifications/${j.id}/resend`);
            await refresh();
          } catch (err) {
            toast(err.message);
          }
        });
        row.append(' ', b);
      }
      notes.append(row);
    }
    card.append(notes);

    if (active) {
      const panel = actionPanel(e);
      panel.querySelector('[data-role="open-only"]').classList.toggle('hidden', e.status !== 'open');
      panel.querySelector('[data-role="ack-only"]').classList.toggle('hidden', e.status !== 'acknowledged');
      card.append(panel);
    }

    const log = el('ol', { class: 'timeline' });
    for (const a of e.actions) {
      log.append(
        el('li', {},
          el('span', { class: 'when' }, time(a.created_at)), ' ',
          el('strong', {}, ACTION_LABEL[a.action] || a.action),
          a.channel && a.channel !== 'dashboard' ? ` via ${a.channel}` : '',
          ` — ${a.actor}`,
          a.note ? el('div', { class: 'small' }, a.note) : null,
        ),
      );
    }
    card.append(el('details', { open: active ? true : null }, el('summary', {}, `Log (${e.actions.length})`), log));
    return card;
  }

  function renderEvents(d) {
    const active = d.events.filter((e) => e.status === 'open' || e.status === 'acknowledged');
    const recent = d.events.filter((e) => e.status === 'closed' || e.status === 'false_alert');
    // Preserve focus/typing: cards are rebuilt but the action panels are reused.
    const focused = document.activeElement;
    $('active').replaceChildren(...(active.length ? active.map((e) => eventCard(e, true)) : [el('p', { class: 'muted' }, 'No active alerts recorded.')]));
    $('recent').replaceChildren(...(recent.length ? recent.map((e) => eventCard(e, false)) : [el('p', { class: 'muted' }, 'None yet.')]));
    if (focused && document.contains(focused)) focused.focus();
    for (const id of forms.keys()) if (!active.some((e) => e.id === id)) forms.delete(id);
    const openCount = active.filter((e) => e.status === 'open').length;
    document.title = openCount ? `(${openCount}) ALERT · Safe Savannah` : 'Safe Savannah · Duty dashboard';
  }

  function render(d) {
    renderStatus(d);
    renderDemo(d);
    renderLive(d);
    renderEvents(d);
  }

  async function refresh() {
    try {
      const res = await fetch('/api/events', { credentials: 'same-origin', cache: 'no-store' });
      if (res.status === 401) {
        location.href = '/login';
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      serverOffsetMs = new Date(d.serverTime).getTime() - Date.now();
      lastData = d;
      failures = 0;
      $('conn').classList.add('hidden');
      render(d);
    } catch (err) {
      failures += 1;
      const banner = $('conn');
      banner.textContent = `Dashboard cannot reach the local server (${err.message}). Information below may be out of date — use radio procedure.`;
      banner.classList.remove('hidden');
      if (lastData) render(lastData);
    }
  }

  refresh();
  setInterval(refresh, POLL_MS);
})();
