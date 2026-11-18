// Settings: read-only view of how the system is configured (no secrets), plus operator management for admins.
import { api, BOOT, clear, confirmDialog, el, fmtDate, icon, runAction, validateRequired } from '../lib.js';

export function mount(main) {
  const body = el('div', { class: 'stack' }, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading settings…'));
  const operatorsBox = el('div', {});
  main.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Settings'),
      el('p', { class: 'sub' }, 'How this station is set up (read-only).'))),
    body, operatorsBox);

  async function load() {
    try {
      const s = await api.get('/api/settings');
      render(s);
    } catch (err) {
      clear(body, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), el('div', { class: 'grow' }, el('strong', {}, 'Could not load settings. '), err.message),
        el('button', { type: 'button', class: 'btn btn-sm', onclick: load }, 'Try again')));
    }
  }

  function render(s) {
    const d = s.detector;
    const secondsForStreak = (d.consecutiveFrames / d.sampleFps).toFixed(1);
    clear(body,
      el('div', { class: 'cols-3' },
        section('camera', 'Camera', [
          ['Camera', s.camera.label],
          ['Source', { file: 'Recorded video (replay)', device: 'USB / local camera', stream: 'Network camera stream' }[s.camera.sourceKind] || 'Not reported yet'],
        ]),
        section('cpu', 'Detection', [
          ['Detector', d.kind === 'inference' ? el('span', { class: 'badge tone-real' }, icon('cpu'), 'Real AI model') : d.kind === 'simulated' ? el('span', { class: 'badge tone-sim' }, icon('flask'), 'Simulated (demo)') : 'Not reported yet'],
          ['Looks for', d.targetClass],
          ['Alert when', `Seen ${d.consecutiveFrames} frames in a row (about ${secondsForStreak} s) inside the zone`],
        ]),
        section('clock', 'This station', [
          ['Time zone', s.timeZone],
          ['You are', BOOT.operator.role === 'admin' ? 'Admin' : 'Ranger'],
        ])),
      s.technical ? el('details', { class: 'panel' },
        el('summary', { class: 'panel-head', style: null }, el('h2', {}, icon('settings'), 'Technical details'), icon('chevron-down', 'icon icon-sm t-caret')),
        el('div', { class: 'panel-body' }, el('dl', { class: 'facts', style: null },
          fact('Camera ID', s.camera.id),
          fact('Camera source', s.technical.cameraSource),
          ...(s.camera.sourceKind === 'file' ? [fact('Replay', s.camera.loopsReplay ? 'Loops continuously' : 'Plays once')] : []),
          fact('Marked zones', s.zones.length ? s.zones.map((z) => `${z.label} (${z.vertices} points)`).join(', ') : 'None'),
          fact('Detector model', s.technical.detectorModel || '—'),
          fact('Minimum confidence', `${Math.round(d.confidenceThreshold * 100)}%`),
          fact('Frames analysed', `${d.sampleFps} per second`),
          fact('Re-arming', `Zone empty for ${d.clearSeconds} s after the alert is closed`),
          fact('Feed counts as stale', `After ${d.staleFeedSeconds} s without a frame`),
          fact('Max frame gap', `${s.technical.maxFrameGapMs} ms`),
          fact('Session length', `${s.technical.sessionHours} h`),
          fact('Secure cookies', yes(s.technical.secureCookies))),
          el('p', { class: 'hint', style: null }, 'Read-only: these come from the server configuration. Credentials are never shown here.'))) : null,
    );
  }

  // ---------------------------------------------------------------- operators
  async function loadOperators() {
    try {
      const { operators } = await api.get('/api/operators');
      renderOperators(operators);
    } catch (err) {
      clear(operatorsBox, el('div', { class: 'alert alert-error' }, icon('alert'), `Could not load operators: ${err.message}`));
    }
  }

  function renderOperators(ops) {
    const rows = ops.map((o) => {
      const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
      const self = o.id === BOOT.operator.id;
      const roleSel = el('select', { 'aria-label': `Role for ${o.name}`, disabled: self }, [['ranger', 'Ranger'], ['admin', 'Admin']].map(([v, l]) => el('option', { value: v }, l)));
      roleSel.value = o.role;
      roleSel.addEventListener('change', async () => {
        const ok = await confirmDialog({ title: `Change ${o.name}'s role?`, body: `They will become a ${roleSel.value === 'admin' ? 'admin' : 'ranger'} and will need to sign in again.`, confirmLabel: 'Change role' });
        if (!ok) {
          roleSel.value = o.role;
          return;
        }
        roleSel.disabled = true;
        const r = await runAction(null, status, () => api.patch(`/api/operators/${encodeURIComponent(o.id)}`, { role: roleSel.value }), { success: 'Role updated.' });
        roleSel.disabled = false;
        if (!r) roleSel.value = o.role;
        loadOperators();
      });
      const toggle = el('button', { type: 'button', class: 'btn btn-sm', disabled: self }, o.active ? 'Deactivate' : 'Reactivate');
      toggle.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: `${o.active ? 'Deactivate' : 'Reactivate'} ${o.name}?`, body: o.active ? 'They will be signed out and cannot sign in until reactivated. Their history is kept.' : 'They will be able to sign in again with their current PIN.', confirmLabel: o.active ? 'Deactivate' : 'Reactivate', tone: o.active ? 'urgent' : 'primary' });
        if (ok) await runAction(toggle, status, () => api.patch(`/api/operators/${encodeURIComponent(o.id)}`, { active: !o.active }), { success: o.active ? 'Operator deactivated.' : 'Operator reactivated.' });
        loadOperators();
      });
      const pinBtn = el('button', { type: 'button', class: 'btn btn-sm' }, icon('key', 'icon icon-sm'), 'Reset PIN');
      pinBtn.addEventListener('click', () => resetPin(o, status));
      return el('tr', { class: o.active ? null : 'muted' },
        el('td', { 'data-label': 'Name' }, el('div', { class: 'cell-stack' }, el('strong', {}, o.name), el('span', { class: 'muted small' }, `${o.id}${self ? ' (you)' : ''}`))),
        el('td', { 'data-label': 'Role' }, roleSel),
        el('td', { 'data-label': 'Status' }, el('span', { class: `badge ${o.active ? 'tone-ok' : 'tone-muted'}` }, o.active ? 'Active' : 'Deactivated')),
        el('td', { 'data-label': 'Added' }, fmtDate(o.created_at)),
        el('td', { 'data-label': 'Actions' }, el('div', { class: 'row' }, pinBtn, toggle, status)));
    });
    clear(operatorsBox, el('section', { class: 'section', 'aria-labelledby': 'ops-title' },
      el('div', { class: 'section-head' }, el('h2', { id: 'ops-title' }, 'Operators'), el('span', { class: 'muted small' }, 'Admins only')),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data table-cards' },
        el('thead', {}, el('tr', {}, ['Name', 'Role', 'Status', 'Added', 'Actions'].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, rows))),
      addOperatorForm()));
  }

  function addOperatorForm() {
    const id = el('input', { id: 'op-id', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '32', pattern: '[A-Za-z0-9_-]{2,32}' });
    const name = el('input', { id: 'op-name', autocomplete: 'off', maxlength: '60' });
    const pin = el('input', { id: 'op-pin', type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: '12' });
    const role = el('select', { id: 'op-role' }, el('option', { value: 'ranger' }, 'Ranger'), el('option', { value: 'admin' }, 'Admin'));
    const err = el('p', { class: 'field-error', hidden: true, role: 'alert' });
    const btn = el('button', { type: 'submit', class: 'btn btn-primary' }, icon('plus'), el('span', {}, 'Add operator'));
    const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
    const form = el('form', { class: 'panel section', novalidate: true },
      el('div', { class: 'panel-head' }, el('h3', {}, 'Add an operator')),
      el('div', { class: 'panel-body stack' },
        el('div', { class: 'filters-row align-start' },
          el('div', { class: 'field' }, el('label', { for: 'op-name' }, 'Full name'), name),
          el('div', { class: 'field' }, el('label', { for: 'op-id' }, 'Operator ID'), id, el('span', { class: 'hint' }, '2–32 letters, digits, - or _')),
          el('div', { class: 'field' }, el('label', { for: 'op-pin' }, 'Starting PIN'), pin, el('span', { class: 'hint' }, '4–12 digits')),
          el('div', { class: 'field' }, el('label', { for: 'op-role' }, 'Role'), role)),
        err, el('div', { class: 'form-actions' }, btn, status)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!validateRequired(name, err, 'Enter the person’s name.') || !validateRequired(id, err, 'Choose an operator ID.') || !validateRequired(pin, err, 'Set a starting PIN.')) return;
      if (!/^[A-Za-z0-9_-]{2,32}$/.test(id.value.trim())) return showErr(id, 'Operator ID: 2–32 letters, digits, - or _.');
      if (!/^\d{4,12}$/.test(pin.value.trim())) return showErr(pin, 'PIN must be 4–12 digits.');
      const r = await runAction(btn, status, () => api.post('/api/operators', { id: id.value.trim(), name: name.value.trim(), pin: pin.value.trim(), role: role.value }),
        { success: `Operator ${id.value.trim()} added.` });
      if (r) {
        form.reset();
        loadOperators();
      }
    });
    function showErr(input, msg) {
      input.setAttribute('aria-invalid', 'true');
      err.hidden = false;
      clear(err, icon('alert', 'icon icon-sm'), msg);
      input.focus();
    }
    return form;
  }

  async function resetPin(o, status) {
    const pin = el('input', { id: 'new-pin', type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: '12' });
    const ok = await confirmDialog({
      title: `Reset PIN for ${o.name}`,
      body: el('div', { class: 'field' }, el('label', { for: 'new-pin' }, 'New PIN (4–12 digits)'), pin,
        el('p', { class: 'hint' }, 'They will be signed out everywhere and must use the new PIN.')),
      confirmLabel: 'Reset PIN',
    });
    if (!ok) return;
    if (!/^\d{4,12}$/.test(pin.value.trim())) {
      status.className = 'form-status is-err';
      clear(status, icon('alert', 'icon icon-sm'), 'PIN must be 4–12 digits. Nothing was changed.');
      return;
    }
    await runAction(null, status, () => api.post(`/api/operators/${encodeURIComponent(o.id)}/pin`, { pin: pin.value.trim() }), { success: `PIN reset for ${o.name}.` });
  }

  load();
  return {};
}

function section(iconId, title, rows) {
  return el('section', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, icon(iconId), title)),
    el('div', { class: 'panel-body' }, el('dl', { class: 'facts facts-stack' }, rows.map(([k, v]) => fact(k, v)))));
}
function fact(k, v) {
  return [el('dt', {}, k), el('dd', {}, v)];
}
const yes = (b) => (b ? 'Yes' : 'No');
