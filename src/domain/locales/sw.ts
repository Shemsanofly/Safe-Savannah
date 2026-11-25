import type { Catalog } from '../i18n.js';

export const sw: Catalog = {
  species: {
    lion: 'Simba', leopard: 'Chui', buffalo: 'Nyati', hippo: 'Kiboko', elephant: 'Tembo', rhino: 'Kifaru', crocodile: 'Mamba',
    hyena: 'Fisi', cheetah: 'Duma', baboon: 'Nyani', giraffe: 'Twiga', zebra: 'Punda milia', wildebeest: 'Nyumbu', antelope: 'Swala',
  },
  unknownAnimal: 'Mnyama',
  actions: {
    generic: ['Baki ndani ya gari, hema au chumba chako hadi askari wa wanyamapori waseme ni salama.', 'Usimkaribie, usimlishe wala kumpiga picha mnyama ukiwa kwa miguu.', 'Fuata maelekezo ya kiongozi wako au wafanyakazi wa hoteli.'],
    extra: {
      elephant: 'Kaa angalau mita 50 mbali na tembo. Kamwe usikae kati ya mama na mtoto wake.',
      lion: 'Kamwe usimkimbie simba. Kaeni pamoja na subirini msindikizaji usiku.',
      buffalo: 'Nyati anaweza kushambulia bila onyo. Kaa mbali na vichaka vizito.',
      hippo: 'Kaa mbali na ukingo wa maji, hasa jioni na usiku.',
      leopard: 'Weka watoto karibu na baki ndani usiku.',
      crocodile: 'Usisimame wala kunawa kwenye ukingo wa maji.',
    },
  },
  alertTitle: (animal, place, simulated) => `${animal} ameonekana karibu na ${place}${simulated ? ' (jaribio)' : ''}`,
  alertBody: (animal) => `Askari wa wanyamapori wamejulishwa na wanafuatilia. ${animal} anaweza kuwa hatari kwa watu wanaotembea kwa miguu.`,
  alertSms: ({ tag, simulated, animal, place, line }) =>
    `Safe Savannah${tag}${simulated ? ' (JARIBIO)' : ''}: ${animal} karibu na ${place}. Baki ndani ya gari, hema au chumba na fuata maelekezo ya wafanyakazi. Dharura: ${line}`,
  sosReceived: (ref, line) => `Safe Savannah: Tumepokea ombi lako la dharura (${ref}). Askari wamejulishwa. Ikiwezekana piga pia ${line}.`,
  sosResponding: (ref, ranger) => `Safe Savannah ${ref}: Askari ${ranger} anashughulikia ombi lako. Kaa mahali salama.`,
  sosResolved: (ref, ranger) => `Safe Savannah ${ref}: Ombi lako la dharura limefungwa na ${ranger}.`,
  rollCallReason: (animal, place) => `${animal} karibu na ${place}`,
  safetyCheck: (lodge) => `Ukaguzi wa usalama ${lodge}`,
  rollCallSms: ({ tag, reason, lodge, line }) =>
    `Safe Savannah${tag}: ${reason}. ${lodge} inawahesabu wageni. Uko salama? Jibu SALAMA au MSAADA. Baki ndani. Dharura: ${line}`,
  allClearTitle: (place, simulated) => `Hali ni shwari karibu na ${place}${simulated ? ' (jaribio)' : ''}`,
  allClearBody: (falseAlarm) => (falseAlarm
    ? 'Askari wamekagua na haikuwa hatari. Unaweza kuendelea na mipango yako. Endelea kufuata maelekezo ya kiongozi wako.'
    : 'Askari wamekagua eneo. Unaweza kuendelea na mipango yako. Endelea kufuata maelekezo ya kiongozi wako na kuwa makini.'),
  allClearSms: ({ tag, place }) => `Safe Savannah${tag}: Hali ni shwari karibu na ${place}. Askari wamekagua. Endelea kufuata maelekezo ya kiongozi wako.`,
};
