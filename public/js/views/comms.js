// Messages: SMS + voice outbox across all incidents, provider modes, and USSD / voice simulators.
import { api, clear, confirmDialog, el, fmtDateTime, icon, qs, runAction } from '../lib.js';
import { RESENDABLE, SMS, smsActionHint, smsBadge } from '../status.js';
import * as store from '../store.js';

export function mount(main, ctx) {
  let params = { channel: ctx.params.channel || '', recipient: ctx.params.recipient || '' };
  const providers = el('div', { class: 'tiles' });
  const seg = el('div', { class: 'row' });
  const list = el('div', { 'aria-live': 'polite' });
  const moreBox = el('div', { class: 'pager' });
  let showAll = false;
  const calls = el('div', {});
  const sessions = el('div', {});

  main.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Messages'), el('p', { class: 'sub' }, "SMS and voice alerts to rangers and tourists via Africa's Talking, plus USSD and voice emergency lines."))),
    providers,
    el('div', { class: 'cols-2 section' }, ussdSimulator(), voiceSimulator()),
    el('section', { class: 'section', 'aria-labelledby': 'out-title' }, el('div', { class: 'section-head' }, el('h2', { id: 'out-title' }, 'Outbox'), seg), list, moreBox),
    el('div', { class: 'cols-2 section' }, calls, sessions),
  );

  function renderSeg() {
    const b = (key, v, l) => el('button', { type: 'button', 'aria-pressed': String(params[key] === v), onclick: () => go({ [key]: v }) }, l);
    clear(seg, el('div', { class: 'seg', role: 'group', 'aria-label': 'Channel' }, b('channel', '', 'All'), b('channel', 'sms', 'SMS'), b('channel', 'voice', 'Voice')),
      el('div', { class: 'seg', role: 'group', 'aria-label': 'Recipient' }, b('recipient', '', 'Everyone'), b('recipient', 'ranger', 'Rangers'), b('recipient', 'tourist', 'Tourists'), b('recipient', 'duty', 'Gate duty')));
  }
  const go = (patch) => {
    params = { ...params, ...patch };
    ctx.navigate(`#/comms${qs(params)}`, { replace: true });
  };

  async function load() {
    renderSeg();
    try {
      const d = await api.get(`/api/comms${qs(params)}`);
      const p = d.providers;
      clear(providers,
        tile('sms', 'SMS', p.sms.label, p.sms.mode === 'simulated' ? 'Switch SMS_PROVIDER=africastalking to use the sandbox' : p.sms.keyConfigured ? `Username: ${p.sms.username}` : 'No AT_API_KEY set — messages will fail with that reason', p.sms.mode === 'live' ? '' : 'warn'),
        tile('phone', 'Voice', p.voice.label, p.voice.mode === 'simulated' ? "AT's voice sandbox is not operational; set a live AT number to place real calls" : 'Calls placed from your AT number', p.voice.mode === 'simulated' ? 'warn' : ''),
        tile('globe', 'USSD', p.ussd.label, 'Needs a public HTTPS callback; the simulator below runs the same menu', p.ussd.mode === 'webhook' ? '' : 'warn'));
      if (!d.jobs.length) {
        clear(list, el('div', { class: 'panel' }, el('div', { class: 'empty' }, icon('sms'), el('strong', {}, 'No messages yet'), el('p', {}, 'Messages are queued automatically when an incident opens or changes.'))));
      } else {
        clear(list, el('div', { class: 'table-wrap' }, el('table', { class: 'data table-cards' },
          el('caption', { class: 'sr-only' }, 'Recent outbound messages'),
          el('thead', {}, el('tr', {}, ['Queued', 'To', 'Incident', 'State', 'Message', ''].map((h) => el('th', { scope: 'col' }, h)))),
          el('tbody', {}, (showAll ? d.jobs : d.jobs.slice(0, 25)).map((j) => {
            const hint = smsActionHint(j);
            const active = true;
            const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
            const resend = RESENDABLE.has(j.status) && active ? el('button', { type: 'button', class: 'btn btn-sm' }, icon('send', 'icon icon-sm'), el('span', {}, 'Resend')) : null;
            resend?.addEventListener('click', async () => {
              const ok = await confirmDialog({ title: `Resend to ${j.recipient_alias}?`, body: j.status === 'unknown' ? 'The first attempt may already have arrived. Check with the recipient first.' : 'A new attempt will be queued.', confirmLabel: 'Resend' });
              if (ok) await runAction(resend, status, async () => { await api.post(`/api/notifications/${j.id}/resend`); await load(); }, { success: 'Re-queued.' });
            });
            return el('tr', {},
              el('td', { 'data-label': 'Queued' }, fmtDateTime(j.created_at)),
              el('td', { 'data-label': 'To' }, el('div', { class: 'cell-stack' },
                el('span', { class: 'row' }, el('span', { class: 'badge tone-muted' }, icon(j.channel === 'voice' ? 'phone' : 'sms'), j.channel.toUpperCase()), el('strong', {}, j.recipient_kind)),
                el('span', { class: 'small muted' }, `${j.recipient_alias}${j.to_number ? ` · ${j.to_number}` : ''}`))),
              el('td', { 'data-label': 'Incident' }, el('a', { href: `#/incidents/${j.event_id}`, class: 'strong' }, j.ref), el('div', { class: 'small muted' }, j.kind.replace(/_/g, ' '))),
              el('td', { 'data-label': 'State' }, el('div', { class: 'cell-stack' }, smsBadge(j.status), j.provider ? el('span', { class: 'small muted' }, j.provider) : null,
                j.last_error && !['accepted', 'delivered'].includes(j.status) ? el('span', { class: 'small bad-text' }, j.last_error) : null,
                hint ? el('span', { class: 'small' }, hint) : null)),
              el('td', { 'data-label': 'Message' }, el('div', { class: 'sms-body' }, j.message_body || '—')),
              el('td', { 'data-label': '' }, el('div', { class: 'row' }, resend, status)));
          })))));
      }
      clear(moreBox, d.jobs.length > 25
        ? el('button', { type: 'button', class: 'btn btn-sm', onclick: () => { showAll = !showAll; load(); } }, showAll ? 'Show the latest 25' : `Show all ${d.jobs.length} recent messages`)
        : null);
      clear(calls, el('section', { class: 'panel' }, el('div', { class: 'panel-head' }, el('h2', {}, icon('phone'), 'Simulated voice calls'), el('span', { class: 'badge tone-mock' }, 'No phone rang')),
        el('div', { class: 'panel-body stack' }, d.simulatedCalls.length ? d.simulatedCalls.map((c) => el('div', { class: 'stack' }, el('p', { class: 'small muted' }, `${fmtDateTime(c.created_at)} → ${c.to_number}`), el('div', { class: 'sms-body' }, c.script))) : el('p', { class: 'muted' }, 'None yet. Critical alerts and SOS trigger voice calls to on-duty rangers.'))));
      clear(sessions, el('section', { class: 'panel' }, el('div', { class: 'panel-head' }, el('h2', {}, icon('globe'), 'USSD & voice sessions')),
        el('div', { class: 'panel-body stack' }, d.sessions.length ? d.sessions.slice(0, 12).map((s) => el('div', { class: 'small' },
          el('div', { class: 'row' }, el('strong', {}, `${s.channel.toUpperCase()} ${s.phone || ''}`), s.simulated ? el('span', { class: 'badge tone-sim' }, 'Simulator') : el('span', { class: 'badge tone-real' }, "Africa's Talking"), el('span', { class: 'muted' }, fmtDateTime(s.created_at))),
          el('div', { class: 'muted' }, `Input: "${s.input ?? ''}" → ${(s.response || '').replace(/<[^>]+>/g, ' ').slice(0, 120)}`))) : el('p', { class: 'muted' }, 'No sessions yet.'))));
    } catch (err) {
      clear(list, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), `Could not load messages: ${err.message}`));
    }
  }

  function ussdSimulator() {
    const phone = el('input', { id: 'ussd-phone', value: '+255765000201', autocomplete: 'off' });
    const screen = el('div', { class: 'ussd-screen', 'aria-live': 'polite' }, 'Dial to start. Demo tourist +255765000201 is registered; try any other number as an unregistered caller, or a ranger number (e.g. +255754000101).');
    const input = el('input', { id: 'ussd-in', inputmode: 'numeric', autocomplete: 'off', 'aria-label': 'USSD reply' });
    let text = null;
    let session = 0;
    const send = async (reply) => {
      const nextText = text === null ? '' : text === '' ? reply : `${text}*${reply}`;
      try {
        const r = await api.post('/api/sim/ussd', { phone: phone.value, text: nextText, sessionId: String(session) });
        screen.textContent = r.response.replace(/^(CON|END) /, '');
        text = r.response.startsWith('CON') ? nextText : null;
        if (!text && text !== '') input.value = '';
        input.value = '';
        if (r.response.startsWith('END')) { text = null; load(); store.refresh(); }
        input.focus();
      } catch (e) {
        screen.textContent = e.message;
      }
    };
    const dial = el('button', { type: 'button', class: 'btn btn-sm' }, icon('phone', 'icon icon-sm'), 'Dial *384*7233#');
    dial.addEventListener('click', () => { session += 1; text = null; send(''); });
    const form = el('form', { class: 'row' }, input, el('button', { type: 'submit', class: 'btn btn-sm' }, 'Send'));
    form.addEventListener('submit', (e) => { e.preventDefault(); if (text !== null && input.value.trim()) send(input.value.trim()); });
    return el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, icon('globe'), 'USSD simulator'), el('span', { class: 'badge tone-sim' }, 'Simulator — no network')),
      el('div', { class: 'panel-body stack' },
        el('p', { class: 'small' }, "Runs the same menu Africa's Talking would call for a basic phone. Tourists can request emergency help; ranger phones can respond."),
        el('div', { class: 'field' }, el('label', { for: 'ussd-phone' }, 'Caller phone number'), phone),
        el('div', { class: 'ussd-phone' }, screen, el('div', { class: 'stack', style: null }, form, dial))));
  }

  function voiceSimulator() {
    const phone = el('input', { id: 'voice-phone', value: '+255765000203', autocomplete: 'off' });
    const out = el('div', { class: 'ussd-screen', 'aria-live': 'polite' }, 'Call the emergency line to hear the keypad menu.');
    const say = (xml) => [...new DOMParser().parseFromString(xml, 'application/xml').querySelectorAll('Say')].map((n) => n.textContent).join(' ');
    const call = async (digits) => {
      try {
        const r = await api.post('/api/sim/voice', { phone: phone.value, digits });
        out.textContent = `🔊 ${say(r.xml) || '(call ended)'}`;
        if (digits) { load(); store.refresh(); }
      } catch (e) {
        out.textContent = e.message;
      }
    };
    const keys = el('div', { class: 'row' }, [1, 2, 3, 4].map((d) => el('button', { type: 'button', class: 'btn btn-sm', onclick: () => call(String(d)) }, `Press ${d}`)));
    return el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, icon('phone'), 'Voice line simulator'), el('span', { class: 'badge tone-sim' }, 'Simulator — no call placed')),
      el('div', { class: 'panel-body stack' },
        el('p', { class: 'small' }, 'Plays the inbound emergency line: 1 medical, 2 dangerous wildlife, 3 vehicle breakdown, 4 personal safety. Pressing a key raises a real SOS incident.'),
        el('div', { class: 'field' }, el('label', { for: 'voice-phone' }, 'Caller phone number'), phone),
        el('div', { class: 'ussd-phone' }, out, el('div', { class: 'stack' }, el('button', { type: 'button', class: 'btn btn-sm', onclick: () => call() }, icon('phone', 'icon icon-sm'), 'Call emergency line'), keys))));
  }

  function tile(iconId, label, value, note, tone) {
    return el('div', { class: `tile ${tone ? `is-${tone}` : ''}` }, el('span', { class: 'tile-label' }, icon(iconId, 'icon icon-sm'), label),
      el('span', { class: 'strong' }, value), el('span', { class: 'tile-note' }, note));
  }

  load();
  const timer = setInterval(() => !document.hidden && load(), 6000);
  return { onParams(p) { params = { channel: p.channel || '', recipient: p.recipient || '' }; load(); }, destroy() { clearInterval(timer); } };
}

export { SMS };
