// Front desk: a lodge's guests, wildlife alerts at the property, the "Are you safe?" roll call and the check-in QR.
import { age, api, BOOT, clear, confirmDialog, el, fmtDateTime, fmtTime, icon, initials, qs, runAction } from '../lib.js';
import { EMERGENCY, RISK } from '../status.js';

const STATUS = {
  help: { label: 'Needs help', tone: 'urgent', icon: 'siren' },
  pending: { label: 'No reply yet', tone: 'warn', icon: 'clock' },
  safe: { label: 'Safe', tone: 'ok', icon: 'check-circle' },
};
const via = (r) => (r.channel === 'app' ? 'in the app' : r.channel === 'sms' ? 'by SMS' : r.channel === 'host' ? `confirmed by ${r.marked_by || 'front desk'}` : '');
const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;

export function mount(main, ctx) {
  const isAdmin = BOOT.operator.role === 'admin';
  let lodgeId = ctx.params.lodge || '';
  let data = null;
  let lastKey = '';
  const head = el('div', { class: 'page-head' });
  const body = el('div', { class: 'desk' }, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'));
  main.append(head, body);

  async function load() {
    try {
      data = await api.get(`/api/lodge${qs({ lodge: lodgeId })}`);
      const key = JSON.stringify([data.lodge, data.rollCall, data.alerts, data.sos, data.guests, data.allClear]);
      if (key !== lastKey) {
        lastKey = key;
        render();
      }
    } catch (err) {
      clear(body, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), el('div', { class: 'grow' }, el('strong', {}, 'Could not load the front desk. '), err.message)));
    }
  }

  function render() {
    const { lodge } = data;
    const switcher = isAdmin && data.lodges?.length > 1
      ? el('select', { 'aria-label': 'Lodge', onchange: (e) => ctx.navigate(`#/lodge?lodge=${encodeURIComponent(e.target.value)}`, { replace: true }) },
          data.lodges.map((l) => el('option', { value: l.id, selected: l.id === lodge.id }, l.name)))
      : null;
    clear(head,
      el('div', {}, el('h1', {}, 'Front desk'), el('p', { class: 'sub' }, `${lodge.name} · ${lodge.area_name}`)),
      switcher ? el('div', { class: 'page-actions' }, switcher) : null);
    clear(body,
      el('div', { class: 'desk-main' }, rollCallPanel(), alertsPanel(), sosPanel()),
      el('aside', { class: 'desk-side' }, qrPanel(), guestsPanel()));
  }

  // ---------------------------------------------------------------- roll call
  function rollCallPanel() {
    const rc = data.rollCall;
    const atProperty = data.alerts.filter((a) => a.at_property);
    if (!rc || rc.closed_at) {
      const start = el('button', { type: 'button', class: `btn ${atProperty.length ? 'btn-urgent' : ''}` }, icon('users'), el('span', {}, 'Start roll call'));
      const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
      start.addEventListener('click', async () => {
        const eventId = atProperty[0]?.id ?? null;
        const ok = await confirmDialog({
          title: 'Ask every guest "Are you safe?"',
          body: `${data.guests.length} guest part${data.guests.length === 1 ? 'y' : 'ies'} staying tonight will be asked in the app${eventId ? ' and by SMS' : ''}. You will see each answer here.`,
          confirmLabel: 'Start roll call',
        });
        if (ok) await runAction(start, status, () => api.post(`/api/lodge/checks${qs({ lodge: lodgeId })}`, { event_id: eventId }), { success: 'Roll call started.' }).then(load);
      });
      const ended = rc?.closed_at
        ? el('p', { class: 'desk-ended' }, icon(rc.closed_reason === 'all_clear' ? 'check-circle' : 'info', 'icon icon-sm'),
            `Last roll call ${rc.closed_reason === 'all_clear' ? 'ended with the all clear' : 'ended'} at ${fmtTime(rc.closed_at, false)}: ${rc.counts.safe + rc.counts.help} of ${rc.counts.total} answered${rc.counts.help ? `, ${rc.counts.help} needed help` : ''}.`)
        : null;
      return el('section', { class: `panel desk-rollcall is-idle${atProperty.length ? ' is-alert' : ''}` },
        el('div', { class: 'panel-body stack' },
          el('div', { class: 'desk-rc-head' },
            el('span', { class: 'desk-rc-icon' }, icon(atProperty.length ? 'incident' : 'shield')),
            el('div', { class: 'grow' },
              el('h2', {}, atProperty.length ? 'Wildlife alert at your lodge' : 'No roll call running'),
              el('p', { class: 'muted' }, atProperty.length
                ? 'Start a roll call to check every guest is safe. It starts by itself for high and critical alerts at your lodge.'
                : 'A roll call starts automatically when a high or critical wildlife alert is reported at your lodge.')),
          ),
          ended,
          el('div', { class: 'row' }, start, status)));
    }

    const c = rc.counts;
    const answered = c.safe + c.help;
    const bar = el('div', { class: 'desk-bar', role: 'img', 'aria-label': `${c.safe} safe, ${c.help} need help, ${c.pending} not answered` },
      el('span', { class: 'is-safe', style: null }), el('span', { class: 'is-help' }), el('span', { class: 'is-pending' }));
    const seg = [c.safe, c.help, c.pending];
    [...bar.children].forEach((s, i) => { s.style.flexGrow = String(seg[i]); s.hidden = !seg[i]; });

    const end = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'End roll call');
    const endStatus = el('span', { class: 'form-status', 'aria-live': 'polite' });
    end.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'End this roll call?', body: c.pending ? `${c.pending} guest part${c.pending === 1 ? 'y has' : 'ies have'} not answered yet.` : 'Every guest has answered.', confirmLabel: 'End roll call', tone: c.pending ? 'urgent' : 'primary' });
      if (ok) await runAction(end, endStatus, () => api.post(`/api/lodge/checks/${rc.id}/close${qs({ lodge: lodgeId })}`, {}), { success: 'Roll call ended.' }).then(load);
    });

    return el('section', { class: `panel desk-rollcall ${c.help ? 'is-help' : c.pending ? 'is-open' : 'is-done'}`, 'aria-labelledby': 'rc-title' },
      el('div', { class: 'panel-body stack' },
        el('div', { class: 'desk-rc-head' },
          el('span', { class: 'desk-rc-icon' }, icon(c.help ? 'siren' : c.pending ? 'users' : 'check-circle')),
          el('div', { class: 'grow' },
            el('p', { class: 'desk-kicker' }, `Roll call${rc.event_ref ? ` · ${rc.event_ref}` : ''} · started ${fmtTime(rc.started_at, false)} (${age(rc.started_at)} ago)`),
            el('h2', { id: 'rc-title' }, c.pending ? `${answered} of ${c.total} guests answered` : c.help ? `All answered · ${c.help} need${c.help === 1 ? 's' : ''} help` : `All ${c.total} guests are safe`),
            el('p', { class: 'muted' }, rc.reason)),
          el('div', { class: 'desk-big' }, el('strong', {}, `${answered}/${c.total}`), el('span', {}, `${rc.people} people`))),
        bar,
        el('ul', { class: 'desk-legend' },
          el('li', { class: 'is-safe' }, `${c.safe} safe`), el('li', { class: 'is-help' }, `${c.help} need help`), el('li', { class: 'is-pending' }, `${c.pending} no reply`)),
        el('ul', { class: 'desk-guests' }, rc.responses.map(responseRow)),
        el('div', { class: 'row between' }, el('p', { class: 'small muted' }, 'Guests answer in the app or by replying SAFE / HELP to the SMS. Call anyone who has not answered.'), el('div', { class: 'row' }, endStatus, end))));
  }

  function responseRow(r) {
    const st = STATUS[r.status];
    let action = null;
    if (r.status === 'pending') {
      const b = el('button', { type: 'button', class: 'btn btn-sm' }, icon('check', 'icon icon-sm'), el('span', {}, 'Mark safe'));
      const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
      b.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: `Mark ${r.name} safe?`, body: 'Only after you have seen them or spoken to them.', confirmLabel: 'Mark safe' });
        if (ok) await runAction(b, status, () => api.post(`/api/lodge/checks/${data.rollCall.id}/responses/${r.tourist_id}${qs({ lodge: lodgeId })}`, { status: 'safe' }), { success: `${r.name} marked safe.` }).then(load);
      });
      action = [b, status];
    }
    return el('li', { class: `desk-guest st-${r.status}` },
      el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(r.name || '?')),
      el('div', { class: 'grow' },
        el('strong', {}, r.name),
        el('div', { class: 'small muted' }, people(r.group_size ?? 1), ' · ', el('a', { href: `tel:${r.phone}` }, r.phone)),
        r.status === 'help' ? el('div', { class: 'small desk-help-note' }, icon('siren', 'icon icon-sm'), ` Rangers alerted${r.sos_event_id ? ` (SS-${String(r.sos_event_id).padStart(3, '0')})` : ''}. Call the guest now.`) : null),
      el('div', { class: 'desk-guest-status' },
        el('span', { class: `inc-status tone-${st.tone}` }, st.label),
        r.responded_at ? el('span', { class: 'small muted' }, `${via(r)} · ${fmtTime(r.responded_at, false)}`) : null,
        action));
  }

  // ---------------------------------------------------------------- alerts and SOS
  function alertsPanel() {
    const list = data.alerts;
    const clears = data.allClear;
    return el('section', { class: 'panel', 'aria-labelledby': 'al-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'al-title' }, icon('incident'), 'Wildlife alerts near you'), el('span', { class: 'muted small' }, list.length ? `${list.length} open` : '')),
      el('div', { class: 'panel-body stack' },
        clears.map((c) => el('div', { class: 'desk-clear' }, icon('check-circle'), el('div', {}, el('strong', {}, c.title), el('span', { class: 'small' }, ` · ${fmtTime(c.created_at, false)}. Guests have been told.`)))),
        list.length
          ? el('ul', { class: 'desk-alerts' }, list.map((a) => el('li', { class: `lv-${a.risk_level || 'none'}` },
              el('span', { class: 'inc-icon', 'aria-hidden': 'true' }, icon('paw')),
              el('div', { class: 'grow' },
                el('div', { class: 'inc-meta' }, el('strong', {}, a.ref), a.at_property ? el('span', { class: 'desk-at' }, 'At your lodge') : null,
                  el('span', {}, `${age(a.opened_at)} ago`), a.source !== 'inference' ? el('span', { class: 'inc-tag' }, 'Simulated') : null),
                el('strong', {}, a.title || a.zone_label),
                el('div', { class: 'small muted' }, a.responder ? `Ranger ${a.responder} is responding` : 'Rangers alerted, waiting for a responder')),
              el('span', { class: `risk-text lv-${a.risk_level}` }, RISK[a.risk_level]?.label || ''))))
          : el('p', { class: 'muted' }, 'No wildlife alerts reported near your lodge. Keep normal night procedures.')));
  }

  function sosPanel() {
    if (!data.sos.length) return null;
    return el('section', { class: 'panel', 'aria-labelledby': 'sos-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'sos-title' }, icon('siren'), 'Guest emergencies (24 h)')),
      el('div', { class: 'panel-body' }, el('ul', { class: 'desk-alerts' }, data.sos.map((s) => {
        const open = s.status === 'open' || s.status === 'acknowledged';
        return el('li', { class: open ? 'lv-critical' : 'lv-none' },
          el('span', { class: 'inc-icon', 'aria-hidden': 'true' }, icon(EMERGENCY[s.emergency_type]?.icon || 'siren')),
          el('div', { class: 'grow' },
            el('div', { class: 'inc-meta' }, el('strong', {}, s.ref), el('span', {}, fmtDateTime(s.opened_at))),
            el('strong', {}, `${EMERGENCY[s.emergency_type]?.label || 'Emergency'} — ${s.name}`),
            el('div', { class: 'small muted' }, el('a', { href: `tel:${s.phone}` }, s.phone), ' · ',
              s.status === 'open' ? 'Waiting for a ranger' : s.status === 'acknowledged' ? `Ranger ${s.responder || ''} is responding` : 'Resolved')),
          el('span', { class: `inc-status tone-${s.status === 'open' ? 'urgent' : open ? 'warn' : 'ok'}` }, s.status === 'open' ? 'Pending' : open ? 'Responding' : 'Resolved'));
      }))));
  }

  // ---------------------------------------------------------------- check-in QR and guests
  function qrPanel() {
    const copy = el('button', { type: 'button', class: 'btn btn-sm' }, icon('external', 'icon icon-sm'), el('span', {}, 'Copy link'));
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(data.checkinUrl);
        copy.lastChild.textContent = 'Copied';
      } catch {
        copy.lastChild.textContent = 'Copy failed';
      }
      setTimeout(() => { copy.lastChild.textContent = 'Copy link'; }, 2000);
    });
    const print = el('button', { type: 'button', class: 'btn btn-sm btn-primary' }, icon('download', 'icon icon-sm'), el('span', {}, 'Print'));
    print.addEventListener('click', () => {
      document.body.classList.add('print-qr');
      window.print();
      setTimeout(() => document.body.classList.remove('print-qr'), 500);
    });
    return el('section', { class: 'panel desk-qr', 'aria-labelledby': 'qr-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'qr-title' }, icon('pin'), 'Guest check-in')),
      el('div', { class: 'panel-body stack' },
        el('p', { class: 'qr-print-title' }, `Welcome to ${data.lodge.name}`),
        el('img', { src: `/api/lodge/qr.svg${qs({ lodge: lodgeId, v: data.lodge.checkin_code })}`, alt: `QR code to check in at ${data.lodge.name}`, width: '220', height: '220', class: 'desk-qr-img' }),
        el('p', { class: 'small' }, el('strong', {}, 'Scan to get wildlife alerts and one-tap SOS during your stay.'), ' English / Kiswahili.'),
        el('p', { class: 'small muted desk-code' }, 'Code ', el('strong', {}, data.lodge.checkin_code)),
        el('div', { class: 'row' }, print, copy)));
  }

  function guestsPanel() {
    const g = data.guests;
    const total = g.reduce((n, x) => n + x.group_size, 0);
    return el('section', { class: 'panel', 'aria-labelledby': 'g-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'g-title' }, icon('users'), 'Guests tonight'), el('span', { class: 'muted small' }, `${g.length} · ${people(total)}`)),
      el('div', { class: 'panel-body' }, g.length
        ? el('ul', { class: 'desk-guestlist' }, g.map((x) => el('li', {},
            el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(x.name)),
            el('div', { class: 'grow' }, el('strong', {}, x.name, x.demo ? el('span', { class: 'inc-tag small' }, ' Demo') : null),
              el('div', { class: 'small muted' }, `${people(x.group_size)} · ${x.language === 'sw' ? 'Kiswahili' : 'English'} · leaves ${new Date(`${x.trip_end}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`)),
            el('a', { class: 'btn btn-sm btn-ghost', href: `tel:${x.phone}`, 'aria-label': `Call ${x.name}` }, icon('phone', 'icon icon-sm')))))
        : el('p', { class: 'muted' }, 'No guests checked in. Ask arriving guests to scan the QR code.')));
  }

  load();
  const timer = setInterval(() => !document.hidden && load(), 4000);
  return {
    onParams(p) { lodgeId = p.lodge || ''; lastKey = ''; load(); },
    destroy() { clearInterval(timer); },
  };
}
