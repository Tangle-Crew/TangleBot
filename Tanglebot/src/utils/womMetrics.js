const { BOSSES, BossProps, SKILLS, SkillProps, MetricProps } = require('@wise-old-man/utils');

const METRIC_PROPS = { ...BossProps, ...SkillProps };

// { name: display name, value: WOM metric key } for every boss and skill WOM tracks.
const WOM_METRICS = [...BOSSES, ...SKILLS].map(metric => ({ name: METRIC_PROPS[metric].name, value: metric }));

// Display names for WOM's metric types.
const CATEGORY_LABELS = {
  boss: 'Bossing',
  skill: 'Skilling',
  activity: 'Activities',
  computed: 'Efficiency',
};

const MEASURE_UNITS = {
  experience: 'xp',
  kills: 'kc',
  score: 'score',
  value: '',
};

// Accepts either the raw metric key (from autocomplete) or a display name typed by hand.
function findMetric(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (METRIC_PROPS[raw]) return { name: METRIC_PROPS[raw].name, value: raw };
  const lower = raw.toLowerCase();
  return WOM_METRICS.find(m => m.name.toLowerCase() === lower) ?? null;
}

function metricName(metric) {
  return MetricProps[metric]?.name ?? metric;
}

// Without a leading "The" ("The Gauntlet" -> "Gauntlet"), as competitions are named.
function shortMetricName(metric) {
  return metricName(metric).replace(/^the\s+/i, '');
}

function metricCategory(metric) {
  return MetricProps[metric]?.type ?? 'other';
}

// EHP/EHB and other 'value' metrics are fractional, so they keep up to two decimals.
function formatNumber(amount, metric) {
  const decimals = MetricProps[metric]?.measure === 'value' ? 2 : 0;
  return amount.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

function formatAmount(amount, metric) {
  const unit = MEASURE_UNITS[MetricProps[metric]?.measure] ?? '';
  return `${formatNumber(amount, metric)}${unit ? ` ${unit}` : ''}`;
}

module.exports = {
  WOM_METRICS,
  CATEGORY_LABELS,
  findMetric,
  metricName,
  shortMetricName,
  metricCategory,
  formatNumber,
  formatAmount,
};
