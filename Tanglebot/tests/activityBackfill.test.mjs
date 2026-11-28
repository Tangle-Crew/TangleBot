import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, ago, member, message, snowflake, interaction, button, embedOf } from './helpers/quietFakes.mjs';

const require = createRequire(import.meta.url);
const fakes = setup();
const activity = require('../src/utils/memberActivity.js');
const backfill = require('../src/utils/activityBackfill.js');
const command = require('../src/commands/activitybackfill.js');
const { commandDisabledReason } = require('../src/utils/commandAvailability.js');
const { ChannelType, MessageType, PermissionFlagsBits: P } = require('discord.js');

beforeEach(() => {
  fakes.reset();
  fakes.members = [member('founder', { joined: 100 }), member('later', { joined: 10 })];
});

const EVERYTHING = [P.ViewChannel, P.ReadMessageHistory, P.Connect, P.ManageThreads];
const without = (...flags) => EVERYTHING.filter(f => !flags.includes(f));

// A channel or thread whose history is `messages`, any order. fetches records each request.
function history(target, messages) {
  // Discord orders history by message ID.
  const newestFirst = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
  target.lastMessageId = null;
  target.fetches = [];
  target.messages = {
    fetch: async ({ limit, before }) => {
      target.fetches.push(before ?? null);
      await target.onFetch?.(target.fetches.length);
      if (target.error) throw target.error;
      const older = before ? newestFirst.filter(m => BigInt(m.id) < BigInt(before)) : newestFirst;
      return new Map(older.slice(0, limit).map(m => [m.id, m]));
    },
  };
  return target;
}

function channel(name, { type = ChannelType.GuildText, perms = EVERYTHING, messages = [], archived = {} } = {}) {
  const c = history({
    id: name, name, type, parent: { name: 'Chat', rawPosition: 0 }, rawPosition: fakes.guildChannels.length,
    permissionsFor: () => ({ has: flag => perms.includes(flag) }),
  }, messages);
  c.archivedRequests = [];
  c.threads = {
    fetchArchived: async options => {
      c.archivedRequests.push(options);
      return { threads: new Map((archived[options.type] ?? []).map(t => [t.id, t])), hasMore: false };
    },
  };
  fakes.guildChannels.push(c);
  return c;
}

const thread = (name, parent, messages, archivedDays = 1) =>
  history({ id: name, name, parentId: parent.id, parent, isThread: () => true, archivedAt: new Date(ago(archivedDays)) }, messages);

// `count` messages by one person, a minute apart, going back from `days` ago.
const chatter = (author, count, days, extra = {}) =>
  Array.from({ length: count }, (_, i) => message({ author, at: Math.floor(ago(days)) - i * 60000, ...extra }));

const posts = () => [...fakes.posts.values()];
const titles = () => posts().map(p => embedOf(p).title);
const allText = () => posts().map(p => `${embedOf(p).title}\n${embedOf(p).description}`).join('\n');

async function run(subcommand, options = {}) {
  const i = interaction(fakes, { subcommand, ...options });
  await command.execute(i);
  return i;
}

// Starts a run through the engine and waits for it to end.
async function backfillNow(during) {
  const prepared = await backfill.prepareRun(fakes.client);
  let summary = null;
  const done = prepared.execute({ onProgress: async data => during?.(data), onSummary: data => { summary = data; return 'summary'; } });
  await done;
  return { prepared, data: summary ?? backfill.getStatus().backfill };
}

const waitForIdle = async () => {
  while (backfill.isActive()) await new Promise(resolve => setImmediate(resolve));
  // Lets the summary and progress edits finish.
  await new Promise(resolve => setTimeout(resolve, 20));
};

test('does not load unless switched on, and needs its settings', () => {
  assert.match(commandDisabledReason(command, { ...process.env }), /ACTIVITY_BACKFILL_ENABLED/);
  assert.match(commandDisabledReason(command, { ...process.env, ACTIVITY_BACKFILL_ENABLED: 'false' }), /ACTIVITY_BACKFILL_ENABLED/);
  const on = { ...process.env, ACTIVITY_BACKFILL_ENABLED: 'true' };
  assert.equal(commandDisabledReason(command, on), null);
  for (const key of ['DATABASE_URL', 'CLAN_ID', 'OWNER_ROLE_ID', 'ADMIN_LOG_CHANNEL_ID']) {
    assert.match(commandDisabledReason(command, { ...on, [key]: '' }), new RegExp(key));
  }
});

test('the command and its buttons need the Owner role', async () => {
  const i = await run('check', { roles: ['templar'] });
  assert.match(i.sent.replies[0].content, /Owner role/);
  const press = button(fakes, 'activitybackfill:export', '1', { roles: ['templar'] });
  await command.handleActivityBackfillButton(press);
  assert.match(press.sent.replies[0].content, /Owner role/);
  assert.equal(fakes.posts.size, 0);
});

test('check names each channel it cannot reach with the reason, and reads no messages', async () => {
  const open = channel('open', { messages: chatter('later', 1, 1) });
  channel('secret', { perms: [] });
  channel('nohistory', { perms: [P.ViewChannel] });
  channel('lounge', { type: ChannelType.GuildVoice, perms: without(P.Connect) });
  channel('nothreads', { perms: without(P.ManageThreads) });
  channel('news', { type: ChannelType.GuildAnnouncement, perms: without(P.ManageThreads) });
  channel('trap', { perms: [] });
  channel('category', { type: ChannelType.GuildCategory, perms: [] });

  await run('check');
  const list = embedOf(posts()[1]).description;
  assert.match(list, /secret\*\*.*Missing View Channel \(the channel and its threads/);
  assert.match(list, /nohistory\*\*.*Missing Read Message History/);
  assert.match(list, /lounge\*\*.*Voice — Missing Connect/);
  assert.match(list, /nothreads\*\*.*Missing Manage Threads/);
  assert.doesNotMatch(list, /\*\*(open|news|trap|category)\*\*/);
  assert.match(embedOf(posts()[0]).description, /can read:\*\* 3/);
  assert.equal(open.fetches.length, 0);
  assert.equal(fakes.rows.size, 0);
  assert.equal(fakes.files.get('member-activity.json').backfill, undefined);
});

test('check with everything reachable has no list, and a new check replaces the old one', async () => {
  channel('secret', { perms: [] });
  await run('check');
  assert.equal(fakes.posts.size, 2);
  fakes.guildChannels = [];
  channel('open');
  await run('check');
  assert.equal(fakes.posts.size, 1);
  assert.match(allText(), /Every channel is reachable/);
});

test('reads channels, threads and voice chats back to the earliest join, and copies the command log', async () => {
  const general = channel('general', {
    messages: [
      ...chatter('founder', 1, 5),
      ...chatter('newbie', 1, 6, { type: MessageType.UserJoin, system: true }),
      ...chatter('ancient', 1, 150),
    ],
  });
  general.archived = null;
  const forum = channel('forum', { type: ChannelType.GuildForum, archived: {} });
  const post = thread('forumpost', forum, chatter('poster', 1, 3));
  forum.threads.fetchArchived = async () => ({ threads: new Map([[post.id, post]]), hasMore: false });
  fakes.activeThreads = [thread('live', general, chatter('threader', 1, 2))];
  channel('lounge', { type: ChannelType.GuildVoice, messages: chatter('voicechat', 1, 4) });
  const trap = channel('trap', { messages: chatter('trapped', 1, 1) });
  fakes.commandLog = [{ discordId: 'commander', at: new Date(ago(8)) }];

  const { data } = await backfillNow();
  assert.equal(data.status, 'finished');
  assert.deepEqual([...fakes.rows.keys()].sort(), [
    'commander:command', 'founder:message', 'poster:message', 'threader:message', 'voicechat:message',
  ]);
  assert.equal(trap.fetches.length, 0);
  assert.equal(data.channelsDone.length, 3);
  assert.ok(backfill.getStatus().lastFinished);
});

test('stops paging at the earliest join date', async () => {
  const messages = [...chatter('later', 150, 99), ...chatter('ancient', 300, 101)];
  const general = channel('general', { messages });
  await backfillNow();
  assert.equal(general.fetches.length, 2);
  assert.ok(!fakes.rows.has('ancient:message'));
});

test('private threads are listed in full only with Manage Threads', async () => {
  const all = channel('all');
  const some = channel('some', { perms: without(P.ManageThreads) });
  await backfillNow();
  assert.equal(all.archivedRequests.find(r => r.type === 'private').fetchAll, true);
  assert.equal(some.archivedRequests.find(r => r.type === 'private').fetchAll, false);
});

test('a skipped channel does not stop the run finishing', async () => {
  channel('open');
  channel('secret', { perms: [] });
  const { data } = await backfillNow();
  assert.equal(data.status, 'finished');
  assert.equal(backfill.getStatus().lastFinished.unreachableCount, 1);
});

test('a failed channel leaves the run incomplete, and start retries just that one', async () => {
  const good = channel('good', { messages: chatter('later', 1, 1) });
  good.lastMessageId = snowflake(ago(1));
  const bad = channel('bad', { messages: chatter('founder', 1, 1) });
  bad.error = new Error('Internal Server Error');
  const first = await backfillNow();
  assert.equal(first.data.status, 'incomplete');
  assert.deepEqual(first.data.failed.map(f => [f.name, f.reason, f.error]), [['bad', 'error', 'Internal Server Error']]);
  assert.equal(backfill.getStatus().lastFinished, null);
  assert.ok(fakes.rows.has('later:message'), 'the other channel was still read');

  bad.error = null;
  const goodFetches = good.fetches.length;
  const second = await backfillNow();
  assert.equal(second.prepared.resumed, true);
  assert.equal(second.data.status, 'finished');
  assert.equal(good.fetches.length, goodFetches);
  assert.ok(fakes.rows.has('founder:message'));
});

test('access refused while reading counts as skipped', async () => {
  channel('odd').error = Object.assign(new Error('Missing Access'), { code: 50001 });
  const { data } = await backfillNow();
  assert.equal(data.status, 'finished');
  assert.equal(data.unreachable[0].reason, 'denied');
});

test('a database failure ends the run without saving a position past unsaved activity', async () => {
  channel('general', { messages: chatter('later', 150, 1) });
  const prepared = await backfill.prepareRun(fakes.client);
  fakes.failDatabase = true;
  let data;
  await prepared.execute({ onProgress: async () => {}, onSummary: d => { data = d; } });
  assert.equal(data.status, 'incomplete');
  assert.deepEqual(data.positions, {});
  assert.match(data.failed[0].error, /database down/);
});

test('stop saves the position and start continues from it', async () => {
  const general = channel('general', { messages: chatter('later', 250, 1) });
  general.lastMessageId = snowflake(ago(1));
  let stopped = null;
  general.onFetch = count => {
    if (count === 1) stopped = backfill.requestStop(() => 'stop-summary');
  };
  await backfillNow();
  assert.equal(await stopped, 'stop-summary');
  const saved = backfill.getStatus();
  assert.equal(saved.status, 'stopped');
  assert.ok(saved.backfill.positions.general);

  general.onFetch = null;
  const { data } = await backfillNow();
  assert.equal(data.status, 'finished');
  assert.equal(general.fetches[1], saved.backfill.positions.general);
  assert.equal(data.messagesRead, 250);
});

test('a run left running by a restart shows as stopped, and a finished one starts a new pass', async () => {
  channel('general');
  const first = await backfillNow();
  const { backfill: finished } = backfill.getStatus();
  activity.updateActivityState({ backfill: { ...finished, status: 'running' } });
  assert.equal(backfill.getStatus().status, 'stopped');
  activity.updateActivityState({ backfill: finished });
  const second = await backfillNow();
  assert.equal(second.prepared.resumed, false);
  assert.ok(second.data.startedAt >= first.data.startedAt);
});

test('only one run can be active', async () => {
  channel('general');
  const prepared = await backfill.prepareRun(fakes.client);
  await assert.rejects(backfill.prepareRun(fakes.client), /already running/);
  const i = await run('start');
  assert.match(i.sent.replies[0].content, /already running/);
  prepared.cancel();
  assert.equal(backfill.isActive(), false);
});

test('of two stops at once, one posts the summary and the other is told it is already stopping', async () => {
  const general = channel('general', { messages: chatter('later', 1, 1) });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  general.onFetch = () => held;
  await run('start');

  const first = interaction(fakes, { subcommand: 'stop', channelId: 'adminlog' });
  const second = interaction(fakes, { subcommand: 'stop' });
  const both = Promise.all([command.execute(first), command.execute(second)]);
  while (!backfill.isStopping()) await new Promise(resolve => setImmediate(resolve));
  release();
  await both;
  await waitForIdle();

  assert.equal(typeof first.sent.edits[0], 'object', 'the first gets the summary as its reply');
  assert.match(second.sent.edits.at(-1), /already stopping/);
  assert.ok(!second.commandError);
});

test('a run cut off by a restart does not count the downtime when resumed', async () => {
  channel('general');
  const prepared = await backfill.prepareRun(fakes.client);
  prepared.cancel();
  activity.updateActivityState({ backfill: { ...prepared.data, status: 'running', activeMs: 60000, segmentStart: ago(2) } });
  const resumed = await backfill.prepareRun(fakes.client);
  assert.equal(backfill.timeTaken(resumed.data), 60000);
  resumed.cancel();
});

test('an archived thread reopened during the run is still read', async () => {
  const first = channel('first');
  const second = channel('second');
  const reopened = thread('reopened', second, chatter('oldposter', 1, 5));
  let isOpen = false;
  first.onFetch = () => {
    isOpen = true;
    fakes.activeThreads = [reopened];
  };
  second.threads.fetchArchived = async () => ({ threads: new Map(isOpen ? [] : [[reopened.id, reopened]]), hasMore: false });
  const { data } = await backfillNow();
  assert.equal(data.status, 'finished');
  assert.ok(fakes.rows.has('oldposter:message'));
  assert.equal(reopened.fetches.length, 1);
});

test('resuming reads what was sent during downtime in channels already read', async () => {
  const history_ = chatter('later', 3, 5);
  channel('read', { messages: history_ });
  channel('broken').error = new Error('Server Error');
  assert.equal((await backfillNow()).data.status, 'incomplete');

  // The bot was down: this was never seen live.
  fakes.guildChannels = [];
  channel('read', { messages: [...history_, message({ author: 'downtime' })] });
  channel('broken');
  const { data } = await backfillNow();
  assert.equal(data.status, 'finished');
  assert.ok(fakes.rows.has('downtime:message'));
  assert.equal(data.messagesRead, 4, 'messages read before are not counted again');
});

test('resuming a partly read channel reads both the newer and the older messages', async () => {
  const older = [...chatter('later', 150, 5), ...chatter('earliest', 1, 50)];
  const general = channel('general', { messages: older });
  general.onFetch = count => {
    if (count === 1) backfill.requestStop(() => 'stopped');
  };
  await backfillNow();
  assert.ok(!fakes.rows.has('earliest:message'));

  fakes.guildChannels = [];
  channel('general', { messages: [...older, ...Array.from({ length: 120 }, () => message({ author: 'downtime' }))] });
  const { data } = await backfillNow();
  assert.equal(data.status, 'finished');
  assert.ok(fakes.rows.has('downtime:message') && fakes.rows.has('earliest:message'));
  assert.equal(data.messagesRead, 271);
});

test('a read channel with nothing since the pass began is not fetched again', async () => {
  const quiet = channel('quiet', { messages: chatter('later', 1, 5) });
  quiet.lastMessageId = snowflake(ago(5));
  channel('broken').error = new Error('Server Error');
  await backfillNow();
  await backfillNow();
  assert.equal(quiet.fetches.length, 1);
});

test('a channel deleted during the run does not leave it incomplete', async () => {
  const gone = Object.assign(new Error('Unknown Channel'), { code: 10003 });
  const deleted = channel('deleted');
  deleted.error = gone;
  deleted.threads.fetchArchived = async () => { throw gone; };
  const { data } = await backfillNow();
  assert.equal(data.status, 'finished');
  assert.deepEqual(data.failed, []);
});

test('a channel with several problems is counted once, and every problem is listed', async () => {
  const odd = channel('odd', { perms: without(P.ManageThreads) });
  odd.threads.fetchArchived = async () => { throw Object.assign(new Error('Missing Access'), { code: 50001 }); };
  const { data } = await backfillNow();
  assert.equal(data.unreachable.length, 3);
  assert.equal(backfill.getStatus().lastFinished.unreachableCount, 1);
  await run('status');
  assert.match(allText(), /can't \(fully\) read:\*\* 1\./);
  assert.match(allText(), /Access denied by Discord: \*\*1\*\*/);
});

test('if the stop reply fails, the summary is still posted and the failure reported', async () => {
  const general = channel('general', { messages: chatter('later', 1, 1) });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  general.onFetch = () => held;
  await run('start');
  const stop = interaction(fakes, { subcommand: 'stop', channelId: 'adminlog' });
  stop.editReply = async () => { throw new Error('Invalid Webhook Token'); };
  const stopping = command.execute(stop);
  while (!backfill.isStopping()) await new Promise(resolve => setImmediate(resolve));
  release();
  await stopping;
  await waitForIdle();
  const posted = posts().filter(p => p.embeds).map(p => embedOf(p).title);
  assert.equal(posted.filter(t => /run (stopped|finished)/.test(t)).length, 1);
  assert.ok(posted.some(t => t.includes('/activitybackfill stop failed')));
  assert.ok(stop.commandError);
});

test('stop with nothing running is a private notice', async () => {
  const i = await run('stop');
  assert.match(i.sent.replies[0].content, /No backfill is running/);
  assert.equal(fakes.posts.size, 0);
});

for (const channelId of ['elsewhere', 'adminlog']) {
  test(`every subcommand posts to the admin log when run from ${channelId}`, async () => {
    const general = channel('general', { messages: chatter('later', 250, 1) });
    channel('secret', { perms: [] });
    const checkLink = i => {
      if (channelId === 'adminlog') assert.equal(typeof i.sent.edits[0], 'object');
      else assert.match(i.sent.edits.at(-1), /channels\/clan\/adminlog\/\d+/);
    };

    checkLink(await run('check', { channelId }));
    assert.ok(titles().some(t => t.includes('channel check')));
    checkLink(await run('status', { channelId }));
    assert.ok(titles().some(t => t.includes('status')));
    assert.ok(!titles().some(t => t.includes('channel check')), 'status replaced the check');

    // Held on its first request until stop is run.
    let release;
    const held = new Promise(resolve => { release = resolve; });
    general.onFetch = () => held;
    checkLink(await run('start', { channelId }));
    assert.ok(titles().some(t => t.includes('progress')));
    const stopping = run('stop', { channelId });
    while (!backfill.isStopping()) await new Promise(resolve => setImmediate(resolve));
    release();
    checkLink(await stopping);
    await waitForIdle();
    assert.equal(titles().filter(t => t.includes('run stopped')).length, 1, 'one summary');
    assert.match(allText(), /This run has ended/);

    general.onFetch = null;
    await run('start', { channelId });
    await waitForIdle();
    assert.equal(titles().filter(t => t.includes('run finished')).length, 1);
    assert.equal(titles().filter(t => t.includes('run stopped')).length, 1, 'summaries are kept');
  });
}

test('the channel list pages and exports, and expires after a restart', async () => {
  for (let i = 0; i < 18; i++) channel(`hidden${String(i).padStart(2, '0')}`, { perms: [] });
  await run('check');
  const listId = [...fakes.posts.keys()][1];
  const next = button(fakes, 'activitybackfill:next', listId);
  await command.handleActivityBackfillButton(next);
  assert.match(next.sent.updates[0].embeds[0].toJSON().footer.text, /Page 2\/2 · 18 problems/);

  const exported = button(fakes, 'activitybackfill:export', listId);
  await command.handleActivityBackfillButton(exported);
  assert.match(exported.sent.replies[0].files[0].name, /\.xlsx$/);

  const gone = button(fakes, 'activitybackfill:next', snowflake());
  await command.handleActivityBackfillButton(gone);
  assert.match(gone.sent.replies[0].content, /expired/);
});
