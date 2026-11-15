// Gate camera: the fixed camera on the guest path, live — plus a banner if a gate alert is waiting.
import { createCameraFeed } from '../camera.js';
import { age, clear, el, icon } from '../lib.js';

export function mount(main) {
  const attention = el('div', { class: 'attention', role: 'alert', hidden: true });
  const camera = createCameraFeed();
  main.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Gate camera'), el('p', { class: 'sub' }, 'The fixed camera on the guest path, live.'))),
    attention,
    camera.root,
  );

  return {
    update(s) {
      const o = s.overview;
      if (!o) return;
      const open = o.activeIncidents.filter((e) => e.kind === 'zone_alert' && e.status === 'open');
      attention.hidden = !open.length;
      if (open.length) {
        const e = open[0];
        clear(attention, icon('incident', 'icon icon-lg'),
          el('div', { class: 'grow' }, el('strong', {}, `${e.ref}: possible elephant at ${e.zone_label}`), el('p', { class: 'small' }, `Waiting ${age(e.opened_at)}.`)),
          el('a', { class: 'btn', href: `#/incidents/${e.id}` }, 'Open'));
      }
      camera.update(o.cameras[0] || null, o.zones);
    },
    destroy() {
      camera.destroy();
    },
  };
}
