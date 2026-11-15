// Leaflet map helper. Leaflet is served from this server (no CDN); only the tiles need internet.
import { el, fmtDateTime, icon } from './lib.js';

let loading = null;
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  loading ??= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/static/vendor/leaflet/leaflet.css';
    document.head.append(css);
    const s = document.createElement('script');
    s.src = '/static/vendor/leaflet/leaflet.js';
    s.onload = () => resolve(window.L);
    s.onerror = () => reject(new Error('Map library could not be loaded'));
    document.head.append(s);
  });
  return loading;
}

const SENS_COLOR = { high: '#a4231b', medium: '#c88a1f', low: '#4f7a63' };
export const RISK_COLOR = { none: '#8b9389', low: '#4f7a63', medium: '#c88a1f', high: '#d0521f', critical: '#a4231b' };

/** Create a map in `container`. Returns helpers to draw layers. */
export async function createMap(container, { center = [-3.2, 35.3], zoom = 7 } = {}) {
  const L = await loadLeaflet();
  const wrap = el('div', { class: 'map-wrap' });
  const node = el('div', { class: container.dataset.size === 'sm' ? 'map map-sm' : 'map', role: 'region', 'aria-label': 'Map of safety zones, cameras and incidents' });
  const note = el('div', { class: 'map-note', hidden: true });
  wrap.append(node, note);
  container.replaceChildren(wrap);
  const map = L.map(node, { zoomControl: true, attributionControl: true }).setView(center, zoom);
  let tileErrors = 0;
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' })
    .on('tileerror', () => {
      tileErrors += 1;
      if (tileErrors === 3) {
        note.hidden = false;
        note.textContent = 'Map background unavailable (offline?). Zones, cameras and incidents are still drawn in the right places.';
      }
    })
    .addTo(map);
  const layers = { zones: L.layerGroup().addTo(map), cameras: L.layerGroup().addTo(map), detections: L.layerGroup().addTo(map), incidents: L.layerGroup().addTo(map), draft: L.layerGroup().addTo(map) };
  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(node);

  const divIcon = (cls, iconId, size = 28, label = '') =>
    L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html: `<div class="mk ${cls}">${iconId ? `<svg class="icon" aria-hidden="true"><use href="#i-${iconId}"></use></svg>` : label}</div>` });

  return {
    L,
    map,
    node,
    layers,
    destroy() {
      ro.disconnect();
      map.remove();
    },
    drawZones(zones, { onClick } = {}) {
      layers.zones.clearLayers();
      for (const z of zones) {
        const color = SENS_COLOR[z.sensitivity] || '#4f7a63';
        const poly = L.polygon(z.geometry, { color, weight: 2, dashArray: z.active === false ? '4 6' : null, fillOpacity: 0.12 });
        poly.bindTooltip(`${escapeHtml(z.name)} · ${z.sensitivity} sensitivity · alert distance ${z.buffer_m} m`, { sticky: true });
        if (onClick) poly.on('click', () => onClick(z));
        poly.addTo(layers.zones);
      }
    },
    drawCameras(cameras) {
      layers.cameras.clearLayers();
      for (const c of cameras) {
        if (c.lat === null || c.lng === null) continue;
        const sim = c.station_kind === 'simulated';
        L.marker([c.lat, c.lng], { icon: divIcon(`mk-cam ${sim ? 'is-sim' : ''}`, 'camera', 26), title: c.label, keyboard: false })
          .bindPopup(`<strong>${escapeHtml(c.label)}</strong><br>${sim ? 'Simulated camera station' : 'Camera station'}`)
          .addTo(layers.cameras);
      }
    },
    drawDetections(dets) {
      layers.detections.clearLayers();
      for (const d of dets) {
        if (d.lat === null || d.lng === null) continue;
        L.circleMarker([d.lat, d.lng], { radius: d.risk_level === 'none' ? 4 : 6, color: '#fff', weight: 1.5, fillColor: RISK_COLOR[d.risk_level], fillOpacity: 0.9 })
          .bindTooltip(`${escapeHtml(d.species || 'unknown')} · ${d.risk_level} risk · ${d.analysis === 'simulated' ? 'SIMULATED' : 'model'} · ${fmtDateTime(d.captured_at)}`)
          .addTo(layers.detections);
      }
    },
    drawIncidents(incidents, { onClick } = {}) {
      layers.incidents.clearLayers();
      for (const i of incidents) {
        if (i.lat === null || i.lng === null) continue;
        const cls = i.kind === 'sos' ? `mk-sos ${i.status === 'acknowledged' ? 'is-ack' : ''}` : `mk-inc r-${i.risk_level || 'high'} ${i.status === 'open' ? 'is-open' : ''}`;
        const m = L.marker([i.lat, i.lng], { icon: divIcon(cls, i.kind === 'sos' ? 'siren' : 'paw', 34), title: `${i.ref} ${i.title || ''}`, zIndexOffset: 1000 });
        m.bindPopup(`<strong>${escapeHtml(i.ref)}</strong> ${escapeHtml(i.title || '')}<br>${i.status === 'open' ? 'Pending' : 'Responding'}${i.acknowledged_by_name ? ` — ${escapeHtml(i.acknowledged_by_name)}` : ''}<br><a href="#/incidents/${i.id}">Open incident</a>`);
        if (onClick) m.on('click', () => onClick(i));
        m.addTo(layers.incidents);
      }
    },
    fitTo(points) {
      const pts = points.filter((p) => p && Number.isFinite(p[0]));
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15 });
    },
  };
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function legend() {
  return el('div', { class: 'map-legend', 'aria-label': 'Map legend' },
    el('span', {}, el('i', { class: 'lg-swatch', dataset: { c: 'high' } }), 'Safety zone'),
    el('span', {}, el('i', { class: 'lg-dot lg-crit' }), 'Critical'),
    el('span', {}, el('i', { class: 'lg-dot lg-hi' }), 'High'),
    el('span', {}, el('i', { class: 'lg-dot lg-me' }), 'Medium'),
    el('span', {}, icon('siren', 'icon icon-sm'), 'SOS'),
    el('span', {}, icon('camera', 'icon icon-sm'), 'Camera'));
}
