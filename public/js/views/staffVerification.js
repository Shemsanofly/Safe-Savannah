import { api, clear, el, icon } from '../lib.js';

// This page authenticates an arrival. It never loads enrollment, gallery or demo controls.
/** A guide's tour group linked to this entry (see Tour groups). */
const tourLine = (g) => g ? ` Tour group: ${g.name} (${g.operator}) is now in the park here · ${g.declared} declared, ${g.registered} registered in the app.` : '';

export function mount(main) {
  let destroyed = false;
  let stream = null;
  let station = null;
  let ready = false;
  let running = false;
  let busy = false;
  let activating = false;
  let generation = 0;
  let session = null;
  let heldFrame = null;
  let heldAt = 0;
  let timer = null;
  let resumeAt = 0;
  let loadSeq = 0;
  const video = el('video', { class: 'gate-video', autoplay: true, playsinline: true, 'aria-label': 'Staff authentication camera' });
  video.muted = true;
  const location = el('p', { class: 'station-location' }, 'Loading the admin-configured gate…');
  const service = el('p', { class: 'muted small' }, 'Checking face authentication…');
  const title = el('h2', {}, 'Ready to authenticate');
  const message = el('p', {}, 'Face the camera to compare against the staff reference picture saved by an admin.');
  const result = el('section', { class: 'authentication-result', 'aria-live': 'polite' }, title, message);
  const count = el('input', { id: 'staff-tourist-count', type: 'number', min: '0', max: '60', value: '0', inputmode: 'numeric' });
  const start = el('button', { class: 'btn btn-primary btn-lg', type: 'button', disabled: true }, icon('camera'), 'Start face authentication');
  const stop = el('button', { class: 'btn', type: 'button', disabled: true }, 'Stop camera');
  main.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Staff face authentication'),
    el('p', { class: 'sub' }, 'Authenticate against the reference picture registered by an admin.'))),
    location, service,
    el('div', { class: 'gate-grid' }, el('section', { class: 'panel' }, el('div', { class: 'panel-body stack' }, video, el('div', { class: 'row' }, start, stop))),
      el('div', { class: 'stack' }, result, el('div', { class: 'panel panel-body stack' },
        el('div', { class: 'field' }, el('label', { for: count.id }, 'Accompanying tourists (declared)'), count),
        el('p', { class: 'small muted' }, 'The admin selects this gate and manages staff access. Ask an admin if your picture or permission needs updating.')))));
  function show(heading, detail, state = '') { title.textContent = heading; message.textContent = detail; result.className = `authentication-result ${state}`; }
  function live() { return !!stream?.getVideoTracks().some((t) => t.readyState === 'live') && video.readyState >= 2 && !video.paused; }
  function controls() {
    start.disabled = destroyed || activating || running || busy || !ready || !station?.zone || !Number.isInteger(Number(count.value)) || Number(count.value) < 0 || Number(count.value) > 60;
    stop.disabled = !stream && !running && !activating;
    count.disabled = running || busy;
  }
  async function cancel() {
    const id = session; session = null; heldFrame = null;
    if (id) await api.post('/api/gate/face/cancel', { challengeId: id }).catch(() => undefined);
  }
  async function stopCamera() {
    generation++; running = false; activating = false; clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop()); stream = null; video.srcObject = null;
    await cancel();
    if (!destroyed) show('Camera stopped', 'Start face authentication when you are ready.');
    controls();
  }
  function frame() {
    if (!live()) throw new Error('The camera is unavailable.');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .86).split(',')[1];
  }
  function schedule(ms = 800) { clearTimeout(timer); if (running && !destroyed) timer = setTimeout(scan, ms); }
  async function scan() {
    if (busy || destroyed || !running) return;
    if (!live()) return stopCamera();
    if (Date.now() < resumeAt) { schedule(1000); return; }
    const gen = generation;
    busy = true; controls();
    try {
      if (!session) {
        const opened = await api.post('/api/gate/face/begin', { touristCount: Number(count.value) });
        if (gen !== generation || !running) { await api.post('/api/gate/face/cancel', { challengeId: opened.challengeId }).catch(() => undefined); return; }
        session = opened.challengeId;
      }
      if (heldFrame && Date.now() - heldAt > 4000) heldFrame = null;
      const image = heldFrame || frame();
      const r = await api.post('/api/gate/face/scan', { challengeId: session, image });
      if (destroyed || gen !== generation) return;
      if (r.state === 'complete') {
        const command = r.gate?.lastCommand;
        if (command?.status === 'failed' || command?.status === 'unknown') show('Face authenticated — gate needs review', 'Your identity matched, but the opening could not be confirmed. Ask the gate attendant.', 'is-warning');
        else show(`Authenticated${r.guide?.name ? ` — ${r.guide.name}` : ''}`, `${r.instruction || 'Your face and gate permission were verified.'}${tourLine(r.tourGroup)}`, 'is-authenticated');
        session = null; heldFrame = null; resumeAt = Date.now() + 10000;
      } else if (r.state === 'denied') {
        show(r.faceMatched ? 'Face matched — gate access not granted' : 'Face not authenticated', r.instruction, r.faceMatched ? 'is-warning' : 'is-denied');
        session = null; heldFrame = null; resumeAt = Date.now() + 10000;
      } else {
        show(r.guide?.name ? `Face matched — ${r.guide.name}` : 'Checking your face', r.instruction || 'Look toward the camera.');
        if (r.state === 'waiting_sensor') { if (!heldFrame) heldAt = Date.now(); heldFrame = image; }
        else heldFrame = null;
      }
    } catch (error) {
      if (!destroyed && gen === generation) {
        if (error.status === 410) { session = null; heldFrame = null; }
        else {
          show('Authentication not completed', error.message, 'is-warning');
          await cancel(); resumeAt = Date.now() + 5000;
          if ([401, 403, 503].includes(error.status)) running = false;
        }
      }
    } finally { busy = false; controls(); schedule(); }
  }
  start.addEventListener('click', async () => {
    activating = true; controls();
    const gen = ++generation;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires localhost or HTTPS and a connected camera.');
      if (!live()) {
        const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
        if (destroyed || gen !== generation) { next.getTracks().forEach((t) => t.stop()); return; }
        stream = next; video.srcObject = stream;
        stream.getTracks().forEach((t) => t.addEventListener('ended', stopCamera, { once: true }));
        await video.play();
      }
      if (gen !== generation || destroyed) return;
      running = true; show('Look toward the camera', 'Your face will be compared with the admin’s saved staff picture.'); scan();
    } catch (error) { show('Camera unavailable', error.message, 'is-warning'); }
    finally { activating = false; controls(); }
  });
  stop.addEventListener('click', stopCamera);
  count.addEventListener('input', controls);
  async function load() {
    const sequence = ++loadSeq;
    try {
      const next = await api.get('/api/gate/station');
      const face = await api.get(`/api/gate/face/status?view=verification${next.zone ? `&zoneId=${next.zone.id}` : ''}`);
      if (destroyed || sequence !== loadSeq) return;
      if (station?.zone?.id && station.zone.id !== next.zone?.id && running) await stopCamera();
      station = next; ready = face.available;
      location.textContent = next.zone ? `Gate: ${next.zone.name} · ${next.zone.area_name}` : 'This station has no gate configured. Ask an admin to select one in Staff management.';
      service.textContent = face.available ? 'Face authentication ready. Staff records and reference photos are managed by admins.' : face.reason;
      controls();
    } catch (error) {
      if (destroyed || sequence !== loadSeq) return;
      ready = false; service.textContent = error.message;
      if (running) { running = false; clearTimeout(timer); await cancel(); }
      controls();
    }
  }
  function visibility() { if (document.hidden) stopCamera(); else load(); }
  document.addEventListener('visibilitychange', visibility);
  const poll = setInterval(() => { if (!document.hidden) load(); }, 5000);
  load();
  return { destroy() { destroyed = true; clearInterval(poll); document.removeEventListener('visibilitychange', visibility); stopCamera(); } };
}
