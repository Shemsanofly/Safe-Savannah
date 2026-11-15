// SMS notifications: every outbox job with plain-language state, actionable failures, resend, and the mock outbox.
import { api, BOOT, clear, confirmDialog, el, fmtDateTime, fmtTime, icon, qs, runAction } from '../lib.js';
import { RESENDABLE, SMS, smsActionHint, smsBadge, smsDetail } from '../status.js';
import * as store from '../store.js';

const GROUPS = [
  { value: '', label: 'All', statuses: null },
  { value: 'queued', label: 'Queued / retrying', statuses: ['pending', 'sending', 'retry_wait'] },
  { value: 'accepted', label: 'Accepted', statuses: ['accepted'] },
  { value: 'delivered', label: 'Delivered', statuses: ['delivered'] },
  { value: 'problem', label: 'Needs attention', statuses: ['failed', 'unknown', 'delivery_failed'] },
  { value: 'not_sent', label: 'Not sent', statuses: ['expired', 'cancelled'] },
];

export function mount(main, ctx) {
  let params = { group: ctx.params.group || '', page: ctx.params.page || '' };
  const providerBox = el('div', {});
  const demoBox = el('div', {});
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Filter by SMS state' });
  const list = el('div', { 'aria-live': 'polite' });
  const pager = el('nav', { class: 'pager', 'aria-label': 'Pages' });
  const mockBox = el('div', {});

  main.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'SMS notifications'),
      el('p', { class: 'sub' }, 'One SMS per alert goes to the duty phone. Messages wait safely here if the uplink is down.'))),
    providerBox,
    el('section', { class: 'panel section', 'aria-labelledby': 'life-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'life-title' }, icon('info'), 'What the states mean')),
      el('div', { class: 'panel-body stack' },
        el('ol', { class: 'lifecycle', 'aria-label': 'Normal lifecycle' }, ['pending', 'sending', 'accepted', 'delivered'].map((s) => el('li', {}, smsBadge(s)))),
        el('p', { class: 'small' }, el('strong', {}, 'Accepted by provider is not the same as delivered. '),
          'The provider takes the message first; a delivery report (if configured) confirms it reached the handset later. Neither means someone read it — only an acknowledgement in this app confirms ownership.'),
        el('div', { class: 'glossary' }, ['retry_wait', 'unknown', 'failed', 'delivery_failed', 'expired', 'cancelled'].map((s) =>
          el('div', { class: 'gloss-item' }, smsBadge(s), el('span', {}, SMS[s].explain)))))),
    demoBox,
    el('section', { class: 'section', 'aria-labelledby': 'jobs-title' },
      el('div', { class: 'section-head' }, el('h2', { id: 'jobs-title' }, 'Messages'), seg),
      list, pager),
    mockBox,
  );

  function renderSeg(counts) {
    clear(seg, GROUPS.map((g) => {
      const n = g.statuses ? g.statuses.reduce((a, s) => a + (counts?.[s] || 0), 0) : Object.values(counts || {}).reduce((a, b) => a + b, 0);
      return el('button', { type: 'button', 'aria-pressed': String(params.group === g.value), onclick: () => go({ group: g.value, page: '' }) },
        g.label, counts ? el('span', { class: 'count' }, String(n)) : null);
    }));
  }
  function go(patch) {
    params = { ...params, ...patch };
    ctx.navigate(`#/notifications${qs(params)}`, { replace: true });
  }

  async function load() {
    try {
      const d = await api.get(`/api/notifications${qs(params)}`);
      renderProvider(d.provider);
      renderSeg(d.countsByStatus);
      renderList(d);
      renderMock(d);
    } catch (err) {
      clear(list, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), el('div', { class: 'grow' }, el('strong', {}, 'Could not load SMS notifications. '), err.message),
        el('button', { type: 'button', class: 'btn btn-sm', onclick: load }, 'Try again')));
    }
  }

  function renderProvider(p) {
    if (p.mode === 'mock') {
      clear(providerBox, el('div', { class: 'alert alert-mock' }, icon('sms'), el('div', { class: 'grow' },
        el('strong', {}, 'Mock SMS mode. '), 'No message is sent to any phone. "Accepted" below means the mock adapter stored it in the mock outbox at the bottom of this page.')));
    } else if (p.mode === 'sandbox') {
      clear(providerBox, el('div', { class: 'alert alert-mock' }, icon('sms'), el('div', { class: 'grow' },
        el('strong', {}, "Africa's Talking sandbox. "), 'Messages appear in the provider simulator only. No real phone receives them.')));
    } else {
      clear(providerBox, el('div', { class: 'alert alert-info' }, icon('sms'), el('div', { class: 'grow' },
        el('strong', {}, "Live SMS via Africa's Talking. "), 'Messages go to the configured duty phone numbers.')));
    }
  }

  function renderList(d) {
    if (!d.items.length) {
      clear(list, el('div', { class: 'panel' }, el('div', { class: 'empty' }, icon('sms'),
        el('strong', {}, params.group ? 'No messages in this state' : 'No SMS messages yet'),
        el('p', {}, params.group ? 'Choose "All" to see every message.' : 'A message is queued automatically when an alert opens.'))));
      clear(pager);
      return;
    }
    clear(list, el('div', { class: 'stack' }, d.items.map((j) => {
      const hint = smsActionHint(j);
      const active = j.event_status === 'open' || j.event_status === 'acknowledged';
      const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
      const resend = RESENDABLE.has(j.status) && active ? el('button', { type: 'button', class: 'btn btn-sm' }, icon('send', 'icon icon-sm'), el('span', {}, 'Resend')) : null;
      resend?.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: `Resend the ${j.ref} SMS?`,
          body: j.status === 'unknown'
            ? 'The first message may already have arrived. Check the duty phone first — if it did arrive, resending sends a duplicate.'
            : 'A new attempt will be queued for the same recipient.',
          confirmLabel: 'Resend SMS',
        });
        if (ok) await runAction(resend, status, async () => {
          await api.post(`/api/notifications/${j.id}/resend`);
          await Promise.all([load(), store.refresh()]);
        }, { success: 'SMS re-queued.' });
      });
      return el('article', { class: 'sms-job' },
        el('div', { class: 'sms-head' },
          el('div', { class: 'row' }, el('a', { href: `#/incidents/${j.event_id}`, class: 'strong' }, j.ref), el('span', { class: 'muted' }, j.zone_label),
            smsBadge(j.status), j.provider === 'mock' ? el('span', { class: 'badge tone-mock' }, 'Mock') : null,
            j.event_source !== 'inference' ? el('span', { class: 'badge tone-sim' }, j.event_source === 'simulated' ? 'Simulated incident' : 'Test incident') : null),
          el('div', { class: 'row' }, resend, status)),
        el('p', { class: 'sms-explain' }, `To ${j.recipient_alias}. ${smsDetail(j)}`),
        hint ? el('div', { class: `alert ${j.status === 'retry_wait' ? 'alert-info' : 'alert-warn'}` }, icon('info'), el('span', {}, hint)) : null,
        j.last_error && !['accepted', 'delivered'].includes(j.status) ? el('p', { class: 'small muted' }, `Last error: ${j.last_error}`) : null,
        el('p', { class: 'small muted' }, `Queued ${fmtDateTime(j.created_at)} · ${j.attempts} attempt${j.attempts === 1 ? '' : 's'} · updated ${fmtTime(j.updated_at)}`));
    })));
    clear(pager, d.pages > 1 ? [
      el('button', { type: 'button', class: 'btn btn-sm', disabled: d.page <= 1, onclick: () => go({ page: String(d.page - 1) }) }, icon('chevron-left', 'icon icon-sm'), 'Previous'),
      el('span', { class: 'small strong' }, `Page ${d.page} of ${d.pages}`),
      el('button', { type: 'button', class: 'btn btn-sm', disabled: d.page >= d.pages, onclick: () => go({ page: String(d.page + 1) }) }, 'Next', icon('chevron-right', 'icon icon-sm')),
    ] : []);
  }

  function renderMock(d) {
    if (d.provider.mode !== 'mock') {
      clear(mockBox);
      return;
    }
    clear(mockBox, el('section', { class: 'panel section', 'aria-labelledby': 'mock-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'mock-title' }, icon('sms'), 'Mock outbox'), el('span', { class: 'badge tone-mock' }, 'Not sent to any phone')),
      el('div', { class: 'panel-body' }, d.mockMessages.length
        ? el('div', { class: 'stack' }, d.mockMessages.map((m) => el('div', { class: 'stack', style: null },
          el('p', { class: 'small muted' }, `${fmtDateTime(m.created_at)} → ${m.recipient_alias}`), el('div', { class: 'sms-body' }, m.body))))
        : el('p', { class: 'muted' }, 'The mock adapter has not stored any messages yet.'))));
  }

  function renderDemo(o) {
    if (!BOOT.permissions?.canUseDemoControls || !o) {
      clear(demoBox);
      return;
    }
    const current = o.sms.mockUplink;
    const key = `demo-${current}`;
    if (demoBox.dataset.key === key) return;
    demoBox.dataset.key = key;
    const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
    clear(demoBox, el('section', { class: 'panel section', 'aria-labelledby': 'demo-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'demo-title' }, icon('wifi-off'), 'Demo: simulate the SMS uplink'), el('span', { class: 'badge tone-mock' }, 'Demo control')),
      el('div', { class: 'panel-body stack' },
        el('p', { class: 'small' }, 'Only affects the mock adapter. "Down" makes sends fail as if the network were unplugged (they queue and retry). "Timeout" makes the outcome unknown.'),
        el('div', { class: 'row' }, el('div', { class: 'seg', role: 'group', 'aria-label': 'Simulated uplink state' },
          [['up', 'Up'], ['down', 'Down'], ['timeout', 'Timeout']].map(([v, l]) => {
            const b = el('button', { type: 'button', 'aria-pressed': String(current === v) }, l);
            b.addEventListener('click', () => runAction(b, status, async () => {
              await api.post('/api/demo/uplink', { state: v });
              demoBox.dataset.key = '';
              await store.refresh();
              await load();
            }, { success: `Simulated uplink is now ${l.toLowerCase()}.` }));
            return b;
          })), status))));
  }

  load();
  const timer = setInterval(() => {
    if (!document.hidden && !list.querySelector('[aria-busy="true"]')) load();
  }, 5000);
  return {
    update(s) {
      renderDemo(s.overview);
    },
    onParams(p) {
      params = { group: p.group || '', page: p.page || '' };
      load();
    },
    destroy() {
      clearInterval(timer);
    },
  };
}
