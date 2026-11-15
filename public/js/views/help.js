// Guide: the operator workflow and what every status means.
import { el, icon } from '../lib.js';
import { FEED, INCIDENT, SOURCE, ZONE, badge, smsBadge, SMS } from '../status.js';

export function mount(main) {
  const gloss = (defs) => el('div', { class: 'glossary' }, Object.entries(defs).map(([, d]) => el('div', { class: 'gloss-item' }, badge(d), el('span', {}, d.explain))));
  main.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Guide'), el('p', { class: 'sub' }, 'How to handle an alert, and what each label means.'))),
    el('div', { class: 'alert alert-warn' }, icon('alert'), el('div', { class: 'grow' },
      el('strong', {}, 'This system can only warn, never reassure. '),
      'A camera can miss an elephant, and a camera that is not live sees nothing. "No active incidents" never means a path is safe. Your radio procedure always comes first.')),
    el('section', { class: 'section', 'aria-labelledby': 'wf-title' },
      el('h2', { id: 'wf-title', class: 'section-head' }, 'When an alert opens'),
      el('ol', { class: 'guide-steps' },
        el('li', {}, el('strong', {}, 'Acknowledge it. '), 'Press ', el('em', {}, 'Acknowledge — I take ownership'), ' on the Overview or the incident page. Everyone can then see that you own it. If someone else got there first, you will be told who.'),
        el('li', {}, el('strong', {}, 'Verify. '), 'Look at the snapshot and the live camera. Check whether it really is an elephant and whether it is near the guest path.'),
        el('li', {}, el('strong', {}, 'Follow your radio procedure. '), 'Contact guides, rangers or the lodge as your procedure says. Log each contact with ', el('em', {}, 'Log handoff'), ' (radio, phone or in person) and a short note of what was agreed.'),
        el('li', {}, el('strong', {}, 'Close it. '), 'When the situation is resolved, choose ', el('em', {}, 'Close incident'), ' and write what you verified. If it was not an elephant, choose ', el('em', {}, 'False alert'), ' and say what it was.'),
        el('li', {}, el('strong', {}, 'Watch the system status. '), 'If the camera shows ', el('strong', {}, 'Reconnecting, Stale or Offline'), ', the zone is UNKNOWN: tell the duty manager and rely on people and radio until it is live again.'))),
    el('section', { class: 'section', 'aria-labelledby': 'g1' }, el('h2', { id: 'g1', class: 'section-head' }, 'Incident states'), gloss(INCIDENT)),
    el('section', { class: 'section', 'aria-labelledby': 'g2' }, el('h2', { id: 'g2', class: 'section-head' }, 'Camera feed'), gloss(FEED)),
    el('section', { class: 'section', 'aria-labelledby': 'g3' }, el('h2', { id: 'g3', class: 'section-head' }, 'Zone status'), gloss(ZONE)),
    el('section', { class: 'section', 'aria-labelledby': 'g4' }, el('h2', { id: 'g4', class: 'section-head' }, 'SMS states'),
      el('div', { class: 'glossary' }, Object.keys(SMS).map((s) => el('div', { class: 'gloss-item' }, smsBadge(s), el('span', {}, SMS[s].explain))))),
    el('section', { class: 'section', 'aria-labelledby': 'g5' }, el('h2', { id: 'g5', class: 'section-head' }, 'Where an alert came from'), gloss(SOURCE),
      el('p', { class: 'small muted', style: null }, el('span', { class: 'badge tone-mock' }, 'Mock'), ' marks SMS that were stored by the demo adapter instead of being sent to a phone.')),
    el('section', { class: 'section', 'aria-labelledby': 'g6' }, el('h2', { id: 'g6', class: 'section-head' }, 'Keyboard'),
      el('ul', {}, el('li', {}, el('kbd', {}, 'Tab'), ' moves between controls; a visible amber ring shows where you are.'),
        el('li', {}, 'On an incident, use ', el('kbd', {}, '←'), ' ', el('kbd', {}, '→'), ' to switch between Log handoff, Close, False alert and Add note.'),
        el('li', {}, el('kbd', {}, 'Esc'), ' closes dialogs and the account menu.'))),
  );
  return {};
}
