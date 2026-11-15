// Incident detail: evidence, ownership, actions, SMS history and a chronological activity log.
import { age, api, BOOT, clear, confirmDialog, el, fmtDateTime, fmtDuration, fmtTime, icon, initials, runAction, uid, validateRequired } from '../lib.js';
import {
  ACTION, CHANNEL, INCIDENT, RESENDABLE, SMS, incidentBadge, smsActionHint, smsBadge, smsDetail, sourceBadge, SOURCE,
} from '../status.js';
import * as store from '../store.js';

function lastListHash() {
  try {
    return sessionStorage.getItem('ss-last-incidents') || '#/incidents';
  } catch {
    return '#/incidents';
  }
}

const FALSE_REASONS = ['Vehicle', 'Person or staff', 'Other animal', 'Shadow, vegetation or rock', 'Camera or lighting glitch', 'Other'];

export function mount(main, ctx) {
  const id = ctx.id;
  let data = null;
  let actionStatus = null; // status the action panel was built for
  let activeTab = 'handoff';
  let destroyed = false;
  let lastEvKey = '';
  let grid = null;
  let lastTlKey = '';

  const head = el('div', { class: 'page-head' });
  const explainer = el('div', { class: 'status-explainer', role: 'status' });
  const evidence = el('div', {});
  const actionPanel = el('div', { class: 'action-panel' });
  const smsBox = el('div', {});
  const timeline = el('ol', { class: 'timeline' });

  main.append(
    el('a', { href: lastListHash(), class: 'back-link' }, icon('chevron-left', 'icon icon-sm'), 'Incidents'),
    head, explainer,
    grid = el('div', { class: 'detail-grid' },
      el('div', { class: 'stack' },
        el('section', { class: 'panel', 'aria-labelledby': 'ev-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'ev-title' }, icon('camera'), 'Detection')),
          el('div', { class: 'panel-body' }, evidence)),
        el('section', { class: 'panel', 'aria-labelledby': 'tl-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'tl-title' }, icon('clock'), 'Activity'), el('span', { class: 'muted small' }, 'Oldest first')),
          el('div', { class: 'panel-body' }, timeline))),
      el('div', { class: 'stack' },
        el('section', { class: 'panel', 'aria-labelledby': 'act-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'act-title' }, icon('user'), 'Ownership & actions')),
          el('div', { class: 'panel-body' }, actionPanel)),
        el('section', { class: 'panel', 'aria-labelledby': 'sms-title' },
          el('div', { class: 'panel-head' }, el('h2', { id: 'sms-title' }, icon('sms'), 'SMS notifications')),
          el('div', { class: 'panel-body' }, smsBox)))),
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
    clear(head,
      el('div', {},
        el('h1', {}, `${e.ref} · ${e.zone_label}`),
        el('div', { class: 'row', style: null }, incidentBadge(e.status, { pill: true }), sourceBadge(e.source, { pill: true }),
          el('span', { class: 'muted small' }, `Opened ${fmtDateTime(e.opened_at)}${active ? ` · ${age(e.opened_at)} ago` : ''}`))));
    document.title = `${e.ref} · Safe Savannah`;
    explainer.className = `status-explainer tone-${def.tone === 'urgent' ? 'urgent' : def.tone}`;
    clear(explainer, icon(def.icon), el('div', {}, el('strong', {}, def.label), el('p', { class: 'small' }, def.explain),
      e.source !== 'inference' ? el('p', { class: 'small' }, SOURCE[e.source].explain) : null));

    const evKey = JSON.stringify([e.status, e.last_seen_at, e.confidence, e.acknowledged_at, e.snapshotUrl, data.cameraLabel]);
    if (evKey !== lastEvKey) {
      renderEvidence(e);
      lastEvKey = evKey;
    }
    renderActions(e);
    if (!smsBox.querySelector('[aria-busy="true"]')) renderSms(e);
    const tlKey = JSON.stringify(data.timeline);
    if (tlKey !== lastTlKey) {
      renderTimeline();
      lastTlKey = tlKey;
    }
  }

  function renderEvidence(e) {
    const snap = el('div', { class: 'snapshot' });
    if (e.snapshotUrl) {
      const img = el('img', { src: e.snapshotUrl, alt: `Snapshot that triggered ${e.ref}: detection box over ${e.zone_label}`, loading: 'lazy' });
      img.addEventListener('error', () => clear(snap, el('div', { class: 'empty' }, icon('image-off'), el('strong', {}, 'Snapshot could not be loaded'),
        el('p', {}, 'The image file may have been removed from this laptop. The rest of the record is intact.'))));
      snap.append(el('a', { href: e.snapshotUrl, target: '_blank', rel: 'noopener', 'aria-label': `Open the ${e.ref} snapshot full size` }, img));
    } else {
      snap.append(el('div', { class: 'empty' }, icon('image-off'), el('strong', {}, 'No snapshot for this incident'),
        el('p', {}, e.source === 'synthetic' ? 'Test incidents are created without a camera image.' : 'No image was saved when this alert opened.')));
    }
    const ackSecs = e.acknowledged_at ? (Date.parse(e.acknowledged_at) - Date.parse(e.opened_at)) / 1000 : null;
    clear(evidence, snap, el('dl', { class: 'facts' },
      fact('Camera', data.cameraLabel),
      fact('Zone', e.zone_label),
      fact('Detected', `${e.class_label}, peak confidence ${Math.round(e.confidence * 100)}%`),
      fact('Detection source', SOURCE[e.source]?.label || e.source),
      fact('First seen in zone', fmtTime(e.first_seen_at)),
      fact('Alert opened', `${fmtDateTime(e.opened_at)} (${fmtDuration((Date.parse(e.opened_at) - Date.parse(e.first_seen_at)) / 1000)} after first sighting)`),
      fact('Last seen in zone', fmtDateTime(e.last_seen_at)),
      fact('Time to acknowledge', ackSecs === null ? (e.status === 'open' ? `waiting ${age(e.opened_at)}` : '—') : fmtDuration(ackSecs)),
      BOOT.permissions?.canViewTechnical && e.model ? fact('Model', e.model) : null));
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
      const btn = el('button', { type: 'button', class: 'btn btn-urgent btn-lg btn-block' }, icon('user'), el('span', {}, 'Acknowledge — I take ownership'));
      const status = el('p', { class: 'form-status', 'aria-live': 'polite' });
      btn.addEventListener('click', () => runAction(btn, status, async () => {
        const r = await api.post(`/api/events/${e.id}/acknowledge`);
        if (r.alreadyAcknowledged) throw new Error(`Already acknowledged by ${r.event.acknowledged_by}.`);
        await Promise.all([load(), store.refresh()]);
      }, { success: `${e.ref} acknowledged — you own it now. Verify, then log your handoff.` }));
      actionPanel.append(btn, status, el('p', { class: 'hint' }, 'Acknowledging records that you have taken ownership. It does not mark the incident as handled.'));
      return;
    }

    if (e.status === 'acknowledged') {
      const tabs = [
        { id: 'handoff', label: 'Log handoff', icon: 'radio', panel: handoffForm(e) },
        { id: 'close', label: 'Close incident', icon: 'check-circle', panel: closeForm(e) },
        { id: 'dismiss', label: 'False alert', icon: 'x', panel: dismissForm(e) },
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
  function actionForm({ e, fields = [], label, placeholder, hintText, submitLabel, submitClass = 'btn-primary', body, success, confirm }) {
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
        const r = await api.post(`/api/events/${e.id}/actions`, { ...body(note.value.trim()), clientActionId });
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
      hintText: 'Closing re-arms the zone once it has stayed empty for the clear window.', submitLabel: 'Close incident',
      body: (note) => ({ type: 'close', note }), success: `${e.ref} closed.`,
      confirm: () => ({ title: `Close ${e.ref}?`, body: 'Only close once you have verified the situation. Closing does not mean the path is safe; the camera keeps watching.', confirmLabel: 'Close incident' }),
    });
  }

  function dismissForm(e) {
    const reason = el('select', { id: `reason-${e.id}` }, FALSE_REASONS.map((r) => el('option', { value: r }, r)));
    const form = actionForm({
      e, fields: [el('div', { class: 'field' }, el('label', { for: `reason-${e.id}` }, 'What was it?'), reason)],
      label: 'Details', placeholder: 'e.g. Supply truck on the service road', hintText: 'Recorded with the reason above.',
      submitLabel: 'Record false alert', submitClass: 'btn-amber',
      body: (note) => ({ type: 'dismiss', note: `${reason.value}: ${note}` }), success: `${e.ref} recorded as a false alert.`,
      confirm: () => ({ title: `Record ${e.ref} as a false alert?`, body: `Reason: ${reason.value}. This closes the incident.`, confirmLabel: 'Record false alert' }),
    });
    return form;
  }

  function noteForm(e) {
    return actionForm({
      e, label: 'Note', placeholder: 'Anything the next shift should know', hintText: 'Notes do not change the incident status.',
      submitLabel: 'Add note', submitClass: '', body: (note) => ({ type: 'note', note }), success: 'Note added.',
    });
  }

  // ---------------------------------------------------------------- SMS
  function renderSms(e) {
    const active = e.status === 'open' || e.status === 'acknowledged';
    const jobs = data.notifications;
    if (!jobs.length) {
      clear(smsBox, el('div', { class: 'empty' }, icon('sms'), el('strong', {}, 'No SMS for this incident'),
        el('p', {}, e.source === 'synthetic' ? 'No duty number was configured when this test incident was created.' : 'No SMS job was created for this alert.')));
      return;
    }
    clear(smsBox,
      el('p', { class: 'small muted' }, 'Accepted by provider ≠ delivered ≠ read. Acknowledgement in this app is the only confirmation that someone took ownership.'),
      jobs.map((j) => {
        const hint = smsActionHint(j);
        const isMock = j.provider === 'mock';
        const resend = RESENDABLE.has(j.status) && active
          ? el('button', { type: 'button', class: 'btn btn-sm' }, icon('send', 'icon icon-sm'), el('span', {}, 'Resend'))
          : null;
        const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
        resend?.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Resend this SMS?',
            body: j.status === 'unknown'
              ? 'The first message may already have arrived. Check the duty phone first — if it did arrive, resending sends a duplicate.'
              : 'A new attempt will be queued for the same recipient.',
            confirmLabel: 'Resend SMS',
          });
          if (!ok) return;
          await runAction(resend, status, async () => {
            await api.post(`/api/notifications/${j.id}/resend`);
            await Promise.all([load(), store.refresh()]);
          }, { success: 'SMS re-queued.' });
        });
        return el('div', { class: 'sms-job' },
          el('div', { class: 'sms-head' },
            el('div', { class: 'row' }, el('strong', {}, `To ${j.recipient_alias}`), smsBadge(j.status), isMock ? el('span', { class: 'badge tone-mock' }, 'Mock — not sent to a phone') : null),
            el('div', { class: 'row' }, resend, status)),
          el('p', { class: 'sms-explain' }, smsDetail(j)),
          hint ? el('div', { class: `alert ${['retry_wait'].includes(j.status) ? 'alert-info' : 'alert-warn'}` }, icon('info'), el('span', {}, hint)) : null,
          j.last_error && !['accepted', 'delivered'].includes(j.status) ? el('p', { class: 'small muted' }, `Last error: ${j.last_error}`) : null,
          j.message_body ? el('div', { class: 'sms-body', 'aria-label': 'Message text' }, j.message_body) : null,
          j.attemptLog.length ? el('details', {}, el('summary', { class: 'small strong' }, `${j.attemptLog.length} send attempt${j.attemptLog.length === 1 ? '' : 's'}`),
            el('div', { class: 'table-wrap', style: null }, el('table', { class: 'data' },
              el('thead', {}, el('tr', {}, ['Time', 'Result', 'Detail'].map((h) => el('th', { scope: 'col' }, h)))),
              el('tbody', {}, j.attemptLog.map((a) => el('tr', {}, el('td', {}, fmtTime(a.finished_at)),
                el('td', {}, attemptLabel(a.outcome)), el('td', { class: 'small' }, [a.http_status ? `HTTP ${a.http_status}. ` : '', a.detail || '—']))))))) : null);
      }));
  }

  function attemptLabel(outcome) {
    return { accepted: 'Accepted', transient: 'Not sent — will retry', ambiguous: 'Unknown outcome', rejected: 'Rejected' }[outcome] || outcome;
  }

  // ---------------------------------------------------------------- timeline
  function renderTimeline() {
    const items = data.timeline.map((t) => {
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
        who = t.actor.startsWith('system:') ? 'System' : t.actorName || t.actor;
        note = t.note;
      } else if (t.kind === 'sms_queued') {
        ic = 'sms';
        title = `SMS to ${t.recipient} queued`;
        who = 'System';
      } else if (t.kind === 'sms_attempt') {
        ic = t.outcome === 'accepted' ? 'check' : t.outcome === 'transient' ? 'refresh' : 'alert';
        tone = t.outcome === 'accepted' ? 'ok' : t.outcome === 'transient' ? 'warn' : 'bad';
        title = `SMS to ${t.recipient}: ${attemptLabel(t.outcome).toLowerCase()}`;
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
    },
  };
}
