// People: rangers and admins (routing details, roles, PINs) and tourist accounts. Admins only.
import { api, BOOT, clear, confirmDialog, el, fmtDate, icon, runAction, validateRequired } from '../lib.js';
import { demoBadge } from '../status.js';

export function mount(main, ctx) {
  let tab = ctx.params.tab === 'tourists' ? 'tourists' : 'staff';
  let areas = [];
  const tabs = el('div', { class: 'seg', role: 'group', 'aria-label': 'Section' });
  const body = el('div', {});
  main.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'People'), el('p', { class: 'sub' }, 'Rangers and registered tourists.')), tabs), body);

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

  function renderStaff(ops) {
    const rows = ops.map((o) => {
      const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
      const self = o.id === BOOT.operator.id;
      const phone = el('input', { value: o.phone || '', 'aria-label': `Phone for ${o.name}`, placeholder: '+255…', inputmode: 'tel' });
      const area = areaSelect(`area-${o.id}`, o.area_id, `Area for ${o.name}`);
      const duty = el('input', { type: 'checkbox', checked: o.on_duty, 'aria-label': `${o.name} on duty` });
      const saveContact = el('button', { type: 'button', class: 'btn btn-sm' }, 'Save');
      saveContact.addEventListener('click', () => runAction(saveContact, status, () => api.patch(`/api/rangers/${encodeURIComponent(o.id)}/contact`, { phone: phone.value.trim() || null, area_id: area.value || null, on_duty: duty.checked }), { success: `${o.name} updated.` }));
      const role = el('select', { 'aria-label': `Role for ${o.name}`, disabled: self }, el('option', { value: 'ranger' }, 'Ranger'), el('option', { value: 'admin' }, 'Admin'));
      role.value = o.role;
      role.addEventListener('change', async () => {
        if (!(await confirmDialog({ title: `Make ${o.name} ${role.value === 'admin' ? 'an admin' : 'a ranger'}?`, body: 'They will need to sign in again.', confirmLabel: 'Change role' }))) { role.value = o.role; return; }
        role.disabled = true;
        const r = await runAction(null, status, () => api.patch(`/api/operators/${encodeURIComponent(o.id)}`, { role: role.value }), { success: 'Role changed.' });
        if (!r) role.value = o.role;
        role.disabled = false;
      });
      const active = el('button', { type: 'button', class: 'btn btn-sm', disabled: self }, o.active ? 'Deactivate' : 'Reactivate');
      active.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `${o.active ? 'Deactivate' : 'Reactivate'} ${o.name}?`, body: o.active ? 'They are signed out and stop receiving alerts. History is kept.' : 'They can sign in again.', confirmLabel: o.active ? 'Deactivate' : 'Reactivate', tone: o.active ? 'urgent' : 'primary' }))) return;
        if (await runAction(active, status, () => api.patch(`/api/operators/${encodeURIComponent(o.id)}`, { active: !o.active }), { success: 'Updated.' })) load();
      });
      const pin = el('button', { type: 'button', class: 'btn btn-sm' }, icon('key', 'icon icon-sm'), 'Reset PIN');
      pin.addEventListener('click', async () => {
        const input = el('input', { id: 'np', type: 'password', inputmode: 'numeric', maxlength: '12' });
        if (!(await confirmDialog({ title: `New PIN for ${o.name}`, body: el('div', { class: 'field' }, el('label', { for: 'np' }, 'New PIN (4–12 digits)'), input, el('p', { class: 'hint' }, 'They are signed out everywhere.')), confirmLabel: 'Reset PIN' }))) return;
        if (!/^\d{4,12}$/.test(input.value.trim())) { status.className = 'form-status is-err'; clear(status, 'PIN must be 4–12 digits. Nothing changed.'); return; }
        await runAction(null, status, () => api.post(`/api/operators/${encodeURIComponent(o.id)}/pin`, { pin: input.value.trim() }), { success: 'PIN reset.' });
      });
      return el('tr', { class: o.active ? null : 'muted' },
        el('td', { 'data-label': 'Name' }, el('div', { class: 'cell-stack' }, el('strong', {}, o.name), el('span', { class: 'small muted' }, `${o.id}${self ? ' (you)' : ''}`), o.demo ? demoBadge() : null)),
        el('td', { 'data-label': 'Role' }, role),
        el('td', { 'data-label': 'Alert routing' }, el('div', { class: 'stack' }, phone, area, el('label', { class: 'duty-toggle' }, duty, el('span', {}, 'On duty')), saveContact)),
        el('td', { 'data-label': 'Status' }, el('span', { class: `badge ${o.active ? 'tone-ok' : 'tone-muted'}` }, o.active ? 'Active' : 'Deactivated')),
        el('td', { 'data-label': 'Actions' }, el('div', { class: 'row' }, pin, active, status)));
    });
    clear(body,
      el('p', { class: 'hint' }, 'On-duty rangers are alerted about incidents in their area.'),
      el('div', { class: 'table-wrap section' }, el('table', { class: 'data table-cards' },
        el('thead', {}, el('tr', {}, ['Name', 'Role', 'Alert routing', 'Status', 'Actions'].map((h) => el('th', { scope: 'col' }, h)))), el('tbody', {}, rows))),
      addStaffForm());
  }

  function addStaffForm() {
    const name = el('input', { id: 'ns-name', maxlength: '60' });
    const id = el('input', { id: 'ns-id', maxlength: '32', autocapitalize: 'none' });
    const pin = el('input', { id: 'ns-pin', type: 'password', inputmode: 'numeric', maxlength: '12' });
    const phone = el('input', { id: 'ns-phone', inputmode: 'tel', placeholder: '+255…' });
    const area = areaSelect('ns-area', '', 'Area');
    const role = el('select', { id: 'ns-role' }, el('option', { value: 'ranger' }, 'Ranger'), el('option', { value: 'admin' }, 'Admin'));
    const err = el('p', { class: 'field-error', hidden: true, role: 'alert' });
    const btn = el('button', { type: 'submit', class: 'btn btn-primary' }, icon('plus'), el('span', {}, 'Add person'));
    const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
    const f = (i, l, c, h) => el('div', { class: 'field' }, el('label', { for: i }, l), c, h ? el('span', { class: 'hint' }, h) : null);
    const form = el('form', { class: 'panel section', novalidate: true }, el('div', { class: 'panel-head' }, el('h2', {}, icon('user'), 'Add a ranger or admin')),
      el('div', { class: 'panel-body stack' }, el('div', { class: 'filters-row align-start' },
        f('ns-name', 'Full name', name), f('ns-id', 'Sign-in ID', id, 'letters, digits, - or _'), f('ns-pin', 'Starting PIN', pin, '4–12 digits'),
        f('ns-phone', 'Phone for alerts', phone, 'Optional'), f('ns-area', 'Area', area), f('ns-role', 'Role', role)), err, el('div', { class: 'form-actions' }, btn, status)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!validateRequired(name, err, 'Enter a name.') || !validateRequired(id, err, 'Choose a sign-in ID.') || !validateRequired(pin, err, 'Set a starting PIN.')) return;
      if (!/^\d{4,12}$/.test(pin.value.trim())) { err.hidden = false; clear(err, icon('alert', 'icon icon-sm'), 'PIN must be 4–12 digits.'); return; }
      if (await runAction(btn, status, () => api.post('/api/rangers', { id: id.value.trim(), name: name.value.trim(), pin: pin.value.trim(), role: role.value, phone: phone.value.trim() || null, area_id: area.value || null }), { success: `${name.value.trim()} added.` })) load();
    });
    return form;
  }

  async function loadTourists(q = '', areaId = '', onTrip = false) {
    const search = el('input', { type: 'search', id: 'tq', value: q, placeholder: 'Name, phone or lodge' });
    const area = areaSelect('ta', areaId, 'Area');
    const trip = el('input', { type: 'checkbox', checked: onTrip, id: 'tt' });
    const results = el('div', {});
    const refresh = async () => {
      const r = await api.get(`/api/tourists?q=${encodeURIComponent(search.value.trim())}&area=${encodeURIComponent(area.value)}&onTrip=${trip.checked ? 1 : 0}`);
      if (!r.tourists.length) return clear(results, el('div', { class: 'panel' }, el('div', { class: 'empty' }, icon('users'), el('strong', {}, 'No tourists match'), el('p', {}, 'Tourists register themselves in the traveller app at /t.'))));
      clear(results, el('div', { class: 'table-wrap' }, el('table', { class: 'data table-cards' },
        el('thead', {}, el('tr', {}, ['Traveller', 'Destination', 'Trip', 'Group', 'Language', 'SOS', 'Account'].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, r.tourists.map((t) => {
          const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
          const btn = el('button', { type: 'button', class: 'btn btn-sm' }, t.active ? 'Deactivate' : 'Reactivate');
          btn.addEventListener('click', async () => {
            if (!(await confirmDialog({ title: `${t.active ? 'Deactivate' : 'Reactivate'} ${t.name}?`, body: t.active ? 'They are signed out and stop receiving alerts.' : 'They can sign in and receive alerts again.', confirmLabel: t.active ? 'Deactivate' : 'Reactivate' }))) return;
            if (await runAction(btn, status, () => api.patch(`/api/tourists/${t.id}`, { active: !t.active }), { success: 'Updated.' })) refresh();
          });
          return el('tr', { class: t.active ? null : 'muted' },
            el('td', { 'data-label': 'Traveller' }, el('div', { class: 'cell-stack' }, el('strong', {}, t.name), el('a', { href: `tel:${t.phone}`, class: 'small' }, t.phone), t.nationality ? el('span', { class: 'small muted' }, t.nationality) : null, t.demo ? demoBadge() : null)),
            el('td', { 'data-label': 'Destination' }, el('div', { class: 'cell-stack' }, areaName(t.area_id), el('span', { class: 'small muted' }, t.lodge || ''))),
            el('td', { 'data-label': 'Trip' }, `${fmtDate(t.trip_start)} – ${fmtDate(t.trip_end)}`),
            el('td', { 'data-label': 'Group' }, String(t.group_size)),
            el('td', { 'data-label': 'Language' }, t.language === 'sw' ? 'Kiswahili' : 'English', t.sms_alerts ? '' : el('div', { class: 'small muted' }, 'Alerts off')),
            el('td', { 'data-label': 'SOS' }, t.sos_count ? el('a', { href: `#/incidents?kind=sos&q=${encodeURIComponent(t.phone)}` }, String(t.sos_count)) : '0'),
            el('td', { 'data-label': 'Account' }, el('div', { class: 'row' }, el('span', { class: `badge ${t.active ? 'tone-ok' : 'tone-muted'}` }, t.active ? 'Active' : 'Deactivated'), btn, status)));
        })))));
    };
    for (const c of [area, trip]) c.addEventListener('change', refresh);
    let t;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(refresh, 300); });
    clear(body, el('div', { class: 'filters' }, el('div', { class: 'filters-row' },
      el('div', { class: 'field grow' }, el('label', { for: 'tq' }, 'Search'), search), el('div', { class: 'field' }, el('label', { for: 'ta' }, 'Destination'), area),
      el('label', { class: 'duty-toggle' }, trip, el('span', {}, 'On trip today')))), results);
    await refresh();
  }

  load();
  return { onParams(p) { tab = p.tab === 'tourists' ? 'tourists' : 'staff'; load(); } };
}
