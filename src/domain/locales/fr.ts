import type { Catalog } from '../i18n.js';

// Machine-assisted translation: have a native speaker review before production use.
export const fr: Catalog = {
  species: {
    lion: 'Lion', leopard: 'Léopard', buffalo: 'Buffle', hippo: 'Hippopotame', elephant: 'Éléphant', rhino: 'Rhinocéros', crocodile: 'Crocodile',
    hyena: 'Hyène tachetée', cheetah: 'Guépard', baboon: 'Babouin', giraffe: 'Girafe', zebra: 'Zèbre', wildebeest: 'Gnou', antelope: 'Antilope',
  },
  unknownAnimal: 'Animal inconnu',
  actions: {
    generic: ['Restez dans votre véhicule, votre tente ou votre chambre jusqu’à ce que les rangers confirment qu’il n’y a plus de danger.', 'Ne vous approchez pas de l’animal à pied, ne le nourrissez pas et ne le photographiez pas.', 'Suivez les consignes de votre guide ou du personnel du lodge.'],
    extra: {
      elephant: 'Restez à au moins 50 mètres des éléphants. Ne vous placez jamais entre une mère et son petit.',
      lion: 'Ne fuyez jamais un lion en courant. Restez en groupe et attendez une escorte après la tombée de la nuit.',
      buffalo: 'Le buffle peut charger sans prévenir. Tenez-vous bien à l’écart des fourrés épais.',
      hippo: 'Éloignez-vous du bord de l’eau, surtout au crépuscule et la nuit.',
      leopard: 'Gardez les enfants près de vous et restez à l’intérieur après la tombée de la nuit.',
      crocodile: 'Ne restez pas au bord de l’eau et ne vous y lavez pas.',
    },
  },
  alertTitle: (animal, place, simulated) => `Signalement : ${animal} près de ${place}${simulated ? ' (test simulé)' : ''}`,
  alertBody: (animal) => `Les rangers ont été alertés et vérifient la situation. Cet animal (${animal}) peut être dangereux pour les personnes à pied.`,
  alertSms: ({ tag, simulated, animal, place, line }) =>
    `Safe Savannah${tag}${simulated ? ' (SIMULATION)' : ''} : ${animal} près de ${place}. Restez dans votre véhicule, tente ou chambre et suivez les consignes du personnel. Urgence : ${line}`,
  sosReceived: (ref, line) => `Safe Savannah : nous avons bien reçu votre SOS (${ref}). Les rangers ont été alertés. Si possible, appelez aussi le ${line}.`,
  sosResponding: (ref, ranger) => `Safe Savannah ${ref} : le ranger ${ranger} prend en charge votre SOS. Restez dans un endroit sûr si possible.`,
  sosResolved: (ref, ranger) => `Safe Savannah ${ref} : votre SOS a été marqué comme résolu par ${ranger}.`,
  rollCallReason: (animal, place) => `${animal} près de ${place}`,
  safetyCheck: (lodge) => `Contrôle de sécurité à ${lodge}`,
  rollCallSms: ({ tag, reason, lodge, line }) =>
    `Safe Savannah${tag} : ${reason}. ${lodge} vérifie que chaque client va bien. Êtes-vous en sécurité ? Répondez 1 (en sécurité) ou 2 (besoin d'aide). Restez à l'intérieur. Urgence : ${line}`,
  allClearTitle: (place, simulated) => `Fin d’alerte près de ${place}${simulated ? ' (test simulé)' : ''}`,
  allClearBody: (falseAlarm) => (falseAlarm
    ? 'Les rangers ont vérifié : c’était une fausse alerte. Vous pouvez reprendre vos activités. Continuez à suivre votre guide.'
    : 'Les rangers ont vérifié la zone. Vous pouvez reprendre vos activités. Continuez à suivre votre guide et restez sur vos gardes.'),
  allClearSms: ({ tag, place }) => `Safe Savannah${tag} : fin d'alerte près de ${place}. Les rangers ont vérifié la zone. Continuez à suivre votre guide.`,
};
