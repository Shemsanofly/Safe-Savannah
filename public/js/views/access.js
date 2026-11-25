import { api, BOOT, clear, confirmDialog, el, fmtDateTime, icon, runAction } from '../lib.js';
import * as store from '../store.js';

const REASONS = {
  authorized: 'Credentials, zone access and visual ID check confirmed',
  invalid_credentials: 'Staff credentials could not be verified',
  no_permission: 'No current permission for this zone',
  identity_unconfirmed: 'Visual identity check was not completed',
  face_authorized: 'Guide face recognized and attraction permission verified',
  face_unknown: 'Face did not match an enrolled guide',
  face_ambiguous: 'The face match was ambiguous',
  face_changed: 'The face or enrollment changed during verification',
  face_liveness_failed: 'The trusted anti-spoof check failed',
  face_not_enrolled: 'No active guide face enrollments are available',
};

export function mount(main, ctx) {
  if (BOOT.operator.role !== 'admin') { main.append(el('p', { role: 'alert' }, 'Gate reviews and permissions require an admin account.')); return {}; }
  let destroyed = false;
  let stream = null;
  let cameraGeneration = 0;
  let checking = false;
  let requestSeq = 0;
  let resultTimer = null;
  let pendingOnly = ctx.params.pending === '1';
  let data = null;
  const isAdmin = BOOT.operator.role === 'admin';
  const connection = el('p', { class: 'muted', role: 'status' }, 'Connecting to gate records…');
  const video = el('video', { class: 'gate-video', autoplay: true, playsinline: true, 'aria-label': 'Live gate camera for the attendant’s visual identity check' });
  video.muted = true;
  const cameraMessage = el('p', { class: 'gate-camera-status', role: 'status' }, 'Camera off. Start the camera before verifying a person at the gate.');
  const cameraButton = el('button', { type: 'button', class: 'btn btn-primary' }, icon('camera'), 'Start gate camera');
  const stopButton = el('button', { type: 'button', class: 'btn', disabled: true }, 'Stop camera');
  const zone = el('select', { id: 'gate-zone', required: true }, el('option', { value: '' }, 'Choose the restricted zone'));
  const staffId = el('input', { id: 'gate-staff-id', maxlength: '32', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'Staff ID' });
  const pin = el('input', { id: 'gate-pin', type: 'password', inputmode: 'numeric', maxlength: '12', autocomplete: 'off', placeholder: '4–12 digits' });
  const visual = el('input', { id: 'gate-visual', type: 'checkbox', disabled: true });
  const tourists = el('input', { id: 'gate-tourists', type: 'number', min: '0', max: '60', value: '0', inputmode: 'numeric' });
  const verify = el('button', { type: 'submit', class: 'btn btn-primary btn-lg', disabled: true }, icon('shield'), 'Verify staff access');
  const visitor = el('button', { type: 'button', class: 'btn', disabled: true }, 'No valid staff ID — deny entry');
  const result = el('div', { class: 'gate-result', 'aria-live': 'assertive', tabindex: '-1' });
  const records = el('div', { class: 'stack' });
  const permissionsList = el('div', { class: 'stack' });
  const grantZone = el('select', { id: 'grant-zone', required: true }, el('option', { value: '' }, 'Choose a zone'));
  const grantStaff = el('select', { id: 'grant-staff', required: true }, el('option', { value: '' }, 'Choose a staff member'));
  const expiry = el('input', { id: 'grant-expiry', type: 'datetime-local' });
  const grantStatus = el('p', { class: 'form-status', 'aria-live': 'polite' });
  const filter = el('button', { class: 'btn btn-sm', type: 'button', 'aria-pressed': String(pendingOnly) }, 'Awaiting review only');
  const field = (id, label, input, hint) => el('div', { class: 'field' }, el('label', { for: id }, label), input, hint ? el('p', { class: 'hint' }, hint) : null);

  const form = el('form', { class: 'stack', autocomplete: 'off' },
    field('gate-zone', 'Restricted zone', zone),
    field('gate-staff-id', 'Staff ID', staffId), field('gate-pin', 'Staff PIN', pin),
    field('gate-tourists', 'Tourists with this guide', tourists, 'A guide’s tour group for today is recorded as in the park here.'),
    el('label', { class: 'gate-confirm' }, visual, el('span', {}, 'I checked the person’s staff badge against the live camera view.')),
    el('div', { class: 'stack' }, verify, visitor), result);
  main.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Gate permissions & manual review'), el('p', { class: 'sub' }, 'Manage guide access and investigate denied entries. Manual credential checks do not open the gate.')), el('a', { class: 'btn', href: '#/access' }, icon('camera'), 'Automatic face entry')),
    el('div', { class: 'gate-guidance' }, icon('shield'), el('div', {}, el('strong', {}, 'Camera view + staff credentials + zone permission'),
      el('p', {}, 'The attendant checks the person’s badge using the camera view. The server verifies their ID, PIN and current zone access. Keep entry closed when verification fails.'),
      el('p', { class: 'small muted' }, 'This screen records a decision for the attendant. It does not identify faces or operate a physical barrier.'))),
    connection,
    el('div', { class: 'gate-grid' },
      el('section', { class: 'panel', 'aria-labelledby': 'gate-camera-title' }, el('div', { class: 'panel-head' }, el('h2', { id: 'gate-camera-title' }, 'Gate camera')),
        el('div', { class: 'panel-body stack' }, video, cameraMessage, el('div', { class: 'row' }, cameraButton, stopButton),
          el('p', { class: 'small muted' }, 'Uses this device’s camera. The preview stays on this device; images are not saved or sent. Stop the camera or leave this screen to end the preview.'))),
      el('section', { class: 'panel', 'aria-labelledby': 'gate-check-title' }, el('div', { class: 'panel-head' }, el('h2', { id: 'gate-check-title' }, 'Check the person at the gate')), el('div', { class: 'panel-body' }, form))),
    el('section', { class: 'panel section', 'aria-labelledby': 'gate-records-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'gate-records-title' }, 'Gate checks & review'), filter), el('div', { class: 'panel-body' }, records)));

  if (isAdmin) {
    const grantButton = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Grant zone access');
    const grantForm = el('form', { class: 'stack' },
      el('p', {}, 'Access starts denied for everyone. Choose each staff member and zone explicitly; admin accounts also need a grant.'),
      el('div', { class: 'form-grid' }, field('grant-staff', 'Authorized staff member', grantStaff), field('grant-zone', 'Restricted zone', grantZone),
        field('grant-expiry', 'Access expires (optional)', expiry, 'Local date and time. Leave blank for access until revoked.')),
      el('div', { class: 'row' }, grantButton, grantStatus));
    grantForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const ok = await runAction(grantButton, grantStatus, async () => {
        await api.post('/api/gate/permissions', { staffId: grantStaff.value, zoneId: Number(grantZone.value), active: true, expiresAt: expiry.value ? new Date(expiry.value).toISOString() : null });
      }, { success: 'Zone permission saved.' });
      if (ok) await load();
    });
    main.append(el('section', { class: 'panel section', 'aria-labelledby': 'gate-permissions-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'gate-permissions-title' }, 'Authorized staff by zone'), el('a', { href: '#/staff', class: 'btn btn-sm' }, 'Manage staff accounts')),
      el('div', { class: 'panel-body stack' }, grantForm, permissionsList)));
  }

  function cameraLive() {
    return !!stream?.getVideoTracks().some((track) => track.readyState === 'live') && video.readyState >= 2 && video.videoWidth > 0 && !video.paused;
  }
  function refreshControls() {
    const live = cameraLive();
    visual.disabled = !live || checking;
    verify.disabled = checking || !live || !zone.value || !data || !visual.checked;
    visitor.disabled = checking || !zone.value || !data;
    for (const control of [zone, staffId, pin]) control.disabled = checking;
  }
  function resetDecision() {
    clearTimeout(resultTimer);
    clear(result);
    result.className = 'gate-result';
  }
  function stopCamera() {
    cameraGeneration++;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    visual.checked = false;
    stopButton.disabled = true;
    cameraButton.disabled = false;
    cameraMessage.textContent = 'Camera off. Keep entry closed until a visual ID check can be completed.';
    resetDecision();
    refreshControls();
  }
  cameraButton.addEventListener('click', async () => {
    const generation = ++cameraGeneration;
    cameraButton.disabled = true;
    cameraMessage.textContent = 'Starting camera… Allow camera access in the browser to continue.';
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs localhost or HTTPS and a supported browser.');
      const nextStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      if (destroyed || generation !== cameraGeneration) { nextStream.getTracks().forEach((track) => track.stop()); return; }
      stream = nextStream;
      stream.getVideoTracks().forEach((track) => track.addEventListener('ended', stopCamera, { once: true }));
      video.srcObject = stream;
      await video.play();
      if (destroyed || generation !== cameraGeneration) return;
      stopButton.disabled = false;
      cameraMessage.textContent = 'Camera live. Ask the person to present their staff badge, then enter their ID and PIN.';
      refreshControls();
    } catch (error) {
      if (destroyed || generation !== cameraGeneration) return;
      stopCamera();
      cameraMessage.textContent = `Camera unavailable. ${error.name === 'NotAllowedError' ? 'Camera permission was not granted.' : 'Check that a camera is connected and available.'} Keep entry closed and contact gate staff.`;
    }
  });
  stopButton.addEventListener('click', stopCamera);
  video.addEventListener('loadeddata', refreshControls);
  video.addEventListener('pause', () => { visual.checked = false; refreshControls(); });
  visual.addEventListener('change', () => { resetDecision(); refreshControls(); });
  for (const control of [zone, staffId]) control.addEventListener('change', () => { visual.checked = false; resetDecision(); refreshControls(); });
  for (const control of [staffId, pin]) control.addEventListener('input', resetDecision);
  staffId.addEventListener('input', () => { visual.checked = false; refreshControls(); });

  async function check(unidentified = false) {
    if (checking || !zone.value) return;
    if (!unidentified && (!staffId.value.trim() || !/^\d{4,12}$/.test(pin.value) || !cameraLive() || !visual.checked)) {
      clear(result, el('p', { class: 'alert alert-error' }, 'Start the camera, enter a staff ID and a 4–12 digit PIN, then complete the visual badge check.'));
      return;
    }
    checking = true;
    resetDecision();
    refreshControls();
    clear(result, el('p', {}, 'Checking authorization. Keep entry closed…'));
    const input = { zoneId: Number(zone.value), staffId: unidentified ? '' : staffId.value.trim(), pin: unidentified ? '' : pin.value, identityConfirmed: !unidentified && cameraLive() && visual.checked, touristCount: unidentified ? 0 : Math.max(0, Math.min(60, Number(tourists.value) || 0)) };
    pin.value = '';
    try {
      const response = await api.post('/api/gate/check', input);
      if (destroyed) return;
      const allowed = response.attempt.decision === 'allowed';
      result.className = `gate-result ${allowed ? 'is-allowed' : 'is-denied'}`;
      clear(result, el('h3', {}, icon(allowed ? 'check-circle' : 'shield'), allowed ? 'Staff access verified' : 'Entry denied — gate review required'),
        el('p', {}, REASONS[response.attempt.reason]), el('p', {}, response.instruction),
        response.attempt.tour_group ? el('p', { class: 'strong' }, icon('users', 'icon icon-sm'), ` Tour group ${response.attempt.tour_group.name} (${response.attempt.tour_group.operator}) is now in the park here · ${response.attempt.tour_group.declared} declared, ${response.attempt.tour_group.registered} registered.`) : null,
        el('p', { class: 'small' }, `Check #${response.attempt.id} · ${fmtDateTime(response.attempt.created_at)}${allowed ? ' · Complete this entry now; verify again for another arrival.' : ' · Added to the gate review queue.'}`));
      result.focus({ preventScroll: true });
      if (allowed) resultTimer = setTimeout(() => { resetDecision(); clear(result, el('p', {}, 'Previous check finished. Verify again for the next arrival.')); }, 20000);
      await Promise.all([load(), store.refresh()]);
    } catch (error) {
      if (!destroyed) {
        result.className = 'gate-result is-denied';
        clear(result, el('h3', {}, 'Entry not authorized'), el('p', {}, `${error.message} Keep entry closed. If the connection failed, this attempt may not have reached the server; check the records before retrying.`));
      }
    } finally {
      checking = false;
      visual.checked = false;
      refreshControls();
    }
  }
  form.addEventListener('submit', (event) => { event.preventDefault(); check(); });
  visitor.addEventListener('click', () => check(true));
  filter.addEventListener('click', () => ctx.navigate(`#/access-manual${pendingOnly ? '' : '?pending=1'}`, { replace: true }));

  function fillSelect(select, rows, label) {
    const key = JSON.stringify(rows);
    if (select.dataset.options === key) return;
    const value = select.value;
    const empty = select.options[0].textContent;
    clear(select, el('option', { value: '' }, empty), rows.map((row) => el('option', { value: row.id }, label(row))));
    select.value = value;
    select.dataset.options = key;
  }
  async function load() {
    const seq = ++requestSeq;
    try {
      const next = await api.get(`/api/gate?pending=${pendingOnly ? '1' : '0'}`);
      if (destroyed || seq !== requestSeq) return;
      data = next;
      connection.className = 'muted';
      connection.textContent = `${data.pending} denied attempt${data.pending === 1 ? '' : 's'} awaiting gate staff review · Updated ${fmtDateTime(data.serverTime)}`;
      fillSelect(zone, data.zones, (z) => `${z.name} · ${z.area_name}`);
      fillSelect(grantZone, data.zones, (z) => `${z.name} · ${z.area_name}`);
      fillSelect(grantStaff, data.staff, (s) => `${s.name} (${s.id})`);
      if (!data.zones.length) connection.textContent = 'No active zones. Ask an admin to add a safety zone before configuring gate access.';
      renderRecords();
      if (isAdmin) renderPermissions();
      refreshControls();
    } catch (error) {
      if (destroyed || seq !== requestSeq) return;
      data = null;
      resetDecision();
      connection.className = 'alert alert-error';
      connection.textContent = `${error.message} Gate records may be out of date. Keep entry closed until verification is available.`;
      refreshControls();
    }
  }
  function renderRecords() {
    if (!data.attempts.length) return clear(records, el('p', { class: 'muted' }, pendingOnly ? 'No denied attempts awaiting review.' : 'No gate checks yet. Start with a zone, camera view and staff credentials.'));
    clear(records, el('p', { class: 'muted small' }, 'Showing up to 50 checks. Reviewing a denial records the follow-up; it does not authorize entry.'), data.attempts.map((attempt) => {
      const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
      const review = el('button', { type: 'button', class: 'btn btn-sm' }, 'Record gate review');
      review.addEventListener('click', async () => {
        const note = el('textarea', { id: `gate-review-${attempt.id}`, maxlength: '500', rows: '3', placeholder: 'For example: visitor directed to reception; entry remained closed.' });
        const ok = await confirmDialog({ title: `Review denied check #${attempt.id}`, body: el('div', { class: 'field' }, el('label', { for: note.id }, 'What did gate staff do?'), note), confirmLabel: 'Save review' });
        if (ok && await runAction(review, status, () => api.post(`/api/gate/attempts/${attempt.id}/review`, { note: note.value.trim() }), { success: 'Review saved. Entry permission is unchanged.' })) await Promise.all([load(), store.refresh()]);
      });
      return el('article', { class: `gate-record ${attempt.decision === 'allowed' ? '' : 'is-denied'}` },
        el('div', { class: 'row between' }, el('strong', {}, attempt.staff_name || attempt.claimed_staff_id || 'Person without staff credentials'),
          el('span', { class: `badge tone-${attempt.decision === 'allowed' ? 'ok' : 'urgent'}` }, attempt.decision === 'allowed' ? 'Verified' : 'Denied')),
        el('p', {}, `${attempt.zone_name} · ${REASONS[attempt.reason]}`),
        el('p', { class: 'muted small' }, `#${attempt.id} · ${fmtDateTime(attempt.created_at)} · Checked by ${attempt.checked_by_name}`),
        attempt.decision === 'denied' ? attempt.reviewed_at
          ? el('p', { class: 'small' }, `Reviewed ${fmtDateTime(attempt.reviewed_at)} · ${attempt.review_note}`)
          : el('div', { class: 'row' }, review, status) : null);
    }));
  }
  function renderPermissions() {
    if (!data.permissions.length) return clear(permissionsList, el('p', { class: 'muted' }, 'No access grants. Everyone is denied until an admin grants access to a zone.'));
    clear(permissionsList, data.permissions.map((permission) => {
      const status = el('span', { class: 'form-status', 'aria-live': 'polite' });
      const revoke = el('button', { type: 'button', class: 'btn btn-sm', disabled: !permission.active }, 'Revoke access');
      revoke.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Revoke ${permission.staff_name}’s zone access?`, body: `They will be denied entry to ${permission.zone_name}. Their console account and entry history remain available.`, confirmLabel: 'Revoke access', tone: 'urgent' }))) return;
        if (await runAction(revoke, status, () => api.post('/api/gate/permissions', { staffId: permission.staff_id, zoneId: permission.zone_id, active: false }), { success: 'Access revoked.' })) await load();
      });
      return el('div', { class: 'gate-record' }, el('div', { class: 'row between' }, el('strong', {}, `${permission.staff_name} · ${permission.zone_name}`),
        el('span', { class: `badge tone-${permission.effective ? 'ok' : 'muted'}` }, permission.effective ? 'Authorized' : !permission.active ? 'Revoked' : !permission.staff_active ? 'Staff inactive' : 'Expired or zone inactive')),
        el('p', { class: 'muted small' }, permission.expires_at ? `Expires ${fmtDateTime(permission.expires_at)}` : 'Until revoked'), el('div', { class: 'row' }, revoke, status));
    }));
  }
  function visibilityChanged() {
    if (document.hidden) stopCamera();
    else load();
  }
  document.addEventListener('visibilitychange', visibilityChanged);
  const timer = setInterval(() => { if (!document.hidden && !checking) load(); }, 5000);
  load();
  return {
    onParams(params) { pendingOnly = params.pending === '1'; filter.setAttribute('aria-pressed', String(pendingOnly)); load(); },
    destroy() { destroyed = true; clearInterval(timer); clearTimeout(resultTimer); document.removeEventListener('visibilitychange', visibilityChanged); stopCamera(); },
  };
}
