// AI monitor: analyse a camera image or wildlife photo, see the risk assessment and any incident it opened.
import { api, clear, el, icon, toast } from '../lib.js';
import { riskBadge } from '../status.js';
import * as store from '../store.js';

export function mount(main) {
  const statusBox = el('div', {});
  const resultBox = el('div', { 'aria-live': 'polite' });
  const file = el('input', { type: 'file', id: 'ai-file', accept: 'image/jpeg,image/png,image/webp', capture: 'environment', class: 'sr-only' });
  const preview = el('img', { class: 'preview-img', alt: 'Selected photo', hidden: true });
  const fileName = el('span', { class: 'small muted' }, 'No photo chosen');
  const drop = el('label', { class: 'dropzone', for: 'ai-file' }, icon('upload', 'icon icon-lg'), el('strong', {}, 'Choose or drop a photo'), el('span', { class: 'small muted' }, 'JPEG, PNG or WebP, up to 8 MB. On a phone this opens the camera.'), fileName);
  const camera = el('select', { id: 'ai-camera', required: true });
  const modeModel = el('input', { type: 'radio', name: 'ai-mode', value: 'model', checked: true });
  const modeSim = el('input', { type: 'radio', name: 'ai-mode', value: 'simulated' });
  const species = el('select', { id: 'ai-species' });
  const conf = el('input', { type: 'text', id: 'ai-conf', inputmode: 'decimal', value: '0.8' });
  const simFields = el('div', { class: 'filters-row', hidden: true },
    el('div', { class: 'field' }, el('label', { for: 'ai-species' }, 'Animal to simulate'), species),
    el('div', { class: 'field' }, el('label', { for: 'ai-conf' }, 'Simulated confidence (0–1)'), conf));
  const err = el('p', { class: 'field-error', hidden: true, role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, icon('cpu'), el('span', {}, 'Analyse'));
  let model = null;

  const form = el('form', { class: 'panel', novalidate: true },
    el('div', { class: 'panel-head' }, el('h2', {}, icon('upload'), 'Analyse a photo')),
    el('div', { class: 'panel-body stack' },
      file, drop, preview,
      el('div', { class: 'field' }, el('label', { for: 'ai-camera' }, 'Where was it taken?'), camera,
        el('p', { class: 'hint' }, "The detection is placed at this camera station's position and compared with that area's safety zones.")),
      el('fieldset', { class: 'choice-group' }, el('legend', { class: 'label' }, 'Analysis'),
        el('label', { class: 'choice' }, modeModel, el('span', {}, icon('cpu', 'icon icon-sm'), 'Run the AI model (real inference)')),
        el('label', { class: 'choice' }, modeSim, el('span', {}, icon('flask', 'icon icon-sm'), 'Simulated detection (demo)'))),
      simFields, err, el('div', { class: 'form-actions' }, submit)));

  main.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'AI monitor'), el('p', { class: 'sub' }, 'Upload a camera image or wildlife photo. The system detects the animal, then scores risk by species, distance to safety zones and who is likely nearby.'))),
    statusBox,
    el('div', { class: 'cols-2 section' }, form, resultBox),
  );

  for (const r of [modeModel, modeSim]) r.addEventListener('change', () => {
    simFields.hidden = !modeSim.checked;
  });
  file.addEventListener('change', () => showFile(file.files?.[0]));
  for (const ev of ['dragover', 'dragenter']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      const dt = new DataTransfer();
      dt.items.add(f);
      file.files = dt.files;
      showFile(f);
    }
  });
  function showFile(f) {
    if (!f) return;
    fileName.textContent = `${f.name} · ${(f.size / 1024 / 1024).toFixed(1)} MB`;
    preview.src = URL.createObjectURL(f);
    preview.hidden = false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const f = file.files?.[0];
    const mode = modeSim.checked ? 'simulated' : 'model';
    const problem = !camera.value ? 'Choose where the photo was taken.' : mode === 'model' && !f ? 'Choose a photo to analyse.' : mode === 'model' && !model?.available ? 'No AI model is installed on this system. Choose "Simulated detection" to demo the workflow.' : f && f.size > 8 * 1024 * 1024 ? 'That photo is larger than 8 MB.' : null;
    if (problem) {
      err.hidden = false;
      clear(err, icon('alert', 'icon icon-sm'), problem);
      return;
    }
    const fd = new FormData();
    fd.append('camera_id', camera.value);
    fd.append('mode', mode);
    if (mode === 'simulated') {
      fd.append('species', species.value);
      fd.append('confidence', conf.value || '0.8');
    }
    if (f) fd.append('photo', f);
    submit.disabled = true;
    const original = [...submit.childNodes];
    submit.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', {}, mode === 'model' ? 'Running model…' : 'Saving…'));
    clear(resultBox, el('div', { class: 'panel' }, el('div', { class: 'view-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Analysing…')));
    try {
      const res = await fetch('/api/ai/analyze', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Analysis failed (HTTP ${res.status})`);
      renderResult(data);
      store.refresh();
      if (data.incident?.created) toast(`${data.incident.ref} opened: rangers are being alerted.`);
    } catch (e2) {
      clear(resultBox, el('div', { class: 'alert alert-error', role: 'alert' }, icon('alert'), e2.message));
    } finally {
      submit.disabled = false;
      submit.replaceChildren(...original);
    }
  });

  function renderResult(r) {
    const sim = r.analysis === 'simulated';
    clear(resultBox, el('section', { class: 'panel', 'aria-labelledby': 'res-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'res-title' }, icon('target'), 'Result'),
        sim ? el('span', { class: 'badge tone-sim' }, icon('flask'), 'SIMULATED — not model output') : el('span', { class: 'badge tone-real' }, icon('cpu'), `Real model · ${r.model}`)),
      el('div', { class: 'panel-body stack' },
        r.imageUrl ? el('a', { href: r.imageUrl, target: '_blank', rel: 'noopener' }, el('img', { src: r.imageUrl, alt: 'Analysed photo with detection boxes', class: 'preview-img' })) : null,
        r.species
          ? el('p', { class: 'strong' }, `${r.species[0].toUpperCase() + r.species.slice(1)} — ${Math.round(r.confidence * 100)}% confidence`)
          : el('div', { class: 'alert alert-warn' }, icon('info'), el('div', {}, el('strong', {}, 'No wildlife species recognised. '),
              r.others?.length ? `The model saw: ${r.others.map((o) => `${o.label} ${Math.round(o.confidence * 100)}%`).join(', ')} — these are not mapped to a wildlife species.` : 'Nothing animal-like was found.',
              model && !model.recognises.length ? '' : ` This model can name: ${model?.recognises.join(', ') || '—'}.`)),
        el('div', { class: 'row' }, el('span', { class: 'strong' }, 'Risk:'), riskBadge(r.risk.level, { pill: true }),
          r.risk.zone ? el('span', { class: 'muted small' }, r.risk.distanceM === 0 ? `inside ${r.risk.zone}` : `${r.risk.distanceM} m from ${r.risk.zone}`) : null),
        el('ul', { class: 'reasons' }, r.risk.reasons.map((x) => el('li', {}, x))),
        r.incident
          ? el('div', { class: 'alert alert-error' }, icon('incident'), el('div', { class: 'grow' }, el('strong', {}, `${r.incident.ref} ${r.incident.created ? 'opened' : r.incident.escalated ? 'escalated' : 'updated (same camera and zone already active)'}. `), 'Rangers in this area are alerted.'),
              el('a', { class: 'btn btn-sm', href: `#/incidents/${r.incident.id}` }, 'Open'))
          : el('div', { class: 'alert alert-info' }, icon('info'), 'Logged as a detection. No incident: risk is below medium.'))));
  }

  async function loadStatus() {
    try {
      const s = await api.get('/api/ai/status');
      model = s.model;
      clear(camera, el('option', { value: '' }, 'Choose a camera station…'), s.cameras.map((c) => el('option', { value: c.id }, `${c.label}${c.station_kind === 'simulated' && !/sim/i.test(c.label) ? ' (simulated station)' : ''}`)));
      clear(species, s.species.map((x) => el('option', { value: x.key }, x.name)));
      if (!model.available) {
        modeModel.disabled = true;
        modeSim.checked = true;
        simFields.hidden = false;
      }
      clear(statusBox, model.available
        ? el('div', { class: 'alert alert-info' }, icon('cpu'), el('div', { class: 'grow' },
            el('strong', {}, `Model installed: ${model.modelId}. `), `It can recognise: ${model.recognises.join(', ') || 'no wildlife species'}. `,
            model.cannotRecognise.length ? `It cannot recognise ${model.cannotRecognise.join(', ')} — those need a wildlife-specific model (drop one in via scripts/export_model.py). Until then, use simulated detections for them.` : ''))
        : el('div', { class: 'alert alert-warn' }, icon('alert'), el('div', { class: 'grow' }, el('strong', {}, 'No AI model installed. '), `${model.reason || ''} You can still demonstrate the workflow with simulated detections, which are labelled everywhere.`)));
    } catch (e) {
      clear(statusBox, el('div', { class: 'alert alert-error' }, icon('alert'), e.message));
    }
  }
  loadStatus();
  clear(resultBox, el('div', { class: 'panel' }, el('div', { class: 'empty' }, icon('cpu'), el('strong', {}, 'Results appear here'), el('p', {}, 'Each analysis is saved as a detection. Medium risk or above opens an incident and alerts rangers.'))));
  return {};
}
