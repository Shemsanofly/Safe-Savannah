import type { Catalog } from '../i18n.js';

// Spanish server-side text. Machine-assisted translation: have a native speaker review before production use.
export const es: Catalog = {
  species: {
    lion: 'León', leopard: 'Leopardo', buffalo: 'Búfalo cafre', hippo: 'Hipopótamo', elephant: 'Elefante', rhino: 'Rinoceronte', crocodile: 'Cocodrilo',
    hyena: 'Hiena manchada', cheetah: 'Guepardo', baboon: 'Babuino', giraffe: 'Jirafa', zebra: 'Cebra', wildebeest: 'Ñu', antelope: 'Antílope',
  },
  unknownAnimal: 'Animal desconocido',
  actions: {
    generic: ['Permanezca en su vehículo, tienda o habitación hasta que los guardaparques digan que es seguro.', 'No se acerque al animal, no lo alimente ni lo fotografíe a pie.', 'Siga las indicaciones de su guía o del personal del lodge.'],
    extra: {
      elephant: 'Manténgase al menos a 50 metros de los elefantes. Nunca se ponga entre una madre y su cría.',
      lion: 'Nunca huya corriendo de un león. Permanezca en grupo y espere a un acompañante de noche.',
      buffalo: 'El búfalo puede embestir sin aviso. Manténgase bien lejos de la maleza espesa.',
      hippo: 'Aléjese de la orilla del agua, sobre todo al anochecer y de noche.',
      leopard: 'Mantenga a los niños cerca y quédese bajo techo de noche.',
      crocodile: 'No se quede ni se lave en la orilla del agua.',
    },
  },
  alertTitle: (animal, place, simulated) => `${animal}: avistamiento cerca de ${place}${simulated ? ' (prueba simulada)' : ''}`,
  alertBody: (animal) => `Se ha avisado a los guardaparques y ya están comprobando. Este animal (${animal}) puede ser peligroso para las personas a pie.`,
  alertSms: ({ tag, simulated, animal, place, line }) =>
    `Safe Savannah${tag}${simulated ? ' (SIMULADO)' : ''}: ${animal} cerca de ${place}. Permanezca en su vehículo, tienda o habitación y siga las indicaciones del personal. Emergencias: ${line}`,
  sosReceived: (ref, line) => `Safe Savannah: Hemos recibido su SOS (${ref}). Se ha avisado a los guardaparques. Si puede, llame también al ${line}.`,
  sosResponding: (ref, ranger) => `Safe Savannah ${ref}: El guardaparques ${ranger} está atendiendo su SOS. Si puede, quédese en un lugar seguro.`,
  sosResolved: (ref, ranger) => `Safe Savannah ${ref}: ${ranger} ha marcado su SOS como resuelto.`,
  rollCallReason: (animal, place) => `${animal} cerca de ${place}`,
  safetyCheck: (lodge) => `Control de seguridad en ${lodge}`,
  rollCallSms: ({ tag, reason, lodge, line }) =>
    `Safe Savannah${tag}: ${reason}. ${lodge} está comprobando a cada huésped. ¿Está a salvo? Responda 1 (a salvo) o 2 (necesito ayuda). Quédese dentro. Emergencias: ${line}`,
  allClearTitle: (place, simulated) => `Sin peligro cerca de ${place}${simulated ? ' (prueba simulada)' : ''}`,
  allClearBody: (falseAlarm) => (falseAlarm
    ? 'Los guardaparques lo han comprobado y era una falsa alarma. Puede seguir con sus planes. Siga las indicaciones de su guía.'
    : 'Los guardaparques han revisado la zona. Puede seguir con sus planes. Siga las indicaciones de su guía y manténgase alerta.'),
  allClearSms: ({ tag, place }) => `Safe Savannah${tag}: Sin peligro cerca de ${place}. Los guardaparques han revisado la zona. Siga las indicaciones de su guía.`,
};
