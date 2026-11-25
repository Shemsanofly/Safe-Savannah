// Lodges & camps (admin): partner properties, the safety zone each one sits on, front-desk phone and check-in code.
import { api, clear, confirmDialog, el, icon, runAction, toast } from '../lib.js';

export function mount(main) {
  let areas = [];
  let zones = [];
  const body = el('div', { class: 'stack' }, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'));
  main.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Lodges & camps'),
      el('p', { class: 'sub' }, 'Partner properties. Guests check in with the QR code; the front desk sees alerts and roll calls.'))),
    body);

  const field = (id, label, control, hint) => el('div', { class: 'field' }, el('label', { for: id }, label), control, hint ? el('span', { class: 'hint' }, hint) : null);
  function areaSelect(id, value) {
    const s = el('select', { id }, areas.map((a) => el('option', { value: a.id }, a.name)));
    if (value) s.value = value;
    return s;
  }
  function zoneSelect(id, areaId, value) {
    const s = el('select', { id });
    const fill = (a) => clear(s, el('option', { value: '' }, 'No zone (no automatic roll call)'),
      zones.filter((z) => z.area_id === a && z.active).map((z) => el('option', { value: String(z.id) }, `${z.name} (${z.kind})`)));
    fill(areaId);
    s.value = value ? String(value) : '';
    return { s, fill };
  }

  async function load() {
    try {
      const [l, z] = await Promise.all([api.get('/api/lodges'), api.get('/api/zones?all=1')]);
      zones = z.zones;
      areas = z.areas;
      render(l.lodges);
    } catch (err) {
      clear(body, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), err.message));
    }
  }

  function render(lodges) {
    clear(body,
      lodges.length
        ? el('ul', { class: 'person-list' }, lodges.map(row))
        : el('div', { class: 'panel' }, el('div', { class: 'empty' }, icon('home'), el('strong', {}, 'No lodges yet'), el('p', {}, 'Add a partner lodge or camp below.'))),
      addForm());
  }

  function row(l) {
    const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
    const edit = el('button', { type: 'button', class: 'btn btn-sm' }, icon('settings', 'icon icon-sm'), el('span', {}, 'Edit'));
    edit.addEventListener('click', () => editLodge(l, status));
    const code = el('button', { type: 'button', class: 'menu-item' }, icon('refresh', 'icon icon-sm'), 'New check-in code');
    code.addEventListener('click', async () => {
      menu.open = false;
      const ok = await confirmDialog({ title: `New check-in code for ${l.name}?`, body: 'The printed QR code at reception stops working. Print the new one from the front desk.', confirmLabel: 'Make new code', tone: 'urgent' });
      if (ok) await runAction(null, status, () => api.post(`/api/lodges/${encodeURIComponent(l.id)}/code`, {}), { success: 'New check-in code created.' }).then(load);
    });
    const toggle = el('button', { type: 'button', class: 'menu-item' }, icon(l.active ? 'x' : 'check', 'icon icon-sm'), l.active ? 'Deactivate' : 'Reactivate');
    toggle.addEventListener('click', async () => {
      menu.open = false;
      const ok = await confirmDialog({ title: `${l.active ? 'Deactivate' : 'Reactivate'} ${l.name}?`, body: l.active ? 'Guests can no longer check in and no new roll calls start. History is kept.' : 'Guests can check in again.', confirmLabel: l.active ? 'Deactivate' : 'Reactivate', tone: l.active ? 'urgent' : 'primary' });
      if (ok) await runAction(null, status, () => api.patch(`/api/lodges/${encodeURIComponent(l.id)}`, { active: !l.active }), { success: 'Updated.' }).then(load);
    });
    const menu = el('details', { class: 'row-menu' }, el('summary', { 'aria-label': `More actions for ${l.name}` }, icon('chevron-down', 'icon icon-sm')), el('div', { class: 'row-menu-panel' }, code, toggle));
    return el('li', { class: `person-row${l.active ? '' : ' is-off'}` },
      el('span', { class: 'avatar is-admin', 'aria-hidden': 'true' }, icon('home', 'icon icon-sm')),
      el('div', { class: 'person-main' },
        el('div', { class: 'person-name' }, el('strong', {}, l.name), l.demo ? el('span', { class: 'inc-tag small' }, 'Demo') : null),
        el('div', { class: 'person-sub' }, el('span', {}, l.area_name), l.zone_name ? el('span', {}, `Zone: ${l.zone_name}`) : el('span', { class: 'warn-text' }, 'No safety zone'),
          l.phone ? el('a', { href: `tel:${l.phone}` }, l.phone) : el('span', { class: 'warn-text' }, 'No desk phone'),
          el('span', {}, `Code ${l.checkin_code}`))),
      el('span', { class: `person-pill tone-${l.active ? 'ok' : 'muted'}` }, l.active ? `${l.guests_tonight} guest${l.guests_tonight === 1 ? '' : 's'} tonight` : 'Deactivated'),
      el('div', { class: 'person-actions' }, el('a', { class: 'btn btn-sm', href: `#/lodge?lodge=${encodeURIComponent(l.id)}` }, icon('home', 'icon icon-sm'), el('span', {}, 'Front desk')), edit, menu),
      status);
  }

  async function editLodge(l, status) {
    const name = el('input', { id: 'el-name', value: l.name, maxlength: '80' });
    const area = areaSelect('el-area', l.area_id);
    const zone = zoneSelect('el-zone', l.area_id, l.zone_id);
    area.addEventListener('change', () => zone.fill(area.value));
    const phone = el('input', { id: 'el-phone', type: 'tel', inputmode: 'tel', value: l.phone || '', placeholder: '+255…' });
    const ok = await confirmDialog({
      title: `Edit ${l.name}`,
      body: el('div', { class: 'stack' }, field('el-name', 'Name', name), field('el-area', 'Area', area),
        field('el-zone', 'Safety zone', zone.s, 'High or critical wildlife alerts in this zone start a guest roll call.'),
        field('el-phone', 'Front-desk phone', phone, 'Gets an SMS when a roll call starts and at the all clear.')),
      confirmLabel: 'Save changes',
    });
    if (!ok) return;
    await runAction(null, status, () => api.patch(`/api/lodges/${encodeURIComponent(l.id)}`, {
      name: name.value.trim(), area_id: area.value, zone_id: zone.s.value ? Number(zone.s.value) : null, phone: phone.value.trim() || null,
    }), { success: `${name.value.trim()} saved.` }).then((r) => r && load());
  }

  function addForm() {
    const name = el('input', { id: 'nl-name', maxlength: '80', autocomplete: 'off' });
    const area = areaSelect('nl-area');
    const zone = zoneSelect('nl-zone', areas[0]?.id);
    area.addEventListener('change', () => zone.fill(area.value));
    const phone = el('input', { id: 'nl-phone', type: 'tel', inputmode: 'tel', placeholder: '+255…' });
    const err = el('p', { class: 'field-error', hidden: true, role: 'alert' });
    const btn = el('button', { type: 'submit', class: 'btn btn-primary' }, icon('plus'), el('span', {}, 'Add lodge'));
    const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
    const form = el('form', { class: 'add-form', novalidate: true },
      el('div', { class: 'form-grid' }, field('nl-name', 'Name', name), field('nl-area', 'Area', area), field('nl-zone', 'Safety zone', zone.s, 'Draw it first under Safety zones'),
        field('nl-phone', 'Front-desk phone', phone, 'Optional')),
      err, el('p', { class: 'hint' }, 'Then add a front-desk account in Staff management, with the role Front desk.'),
      el('div', { class: 'form-actions' }, btn, status));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (name.value.trim().length < 2) {
        err.hidden = false;
        clear(err, icon('alert', 'icon icon-sm'), 'Enter the lodge name.');
        name.focus();
        return;
      }
      err.hidden = true;
      const r = await runAction(btn, status, () => api.post('/api/lodges', {
        name: name.value.trim(), area_id: area.value, zone_id: zone.s.value ? Number(zone.s.value) : null, phone: phone.value.trim() || null,
      }), { success: `${name.value.trim()} added.` });
      if (r) {
        toast('Print its check-in QR from the front desk.');
        load();
      }
    });
    return el('details', { class: 'panel add-panel' },
      el('summary', { class: 'panel-head' }, el('h2', {}, icon('plus'), 'Add a lodge or camp'), icon('chevron-down', 'icon icon-sm t-caret')),
      el('div', { class: 'panel-body' }, form));
  }

  load();
  return {};
}
