const { escapeMarkdown, ChannelType } = require('discord.js');
const {
  getAllGroupCompetitions,
  getCompetitionDetails,
  getCompetitionTopHistory,
  getGroupGains,
  rankParticipants,
  competitionUrl,
} = require('./wiseOldMan');
const { metricName, shortMetricName, metricCategory, metricUnit, formatNumber } = require('./womMetrics');
const { readJson, writeJson, withTimeout, truncate } = require('./db');
const { renderProgressChart, chartFileName } = require('./weeklyAnnounceChart');
const { metricPet, findPetEmoji } = require('./bossPets');

// The WOM client sets no timeout of its own.
const REQUEST_TIMEOUT_MS = 20 * 1000;
// This feature's WOM calls run one at a time with this gap, inside WOM's limit of 20 requests a
// minute (100 with WOM_API_KEY), leaving room for the bot's other features.
const WOM_CALL_GAP_MS = process.env.WOM_API_KEY ? 700 : 3500;
// WOM responses are reused for this long, unless loaded with fresh (as when sending).
const WOM_CACHE_TTL_MS = 5 * 60 * 1000;
const womCache = new Map(); // key -> { value, loadedAt }
let womQueue = Promise.resolve();
let lastWomCallAt = 0;
const PLACES = ['🥇', '🥈', '🥉'];
// Discord calls loading the server members and the bot's emojis.
const DISCORD_TIMEOUT_MS = 20 * 1000;
const WINNERS_INTRO = 'Hello @everyone , It is time to announce the winners of this weeks event';
const UNIT_LABELS = { kc: 'KC', xp: 'XP' };
const DAY_MS = 24 * 60 * 60 * 1000;
const CHART_PLAYERS = 5;

// { drafts: { <id>: draft }, jobs: { <id>: accepted draft } }. Read from disk on every call, so
// both survive restarts.
const DATA_FILE = 'weeklyannounce.json';
const MAX_ANNOUNCEMENTS = 5;
// Discord's limit of options in one select menu.
const MAX_CHOICES = 25;
// Discord's limit for one message, which the joined announcements are measured against.
const MESSAGE_LIMIT = 2000;
const ANNOUNCEMENT_SEPARATOR = '\n\n';
// Drafts not changed for this long are dropped on the next save.
const DRAFT_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

// Queues fn behind this feature's earlier WOM calls, spaced WOM_CALL_GAP_MS apart.
function womCall(label, fn) {
  const run = womQueue.then(async () => {
    const wait = lastWomCallAt + WOM_CALL_GAP_MS - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastWomCallAt = Date.now();
    return withTimeout(fn(), label, REQUEST_TIMEOUT_MS);
  });
  womQueue = run.catch(() => {});
  return run;
}

async function cachedWomCall(key, label, fn, { fresh = false } = {}) {
  const cached = womCache.get(key);
  if (!fresh && cached && Date.now() - cached.loadedAt < WOM_CACHE_TTL_MS) return cached.value;
  const value = await womCall(label, fn);
  womCache.set(key, { value, loadedAt: Date.now() });
  for (const [k, entry] of womCache) {
    if (Date.now() - entry.loadedAt >= WOM_CACHE_TTL_MS) womCache.delete(k);
  }
  return value;
}

function loadGroupCompetitions(groupId) {
  return womCall('Loading the group competitions', () => getAllGroupCompetitions(groupId));
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
  const all = await loadGroupCompetitions(groupId);
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

function loadCompetitionDetails(id, options) {
  return cachedWomCall(`details:${id}`, `Loading competition #${id}`, () => getCompetitionDetails(id), options);
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

// How names compare: lowercase, with runs of spaces, _ and - as one space, as in RSNs.
function nameText(name) {
  return String(name ?? '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

// The server member each RSN belongs to, by nickname, display name or username: one that matches
// exactly, or else one that starts with the RSN followed by a space or symbol ("Snow I 🍌x14" for
// "Snow I"). RSNs matching no member, or several, are left out. Returns RSN -> user ID.
function matchMembers(rsns, members) {
  const people = [...members]
    .filter(m => !m.user.bot)
    .map(m => ({ id: m.id, names: [m.nickname, m.user.globalName, m.user.username].filter(Boolean).map(nameText) }));
  const mentions = new Map();
  for (const rsn of rsns) {
    const target = nameText(rsn);
    if (!target) continue;
    const exact = people.filter(p => p.names.includes(target));
    const found = exact.length
      ? exact
      : people.filter(p => p.names.some(n => n.startsWith(target) && /^[^a-z0-9]/.test(n.slice(target.length))));
    if (found.length === 1) mentions.set(rsn, found[0].id);
  }
  return mentions;
}

// The RSNs the winners text names: every player placed 1st to 3rd.
function winnerNames(lists) {
  return [...new Set(lists.flatMap(list => topPlaces(list.ranked).flatMap(place => place.players.map(p => p.name))))];
}

// The server's members, loading them all from Discord. Falls back to those already cached.
async function loadMembers(guild) {
  try {
    return [...(await withTimeout(guild.members.fetch(), 'Loading the server members', DISCORD_TIMEOUT_MS)).values()];
  } catch (err) {
    console.warn('[WeeklyAnnounce] Failed to load the server members, matching winners against those cached:', err.message);
    return [...guild.members.cache.values()];
  }
}

// The bot's application emojis, or [] if they can't be loaded.
async function loadBotEmojis(client) {
  try {
    return [...(await withTimeout(client.application.emojis.fetch(), 'Loading the bot emojis', DISCORD_TIMEOUT_MS)).values()];
  } catch (err) {
    console.warn('[WeeklyAnnounce] Failed to load the bot emojis, posting the winners without them:', err.message);
    return [];
  }
}

// Day marks from the start, every 24 hours, then the end, cut off at `now` for a competition still
// running. A 7-day competition has 8.
function chartMarks(startsAt, endsAt, now) {
  const last = Math.min(endsAt, now);
  const marks = [];
  for (let t = startsAt; t < last; t += DAY_MS) marks.push(t);
  marks.push(last);
  return marks;
}

// A player's gains in one competition at each mark, from WOM's top history (lifetime values,
// newest first). The last mark is their gains from the competition details. Values before the
// player's first update, or unranked (-1), count as no gains yet.
function playerGainsAt(marks, history, progress) {
  const baseline = progress.end - progress.gained;
  return marks.map((t, i) => {
    if (i === marks.length - 1) return progress.gained;
    const snapshot = history.find(h => new Date(h.date).getTime() <= t);
    if (!snapshot || snapshot.value < 0) return 0;
    return Math.min(Math.max(snapshot.value - baseline, 0), progress.gained);
  });
}

// What the progress chart of a winners list draws: the top 5 players' gains and the clan's total
// gains (every participant who gained) at each day mark. Null when nobody gained.
async function loadChartData(list, { fresh = false, now = Date.now() } = {}) {
  if (list.ranked.length === 0) return null;
  const startsAt = Math.min(...list.competitions.map(c => new Date(c.startsAt).getTime()));
  const endsAt = Math.max(...list.competitions.map(c => new Date(c.endsAt).getTime()));
  const marks = chartMarks(startsAt, endsAt, now);
  const top = list.ranked.slice(0, CHART_PLAYERS);
  const players = top.map(row => ({ name: row.name, final: row.gained, values: marks.map(() => 0) }));
  const total = marks.map(() => 0);

  for (const competition of list.competitions) {
    const history = await cachedWomCall(
      `tophistory:${competition.id}`,
      `Loading the top history of competition #${competition.id}`,
      () => getCompetitionTopHistory(competition.id),
      { fresh }
    );
    const historyByPlayer = new Map(history.map(entry => [entry.player.id, entry.history]));
    const progressByPlayer = new Map(competition.participations.map(p => [p.player.id, p.progress]));

    top.forEach((row, i) => {
      const progress = progressByPlayer.get(row.id);
      if (!progress) return;
      playerGainsAt(marks, historyByPlayer.get(row.id) ?? [], progress).forEach((value, m) => {
        players[i].values[m] += value;
      });
    });

    // Marks in between come from the group's gains since the start; the last is the details' total.
    const participantIds = new Set(competition.participations.map(p => p.player.id));
    for (let m = 1; m < marks.length; m++) {
      let gains;
      if (m === marks.length - 1) {
        gains = competition.participations.map(p => p.progress.gained);
      } else {
        const rows = await cachedWomCall(
          `gains:${competition.id}:${marks[m]}`,
          `Loading the group's gains for competition #${competition.id}`,
          () => getGroupGains(competition.groupId, competition.metric, new Date(competition.startsAt), new Date(marks[m])),
          { fresh }
        );
        gains = rows.filter(r => participantIds.has(r.player.id)).map(r => r.data.gained);
      }
      total[m] += gains.reduce((sum, gained) => sum + Math.max(gained, 0), 0);
    }
  }

  return { title: list.title, metric: list.metric, marks, players, total };
}

function readStore() {
  const store = readJson(DATA_FILE);
  return { ...store, drafts: store.drafts ?? {}, jobs: store.jobs ?? {} };
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

// Moves the draft to the scheduled jobs under the same ID. Null if it no longer exists, e.g. when
// Accept is pressed twice.
function acceptDraft(id, acceptedBy) {
  const store = readStore();
  const draft = store.drafts[id];
  if (!draft) return null;
  delete store.drafts[id];
  const job = { ...draft, status: 'scheduled', acceptedBy, acceptedAt: new Date().toISOString(), sent: { winners: null, announcements: [] } };
  store.jobs[id] = job;
  saveStore(store);
  return job;
}

// The announcements as they're sent in message 2.
function joinAnnouncements(announcements) {
  return announcements.join(ANNOUNCEMENT_SEPARATOR);
}

// The announcements as message texts: one message if they fit, otherwise two split between
// announcements (the first as full as possible). Null if they don't fit in two.
function splitAnnouncements(announcements) {
  if (announcements.length === 0) return [];
  const joined = joinAnnouncements(announcements);
  if (joined.length <= MESSAGE_LIMIT) return [joined];
  for (let cut = announcements.length - 1; cut >= 1; cut--) {
    const parts = [joinAnnouncements(announcements.slice(0, cut)), joinAnnouncements(announcements.slice(cut))];
    if (parts.every(part => part.length <= MESSAGE_LIMIT)) return parts;
  }
  return null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "@Role Name" and "#channel-name" typed as plain text become real mentions of the server's roles
// and channels, ignoring case and matching longer names first. @everyone, @here and mentions
// already in <@&id> / <#id> form are left as they are.
function resolveMentions(text, guild) {
  if (!guild) return text;
  let resolved = text;
  const roles = [...guild.roles.cache.values()]
    .filter(role => role.id !== guild.id && role.name.trim() && !/^(everyone|here)$/i.test(role.name))
    .sort((a, b) => b.name.length - a.name.length);
  for (const role of roles) {
    const pattern = new RegExp(`(^|[^\\w<&@])@${escapeRegExp(role.name)}(?![\\w-])`, 'gi');
    resolved = resolved.replace(pattern, (_, before) => `${before}<@&${role.id}>`);
  }
  const channels = [...guild.channels.cache.values()]
    .filter(channel => channel.name && !/\s/.test(channel.name) && channel.type !== ChannelType.GuildCategory)
    .sort((a, b) => b.name.length - a.name.length);
  for (const channel of channels) {
    const pattern = new RegExp(`(^|[^\\w<#])#${escapeRegExp(channel.name)}(?![\\w-])`, 'gi');
    resolved = resolved.replace(pattern, (_, before) => `${before}<#${channel.id}>`);
  }
  return resolved;
}

// Message 2's texts for the draft as it would be sent, or null if too long for two messages.
function announcementParts(draft, guild) {
  return splitAnnouncements(draft.announcements.map(text => resolveMentions(text, guild)));
}

// Names chart files after their metric, numbering repeats.
function uniqueFileName(metric, used) {
  let name = chartFileName(metric);
  for (let n = 2; used.has(name); n++) name = chartFileName(`${metric}-${n}`);
  used.add(name);
  return name;
}

// Everything the post needs, as the preview shows it and the send posts it:
// - winnersText: message 1's text, or null when no competition has ended by the send time
// - charts: [{ attachment, name }] for message 1; chartProblems: why a list has no chart
// - winnersError: why the winners couldn't be loaded from WOM, if they couldn't
// - running: whether any of the competitions is still running (the winners are standings so far)
// - runningAtSend: whether any will still be running at the send time, so the post won't have the
//   final results
// - winners: [{ name, userId }] for each RSN the winners text names, userId null when no server
//   member matched it (shown in bold instead of a mention)
// - emojiProblems: why a list's heading has no pet emoji
// - announcements: each announcement with plain @Role / #channel text turned into mentions
// - announcementParts: message 2's texts (two when over the limit), or null if too long for two
async function buildPost(draft, guild, { fresh = false } = {}) {
  const announcements = draft.announcements.map(text => resolveMentions(text, guild));
  const post = {
    winnersText: null,
    charts: [],
    chartProblems: [],
    winnersError: null,
    running: false,
    runningAtSend: false,
    winners: [],
    emojiProblems: [],
    competitions: [],
    announcements,
    announcementParts: splitAnnouncements(announcements),
  };

  let lists;
  try {
    post.competitions = await competitionsForDraft(draft, Number(process.env.WOM_GROUP_ID));
    lists = await loadWinnerLists(post.competitions, { fresh });
  } catch (err) {
    post.winnersError = err.message;
    return post;
  }
  if (lists.length === 0) return post;

  const names = winnerNames(lists);
  const mentions = guild && names.length ? matchMembers(names, await loadMembers(guild)) : new Map();
  const emojis = guild ? await loadBotEmojis(guild.client) : [];
  post.winners = names.map(name => ({ name, userId: mentions.get(name) ?? null }));
  for (const list of lists) {
    const pet = metricPet(list.metric);
    if (!pet) post.emojiProblems.push(`${list.title}: no pet is listed for ${metricName(list.metric)}`);
    else if (!findPetEmoji(list.metric, emojis)) post.emojiProblems.push(`${list.title}: the bot has no emoji named after ${pet}`);
  }
  post.winnersText = buildWinnersText(lists, { emojis, mentions });
  const endsAfter = at => lists.some(list => list.competitions.some(c => new Date(c.endsAt).getTime() > at));
  post.running = endsAfter(Date.now());
  post.runningAtSend = endsAfter(new Date(draft.sendAt).getTime());
  const usedNames = new Set();
  for (const list of lists) {
    try {
      const data = await loadChartData(list, { fresh });
      if (!data) {
        post.chartProblems.push(`${list.title}: nobody has gained yet`);
        continue;
      }
      post.charts.push({ attachment: renderProgressChart(data), name: uniqueFileName(list.metric, usedNames) });
    } catch (err) {
      console.error(`[WeeklyAnnounce] Failed to draw the chart for ${list.title}:`, err);
      post.chartProblems.push(`${list.title}: ${err.message}`);
    }
  }
  return post;
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
  loadChartData,
  createDraft,
  getDraft,
  updateDraft,
  deleteDraft,
  acceptDraft,
  joinAnnouncements,
  announcementParts,
  buildPost,
};
