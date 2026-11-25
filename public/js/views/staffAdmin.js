import { api, BOOT, clear, confirmDialog, el, fmtDateTime, icon, runAction } from '../lib.js';
import { mount as mountPeople } from './people.js';

const REASONS = { no_permission: 'Face matched; gate permission missing', face_unknown: 'Face not recognized', face_ambiguous: 'Ambiguous face match', face_not_enrolled: 'No eligible staff reference enrolled', face_changed: 'Person or reference changed during verification', face_liveness_failed: 'Camera verification failed', invalid_credentials: 'Credentials did not match', identity_unconfirmed: 'Identity check incomplete' };

async function fileImage(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG or WebP photograph.');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [.85, .7, .55]) { const image = canvas.toDataURL('image/jpeg', quality).split(',')[1]; if (image.length <= 666668) return image; }
    throw new Error('This photo is too large. Choose a closer portrait with a simpler background.');
  } finally { bitmap.close(); }
}

export function mount(main, ctx) {
  if (BOOT.operator.role !== 'admin') { main.append(el('p', { role: 'alert' }, 'Only admins can manage staff, reference pictures, demonstrations and gate reviews.')); return {}; }
  let destroyed = false;
  let data = null;
  let face = null;
  let station = null;
  let sequence = 0;
  let busy = false;
  let stream = null;
  let cameraGeneration = 0;
  let requestedStaff = ctx.params.staff || '';
  let pendingOnly = ctx.params.pending === '1';
  const field = (id, label, control, hint) => el('div', { class: 'field' }, el('label', { for: id }, label), control, hint ? el('p', { class: 'hint' }, hint) : null);
  const section = (id, title, ...children) => el('section', { id, class: 'panel section' }, el('div', { class: 'panel-head' }, el('h2', {}, title)), el('div', { class: 'panel-body stack' }, ...children));
  const accounts = el('div', {});
  const health = el('p', { class: 'muted small', role: 'status' }, 'Loading staff reference records…');
  const referenceStaff = el('select', { id: 'admin-reference-staff', required: true }, el('option', { value: '' }, 'Choose a staff member'));
  const referenceFile = el('input', { id: 'admin-reference-file', type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const consent = el('input', { id: 'admin-reference-consent', type: 'checkbox' });
  const upload = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save staff reference picture');
  const referenceFeedback = el('p', { class: 'form-status', 'aria-live': 'polite' });
  const video = el('video', { class: 'gate-video admin-enrollment-video', playsinline: true, autoplay: true, hidden: true, 'aria-label': 'Admin staff enrollment camera' }); video.muted = true;
  const camera = el('button', { class: 'btn', type: 'button' }, 'Use enrollment camera');
  const stopCameraButton = el('button', { class: 'btn', type: 'button', hidden: true }, 'Stop enrollment camera');
  const capture = el('button', { class: 'btn', type: 'button', disabled: true }, 'Capture live reference');
  const gallery = el('div', { class: 'staff-reference-gallery' });
  const stationSelect = el('select', { id: 'admin-station-zone', required: true }, el('option', { value: '' }, 'Choose the station gate'));
  const stationSave = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Set station gate');
  const stationFeedback = el('p', { class: 'form-status', 'aria-live': 'polite' });
  const stationLabel = el('p', { class: 'strong' }, 'No station gate configured.');
  const grantStaff = el('select', { id: 'admin-grant-staff', required: true }, el('option', { value: '' }, 'Choose staff'));
  const grantZone = el('select', { id: 'admin-grant-zone', required: true }, el('option', { value: '' }, 'Choose attraction'));
  const expires = el('input', { id: 'admin-grant-expiry', type: 'datetime-local' });
  const grantSave = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Grant attraction access');
  const grantFeedback = el('p', { class: 'form-status', 'aria-live': 'polite' });
  const grantList = el('div', { class: 'stack' });
  const demoStaff = el('select', { id: 'admin-demo-staff', required: true }, el('option', { value: '' }, 'Choose an enrolled reference'));
  const demoZone = el('select', { id: 'admin-demo-zone', required: true }, el('option', { value: '' }, 'Choose the test gate'));
  const demoFile = el('input', { id: 'admin-demo-file', type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const demoButton = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Test picture comparison');
  const demoTitle = el('h3', {}, 'Compare a picture with the enrolled staff references');
  const demoMessage = el('p', {}, 'Use the saved portrait or choose another photograph. This demonstration never sends a gate command.');
  const demoResult = el('div', { class: 'face-gate-state', 'aria-live': 'polite' }, demoTitle, el('div', { class: 'gate-arm', 'aria-hidden': 'true' }, el('span', { class: 'gate-arm-bar' }), el('span', { class: 'gate-arm-post' })), demoMessage);
  const reviewList = el('div', { class: 'stack' });
  const reviewToggle = el('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': String(pendingOnly) }, 'Awaiting review only');

  const referenceForm = el('form', { class: 'stack' },
    el('p', {}, 'Only admins can register a staff reference picture. The staff gate page only compares arriving faces against these records.'),
    field(referenceStaff.id, 'Staff member', referenceStaff), field(referenceFile.id, 'Reference picture', referenceFile, 'Choose a clear picture with one face. Existing demo accounts remain simulation-only.'),
    el('label', { class: 'gate-confirm' }, consent, el('span', {}, 'I am authorized to register this staff member’s picture for face authentication.')),
    el('div', { class: 'row' }, upload, camera, stopCameraButton, capture), video, referenceFeedback);
  const stationForm = el('form', { class: 'stack' }, stationLabel, field(stationSelect.id, 'Gate used by the staff authentication page', stationSelect),
    el('div', { class: 'row' }, stationSave, stationFeedback), el('p', { class: 'small muted' }, 'Staff cannot choose another gate. Setting the location does not grant staff access automatically.'));
  const grantForm = el('form', { class: 'stack' }, el('div', { class: 'form-grid' }, field(grantStaff.id, 'Staff member', grantStaff), field(grantZone.id, 'Authorized attraction', grantZone), field(expires.id, 'Access expires (optional)', expires)), el('div', { class: 'row' }, grantSave, grantFeedback));
  const demoForm = el('form', { class: 'stack' }, el('div', { class: 'form-grid' }, field(demoStaff.id, 'Enrolled staff reference', demoStaff), field(demoZone.id, 'Gate to test', demoZone)), field(demoFile.id, 'Optional test photograph', demoFile, 'Leave empty to test the saved reference portrait.'), demoButton, demoResult);
  const referenceSection = section('admin-staff-references', 'Staff reference pictures', referenceForm, gallery);
  const demoSection = section('admin-face-demo', 'Admin photo comparison demo', demoForm);
  const reviewsSection = section('admin-gate-reviews', 'Gate reviews', reviewToggle, reviewList);
  main.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Staff management'), el('p', { class: 'sub' }, 'Admin-only staff accounts, reference pictures, attraction permissions and gate reviews.')),
    el('a', { class: 'btn', href: '#/access' }, 'Open staff authentication')),
    el('div', { class: 'row admin-section-links' }, [['Staff accounts', accounts], ['Reference pictures', referenceSection], ['Gate reviews', reviewsSection], ['Photo demo', demoSection]].map(([label, target]) =>
      el('button', { type: 'button', class: 'btn btn-sm', onclick: () => target.scrollIntoView({ block: 'start' }) }, label))),
    health, accounts, referenceSection, section('admin-station', 'Gate station configuration', stationForm), section('admin-staff-access', 'Staff attraction permissions', grantForm, grantList), demoSection, reviewsSection);
  const people = mountPeople(accounts, { ...ctx, params: { tab: 'staff' }, staffOnly: true, embedded: true, touristOnly: false });

  function controls() {
    const active = !!stream?.getVideoTracks().some((t) => t.readyState === 'live') && video.readyState >= 2;
    capture.disabled = busy || !active || !referenceStaff.value || !consent.checked || !face?.available;
    camera.disabled = busy;
    for (const node of [referenceStaff, referenceFile, consent, upload]) node.disabled = busy;
  }
  function stopCamera() { cameraGeneration++; stream?.getTracks().forEach((t) => t.stop()); stream = null; video.srcObject = null; video.hidden = true; stopCameraButton.hidden = true; controls(); }
  function snapshot() {
    const canvas = document.createElement('canvas'); const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .85).split(',')[1];
  }
  camera.addEventListener('click', async () => {
    const gen = ++cameraGeneration;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('The enrollment camera needs localhost or HTTPS.');
      const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (destroyed || gen !== cameraGeneration) { next.getTracks().forEach((t) => t.stop()); return; }
      stream?.getTracks().forEach((t) => t.stop()); stream = next; video.srcObject = stream; video.hidden = false; stopCameraButton.hidden = false;
      stream.getTracks().forEach((t) => t.addEventListener('ended', stopCamera, { once: true })); await video.play(); controls();
    } catch (error) { referenceFeedback.textContent = error.message; }
  });
  stopCameraButton.addEventListener('click', stopCamera);
  for (const node of [referenceStaff, consent]) node.addEventListener('change', controls);
  referenceForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!referenceStaff.value || !referenceFile.files[0] || !consent.checked) { referenceFeedback.textContent = 'Select the staff member and reference photo, and confirm authorization.'; return; }
    busy = true; controls();
    await runAction(null, referenceFeedback, async () => {
      await api.post('/api/gate/face/reference', { staffId: referenceStaff.value, image: await fileImage(referenceFile.files[0]), consent: true });
      referenceFile.value = ''; consent.checked = false; await load();
    }, { success: 'Staff reference picture saved. Check the attraction permission below.' });
    busy = false; controls();
  });
  capture.addEventListener('click', async () => {
    if (busy || capture.disabled) return;
    busy = true; controls(); const gen = cameraGeneration;
    await runAction(null, referenceFeedback, async () => {
      const images = [];
      for (let i = 0; i < 3; i++) { referenceFeedback.textContent = `Capturing live sample ${i + 1} of 3…`; await new Promise((resolve) => setTimeout(resolve, 650)); if (destroyed || gen !== cameraGeneration) throw new Error('Camera capture stopped.'); images.push(snapshot()); }
      await api.post('/api/gate/face/enroll', { staffId: referenceStaff.value, images, consent: true }); consent.checked = false; await load();
    }, { success: 'Live staff reference saved.' });
    busy = false; controls();
  });
  stationForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (await runAction(stationSave, stationFeedback, () => api.post('/api/gate/station', { zoneId: Number(stationSelect.value) }), { success: 'Staff authentication is now fixed to this gate.' })) await load();
  });
  grantForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (await runAction(grantSave, grantFeedback, () => api.post('/api/gate/permissions', { staffId: grantStaff.value, zoneId: Number(grantZone.value), active: true, expiresAt: expires.value ? new Date(expires.value).toISOString() : null }), { success: 'Attraction permission saved.' })) await load();
  });
  demoForm.addEventListener('submit', async (event) => {
    event.preventDefault(); demoButton.disabled = true;
    try {
      demoTitle.textContent = 'Comparing the picture…';
      const input = { zoneId: Number(demoZone.value), ...(demoFile.files[0] ? { image: await fileImage(demoFile.files[0]) } : { staffId: demoStaff.value }) };
      const r = await api.post('/api/gate/face/demo/compare', input);
      demoTitle.textContent = r.authorized ? `Face matched and authorized — ${r.staff.name}` : r.recognized ? `Face matched — ${r.staff.name}; gate permission missing` : 'Face not recognized';
      demoMessage.textContent = `${r.instruction}${r.similarity !== undefined ? ` Similarity: ${r.similarity.toFixed(3)}.` : ''} Demonstration only: no gate command was sent.`;
      demoResult.classList.toggle('is-open', r.authorized); demoResult.classList.toggle('is-unknown', r.recognized && !r.authorized);
    } catch (error) { demoTitle.textContent = 'Comparison not completed'; demoMessage.textContent = error.message; demoResult.classList.remove('is-open'); }
    finally { demoButton.disabled = false; }
  });
  reviewToggle.addEventListener('click', () => ctx.navigate(`#/staff${pendingOnly ? '' : '?pending=1'}`, { replace: true }));
  function fill(select, rows, label) {
    const key = JSON.stringify(rows); if (select.dataset.options === key) return;
    const value = select.value; const placeholder = select.options[0].textContent;
    clear(select, el('option', { value: '' }, placeholder), rows.map((row) => el('option', { value: row.id }, label(row)))); select.value = value; select.dataset.options = key;
  }
  async function load() {
    const seq = ++sequence;
    try {
      const [next, nextFace, nextStation] = await Promise.all([api.get(`/api/gate?pending=${pendingOnly ? '1' : '0'}`), api.get('/api/gate/face/status?view=admin'), api.get('/api/gate/station')]);
      if (destroyed || seq !== sequence) return;
      data = next; face = nextFace; station = nextStation;
      health.textContent = face.available ? `Face recognition ready · ${data.pending} gate review${data.pending === 1 ? '' : 's'} pending` : face.reason;
      if (!busy) fill(referenceStaff, data.staff, (s) => `${s.name} (${s.id})`);
      for (const select of [stationSelect, grantZone, demoZone]) fill(select, data.zones, (z) => `${z.name} · ${z.area_name}`);
      fill(grantStaff, data.staff, (s) => s.name);
      const enrolled = face.profiles.filter((p) => p.active && p.staff_active).map((p) => ({ id: p.staff_id, name: p.name }));
      fill(demoStaff, enrolled, (p) => p.name);
      if (!demoStaff.value && enrolled.length === 1) demoStaff.value = enrolled[0].id;
      if (!stationSelect.value) stationSelect.value = String(station.zone?.id || '');
      if (!demoZone.value) demoZone.value = String(station.zone?.id || '');
      stationLabel.textContent = station.zone ? `Staff page gate: ${station.zone.name} · ${station.zone.area_name}` : 'No station gate configured. Select one before staff authenticate.';
      demoSection.hidden = face.mode !== 'simulated';
      if (requestedStaff && !busy) { referenceStaff.value = requestedStaff; grantStaff.value = requestedStaff; requestedStaff = ''; referenceSection.scrollIntoView({ block: 'start' }); }
      renderGallery(); renderGrants(); renderReviews(); controls();
    } catch (error) { if (!destroyed && seq === sequence) health.textContent = error.message; }
  }
  function renderGallery() {
    clear(gallery, face.profiles.length ? face.profiles.map((p) => {
      const feedback = el('span', { class: 'form-status', 'aria-live': 'polite' });
      const erase = el('button', { class: 'btn btn-sm', type: 'button', disabled: !p.active }, 'Erase reference');
      erase.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Erase ${p.name}’s reference?`, body: 'The encrypted face template and saved portrait will be removed. Staff must be registered again before authentication.', confirmLabel: 'Erase reference', tone: 'urgent' }))) return;
        if (await runAction(erase, feedback, () => api.post(`/api/gate/face/${encodeURIComponent(p.staff_id)}/erase`), { success: 'Staff reference erased.' })) await load();
      });
      const portrait = p.portraitUrl ? el('img', { src: p.portraitUrl, class: 'face-profile-portrait', alt: `${p.name} — admin reference picture`, loading: 'lazy' }) : null;
      portrait?.addEventListener('error', () => portrait.remove());
      return el('article', { class: 'gate-record' }, el('strong', {}, p.name), portrait,
        el('span', { class: 'badge' }, !p.active || !p.staff_active ? 'Inactive' : p.enrollment_kind === 'demo_photo' ? 'Demo reference — simulation only' : 'Admin-registered reference'),
        el('p', { class: 'small muted' }, `Updated ${fmtDateTime(p.updated_at)}`), el('div', { class: 'row' }, erase, feedback));
    }) : el('p', { class: 'muted' }, 'No reference pictures registered. Add staff above, then register their photo.'));
  }
  function renderGrants() {
    clear(grantList, data.permissions.length ? data.permissions.map((p) => {
      const revoke = el('button', { class: 'btn btn-sm', type: 'button', disabled: !p.active }, 'Revoke permission');
      const feedback = el('span', { class: 'form-status', 'aria-live': 'polite' });
      revoke.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Revoke ${p.staff_name}’s access?`, body: `${p.zone_name} will deny future entries for this staff member.`, confirmLabel: 'Revoke permission', tone: 'urgent' }))) return;
        if (await runAction(revoke, feedback, () => api.post('/api/gate/permissions', { staffId: p.staff_id, zoneId: p.zone_id, active: false }), { success: 'Permission revoked.' })) await load();
      });
      return el('div', { class: 'gate-record' }, el('strong', {}, `${p.staff_name} · ${p.zone_name}`), el('p', {}, p.effective ? 'Authorized for this attraction' : 'Revoked, expired or inactive'), el('div', { class: 'row' }, revoke, feedback));
    }) : el('p', { class: 'muted' }, 'No staff attraction permissions configured. A face match alone does not grant gate access.'));
  }
  function renderReviews() {
    clear(reviewList, data.attempts.length ? data.attempts.map((a) => {
      const review = el('button', { class: 'btn btn-sm', type: 'button' }, 'Record admin review');
      const feedback = el('span', { class: 'form-status', 'aria-live': 'polite' });
      review.addEventListener('click', async () => {
        const note = el('textarea', { id: `review-${a.id}`, rows: '3', maxlength: '500' });
        if (!(await confirmDialog({ title: `Review gate attempt #${a.id}`, body: field(note.id, 'Admin review note', note), confirmLabel: 'Save review' }))) return;
        if (await runAction(review, feedback, () => api.post(`/api/gate/attempts/${a.id}/review`, { note: note.value.trim() }), { success: 'Admin review recorded.' })) await load();
      });
      return el('article', { class: `gate-record${a.decision === 'denied' ? ' is-denied' : ''}` },
        el('div', { class: 'row between' }, el('strong', {}, a.staff_name || a.claimed_staff_id || 'Unrecognized visitor'), el('span', { class: 'badge' }, a.decision === 'allowed' ? 'Authorized' : a.reviewed_at ? 'Reviewed' : 'Needs review')),
        el('p', {}, `${a.zone_name} · ${REASONS[a.reason] || a.reason.replaceAll('_', ' ')}`),
        el('p', { class: 'small muted' }, `#${a.id} · ${fmtDateTime(a.created_at)} · ${a.checked_by_name}`),
        a.reviewed_at ? el('p', {}, a.review_note) : a.decision === 'denied' ? el('div', { class: 'row' }, review, feedback) : null);
    }) : el('p', { class: 'muted' }, 'No gate attempts match this view.'));
  }
  function visibility() { if (document.hidden) stopCamera(); else load(); }
  document.addEventListener('visibilitychange', visibility);
  const poll = setInterval(() => { if (!document.hidden && !busy) load(); }, 5000);
  load();
  return { onParams(params) { requestedStaff = params.staff || ''; pendingOnly = params.pending === '1'; reviewToggle.setAttribute('aria-pressed', String(pendingOnly)); load(); },
    destroy() { destroyed = true; clearInterval(poll); document.removeEventListener('visibilitychange', visibility); stopCamera(); people?.destroy?.(); } };
}
