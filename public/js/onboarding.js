import { BOOT, el, icon } from './lib.js';

export function staffIntro(main) {
  const key = `ss-intro-staff-v1:${BOOT.operator.id}`;
  try { if (localStorage.getItem(key)) return; } catch { /* storage is optional */ }
  const close = el('button', { type: 'button', class: 'btn btn-sm' }, 'Got it');
  const intro = el('section', { class: 'onboarding', 'aria-labelledby': 'intro-title' },
    el('div', { class: 'row between' }, el('h2', { id: 'intro-title' }, icon('shield'), 'Start your shift'), close),
    el('p', {}, 'Check urgent incidents on the live map, claim a response, and coordinate by radio.'),
    el('p', {}, 'At an attraction gate, open Staff gate access. The camera recognizes an enrolled, authorized guide to trigger one entry for the guide and the declared tourist group.'),
    el('div', { class: 'row' }, el('a', { href: '#/access', class: 'btn btn-sm' }, 'Staff gate access'), el('a', { href: '#/help', class: 'btn btn-sm btn-ghost' }, 'Read the guide')));
  close.addEventListener('click', () => {
    try { localStorage.setItem(key, '1'); } catch { /* storage is optional */ }
    intro.remove();
  });
  main.prepend(intro);
}
