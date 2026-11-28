const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags, escapeMarkdown } = require('discord.js');
const { DEFAULT_EMBED_COLOR } = require('../utils/embedColor');
const { truncate, withFileLock, discordTimestamp, formatNumber, hasAnyRole } = require('../utils/common');
const { refuseWithoutRole } = require('../utils/roleCheck');
const { buildXlsx } = require('../utils/xlsx');
const activity = require('../utils/memberActivity');
const backfill = require('../utils/activityBackfill');
const adminPost = require('../utils/adminPost');

const BUTTON_PREFIX = 'activitybackfill:';
const LOG_PREFIX = '[Backfill]';
const TITLE = '🗄️ Activity backfill';
// The progress message is edited at most this often.
const PROGRESS_EVERY_MS = 30 * 1000;
// Channel lists kept in memory for their buttons; past this the oldest is dropped, as on a restart.
const MAX_LOADED_LISTS = 20;

// Header message ID -> { entries, page, ids, at } for each posted channel list. Lost on restart.
const loadedLists = new Map();

const STATUS_NAMES = {
  running: 'Running',
  stopped: 'Stopped (run `/activitybackfill start` to continue)',
  incomplete: 'Incomplete (run `/activitybackfill start` to retry)',
  finished: 'Finished',
};

// A failed entry is an error; the rest are channels the bot can't (fully) read.
function allEntries(data) {
  return [...(data?.unreachable ?? []), ...(data?.failed ?? [])];
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}h ${minutes % 60}m`;
  return minutes ? `${minutes}m` : `${Math.floor(ms / 1000)}s`;
}

function reasonText(entry) {
  const reason = backfill.REASONS[entry.reason];
  const detail = entry.error ? `: ${truncate(entry.error, 100)}` : '';
  return `${reason.label}${detail} (${reason.missed})`;
}

function formatEntry(entry, index) {
  const link = entry.id ? `<#${entry.id}> ` : '';
  return `**${index + 1}.** ${link}**${escapeMarkdown(truncate(entry.name, 60))}** · ${escapeMarkdown(truncate(entry.category, 40))} · ` +
    `${entry.type} — ${reasonText(entry)}`;
}

// "3 Missing View Channel, 1 Error", or a line saying everything is reachable.
function reasonTotals(entries) {
  if (!entries.length) return ['✅ Every channel is reachable.'];
  const lines = Object.entries(backfill.REASONS)
    // Each channel or thread once; the run's own errors have no ID and are told apart by name.
    .map(([key, reason]) => [reason.label, new Set(entries.filter(e => e.reason === key).map(e => e.id ?? e.name)).size])
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `• ${label}: **${count}**`);
  return [`**Channels and threads it can't (fully) read:** ${backfill.countAffected(entries)}. Every problem is listed below.`, ...lines];
}

function runLines(data, status) {
  return [
    `**State:** ${STATUS_NAMES[status]}`,
    `**Reading back to:** ${discordTimestamp(data.cutoff, 'D')} (the earliest join among members when the pass began)`,
    `**Channels done:** ${data.channelsDone.length} of ${data.channelsTotal}`,
    `**Messages read:** ${formatNumber(data.messagesRead)}`,
    `**Command log copied:** ${data.commandLogCopied ? 'yes' : 'not yet'}`,
    `**Time taken:** ${formatDuration(backfill.timeTaken(data))}`,
    `**Skipped:** ${backfill.countAffected(data.unreachable)} · **Errors:** ${data.failed.length}`,
  ];
}

function embed(title, lines, at = Date.now()) {
  return new EmbedBuilder()
    .setColor(DEFAULT_EMBED_COLOR)
    .setTitle(title)
    .setDescription(truncate(lines.join('\n'), 4096))
    .setTimestamp(at);
}

function renderList(state) {
  return {
    embeds: [adminPost.pageEmbed({
      title: "📵 Channels it can't (fully) read",
      rows: state.entries,
      page: state.page,
      format: formatEntry,
      noun: 'problem',
      at: state.at,
    })],
    components: [adminPost.pageButtons(BUTTON_PREFIX, { page: state.page, count: state.entries.length })],
  };
}

function rememberList(state) {
  loadedLists.set(state.ids.header, state);
  if (loadedLists.size > MAX_LOADED_LISTS) loadedLists.delete(loadedLists.keys().next().value);
}

// Posts a header and, if there are any entries, the paged channel list under it. Returns the IDs.
async function postWithList(client, header, entries, postHeader) {
  const state = { entries, page: 0, at: Date.now() };
  state.ids = await adminPost.sendGroup(client, { embeds: [header] }, entries.length ? [['list', renderList(state)]] : [], postHeader);
  if (entries.length) rememberList(state);
  return state.ids;
}

// A check or status post replaces the previous one. Run summaries are posted with postWithList and kept.
async function postChannelReport(client, header, entries, postHeader) {
  const ids = await postWithList(client, header, entries, postHeader);
  // One at a time, so overlapping posts can't each miss the other.
  await withFileLock('backfill-channel-post', async () => {
    const previous = activity.readActivityState().channelPost;
    const kept = await adminPost.keepNewest(client, [ids, previous], LOG_PREFIX);
    if (previous?.header && previous.header !== kept.header) loadedLists.delete(previous.header);
    activity.updateActivityState({ channelPost: kept });
  });
  return ids.header;
}

async function postCheck(interaction, postHeader) {
  const guild = await interaction.client.guilds.fetch(process.env.CLAN_ID);
  const { readable, unreachable } = await backfill.checkAccess(guild);
  const header = embed(`${TITLE}: channel check`, [
    `**Checked** ${discordTimestamp(Date.now(), 'f')} by ${interaction.user}. No messages were read.`,
    `**Channels it can read:** ${readable.length}`,
    ...reasonTotals(unreachable),
    '',
    'Threads inside a channel the bot can’t view can’t be listed or counted. Honeypot channels are left out on purpose.',
  ]);
  return postChannelReport(interaction.client, header, unreachable, postHeader);
}

function postStatus(interaction, postHeader) {
  const { backfill: data, lastFinished, status } = backfill.getStatus();
  const entries = allEntries(data);
  const lines = data
    ? [...runLines(data, status), ...(lastFinished ? [`**Last finished:** ${discordTimestamp(lastFinished.finishedAt, 'f')}`] : []), '', ...reasonTotals(entries)]
    : ['No backfill has run. `/activitybackfill check` shows which channels it can’t reach.'];
  return postChannelReport(interaction.client, embed(`${TITLE}: status`, lines), entries, postHeader);
}

// A run's summary, kept in the admin log.
async function postSummary(client, data, postHeader = null) {
  const entries = allEntries(data);
  const header = embed(`${TITLE}: run ${data.status}`, [...runLines(data, data.status), '', ...reasonTotals(entries)]);
  return (await postWithList(client, header, entries, postHeader)).header;
}

function progressEmbed(data, intro) {
  return embed(`${TITLE}: progress`, [intro, '', ...runLines(data, 'running')]);
}

// Posts the progress message (the command's announcement) and starts the run in the background.
async function startRun(interaction, postHeader) {
  const { client } = interaction;
  let run;
  try {
    run = await backfill.prepareRun(client);
  } catch (err) {
    if (err instanceof backfill.BusyError) throw new adminPost.NoticeError(err.message);
    throw err;
  }
  const intro = `${run.resumed ? '▶️ Resumed' : '▶️ Started'} by ${interaction.user}.`;
  let messageId;
  try {
    ({ header: messageId } = await adminPost.sendGroup(client, { embeds: [progressEmbed({ ...run.data, status: 'running' }, intro)] }, [], postHeader));
  } catch (err) {
    run.cancel();
    throw err;
  }

  const editProgress = async content => {
    const channel = await adminPost.adminChannel(client);
    await channel.messages.edit(messageId, { embeds: [content], allowedMentions: adminPost.NO_PINGS });
  };
  let editedAt = Date.now();
  run.execute({
    onProgress: async data => {
      if (Date.now() - editedAt < PROGRESS_EVERY_MS) return;
      editedAt = Date.now();
      await editProgress(progressEmbed(data, intro));
    },
    // Also runs after a stop, whose own poster posts the summary instead.
    onSummary: data => postSummary(client, data),
  })
    .catch(async err => {
      console.error(`${LOG_PREFIX} The run or its summary failed:`, err);
      await adminPost.adminChannel(client)
        .then(channel => channel.send({ content: `⚠️ The activity backfill hit an error: ${truncate(err.message, 1500)}`, allowedMentions: adminPost.NO_PINGS }))
        .catch(sendErr => console.error(`${LOG_PREFIX} Could not report the error:`, sendErr.message));
    })
    .finally(() => {
      const { backfill: data, status } = backfill.getStatus();
      if (!data) return undefined;
      return editProgress(embed(`${TITLE}: progress`, [intro, 'This run has ended; its summary is posted separately.', '', ...runLines(data, status)]))
        .catch(err => console.warn(`${LOG_PREFIX} Could not close the progress message:`, err.message));
    });
  return messageId;
}

// The spreadsheet of one list.
function exportFile(state) {
  const columns = ['#', 'Channel', 'Channel ID', 'Category', 'Type', 'Reason', 'What is missed', 'Error'];
  const rows = state.entries.map((e, i) => [
    i + 1, e.name, e.id ?? '', e.category, e.type, backfill.REASONS[e.reason].label, backfill.REASONS[e.reason].missed, e.error ?? '',
  ]);
  const name = `backfill-unreachable-channels-${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.xlsx`;
  const file = buildXlsx([{ name: 'Channels', rows: [columns, ...rows], widths: [5, 28, 22, 24, 13, 30, 45, 45], boldRows: [0] }]);
  return new AttachmentBuilder(file, { name });
}

async function handleActivityBackfillButton(button) {
  if (!hasAnyRole(button.member, [process.env.OWNER_ROLE_ID])) {
    console.log(`${LOG_PREFIX} ${button.user.tag} pressed a list button (missing Owner role).`);
    await button.reply({ content: 'You need the Owner role to use these buttons.', flags: MessageFlags.Ephemeral });
    return;
  }
  const action = button.customId.slice(BUTTON_PREFIX.length);
  const state = [...loadedLists.values()].find(s => Object.values(s.ids).includes(button.message.id));
  if (!state) {
    await button.reply({
      content: 'This list has expired (the bot has restarted since it was posted). Run `/activitybackfill status` or `/activitybackfill check` again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (action === 'export') {
    await button.reply({ content: `${state.entries.length} problem(s). Opens in Excel or Google Sheets.`, files: [exportFile(state)], flags: MessageFlags.Ephemeral });
    return;
  }
  state.page = adminPost.turnPage(state.page, action, state.entries.length);
  await button.update(renderList(state));
}

const SUBCOMMANDS = {
  check: interaction => post => postCheck(interaction, post),
  start: interaction => post => startRun(interaction, post),
  status: interaction => post => postStatus(interaction, post),
  stop: interaction => post => {
    // Checked again: another stop may have arrived while this one was being acknowledged.
    const refusal = notice('stop');
    if (refusal) throw new adminPost.NoticeError(refusal);
    return backfill.requestStop(data => postSummary(interaction.client, data, post));
  },
};

// Refusals that don't need anything loaded, replied before the command is acknowledged.
function notice(subcommand) {
  if (subcommand === 'start' && backfill.isActive()) return 'A backfill is already running.';
  if (subcommand === 'stop' && !backfill.isActive()) return 'No backfill is running.';
  if (subcommand === 'stop' && backfill.isStopping()) return 'The backfill is already stopping.';
  return null;
}

module.exports = {
  // Shown in the admin commands post.
  help: {
    category: 'Members',
    access: 'Owner',
    examples: {
      check: '/activitybackfill check',
      start: '/activitybackfill start',
      status: '/activitybackfill status',
      stop: '/activitybackfill stop',
    },
  },
  // Only loaded while the backfill is switched on.
  requiredFeature: 'ACTIVITY_BACKFILL_ENABLED',
  requiredEnv: ['DATABASE_URL', 'CLAN_ID', 'OWNER_ROLE_ID', 'ADMIN_LOG_CHANNEL_ID'],

  handleActivityBackfillButton,

  data: new SlashCommandBuilder()
    .setName('activitybackfill')
    .setDefaultMemberPermissions(0)
    .setDescription('Fill in past member activity from channel history (one time)')
    .addSubcommand(s => s.setName('check').setDescription("List the channels the backfill can't reach, without reading any"))
    .addSubcommand(s => s.setName('start').setDescription('Start the backfill, or continue a stopped or incomplete one'))
    .addSubcommand(s => s.setName('status').setDescription("Show the backfill's progress and the channels it can't reach"))
    .addSubcommand(s => s.setName('stop').setDescription('Stop the running backfill; start continues it later')),

  async execute(interaction) {
    const refused = await refuseWithoutRole(interaction, [process.env.OWNER_ROLE_ID], {
      logPrefix: LOG_PREFIX, command: '/activitybackfill', missing: 'missing Owner role', message: 'You need the Owner role to use this command.',
    });
    if (refused) return;

    const subcommand = interaction.options.getSubcommand();
    console.log(`${LOG_PREFIX} ${interaction.user.tag} ran /activitybackfill ${subcommand}`);
    const refusal = notice(subcommand);
    if (refusal) {
      await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
      return;
    }
    await adminPost.runAdminCommand(interaction, {
      command: `/activitybackfill ${subcommand}`,
      logPrefix: LOG_PREFIX,
      post: async postHeader => SUBCOMMANDS[subcommand](interaction)(postHeader),
    });
  },
};
