// models.js — 模型名归一（主进程与渲染层共用）
// 平台在用的就两个模型：deepseek-flash（V4.1-Flash，旧名/实验名都归它）与 deepseek-v4-pro。
// 但历史用量行里会夹杂已退役、已过期的别名（如 deepseek-v4.1-flash-expires-on-0910），
// 展示与统计统一归到这两个族里，避免图例和模型列表被六七个名字撑爆。
(function (factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (typeof window !== 'undefined' ? window : globalThis).Models = factory();
})(function () {
  const FLASH = 'deepseek-flash';
  const PRO = 'deepseek-v4-pro';

  const ALIASES = {
    'deepseek-v4-flash': FLASH,
    'deepseek-v4-flash-0731': FLASH,
    'deepseek-v4-flash-vision-exp': FLASH,
    'deepseek-v4.1-flash-expires-on-0910': FLASH,
    'deepseek-chat': FLASH,
    'deepseek-reasoner': FLASH,
    'deepseek-chat & deepseek-reasoner': FLASH,
    'deepseek-v4-pro-0813': PRO,
  };

  // 未知模型原样保留——不能把还没见过的模型吞成已知的
  function canonicalModel(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) return 'unknown';
    if (ALIASES[n]) return ALIASES[n];
    const l = n.toLowerCase();
    if (l.includes('flash')) return FLASH;
    if (l.includes('pro')) return PRO;
    return n;
  }

  const isKnown = (name) => canonicalModel(name) === FLASH || canonicalModel(name) === PRO;

  return { FLASH, PRO, ALIASES, canonicalModel, isKnown };
});
