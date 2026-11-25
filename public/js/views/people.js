// People: rangers and admins (alert routing, roles, PINs) and tourist accounts. Admins only.
import { api, BOOT, clear, confirmDialog, el, fmtDate, icon, initials, lodgeToday, runAction, toast, validateRequired } from '../lib.js';

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
    clear(body, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'));
    try {
      if (tab === 'staff') renderStaff((await api.get('/api/operators')).operators);
      else await loadTourists();
    } catch (err) {
      clear(body, el('div', { class: 'alert alert-error' }, icon('alert'), err.message));
    }
  }
  const areaName = (id) => areas.find((a) => a.id === id)?.name || 'All areas';
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
        el('div', { class: 'person-sub' }, el('span', {}, o.role === 'admin' ? 'Admin' : 'Ranger'), el('span', {}, areaName(o.area_id)),
          o.phone ? el('a', { href: `tel:${o.phone}` }, o.phone) : el('span', { class: 'warn-text' }, 'No phone'))),
      el('span', { class: `person-pill tone-${duty[1]}` }, duty[0]),
      el('div', { class: 'person-actions' }, el('a', { class: 'btn btn-sm', href: `#/staff?staff=${encodeURIComponent(o.id)}` }, 'Reference photo'), edit, menu),
      status);
  }

  async function editStaff(o, status) {
    const self = o.id === BOOT.operator.id;
    const role = el('select', { id: 'es-role', disabled: self }, el('option', { value: 'ranger' }, 'Ranger'), el('option', { value: 'admin' }, 'Admin'));
    role.value = o.role;
    const phone = el('input', { id: 'es-phone', type: 'tel', inputmode: 'tel', value: o.phone || '', placeholder: '+255…' });
    const area = areaSelect('es-area', o.area_id, 'Area');
    const duty = el('input', { type: 'checkbox', id: 'es-duty', checked: o.on_duty });
    const ok = await confirmDialog({
      title: `Edit ${o.name}`,
      body: el('div', { class: 'stack' },
        f('es-role', 'Role', role, self ? 'You cannot change your own role.' : 'Changing the role signs them out.'),
        f('es-phone', 'Phone for alerts', phone, 'Alerts are sent here while on duty.'),
        f('es-area', 'Area', area, 'Alerts for this area only, or all areas.'),
        el('label', { class: 't-switch' }, duty, el('span', { class: 't-switch-track', 'aria-hidden': 'true' }), el('span', {}, 'On duty'))),
      confirmLabel: 'Save changes',
    });
    if (!ok) return;
    const done = await runAction(null, status, async () => {
      await api.patch(`/api/rangers/${encodeURIComponent(o.id)}/contact`, { phone: phone.value.trim() || null, area_id: area.value || null, on_duty: duty.checked });
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
    const role = el('select', { id: 'ns-role' }, el('option', { value: 'ranger' }, 'Ranger'), el('option', { value: 'admin' }, 'Admin'));
    const err = el('p', { class: 'field-error', hidden: true, role: 'alert' });
    const btn = el('button', { type: 'submit', class: 'btn btn-primary' }, icon('plus'), el('span', {}, 'Add person'));
    const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
    const form = el('form', { class: 'add-form', novalidate: true },
      el('div', { class: 'form-grid' },
        f('ns-name', 'Full name', name), f('ns-id', 'Sign-in ID', id, 'Letters, digits, - or _'), f('ns-pin', 'Starting PIN', pin, '4–12 digits'),
        f('ns-phone', 'Phone for alerts', phone, 'Optional'), f('ns-area', 'Area', area), f('ns-role', 'Role', role)),
      err, el('div', { class: 'form-actions' }, btn, status));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!validateRequired(name, err, 'Enter a name.') || !validateRequired(id, err, 'Choose a sign-in ID.') || !validateRequired(pin, err, 'Set a starting PIN.')) return;
      if (!/^\d{4,12}$/.test(pin.value.trim())) { err.hidden = false; clear(err, icon('alert', 'icon icon-sm'), 'PIN must be 4–12 digits.'); return; }
      if (await runAction(btn, status, () => api.post('/api/rangers', { id: id.value.trim(), name: name.value.trim(), pin: pin.value.trim(), role: role.value, phone: phone.value.trim() || null, area_id: area.value || null }), { success: `${name.value.trim()} added.` })) load();
    });
    return el('details', { class: 'panel add-panel' },
      el('summary', { class: 'panel-head' }, el('h2', {}, icon('plus'), 'Add a ranger or admin'), icon('chevron-down', 'icon icon-sm t-caret')),
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
      const tripText = (t) => `${short(t.trip_start)} – ${short(t.trip_end)} · ${t.group_size} ${t.group_size === 1 ? 'person' : 'people'} · ${t.language === 'sw' ? 'Kiswahili' : 'English'}`;
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
            el('td', {}, el('div', { class: 'cell-stack' }, `${fmtDate(t.trip_start)} – ${fmtDate(t.trip_end)}`, el('span', { class: 'small muted' }, `${t.group_size} ${t.group_size === 1 ? 'person' : 'people'} · ${t.language === 'sw' ? 'Kiswahili' : 'English'}${t.sms_alerts ? '' : ' · SMS off'}`))),
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
