// People: rangers and admins (alert routing, roles, PINs) and tourist accounts. Admins only.
import { api, BOOT, clear, confirmDialog, el, fmtDate, icon, initials, lodgeToday, runAction, toast, validateRequired } from '../lib.js';
import { languageName } from '../status.js';

export function mount(main, ctx) {
  if (BOOT.operator.role !== 'admin') { main.append(el('p', { role: 'alert' }, 'Only admins can add or manage staff.')); return {}; }
  let tab = ctx.touristOnly || ctx.params.tab === 'tourists' ? 'tourists' : 'staff';
  let areas = [];
  const tabs = el('div', { class: 'seg', role: 'group', 'aria-label': 'Section' });
  const body = el('div', { class: 'stack' });
  main.append(el('div', { class: 'page-head' }, el('div', {}, el(ctx.embedded ? 'h2' : 'h1', {}, ctx.staffOnly ? 'Staff accounts' : ctx.touristOnly ? 'Traveller accounts' : 'People'), el('p', { class: 'sub' }, ctx.staffOnly ? 'Only admins can create staff accounts. Add a reference photo and gate permission below.' : 'Registered staff and travellers.')), ctx.staffOnly || ctx.touristOnly ? null : tabs), body);

  const renderTabs = () => clear(tabs, [['staff', 'Rangers & admins'], ['tourists', 'Tourists']].map(([v, l]) =>
    el('button', { type: 'button', 'aria-pressed': String(tab === v), onclick: () => { tab = v; ctx.navigate(`#/people?tab=${v}`, { replace: true }); } }, l)));

  async function load() {
    renderTabs();
    if (!areas.length) areas = (await api.get('/api/areas').catch(() => ({ areas: [] }))).areas;
    if (!lodges.length) lodges = (await api.get('/api/lodges').catch(() => ({ lodges: [] }))).lodges.filter((l) => l.active);
    if (!tourOps.length) tourOps = (await api.get('/api/tours/operators').catch(() => ({ operators: [] }))).operators.filter((o) => o.active);
    clear(body, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'));
    try {
      if (tab === 'staff') renderStaff((await api.get('/api/operators')).operators);
      else await loadTourists();
    } catch (err) {
      clear(body, el('div', { class: 'alert alert-error' }, icon('alert'), err.message));
    }
  }
  let lodges = [];
  let tourOps = [];
  const TOURING = ['agency', 'guide'];
  const tourOpName = (id) => tourOps.find((o) => o.id === id)?.name || 'No tour operator';
  const areaName = (id) => areas.find((a) => a.id === id)?.name || 'All areas';
  const lodgeName = (id) => lodges.find((l) => l.id === id)?.name || 'No lodge';
  const ROLE_LABEL = { ranger: 'Ranger', admin: 'Admin', host: 'Front desk', agency: 'Tour operator', guide: 'Guide' };
  const roleSelect = (id, value, disabled) => {
    const s = el('select', { id, disabled }, Object.entries(ROLE_LABEL).map(([v, l]) => el('option', { value: v }, l)));
    s.value = value;
    return s;
  };
  const lodgeSelect = (id, value) => {
    const s = el('select', { id }, el('option', { value: '' }, 'Choose a lodge…'), lodges.map((l) => el('option', { value: l.id }, l.name)));
    s.value = value || '';
    return s;
  };
  const tourSelect = (id, value) => {
    const s = el('select', { id }, el('option', { value: '' }, 'Choose a tour operator…'), tourOps.map((o) => el('option', { value: o.id }, o.name)));
    s.value = value || '';
    return s;
  };
  const areaSelect = (id, value, label) => {
    const s = el('select', { id, 'aria-label': label }, el('option', { value: '' }, 'All areas'), areas.map((a) => el('option', { value: a.id }, a.name)));
    s.value = value || '';
    return s;
  };
  const f = (i, l, c, h) => el('div', { class: 'field' }, el('label', { for: i }, l), c, h ? el('span', { class: 'hint' }, h) : null);

  // ---------------------------------------------------------------- staff
  function renderStaff(ops) {
    const sorted = [...ops].sort((a, b) => Number(b.active) - Number(a.active) || Number(b.on_duty) - Number(a.on_duty) || a.name.localeCompare(b.name));
    const onDuty = ops.filter((o) => o.active && o.on_duty).length;
    clear(body,
      el('p', { class: 'muted small' }, `${ops.filter((o) => o.active).length} active · ${onDuty} on duty. On-duty rangers are alerted about incidents in their area.`),
      el('ul', { class: 'person-list' }, sorted.map(staffRow)),
      addStaffForm());
  }

  function staffRow(o) {
    const self = o.id === BOOT.operator.id;
    const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
    const edit = el('button', { type: 'button', class: 'btn btn-sm' }, icon('settings', 'icon icon-sm'), el('span', {}, 'Edit'));
    edit.addEventListener('click', () => editStaff(o, status));
    const pin = el('button', { type: 'button', class: 'menu-item' }, icon('key', 'icon icon-sm'), 'Reset PIN');
    pin.addEventListener('click', () => { menu.open = false; resetPin(o, status); });
    const toggle = el('button', { type: 'button', class: 'menu-item', disabled: self }, icon(o.active ? 'x' : 'check', 'icon icon-sm'), o.active ? 'Deactivate' : 'Reactivate');
    toggle.addEventListener('click', async () => {
      menu.open = false;
      if (!(await confirmDialog({ title: `${o.active ? 'Deactivate' : 'Reactivate'} ${o.name}?`, body: o.active ? 'They are signed out and stop receiving alerts. History is kept.' : 'They can sign in again.', confirmLabel: o.active ? 'Deactivate' : 'Reactivate', tone: o.active ? 'urgent' : 'primary' }))) return;
      if (await runAction(null, status, () => api.patch(`/api/operators/${encodeURIComponent(o.id)}`, { active: !o.active }), { success: `${o.name} ${o.active ? 'deactivated' : 'reactivated'}.` })) load();
    });
    const menu = el('details', { class: 'row-menu' }, el('summary', { 'aria-label': `More actions for ${o.name}` }, icon('chevron-down', 'icon icon-sm')), el('div', { class: 'row-menu-panel' }, pin, toggle));
    const duty = !o.active ? ['Deactivated', 'muted'] : o.on_duty ? ['On duty', 'ok'] : ['Off duty', 'muted'];
    return el('li', { class: `person-row${o.active ? '' : ' is-off'}` },
      el('span', { class: `avatar${o.role === 'admin' ? ' is-admin' : ''}`, 'aria-hidden': 'true' }, initials(o.name)),
      el('div', { class: 'person-main' },
        el('div', { class: 'person-name' }, el('strong', {}, o.name), self ? el('span', { class: 'muted small' }, '(you)') : null, o.demo ? el('span', { class: 'inc-tag small' }, 'Demo') : null),
        o.role === 'host'
          ? el('div', { class: 'person-sub' }, el('span', {}, 'Front desk'), el('span', {}, lodgeName(o.lodge_id)))
          : TOURING.includes(o.role)
          ? el('div', { class: 'person-sub' }, el('span', {}, ROLE_LABEL[o.role]), el('span', {}, tourOpName(o.tour_operator_id)), o.phone ? el('a', { href: `tel:${o.phone}` }, o.phone) : null)
          : el('div', { class: 'person-sub' }, el('span', {}, ROLE_LABEL[o.role] || o.role), el('span', {}, areaName(o.area_id)),
            o.phone ? el('a', { href: `tel:${o.phone}` }, o.phone) : el('span', { class: 'warn-text' }, 'No phone'))),
      el('span', { class: `person-pill tone-${duty[1]}` }, (o.role === 'host' || TOURING.includes(o.role)) && o.active ? ROLE_LABEL[o.role] : duty[0]),
      el('div', { class: 'person-actions' }, o.role === 'host' || o.role === 'agency' ? null : el('a', { class: 'btn btn-sm', href: `#/staff?staff=${encodeURIComponent(o.id)}` }, 'Reference photo'), edit, menu),
      status);
  }

  async function editStaff(o, status) {
    const self = o.id === BOOT.operator.id;
    const role = roleSelect('es-role', o.role, self);
    const lodge = lodgeSelect('es-lodge', o.lodge_id);
    const lodgeField = f('es-lodge', 'Lodge', lodge, 'Front-desk accounts see only this lodge.');
    const tour = tourSelect('es-tour', o.tour_operator_id);
    const tourField = f('es-tour', 'Tour operator', tour, 'Tour operator and guide accounts see only this company’s groups.');
    const phone = el('input', { id: 'es-phone', type: 'tel', inputmode: 'tel', value: o.phone || '', placeholder: '+255…' });
    const area = areaSelect('es-area', o.area_id, 'Area');
    const duty = el('input', { type: 'checkbox', id: 'es-duty', checked: o.on_duty });
    const phoneField = f('es-phone', 'Phone', phone, 'Rangers: alerts are sent here while on duty. Guides: rangers call this number.');
    const rangerFields = el('div', { class: 'stack' },
      f('es-area', 'Area', area, 'Alerts for this area only, or all areas.'),
      el('label', { class: 't-switch' }, duty, el('span', { class: 't-switch-track', 'aria-hidden': 'true' }), el('span', {}, 'On duty')));
    const sync = () => {
      lodgeField.hidden = role.value !== 'host';
      tourField.hidden = !TOURING.includes(role.value);
      phoneField.hidden = role.value === 'host' || role.value === 'agency';
      rangerFields.hidden = role.value !== 'ranger' && role.value !== 'admin';
    };
    role.addEventListener('change', sync);
    sync();
    const ok = await confirmDialog({
      title: `Edit ${o.name}`,
      body: el('div', { class: 'stack' },
        f('es-role', 'Role', role, self ? 'You cannot change your own role.' : 'Changing the role signs them out.'),
        lodgeField, tourField, phoneField,
        rangerFields),
      confirmLabel: 'Save changes',
    });
    if (!ok) return;
    if (role.value === 'host' && !lodge.value) {
      toast('Choose the lodge for a front-desk account. Nothing changed.', 'error');
      return;
    }
    if (TOURING.includes(role.value) && !tour.value) {
      toast('Choose the tour operator for this account. Nothing changed.', 'error');
      return;
    }
    const done = await runAction(null, status, async () => {
      await api.patch(`/api/rangers/${encodeURIComponent(o.id)}/contact`, role.value === 'host'
        ? { lodge_id: lodge.value, on_duty: false }
        : TOURING.includes(role.value)
        ? { tour_operator_id: tour.value, on_duty: false, ...(role.value === 'guide' ? { phone: phone.value.trim() || null } : {}) }
        : { phone: phone.value.trim() || null, area_id: area.value || null, on_duty: duty.checked });
      if (!self && role.value !== o.role) await api.patch(`/api/operators/${encodeURIComponent(o.id)}`, { role: role.value });
    }, { success: `${o.name} updated.` });
    if (done) load();
  }

  async function resetPin(o, status) {
    const input = el('input', { id: 'np', type: 'password', inputmode: 'numeric', maxlength: '12', autocomplete: 'new-password' });
    if (!(await confirmDialog({ title: `New PIN for ${o.name}`, body: el('div', { class: 'field' }, el('label', { for: 'np' }, 'New PIN (4–12 digits)'), input, el('p', { class: 'hint' }, 'They are signed out everywhere.')), confirmLabel: 'Reset PIN' }))) return;
    if (!/^\d{4,12}$/.test(input.value.trim())) {
      toast('PIN must be 4–12 digits. Nothing changed.', 'error');
      return;
    }
    await runAction(null, status, () => api.post(`/api/operators/${encodeURIComponent(o.id)}/pin`, { pin: input.value.trim() }), { success: `PIN reset for ${o.name}.` });
  }

  function addStaffForm() {
    const name = el('input', { id: 'ns-name', maxlength: '60', autocomplete: 'off' });
    const id = el('input', { id: 'ns-id', maxlength: '32', autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false' });
    const pin = el('input', { id: 'ns-pin', type: 'password', inputmode: 'numeric', maxlength: '12', autocomplete: 'new-password' });
    const phone = el('input', { id: 'ns-phone', type: 'tel', inputmode: 'tel', placeholder: '+255…' });
    const area = areaSelect('ns-area', '', 'Area');
    const role = roleSelect('ns-role', 'ranger', false);
    const lodge = lodgeSelect('ns-lodge', '');
    const lodgeField = f('ns-lodge', 'Lodge', lodge, 'Front desk only');
    const tour = tourSelect('ns-tour', '');
    const tourField = f('ns-tour', 'Tour operator', tour, 'Tour operator and guide accounts');
    const err = el('p', { class: 'field-error', hidden: true, role: 'alert' });
    const btn = el('button', { type: 'submit', class: 'btn btn-primary' }, icon('plus'), el('span', {}, 'Add person'));
    const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
    const form = el('form', { class: 'add-form', novalidate: true },
      el('div', { class: 'form-grid' },
        f('ns-name', 'Full name', name), f('ns-id', 'Sign-in ID', id, 'Letters, digits, - or _'), f('ns-pin', 'Starting PIN', pin, '4–12 digits'),
        f('ns-role', 'Role', role), lodgeField, tourField, f('ns-phone', 'Phone', phone, 'Optional'), f('ns-area', 'Area', area)),
      err, el('div', { class: 'form-actions' }, btn, status));
    const syncRole = () => { lodgeField.hidden = role.value !== 'host'; tourField.hidden = !TOURING.includes(role.value); };
    role.addEventListener('change', syncRole);
    syncRole();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!validateRequired(name, err, 'Enter a name.') || !validateRequired(id, err, 'Choose a sign-in ID.') || !validateRequired(pin, err, 'Set a starting PIN.')) return;
      if (!/^\d{4,12}$/.test(pin.value.trim())) { err.hidden = false; clear(err, icon('alert', 'icon icon-sm'), 'PIN must be 4–12 digits.'); return; }
      if (role.value === 'host' && !lodge.value) { err.hidden = false; clear(err, icon('alert', 'icon icon-sm'), 'Choose the lodge for this front-desk account.'); lodge.focus(); return; }
      if (TOURING.includes(role.value) && !tour.value) { err.hidden = false; clear(err, icon('alert', 'icon icon-sm'), 'Choose the tour operator for this account.'); tour.focus(); return; }
      if (await runAction(btn, status, () => api.post('/api/rangers', { id: id.value.trim(), name: name.value.trim(), pin: pin.value.trim(), role: role.value, phone: phone.value.trim() || null, area_id: area.value || null, lodge_id: role.value === 'host' ? lodge.value : null, tour_operator_id: TOURING.includes(role.value) ? tour.value : null }), { success: `${name.value.trim()} added.` })) load();
    });
    return el('details', { class: 'panel add-panel' },
      el('summary', { class: 'panel-head' }, el('h2', {}, icon('plus'), 'Add a ranger, admin, front desk, tour operator or guide'), icon('chevron-down', 'icon icon-sm t-caret')),
      el('div', { class: 'panel-body' }, form));
  }

  // ---------------------------------------------------------------- tourists
  async function loadTourists() {
    const search = el('input', { type: 'search', id: 'tq', placeholder: 'Search name, phone or lodge', 'aria-label': 'Search tourists' });
    const area = areaSelect('ta', '', 'Destination');
    const trip = el('input', { type: 'checkbox', id: 'tt' });
    const results = el('div', {});
    const count = el('p', { class: 'muted small' });
    const today = lodgeToday();
    const tripState = (t) => (!t.active ? ['Deactivated', 'muted'] : t.trip_start > today ? ['Upcoming', 'warn'] : t.trip_end < today ? ['Trip ended', 'muted'] : ['On trip', 'ok']);
    const refresh = async () => {
      const r = await api.get(`/api/tourists?q=${encodeURIComponent(search.value.trim())}&area=${encodeURIComponent(area.value)}&onTrip=${trip.checked ? 1 : 0}`);
      const list = [...r.tourists].sort((a, b) => Number(b.active) - Number(a.active));
      count.textContent = `${list.length} traveller${list.length === 1 ? '' : 's'}${list.length ? ` · ${list.filter((t) => tripState(t)[0] === 'On trip').length} on trip today` : ''}`;
      if (!list.length) return clear(results, el('div', { class: 'panel' }, el('div', { class: 'empty' }, icon('users'), el('strong', {}, 'No tourists match'), el('p', {}, 'Tourists register themselves in the traveller app at /t.'))));
      const actions = (t) => {
        const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
        const btn = el('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, t.active ? 'Deactivate' : 'Reactivate');
        btn.addEventListener('click', async () => {
          if (!(await confirmDialog({ title: `${t.active ? 'Deactivate' : 'Reactivate'} ${t.name}?`, body: t.active ? 'They are signed out and stop receiving alerts.' : 'They can sign in and receive alerts again.', confirmLabel: t.active ? 'Deactivate' : 'Reactivate', tone: t.active ? 'urgent' : 'primary' }))) return;
          if (await runAction(btn, status, () => api.patch(`/api/tourists/${t.id}`, { active: !t.active }), { success: `${t.name} ${t.active ? 'deactivated' : 'reactivated'}.` })) refresh();
        });
        return [t.sos_count ? el('a', { class: 'btn btn-sm', href: `#/incidents?kind=sos&q=${encodeURIComponent(t.phone)}` }, icon('siren', 'icon icon-sm'), `${t.sos_count} SOS`) : null, btn, status];
      };
      const short = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      const tripText = (t) => `${short(t.trip_start)} – ${short(t.trip_end)} · ${t.group_size} ${t.group_size === 1 ? 'person' : 'people'} · ${languageName(t.language)}`;
      const cards = el('ul', { class: 'person-list inc-list' }, list.map((t) => {
        const st = tripState(t);
        return el('li', { class: `person-row${t.active ? '' : ' is-off'}` },
          el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(t.name)),
          el('div', { class: 'person-main' },
            el('div', { class: 'person-name' }, el('strong', {}, t.name), t.demo ? el('span', { class: 'inc-tag small' }, 'Demo') : null),
            el('div', { class: 'person-sub' }, el('a', { href: `tel:${t.phone}` }, t.phone), el('span', {}, [areaName(t.area_id), t.lodge].filter(Boolean).join(' · '))),
            el('div', { class: 'person-sub' }, el('span', {}, tripText(t)))),
          el('span', { class: `person-pill tone-${st[1]}` }, st[0]),
          el('div', { class: 'person-actions' }, actions(t)));
      }));
      const table = el('div', { class: 'table-wrap inc-table' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ['Traveller', 'Destination', 'Trip', 'Status', ''].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, list.map((t) => {
          const st = tripState(t);
          return el('tr', { class: t.active ? null : 'muted' },
            el('td', {}, el('div', { class: 'cell-stack' }, el('strong', {}, t.name, t.demo ? el('span', { class: 'inc-tag small' }, ' Demo') : null), el('a', { href: `tel:${t.phone}`, class: 'small' }, t.phone))),
            el('td', {}, el('div', { class: 'cell-stack' }, areaName(t.area_id), el('span', { class: 'small muted' }, t.lodge || ''))),
            el('td', {}, el('div', { class: 'cell-stack' }, `${fmtDate(t.trip_start)} – ${fmtDate(t.trip_end)}`, el('span', { class: 'small muted' }, `${t.group_size} ${t.group_size === 1 ? 'person' : 'people'} · ${languageName(t.language)}${t.sms_alerts ? '' : ' · SMS off'}`))),
            el('td', {}, el('span', { class: `person-pill tone-${st[1]}` }, st[0])),
            el('td', {}, el('div', { class: 'row end' }, actions(t))));
        }))));
      clear(results, cards, table);
    };
    for (const c of [area, trip]) c.addEventListener('change', refresh);
    let t;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(refresh, 300); });
    clear(body,
      el('div', { class: 'filters' },
        el('div', { class: 'input-icon' }, icon('search'), search),
        el('div', { class: 'filters-row' }, el('div', { class: 'field' }, el('label', { for: 'ta' }, 'Destination'), area),
          el('label', { class: 't-switch' }, trip, el('span', { class: 't-switch-track', 'aria-hidden': 'true' }), el('span', {}, 'On trip today')))),
      count, results);
    await refresh();
  }

  load();
  return { refresh: load, onParams(p) { tab = ctx.touristOnly || p.tab === 'tourists' ? 'tourists' : 'staff'; load(); } };
}
