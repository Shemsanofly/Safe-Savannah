// Tour groups: a tour operator plans groups of registered travellers with a guide. When the guide is
// verified at an attraction gate (or radios in), the group is in the park and its travellers are checked
// out there. Guides see their own groups; admins see every tour operator and can add new ones.
import { api, BOOT, clear, confirmDialog, el, fmtDateTime, fmtTime, icon, initials, lodgeToday, qs, runAction, toast } from '../lib.js';
import { languageName, RISK } from '../status.js';

const ACTIVITY = { game_drive: 'Game drive', walking_safari: 'Walking safari', picnic: 'Picnic', sundowner: 'Sundowner', other: 'Other activity' };
const STATE = {
  planned: ['Planned', 'muted'], in_park: ['In the park', 'warn'], overdue: ['Overdue', 'urgent'], back: ['Back', 'ok'], cancelled: ['Cancelled', 'muted'],
};
const ENTRY = { face: 'face check at the gate', credentials: 'badge and PIN at the gate', manual: 'reported by radio' };
const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
const dayLabel = (day, today) => {
  if (day === today) return 'Today';
  if (day === lodgeToday(1)) return 'Tomorrow';
  if (day === lodgeToday(-1)) return 'Yesterday';
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};

export function mount(main, ctx) {
  const role = BOOT.operator.role;
  const isAdmin = role === 'admin';
  let operator = ctx.params.operator || '';
  let data = null;
  let lastKey = '';
  const head = el('div', { class: 'page-head' });
  const body = el('div', { class: 'desk' }, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'));
  main.append(head, body);

  async function load() {
    try {
      data = await api.get(`/api/tours${qs({ operator })}`);
      if (isAdmin && !operator && data.tourOperators?.length === 1) operator = data.tourOperators[0].id;
      const key = JSON.stringify([data.groups, data.alerts, data.guides, data.tourOperators, operator]);
      if (key !== lastKey) {
        lastKey = key;
        render();
      }
    } catch (err) {
      clear(body, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), el('div', { class: 'grow' }, el('strong', {}, 'Could not load tour groups. '), err.message)));
    }
  }

  function render() {
    const opName = data.operators.find((o) => o.id === operator)?.name ?? data.operators[0]?.name;
    const switcher = isAdmin && data.tourOperators?.length
      ? el('select', { 'aria-label': 'Tour operator', onchange: (e) => ctx.navigate(`#/tours${e.target.value ? `?operator=${encodeURIComponent(e.target.value)}` : ''}`, { replace: true }) },
          el('option', { value: '' }, 'All tour operators'),
          data.tourOperators.map((o) => el('option', { value: o.id, selected: o.id === operator }, o.name)))
      : null;
    const plan = data.canPlan && (!isAdmin || operator)
      ? el('button', { type: 'button', class: 'btn btn-primary', onclick: () => planGroup() }, icon('plus'), el('span', {}, 'Plan a group'))
      : null;
    clear(head,
      el('div', {}, el('h1', {}, role === 'guide' ? 'My groups' : isAdmin ? 'Tour operators' : 'Tour groups'),
        el('p', { class: 'sub' }, isAdmin && !operator ? 'Groups across all tour operators.' : `${opName ?? ''}${role === 'guide' ? ` · ${BOOT.operator.name}` : ''}`)),
      el('div', { class: 'page-actions' }, switcher, plan));
    const today = data.today;
    const now = data.groups.filter((g) => g.day === today || g.status === 'in_park');
    const later = data.groups.filter((g) => g.day > today && g.status !== 'in_park');
    const earlier = data.groups.filter((g) => g.day < today && g.status !== 'in_park');
    clear(body,
      el('div', { class: 'desk-main' },
        data.alerts.length ? alertsPanel() : null,
        groupsPanel('today-title', 'Today', now, 'No groups today.', true),
        later.length ? groupsPanel('later-title', 'Coming up', later, '', false) : null,
        earlier.length ? groupsPanel('earlier-title', 'Earlier', earlier, '', false) : null),
      el('aside', { class: 'desk-side' }, guidesPanel(), isAdmin ? operatorsPanel() : howPanel()));
  }

  // ---------------------------------------------------------------- alerts near groups
  function alertsPanel() {
    return el('section', { class: 'panel desk-attn', 'aria-labelledby': 'ta-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'ta-title' }, icon('incident'), 'Wildlife alerts near your groups'), el('span', { class: 'muted small' }, `${data.alerts.length} open`)),
      el('div', { class: 'panel-body' }, el('ul', { class: 'desk-guests' }, data.alerts.map((a) => {
        const r = RISK[a.risk_level] || RISK.low;
        const near = a.groups.filter((g) => g.same_zone);
        return el('li', { class: `desk-guest st-${near.length ? 'help' : 'pending'}` },
          el('span', { class: 'avatar', 'aria-hidden': 'true' }, icon('paw', 'icon icon-sm')),
          el('div', { class: 'grow' },
            el('strong', {}, a.title || 'Wildlife alert'),
            el('div', { class: 'small muted' }, `${fmtDateTime(a.opened_at)} · `, near.length ? el('strong', {}, `Where ${near.map((g) => g.name).join(', ')} ${near.length === 1 ? 'is' : 'are'}`) : `Same park area as ${a.groups.map((g) => g.name).join(', ')}`)),
          el('span', { class: `inc-status ${r.tone}` }, r.label));
      })),
      el('p', { class: 'hint' }, 'Rangers are handling it. Call your guide on the radio or phone and follow the rangers’ instructions.')));
  }

  // ---------------------------------------------------------------- groups
  function groupsPanel(id, title, list, empty, full) {
    return el('section', { class: 'panel', 'aria-labelledby': id },
      el('div', { class: 'panel-head' }, el('h2', { id }, icon(full ? 'users' : 'calendar'), title), el('span', { class: 'muted small' }, list.length ? `${list.length} group${list.length === 1 ? '' : 's'}` : '')),
      el('div', { class: 'panel-body stack' }, list.length ? list.map((g) => groupCard(g, full)) : el('p', { class: 'muted' }, empty)));
  }

  function groupCard(g, full) {
    const [label, tone] = STATE[g.state] || STATE.planned;
    const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
    const act = (text, cls, fn, success) => {
      const b = el('button', { type: 'button', class: `btn btn-sm ${cls}` }, text);
      b.addEventListener('click', async () => { if (await runAction(b, status, fn, { success })) load(); });
      return b;
    };
    const actions = [];
    if (g.status === 'planned') {
      if (g.day <= data.today) actions.push(el('button', { type: 'button', class: 'btn btn-sm', onclick: () => enterDialog(g) }, icon('map', 'icon icon-sm'), el('span', {}, 'In the park')));
      if (data.canPlan) actions.push(act('Cancel', 'btn-ghost', () => api.post(`/api/tours/groups/${g.id}/cancel`, {}), 'Group cancelled.'));
    }
    if (g.status === 'in_park') actions.push(act('Back out of the park', g.state === 'overdue' ? 'btn-urgent' : '', () => api.post(`/api/tours/groups/${g.id}/back`, {}), `${g.name} is back.`));
    if (data.canPlan && (g.status === 'planned' || g.status === 'in_park')) actions.push(el('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => addTraveller(g) }, icon('plus', 'icon icon-sm'), el('span', {}, 'Traveller')));
    const where = g.entry_zone_name || g.zone_name || g.area_name;
    const lines = [
      `${ACTIVITY[g.kind] || g.kind} · ${where}${g.zone_name || g.entry_zone_name ? ` (${g.area_name})` : ''}`,
      `${dayLabel(g.day, data.today)} · out by ${fmtTime(g.ends_at, false)}${g.guide_name ? ` · guide ${g.guide_name}` : ' · no guide yet'}${isAdmin && !operator ? ` · ${g.operator_name}` : ''}`,
    ];
    const registered = g.members.length;
    const entry = g.entered_at
      ? el('p', { class: 'tour-entry' }, icon(g.entry_method === 'manual' ? 'radio' : 'shield', 'icon icon-sm'),
          el('span', {}, `Entered ${g.entry_zone_name} at ${fmtTime(g.entered_at, false)} · ${ENTRY[g.entry_method] || ''}`,
            g.declared_count != null ? ` · ${people(g.declared_count)} declared, ${registered} registered` : '',
            g.declared_count != null && g.declared_count !== registered ? el('strong', { class: 'tour-mismatch' }, ' — counts differ') : '',
            g.returned_at ? ` · back ${fmtTime(g.returned_at, false)}` : ''))
      : null;
    return el('article', { class: `tour-card is-${g.state}` },
      el('div', { class: 'tour-card-head' },
        el('div', { class: 'grow' }, el('h3', {}, g.name), lines.map((l) => el('p', { class: 'small muted' }, l))),
        el('span', { class: `inc-status tone-${tone}` }, label)),
      entry,
      full || g.status === 'in_park' ? membersList(g) : el('p', { class: 'small muted' }, `${registered} traveller${registered === 1 ? '' : 's'}: ${g.members.map((m) => m.name).join(', ') || 'none yet'}`),
      actions.length ? el('div', { class: 'tour-actions' }, actions, status) : null);
  }

  function membersList(g) {
    if (!g.members.length) return el('p', { class: 'small muted' }, 'No registered travellers yet. Add them by the phone number they used in the Safe Savannah app.');
    return el('ul', { class: 'desk-guestlist tour-members' }, g.members.map((m) => {
      const safety = m.open_sos_id ? ['SOS open', 'urgent'] : m.roll_call === 'help' ? ['Needs help', 'urgent'] : m.roll_call === 'pending' ? ['Roll call: no reply', 'warn'] : m.roll_call === 'safe' ? ['Safe', 'ok'] : null;
      const remove = data.canPlan && g.status === 'planned'
        ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': `Remove ${m.name}` }, icon('x', 'icon icon-sm'))
        : null;
      remove?.addEventListener('click', async () => {
        if (await confirmDialog({ title: `Remove ${m.name}?`, body: 'They stay registered in the app; they are only taken out of this group.', confirmLabel: 'Remove' })) {
          try { await api.post(`/api/tours/groups/${g.id}/members/${m.id}/remove`, {}); load(); } catch (err) { toast(err.message, 'error'); }
        }
      });
      return el('li', {},
        el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(m.name)),
        el('div', { class: 'grow' }, el('strong', {}, m.name),
          el('div', { class: 'small muted' }, [people(m.group_size), languageName(m.language), m.lodge_name].filter(Boolean).join(' · '))),
        safety ? el('span', { class: `inc-status tone-${safety[1]}` }, safety[0]) : null,
        el('a', { class: 'btn btn-sm btn-ghost', href: `tel:${m.phone}`, 'aria-label': `Call ${m.name}` }, icon('phone', 'icon icon-sm')),
        remove);
    }));
  }

  // ---------------------------------------------------------------- side panels
  function guidesPanel() {
    const list = data.guides.filter((g) => !operator || g.tour_operator_id === operator);
    return el('section', { class: 'panel', 'aria-labelledby': 'tg-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'tg-title' }, icon('person'), 'Guides')),
      el('div', { class: 'panel-body' }, list.length
        ? el('ul', { class: 'desk-guestlist' }, list.map((g) => el('li', {},
            el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(g.name)),
            el('div', { class: 'grow' }, el('strong', {}, g.name),
              el('div', { class: 'small muted' }, g.gate_zone_names.length ? `Gate access: ${g.gate_zone_names.join(', ')}` : 'No gate access yet — ask the park admin',
                g.face_enrolled ? ' · face check enrolled' : '')),
            g.phone ? el('a', { class: 'btn btn-sm btn-ghost', href: `tel:${g.phone}`, 'aria-label': `Call ${g.name}` }, icon('phone', 'icon icon-sm')) : null)))
        : el('p', { class: 'muted' }, 'No guide accounts yet. The park admin adds them in Staff management with the role Guide.')));
  }

  function howPanel() {
    return el('section', { class: 'panel', 'aria-labelledby': 'th-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'th-title' }, icon('info'), 'How it works')),
      el('div', { class: 'panel-body' }, el('ol', { class: 'tour-how' },
        el('li', {}, 'Plan the group: guide, place, travellers (by the phone number they registered with).'),
        el('li', {}, 'At the attraction gate the guide is verified by face or badge. The group shows “In the park”.'),
        el('li', {}, 'Rangers see the group on their map and can call the guide. A wildlife alert there is shown here at once.'),
        el('li', {}, 'Mark the group back when it leaves. Groups 30 minutes late turn red.'))));
  }

  function operatorsPanel() {
    const list = data.tourOperators || [];
    const add = el('button', { type: 'button', class: 'btn btn-sm' }, icon('plus', 'icon icon-sm'), el('span', {}, 'Add'));
    add.addEventListener('click', () => addOperator());
    return el('section', { class: 'panel', 'aria-labelledby': 'to-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'to-title' }, icon('globe'), 'Tour operators'), add),
      el('div', { class: 'panel-body' }, list.length
        ? el('ul', { class: 'desk-guestlist' }, list.map((o) => el('li', {},
            el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(o.name)),
            el('div', { class: 'grow' }, el('a', { href: `#/tours?operator=${encodeURIComponent(o.id)}` }, el('strong', {}, o.name)),
              el('div', { class: 'small muted' }, `${o.desks} office · ${o.guides} guide${o.guides === 1 ? '' : 's'} · ${o.groups_30d} groups in 30 days`)))))
        : el('p', { class: 'muted' }, 'No tour operators yet.'),
        el('p', { class: 'hint' }, 'Then add their accounts in Staff management: role Tour operator for the office, Guide for each guide, and give guides gate access.')));
  }

  // ---------------------------------------------------------------- dialogs
  const field = (id, label, control, hint) => el('div', { class: 'field' }, el('label', { for: id }, label), control, hint ? el('p', { class: 'hint' }, hint) : null);

  async function planGroup() {
    const guides = data.guides.filter((g) => !operator || g.tour_operator_id === operator);
    const name = el('input', { id: 'pg-name', required: true, maxlength: 80, placeholder: 'e.g. Becker family walking safari' });
    const guide = el('select', { id: 'pg-guide' }, el('option', { value: '' }, 'Decide later'), guides.map((g) => el('option', { value: g.id }, g.name)));
    const area = el('select', { id: 'pg-area' }, data.areas.map((a) => el('option', { value: a.id }, a.name)));
    const place = el('select', { id: 'pg-place' });
    const fillPlaces = () => clear(place, el('option', { value: '' }, 'Decide at the gate'), (data.places[area.value] || []).map((p) => el('option', { value: String(p.id) }, p.name)));
    area.addEventListener('change', fillPlaces);
    fillPlaces();
    const kind = el('select', { id: 'pg-kind' }, Object.entries(ACTIVITY).map(([v, l]) => el('option', { value: v }, l)));
    const day = el('input', { id: 'pg-day', type: 'date', value: data.today, min: data.today, required: true });
    const back = el('input', { id: 'pg-back', type: 'time', value: '17:30', required: true });
    const phones = el('textarea', { id: 'pg-phones', rows: 3, placeholder: '+255 765 000 201\n+255 765 000 202' });
    const ok = await confirmDialog({
      title: 'Plan a group',
      body: el('div', { class: 'stack' }, field('pg-name', 'Group name', name), field('pg-guide', 'Guide', guide), field('pg-area', 'Park area', area),
        field('pg-place', 'Attraction', place), field('pg-kind', 'Activity', kind),
        el('div', { class: 'grid-2' }, field('pg-day', 'Date', day), field('pg-back', 'Out of the park by', back)),
        field('pg-phones', 'Travellers (optional)', phones, 'One phone number per line, as they registered in the Safe Savannah app. They see the group and their guide in the app, and can leave it.')),
      confirmLabel: 'Plan group',
    });
    if (!ok) return;
    try {
      const r = await api.post(`/api/tours/groups${qs({ operator })}`, {
        name: name.value.trim(), guide_id: guide.value || null, area_id: area.value, zone_id: place.value ? Number(place.value) : null, kind: kind.value,
        day: day.value, back_by: back.value, members: phones.value.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean),
      });
      toast(r.missing.length ? `Group planned. Not registered yet: ${r.missing.join(', ')}` : 'Group planned.', r.missing.length ? 'error' : undefined);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function addTraveller(g) {
    const phone = el('input', { id: 'at-phone', type: 'tel', autocomplete: 'off', placeholder: '+255 765 000 201', required: true });
    const ok = await confirmDialog({ title: `Add a traveller to ${g.name}`, body: el('div', { class: 'stack' }, field('at-phone', 'Phone number', phone, 'The number they registered with in the Safe Savannah app.')), confirmLabel: 'Add' });
    if (!ok) return;
    try {
      await api.post(`/api/tours/groups/${g.id}/members${qs({ operator })}`, { phone: phone.value });
      toast('Traveller added.');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function enterDialog(g) {
    const places = data.places[g.area_id] || [];
    const place = el('select', { id: 'en-place' }, places.map((p) => el('option', { value: String(p.id), selected: p.id === g.zone_id }, p.name)));
    const count = el('input', { id: 'en-count', type: 'number', min: 0, max: 60, value: String(Math.max(g.members.length, 1)) });
    if (!places.length) {
      await confirmDialog({ title: 'In the park', body: 'No attractions are set up in this area yet.', confirmLabel: 'OK' });
      return;
    }
    const ok = await confirmDialog({
      title: `${g.name} is in the park`,
      body: el('div', { class: 'stack' }, el('p', {}, 'Use this when the gate has no camera and the guide reports in by radio. A verified gate entry does this by itself.'),
        field('en-place', 'Where', place), field('en-count', 'Tourists with the guide', count)),
      confirmLabel: 'Record entry',
    });
    if (!ok) return;
    try {
      await api.post(`/api/tours/groups/${g.id}/enter${qs({ operator })}`, { zone_id: Number(place.value), declared: Number(count.value) });
      toast('Entry recorded.');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function addOperator() {
    const name = el('input', { id: 'ao-name', required: true, maxlength: 80, placeholder: 'e.g. Kilima Safaris' });
    const id = el('input', { id: 'ao-id', required: true, maxlength: 40, placeholder: 'kilima-safaris' });
    const phone = el('input', { id: 'ao-phone', type: 'tel', placeholder: '+255 …' });
    name.addEventListener('input', () => { if (!id.dataset.touched) id.value = name.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40); });
    id.addEventListener('input', () => { id.dataset.touched = '1'; });
    const ok = await confirmDialog({ title: 'Add a tour operator', body: el('div', { class: 'stack' }, field('ao-name', 'Name', name), field('ao-id', 'ID', id, 'Lowercase letters, numbers and dashes.'), field('ao-phone', 'Office phone (optional)', phone)), confirmLabel: 'Add' });
    if (!ok) return;
    try {
      const r = await api.post('/api/tours/operators', { id: id.value, name: name.value, phone: phone.value || null });
      toast(`${r.operator.name} added. Now add their accounts in Staff management.`);
      ctx.navigate(`#/tours?operator=${encodeURIComponent(r.operator.id)}`, { replace: true });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  load();
  const timer = setInterval(() => !document.hidden && load(), 5000);
  return {
    onParams(p) { operator = p.operator || ''; lastKey = ''; load(); },
    destroy() { clearInterval(timer); },
  };
}
