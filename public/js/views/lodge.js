// Front desk: a lodge's guests, wildlife alerts at the property, the "Are you safe?" roll call and the check-in QR.
import { age, api, BOOT, clear, confirmDialog, el, fmtDateTime, fmtTime, icon, initials, qs, runAction, toast } from '../lib.js';
import { EMERGENCY, languageName, RISK } from '../status.js';

const STATUS = {
  help: { label: 'Needs help', tone: 'urgent', icon: 'siren' },
  pending: { label: 'No reply yet', tone: 'warn', icon: 'clock' },
  safe: { label: 'Safe', tone: 'ok', icon: 'check-circle' },
};
const via = (r) => (r.channel === 'app' ? 'in the app' : r.channel === 'sms' ? 'by SMS' : r.channel === 'host' ? `confirmed by ${r.marked_by || 'front desk'}` : '');
const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
const ESCORT_TO = { dining: 'Restaurant', reception: 'Reception', bar: 'Bar / fire pit', room: 'Their tent or room', other: 'Other' };
const ACTIVITY = { game_drive: 'Game drive', walking_safari: 'Walking safari', picnic: 'Picnic', sundowner: 'Sundowner', other: 'Other activity' };

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
      const key = JSON.stringify([data.lodge, data.rollCall, data.alerts, data.sos, data.guests, data.allClear, data.escorts, data.activities.map((a) => [a.id, a.status])]);
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
      el('div', { class: 'desk-main' }, rollCallPanel(), escortPanel(), alertsPanel(), outPanel(), sosPanel()),
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
                el('div', { class: 'small muted' }, a.responder ? `Ranger ${a.responder} is responding` : 'Rangers alerted, waiting for a responder'),
                a.guests_out ? el('div', { class: 'small desk-help-note' }, icon('users', 'icon icon-sm'), ` ${people(a.guests_out)} from your lodge ${a.guests_out === 1 ? 'is' : 'are'} out here now. Call their guide.`) : null),
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

  // ---------------------------------------------------------------- night escorts
  function escortPanel() {
    const list = data.escorts;
    const waiting = list.filter((e) => e.status === 'requested').length;
    const dest = (e) => (e.to_key === 'other' ? e.to_text : ESCORT_TO[e.to_key]);
    return el('section', { class: `panel${waiting ? ' desk-attn' : ''}`, 'aria-labelledby': 'esc-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'esc-title' }, icon('person'), 'Night escorts'), el('span', { class: 'muted small' }, waiting ? `${waiting} waiting` : '')),
      el('div', { class: 'panel-body' }, list.length
        ? el('ul', { class: 'desk-guests' }, list.map((e) => {
            const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
            const actions = [];
            if (e.status === 'requested') {
              const b = el('button', { type: 'button', class: 'btn btn-sm btn-primary' }, icon('check', 'icon icon-sm'), el('span', {}, 'Accept'));
              b.addEventListener('click', async () => {
                const who = el('input', { id: 'esc-who', value: BOOT.operator.name, maxlength: '60' });
                const ok = await confirmDialog({ title: `Escort for ${e.name}`, body: el('div', { class: 'field' }, el('label', { for: 'esc-who' }, 'Who is going?'), who, el('p', { class: 'hint' }, 'The guest sees this name in the app.')), confirmLabel: 'Send escort' });
                if (ok) await runAction(b, status, () => api.post(`/api/lodge/escorts/${e.id}/accept${qs({ lodge: lodgeId })}`, { escort_name: who.value.trim() }), { success: 'Escort on the way.' }).then(load);
              });
              actions.push(b);
            }
            if (e.status === 'requested' || e.status === 'accepted') {
              const d = el('button', { type: 'button', class: 'btn btn-sm' }, 'Done');
              d.addEventListener('click', () => runAction(d, status, () => api.post(`/api/lodge/escorts/${e.id}/done${qs({ lodge: lodgeId })}`, {}), { success: 'Escort done.' }).then(load));
              actions.push(d);
            }
            const tone = e.status === 'requested' ? 'urgent' : e.status === 'accepted' ? 'warn' : 'ok';
            const label = e.status === 'requested' ? 'Waiting' : e.status === 'accepted' ? `${e.escort_name} on the way` : 'Done';
            return el('li', { class: `desk-guest st-${e.status === 'requested' ? 'help' : e.status === 'accepted' ? 'pending' : 'safe'}` },
              el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(e.name)),
              el('div', { class: 'grow' },
                el('strong', {}, `${e.from_place} → ${dest(e)}`),
                el('div', { class: 'small muted' }, `${e.name} · ${people(e.people)} · asked ${fmtTime(e.created_at, false)} · `, el('a', { href: `tel:${e.phone}` }, e.phone)),
                e.note ? el('div', { class: 'small' }, `“${e.note}”`) : null),
              el('div', { class: 'desk-guest-status' }, el('span', { class: `inc-status tone-${tone}` }, label), el('div', { class: 'row' }, actions), status));
          }))
        : el('p', { class: 'muted' }, 'No escort requests. Guests can ask for one in the app after dark.')));
  }

  // ---------------------------------------------------------------- guests out on activities
  function outPanel() {
    const list = data.activities;
    const overdue = list.filter((a) => a.status === 'overdue').length;
    const add = el('button', { type: 'button', class: 'btn btn-sm' }, icon('plus', 'icon icon-sm'), el('span', {}, 'Log an activity'));
    add.addEventListener('click', () => logActivity());
    const ST = { out: ['Out now', 'warn'], overdue: ['Overdue', 'urgent'], planned: ['Planned', 'muted'], returned: ['Back', 'ok'] };
    return el('section', { class: `panel${overdue ? ' desk-attn' : ''}`, 'aria-labelledby': 'out-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'out-title' }, icon('map'), 'Guests out'), add),
      el('div', { class: 'panel-body' }, list.length
        ? el('ul', { class: 'desk-guests' }, list.map((a) => {
            const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
            const back = a.status === 'returned' ? null : el('button', { type: 'button', class: 'btn btn-sm' }, a.status === 'planned' ? 'Cancel' : 'Back');
            back?.addEventListener('click', () => runAction(back, status, () => api.post(`/api/lodge/activities/${a.id}/${a.status === 'planned' ? 'cancel' : 'back'}${qs({ lodge: lodgeId })}`, {}), { success: a.status === 'planned' ? 'Cancelled.' : `${a.name} is back.` }).then(load));
            const [label, tone] = ST[a.status] || ['', 'muted'];
            return el('li', { class: `desk-guest st-${a.status === 'overdue' ? 'help' : a.status === 'out' ? 'pending' : 'safe'}` },
              el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(a.name)),
              el('div', { class: 'grow' },
                el('strong', {}, `${a.name} · ${ACTIVITY[a.kind] || a.kind}`),
                el('div', { class: 'small muted' }, `${a.zone_name} · ${people(a.people)} · ${a.status === 'planned' ? `from ${fmtTime(a.starts_at, false)}, ` : ''}back by ${fmtTime(a.ends_at, false)}${a.returned_at ? ` · back ${fmtTime(a.returned_at, false)}` : ''} · `, el('a', { href: `tel:${a.phone}` }, a.phone))),
              el('div', { class: 'desk-guest-status' }, el('span', { class: `inc-status tone-${tone}` }, label), back, status));
          }))
        : el('p', { class: 'muted' }, 'Nobody is out. Guests check in walks, drives and picnics in the app, or log one here.')));
  }

  async function logActivity() {
    const guest = el('select', { id: 'la-guest' }, data.guests.map((g) => el('option', { value: String(g.id) }, `${g.name} (${people(g.group_size)})`)));
    const kind = el('select', { id: 'la-kind' }, Object.entries(ACTIVITY).map(([v, l]) => el('option', { value: v }, l)));
    const place = el('select', { id: 'la-place' }, data.places.map((p) => el('option', { value: String(p.id) }, `${p.name} (${p.kind})`)));
    const hours = el('select', { id: 'la-hours' }, [1, 2, 3, 4, 6, 8].map((h) => el('option', { value: String(h), selected: h === 3 }, `${h} hour${h === 1 ? '' : 's'}`)));
    const f = (id, l, c) => el('div', { class: 'field' }, el('label', { for: id }, l), c);
    if (!data.guests.length || !data.places.length) {
      await confirmDialog({ title: 'Log an activity', body: !data.guests.length ? 'No guests are staying tonight.' : 'No outing places are set up in this area. Ask an admin to add trails or picnic sites under Safety zones.', confirmLabel: 'OK' });
      return;
    }
    const ok = await confirmDialog({
      title: 'Log an activity',
      body: el('div', { class: 'stack' }, f('la-guest', 'Guest', guest), f('la-kind', 'Activity', kind), f('la-place', 'Where', place), f('la-hours', 'Back in', hours),
        el('p', { class: 'hint' }, 'Starts now. Rangers see the group on their map, and wildlife alerts there count these guests.')),
      confirmLabel: 'Log activity',
    });
    if (!ok) return;
    const ends = new Date(Date.now() + Number(hours.value) * 3_600_000).toISOString();
    try {
      await api.post(`/api/lodge/activities${qs({ lodge: lodgeId })}`, { tourist_id: Number(guest.value), kind: kind.value, zone_id: Number(place.value), ends_at: ends });
      toast('Activity logged.');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
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
        el('p', { class: 'small' }, el('strong', {}, 'Scan to get wildlife alerts and one-tap SOS during your stay.'), ' In 7 languages.'),
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
              el('div', { class: 'small muted' }, `${people(x.group_size)} · ${languageName(x.language)} · leaves ${new Date(`${x.trip_end}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`)),
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
