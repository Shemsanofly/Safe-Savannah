import type { Catalog } from '../i18n.js';

export const en: Catalog = {
  species: {
    lion: 'Lion', leopard: 'Leopard', buffalo: 'Cape buffalo', hippo: 'Hippopotamus', elephant: 'Elephant', rhino: 'Rhinoceros', crocodile: 'Crocodile',
    hyena: 'Spotted hyena', cheetah: 'Cheetah', baboon: 'Baboon', giraffe: 'Giraffe', zebra: 'Zebra', wildebeest: 'Wildebeest', antelope: 'Antelope',
  },
  unknownAnimal: 'Unknown animal',
  actions: {
    generic: ['Stay inside your vehicle, tent or room until rangers say it is safe.', 'Do not approach, feed or photograph the animal on foot.', 'Follow instructions from your guide or lodge staff.'],
    extra: {
      elephant: 'Give elephants at least 50 metres. Never get between a mother and her calf.',
      lion: 'Never run from a lion. Stay in a group and wait for an escort after dark.',
      buffalo: 'Buffalo can charge without warning. Keep well clear of thick bush.',
      hippo: 'Keep away from the water edge, especially at dusk and night.',
      leopard: 'Keep children close and stay indoors after dark.',
      crocodile: 'Do not stand or wash at the water edge.',
    },
  },
  alertTitle: (animal, place, simulated) => `${animal} reported near ${place}${simulated ? ' (simulated test)' : ''}`,
  alertBody: (animal) => `Rangers have been alerted and are checking. ${animal}s can be dangerous to people on foot.`,
  alertSms: ({ tag, simulated, animal, place, line }) =>
    `Safe Savannah${tag}${simulated ? ' (SIMULATED)' : ''}: ${animal} near ${place}. Stay inside your vehicle, tent or room and follow staff instructions. Emergency: ${line}`,
  sosReceived: (ref, line) => `Safe Savannah: We received your SOS (${ref}). Rangers have been alerted. If you can, also call ${line}.`,
  sosResponding: (ref, ranger) => `Safe Savannah ${ref}: Ranger ${ranger} is responding to your SOS. Stay somewhere safe if you can.`,
  sosResolved: (ref, ranger) => `Safe Savannah ${ref}: Your SOS has been marked resolved by ${ranger}.`,
  rollCallReason: (animal, place) => `${animal} near ${place}`,
  safetyCheck: (lodge) => `Safety check at ${lodge}`,
  rollCallSms: ({ tag, reason, lodge, line }) =>
    `Safe Savannah${tag}: ${reason}. ${lodge} is checking on every guest. Are you safe? Reply SAFE or HELP. Stay inside. Emergency: ${line}`,
  allClearTitle: (place, simulated) => `All clear near ${place}${simulated ? ' (simulated test)' : ''}`,
  allClearBody: (falseAlarm) => (falseAlarm
    ? 'Rangers checked and it was a false alarm. You can carry on with your plans. Keep following your guide.'
    : 'Rangers have checked the area. You can carry on with your plans. Keep following your guide and stay alert.'),
  allClearSms: ({ tag, place }) => `Safe Savannah${tag}: All clear near ${place}. Rangers have checked the area. Keep following your guide.`,
};
