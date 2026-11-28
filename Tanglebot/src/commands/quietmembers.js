const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
  escapeMarkdown,
} = require('discord.js');
const { DEFAULT_EMBED_COLOR } = require('../utils/embedColor');
const { DATA_DIR, truncate, withFileLock, discordTimestamp, hasAnyRole } = require('../utils/common');
const { readState, writeState } = require('../utils/state');
const { notifyAdminLog } = require('../utils/adminLog');
const { refuseWithoutRole } = require('../utils/roleCheck');
const { buildXlsx } = require('../utils/xlsx');
const activity = require('../utils/memberActivity');
const backfill = require('../utils/activityBackfill');
const adminPost = require('../utils/adminPost');

const BUTTON_PREFIX = 'quietmembers:';
const LOG_PREFIX = '[QuietMembers]';
const TITLE = '🤫 Quiet Members';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 3650;
// { list: { header, noActivity, beforeTracking } }, the newest report's message IDs.
const DATA_FILE = 'quietmembers.json';
// Every export is also saved here; only the newest few are kept.
const EXPORT_DIR = path.join(DATA_DIR, 'quietmembers-exports');
const EXPORT_PREFIX = 'quiet-members-export-';
const MAX_SAVED_EXPORTS = 5;
// Reports kept in memory for the buttons; past this the oldest is dropped, as on a restart.
const MAX_LOADED_LISTS = 20;

const SECTIONS = ['noActivity', 'beforeTracking'];
const SECTION_NAMES = { noActivity: 'No activity recorded', beforeTracking: 'Joined before tracking' };
const SECTION_FILES = { noActivity: 'no-activity', beforeTracking: 'before-tracking' };
const LABELS = {
  noActivity: 'No activity recorded',
  noMessages: 'No messages or commands found',
  unknown: 'Unknown',
};

// Header message ID -> { view, ids, pages, updating } for each posted report. Lost on restart.
const loadedLists = new Map();

// "Nickname (username)", readable outside Discord. No "@", which spreadsheets read as a formula.
function personName(interaction) {
  const nickname = interaction.member?.displayName;
  const { username } = interaction.user;
  return nickname && nickname !== username ? `${nickname} (${username})` : username;
}

// Whether a backfill has finished, what the current one is doing, and how many channels and threads
// it couldn't read: from the last finished pass, or else the current run's skipped and failed ones
// (partial, since it may not have reached others). unreachable is null before any run.
function backfillSummary() {
  const { backfill: data, lastFinished, status } = backfill.getStatus();
  return {
    finishedAt: lastFinished?.finishedAt ?? null,
    status,
    unreachable: lastFinished?.unreachableCount ?? (data ? backfill.countAffected([...data.unreachable, ...data.failed]) : null),
    partial: !lastFinished && Boolean(data),
  };
}

// `time` formats a timestamp, for Discord or a spreadsheet.
function backfillText({ finishedAt, status }, time) {
  const current = { running: 'running', stopped: 'stopped', incomplete: 'incomplete' }[status];
  if (finishedAt) return `finished ${time(finishedAt)}${current ? ` (a later run is ${current})` : ''}`;
  return current ? `not finished (a run is ${current})` : 'not run';
}

// The members to list: in the server, not bots, whose latest join is more than `days` ago, with no
// activity since it. Oldest join first, in two lists by whether tracking saw them join.
async function loadView(client, days, checkedBy) {
  const guild = await client.guilds.fetch(process.env.CLAN_ID);
  const members = await activity.fetchAllMembers(guild);
  const now = Date.now();
  const checked = members.filter(m => !m.user.bot && m.joinedTimestamp && m.joinedTimestamp < now - days * DAY_MS);
  const ids = checked.map(m => m.id);
  const [lastActive, joins] = await Promise.all([activity.latestActivity(ids), activity.joinCounts(ids)]);

  const startedAt = activity.readActivityState().trackingStartedAt;
  const trackingStartedAt = startedAt ? Date.parse(startedAt) : null;
  const summary = backfillSummary();
  const beforeLabel = summary.finishedAt ? LABELS.noMessages : LABELS.unknown;

  const rows = checked
    .filter(m => !(lastActive.get(m.id)?.getTime() >= m.joinedTimestamp))
    .map(m => {
      const seenJoining = trackingStartedAt !== null && m.joinedTimestamp >= trackingStartedAt;
      return {
        id: m.id,
        name: m.displayName,
        username: m.user.username,
        joinedAt: m.joinedTimestamp,
        days: Math.floor((now - m.joinedTimestamp) / DAY_MS),
        rejoined: (joins.get(m.id) ?? 0) > 1,
        pending: Boolean(m.pending),
        section: seenJoining ? 'noActivity' : 'beforeTracking',
        label: seenJoining ? LABELS.noActivity : beforeLabel,
      };
    })
    .sort((a, b) => a.joinedAt - b.joinedAt || a.name.localeCompare(b.name));
  console.log(`${LOG_PREFIX} ${rows.length} of ${checked.length} member(s) past ${days} day(s) are quiet.`);

  return {
    days,
    now,
    checkedBy,
    checked: checked.length,
    sections: Object.fromEntries(SECTIONS.map(s => [s, rows.filter(r => r.section === s)])),
    beforeLabel,
    trackingStartedAt,
    backfill: summary,
  };
}

// The lists with anyone in them, in posting order. Only these get a message.
function shownSections(view) {
  return SECTIONS.filter(section => view.sections[section].length > 0);
}

function sectionTitle(view, section) {
  return section === 'noActivity' ? `🔇 ${SECTION_NAMES.noActivity}` : `❔ ${SECTION_NAMES.beforeTracking}: ${view.beforeLabel}`;
}

function buildHeaderEmbed(view) {
  const count = section => view.sections[section].length;
  const labelled = label => SECTIONS.reduce((n, s) => n + view.sections[s].filter(r => r.label === label).length, 0);
  const total = count('noActivity') + count('beforeTracking');
  const time = at => discordTimestamp(at, 'f');
  const { unreachable, partial } = view.backfill;

  const lines = [
    `**Checked:** ${time(view.now)} (${discordTimestamp(view.now, 'R')}) by <@${view.checkedBy.id}>`,
    `**Joined more than:** ${view.days} day${view.days === 1 ? '' : 's'} ago, with nothing since`,
    '',
    `**Members checked:** ${view.checked}`,
    ...Object.values(LABELS).map(label => `• ${label}: **${labelled(label)}**`),
    ...(total === 0 ? ['Nobody is quiet, so there are no lists.'] : SECTIONS.filter(s => count(s) === 0)
      .map(s => `The **${SECTION_NAMES[s]}** list is empty.`)),
    '',
    `**Tracking since:** ${view.trackingStartedAt ? time(view.trackingStartedAt) : 'not started'}`,
    `**Backfill:** ${backfillText(view.backfill, time)}`,
    `**Channels and threads it couldn't (fully) read:** ${unreachable ?? 'no backfill run yet'}` +
      (partial ? ' so far (the run isn’t finished, so others may be unread)' : ''),
    '',
    'Activity is a message, a voice join or a slash command. Reactions and buttons don’t count.',
    `${LABELS.noMessages}: voice before tracking is unknown. ${LABELS.unknown}: they joined before tracking and no backfill has finished.`,
    '',
    '🔄 **Update** checks again. 📄 **Export all** sends you the lists as a spreadsheet.' +
      (total > 0 ? ' Each list has its own ◀ ▶ pages and 📄 **Export**.' : ''),
  ];
  return new EmbedBuilder()
    .setColor(DEFAULT_EMBED_COLOR)
    .setTitle(TITLE)
    .setDescription(truncate(lines.join('\n'), 4096))
    .setTimestamp(view.now);
}

function formatRow(row, index) {
  const flags = [
    ...(row.rejoined ? ['🔁 rejoined'] : []),
    ...(row.pending ? ['📜 rules not accepted'] : []),
  ];
  return [
    `**${index + 1}.** **${escapeMarkdown(row.name)}** — joined ${discordTimestamp(row.joinedAt, 'd')}`,
    `${row.days} day${row.days === 1 ? '' : 's'}`,
    ...flags,
  ].join(' · ');
}

// The Update button carries `days`, so it works after a restart.
function renderHeader(state) {
  const total = shownSections(state.view).length;
  return {
    embeds: [buildHeaderEmbed(state.view)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}update:${state.view.days}`).setLabel('🔄 Update').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}export`).setLabel('📄 Export all').setStyle(ButtonStyle.Success).setDisabled(total === 0)
    )],
  };
}

function renderSection(state, section) {
  const rows = state.view.sections[section];
  const page = state.pages[section];
  return {
    embeds: [adminPost.pageEmbed({ title: sectionTitle(state.view, section), rows, page, format: formatRow, noun: 'member', at: state.view.now })],
    components: [adminPost.pageButtons(BUTTON_PREFIX, { key: section, page, count: rows.length })],
  };
}

// Each list's page, kept in range after a reload changed its length.
function clampPages(view, pages) {
  return Object.fromEntries(SECTIONS.map(s => [s, Math.min(pages?.[s] ?? 0, adminPost.pageCount(view.sections[s].length) - 1)]));
}

// The newest report's message IDs from the data file, or null.
function savedList() {
  const { list } = readState(DATA_FILE);
  return list?.header ? list : null;
}

function rememberList(state) {
  loadedLists.delete(state.ids.header);
  loadedLists.set(state.ids.header, state);
  if (loadedLists.size > MAX_LOADED_LISTS) loadedLists.delete(loadedLists.keys().next().value);
}

// A loaded report, by any of its message IDs.
function findList(messageId) {
  return [...loadedLists.values()].find(state => Object.values(state.ids).includes(messageId)) ?? null;
}

async function sendReport(client, state, postHeader) {
  const parts = shownSections(state.view).map(section => [section, renderSection(state, section)]);
  return adminPost.sendGroup(client, renderHeader(state), parts, postHeader);
}

// Deletes every report but the newest, and saves the newest's message IDs.
function replaceOldReports(client, newIds, others = []) {
  return withFileLock(DATA_FILE, async () => {
    const kept = await adminPost.keepNewest(
      client, [newIds, ...[...loadedLists.values()].map(s => s.ids), savedList(), ...others], LOG_PREFIX
    );
    for (const header of [...loadedLists.keys()]) {
      if (adminPost.isOlder(header, kept.header)) loadedLists.delete(header);
    }
    try {
      writeState(DATA_FILE, { list: kept });
    } catch (err) {
      console.error(`${LOG_PREFIX} Couldn't save report ${kept.header} to ${DATA_FILE}:`, err.message);
    }
  });
}

// Loads and posts a new report, then removes the previous one. Returns the header message ID.
async function postReport(interaction, days, postHeader) {
  const view = await loadView(interaction.client, days, { id: interaction.user.id, name: personName(interaction) });
  const state = { view, pages: clampPages(view) };
  state.ids = await sendReport(interaction.client, state, postHeader);
  rememberList(state);
  console.log(`${LOG_PREFIX} Posted report ${state.ids.header} for ${interaction.user.tag}.`);
  // Only once the new report is up, so a failed run leaves the old one in place.
  await replaceOldReports(interaction.client, state.ids);
  return state.ids.header;
}

// Edits a posted report in place: 'edited', 'headerGone' or 'listGone' (a list message was deleted).
async function editReport(client, state) {
  const channel = await adminPost.adminChannel(client);
  // 10008 Unknown Message: it was deleted.
  const unlessDeleted = (edit, gone) => edit.then(() => 'edited', err => {
    if (err?.code !== 10008) throw err;
    return gone;
  });
  // The header first, so a deleted report is left alone.
  const header = await unlessDeleted(
    channel.messages.edit(state.ids.header, { ...renderHeader(state), allowedMentions: adminPost.NO_PINGS }), 'headerGone'
  );
  if (header !== 'edited') return header;
  const lists = await Promise.all(shownSections(state.view)
    .map(s => unlessDeleted(channel.messages.edit(state.ids[s], renderSection(state, s)), 'listGone')));
  return lists.includes('listGone') ? 'listGone' : 'edited';
}

// Shows reloaded data on a posted report, keeping each list's page. When a list emptied or gained its
// first member, or a list message is unknown or deleted, the report is posted again so the order holds.
// Returns false if it was deleted or a newer report replaced it.
async function showReloaded(client, headerId, view) {
  const old = loadedLists.get(headerId);
  const saved = savedList();
  if (!old && saved && adminPost.isOlder(headerId, saved.header)) return false;
  const ids = old?.ids ?? (saved?.header === headerId ? saved : { header: headerId });
  const state = { view, ids, pages: clampPages(view, old?.pages) };

  if (SECTIONS.every(s => Boolean(ids[s]) === view.sections[s].length > 0)) {
    const result = await editReport(client, state);
    if (result === 'headerGone') return false;
    if (result === 'edited') {
      rememberList(state);
      return true;
    }
    // A newer report may be deleting this one right now: wait for it, then leave this one alone.
    await withFileLock(DATA_FILE, () => {});
    const newest = savedList();
    if (newest && adminPost.isOlder(headerId, newest.header)) return false;
  }
  state.ids = await sendReport(client, state);
  rememberList(state);
  await replaceOldReports(client, state.ids, [ids]);
  return true;
}

async function updateReport(button, state, days) {
  const tell = content => button.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  if (state?.updating) {
    await button.reply({ content: 'This list is already being updated.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (state) state.updating = true;
  try {
    await button.deferUpdate();
    console.log(`${LOG_PREFIX} ${button.user.tag} is updating report ${button.message.id}.`);
    const view = await loadView(button.client, days, { id: button.user.id, name: personName(button) });
    if (!await showReloaded(button.client, button.message.id, view)) {
      await tell("This list was deleted or replaced by a newer one, so it wasn't updated.");
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to update report ${button.message.id}:`, err);
    await notifyAdminLog(button.client, '⚠️ /quietmembers: Could not update the list', truncate(`${button.user} pressed Update.\n\n${err.message}`, 4096));
    await tell(`Couldn't update the list: ${truncate(err.message, 500)}`);
  } finally {
    if (state) state.updating = false;
  }
}

function exportTime(time) {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// Each column's title and width in characters.
const EXPORT_COLUMNS = [
  ['#', 5], ['Display name', 24], ['Username', 20], ['Discord ID', 21], ['Joined', 12],
  ['Days in server', 15], ['Rejoined', 10], ['Rules accepted', 15], ['Status', 32],
];

// One list as a spreadsheet tab, after rows saying which list it is and when it was checked.
function exportSheet(view, section, { exportedBy, exportedAt }) {
  const info = [
    ['Quiet Members export'],
    ['List', SECTION_NAMES[section]],
    ['Data checked', exportTime(view.now), 'by', view.checkedBy.name],
    ['Exported', exportTime(exportedAt), 'by', exportedBy],
    ['Days', view.days],
    ['Backfill', backfillText(view.backfill, exportTime)],
    [],
  ];
  const rows = view.sections[section].map((row, i) => [
    i + 1, row.name, row.username, row.id, new Date(row.joinedAt).toISOString().slice(0, 10),
    row.days, row.rejoined ? 'Yes' : 'No', row.pending ? 'No' : 'Yes', row.label,
  ]);
  return {
    name: SECTION_NAMES[section],
    rows: [...info, EXPORT_COLUMNS.map(([title]) => title), ...rows],
    widths: EXPORT_COLUMNS.map(([, width]) => width),
    boldRows: [0, info.length],
  };
}

// "quiet-members-export-2026-09-27_14-30-05.xlsx" (UTC), so exports sort oldest to newest.
function exportFileName(time, section) {
  const suffix = section ? `-${SECTION_FILES[section]}` : '';
  return `${EXPORT_PREFIX}${new Date(time).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}${suffix}.xlsx`;
}

// Saves a copy in EXPORT_DIR, keeping the newest MAX_SAVED_EXPORTS. Returns the name used.
function saveExport(name, file, dir = EXPORT_DIR) {
  return withFileLock(dir, async () => {
    fs.mkdirSync(dir, { recursive: true });
    let saveAs = name;
    for (let n = 2; fs.existsSync(path.join(dir, saveAs)); n++) saveAs = name.replace(/\.xlsx$/, `_${n}.xlsx`);
    fs.writeFileSync(path.join(dir, saveAs), file);
    const old = fs.readdirSync(dir)
      .filter(entry => entry.startsWith(EXPORT_PREFIX) && entry.endsWith('.xlsx'))
      .sort()
      .slice(0, -MAX_SAVED_EXPORTS);
    for (const entry of old) fs.rmSync(path.join(dir, entry), { force: true });
    return saveAs;
  });
}

// Sends one list, or with no `section` every list with members as a tab each, privately to whoever
// pressed Export, and keeps a copy on the bot.
async function exportList(button, state, section) {
  const { view } = state;
  const sections = section ? [section] : shownSections(view);
  const exportedAt = Date.now();
  const file = buildXlsx(sections.map(s => exportSheet(view, s, { exportedBy: personName(button), exportedAt })));
  let name = exportFileName(exportedAt, section);
  let saved = true;
  try {
    name = await module.exports.saveExport(name, file);
  } catch (err) {
    saved = false;
    console.error(`${LOG_PREFIX} Couldn't save export ${name}:`, err.message);
  }
  const count = sections.reduce((sum, s) => sum + view.sections[s].length, 0);
  console.log(`${LOG_PREFIX} ${button.user.tag} exported ${count} member(s) as ${name}.`);
  await button.reply({
    content: `${count} member(s), checked ${discordTimestamp(view.now, 'f')}. Opens in Excel or Google Sheets. ` +
      (saved ? `A copy is saved on the bot (the last ${MAX_SAVED_EXPORTS} are kept).` : "Couldn't save a copy on the bot."),
    files: [new AttachmentBuilder(file, { name })],
    flags: MessageFlags.Ephemeral,
  });
}

// Every click on a report's buttons. Only Templars can use them, though others may see the report.
async function handleQuietMembersButton(button) {
  if (!hasAnyRole(button.member, [process.env.TEMPLAR_ROLE_ID])) {
    console.log(`${LOG_PREFIX} ${button.user.tag} pressed a list button (missing Templar role).`);
    await button.reply({ content: 'You need the Templar role to use these buttons.', flags: MessageFlags.Ephemeral });
    return;
  }
  const [action, part] = button.customId.slice(BUTTON_PREFIX.length).split(':');
  const state = findList(button.message.id);
  if (action === 'update') {
    await updateReport(button, state, Number(part) || DEFAULT_DAYS);
    return;
  }
  // Prev, Next and Export need the report in memory, which Update reloads.
  if (!state) {
    await button.reply({
      content: 'This list has expired (the bot has restarted since it was posted). Press 🔄 **Update** on the list to reload it.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const section = SECTIONS.includes(part) ? part : null;
  if (action === 'export') {
    await exportList(button, state, section);
    return;
  }
  if (!section) return;
  state.pages[section] = adminPost.turnPage(state.pages[section], action, state.view.sections[section].length);
  await button.update(renderSection(state, section));
}

module.exports = {
  // Shown in the admin commands post.
  help: {
    category: 'Members',
    access: 'Templar',
    examples: { '': '/quietmembers days:7' },
    options: { days: 'joined more than this many days ago (default 7)' },
  },
  requiredEnv: ['DATABASE_URL', 'CLAN_ID', 'TEMPLAR_ROLE_ID', 'ADMIN_LOG_CHANNEL_ID'],

  handleQuietMembersButton,
  saveExport,

  data: new SlashCommandBuilder()
    .setName('quietmembers')
    .setDefaultMemberPermissions(0)
    .setDescription('List members who joined but have not sent a message, joined voice or run a command')
    .addIntegerOption(o =>
      o.setName('days')
        .setDescription('Only members who joined more than this many days ago (default 7)')
        .setMinValue(1)
        .setMaxValue(MAX_DAYS)
    ),

  async execute(interaction) {
    const refused = await refuseWithoutRole(interaction, [process.env.TEMPLAR_ROLE_ID], {
      logPrefix: LOG_PREFIX, command: '/quietmembers', missing: 'missing Templar role', message: 'You need the Templar role to use this command.',
    });
    if (refused) return;
    const days = interaction.options.getInteger('days') ?? DEFAULT_DAYS;
    console.log(`${LOG_PREFIX} ${interaction.user.tag} ran /quietmembers days:${days}`);
    await adminPost.runAdminCommand(interaction, {
      command: '/quietmembers',
      logPrefix: LOG_PREFIX,
      post: postHeader => postReport(interaction, days, postHeader),
    });
  },
};
