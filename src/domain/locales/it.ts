import type { Catalog } from '../i18n.js';

// Machine-assisted translation: have a native speaker review before production use.
// SMS templates use a straight apostrophe and avoid capital "È" so they stay in the GSM-7 character set.
export const it: Catalog = {
  species: {
    lion: 'Leone', leopard: 'Leopardo', buffalo: 'Bufalo cafro', hippo: 'Ippopotamo', elephant: 'Elefante', rhino: 'Rinoceronte', crocodile: 'Coccodrillo',
    hyena: 'Iena maculata', cheetah: 'Ghepardo', baboon: 'Babbuino', giraffe: 'Giraffa', zebra: 'Zebra', wildebeest: 'Gnu', antelope: 'Antilope',
  },
  unknownAnimal: 'Animale sconosciuto',
  actions: {
    generic: ['Resti nel veicolo, nella tenda o nella camera finché i ranger non dicono che è sicuro.', 'Non si avvicini all’animale a piedi, non gli dia da mangiare e non lo fotografi.', 'Segua le istruzioni della guida o del personale del lodge.'],
    extra: {
      elephant: 'Stia ad almeno 50 metri dagli elefanti. Non si metta mai tra una madre e il suo piccolo.',
      lion: 'Non scappi mai davanti a un leone. Resti in gruppo e dopo il tramonto attenda un accompagnatore.',
      buffalo: 'Il bufalo può caricare senza preavviso. Stia ben lontano dalla boscaglia fitta.',
      hippo: 'Stia lontano dalla riva, soprattutto al crepuscolo e di notte.',
      leopard: 'Tenga i bambini vicino a sé e resti al chiuso dopo il tramonto.',
      crocodile: 'Non si fermi e non si lavi sulla riva.',
    },
  },
  alertTitle: (animal, place, simulated) => `Segnalazione: ${animal} vicino a ${place}${simulated ? ' (test simulato)' : ''}`,
  alertBody: (animal) => `I ranger sono stati avvisati e stanno verificando. Questo animale (${animal}) può essere pericoloso per chi si sposta a piedi.`,
  alertSms: ({ tag, simulated, animal, place, line }) =>
    `Safe Savannah${tag}${simulated ? ' (SIMULAZIONE)' : ''}: ${animal} vicino a ${place}. Resti nel veicolo, in tenda o in camera e segua le istruzioni del personale. Emergenze: ${line}`,
  sosReceived: (ref, line) => `Safe Savannah: abbiamo ricevuto il suo SOS (${ref}). I ranger sono stati avvisati. Se può, chiami anche il ${line}.`,
  sosResponding: (ref, ranger) => `Safe Savannah ${ref}: il ranger ${ranger} sta rispondendo al suo SOS. Se possibile, resti in un luogo sicuro.`,
  sosResolved: (ref, ranger) => `Safe Savannah ${ref}: il suo SOS è stato segnato come risolto da ${ranger}.`,
  rollCallReason: (animal, place) => `${animal} vicino a ${place}`,
  safetyCheck: (lodge) => `Controllo di sicurezza presso ${lodge}`,
  rollCallSms: ({ tag, reason, lodge, line }) =>
    `Safe Savannah${tag}: ${reason}. ${lodge} sta verificando ogni ospite. Si trova al sicuro? Risponda 1 (al sicuro) o 2 (serve aiuto). Resti all'interno. Emergenze: ${line}`,
  allClearTitle: (place, simulated) => `Cessato allarme vicino a ${place}${simulated ? ' (test simulato)' : ''}`,
  allClearBody: (falseAlarm) => (falseAlarm
    ? 'I ranger hanno verificato: era un falso allarme. Può riprendere i suoi programmi. Continui a seguire la sua guida.'
    : 'I ranger hanno controllato la zona. Può riprendere i suoi programmi. Continui a seguire la sua guida e resti vigile.'),
  allClearSms: ({ tag, place }) => `Safe Savannah${tag}: cessato allarme vicino a ${place}. I ranger hanno controllato la zona. Continui a seguire la sua guida.`,
};
