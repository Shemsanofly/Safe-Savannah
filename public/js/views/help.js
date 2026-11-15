// Guide: the operator workflow and what every status means.
import { el, icon } from '../lib.js';
import { FEED, INCIDENT, SOURCE, badge } from '../status.js';

export function mount(main) {
  const gloss = (defs) => el('div', { class: 'glossary' }, Object.entries(defs).map(([, d]) => el('div', { class: 'gloss-item' }, badge(d), el('span', {}, d.explain))));
  main.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Guide'), el('p', { class: 'sub' }, 'Handling an alert in four steps.'))),
    el('div', { class: 'alert alert-warn' }, icon('alert'), el('div', { class: 'grow' },
      el('strong', {}, 'This system can only warn, never reassure. '),
      'Cameras can miss animals. Your radio procedure always comes first.')),
    el('section', { class: 'section', 'aria-labelledby': 'wf-title' },
      el('h2', { id: 'wf-title', class: 'section-head' }, 'When an alert opens'),
      el('ol', { class: 'guide-steps' },
        el('li', {}, el('strong', {}, 'Take it. '), 'Press ', el('em', {}, "I'm responding"), ' on the live map or the incident page, so everyone knows you have it.'),
        el('li', {}, el('strong', {}, 'Check. '), 'Look at the photo, the map and the details. For an SOS, call the person back.'),
        el('li', {}, el('strong', {}, 'Use your radio. '), 'Coordinate as usual and log each contact with ', el('em', {}, 'Log handoff'), '.'),
        el('li', {}, el('strong', {}, 'Resolve it. '), 'Choose ', el('em', {}, 'Resolve'), ' (or ', el('em', {}, 'False alarm'), ') and write one line about what happened.'))),
    el('section', { class: 'section', 'aria-labelledby': 'g1' }, el('h2', { id: 'g1', class: 'section-head' }, 'Incident states'), gloss(INCIDENT)),
    el('section', { class: 'section', 'aria-labelledby': 'g2' }, el('h2', { id: 'g2', class: 'section-head' }, 'Camera feed'), gloss(FEED)),
    el('section', { class: 'section', 'aria-labelledby': 'g5' }, el('h2', { id: 'g5', class: 'section-head' }, 'Where an alert came from'), gloss(SOURCE)),
  );
  return {};
}
