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

// A metric newer than the installed @wise-old-man/utils falls back to its key in words:
// "the_fractured_archive" -> "The Fractured Archive".
function metricName(metric) {
  return MetricProps[metric]?.name
    ?? String(metric).split('_').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
}

// Without a leading "The" ("The Gauntlet" -> "Gauntlet"), as competitions are named.
function shortMetricName(metric) {
  return metricName(metric).replace(/^the\s+/i, '');
}

function metricCategory(metric) {
  return MetricProps[metric]?.type ?? 'other';
}

// Every metric a competition tracks. Falls back to the deprecated single `metric`.
function competitionMetrics(competition) {
  const metrics = competition.metrics?.map(m => m.metric).filter(Boolean);
  if (metrics?.length) return metrics;
  return competition.metric ? [competition.metric] : [];
}

// "A + B" of the competition's metrics, in the order WOM lists them.
function competitionMetricLabel(competition) {
  return competitionMetrics(competition).map(shortMetricName).join(' + ');
}

// EHP/EHB and other 'value' metrics are fractional, so they keep up to two decimals.
function formatNumber(amount, metric) {
  const decimals = MetricProps[metric]?.measure === 'value' ? 2 : 0;
  return amount.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

// "kc", "xp" or "score", or '' for EHP/EHB and other 'value' metrics.
function metricUnit(metric) {
  return MEASURE_UNITS[MetricProps[metric]?.measure] ?? '';
}

function formatAmount(amount, metric) {
  const unit = metricUnit(metric);
  return `${formatNumber(amount, metric)}${unit ? ` ${unit}` : ''}`;
}

module.exports = {
  WOM_METRICS,
  CATEGORY_LABELS,
  findMetric,
  metricName,
  shortMetricName,
  metricCategory,
  competitionMetrics,
  competitionMetricLabel,
  metricUnit,
  formatNumber,
  formatAmount,
};
