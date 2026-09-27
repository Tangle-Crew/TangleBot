const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  AttachmentBuilder,
  MessageFlags,
  escapeMarkdown,
  parseEmoji,
} = require('discord.js');
const { GROUP_ROLES, GroupRoleProps } = require('@wise-old-man/utils');
const { getGroupDetails, getGroupGains, updateAllGroupMembers, womEvents } = require('../utils/wiseOldMan');
const { DEFAULT_EMBED_COLOR } = require('../utils/embedColor');
const {
  DATA_DIR,
  truncate,
  readJson,
  writeJson,
  withFileLock,
  discordTimestamp,
  withTimeout,
} = require('../utils/db');
const { notifyAdminLog } = require('../utils/roleMenu');
const { buildXlsx } = require('../utils/xlsx');

const TEMPLAR_ROLE_ID = process.env.TEMPLAR_ROLE_ID;
// Every list is posted here, wherever the command is run.
const ADMIN_LOG_CHANNEL_ID = process.env.ADMIN_LOG_CHANNEL_ID;
// { list: { header, inactive, lowXp } }, the newest list's message IDs, so the next run can delete it
// even after a restart.
const DATA_FILE = 'stalemembers.json';
// Every export is also saved here; only the newest few are kept.
const EXPORT_DIR = path.join(DATA_DIR, 'stalemembers-exports');
const EXPORT_PREFIX = 'stale-members-export-';
const MAX_SAVED_EXPORTS = 5;
// Each list is posted as its own message under the header message, in this order.
const SECTIONS = ['inactive', 'lowXp'];
// Members per page of each list. Well under Discord's 4096-character limit; truncate is the backstop.
const PAGE_SIZE = 15;
// How long a refresh waits for WOM to process update all, as the competition reminder does.
const REFRESH_WAIT_MS = 5 * 60 * 1000;
// Names this command's own update all, so it doesn't also trigger an automatic refresh.
const OWN_UPDATE_SOURCE = '/stalemembers';
const MAX_MONTHS = 60;
// The WOM client sets no timeout of its own.
const REQUEST_TIMEOUT_MS = 20 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Members inactive for all but this much of the window are listed as close.
const CLOSE_MS = 2 * WEEK_MS;
// A member whose WOM profile is older than this may have gains WOM hasn't seen yet.
const OUTDATED_MS = WEEK_MS;
// How long autocomplete reuses the group's ranks before reloading them.
const RANKS_CACHE_TTL_MS = 30 * 60 * 1000;
// Autocomplete must answer within 3 seconds, so it only waits this long for WOM.
const AUTOCOMPLETE_WAIT_MS = 2000;
// Posted lists kept in memory for the buttons; past this the oldest is dropped, as on a restart.
const MAX_LOADED_LISTS = 50;
const BUTTON_PREFIX = 'stalemembers:';
// Typed in `ignore` to check every rank without the picker.
const IGNORE_NONE = 'None';
const TITLE = '💤 Stale Members';

// Ranks can be typed as their WOM key or display name, in any case, with spaces, hyphens or
// underscores: "Deputy Owner", "deputy-owner" and "deputy_owner" all match.
function normalizeRank(text) {
  return String(text ?? '').toLowerCase().trim().replace(/[\s_-]+/g, '_');
}

// "deputy_owner" -> "Deputy Owner".
function rankName(role) {
  return String(GroupRoleProps[role]?.name ?? role).replace(/_/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase());
}

let groupRanks = null; // { ranks, loadedAt }, the group's ranks in its own order
let pendingRanks = null;
let rankEmojis = null; // rank -> the bot's emoji for it, loaded once
// Header message ID -> { view, ids, pages, updating } for each posted list: `ids` holds its three
// message IDs ({ header, inactive, lowXp }) and `pages` each list's page. Lost on restart.
const loadedLists = new Map();
// The refresh in progress, or null. One for the whole group, since update all covers everyone.
// Started by a Refresh press (`requester`, `button`) or another feature's update all (`source`);
// `waiting` maps user IDs to everyone to DM when it's done.
let activeRefresh = null;

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

const RANKS_BY_NAME = new Map();
for (const role of GROUP_ROLES) {
  RANKS_BY_NAME.set(normalizeRank(role), role);
  RANKS_BY_NAME.set(normalizeRank(rankName(role)), role);
}

// "a, b, c" -> { roles, unknown }. Blank entries are skipped.
function parseRanks(input) {
  const roles = new Set();
  const unknown = [];
  for (const part of String(input ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const role = RANKS_BY_NAME.get(normalizeRank(part));
    if (role) roles.add(role);
    else unknown.push(part);
  }
  return { roles, unknown };
}

const XP_UNITS = [['k', 1e3], ['m', 1e6], ['b', 1e9]];
const XP_UNIT_SIZES = Object.fromEntries(XP_UNITS);

// "250k", "1.5m", "250,000" or "250000xp" -> 250000, or null if it isn't a number.
function parseXp(input) {
  const match = String(input).toLowerCase().replace(/[\s,_]/g, '').replace(/xp$/, '').match(/^(\d+(?:\.\d+)?|\.\d+)([kmb])?$/);
  if (!match) return null;
  return Math.round(Number(match[1]) * (XP_UNIT_SIZES[match[2]] ?? 1));
}

// 250000 -> "250k", 1234567 -> "1.2m", 999999 -> "1m".
function formatXp(amount) {
  const short = value => value.toLocaleString('en-US', { maximumFractionDigits: 1 });
  for (let i = XP_UNITS.length - 1; i >= 0; i--) {
    const [suffix, size] = XP_UNITS[i];
    if (amount < size) continue;
    const next = XP_UNITS[i + 1];
    if (next && Math.round((amount / size) * 10) / 10 >= 1000) return `${short(amount / next[1])}${next[0]}`;
    return `${short(amount / size)}${suffix}`;
  }
  return amount.toLocaleString('en-US');
}

// `time` moved by `n` calendar months, clamped to the target month's last day (Aug 31 minus 6
// months is Feb 28).
function addMonths(time, n) {
  const date = new Date(time);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + n);
  date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  return date.getTime();
}

// "7 months, 2 weeks" from `since` to `now`: whole calendar months, then whole weeks. A `since`
// after `now` (WOM's clock slightly ahead) gives "under a week".
function formatDuration(since, now) {
  let months = 0;
  while (addMonths(since, months + 1) <= now) months++;
  const weeks = Math.max(0, Math.floor((now - addMonths(since, months)) / WEEK_MS));
  const parts = [...(months ? [plural(months, 'month')] : []), ...(weeks ? [plural(weeks, 'week')] : [])];
  return parts.length ? parts.join(', ') : 'under a week';
}

// The group's ranks in its own rank order, plus any held by members but missing from that order.
function saveGroupRanks(details) {
  const order = new Map(details.roleOrders.map(r => [r.role, r.index]));
  for (const m of details.memberships) if (!order.has(m.role)) order.set(m.role, Infinity);
  const ranks = [...order].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([role]) => role);
  groupRanks = { ranks, loadedAt: Date.now() };
}

// Ranks in the group's rank order (any it doesn't use go last, alphabetically).
function inRankOrder(roles) {
  const order = groupRanks?.ranks ?? [];
  const position = role => (order.includes(role) ? order.indexOf(role) : order.length);
  return [...roles].sort((a, b) => position(a) - position(b) || a.localeCompare(b));
}

// The group's ranks, reloaded after RANKS_CACHE_TTL_MS. Waits at most `waitMs` for WOM (the load
// carries on in the background); null if never loaded.
async function loadGroupRanks(groupId, waitMs) {
  if (groupRanks && Date.now() - groupRanks.loadedAt < RANKS_CACHE_TTL_MS) return groupRanks.ranks;
  if (!pendingRanks) {
    console.log(`[StaleMembers] Loading WOM group ${groupId}'s ranks for autocomplete.`);
    pendingRanks = getGroupDetails(groupId)
      .then(saveGroupRanks)
      .catch(err => console.warn(`[StaleMembers] Failed to load WOM group ${groupId}'s ranks:`, err.message))
      .finally(() => { pendingRanks = null; });
  }
  let timer;
  await Promise.race([pendingRanks, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
  clearTimeout(timer);
  return groupRanks?.ranks ?? null;
}

// Emoji names vary in separators ("Deputy_owner", "SpeedRunner"), so only letters and digits count.
function emojiKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Each rank's emoji from the bot's application emojis, loaded once. On failure, ranks show as names
// and the next call retries.
async function loadRankEmojis(client) {
  if (rankEmojis) return rankEmojis;
  try {
    const emojis = await withTimeout(client.application.emojis.fetch(), 'Loading the bot emojis', REQUEST_TIMEOUT_MS);
    const byKey = new Map(emojis.map(e => [emojiKey(e.name), e.toString()]));
    rankEmojis = new Map(GROUP_ROLES.filter(role => byKey.has(emojiKey(role))).map(role => [role, byKey.get(emojiKey(role))]));
    console.log(`[StaleMembers] Matched ${rankEmojis.size} of ${GROUP_ROLES.length} ranks to the bot's ${emojis.size} emojis.`);
    return rankEmojis;
  } catch (err) {
    console.warn('[StaleMembers] Failed to load the bot emojis, showing rank names instead:', err.message);
    return new Map();
  }
}

function reportError(interaction, title, detail) {
  return notifyAdminLog(
    interaction.client,
    `⚠️ /stalemembers: ${title}`,
    truncate(`${interaction.user} used /stalemembers.\n\n${detail}`, 4096)
  );
}

// "Nickname (username)", readable outside Discord (the export). No "@", which spreadsheets read as a
// formula.
function memberName(interaction) {
  const nickname = interaction.member?.displayName;
  const { username } = interaction.user;
  return nickname && nickname !== username ? `${nickname} (${username})` : username;
}

function timeOrNull(date) {
  return date ? new Date(date).getTime() : null;
}

// Members to list, from those outside the ignored ranks and in the group the whole window, in two
// sections: inactive (no change in the window, or close: none since its first CLOSE_MS), then low
// XP (active later, but gained under `minXp`). No WOM data in the window counts as 0 gained.
async function findStaleMembers(groupId, { months, startDate, endDate, minXp, ignoredRoles }) {
  const [details, gains] = await Promise.all([
    withTimeout(getGroupDetails(groupId), 'Loading the group members', REQUEST_TIMEOUT_MS),
    withTimeout(getGroupGains(groupId, 'overall', startDate, endDate), 'Loading the group gains', REQUEST_TIMEOUT_MS),
  ]);
  const gainedById = new Map(gains.map(row => [row.player.id, row.data.gained]));
  saveGroupRanks(details);

  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  const notIgnored = details.memberships.filter(m => !ignoredRoles.has(m.role));
  // Skips anyone who joined during the window, by the earlier of WOM's two join dates
  // (clientSyncJoinedAt survives WOM re-adding someone, e.g. after a name change). No date counts
  // as old.
  const joinedDuringWindow = m => {
    const dates = [m.createdAt, m.clientSyncJoinedAt].map(timeOrNull).filter(t => t !== null);
    return dates.length > 0 && Math.min(...dates) > startMs;
  };
  const checked = notIgnored.filter(m => !joinedDuringWindow(m));
  const listed = checked
    .map(m => {
      const gained = gainedById.get(m.player.id) ?? null;
      const lastChangedAt = timeOrNull(m.player.lastChangedAt);
      const inactive = lastChangedAt === null || lastChangedAt <= startMs + CLOSE_MS;
      const lowXp = !inactive && (gained ?? 0) < minXp;
      // When a close member will have been inactive for the whole window. Month-end clamping can put
      // that in the past, and then they already have.
      const closeAt = inactive && lastChangedAt > startMs ? addMonths(lastChangedAt, months) : null;
      return {
        name: m.player.displayName,
        role: m.role,
        status: m.player.status,
        gained,
        lastChangedAt,
        updatedAt: timeOrNull(m.player.updatedAt),
        section: inactive ? 'inactive' : lowXp ? 'lowXp' : null,
        closeAt: closeAt > endMs ? closeAt : null,
      };
    })
    .filter(row => row.section !== null)
    // Never seen changing sorts first, then the oldest change, then the least gained.
    .sort((a, b) =>
      (a.lastChangedAt ?? -Infinity) - (b.lastChangedAt ?? -Infinity) ||
      (a.gained ?? -1) - (b.gained ?? -1) ||
      a.name.localeCompare(b.name)
    );
  const sections = Object.fromEntries(SECTIONS.map(section => [section, listed.filter(row => row.section === section)]));
  const closeCount = sections.inactive.filter(row => row.closeAt !== null).length;

  return {
    groupRoles: new Set(groupRanks.ranks),
    checked: checked.length,
    ignored: details.memberships.length - notIgnored.length,
    joinedRecently: notIgnored.length - checked.length,
    untracked: checked.filter(m => !gainedById.has(m.player.id)).length,
    inactiveCount: sections.inactive.length - closeCount,
    closeCount,
    lowXpCount: sections.lowXp.length,
    listed,
    sections,
  };
}

// The markers a row gets, with what each means for the legend and the export notes.
const MARKERS = [
  {
    emoji: '⏳',
    legend: "WOM hasn't updated them in over a week, so they may have gained XP it hasn't seen yet.",
    note: 'WOM not updated in 7+ days',
    applies: (row, view) => row.updatedAt === null || view.now - row.updatedAt > OUTDATED_MS,
  },
  {
    emoji: '❓',
    legend: "WOM can't track them (unranked, flagged, archived or banned on WOM), so their XP may be wrong.",
    note: row => `WOM status: ${row.status}`,
    applies: row => row.status !== 'active',
  },
];

function markersFor(row, view) {
  return MARKERS.filter(marker => marker.applies(row, view));
}

function formatRow(row, index, view) {
  const gained = row.gained === null ? 'no WOM data' : `${formatXp(row.gained)} XP`;
  const active = row.lastChangedAt
    ? `last active **${formatDuration(row.lastChangedAt, view.now)}** ago (${discordTimestamp(row.lastChangedAt, 'd')})`
    : 'never seen active';
  // Counts down live in Discord: "in 9 days".
  const close = row.closeAt !== null ? ` · ⌛ ${plural(view.months, 'month')} inactive ${discordTimestamp(row.closeAt, 'R')}` : '';
  const flags = markersFor(row, view).map(marker => marker.emoji).join('');
  const emoji = view.emojis.get(row.role);
  const name = `**${escapeMarkdown(row.name)}**`;
  return `**${index + 1}.** ${emoji ? `${emoji} ${name}` : `${name} (${rankName(row.role)})`} — ${gained} · ${active}${close}` +
    (flags ? ` ${flags}` : '');
}

// A list's title, without and with its emoji.
function sectionName(section, view) {
  return section === 'inactive'
    ? `Inactive for ${plural(view.months, 'month')}`
    : `Active, but under ${formatXp(view.minXp)} XP`;
}

function sectionTitle(section, view) {
  return `${section === 'inactive' ? '😴' : '📉'} ${sectionName(section, view)}`;
}

function pageCount(view, section) {
  return Math.max(1, Math.ceil(view.sections[section].length / PAGE_SIZE));
}

// Each list's page, kept in range after a reload changed its length.
function clampPages(view, pages) {
  return Object.fromEntries(SECTIONS.map(section => [section, Math.min(pages?.[section] ?? 0, pageCount(view, section) - 1)]));
}

// Refresh needs the verification code, since it asks WOM to update the whole group.
function canRefresh() {
  return Boolean(process.env.WOM_GROUP_VERIFICATION_CODE);
}

// The header message: the options, result, marker legend and button help (buttons can't show hover
// text).
function buildHeader(view) {
  const {
    listed, inactiveCount, closeCount, lowXpCount, checked, ignored, joinedRecently, ignoredRoles, groupRoles, months, minXp, startMs, untracked, emojis,
  } = view;

  // Only ranks the group uses; ignoring any other changes nothing.
  const shown = inRankOrder(ignoredRoles).filter(role => groupRoles.has(role));
  let ignoring = 'none';
  if (shown.length > 0) {
    const labels = shown.map(role => emojis.get(role) ?? rankName(role));
    // Emojis sit side by side; names need commas.
    const separator = shown.every(role => emojis.has(role)) ? ' ' : ', ';
    ignoring = `${labels.join(separator)} (${plural(ignored, 'member')} skipped)`;
  }
  const options = [
    // Discord shows these times in each viewer's own timezone.
    `**Checked:** ${discordTimestamp(view.now, 'f')} (${discordTimestamp(view.now, 'R')})` +
      (view.checkedBy.id ? ` by <@${view.checkedBy.id}>` : `, ${view.checkedBy.label}`),
    `**Time:** ${plural(months, 'month')} (since ${discordTimestamp(startMs, 'D')})`,
    `**Min XP:** ${formatXp(minXp)}`,
    `**Ignoring:** ${ignoring}`,
  ];

  const xp = `**${formatXp(minXp)} XP**`;
  const result = [
    listed.length === 0
      ? `All **${checked}** members checked were active and gained at least ${xp}.`
      : `Of **${checked}** members checked (each list below is longest inactive first):`,
    ...(listed.length > 0
      ? [`**${inactiveCount}** ${inactiveCount === 1 ? "hasn't" : "haven't"} been active in ${plural(months, 'month')}.`]
      : []),
    ...(closeCount > 0
      ? [`**${closeCount}** ${closeCount === 1 ? 'is' : 'are'} close (⌛): inactive for at least ` +
        `${formatDuration(startMs + CLOSE_MS, view.now)}. ⌛ shows when they reach ${plural(months, 'month')}.`]
      : []),
    ...(listed.length > 0
      ? [`**${lowXpCount}** ${lowXpCount === 1 ? 'was' : 'were'} active more recently, but gained less than ${xp}.`]
      : []),
    ...(untracked > 0
      ? [`${untracked} member${untracked === 1 ? ' has' : 's have'} no WOM data in this window and count as 0 XP.`]
      : []),
    ...(joinedRecently > 0
      ? [`${plural(joinedRecently, 'member')} joined the WOM group in the last ${plural(months, 'month')} and ${joinedRecently === 1 ? "isn't" : "aren't"} checked.`]
      : []),
  ];

  // Only the markers the lists use.
  const legend = MARKERS
    .filter(marker => listed.some(row => marker.applies(row, view)))
    .map(marker => `${marker.emoji} ${marker.legend}`);

  const buttons = [
    "🔄 **Update** reloads both lists with WOM's latest data.",
    ...(canRefresh()
      ? [`🔃 **Refresh WOM** has WOM re-check everyone's hiscores first, then updates the lists in about ${REFRESH_WAIT_MS / 60000} minutes and DMs you.`]
      : []),
    '📄 **Export all** sends you both lists as a spreadsheet, one tab each. Each list has its own ◀ ▶ pages and 📄 **Export**.',
  ];

  return [options, result, ...(legend.length > 0 ? [legend] : []), buttons].map(lines => lines.join('\n')).join('\n\n');
}

function buildHeaderEmbed(view) {
  return new EmbedBuilder()
    .setColor(DEFAULT_EMBED_COLOR)
    .setTitle(TITLE)
    .setDescription(truncate(buildHeader(view), 4096))
    .setTimestamp(view.now);
}

function buildSectionEmbed(view, section, page) {
  const all = view.sections[section];
  const totalPages = pageCount(view, section);
  const start = page * PAGE_SIZE;
  const rows = all.slice(start, start + PAGE_SIZE).map((row, i) => formatRow(row, start + i, view));
  if (rows.length === 0) {
    rows.push(section === 'inactive'
      ? `Nobody has been inactive for ${plural(view.months, 'month')}.`
      : `Nobody active more recently gained less than ${formatXp(view.minXp)} XP.`);
  }
  // Pads the last page to the same height so the buttons don't move. Discord trims trailing empty
  // lines, so each pad is a zero-width space.
  if (totalPages > 1 && page === totalPages - 1) {
    while (rows.length < PAGE_SIZE) rows.push('\u200b');
  }
  return new EmbedBuilder()
    .setColor(DEFAULT_EMBED_COLOR)
    .setTitle(sectionTitle(section, view))
    .setDescription(truncate(rows.join('\n'), 4096))
    .setFooter({ text: `Page ${page + 1}/${totalPages} · ${plural(all.length, 'member')}` })
    .setTimestamp(view.now);
}

// Like formatXp, but only shortened when nothing is lost: 250000 -> "250k", 1234567 stays as is.
function exactXp(amount) {
  for (const [suffix, size] of [['b', 1e9], ['m', 1e6], ['k', 1e3]]) {
    if (amount >= size && Number.isInteger(amount * 100 / size)) return `${amount / size}${suffix}`;
  }
  return String(amount);
}

// The command with these options, in the `option:value` form Discord fills in when it's pasted.
function commandText({ months, minXp, ignoredRoles }) {
  const ignore = ignoredRoles.size > 0 ? inRankOrder(ignoredRoles).map(rankName).join(', ') : IGNORE_NONE;
  return `/stalemembers time:${months} minxp:${exactXp(minXp)} ignore:${ignore}`;
}

// The Update button, rank picker and Run button carry the options in their custom ID, so they work
// after a restart. Ignored ranks are a bitmask over GROUP_ROLES in base 36 (at most 52 characters,
// within Discord's 100), tagged with the list's length so a changed list isn't misread.
const RANKS_VERSION = GROUP_ROLES.length.toString(36);

function queryCustomId(action, { months, minXp, ignoredRoles }) {
  let mask = 0n;
  for (const role of ignoredRoles) mask |= 1n << BigInt(GROUP_ROLES.indexOf(role));
  return `${BUTTON_PREFIX}${action}:${RANKS_VERSION}:${months}:${minXp.toString(36)}:${mask.toString(36)}`;
}

function updateButtonId(query) {
  return queryCustomId('update', query);
}

// The options stored by queryCustomId, or null if they can't be read.
function queryFromButtonId(customId) {
  const [, , version, months, minXp, ranks] = customId.split(':');
  if (version !== RANKS_VERSION || !/^\d+$/.test(months ?? '') || !/^[0-9a-z]+$/.test(minXp ?? '') || !/^[0-9a-z]+$/.test(ranks ?? '')) {
    return null;
  }
  const mask = [...ranks].reduce((n, digit) => n * 36n + BigInt(parseInt(digit, 36)), 0n);
  const ignoredRoles = new Set(GROUP_ROLES.filter((_, i) => (mask >> BigInt(i)) & 1n));
  return { months: Number(months), minXp: parseInt(minXp, 36), ignoredRoles };
}

// The options stored on a posted list's Update button, or null.
function queryFromMessage(message) {
  const update = message.components
    ?.flatMap(row => row.components ?? [])
    .find(c => c.customId?.startsWith(`${BUTTON_PREFIX}update`));
  return update ? queryFromButtonId(update.customId) : null;
}

// Message IDs grow over time, so a smaller one was posted earlier.
function isOlder(id, than) {
  return BigInt(id) < BigInt(than);
}

// The newest list's message IDs from the data file, or null. A saved `messageId` is a list posted as
// one message, so only its header is known.
function savedList() {
  const data = readJson(DATA_FILE);
  if (data.list?.header) return data.list;
  return data.messageId ? { header: data.messageId } : null;
}

// Every message of a list, header first.
function messageIdsOf(ids) {
  return [ids.header, ...SECTIONS.map(section => ids[section])].filter(Boolean);
}

// Deletes every list but the newest: those in memory, the one in the data file (from before a
// restart) and `others`. Lists are told apart by their header, and keeping the newest by message age
// means overlapping runs leave the later list. Failures are logged and skipped.
function replaceOldLists(client, newIds, others = []) {
  return withFileLock(DATA_FILE, async () => {
    const saved = savedList();
    const known = new Map();
    for (const ids of [newIds, ...[...loadedLists.values()].map(state => state.ids), ...(saved ? [saved] : []), ...others]) {
      known.set(ids.header, { ...known.get(ids.header), ...ids });
    }
    const newest = [...known.keys()].reduce((a, b) => (isOlder(a, b) ? b : a));

    const old = [...known].filter(([header]) => header !== newest);
    if (old.length > 0) {
      try {
        const channel = await client.channels.fetch(ADMIN_LOG_CHANNEL_ID);
        // Every old message at once.
        await Promise.all(old.flatMap(([header, ids]) => {
          loadedLists.delete(header);
          console.log(`[StaleMembers] Deleting old list ${header}.`);
          return messageIdsOf(ids).map(id => channel.messages.delete(id).catch(err => {
            // 10008 Unknown Message: it was already deleted.
            if (err?.code !== 10008) console.warn(`[StaleMembers] Couldn't delete message ${id} of old list ${header}:`, err.message);
          }));
        }));
      } catch (err) {
        console.warn("[StaleMembers] Couldn't load the admin log to delete old lists:", err.message);
      }
    }

    const keep = known.get(newest);
    if (messageIdsOf(keep).join() !== (saved ? messageIdsOf(saved).join() : '')) {
      try {
        writeJson(DATA_FILE, { list: keep });
      } catch (err) {
        console.error(`[StaleMembers] Couldn't save list ${newest} to ${DATA_FILE}:`, err.message);
      }
    }
  });
}

// Update, Refresh WOM and Export all, under the header.
function headerButtons({ view }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(updateButtonId(view))
      .setLabel('🔄 Update')
      .setStyle(ButtonStyle.Primary),
    // Red, since it has WOM re-check the whole group.
    ...(canRefresh()
      ? [new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}refresh`).setLabel('🔃 Refresh WOM').setStyle(ButtonStyle.Danger)]
      : []),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}export`)
      .setLabel('📄 Export all')
      .setStyle(ButtonStyle.Success)
      .setDisabled(view.listed.length === 0)
  );
}

// Prev, Next and Export under a list, each naming the list in its custom ID.
function sectionButtons({ view, pages }, section) {
  const page = pages[section];
  const totalPages = pageCount(view, section);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}prev:${section}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}next:${section}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}export:${section}`)
      .setLabel('📄 Export')
      .setStyle(ButtonStyle.Success)
      .setDisabled(view.sections[section].length === 0)
  );
}

function exportDate(time) {
  return time === null ? '' : new Date(time).toISOString().slice(0, 10);
}

// "2026-09-27 14:30 UTC". A spreadsheet can't use Discord's local-time stamps.
function exportTime(time) {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// Each column's title and width in characters.
const EXPORT_COLUMNS = [
  ['#', 5], ['Name', 16], ['Rank', 14], ['Status', 36], ['XP gained', 11],
  ['Last active', 12], ['Inactive for', 18], ['WOM last updated', 17], ['Notes', 45],
];

// One list as a spreadsheet tab, in embed order, after rows for which list it is, when it was
// checked, who exported it and when, and the options.
function exportSheet(view, section, { exportedBy, exportedAt }) {
  const info = [
    ['Stale Members export'],
    ['List', sectionName(section, view)],
    ['Data checked', exportTime(view.now), 'by', view.checkedBy.name],
    ['Exported', exportTime(exportedAt), 'by', exportedBy],
    ['Options', commandText(view)],
    [],
  ];
  const rows = view.sections[section].map((row, i) => [
    i + 1,
    row.name,
    rankName(row.role),
    row.closeAt !== null
      ? `Close (${plural(view.months, 'month')} inactive on ${exportDate(row.closeAt)})`
      : row.section === 'inactive' ? 'Inactive' : `Active, under ${exactXp(view.minXp)} XP`,
    row.gained ?? '',
    exportDate(row.lastChangedAt),
    row.lastChangedAt ? formatDuration(row.lastChangedAt, view.now) : 'never seen active',
    exportDate(row.updatedAt),
    [
      ...(row.gained === null ? ['no WOM data'] : []),
      ...markersFor(row, view).map(marker => (typeof marker.note === 'function' ? marker.note(row) : marker.note)),
    ].join('; '),
  ]);
  return {
    name: sectionName(section, view),
    rows: [...info, EXPORT_COLUMNS.map(([title]) => title), ...rows],
    widths: EXPORT_COLUMNS.map(([, width]) => width),
    boldRows: [0, info.length],
  };
}

// "stale-members-export-2026-09-27_14-30-05.xlsx" (UTC), so exports sort oldest to newest. One list's
// export ends in its name, e.g. "-inactive".
function exportFileName(time, section) {
  const suffix = section ? `-${section === 'inactive' ? 'inactive' : 'low-xp'}` : '';
  return `${EXPORT_PREFIX}${new Date(time).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}${suffix}.xlsx`;
}

// Saves a copy in EXPORT_DIR, keeping the newest MAX_SAVED_EXPORTS. A same-second name gets "_2" and
// so on ("_" sorts after ".", so it counts as newer). Returns the name used.
function saveExport(name, file) {
  return withFileLock(EXPORT_DIR, async () => {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    let saveAs = name;
    for (let n = 2; fs.existsSync(path.join(EXPORT_DIR, saveAs)); n++) saveAs = name.replace(/\.xlsx$/, `_${n}.xlsx`);
    fs.writeFileSync(path.join(EXPORT_DIR, saveAs), file);
    const old = fs.readdirSync(EXPORT_DIR)
      .filter(entry => entry.startsWith(EXPORT_PREFIX) && entry.endsWith('.xlsx'))
      .sort()
      .slice(0, -MAX_SAVED_EXPORTS);
    for (const entry of old) {
      fs.rmSync(path.join(EXPORT_DIR, entry), { force: true });
      console.log(`[StaleMembers] Deleted old export ${entry}, keeping the newest ${MAX_SAVED_EXPORTS}.`);
    }
    return saveAs;
  });
}

// Sends one list, or with no `section` both as a tab each, as a spreadsheet, privately to whoever
// pressed Export, and keeps a copy on the bot.
async function exportList(button, state, section) {
  const { view } = state;
  const sections = section ? [section] : SECTIONS;
  const exportedAt = Date.now();
  const exportedBy = memberName(button);
  const file = buildXlsx(sections.map(s => exportSheet(view, s, { exportedBy, exportedAt })));
  const count = plural(sections.reduce((sum, s) => sum + view.sections[s].length, 0), 'member');
  let name = exportFileName(exportedAt, section);

  let saved = true;
  try {
    name = await saveExport(name, file);
  } catch (err) {
    saved = false;
    console.error(`[StaleMembers] Couldn't save export ${name}:`, err.message);
  }
  console.log(`[StaleMembers] ${button.user.tag} exported ${section ?? 'both lists'} from list ${state.ids.header} (${count}) as ${name}.`);

  const what = section ? `${count} from the ${sectionTitle(section, view)} list` : `Both lists (${count}), one tab each`;
  await button.reply({
    content: `${what}, checked ${discordTimestamp(view.now, 'f')}. Opens in Excel or Google Sheets. ` +
      (saved ? `A copy is saved on the bot (the last ${MAX_SAVED_EXPORTS} are kept).` : "Couldn't save a copy on the bot."),
    files: [new AttachmentBuilder(file, { name })],
    flags: MessageFlags.Ephemeral,
  });
}

function renderHeader(state) {
  return { embeds: [buildHeaderEmbed(state.view)], components: [headerButtons(state)] };
}

function renderSection(state, section) {
  return { embeds: [buildSectionEmbed(state.view, section, state.pages[section])], components: [sectionButtons(state, section)] };
}

// A loaded list, by any of its message IDs.
function findList(messageId) {
  for (const state of loadedLists.values()) {
    if (messageIdsOf(state.ids).includes(messageId)) return state;
  }
  return null;
}

function rememberList(state) {
  loadedLists.delete(state.ids.header);
  loadedLists.set(state.ids.header, state);
  if (loadedLists.size > MAX_LOADED_LISTS) loadedLists.delete(loadedLists.keys().next().value);
}

// Posts a list in the admin log: the header (through `postHeader` when given, e.g. as the command's
// reply), then each list under it. If any part fails, deletes what was posted and throws. Returns the
// message IDs.
async function sendList(client, state, postHeader) {
  const channel = await client.channels.fetch(ADMIN_LOG_CHANNEL_ID);
  const posted = [];
  try {
    const header = postHeader ? await postHeader(renderHeader(state)) : await channel.send(renderHeader(state));
    posted.push(header.id);
    const ids = { header: header.id };
    for (const section of SECTIONS) {
      ids[section] = (await channel.send(renderSection(state, section))).id;
      posted.push(ids[section]);
    }
    return ids;
  } catch (err) {
    await Promise.all(posted.map(id => channel.messages.delete(id).catch(() => {})));
    throw err;
  }
}

// Edits all of a posted list's messages at once. Throws 10008 Unknown Message if one was deleted.
async function editList(client, state) {
  const channel = await client.channels.fetch(ADMIN_LOG_CHANNEL_ID);
  await Promise.all([
    channel.messages.edit(state.ids.header, renderHeader(state)),
    ...SECTIONS.map(section => channel.messages.edit(state.ids[section], renderSection(state, section))),
  ]);
}

// Shows reloaded data on a posted list, keeping each list's page. If only its header is known (a
// list posted as one message), it's posted again in its place. Returns the list's message IDs, or
// null if it was deleted or a newer list replaced it.
async function showReloaded(client, headerId, view) {
  const old = loadedLists.get(headerId);
  const saved = savedList();
  if (!old && saved && isOlder(headerId, saved.header)) return null;
  const ids = old?.ids ?? (saved?.header === headerId ? saved : { header: headerId });
  const state = { view, ids, pages: clampPages(view, old?.pages) };

  if (SECTIONS.every(section => ids[section])) {
    try {
      await editList(client, state);
    } catch (err) {
      if (err?.code !== 10008) throw err;
      return null;
    }
    rememberList(state);
    return ids;
  }
  state.ids = await sendList(client, state);
  rememberList(state);
  await replaceOldLists(client, state.ids, [ids]);
  console.log(`[StaleMembers] Posted list ${headerId} again as list ${state.ids.header}.`);
  return state.ids;
}

// Who a list was checked by: whoever ran the command or pressed Update/Refresh.
function checkedByMember(interaction) {
  return { id: interaction.user.id, name: memberName(interaction) };
}

// A list reloaded after another feature's update all. `name` (for the export) says what triggered it;
// the header shows `label`.
function checkedByAutoRefresh(source) {
  return { id: null, name: `auto-refresh after ${source} updated WOM`, label: 'auto refreshed' };
}

// The list for these options as of now. `checkedBy` is { id, name } from checkedByMember or
// checkedByAutoRefresh. Throws if WOM fails.
async function loadView(client, { months, minXp, ignoredRoles }, checkedBy) {
  const groupId = Number(process.env.WOM_GROUP_ID);
  const now = Date.now();
  const startDate = new Date(addMonths(now, -months));

  // Never rejects; missing emojis fall back to rank names.
  const emojisLoad = loadRankEmojis(client);
  const result = await findStaleMembers(groupId, { months, startDate, endDate: new Date(now), minXp, ignoredRoles });
  console.log(
    `[StaleMembers] Of ${result.checked} member(s), ${result.inactiveCount} inactive for ${months} month(s), ` +
    `${result.closeCount} close, ${result.lowXpCount} active but under ${minXp} XP (${result.ignored} ignored by rank, ` +
    `${result.joinedRecently} joined too recently, ${result.untracked} with no WOM data).`
  );
  return {
    ...result,
    months,
    minXp,
    ignoredRoles,
    startMs: startDate.getTime(),
    now,
    checkedBy,
    emojis: await emojisLoad,
  };
}

// Reloads a list with the same options, keeping each list's page. After a restart the options come
// from the button.
async function updateList(button, state) {
  const query = state?.view ?? queryFromButtonId(button.customId);
  if (!query) {
    // Only if WOM's rank list changed (a package update) since the list was posted.
    console.log(`[StaleMembers] ${button.user.tag} tried to update list ${button.message.id}, but its options couldn't be read.`);
    await button.reply({
      content: "This list has expired and can't be reloaded. Run `/stalemembers` again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (state?.updating) {
    console.log(`[StaleMembers] ${button.user.tag} pressed Update on list ${button.message.id} while it was already updating.`);
    await button.reply({ content: 'This list is already being updated.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (state) state.updating = true;
  try {
    await button.deferUpdate();
    console.log(`[StaleMembers] ${button.user.tag} is updating list ${button.message.id} (${commandText(query)}).`);
    let view;
    try {
      view = await loadView(button.client, query, checkedByMember(button));
    } catch (err) {
      console.error(`[StaleMembers] Failed to update list ${button.message.id}:`, err);
      await reportError(button, 'Could not update the list', `Reloading the list from WOM failed: ${err.message}`);
      await button.followUp({ content: `Couldn't update the list from Wise Old Man: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    let ids;
    try {
      ids = await showReloaded(button.client, button.message.id, view);
    } catch (err) {
      console.error(`[StaleMembers] Failed to show the updated list ${button.message.id}:`, err);
      await reportError(button, 'Could not update the list', `Editing the list messages failed: ${err.message}`);
      await button.followUp({ content: 'Something went wrong updating the list. The admins have been notified.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (!ids) {
      console.log(`[StaleMembers] List ${button.message.id} was deleted or replaced while updating, dropping the update.`);
      await button.followUp({ content: 'This list was deleted or replaced by a newer one, so it wasn\'t updated.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    console.log(`[StaleMembers] Updated list ${ids.header}.`);
  } finally {
    if (state) state.updating = false;
  }
}

function listLink(guildId, messageId) {
  return `https://discord.com/channels/${guildId}/${ADMIN_LOG_CHANNEL_ID}/${messageId}`;
}

// DMs someone waiting on a refresh, or pings them in the admin log if their DMs are closed.
async function notifyWaiter(client, user, content) {
  try {
    await user.send(content);
    console.log(`[StaleMembers] DMed ${user.tag} that the refresh finished.`);
    return;
  } catch (err) {
    // 50007 Cannot send messages to this user: DMs from server members are turned off.
    console.warn(`[StaleMembers] Couldn't DM ${user.tag} (${err.message}), pinging them in the admin log instead.`);
  }
  try {
    const channel = await client.channels.fetch(ADMIN_LOG_CHANNEL_ID);
    await channel.send({ content: `${user} ${content}`, allowedMentions: { users: [user.id] } });
  } catch (err) {
    console.error(`[StaleMembers] Couldn't ping ${user.tag} about the refresh:`, err.message);
  }
}

// A posted list's options: from memory, or read off its header's Update button after a restart. Null
// if neither works.
async function listQuery(client, messageId) {
  const state = loadedLists.get(messageId);
  if (state) return state.view;
  try {
    const channel = await client.channels.fetch(ADMIN_LOG_CHANNEL_ID);
    return queryFromMessage(await channel.messages.fetch(messageId));
  } catch (err) {
    // 10008 Unknown Message: the list was deleted.
    if (err?.code !== 10008) console.warn(`[StaleMembers] Couldn't read list ${messageId}:`, err.message);
    return null;
  }
}

// Finishes a refresh: reloads the newest list and returns { dm, status } for everyone waiting (the
// DM, and a line for their private message). Null if there's no list.
async function finishRefresh(refresh) {
  const { client, button } = refresh;
  const targetId = savedList()?.header ?? refresh.messageId;
  if (!targetId) {
    console.log('[StaleMembers] Refresh finished, but there is no list to reload.');
    return null;
  }
  const query = await listQuery(client, targetId);
  if (!query) {
    return {
      dm: 'WOM has finished updating, but the stale members list is gone. Run `/stalemembers` again to see the new data.',
      status: '✅ WOM finished updating, but the list is gone. Run `/stalemembers` again to see the new data.',
    };
  }

  const checkedBy = refresh.requester ? checkedByMember(button) : checkedByAutoRefresh(refresh.source);
  let view;
  try {
    view = await loadView(client, query, checkedBy);
  } catch (err) {
    console.error(`[StaleMembers] Failed to reload list ${targetId} after a refresh:`, err);
    await notifyAdminLog(client, '⚠️ /stalemembers: Could not reload the list after a refresh', truncate(`Reloading the list from WOM failed: ${err.message}`, 4096));
    return {
      dm: `WOM has finished updating, but the stale members list couldn't be reloaded (${err.message}). ` +
        `Press 🔄 **Update** on it to try again: ${listLink(refresh.guildId, targetId)}`,
      status: "⚠️ WOM finished updating, but the list couldn't be reloaded. Press 🔄 **Update** to try again.",
    };
  }

  // Keeps each list's page as it is now, in case someone paged through it during the wait.
  const ids = await showReloaded(client, targetId, view);
  if (!ids) {
    console.log(`[StaleMembers] List ${targetId} was deleted during a refresh.`);
    return {
      dm: 'WOM has finished updating, but the stale members list was deleted. Run `/stalemembers` again to see the new data.',
      status: '✅ WOM finished updating, but the list was deleted. Run `/stalemembers` again to see the new data.',
    };
  }
  console.log(`[StaleMembers] Refreshed list ${ids.header} (${checkedBy.name}).`);
  return {
    dm: `The stale members list is updated with fresh WOM data: ${listLink(refresh.guildId, ids.header)}`,
    status: '✅ WOM finished updating and the list is updated.',
  };
}

// Refresh pressed during a refresh: says who or what started it and when it ends, and adds the
// presser to the DM list.
async function joinRefresh(button, refresh) {
  // An automatic refresh only has CLAN_ID; the button has the real server.
  refresh.guildId ??= button.guildId;
  const when = `at ${discordTimestamp(refresh.finishAt, 't')} (${discordTimestamp(refresh.finishAt, 'R')})`;
  if (refresh.waiting.has(button.user.id)) {
    console.log(`[StaleMembers] ${button.user.tag} pressed Refresh again while already waiting on the refresh.`);
    await button.reply({
      content: `You're already waiting on this refresh. It'll finish ${when}, and I'll DM you when it's done.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const by = refresh.requester ? `${refresh.requester}` : refresh.source.replace(/^./, c => c.toUpperCase());
  const intro = `🔃 ${by} already asked WOM to update everyone at ${discordTimestamp(refresh.startedAt, 't')}.`;
  // Private messages never ping; allowedMentions makes sure.
  await button.reply({
    content: `${intro} The list will refresh ${when}, and I'll DM you when it's done.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
  refresh.waiting.set(button.user.id, {
    user: button.user,
    // editReply changes their private reply. async so errors reject instead of throwing.
    editNotice: async status => button.editReply({ content: `${intro}\n${status}`, allowedMentions: { parse: [] } }),
  });
  console.log(`[StaleMembers] ${button.user.tag} joined the refresh started by ${refresh.requester?.tag ?? refresh.source}.`);
}

// Tells everyone waiting how the refresh went: a DM each, and their private message updated.
async function tellWaiters(refresh, { dm, status }) {
  for (const { user, editNotice } of refresh.waiting.values()) {
    if (dm) await notifyWaiter(refresh.client, user, dm);
    // Fails quietly if they dismissed the message.
    await editNotice(status).catch(err => console.warn(`[StaleMembers] Couldn't update ${user.tag}'s refresh message:`, err.message));
  }
}

// After REFRESH_WAIT_MS, reloads the list and tells everyone waiting. Lost on a restart.
function scheduleFinish(refresh) {
  setTimeout(async () => {
    const result = await finishRefresh(refresh).catch(err => {
      console.error('[StaleMembers] Refresh failed:', err);
      return {
        dm: 'Something went wrong reloading the stale members list after the refresh. Press 🔄 **Update** on it to try again.',
        status: '⚠️ Something went wrong reloading the list. Press 🔄 **Update** to try again.',
      };
    });
    if (activeRefresh === refresh) activeRefresh = null;
    // Replaces the countdown, which would otherwise read "5 minutes ago".
    if (result) await tellWaiters(refresh, { dm: result.dm, status: `${result.status} (${discordTimestamp(Date.now(), 't')})` });
  }, REFRESH_WAIT_MS);
}

// Runs WOM's update all, then reloads the list after REFRESH_WAIT_MS. One refresh at a time for the
// group: pressing Refresh on any list during one joins it. Everyone waiting is told privately, then
// DMed.
async function refreshList(button, state) {
  if (activeRefresh) return joinRefresh(button, activeRefresh);

  const messageId = button.message.id;
  const query = state?.view ?? queryFromMessage(button.message);
  if (!query) {
    // Only if WOM's rank list changed (a package update) since the list was posted.
    console.log(`[StaleMembers] ${button.user.tag} tried to refresh list ${button.message.id}, but its options couldn't be read.`);
    await button.reply({ content: "This list has expired and can't be refreshed. Run `/stalemembers` again.", flags: MessageFlags.Ephemeral });
    return;
  }

  // Set before asking WOM, so a press while WOM answers joins this refresh.
  const startedAt = Date.now();
  const refresh = {
    client: button.client,
    guildId: button.guildId,
    button,
    messageId,
    requester: button.user,
    source: null,
    startedAt,
    finishAt: startedAt + REFRESH_WAIT_MS,
    waiting: new Map(),
  };
  activeRefresh = refresh;
  // Ends the refresh early, telling whoever pressed it and anyone who joined meanwhile.
  const cancel = async (content) => {
    if (activeRefresh === refresh) activeRefresh = null;
    await button.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    await tellWaiters(refresh, { status: content });
  };

  try {
    // Acknowledges the press without changing the list; the notice below is a private follow-up.
    await button.deferUpdate();
    const groupId = Number(process.env.WOM_GROUP_ID);
    let count;
    try {
      console.log(`[StaleMembers] ${button.user.tag} asked WOM to update group ${groupId} (from list ${messageId}).`);
      const result = await withTimeout(
        updateAllGroupMembers(groupId, process.env.WOM_GROUP_VERIFICATION_CODE, OWN_UPDATE_SOURCE),
        'Asking WOM to update the group',
        REQUEST_TIMEOUT_MS
      );
      count = result?.count ?? 0;
    } catch (err) {
      // WOM also errors when no member is due an update.
      console.error('[StaleMembers] Update all failed:', err.message);
      await cancel(`Couldn't ask WOM to update the group: ${err.message}`);
      return;
    }
    if (count === 0) {
      console.log('[StaleMembers] Update all queued nobody, every member is up to date.');
      await cancel('WOM says every member is already up to date, so there is nothing to refresh. Press 🔄 **Update** to reload the list.');
      return;
    }
    console.log(`[StaleMembers] Update all queued ${plural(count, 'member')}, reloading the list in ${REFRESH_WAIT_MS / 60000} minutes.`);

    const asked = `🔃 Asked WOM to update ${plural(count, 'member')} at ${discordTimestamp(startedAt, 't')}.`;
    // The clock time is in the viewer's timezone, and the relative time counts down live in Discord.
    const notice = await button.followUp({
      content: `${asked} This takes about ${REFRESH_WAIT_MS / 60000} minutes: the list will update at ` +
        `${discordTimestamp(refresh.finishAt, 't')} (${discordTimestamp(refresh.finishAt, 'R')}), and I'll DM you when it's ready.`,
      flags: MessageFlags.Ephemeral,
    });
    refresh.waiting.set(button.user.id, {
      user: button.user,
      // async so errors reject instead of throwing.
      editNotice: async status => button.webhook.editMessage(notice, { content: `${asked}\n${status}` }),
    });
  } catch (err) {
    // A Discord call failed while starting: end the refresh so the next press starts a new one.
    console.error('[StaleMembers] Refresh failed to start:', err);
    await cancel(`Something went wrong starting the refresh (${err.message}). Press 🔃 **Refresh WOM** to try again.`);
    return;
  }

  scheduleFinish(refresh);
}

// Another feature ran update all: reloads the newest list once WOM has caught up, so one update all
// serves both. Skipped during a refresh, which picks up the same data.
function autoRefresh(client, { groupId, count, source }) {
  if (source === OWN_UPDATE_SOURCE || count === 0 || groupId !== Number(process.env.WOM_GROUP_ID)) return;
  if (activeRefresh) {
    console.log(`[StaleMembers] ${source} ran update all during a refresh, which will pick up the new data.`);
    return;
  }
  if (!savedList()) {
    console.log(`[StaleMembers] ${source} ran update all, but there is no list to refresh.`);
    return;
  }
  const startedAt = Date.now();
  activeRefresh = {
    client,
    guildId: process.env.CLAN_ID || null,
    button: null,
    messageId: null,
    requester: null,
    source,
    startedAt,
    finishAt: startedAt + REFRESH_WAIT_MS,
    waiting: new Map(),
  };
  console.log(`[StaleMembers] ${source} ran update all (${plural(count, 'member')} queued), refreshing the list in ${REFRESH_WAIT_MS / 60000} minutes.`);
  scheduleFinish(activeRefresh);
}

// Loads the list and posts it in the admin log, with the header as the interaction's reply when
// `asReply` (the command run there). Then replaces the previous list. Returns the list's message IDs,
// or null after passing the error to `onError`.
async function postList(interaction, query, { asReply, onError }) {
  let view;
  try {
    view = await loadView(interaction.client, query, checkedByMember(interaction));
  } catch (err) {
    console.error(`[StaleMembers] Failed to load WOM group ${process.env.WOM_GROUP_ID}:`, err);
    await reportError(interaction, 'Could not load the group', `Loading WOM group ${process.env.WOM_GROUP_ID} failed: ${err.message}`);
    await onError(`Couldn't load the group from Wise Old Man: ${err.message}`);
    return null;
  }

  // Kept until the bot restarts, so the buttons keep working with no time limit.
  const state = { view, pages: clampPages(view) };
  try {
    state.ids = await sendList(interaction.client, state, asReply ? content => interaction.editReply(content) : null);
    rememberList(state);
    console.log(`[StaleMembers] Posted list ${state.ids.header} in the admin log for ${interaction.user.tag}.`);
  } catch (err) {
    console.error('[StaleMembers] Failed to send the list:', err);
    await reportError(interaction, 'Could not send the list', `Sending the stale member list failed: ${err.message}`);
    await onError('Something went wrong showing the list. The admins have been notified.');
    return null;
  }
  // Only once the new list is up, so a failed run leaves the old one in place.
  await replaceOldLists(interaction.client, state.ids);
  return state.ids;
}

// The private rank picker: a tick box of the group's ranks and a Run button, with the matching
// command to copy. Both components carry the options, including what's ticked.
function pickerMessage(query, ranks, emojis) {
  // Discord allows 25 options per menu.
  const shown = ranks.slice(0, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId(queryCustomId('pick', query))
    .setPlaceholder('Ranks to ignore (none ticked checks every rank)')
    .setMinValues(0)
    .setMaxValues(shown.length)
    .addOptions(shown.map(role => ({
      label: rankName(role),
      value: role,
      default: query.ignoredRoles.has(role),
      ...(emojis.has(role) ? { emoji: parseEmoji(emojis.get(role)) } : {}),
    })));
  const run = new ButtonBuilder().setCustomId(queryCustomId('run', query)).setLabel('▶ Run').setStyle(ButtonStyle.Primary);
  // The closed tick box only shows emojis, so the ticked ranks are named here too.
  const ticked = inRankOrder(query.ignoredRoles).map(role => (emojis.has(role) ? `${emojis.get(role)} ${rankName(role)}` : rankName(role)));
  return {
    content: `**Ignoring:** ${ticked.length ? ticked.join(', ') : 'none'}\n` +
      'Tick the ranks to ignore, then press **▶ Run**. To skip this next time, copy the command:\n' +
      `\`${commandText(query)}\``,
    components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(run)],
  };
}

// The command run without `ignore`: shows the rank picker privately.
async function showRankPicker(interaction, query) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const ranks = await loadGroupRanks(Number(process.env.WOM_GROUP_ID), REQUEST_TIMEOUT_MS);
  if (!ranks?.length) {
    console.log(`[StaleMembers] Couldn't show ${interaction.user.tag} the rank picker: the group's ranks didn't load.`);
    await interaction.editReply("Couldn't load the clan's ranks from Wise Old Man. Type them in `ignore` instead, e.g. `Owner, Templar`, or `None`.");
    return;
  }
  const emojis = await loadRankEmojis(interaction.client);
  console.log(`[StaleMembers] Showed ${interaction.user.tag} the rank picker.`);
  await interaction.editReply(pickerMessage(query, ranks, emojis));
}

// Ticking ranks in the picker: updates the ticks, the Run button and the command to copy.
async function handleStaleMembersSelect(select) {
  if (!select.member?.roles.cache.has(TEMPLAR_ROLE_ID)) {
    console.log(`[StaleMembers] ${select.user.tag} used the rank picker (missing Templar role).`);
    await select.reply({ content: 'You need the Templar role to use this.', flags: MessageFlags.Ephemeral });
    return;
  }
  const query = queryFromButtonId(select.customId);
  if (!query) {
    console.log(`[StaleMembers] ${select.user.tag} used a rank picker whose options couldn't be read.`);
    await select.reply({ content: 'This picker has expired. Run `/stalemembers` again.', flags: MessageFlags.Ephemeral });
    return;
  }
  query.ignoredRoles = new Set(select.values.filter(role => GROUP_ROLES.includes(role)));
  // The picker's own options, so updating it never waits on WOM.
  const ranks = select.component.options.map(option => option.value);
  const emojis = await loadRankEmojis(select.client);
  console.log(`[StaleMembers] ${select.user.tag} ticked ${query.ignoredRoles.size} rank(s) to ignore.`);
  await select.update(pickerMessage(query, ranks, emojis));
}

// Run in the picker: posts the list, then turns the picker into a link to it plus the command.
async function runFromPicker(button) {
  const query = queryFromButtonId(button.customId);
  if (!query) {
    console.log(`[StaleMembers] ${button.user.tag} pressed Run on a picker whose options couldn't be read.`);
    await button.reply({ content: 'This picker has expired. Run `/stalemembers` again.', flags: MessageFlags.Ephemeral });
    return;
  }
  await button.deferUpdate();
  console.log(`[StaleMembers] ${button.user.tag} ran the list from the rank picker (${commandText(query)}).`);
  const ids = await postList(button, query, {
    asReply: false,
    onError: content => button.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {}),
  });
  if (!ids) return;
  await button.editReply({
    content: `📋 The stale members list was posted in <#${ADMIN_LOG_CHANNEL_ID}>: ${listLink(button.guildId, ids.header)}\n` +
      `To run it again, copy the command:\n\`${commandText(query)}\``,
    components: [],
  }).catch(err => console.warn(`[StaleMembers] Couldn't update ${button.user.tag}'s rank picker:`, err.message));
}

// Every click on a list's or the picker's buttons. Only Templars can use them, though the list is
// public.
async function handleStaleMembersButton(button) {
  if (!button.member?.roles.cache.has(TEMPLAR_ROLE_ID)) {
    console.log(`[StaleMembers] ${button.user.tag} pressed a list button (missing Templar role).`);
    await button.reply({ content: 'You need the Templar role to use these buttons.', flags: MessageFlags.Ephemeral });
    return;
  }

  // A list's own buttons name it: "next:inactive". Export all has none.
  const [action, part] = button.customId.slice(BUTTON_PREFIX.length).split(':');
  const section = SECTIONS.includes(part) ? part : null;
  const state = findList(button.message.id);
  if (action === 'run') return runFromPicker(button);
  if (action === 'update') return updateList(button, state);
  if (action === 'refresh') return refreshList(button, state);

  // Prev, Next and Export need the list in memory, which Update reloads.
  if (!state) {
    console.log(`[StaleMembers] ${button.user.tag} pressed ${button.customId} on message ${button.message.id}, whose list isn't loaded.`);
    // Only the header's Update button carries the options.
    const query = queryFromMessage(button.message);
    await button.reply({
      content: 'This list has expired (the bot has restarted since it was posted). Press 🔄 **Update** on the list to reload it' +
        (query ? `, or run it again:\n\`${commandText(query)}\`` : '.'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'export') return exportList(button, state, section);
  if (!section) return;

  const totalPages = pageCount(state.view, section);
  const page = state.pages[section];
  state.pages[section] = action === 'prev' ? Math.max(0, page - 1) : Math.min(totalPages - 1, page + 1);
  console.log(`[StaleMembers] ${button.user.tag} moved the ${section} list of ${state.ids.header} to page ${state.pages[section] + 1}/${totalPages}.`);
  await button.update(renderSection(state, section));
}

module.exports = {
  // Fails closed: not loaded without the Templar role or the admin log channel.
  requiredEnv: ['WOM_GROUP_ID', 'TEMPLAR_ROLE_ID', 'ADMIN_LOG_CHANNEL_ID'],

  handleStaleMembersButton,
  handleStaleMembersSelect,

  data: new SlashCommandBuilder()
    .setName('stalemembers')
    .setDescription('List WOM group members who gained too little XP over a number of months')
    .addIntegerOption(o =>
      o.setName('time')
        .setDescription('How many months back to check')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(MAX_MONTHS)
    )
    .addStringOption(o =>
      o.setName('minxp')
        .setDescription('Minimum XP they must have gained, e.g. 250k or 1.5m')
        .setRequired(true)
        .setMaxLength(20)
    )
    .addStringOption(o =>
      o.setName('ignore')
        .setDescription('Ranks to leave out, comma separated, or "None". Leave empty to tick them from a list')
        .setMaxLength(1000)
        .setAutocomplete(true)
    ),

  // Called once on startup: preloads the group's ranks for autocomplete, and reloads the list after
  // other features' update all. Never throws.
  start(client) {
    // Runs inside the caller's update all, so errors mustn't reach it.
    womEvents.on('updateAll', event => {
      try {
        autoRefresh(client, event);
      } catch (err) {
        console.error('[StaleMembers] Failed to schedule an automatic refresh:', err);
      }
    });
    console.log(`[StaleMembers] Started: lists post in the admin log, and reload after any other feature's update all.`);
    loadGroupRanks(Number(process.env.WOM_GROUP_ID), REQUEST_TIMEOUT_MS);
  },

  // Completes the rank after the last comma from the group's ranks, keeping those before it. Offers
  // only "None" if the ranks can't load in time.
  async autocomplete(interaction) {
    const typed = interaction.options.getFocused();
    const parts = typed.split(',');
    const current = normalizeRank(parts.pop());
    const done = parts.map(s => s.trim()).filter(Boolean);
    const chosen = new Set(done.map(s => RANKS_BY_NAME.get(normalizeRank(s))));
    const prefix = done.length ? `${done.join(', ')}, ` : '';

    const ranks = await loadGroupRanks(Number(process.env.WOM_GROUP_ID), AUTOCOMPLETE_WAIT_MS) ?? [];
    const choices = ranks
      .filter(role => !chosen.has(role))
      .map(role => ({ role, key: normalizeRank(rankName(role)) }))
      .filter(({ key }) => key.includes(current))
      // Ranks that start with the typed text come first, otherwise in the group's rank order.
      .sort((a, b) => Number(!a.key.startsWith(current)) - Number(!b.key.startsWith(current)))
      .map(({ role }) => `${prefix}${rankName(role)}`);
    // "None" is only offered before any rank has been picked.
    if (done.length === 0 && 'none'.startsWith(current)) choices.unshift(IGNORE_NONE);
    const fitting = choices.filter(value => value.length <= 100).slice(0, 25);
    await interaction.respond(fitting.map(value => ({ name: value, value })));
  },

  async execute(interaction) {
    const months = interaction.options.getInteger('time', true);
    const minXpInput = interaction.options.getString('minxp', true).trim();
    const ignoreInput = interaction.options.getString('ignore')?.trim() ?? '';
    console.log(`[StaleMembers] ${interaction.user.tag} ran /stalemembers time:${months} minxp:${minXpInput} ignore:${ignoreInput || '(picker)'}`);
    // Logs why the command was turned down, then tells the user privately.
    const reject = (content) => {
      console.log(`[StaleMembers] Rejected /stalemembers from ${interaction.user.tag}: ${content}`);
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    };

    if (!interaction.member?.roles.cache.has(TEMPLAR_ROLE_ID)) {
      return reject('You need the Templar role to use this command.');
    }

    // At least 1: with 0 nobody could gain less, so the list would always be empty.
    const minXp = parseXp(minXpInput);
    if (minXp === null || minXp < 1) {
      return reject(`\`${minXpInput}\` isn't a valid XP amount. Use a number of at least 1, like \`250000\`, \`250k\` or \`1.5m\`.`);
    }

    if (!ignoreInput) return showRankPicker(interaction, { months, minXp, ignoredRoles: new Set() });

    const ignoreNone = normalizeRank(ignoreInput) === normalizeRank(IGNORE_NONE);
    const { roles: ignoredRoles, unknown } = ignoreNone ? { roles: new Set(), unknown: [] } : parseRanks(ignoreInput);
    if (!ignoreNone && ignoredRoles.size === 0 && unknown.length === 0) {
      return reject(`List the ranks to ignore, comma separated, type \`${IGNORE_NONE}\` to check every rank, or leave it empty to pick them.`);
    }
    if (unknown.length > 0) {
      return reject(
        `Unknown rank${unknown.length === 1 ? '' : 's'}: ${unknown.map(r => `\`${r}\``).join(', ')}. ` +
        'Separate ranks with commas and use their Wise Old Man names, e.g. `Owner, Deputy Owner, Templar`, ' +
        `or type \`${IGNORE_NONE}\` to check every rank.`
      );
    }

    // The list names inactive members, so it's always posted in the staff-only admin log. Run there,
    // it's the reply; anywhere else, the reply is private and links to it.
    const inAdminLog = interaction.channelId === ADMIN_LOG_CHANNEL_ID;
    await interaction.deferReply(inAdminLog ? {} : { flags: MessageFlags.Ephemeral });
    // Errors from here on are private. In the admin log, that means swapping the public "thinking"
    // message for a private one.
    const failPrivately = async (content) => {
      if (!inAdminLog) {
        await interaction.editReply(content).catch(() => {});
        return;
      }
      await interaction.deleteReply().catch(() => {});
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    };

    const ids = await postList(interaction, { months, minXp, ignoredRoles }, { asReply: inAdminLog, onError: failPrivately });
    if (ids && !inAdminLog) {
      await interaction.editReply(`📋 The stale members list was posted in <#${ADMIN_LOG_CHANNEL_ID}>: ${listLink(interaction.guildId, ids.header)}`)
        .catch(err => console.warn(`[StaleMembers] Couldn't send ${interaction.user.tag} the link to the list:`, err.message));
    }
  },
};
