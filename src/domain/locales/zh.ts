import type { Catalog } from '../i18n.js';

// Simplified Chinese. Machine-assisted translation: have a native speaker review before production use.
export const zh: Catalog = {
  species: {
    lion: '狮子', leopard: '豹', buffalo: '非洲水牛', hippo: '河马', elephant: '大象', rhino: '犀牛', crocodile: '鳄鱼',
    hyena: '斑鬣狗', cheetah: '猎豹', baboon: '狒狒', giraffe: '长颈鹿', zebra: '斑马', wildebeest: '角马', antelope: '羚羊',
  },
  unknownAnimal: '不明动物',
  actions: {
    generic: ['请留在车内、帐篷或房间内，直到护林员确认安全。', '请勿徒步靠近、喂食或拍摄该动物。', '请听从向导或酒店工作人员的指示。'],
    extra: {
      elephant: '与大象保持至少 50 米距离。切勿进入母象与幼象之间。',
      lion: '遇到狮子切勿奔跑。请结伴待在一起，天黑后等候护送。',
      buffalo: '非洲水牛可能毫无预警地发起冲撞。请远离茂密的灌木丛。',
      hippo: '请远离水边，尤其是在黄昏和夜间。',
      leopard: '请让孩子待在身边，天黑后留在室内。',
      crocodile: '请勿在水边站立或洗涤。',
    },
  },
  alertTitle: (animal, place, simulated) => `据报 ${place} 附近有${animal}出没${simulated ? '（模拟测试）' : ''}`,
  alertBody: (animal) => `已通知护林员，他们正在核查。${animal}可能对徒步人员构成危险。`,
  alertSms: ({ tag, simulated, animal, place, line }) =>
    `Safe Savannah${tag}${simulated ? '（模拟）' : ''}：${place} 附近有${animal}。请留在车内、帐篷或房间内，听从工作人员指示。紧急电话：${line}`,
  sosReceived: (ref, line) => `Safe Savannah：已收到您的 SOS（${ref}），已通知护林员。如有可能，请同时拨打 ${line}。`,
  sosResponding: (ref, ranger) => `Safe Savannah ${ref}：护林员 ${ranger} 正在处理您的 SOS。请尽量待在安全的地方。`,
  sosResolved: (ref, ranger) => `Safe Savannah ${ref}：${ranger} 已将您的 SOS 标记为已解决。`,
  rollCallReason: (animal, place) => `${place} 附近有${animal}`,
  safetyCheck: (lodge) => `${lodge} 安全检查`,
  rollCallSms: ({ tag, reason, lodge, line }) =>
    `Safe Savannah${tag}：${reason}。${lodge} 正在确认每位客人的安全。您安全吗？回复 1（安全）或 2（需要帮助）。请留在室内。紧急电话：${line}`,
  allClearTitle: (place, simulated) => `${place} 附近警报解除${simulated ? '（模拟测试）' : ''}`,
  allClearBody: (falseAlarm) => (falseAlarm
    ? '护林员已核查，这是一次误报。您可以继续原定计划，请继续听从向导的安排。'
    : '护林员已检查该区域。您可以继续原定计划，请继续听从向导的安排并保持警惕。'),
  allClearSms: ({ tag, place }) => `Safe Savannah${tag}：${place} 附近警报解除。护林员已检查该区域。请继续听从向导的安排。`,
};
