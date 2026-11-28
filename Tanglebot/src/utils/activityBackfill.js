// The one-time backfill of member_activity from channel history and the command log, and the check
// for channels the bot can't reach. One run at a time. The command file does the posting.
const { ChannelType, PermissionFlagsBits, SnowflakeUtil } = require('discord.js');
const activity = require('./memberActivity');
const { flushState } = require('./state');

const FETCH_LIMIT = 100;
// Progress is saved at most this often while reading.
const CHECKPOINT_MS = 5 * 1000;
const UNKNOWN_CHANNEL = 10003;
// Missing Access, Missing Permissions.
const ACCESS_DENIED = new Set([50001, 50013]);

const CHANNEL_TYPES = {
  [ChannelType.GuildText]: 'Text',
  [ChannelType.GuildAnnouncement]: 'Announcement',
  [ChannelType.GuildVoice]: 'Voice',
  [ChannelType.GuildStageVoice]: 'Stage',
  [ChannelType.GuildForum]: 'Forum',
  [ChannelType.GuildMedia]: 'Media',
};
const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
// Forums and media channels hold only threads.
const NO_MESSAGES = new Set([ChannelType.GuildForum, ChannelType.GuildMedia]);

const REASONS = {
  view: { label: 'Missing View Channel', missed: 'the channel and its threads (not counted)' },
  history: { label: 'Missing Read Message History', missed: 'its history and threads' },
  connect: { label: 'Missing Connect', missed: 'the text chat' },
  manageThreads: { label: 'Missing Manage Threads', missed: 'private threads the bot has not joined are not read' },
  denied: { label: 'Access denied by Discord', missed: 'whatever was not read' },
  error: { label: 'Error', missed: 'whatever was not read' },
};

// { finished, stopRequested, summaryPoster, savedAt, ... }, or null when nothing is running.
let activeRun = null;

class BusyError extends Error {}
class DatabaseError extends Error {}

function entryFor(channel, reason, error = null) {
  const parent = channel.isThread?.() ? channel.parent : null;
  return {
    id: channel.id,
    name: channel.name ?? channel.id,
    category: (parent ?? channel).parent?.name ?? 'No category',
    type: parent || channel.isThread?.() ? 'Thread' : CHANNEL_TYPES[channel.type] ?? 'Channel',
    reason,
    ...(error ? { error } : {}),
  };
}

function missingReason(channel, permissions) {
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) return 'view';
  if (!permissions.has(PermissionFlagsBits.ReadMessageHistory)) return 'history';
  if (VOICE_TYPES.has(channel.type) && !permissions.has(PermissionFlagsBits.Connect)) return 'connect';
  return null;
}

// How many different channels and threads the entries are about. One can have several entries, and
// the entries for the run itself have no ID.
function countAffected(entries) {
  return new Set(entries.map(e => e.id).filter(Boolean)).size;
}

// Sorts the server's channels into those to read and those the bot can't (fully) read. Reads no
// messages. Honeypot channels are left out of both.
async function checkAccess(guild) {
  const me = await guild.members.fetchMe();
  // Discord lists every channel, including those the bot can't view.
  const channels = await guild.channels.fetch();
  const ignored = activity.ignoredChannelIds();
  const readable = [];
  const unreachable = [];
  const ordered = [...channels.values()]
    .filter(channel => channel && CHANNEL_TYPES[channel.type] && !ignored.has(channel.id))
    .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
  for (const channel of ordered) {
    const permissions = channel.permissionsFor(me);
    const reason = missingReason(channel, permissions);
    if (reason) {
      unreachable.push(entryFor(channel, reason));
      continue;
    }
    // Only text channels have private threads.
    const manageThreads = permissions.has(PermissionFlagsBits.ManageThreads);
    if (channel.type === ChannelType.GuildText && !manageThreads) unreachable.push(entryFor(channel, 'manageThreads'));
    readable.push({ channel, manageThreads });
  }
  return { readable, unreachable };
}

// The earliest join among current members. Older messages can't change the report.
async function findCutoff(guild) {
  const members = await activity.fetchAllMembers(guild);
  const joins = members.filter(m => !m.user.bot && m.joinedTimestamp).map(m => m.joinedTimestamp);
  if (!joins.length) throw new Error('Found no members with a join date.');
  return joins.reduce((a, b) => Math.min(a, b));
}

function isActive() {
  return Boolean(activeRun);
}

function isStopping() {
  return Boolean(activeRun?.stopRequested);
}

// The saved run and its status: none, running, stopped, incomplete or finished. A run saved as
// running that isn't running (a restart) is stopped.
function getStatus() {
  const { backfill = null, lastFinished = null } = activity.readActivityState();
  let status = backfill?.status ?? 'none';
  if (status === 'running' && !activeRun) status = 'stopped';
  return { backfill, lastFinished, status };
}

function timeTaken(data, now = Date.now()) {
  return data.activeMs + (activeRun && data.segmentStart ? now - data.segmentStart : 0);
}

// Saves the run, adding the time since the last save, so a restart doesn't count the downtime.
function save(data) {
  if (data.segmentStart) {
    const now = Date.now();
    data.activeMs += now - data.segmentStart;
    data.segmentStart = now;
  }
  activity.updateActivityState({ backfill: data });
}

// Saves progress while reading, but not for every page and thread: each save rewrites the state file
// and writes to the database. A restart rereads at most the last few seconds, which changes nothing.
function checkpoint(run, data) {
  if (Date.now() - run.savedAt < CHECKPOINT_MS) return;
  run.savedAt = Date.now();
  save(data);
}

function newData(cutoff) {
  return {
    status: 'running',
    startedAt: Date.now(),
    cutoff,
    activeMs: 0,
    segmentStart: null,
    messagesRead: 0,
    commandLogCopied: false,
    // Channels and threads fully read, and the oldest message read so far in the others.
    done: [],
    positions: {},
    channelsDone: [],
    channelsTotal: 0,
    unreachable: [],
    failed: [],
  };
}

async function saveToDatabase(work) {
  try {
    await work();
  } catch (err) {
    throw new DatabaseError(`Saving to the database failed: ${err.message}`);
  }
}

// One page of a channel or thread, newest first, with its activity saved. Only messages sent since
// `since` count.
async function readPage(target, before, since) {
  const messages = [...(await target.messages.fetch({ limit: FETCH_LIMIT, cache: false, ...(before ? { before } : {}) })).values()];
  const recent = messages.filter(message => message.createdTimestamp >= since);
  const ignored = activity.ignoredChannelIds();
  const found = recent.map(message => activity.classifyMessage(message, ignored)).filter(Boolean);
  await saveToDatabase(() => activity.saveActivity(found));
  const oldest = messages.length ? messages.reduce((a, b) => (BigInt(a.id) < BigInt(b.id) ? a : b)) : null;
  // Whether there is nothing older left to read.
  const end = messages.length < FETCH_LIMIT || oldest.createdTimestamp < since;
  return { read: messages.length, recent: recent.length, oldest, end };
}

// True if the newest message is known to be older than `time`.
function quietSince(target, time) {
  return Boolean(target.lastMessageId) && SnowflakeUtil.timestampFrom(target.lastMessageId) < time;
}

// For a channel or thread read before the run was interrupted: reads what was sent since the pass
// began, which covers anything sent while the bot was down. Returns false if stopped partway.
async function catchUp(run, data, target) {
  if (quietSince(target, data.startedAt)) return true;
  let before;
  for (;;) {
    if (run.stopRequested) return false;
    const page = await readPage(target, before, data.startedAt);
    // The rest of the page was counted when it was first read.
    data.messagesRead += page.recent;
    if (page.end) return true;
    before = page.oldest.id;
    await run.onProgress(data);
  }
}

// Reads one channel or thread back to the cutoff. Its position moves on only after that page's
// activity is in the database.
async function readMessages(run, data, target) {
  if (data.done.includes(target.id) && !run.stale.has(target.id)) return;
  const finish = () => {
    data.done.push(target.id);
    delete data.positions[target.id];
    checkpoint(run, data);
  };
  try {
    if (run.stale.has(target.id)) {
      if (!await catchUp(run, data, target)) return;
      run.stale.delete(target.id);
      if (data.done.includes(target.id)) return;
    }
    // Its newest message is older than anything that counts.
    if (quietSince(target, data.cutoff)) return finish();
    for (;;) {
      if (run.stopRequested) return;
      const page = await readPage(target, data.positions[target.id], data.cutoff);
      data.messagesRead += page.read;
      if (page.end) return finish();
      data.positions[target.id] = page.oldest.id;
      checkpoint(run, data);
      await run.onProgress(data);
    }
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    // Deleted during the run.
    if (err?.code === UNKNOWN_CHANNEL) return finish();
    if (ACCESS_DENIED.has(err?.code)) data.unreachable.push(entryFor(target, 'denied', err.message));
    else data.failed.push(entryFor(target, 'error', err.message));
  }
}

// Reads a channel's archived threads of one type. Without Manage Threads, only the private ones the
// bot joined can be listed.
async function readArchived(run, data, channel, type, fetchAll) {
  // Public and fetch-all lists are newest-archived first and page by time; the joined list pages by ID.
  const byTime = type === 'public' || fetchAll;
  let before;
  try {
    for (;;) {
      if (run.stopRequested) return;
      const page = await channel.threads.fetchArchived({ type, fetchAll, limit: FETCH_LIMIT, ...(before ? { before } : {}) }, false);
      const threads = [...page.threads.values()];
      for (const thread of threads) {
        if (run.stopRequested) return;
        await readMessages(run, data, thread);
      }
      const last = threads.at(-1);
      if (!page.hasMore || !last) return;
      // A thread archived before the cutoff has no newer messages, nor do those after it.
      if (byTime && last.archivedAt?.getTime() < data.cutoff) return;
      before = byTime ? last.archivedAt : last.id;
    }
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    // Deleted during the run.
    if (err?.code === UNKNOWN_CHANNEL) return;
    const what = `Listing ${type} archived threads failed: ${err.message}`;
    if (ACCESS_DENIED.has(err?.code)) data.unreachable.push(entryFor(channel, 'denied', what));
    else data.failed.push(entryFor(channel, 'error', what));
  }
}

async function listActiveThreads(guild) {
  const ignored = activity.ignoredChannelIds();
  return [...(await guild.channels.fetchActiveThreads(false)).threads.values()].filter(thread => !ignored.has(thread.parentId));
}

async function readActive(run, data, channel, threads) {
  for (const thread of threads.filter(t => t.parentId === channel.id)) {
    if (run.stopRequested) return;
    await readMessages(run, data, thread);
  }
}

async function readChannel(run, data, guild, { channel, manageThreads }, activeThreads) {
  const failedBefore = data.failed.length;
  if (!NO_MESSAGES.has(channel.type)) await readMessages(run, data, channel);
  if (!VOICE_TYPES.has(channel.type)) {
    await readActive(run, data, channel, activeThreads);
    await readArchived(run, data, channel, 'public', false);
    if (channel.type === ChannelType.GuildText) await readArchived(run, data, channel, 'private', manageThreads);
    if (run.stopRequested) return;
    // Again: an archived thread reopened since the first list is no longer listed as archived.
    try {
      await readActive(run, data, channel, await listActiveThreads(guild));
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      data.failed.push(entryFor(channel, 'error', `Listing active threads failed: ${err.message}`));
    }
  }
  if (!run.stopRequested && data.failed.length === failedBefore && !data.channelsDone.includes(channel.id)) {
    data.channelsDone.push(channel.id);
  }
}

async function readEverything(run, data, guild, readable) {
  if (!data.commandLogCopied) {
    await saveToDatabase(() => activity.copyCommandLog());
    data.commandLogCopied = true;
    save(data);
  }
  let activeThreads = [];
  try {
    activeThreads = await listActiveThreads(guild);
  } catch (err) {
    data.failed.push({ id: null, name: 'Active threads', category: 'Server', type: 'Thread', reason: 'error', error: err.message });
  }
  for (const target of readable) {
    if (run.stopRequested) return;
    await readChannel(run, data, guild, target, activeThreads);
    checkpoint(run, data);
    await run.onProgress(data);
  }
}

// Reserves the run and gets it ready: resumes a stopped or incomplete one, otherwise starts a new
// pass. Returns { data, resumed, execute, cancel }.
async function prepareRun(client) {
  if (activeRun) throw new BusyError('A backfill is already running.');
  const run = { stopRequested: false, summaryPoster: null, savedAt: 0, stale: new Set(), onProgress: async () => {} };
  run.finished = new Promise((resolve, reject) => Object.assign(run, { resolve, reject }));
  // Only /activitybackfill stop waits on this; other failures are handled where they happen.
  run.finished.catch(() => {});
  activeRun = run;
  const release = () => { if (activeRun === run) activeRun = null; };

  try {
    const guild = await client.guilds.fetch(process.env.CLAN_ID);
    const { readable, unreachable } = await checkAccess(guild);
    const { backfill, status } = getStatus();
    const resumed = Boolean(backfill) && status !== 'finished';
    const data = resumed ? backfill : newData(await findCutoff(guild));
    // Channels and threads already read, wholly or partly, are checked again for newer messages.
    if (resumed) run.stale = new Set([...data.done, ...Object.keys(data.positions)]);
    // Failed and skipped entries are found again; channels already read stay done.
    // segmentStart is cleared so a run cut off by a restart doesn't count the downtime.
    Object.assign(data, { unreachable, failed: [], channelsTotal: readable.length, segmentStart: null });
    data.channelsDone = data.channelsDone.filter(id => readable.some(r => r.channel.id === id));

    // Runs to the end, a stop or a database failure. `onProgress(data)` is called after each page,
    // and `onSummary(data)` once at the end, unless a stop supplied its own. Both may be async.
    const execute = async ({ onProgress, onSummary }) => {
      run.onProgress = async current => {
        try {
          await onProgress(current);
        } catch (err) {
          console.warn('[Backfill] Could not report progress:', err.message);
        }
      };
      try {
        Object.assign(data, { status: 'running', segmentStart: Date.now() });
        save(data);
        let aborted = false;
        try {
          await readEverything(run, data, guild, readable);
        } catch (err) {
          aborted = true;
          console.error('[Backfill] The run could not continue:', err);
          data.failed.push({ id: null, name: 'Run', category: 'Server', type: 'Run', reason: 'error', error: err.message });
        }
        const complete = !aborted && data.commandLogCopied && data.channelsDone.length === readable.length;
        data.status = data.failed.length ? 'incomplete' : complete ? 'finished' : 'stopped';
        save(data);
        data.segmentStart = null;
        // So an earlier save still on its way to the database can't land after the final one.
        await flushState();
        if (data.status === 'finished') {
          Object.assign(data, { done: [], positions: {} });
          activity.updateActivityState({ lastFinished: { finishedAt: Date.now(), unreachableCount: countAffected(data.unreachable) } });
        }
        save(data);
        console.log(`[Backfill] Run ${data.status}: ${data.messagesRead} message(s) read, ${data.unreachable.length} unreachable, ${data.failed.length} failed.`);
        const { summaryPoster } = run;
        release();
        let posted;
        try {
          posted = await (summaryPoster ?? onSummary)(data);
        } catch (err) {
          // The stop command's reply failed: the summary still goes to the admin log.
          if (summaryPoster) await onSummary(data);
          throw err;
        }
        run.resolve(posted);
      } catch (err) {
        console.error('[Backfill] Run failed:', err);
        run.reject(err);
        throw err;
      } finally {
        release();
      }
    };

    const cancel = () => {
      release();
      run.reject(new Error('The run did not start.'));
    };
    return { data, resumed, execute, cancel };
  } catch (err) {
    release();
    run.reject(err);
    throw err;
  }
}

// Asks the run to stop after its current request. `summaryPoster(data)` posts its summary. Resolves
// with what the poster returned.
function requestStop(summaryPoster) {
  const run = activeRun;
  run.stopRequested = true;
  run.summaryPoster = summaryPoster;
  return run.finished;
}

module.exports = {
  REASONS,
  BusyError,
  countAffected,
  checkAccess,
  prepareRun,
  requestStop,
  getStatus,
  isActive,
  isStopping,
  timeTaken,
};
