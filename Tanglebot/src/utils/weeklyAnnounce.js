const { escapeMarkdown } = require('discord.js');
const { getAllGroupCompetitions, getCompetitionDetails, rankParticipants, competitionUrl } = require('./wiseOldMan');
const { metricName, shortMetricName, metricCategory, metricUnit, formatNumber } = require('./womMetrics');
const { readJson, writeJson, withTimeout, truncate } = require('./db');
const { findPetEmoji } = require('./bossPets');

// The WOM client sets no timeout of its own.
const REQUEST_TIMEOUT_MS = 20 * 1000;
// Competition details are reused for this long, unless loaded with fresh (as when sending).
const DETAILS_CACHE_TTL_MS = 5 * 60 * 1000;
const detailsCache = new Map(); // competition ID -> { details, loadedAt }
const PLACES = ['🥇', '🥈', '🥉'];
const WINNERS_INTRO = 'Hello @everyone , It is time to announce the winners of this weeks event';
const UNIT_LABELS = { kc: 'KC', xp: 'XP' };

// { drafts: { <id>: draft } }. Read from disk on every call, so drafts survive restarts.
const DATA_FILE = 'weeklyannounce.json';
const MAX_ANNOUNCEMENTS = 5;
// Discord's limit of options in one select menu.
const MAX_CHOICES = 25;
// Discord's limit for one message, which the joined announcements are measured against.
const MESSAGE_LIMIT = 2000;
const ANNOUNCEMENT_SEPARATOR = '\n\n';
// Drafts not changed for this long are dropped on the next save.
const DRAFT_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

function loadGroupCompetitions(groupId) {
  return withTimeout(getAllGroupCompetitions(groupId), 'Loading the group competitions', REQUEST_TIMEOUT_MS);
}

// Of all (the group's competitions), those with the earliest end time still in the future.
// Competitions created together by /weeklycomp share that end time exactly.
// { endsAt: null, competitions: [] } if none.
function findNextEnding(all, now = Date.now()) {
  const future = all.filter(c => new Date(c.endsAt).getTime() > now);
  if (future.length === 0) return { endsAt: null, competitions: [] };
  const endsAt = Math.min(...future.map(c => new Date(c.endsAt).getTime()));
  return {
    endsAt: new Date(endsAt),
    competitions: future.filter(c => new Date(c.endsAt).getTime() === endsAt),
  };
}

// What setup offers to pick the winners from, as [{ id, title, endsAt }] of all (the group's
// competitions): those still to end, soonest first, or for a typed send time (fixedSendAt) those
// started by then, including ones still running, latest end first. At most MAX_CHOICES.
function competitionChoices(all, { fixedSendAt = null, now = Date.now() } = {}) {
  const endsAt = c => new Date(c.endsAt).getTime();
  const shown = fixedSendAt
    ? all.filter(c => new Date(c.startsAt).getTime() <= new Date(fixedSendAt).getTime()).sort((a, b) => endsAt(b) - endsAt(a))
    : all.filter(c => endsAt(c) > now).sort((a, b) => endsAt(a) - endsAt(b));
  return shown.slice(0, MAX_CHOICES).map(c => ({ id: c.id, title: c.title, endsAt: new Date(c.endsAt).toISOString() }));
}

// The group's competitions with the latest end time at or before `at`, for a typed send time.
async function findLastEndedBy(groupId, at) {
  const all = await withTimeout(getAllGroupCompetitions(groupId), 'Loading the group competitions', REQUEST_TIMEOUT_MS);
  const ended = all.filter(c => new Date(c.endsAt).getTime() <= new Date(at).getTime());
  if (ended.length === 0) return [];
  const endsAt = Math.max(...ended.map(c => new Date(c.endsAt).getTime()));
  return ended.filter(c => new Date(c.endsAt).getTime() === endsAt);
}

// The competitions a draft's winners come from: those saved at setup, or for a typed send time the
// ones that last ended by then.
async function competitionsForDraft(draft, groupId) {
  return draft.competitions.length ? draft.competitions : findLastEndedBy(groupId, draft.sendAt);
}

async function loadCompetitionDetails(id, { fresh = false } = {}) {
  const cached = detailsCache.get(id);
  if (!fresh && cached && Date.now() - cached.loadedAt < DETAILS_CACHE_TTL_MS) return cached.details;
  const details = await withTimeout(getCompetitionDetails(id), `Loading competition #${id}`, REQUEST_TIMEOUT_MS);
  detailsCache.set(id, { details, loadedAt: Date.now() });
  return details;
}

// A title split before its metric's name: "BOTW T1: Amoxliatl" -> { prefix: 'BOTW T1: ', name:
// 'Amoxliatl' }. A title that doesn't end in the name is all prefix.
function splitTitle(competition) {
  const title = competition.title.trim();
  for (const name of [metricName(competition.metric), shortMetricName(competition.metric)]) {
    if (title.toLowerCase().endsWith(name.toLowerCase())) {
      const cut = title.length - name.length;
      return { prefix: title.slice(0, cut), name: title.slice(cut) };
    }
  }
  return { prefix: title, name: '' };
}

// "BOTW T1: " and "botw t1" match.
function prefixKey(prefix) {
  return prefix.trim().replace(/[\s:|–—-]+$/, '').toLowerCase();
}

// One list per title prefix and unit, so "BOTW T3 Gauntlet" and "BOTW T3 Corrupted Gauntlet" (both
// kc) share a list, ranked by each player's gains added up across its competitions.
// competitions: [{ id }]. Returns [{ title, prefix, names, metric, competitions, ranked: [{ id, name,
// gained }] }], with names[i] the metric part of competitions[i]'s title ('' if none).
async function loadWinnerLists(competitions, { fresh = false } = {}) {
  const lists = new Map();
  for (const { id } of [...competitions].sort((a, b) => a.id - b.id)) {
    const details = await loadCompetitionDetails(id, { fresh });
    const { prefix, name } = splitTitle(details);
    const key = `${prefixKey(prefix)}|${metricUnit(details.metric)}`;
    if (!lists.has(key)) lists.set(key, { prefix, names: [], competitions: [], totals: new Map() });
    const list = lists.get(key);
    list.names.push(name);
    list.competitions.push(details);
    for (const row of rankParticipants(details)) {
      const total = list.totals.get(row.id) ?? { id: row.id, name: row.name, gained: 0 };
      total.gained += row.gained;
      list.totals.set(row.id, total);
    }
  }
  return [...lists.values()].map(list => ({
    title: list.competitions.length === 1
      ? list.competitions[0].title.trim()
      : `${list.prefix}${list.names.filter(Boolean).join(' + ')}`.trim(),
    prefix: list.prefix,
    names: list.names,
    metric: list.competitions[0].metric,
    competitions: list.competitions,
    ranked: [...list.totals.values()].sort((a, b) => b.gained - a.gained || a.name.localeCompare(b.name)),
  }));
}

// 1st to 3rd as [{ place, players, gained }], with tied players sharing a place. Places follow the
// usual ranking, so two players tied for 2nd leave no 3rd.
function topPlaces(ranked) {
  const places = [];
  let counted = 0;
  for (const row of ranked) {
    const last = places[places.length - 1];
    if (last && last.gained === row.gained) {
      last.players.push(row);
    } else {
      if (counted + 1 > PLACES.length) break;
      places.push({ place: counted + 1, players: [row], gained: row.gained });
    }
    counted++;
  }
  return places;
}

function competitionLink(text, id) {
  return `[${escapeMarkdown(text)}](<${competitionUrl(id)}>)`;
}

// The list's title linking to its competitions on WOM: "BOTW T3: [Gauntlet] + [Corrupted
// Gauntlet]" for a merged list, or each whole title when they don't all name their metric.
function linkedTitle(list) {
  if (list.competitions.length === 1) return competitionLink(list.title, list.competitions[0].id);
  if (list.names.every(Boolean)) {
    return `${escapeMarkdown(list.prefix)}${list.competitions.map((c, i) => competitionLink(list.names[i], c.id)).join(' + ')}`;
  }
  return list.competitions.map(c => competitionLink(c.title.trim(), c.id)).join(' + ');
}

// "BOTW" or "SOTW" as the title says, else by the metric's type.
function eventKind(list) {
  const named = list.title.match(/\b([BS]OTW)\b/i);
  if (named) return named[1].toUpperCase();
  return metricCategory(list.metric) === 'skill' ? 'SOTW' : 'BOTW';
}

// mentions: RSN -> Discord user ID; winners without one show as their RSN in bold.
function winnerLabel(player, mentions) {
  const userId = mentions.get(player.name);
  return userId ? `<@${userId}>` : `**${escapeMarkdown(player.name)}**`;
}

// emojis: the bot's application emojis; mentions: RSN -> Discord user ID.
function buildWinnersSection(list, { emojis, mentions }) {
  const emoji = findPetEmoji(list.metric, emojis);
  const lead = emoji ? `${emoji} ` : '';
  const heading = `# ${lead}${linkedTitle(list)}`;
  const unit = metricUnit(list.metric);
  if (list.ranked.length === 0) {
    return `${heading}\nNobody gained any ${unit === 'kc' || unit === 'xp' ? unit : 'progress'} this week.`;
  }
  const unitLabel = UNIT_LABELS[unit] ?? unit;
  const amount = gained => `${formatNumber(gained, list.metric)}${unitLabel ? ` ${unitLabel}` : ''}`;
  const total = list.ranked.reduce((sum, row) => sum + row.gained, 0);
  const metricLabel = list.names.filter(Boolean).join(' + ') || shortMetricName(list.metric);
  const totalLine = `**Total** ${lead}**${escapeMarkdown(metricLabel)}${unitLabel ? ` ${unitLabel}` : ''}: ${formatNumber(total, list.metric)}**`;

  const places = topPlaces(list.ranked);
  const lines = places.map(({ place, players, gained }) =>
    `${PLACES[place - 1]} ${players.map(p => winnerLabel(p, mentions)).join(', ')} **${amount(gained)}**`
  );
  const templar = process.env.TEMPLAR_ROLE_ID ? `<@&${process.env.TEMPLAR_ROLE_ID}>` : '@Templar';
  const firsts = places[0].players.map(p => winnerLabel(p, mentions)).join(', ');
  const prize = `${firsts} Please reach out to any ${templar} to receive your ${eventKind(list)} Winnings, you have till the next event finishes to collect.`;
  return [heading, totalLine, ...lines, prize].join('\n');
}

// Message 1's text: the intro, then one section per winners list. context: { emojis, mentions },
// as for buildWinnersSection.
function buildWinnersText(lists, context = { emojis: [], mentions: new Map() }) {
  const sections = lists.map(list => buildWinnersSection(list, context));
  return truncate(`${WINNERS_INTRO}\n${sections.join('\n\n')}`, MESSAGE_LIMIT);
}

function readStore() {
  const store = readJson(DATA_FILE);
  return { ...store, drafts: store.drafts ?? {} };
}

function saveStore(store) {
  const cutoff = Date.now() - DRAFT_LIFETIME_MS;
  for (const [id, draft] of Object.entries(store.drafts)) {
    if (new Date(draft.updatedAt).getTime() < cutoff) delete store.drafts[id];
  }
  writeJson(DATA_FILE, store);
}

function makeDraftId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// competitions: [{ id, title }] the winners come from, or [] for a typed send time (fixedSendAt)
// meaning the ones that last ended by then. choices: what the panel offers instead, from
// competitionChoices.
function createDraft({ ownerId, channelId, sendAt, fixedSendAt, competitions, choices = [] }) {
  const now = new Date().toISOString();
  const draft = {
    id: makeDraftId(),
    ownerId,
    channelId,
    sendAt: sendAt.toISOString(),
    fixedSendAt,
    competitions,
    choices,
    announcements: [],
    createdAt: now,
    updatedAt: now,
  };
  const store = readStore();
  store.drafts[draft.id] = draft;
  saveStore(store);
  return draft;
}

function getDraft(id) {
  return readStore().drafts[id] ?? null;
}

// Runs change(draft) and saves the result. Null if the draft no longer exists.
function updateDraft(id, change) {
  const store = readStore();
  const draft = store.drafts[id];
  if (!draft) return null;
  change(draft);
  draft.updatedAt = new Date().toISOString();
  saveStore(store);
  return draft;
}

function deleteDraft(id) {
  const store = readStore();
  if (!store.drafts[id]) return false;
  delete store.drafts[id];
  saveStore(store);
  return true;
}

// The announcements as they're sent in message 2.
function joinAnnouncements(announcements) {
  return announcements.join(ANNOUNCEMENT_SEPARATOR);
}

module.exports = {
  MAX_ANNOUNCEMENTS,
  MESSAGE_LIMIT,
  MAX_CHOICES,
  loadGroupCompetitions,
  findNextEnding,
  competitionChoices,
  competitionsForDraft,
  loadWinnerLists,
  buildWinnersText,
  createDraft,
  getDraft,
  updateDraft,
  deleteDraft,
  joinAnnouncements,
};
