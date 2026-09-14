const { BOSSES, BossProps, SKILLS, SkillProps } = require('@wise-old-man/utils');

const METRIC_PROPS = { ...BossProps, ...SkillProps };

// { name: display name, value: WOM metric key } for every boss and skill WOM tracks.
const WOM_METRICS = [...BOSSES, ...SKILLS].map(metric => ({ name: METRIC_PROPS[metric].name, value: metric }));

// Accepts either the raw metric key (from autocomplete) or a display name typed by hand.
function findMetric(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (METRIC_PROPS[raw]) return { name: METRIC_PROPS[raw].name, value: raw };
  const lower = raw.toLowerCase();
  return WOM_METRICS.find(m => m.name.toLowerCase() === lower) ?? null;
}

module.exports = { WOM_METRICS, findMetric };
