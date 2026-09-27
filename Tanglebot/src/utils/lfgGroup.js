const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { CATEGORIES, emojiMarkup } = require('./roleMenu');
const { truncate } = require('./db');

// /lfg-post categories, from roleMenu.js CATEGORIES.
const CATEGORY_OPTIONS = Object.entries(CATEGORIES).map(([key, c]) => ({
  key,
  label: c.label,
}));

function findCategoryOption(key) {
  return CATEGORY_OPTIONS.find((o) => o.key === key);
}

function getActivityOptions(categoryKey) {
  return CATEGORIES[categoryKey]?.roles ?? [];
}

function findActivityOption(categoryKey, value) {
  return getActivityOptions(categoryKey).find((r) => r.value === value);
}

function findSizeOption(activityOption, value) {
  return activityOption.sizeOptions.find((o) => o.value === value);
}

// Size summary shown in the activity picker, e.g. "2-5" or "2-5, Mass".
function describeSizeOptions(activityOption) {
  const numeric = activityOption.sizeOptions.filter((o) => /^\d+$/.test(o.value)).map((o) => o.value);
  const special = activityOption.sizeOptions.filter((o) => !/^\d+$/.test(o.value)).map((o) => o.label);
  const rangeText = numeric.length ? (numeric.length > 1 ? `${numeric[0]}-${numeric[numeric.length - 1]}` : numeric[0]) : '';
  return [rangeText, ...special].filter(Boolean).join(', ');
}

// "mass" means uncapped.
function parseSizeCap(value) {
  return /^\d+$/.test(value) ? parseInt(value, 10) : Infinity;
}

// Minutes from now, so there's no timezone to get wrong. Resolved when the post is created.
const TIME_OFFSET_OPTIONS = [
  { value: '0', label: 'Now' },
  { value: '15', label: '15 Min' },
  { value: '30', label: '30 Min' },
  { value: '60', label: '1 Hour' },
  { value: '120', label: '2 Hours' },
  { value: '180', label: '3 Hours' },
  { value: '240', label: '4 Hours' },
  { value: '300', label: '5 Hours' },
  { value: '360', label: '6 Hours' },
];

function findTimeOption(value) {
  return TIME_OFFSET_OPTIONS.find((o) => o.value === value);
}

// Thread titles can't use Discord's live timestamps, so the countdown uses the nearest of these
// labels, switching halfway between neighbors.
const COUNTDOWN_BUCKETS = [
  { minutes: 5, label: '5 Min' },
  ...TIME_OFFSET_OPTIONS.filter((o) => parseInt(o.value, 10) >= 15).map((o) => ({ minutes: parseInt(o.value, 10), label: o.label })),
];

function resolveCountdownBucket(minutesRemaining) {
  if (minutesRemaining <= 0) {
    return null;
  }

  let bestBucket = COUNTDOWN_BUCKETS[COUNTDOWN_BUCKETS.length - 1];
  let bestDistance = Math.abs(bestBucket.minutes - minutesRemaining);
  for (const bucket of COUNTDOWN_BUCKETS) {
    const distance = Math.abs(bucket.minutes - minutesRemaining);
    if (distance < bestDistance) {
      bestBucket = bucket;
      bestDistance = distance;
    }
  }
  return bestBucket;
}

// "in <label>" for the thread title, or "Started".
function describeStartCountdown(timeEpoch) {
  const minutesRemaining = Math.ceil((timeEpoch * 1000 - Date.now()) / 60000);
  if (minutesRemaining <= 0) return 'Started';
  const bucket = resolveCountdownBucket(minutesRemaining) ?? COUNTDOWN_BUCKETS[0];
  return `in ${bucket.label}`;
}

// Milliseconds until the countdown label changes, or null once the start time has passed.
function computeCountdownRefreshDelay(timeEpoch) {
  const minutesRemaining = Math.ceil((timeEpoch * 1000 - Date.now()) / 60000);
  if (minutesRemaining <= 0) return null;

  const bucket = resolveCountdownBucket(minutesRemaining);
  if (!bucket) return null;

  const bucketIndex = COUNTDOWN_BUCKETS.findIndex((candidate) => candidate.minutes === bucket.minutes);
  const lowerBucket = bucketIndex > 0 ? COUNTDOWN_BUCKETS[bucketIndex - 1] : null;
  const upperBucket = bucketIndex < COUNTDOWN_BUCKETS.length - 1 ? COUNTDOWN_BUCKETS[bucketIndex + 1] : null;

  const lowerBoundary = lowerBucket ? (bucket.minutes + lowerBucket.minutes) / 2 : 0;
  const upperBoundary = upperBucket ? (bucket.minutes + upperBucket.minutes) / 2 : Number.POSITIVE_INFINITY;
  const nextBoundaryMinutes = minutesRemaining > bucket.minutes ? upperBoundary : lowerBoundary;

  if (!Number.isFinite(nextBoundaryMinutes)) {
    return Math.max((minutesRemaining - bucket.minutes + 0.5) * 60000, 1000);
  }

  return Math.max(timeEpoch * 1000 - nextBoundaryMinutes * 60000 - Date.now(), 1000);
}

// Resolved at creation time, not when the dropdown was shown.
function resolveTimeEpoch(offsetMinutesValue) {
  return Math.floor(Date.now() / 1000) + parseInt(offsetMinutesValue, 10) * 60;
}

// Every spot taken. Not the same as status 'closed', which also covers a spot held for the queue.
function isGroupFull(group) {
  return group.sizeCap !== Infinity && group.members.size >= group.sizeCap;
}

// ---- Group post building blocks, used by lfgPost.js ----
// status: 'open' | 'closed' (full, or a spot held for the queue) | 'disbanded'.

const GROUP_BUTTON_PREFIX = 'lfgpostgroup';

function buildStartNowButton(groupId) {
  return new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:startnow:${groupId}`)
    .setLabel('Start Now')
    .setStyle(ButtonStyle.Primary);
}

// The same Join button whether open or full; a full group queues the clicker.
function buildJoinButton(groupId) {
  return new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:join:${groupId}`)
    .setLabel('Join Group')
    .setStyle(ButtonStyle.Success);
}

// Same row regardless of status.
function buildGroupRow(groupId) {
  const join = buildJoinButton(groupId);
  const startNow = buildStartNowButton(groupId);
  const leave = new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:leave:${groupId}`)
    .setLabel('Leave Group')
    .setStyle(ButtonStyle.Secondary);
  const disband = new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:disband:${groupId}`)
    .setLabel('Disband Group')
    .setStyle(ButtonStyle.Danger);

  return new ActionRowBuilder().addComponents(join, leave, startNow, disband);
}

// Offer to the front of the queue. Decline, or not answering in time, removes them from the queue.
function buildQueueOfferRow(groupId) {
  const accept = new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:queueaccept:${groupId}`)
    .setLabel('Accept Spot')
    .setStyle(ButtonStyle.Success);
  const decline = new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:queuedecline:${groupId}`)
    .setLabel('Decline Spot')
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(accept, decline);
}

// Shown during the disband grace period.
function buildCancelDisbandRow(groupId) {
  const cancel = new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:canceldisband:${groupId}`)
    .setLabel('Cancel Disband')
    .setStyle(ButtonStyle.Success);
  return new ActionRowBuilder().addComponents(cancel);
}

// Shown on the "still active?" check.
function buildKeepAliveRow(groupId) {
  const stillHere = new ButtonBuilder()
    .setCustomId(`${GROUP_BUTTON_PREFIX}:keepalive:${groupId}`)
    .setLabel('Still Here')
    .setStyle(ButtonStyle.Success);
  return new ActionRowBuilder().addComponents(stillHere);
}

function formatCapacity(group) {
  return group.sizeCap === Infinity ? 'Mass' : String(group.sizeCap);
}

// Keeps whole lines up to maxChars and summarizes the rest ("…and N more"), so a Mass group's
// roster can't push the post past Discord's 2000-char cap.
const MAX_ROSTER_SECTION_CHARS = 550;
const MAX_DESCRIPTION_CHARS = 150;
function capMentionLines(lines, maxChars = MAX_ROSTER_SECTION_CHARS) {
  let total = 0;
  const kept = [];
  for (const line of lines) {
    if (total + line.length + 1 > maxChars) break;
    kept.push(line);
    total += line.length + 1;
  }
  if (kept.length === lines.length) return kept.join('\n');

  // The summary line counts against the budget too.
  let summary = `_…and ${lines.length - kept.length} more_`;
  while (kept.length > 0 && total + summary.length + 1 > maxChars) {
    total -= kept[kept.length - 1].length + 1;
    kept.pop();
    summary = `_…and ${lines.length - kept.length} more_`;
  }
  kept.push(truncate(summary, maxChars));
  return kept.join('\n');
}

// The main post body: role ping first so it notifies, then details, members and queue.
function buildGroupText(group) {
  const capDisplay = formatCapacity(group);
  const memberLines = capMentionLines([...group.members].map((id) => `<@${id}>`));

  // group.emoji is validated before the group is created.
  const pingLine = [`<@&${group.roleId}>`, emojiMarkup(group.emoji)].filter(Boolean).join(' ');
  const headline = isGroupFull(group) ? '🔒 **Looking For Group — Full**' : '**Looking For Group**';

  const lines = [
    pingLine,
    headline,
    `**Activity:** ${group.roleLabel}`,
    `**Start:** <t:${group.timeEpoch}:t> (<t:${group.timeEpoch}:R>)`,
    `**Group Size:** ${group.sizeLabel}`,
  ];
  if (group.description) lines.push('**Description:**', truncate(group.description, MAX_DESCRIPTION_CHARS));
  lines.push('', `**Members (${group.members.size}/${capDisplay}):**`, memberLines || '_none yet_');

  // Numbered in queue order.
  if (group.queue?.length) {
    const queueLines = capMentionLines(
      group.queue.map((id, i) => `${i + 1}. <@${id}>${group.pendingOfferUserId === id ? ' 🎟️ _(offer pending)_' : ''}`)
    );
    lines.push('', `**Queue (${group.queue.length}):**`, queueLines);
  }

  lines.push('', `_Started by ${group.creatorTag}_`);
  // Backstop; the section caps above normally keep this well under 2000.
  return truncate(lines.join('\n'), 1900);
}

function makeGroupId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

module.exports = {
  CATEGORY_OPTIONS,
  findCategoryOption,
  getActivityOptions,
  findActivityOption,
  findSizeOption,
  describeSizeOptions,
  parseSizeCap,
  TIME_OFFSET_OPTIONS,
  findTimeOption,
  resolveTimeEpoch,
  describeStartCountdown,
  computeCountdownRefreshDelay,
  buildGroupText,
  capMentionLines,
  buildGroupRow,
  buildQueueOfferRow,
  buildCancelDisbandRow,
  buildKeepAliveRow,
  makeGroupId,
  isGroupFull,
};
