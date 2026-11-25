import type { Catalog } from '../i18n.js';

export const de: Catalog = {
  species: {
    lion: 'Löwe', leopard: 'Leopard', buffalo: 'Kaffernbüffel', hippo: 'Flusspferd', elephant: 'Elefant', rhino: 'Nashorn', crocodile: 'Krokodil',
    hyena: 'Tüpfelhyäne', cheetah: 'Gepard', baboon: 'Pavian', giraffe: 'Giraffe', zebra: 'Zebra', wildebeest: 'Gnu', antelope: 'Antilope',
  },
  unknownAnimal: 'Unbekanntes Tier',
  actions: {
    generic: ['Bleiben Sie in Ihrem Fahrzeug, Zelt oder Zimmer, bis die Ranger sagen, dass es sicher ist.', 'Nähern Sie sich dem Tier nicht zu Fuß, und füttern oder fotografieren Sie es nicht.', 'Befolgen Sie die Anweisungen Ihres Guides oder des Lodge-Personals.'],
    extra: {
      elephant: 'Halten Sie mindestens 50 Meter Abstand zu Elefanten. Gehen Sie nie zwischen eine Mutter und ihr Kalb.',
      lion: 'Laufen Sie nie vor einem Löwen weg. Bleiben Sie in der Gruppe und warten Sie nach Einbruch der Dunkelheit auf eine Begleitung.',
      buffalo: 'Büffel können ohne Vorwarnung angreifen. Halten Sie großen Abstand zu dichtem Busch.',
      hippo: 'Halten Sie sich vom Ufer fern, besonders in der Dämmerung und nachts.',
      leopard: 'Halten Sie Kinder bei sich und bleiben Sie nach Einbruch der Dunkelheit drinnen.',
      crocodile: 'Stellen Sie sich nicht ans Ufer und waschen Sie sich dort nicht.',
    },
  },
  alertTitle: (animal, place, simulated) => `${animal} nahe ${place} gemeldet${simulated ? ' (simulierter Test)' : ''}`,
  alertBody: (animal) => `Die Ranger sind alarmiert und prüfen die Lage. ${animal} kann für Menschen zu Fuß gefährlich sein.`,
  alertSms: ({ tag, simulated, animal, place, line }) =>
    `Safe Savannah${tag}${simulated ? ' (SIMULIERT)' : ''}: ${animal} nahe ${place}. Bleiben Sie im Fahrzeug, Zelt oder Zimmer und folgen Sie den Anweisungen des Personals. Notruf: ${line}`,
  sosReceived: (ref, line) => `Safe Savannah: Wir haben Ihr SOS (${ref}) erhalten. Die Ranger sind alarmiert. Rufen Sie wenn möglich auch ${line} an.`,
  sosResponding: (ref, ranger) => `Safe Savannah ${ref}: Ranger ${ranger} kümmert sich um Ihr SOS. Bleiben Sie wenn möglich an einem sicheren Ort.`,
  sosResolved: (ref, ranger) => `Safe Savannah ${ref}: Ihr SOS wurde von ${ranger} als erledigt markiert.`,
  rollCallReason: (animal, place) => `${animal} nahe ${place}`,
  safetyCheck: (lodge) => `Sicherheitscheck: ${lodge}`,
  rollCallSms: ({ tag, reason, lodge, line }) =>
    `Safe Savannah${tag}: ${reason}. ${lodge} fragt bei allen Gästen nach. Sind Sie in Sicherheit? Antworten Sie 1 (sicher) oder 2 (brauche Hilfe). Bleiben Sie drinnen. Notruf: ${line}`,
  allClearTitle: (place, simulated) => `Entwarnung nahe ${place}${simulated ? ' (simulierter Test)' : ''}`,
  allClearBody: (falseAlarm) => (falseAlarm
    ? 'Die Ranger haben nachgesehen: Es war ein Fehlalarm. Sie können Ihre Pläne fortsetzen. Folgen Sie weiterhin Ihrem Guide.'
    : 'Die Ranger haben das Gebiet überprüft. Sie können Ihre Pläne fortsetzen. Folgen Sie weiterhin Ihrem Guide und bleiben Sie aufmerksam.'),
  allClearSms: ({ tag, place }) => `Safe Savannah${tag}: Entwarnung nahe ${place}. Die Ranger haben das Gebiet überprüft. Folgen Sie weiterhin Ihrem Guide.`,
};
