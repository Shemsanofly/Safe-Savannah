// Lodge and tourism report. Admins see every partner lodge (or one); a front desk sees its own lodge.
import { api, BOOT, clear, el, fmtDateTime, fmtDuration, icon, qs } from '../lib.js';
import { languageName } from '../status.js';

const ACTIVITY = { game_drive: 'Game drive', walking_safari: 'Walking safari', picnic: 'Picnic', sundowner: 'Sundowner', other: 'Other activity' };
const dur = (s) => (s == null ? '—' : fmtDuration(s));
const pct = (n) => (n == null ? '—' : `${n}%`);

export function mount(main, ctx) {
  const isAdmin = BOOT.operator.role === 'admin';
  let days = Number(ctx.params.days) || 30;
  let lodge = ctx.params.lodge || '';
  let lodges = [];
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' });
  const lodgeSel = isAdmin ? el('select', { 'aria-label': 'Lodge' }) : null;
  const csv = el('a', { class: 'btn', download: '' }, icon('download'), el('span', {}, 'Spreadsheet'));
  const title = el('h1', {}, isAdmin ? 'Tourism report' : 'Lodge report');
  const sub = el('p', { class: 'sub' }, 'Guests, wildlife alerts, roll calls and requests at partner lodges.');
  const body = el('div', { 'aria-live': 'polite' });
  main.append(el('div', { class: 'page-head' }, el('div', {}, title, sub), el('div', { class: 'page-actions' }, lodgeSel, seg, csv)), body);

  const renderSeg = () => clear(seg, [7, 30, 90].map((d) => el('button', { type: 'button', 'aria-pressed': String(days === d), onclick: () => { days = d; renderSeg(); load(); } }, `${d} days`)));
  renderSeg();
  lodgeSel?.addEventListener('change', () => { lodge = lodgeSel.value; load(); });

  async function load() {
    clear(body, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Calculating…'));
    csv.href = `/api/lodge/report.csv${qs({ days, lodge })}`;
    try {
      const r = await api.get(`/api/lodge/report${qs({ days, lodge })}`);
      if (isAdmin && !lodges.length) {
        lodges = r.lodges.map((l) => ({ id: l.id, name: l.name }));
        clear(lodgeSel, el('option', { value: '' }, 'All lodges'), lodges.map((l) => el('option', { value: l.id }, l.name)));
        lodgeSel.value = lodge;
      }
      if (!isAdmin && r.lodges[0]) sub.textContent = `${r.lodges[0].name} · ${r.lodges[0].area_name}`;
      render(r);
    } catch (err) {
      clear(body, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), `Could not load the report: ${err.message}`));
    }
  }

  function render(r) {
    const t = r.totals;
    const single = r.lodges.length === 1;
    clear(body,
      el('p', { class: 'muted small' }, `${fmtDay(r.from_day)} – ${fmtDay(r.to_day)} · ${single ? r.lodges[0].name : `${t.lodges} partner lodge${t.lodges === 1 ? '' : 's'}`}`),
      el('div', { class: 'tiles section' },
        tile('users', 'Guests now', t.people_now, 'people', `${t.arrivals} arrival${t.arrivals === 1 ? '' : 's'} in the period`),
        tile('calendar', 'Guest-nights', t.guest_nights, null, 'People × nights stayed'),
        tile('incident', 'Alerts at lodges', t.alerts_at_lodge, null, 'Wildlife at the property', t.alerts_at_lodge ? 'warn' : ''),
        tile('check-circle', 'Guests accounted for', pct(t.accounted_pct), null, t.asked ? `${t.accounted} of ${t.asked} asked in ${t.roll_calls} roll call${t.roll_calls === 1 ? '' : 's'}` : 'No roll calls', t.accounted_pct != null && t.accounted_pct < 100 ? 'warn' : ''),
        tile('siren', 'Guest SOS', t.sos, null, t.needed_help ? `${t.needed_help} asked for help in a roll call` : null, t.sos ? 'warn' : '')),
      lodgesPanel(r, single),
      el('div', { class: 'cols-2 section' }, rollCallsPanel(r), mixPanel(r)),
      r.tours.length ? toursPanel(r) : null);
  }

  function lodgesPanel(r, single) {
    if (single) {
      const l = r.lodges[0];
      return panel(`${l.name}`, 'home', el('dl', { class: 'facts report-facts' },
        fact('Guests now', `${l.people_now} people`), fact('Arrivals', l.arrivals), fact('Guest-nights', l.guest_nights),
        fact('Wildlife alerts at the lodge', l.alerts_at_lodge), fact('High or critical alerts in the area', l.alerts_area),
        fact('Roll calls', l.roll_calls), fact('Guests accounted for', l.asked ? `${l.accounted} of ${l.asked} (${pct(l.accounted_pct)})` : '—'),
        fact('Median time until every guest answered', dur(l.median_all_answered_s)),
        fact('Night escorts', l.escorts ? `${l.escorts} · accepted in ${dur(l.median_escort_accept_s)}` : '0'),
        fact('Activities checked out', l.activities ? `${l.activities}${l.activities_late ? ` · ${l.activities_late} late back` : ''}` : '0'),
        fact('Guest SOS', l.sos ? `${l.sos} · ranger responded in ${dur(l.median_sos_response_s)}` : '0')));
    }
    const head = ['Lodge', 'Guests now', 'Guest-nights', 'Alerts at lodge', 'Roll calls', 'Accounted for', 'All answered in', 'Escorts', 'Activities', 'Guest SOS'];
    return panel('Partner lodges', 'home', el('div', { class: 'table-wrap' }, el('table', { class: 'data report-table' },
      el('thead', {}, el('tr', {}, head.map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, r.lodges.map((l) => el('tr', {},
        el('th', { scope: 'row' }, el('a', { href: `#/tourism${qs({ lodge: l.id, days })}`, onclick: (e) => { e.preventDefault(); lodge = l.id; lodgeSel.value = l.id; load(); } }, l.name), el('div', { class: 'small muted' }, l.area_name)),
        el('td', {}, `${l.people_now}`), el('td', {}, `${l.guest_nights}`),
        el('td', {}, `${l.alerts_at_lodge}`, l.alerts_area ? el('div', { class: 'small muted' }, `${l.alerts_area} high in area`) : null),
        el('td', {}, `${l.roll_calls}`),
        el('td', {}, l.asked ? pct(l.accounted_pct) : '—', l.asked ? el('div', { class: 'small muted' }, `${l.accounted} of ${l.asked}`) : null),
        el('td', {}, dur(l.median_all_answered_s)),
        el('td', {}, `${l.escorts}`, l.escorts ? el('div', { class: 'small muted' }, `accepted in ${dur(l.median_escort_accept_s)}`) : null),
        el('td', {}, `${l.activities}`, l.activities_late ? el('div', { class: 'small warn-text' }, `${l.activities_late} late`) : null),
        el('td', {}, `${l.sos}`, l.sos ? el('div', { class: 'small muted' }, `response ${dur(l.median_sos_response_s)}`) : null))))),
      el('p', { class: 'hint' }, 'Times are medians. "Accounted for" counts guests who answered a roll call (safe or asking for help) or whom the front desk confirmed.')));
  }

  function rollCallsPanel(r) {
    return panel('Roll calls', 'users', r.rollCalls.length
      ? el('ul', { class: 'report-list' }, r.rollCalls.map((c) => {
          const answered = c.safe + c.help;
          return el('li', {},
            el('div', { class: 'grow' },
              el('strong', {}, c.reason),
              el('div', { class: 'small muted' }, `${fmtDateTime(c.started_at)} · ${c.lodge_name} · ${c.automatic ? 'started by the alert' : 'started by the front desk'}${c.demo ? ' · demo' : ''}`),
              el('div', { class: 'small' }, `${answered} of ${c.asked} accounted for`, c.help ? el('strong', { class: 'warn-text' }, ` · ${c.help} needed help`) : '',
                c.by_sms ? ` · ${c.by_sms} by SMS` : '', c.by_desk ? ` · ${c.by_desk} confirmed by the desk` : '')),
            el('span', { class: `inc-status tone-${c.all_answered_s != null ? 'ok' : c.closed_at ? 'muted' : 'warn'}` },
              c.all_answered_s != null ? `All in ${dur(c.all_answered_s)}` : c.closed_at ? 'Closed' : 'Open'));
        }))
      : el('p', { class: 'muted' }, 'No roll calls in this period. A roll call starts by itself when a high or critical wildlife alert is at a lodge.'));
  }

  function mixPanel(r) {
    const bars = (rows, label) => {
      if (!rows.length) return el('p', { class: 'muted small' }, 'No guests in this period.');
      const max = Math.max(1, ...rows.map((x) => x.people));
      return el('div', { class: 'bar-list' }, rows.map((x) => el('div', { class: 'bar-row compact' },
        el('span', { class: 'strong' }, label(x.key)),
        el('span', { class: 'bar-track' }, sized(el('span', { class: 'bar-fill' }), x.people / max)),
        el('span', { class: 'num strong', title: `${x.n} booking${x.n === 1 ? '' : 's'}` }, String(x.people)))));
    };
    return panel('Guests', 'globe',
      el('h3', { class: 'report-sub' }, 'Languages (people)'), bars(r.mix.language, languageName),
      el('h3', { class: 'report-sub' }, 'Countries'), bars(r.mix.nationality, (k) => k),
      r.lodgeId ? null : el('h3', { class: 'report-sub' }, 'Park areas'), r.lodgeId ? null : bars(r.mix.area, (k) => k),
      r.mix.activity.length ? el('h3', { class: 'report-sub' }, 'Activities checked out') : null,
      r.mix.activity.length ? bars(r.mix.activity, (k) => ACTIVITY[k] || k) : null);
  }

  function toursPanel(r) {
    const head = ['Tour operator', 'Groups', 'Entered the park', 'Face check', 'Badge', 'By radio', 'People declared', 'Back late'];
    return panel('Tour operators', 'users', el('div', { class: 'table-wrap' }, el('table', { class: 'data report-table' },
      el('thead', {}, el('tr', {}, head.map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, r.tours.map((o) => el('tr', {}, el('th', { scope: 'row' }, o.operator),
        [o.groups, o.entered, o.by_face, o.by_badge, o.by_radio, o.declared, o.late].map((v) => el('td', {}, String(v)))))))),
      el('p', { class: 'hint' }, r.lodgeId ? 'Groups that included guests of this lodge.' : 'Groups planned for days in this period (cancelled groups left out).'));
  }

  load();
  return { onParams(p) { if (p.lodge !== undefined && p.lodge !== lodge) { lodge = p.lodge || ''; load(); } } };
}

function fmtDay(d) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function panel(title, iconId, ...children) {
  return el('section', { class: 'panel section' }, el('div', { class: 'panel-head' }, el('h2', {}, icon(iconId), title)), el('div', { class: 'panel-body stack' }, ...children));
}
function fact(label, value) {
  return [el('dt', {}, label), el('dd', {}, String(value ?? '—'))];
}
function tile(iconId, label, value, unit, note, tone = '') {
  return el('div', { class: `tile ${tone ? `is-${tone}` : ''}` }, el('span', { class: 'tile-label' }, icon(iconId, 'icon icon-sm'), label),
    el('span', { class: 'tile-value' }, String(value ?? 0), unit ? el('span', { class: 'unit' }, unit) : null), note ? el('span', { class: 'tile-note' }, note) : null);
}
function sized(n, frac) {
  n.style.width = `${Math.max(2, Math.round(frac * 100))}%`;
  return n;
}
