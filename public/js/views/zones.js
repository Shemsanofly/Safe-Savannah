// Safety zones (geofencing): draw, edit and deactivate zones on the map. Admins only.
import { createMap } from '../map.js';
import { api, clear, confirmDialog, el, icon, runAction } from '../lib.js';

const KINDS = [['lodge', 'Lodge / hotel'], ['camp', 'Camp'], ['picnic', 'Picnic site'], ['trail', 'Walking trail'], ['road', 'Road'], ['gate', 'Gate'], ['viewpoint', 'Viewpoint'], ['water', 'Water point'], ['other', 'Other']];
const SENS = [['high', 'High — people on foot, guests, children'], ['medium', 'Medium — vehicles, guided walks'], ['low', 'Low — rarely visited']];
const OCC = [['always', 'Always (day and night)'], ['daytime', 'Daytime (06:00–19:00)'], ['night', 'Mainly at night'], ['rarely', 'Rarely']];

export function mount(main, ctx) {
  let area = ctx.params.area || '';
  let data = null;
  let mapApi = null;
  let draft = [];
  let editing = null;
  let drawing = false;

  const areaSel = el('select', { id: 'z-area', 'aria-label': 'Area' });
  const mapBox = el('div', {});
  const list = el('div', { class: 'stack' });
  const formBox = el('div', {});
  const drawHint = el('div', { class: 'alert alert-info', hidden: true, role: 'status' });

  main.append(
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Safety zones'), el('p', { class: 'sub' }, 'Places where people are. Dangerous animals near them raise alerts.')),
      el('div', { class: 'page-actions zones-actions' }, areaSel, el('button', { type: 'button', class: 'btn btn-primary', onclick: () => startNew() }, icon('plus'), 'New zone'))),
    drawHint,
    el('div', { class: 'ops-grid' },
      el('section', { class: 'panel zones-map' }, el('div', { class: 'panel-head' }, el('h2', {}, icon('map'), 'Map')), el('div', { class: 'panel-body' }, mapBox)),
      el('div', { class: 'stack' }, formBox, el('section', { class: 'panel' }, el('div', { class: 'panel-head' }, el('h2', {}, icon('zone'), 'Zones')), el('div', { class: 'panel-body' }, list)))),
  );

  areaSel.addEventListener('change', () => {
    area = areaSel.value;
    ctx.navigate(`#/zones?area=${encodeURIComponent(area)}`, { replace: true });
  });

  async function load(fit = true) {
    try {
      data = await api.get(`/api/zones?all=1${area ? `&area=${encodeURIComponent(area)}` : ''}`);
      if (!areaSel.options.length) {
        for (const a of data.areas) areaSel.append(el('option', { value: a.id }, a.name));
        if (!area && data.areas[0]) {
          area = data.areas[0].id;
          return load();
        }
        areaSel.value = area;
      }
      const a = data.areas.find((x) => x.id === area);
      if (!mapApi) {
        mapApi = await createMap(mapBox, a ? { center: [a.center_lat, a.center_lng], zoom: a.zoom } : {});
        mapApi.map.on('click', (e) => {
          if (!drawing) return;
          draft.push([Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))]);
          drawDraft();
        });
      }
      mapApi.drawZones(data.zones, { onClick: (z) => !drawing && startEdit(z) });
      if (fit) {
        const pts = data.zones.flatMap((z) => z.geometry);
        if (pts.length) mapApi.fitTo(pts);
        else if (a) mapApi.map.setView([a.center_lat, a.center_lng], a.zoom);
      }
      renderList();
    } catch (err) {
      clear(list, el('div', { class: 'alert alert-error' }, icon('alert'), err.message));
    }
  }

  function renderList() {
    if (!data.zones.length) {
      clear(list, el('div', { class: 'empty' }, icon('zone'), el('strong', {}, 'No zones yet'), el('p', {}, 'Choose "New zone" and click the map to draw one.')));
      return;
    }
    clear(list, el('ul', { class: 'zone-list' }, data.zones.map((z) => el('li', {},
      el('button', { type: 'button', class: `zone-row${z.active ? '' : ' is-off'}`, onclick: () => startEdit(z), 'aria-label': `Edit ${z.name}` },
        el('span', { class: `zone-dot sens-${z.active ? z.sensitivity : 'off'}`, 'aria-hidden': 'true' }),
        el('span', { class: 'grow' }, el('strong', {}, z.name), el('span', { class: 'small muted' }, KINDS.find((k) => k[0] === z.kind)?.[1].split(' /')[0] || z.kind)),
        el('span', { class: 'small muted' }, z.active ? `${z.sensitivity}` : 'off'),
        icon('chevron-right', 'icon icon-sm'))))));
  }

  function drawDraft() {
    const L = mapApi.L;
    mapApi.layers.draft.clearLayers();
    if (draft.length >= 2) L.polygon(draft, { color: '#d4912a', weight: 3, dashArray: '6 6', fillOpacity: 0.15 }).addTo(mapApi.layers.draft);
    for (const p of draft) L.circleMarker(p, { radius: 5, color: '#fff', weight: 2, fillColor: '#d4912a', fillOpacity: 1 }).addTo(mapApi.layers.draft);
    drawHint.hidden = !drawing;
    clear(drawHint, icon('pin'), el('span', {}, el('strong', {}, `Drawing: ${draft.length} point${draft.length === 1 ? '' : 's'}. `), 'Click the map to add corners in order around the area (at least 3). '),
      el('button', { type: 'button', class: 'btn btn-sm', disabled: !draft.length, onclick: () => { draft.pop(); drawDraft(); } }, 'Undo point'),
      el('button', { type: 'button', class: 'btn btn-sm', onclick: () => { draft = []; drawDraft(); } }, 'Clear'),
      el('button', { type: 'button', class: 'btn btn-sm btn-primary', disabled: draft.length < 3, onclick: () => { drawing = false; drawDraft(); } }, 'Finish outline'));
    if (!drawing) drawHint.hidden = true;
  }

  function startNew() {
    editing = null;
    draft = [];
    drawing = true;
    drawDraft();
    renderForm({ name: '', kind: 'lodge', sensitivity: 'high', occupancy: 'always', buffer_m: 200, notes: '', active: true });
    mapApi?.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function startEdit(z) {
    editing = z;
    draft = z.geometry.map((p) => [...p]);
    drawing = false;
    drawDraft();
    renderForm(z);
  }

  function renderForm(z) {
    const name = el('input', { id: 'zf-name', value: z.name, maxlength: '80' });
    const kind = sel('zf-kind', KINDS, z.kind);
    const sens = sel('zf-sens', SENS, z.sensitivity);
    const occ = sel('zf-occ', OCC, z.occupancy);
    const buffer = el('input', { id: 'zf-buf', inputmode: 'numeric', value: String(z.buffer_m) });
    const notes = el('input', { id: 'zf-notes', value: z.notes || '', maxlength: '300' });
    const err = el('p', { class: 'field-error', hidden: true, role: 'alert' });
    const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
    const save = el('button', { type: 'submit', class: 'btn btn-primary' }, el('span', {}, editing ? 'Save changes' : 'Create zone'));
    const redraw = el('button', { type: 'button', class: 'btn' }, icon('pin', 'icon icon-sm'), editing ? 'Redraw outline' : 'Restart outline');
    redraw.addEventListener('click', () => { draft = []; drawing = true; drawDraft(); });
    const toggle = editing ? el('button', { type: 'button', class: 'btn' }, editing.active ? 'Deactivate' : 'Reactivate') : null;
    toggle?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: `${editing.active ? 'Deactivate' : 'Reactivate'} ${editing.name}?`, body: editing.active ? 'Detections near this zone will no longer raise alerts. Past incidents are kept.' : 'Detections near this zone will raise alerts again.', confirmLabel: editing.active ? 'Deactivate' : 'Reactivate', tone: editing.active ? 'urgent' : 'primary' });
      if (ok) await runAction(toggle, status, async () => { await api.patch(`/api/zones/${editing.id}`, { active: !editing.active }); editing = null; clear(formBox); await load(false); }, { success: 'Zone updated.' });
    });
    const form = el('form', { class: 'panel', novalidate: true },
      el('div', { class: 'panel-head' }, el('h2', {}, icon('zone'), editing ? `Edit: ${editing.name}` : 'New safety zone'), el('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { editing = null; drawing = false; draft = []; drawDraft(); clear(formBox); } }, 'Cancel')),
      el('div', { class: 'panel-body stack' },
        fieldEl('zf-name', 'Name', name), fieldEl('zf-kind', 'Type of place', kind), fieldEl('zf-sens', 'Sensitivity', sens),
        fieldEl('zf-occ', 'When are people here?', occ), fieldEl('zf-buf', 'Alert distance (metres)', buffer),
        fieldEl('zf-notes', 'Notes (optional)', notes), err,
        el('div', { class: 'form-actions' }, save, redraw, toggle, status)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = Number(buffer.value);
      const problem = name.value.trim().length < 2 ? 'Give the zone a name.' : draft.length < 3 ? 'Draw the outline: click at least 3 points on the map.' : !Number.isInteger(b) || b < 0 || b > 5000 ? 'Alert distance must be a whole number from 0 to 5000.' : null;
      if (problem) { err.hidden = false; clear(err, icon('alert', 'icon icon-sm'), problem); return; }
      err.hidden = true;
      const payload = { area_id: area, name: name.value.trim(), kind: kind.value, sensitivity: sens.value, occupancy: occ.value, buffer_m: b, geometry: draft, notes: notes.value.trim() || null };
      const r = await runAction(save, status, () => (editing ? api.patch(`/api/zones/${editing.id}`, payload) : api.post('/api/zones', payload)), { success: editing ? 'Zone saved.' : 'Zone created.' });
      if (r) { editing = null; drawing = false; draft = []; drawDraft(); clear(formBox); await load(false); }
    });
    clear(formBox, form);
    name.focus();
  }

  load();
  return {
    onParams(p) { area = p.area || area; areaSel.value = area; clear(formBox); drawing = false; draft = []; if (mapApi) drawDraft(); load(); },
    destroy() { mapApi?.destroy(); },
  };
}

function sel(id, opts, value) {
  const s = el('select', { id }, opts.map(([v, l]) => el('option', { value: v }, l)));
  s.value = value;
  return s;
}
function fieldEl(id, label, control, hint) {
  return el('div', { class: 'field' }, el('label', { for: id }, label), control, hint ? el('p', { class: 'hint' }, hint) : null);
}
