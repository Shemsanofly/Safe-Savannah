// Incident detail: evidence, ownership, actions, SMS history and a chronological activity log.
import { age, api, BOOT, clear, confirmDialog, el, fmtDateTime, fmtDuration, fmtTime, icon, initials, runAction, uid, validateRequired } from '../lib.js';
import {
  ACTION, CHANNEL, EMERGENCY, INCIDENT, KIND, RISK, SMS, demoBadge, languageName, SOURCE,
} from '../status.js';
import { createMap } from '../map.js';
import * as store from '../store.js';

function lastListHash() {
  try {
    return sessionStorage.getItem('ss-last-incidents') || '#/incidents';
  } catch {
    return '#/incidents';
  }
}

const FALSE_REASONS = ['Vehicle', 'Person or staff', 'Other animal', 'Shadow, vegetation or rock', 'Camera or lighting glitch', 'Duplicate report', 'Test or accidental press', 'Other'];

export function mount(main, ctx) {
  const id = ctx.id;
  let data = null;
  let actionStatus = null; // status the action panel was built for
  let activeTab = 'handoff';
  let destroyed = false;
  let lastEvKey = '';
  let grid = null;
  let lastTlKey = '';
  let miniMap = null;

  const head = el('div', { class: 'page-head' });
  const explainer = el('div', { class: 'status-explainer', role: 'status' });
  const evidence = el('div', {});
  const actionPanel = el('div', { class: 'action-panel' });
  const timeline = el('ol', { class: 'timeline' });

  main.append(
    el('a', { href: lastListHash(), class: 'back-link' }, icon('chevron-left', 'icon icon-sm'), 'Incidents'),
    head, explainer,
    grid = el('div', { class: 'detail-grid' },
      el('div', { class: 'stack' },
        el('section', { class: 'panel', 'aria-labelledby': 'ev-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'ev-title' }, icon('camera'), 'Details')),
          el('div', { class: 'panel-body' }, evidence)),
        el('section', { class: 'panel', 'aria-labelledby': 'tl-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'tl-title' }, icon('clock'), 'Activity'), el('span', { class: 'muted small' }, 'Oldest first')),
          el('div', { class: 'panel-body' }, timeline))),
      el('div', { class: 'stack' },
        el('section', { class: 'panel', 'aria-labelledby': 'act-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'act-title' }, icon('user'), 'Response')),
          el('div', { class: 'panel-body' }, actionPanel)))),

  );
  clear(head, el('div', {}, el('h1', {}, `Incident`), el('p', { class: 'sub' }, 'Loading…')));

  async function load() {
    try {
      const d = await api.get(`/api/incidents/${id}`);
      if (destroyed) return;
      data = d;
      render();
    } catch (err) {
      if (destroyed) return;
      if (err.status === 404) {
        clear(main, el('div', { class: 'empty' }, icon('search'), el('h1', {}, 'Incident not found'),
          el('p', {}, err.message), el('a', { class: 'btn', href: '#/incidents' }, 'Back to incidents')));
        destroyed = true;
        return;
      }
      if (!data) {
        explainer.className = 'status-explainer tone-urgent';
        explainer.hidden = false;
        clear(explainer, icon('alert'), el('div', {}, el('strong', {}, 'Could not load this incident. '), err.message,
          el('p', { class: 'small' }, 'This page retries automatically every few seconds.')));
      }
    }
  }

  function render() {
    const e = data.event;
    const def = INCIDENT[e.status];
    const active = e.status === 'open' || e.status === 'acknowledged';
    grid.classList.toggle('is-active', active);
    const lvl = e.kind === 'sos' ? 'critical' : e.risk_level || 'none';
    const em = e.emergency_type ? EMERGENCY[e.emergency_type] : null;
    const order = { open: 0, acknowledged: 1, closed: 2, false_alert: 2 }[e.status];
    const owner = e.acknowledged_by_name || e.acknowledged_by;
    const steps = [
      ['Pending', e.opened_at],
      [order >= 1 && owner ? `${owner.split(' ')[0]} responding` : 'Responding', e.acknowledged_at],
      [e.status === 'false_alert' ? 'False alarm' : 'Resolved', e.closed_at],
    ];
    clear(head,
      el('div', { class: `inc-head lv-${lvl}` },
        el('span', { class: 'inc-icon', 'aria-hidden': 'true' }, icon(em?.icon || KIND[e.kind]?.icon || 'incident')),
        el('div', { class: 'inc-head-text' },
          el('div', { class: 'inc-meta' }, el('strong', {}, e.ref),
            el('span', {}, e.kind === 'sos' ? `SOS${em ? ` · ${em.label}` : ''}` : KIND[e.kind]?.label || e.kind),
            e.kind !== 'sos' && e.risk_level ? el('span', { class: `risk-text lv-${e.risk_level}` }, RISK[e.risk_level]?.label) : null,
            e.source === 'simulated' || e.source === 'synthetic' ? el('span', { class: 'inc-tag', title: SOURCE[e.source].explain }, 'Simulated — not a real animal') : null,
            e.demo ? el('span', { class: 'inc-tag' }, 'Demo') : null),
          el('h1', {}, e.title || e.zone_label || 'Incident'),
          el('p', { class: 'inc-when' }, `${e.area_name ? `${e.area_name} · ` : ''}opened ${fmtDateTime(e.opened_at)}${active ? ` (${age(e.opened_at)} ago)` : ''}`))),
      el('ol', { class: `t-progress inc-progress st-${e.status}`, 'aria-label': `Status: ${def.label}` }, steps.map(([l, at], i) =>
        el('li', { class: i < order || order === 2 ? 'is-done' : i === order ? 'is-current' : '', 'aria-current': i === order ? 'step' : null },
          el('span', { class: 't-dot' }, i < order || order === 2 ? icon('check', 'icon icon-sm') : null),
          el('span', { class: 't-progress-label' }, l, at && i <= order ? el('small', {}, fmtDateTime(at).replace(/^Today /, '')) : null)))));
    document.title = `${e.ref} · Safe Savannah`;
    explainer.hidden = true;

    const evKey = JSON.stringify([e.status, e.last_seen_at, e.confidence, e.acknowledged_at, e.snapshotUrl, data.cameraLabel, e.risk_level]);
    if (evKey !== lastEvKey) {
      renderEvidence(e);
      lastEvKey = evKey;
    }
    renderActions(e);
    const tlKey = JSON.stringify(data.timeline.filter((t) => t.kind === 'action'));
    if (tlKey !== lastTlKey) {
      renderTimeline();
      lastTlKey = tlKey;
    }
  }

  function renderEvidence(e) {
    const ackSecs = e.acknowledged_at ? (Date.parse(e.acknowledged_at) - Date.parse(e.opened_at)) / 1000 : null;
    const respond = fact('Time to respond', ackSecs === null ? (e.status === 'open' ? `waiting ${age(e.opened_at)}` : '—') : fmtDuration(ackSecs));
    const mapBox = el('div', { dataset: { size: 'sm' } });
    const parts = [];
    if (e.kind === 'sos') {
      const t = data.tourist;
      const em = EMERGENCY[e.emergency_type] || { label: e.emergency_type, icon: 'siren' };
      parts.push(
        el('div', { class: 'alert alert-error' }, icon(em.icon), el('div', { class: 'grow' }, el('strong', {}, `${em.label} — reported via ${(e.report_channel || 'app').toUpperCase()}. `),
          e.description ? `"${e.description}"` : 'No description given.')),
        el('dl', { class: 'facts' },
          fact('Reported by', t ? [t.name, t.demo ? [' ', demoBadge()] : null] : 'Unregistered caller'),
          fact('Phone', e.reporter_phone ? el('a', { href: `tel:${e.reporter_phone}`, class: 'strong' }, `${e.reporter_phone} (tap to call)`) : '—'),
          t ? fact('Group size', String(t.group_size)) : null,
          t?.lodge ? fact('Staying at', t.lodge) : null,
          t ? fact('Language', languageName(t.language)) : null,
          t?.nationality ? fact('Nationality', t.nationality) : null,
          fact('Location', e.lat !== null ? (e.zone_label || 'Shared from phone') : 'Not shared'),
          respond));
    } else {
      const snap = el('div', { class: 'snapshot' });
      if (e.snapshotUrl) {
        const img = el('img', { src: e.snapshotUrl, alt: `Image that triggered ${e.ref}`, loading: 'lazy' });
        img.addEventListener('error', () => clear(snap, el('div', { class: 'empty' }, icon('image-off'), el('strong', {}, 'Image could not be loaded'),
          el('p', {}, 'The image file may have been removed from this laptop. The rest of the record is intact.'))));
        snap.append(el('a', { href: e.snapshotUrl, target: '_blank', rel: 'noopener', 'aria-label': `Open the ${e.ref} image full size` }, img));
      } else {
        snap.classList.add('is-none');
        snap.append(icon('image-off', 'icon icon-sm'), el('span', {}, e.source === 'simulated' ? 'No photo — simulated detection.' : e.source === 'synthetic' ? 'No photo — test incident.' : 'No photo was saved for this alert.'));
      }
      const d = data.detection;
      parts.push(snap, el('dl', { class: 'facts' },
        fact('Camera', data.cameraLabel || '—'),
        fact(e.kind === 'zone_alert' ? 'Camera zone' : 'Safety zone', e.zone_label || '—'),
        fact('Detected', e.class_label ? `${e.class_label}, peak confidence ${Math.round((e.confidence || 0) * 100)}%` : '—'),
        fact('Detection source', [SOURCE[e.source]?.label || e.source, d ? ` · ${d.input === 'upload' ? 'uploaded photo' : d.input === 'camera' ? 'live camera' : 'simulated camera'}` : '']),
        d?.zone_name ? fact('Distance', d.inside_zone ? `Inside ${d.zone_name}` : `${Math.round(d.distance_m)} m from ${d.zone_name} (alert distance ${d.buffer_m} m)`) : null,
        fact('First seen', fmtTime(e.first_seen_at)),
        fact('Last seen', fmtDateTime(e.last_seen_at)),
        respond,
        BOOT.permissions?.canViewTechnical && e.model ? fact('Model', e.model) : null));
      const reasons = e.risk_reasons || d?.risk_reasons;
      if (reasons?.length) parts.push(el('div', { class: 'stack detail-block' }, el('h3', {}, 'Why this risk level'), el('ul', { class: 'reasons' }, reasons.map((r) => el('li', {}, r)))));
    }
    if (e.lat !== null && e.lng !== null) parts.push(el('div', { class: 'stack detail-block' }, el('h3', {}, 'Location'), mapBox));
    clear(evidence, ...parts);
    if (e.lat !== null && e.lng !== null) drawMiniMap(mapBox, e);
  }

  async function drawMiniMap(box, e) {
    try {
      const m = await createMap(box, { center: [e.lat, e.lng], zoom: 15 });
      miniMap?.destroy();
      miniMap = m;
      if (e.area_id) {
        const z = await api.get(`/api/zones?area=${encodeURIComponent(e.area_id)}`);
        m.drawZones(z.zones);
      }
      m.drawIncidents([{ ...e, ref: e.ref }]);
      m.map.setView([e.lat, e.lng], 15);
    } catch {
      clear(box, el('p', { class: 'muted small' }, 'Map unavailable.'));
    }
  }

  // ---------------------------------------------------------------- actions
  function renderActions(e) {
    if (actionStatus === e.status && actionPanel.childElementCount) {
      updateOwner(e);
      return;
    }
    actionStatus = e.status;
    const owner = el('div', { class: 'owner-card', 'data-owner': '' });
    clear(actionPanel, owner);
    updateOwner(e);

    if (e.status === 'open') {
      const btn = el('button', { type: 'button', class: 'btn btn-urgent btn-lg btn-block' }, icon('user'), el('span', {}, "I'm responding"));
      const status = el('p', { class: 'form-status', 'aria-live': 'polite' });
      btn.addEventListener('click', () => runAction(btn, status, async () => {
        const r = await api.post(`/api/incidents/${e.id}/status`, { status: 'responding' });
        if (r.alreadyResponding) throw new Error(`${r.event.acknowledged_by} is already responding.`);
        await Promise.all([load(), store.refresh()]);
      }, { success: `You are responding to ${e.ref}. Verify, coordinate by radio, and log handoffs.` }));
      actionPanel.append(btn, status, el('p', { class: 'hint' }, e.kind === 'sos'
        ? 'The reporter gets an SMS that a ranger is responding. Call them if you can.'
        : 'You become the owner. Verify on the ground and coordinate by radio.'));
      return;
    }

    if (e.status === 'acknowledged') {
      const tabs = [
        { id: 'handoff', label: 'Log handoff', icon: 'radio', panel: handoffForm(e) },
        { id: 'close', label: 'Resolve', icon: 'check-circle', panel: closeForm(e) },
        { id: 'dismiss', label: 'False alarm', icon: 'x', panel: dismissForm(e) },
        { id: 'note', label: 'Add note', icon: 'note', panel: noteForm(e) },
      ];
      const tablist = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Incident actions' });
      const panels = [];
      tabs.forEach((t, i) => {
        const tab = el('button', { type: 'button', role: 'tab', id: `tab-${t.id}`, 'aria-controls': `panel-${t.id}`, 'aria-selected': String(activeTab === t.id), tabindex: activeTab === t.id ? '0' : '-1' },
          icon(t.icon, 'icon icon-sm'), t.label);
        const panel = el('div', { role: 'tabpanel', id: `panel-${t.id}`, 'aria-labelledby': `tab-${t.id}`, class: 'tabpanel', hidden: activeTab !== t.id }, t.panel);
        tab.addEventListener('click', () => select(i));
        tab.addEventListener('keydown', (ev) => {
          const dir = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
          if (ev.key === 'Home') select(0, true);
          else if (ev.key === 'End') select(tabs.length - 1, true);
          else if (dir) select((i + dir + tabs.length) % tabs.length, true);
        });
        tablist.append(tab);
        panels.push(panel);
      });
      function select(i, focus = false) {
        activeTab = tabs[i].id;
        [...tablist.children].forEach((t, j) => {
          t.setAttribute('aria-selected', String(i === j));
          t.tabIndex = i === j ? 0 : -1;
          panels[j].hidden = i !== j;
        });
        if (focus) tablist.children[i].focus();
      }
      actionPanel.append(tablist, ...panels);
      return;
    }

    // closed / false alert: allow notes only
    actionPanel.append(el('h3', {}, 'Add a note'), el('p', { class: 'hint' }, 'Notes stay attached to this incident for later review.'), noteForm(e));
  }

  function updateOwner(e) {
    const owner = actionPanel.querySelector('[data-owner]');
    if (!owner) return;
    if (!e.acknowledged_by) {
      clear(owner, el('span', { class: 'avatar is-empty', 'aria-hidden': 'true' }, '?'),
        el('div', {}, el('strong', {}, 'Nobody owns this incident yet'), el('p', { class: 'small muted' }, `Waiting ${age(e.opened_at)}.`)));
      return;
    }
    const name = e.acknowledged_by_name || e.acknowledged_by;
    const secs = (Date.parse(e.acknowledged_at) - Date.parse(e.opened_at)) / 1000;
    clear(owner, el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name)),
      el('div', {}, el('strong', {}, `Owned by ${name}${e.acknowledged_by === BOOT.operator.id ? ' (you)' : ''}`),
        el('p', { class: 'small muted' }, `Acknowledged ${fmtDateTime(e.acknowledged_at)}, ${fmtDuration(secs)} after the alert opened.`),
        e.closed_at ? el('p', { class: 'small muted' }, `${e.status === 'closed' ? 'Closed' : 'Marked false alert'} by ${e.closed_by_name || e.closed_by} ${fmtDateTime(e.closed_at)}.`) : null));
  }

  /** Shared form builder: textarea + submit with validation, progress and idempotency key. */
  function actionForm({ e, fields = [], label, placeholder, hintText, submitLabel, submitClass = 'btn-primary', body, success, confirm, url }) {
    let clientActionId = uid();
    const fid = `f-${uid().slice(0, 8)}`;
    const note = el('textarea', { id: `${fid}-note`, maxlength: '500', placeholder, 'aria-describedby': `${fid}-hint ${fid}-err`, required: true });
    const count = el('span', { class: 'char-count', 'aria-hidden': 'true' }, '0 / 500');
    note.addEventListener('input', () => {
      count.textContent = `${note.value.length} / 500`;
      if (note.value.trim()) note.setAttribute('aria-invalid', 'false');
    });
    const err = el('p', { class: 'field-error', id: `${fid}-err`, hidden: true });
    const btn = el('button', { type: 'submit', class: `btn ${submitClass}` }, el('span', {}, submitLabel));
    const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
    const form = el('form', { novalidate: true },
      ...fields,
      el('div', { class: 'field' }, el('label', { for: `${fid}-note` }, label), note,
        el('div', { class: 'row between' }, el('span', { class: 'hint', id: `${fid}-hint` }, hintText), count), err),
      el('div', { class: 'form-actions' }, btn, status));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!validateRequired(note, err, 'Please add a short note before saving.')) return;
      if (confirm && !(await confirmDialog(confirm()))) return;
      const result = await runAction(btn, status, async () => {
        const r = await api.post(url || `/api/events/${e.id}/actions`, { ...body(note.value.trim()), clientActionId });
        await Promise.all([load(), store.refresh()]);
        return r;
      }, { success });
      if (result) {
        note.value = '';
        count.textContent = '0 / 500';
        clientActionId = uid(); // a retry after a failure re-uses the same id, so it cannot double-log
      }
    });
    return form;
  }

  function handoffForm(e) {
    const channels = el('fieldset', { class: 'choice-group' }, el('legend', { class: 'label' }, 'How did you hand off?'),
      [['radio', 'Radio', 'radio'], ['phone', 'Phone', 'phone'], ['in_person', 'In person', 'person']].map(([v, l, ic], i) =>
        el('label', { class: 'choice' }, el('input', { type: 'radio', name: `channel-${e.id}`, value: v, checked: i === 0 }), el('span', {}, icon(ic, 'icon icon-sm'), l))));
    return actionForm({
      e, fields: [channels], label: 'Who did you contact, and what was agreed?', placeholder: 'e.g. Guide Juma on channel 3 — guests held at the lodge',
      hintText: 'Log each radio or phone handoff as it happens.', submitLabel: 'Log handoff',
      body: (note) => ({ type: 'handoff', channel: channels.querySelector('input:checked').value, note }), success: 'Handoff logged.',
    });
  }

  function closeForm(e) {
    return actionForm({
      e, label: 'What did you verify?', placeholder: 'e.g. Herd moved east off the path; guides informed by radio',
      hintText: e.kind === 'sos' ? 'The reporter is told by SMS that it is resolved.' : 'Further sightings from this camera and zone can open a new incident afterwards.', submitLabel: 'Mark resolved',
      url: `/api/incidents/${e.id}/status`, body: (note) => ({ status: 'resolved', outcome: 'handled', note }), success: `${e.ref} resolved.`,
      confirm: () => ({ title: `Resolve ${e.ref}?`, body: 'Only resolve once you have verified the situation. Resolved does not mean the area is safe; cameras keep watching.', confirmLabel: 'Mark resolved' }),
    });
  }

  function dismissForm(e) {
    const reason = el('select', { id: `reason-${e.id}` }, FALSE_REASONS.map((r) => el('option', { value: r }, r)));
    const form = actionForm({
      e, fields: [el('div', { class: 'field' }, el('label', { for: `reason-${e.id}` }, 'What was it?'), reason)],
      label: 'Details', placeholder: 'e.g. Supply truck on the service road', hintText: 'Recorded with the reason above.',
      submitLabel: 'Resolve as false alarm', submitClass: 'btn-amber',
      url: `/api/incidents/${e.id}/status`, body: (note) => ({ status: 'resolved', outcome: 'false_alarm', note: `${reason.value}: ${note}` }), success: `${e.ref} resolved as a false alarm.`,
      confirm: () => ({ title: `Resolve ${e.ref} as a false alarm?`, body: `Reason: ${reason.value}.`, confirmLabel: 'Resolve as false alarm' }),
    });
    return form;
  }

  function noteForm(e) {
    return actionForm({
      e, label: 'Note', placeholder: 'Anything the next shift should know', hintText: 'Notes do not change the incident status.',
      submitLabel: 'Add note', submitClass: '', body: (note) => ({ type: 'note', note }), success: 'Note added.',
    });
  }

  function attemptLabel(outcome) {
    return { accepted: 'Accepted', transient: 'Not sent — will retry', ambiguous: 'Unknown outcome', rejected: 'Rejected' }[outcome] || outcome;
  }

  // ---------------------------------------------------------------- timeline
  function renderTimeline() {
    // People's actions only: message delivery details are handled by Africa's Talking, not shown here.
    const items = data.timeline.filter((t) => t.kind === 'action').map((t) => {
      let ic = 'info';
      let tone = '';
      let title = '';
      let who = '';
      let note = null;
      if (t.kind === 'action') {
        const a = ACTION[t.action] || { label: t.action, icon: 'info', tone: '' };
        ic = a.icon;
        tone = a.tone;
        title = a.label + (t.channel && t.channel !== 'dashboard' ? ` via ${CHANNEL[t.channel] || t.channel}` : '');
        who = t.actor.startsWith('system:') ? 'System' : t.actor.startsWith('tourist:') ? `Tourist ${data.tourist?.name ?? ''}`.trim() : t.actor.includes(':') ? `Caller ${t.actor.split(':')[1]}` : t.actorName || t.actor;
        note = t.note;
      } else if (t.kind === 'sms_queued') {
        ic = 'sms';
        title = `${t.channel === 'voice' ? 'Voice call' : 'SMS'} to ${t.recipient} queued`;
        who = 'System';
      } else if (t.kind === 'sms_attempt') {
        ic = t.outcome === 'accepted' ? 'check' : t.outcome === 'transient' ? 'refresh' : 'alert';
        tone = t.outcome === 'accepted' ? 'ok' : t.outcome === 'transient' ? 'warn' : 'bad';
        title = `${t.channel === 'voice' ? 'Voice call' : 'SMS'} to ${t.recipient}: ${attemptLabel(t.outcome).toLowerCase()}`;
        who = 'SMS provider';
        note = t.detail;
      } else if (t.kind === 'sms_delivery') {
        ic = t.status === 'delivered' ? 'check-circle' : 'alert';
        tone = t.status === 'delivered' ? 'ok' : 'bad';
        title = t.status === 'delivered' ? `SMS delivered to ${t.recipient}'s phone` : `SMS delivery to ${t.recipient} failed`;
        who = 'Delivery report';
        note = t.detail;
      } else if (t.kind === 'sms_not_sent') {
        ic = 'clock';
        title = `SMS to ${t.recipient} ${SMS[t.status]?.label.toLowerCase() || t.status}`;
        who = 'System';
        note = t.detail;
      }
      return el('li', {},
        el('span', { class: `tl-icon ${tone ? `tone-${tone}` : ''}`, 'aria-hidden': 'true' }, icon(ic)),
        el('div', {},
          el('div', { class: 'tl-head' }, el('strong', {}, title), el('span', { class: 'tl-time' }, `${fmtTime(t.at)} · ${who}`)),
          note ? el('div', { class: 'tl-note' }, note) : null));
    });
    clear(timeline, items.length ? items : el('li', { class: 'muted' }, 'No activity recorded.'));
  }

  function fact(k, v) {
    return [el('dt', {}, k), el('dd', {}, v)];
  }

  load();
  const timer = setInterval(() => {
    if (!document.hidden) load();
  }, 4000);
  return {
    destroy() {
      destroyed = true;
      clearInterval(timer);
      miniMap?.destroy();
    },
  };
}
