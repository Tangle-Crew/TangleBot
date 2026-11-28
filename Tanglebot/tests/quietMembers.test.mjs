import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, ago, member, interaction, button, embedOf } from './helpers/quietFakes.mjs';

const require = createRequire(import.meta.url);
const fakes = setup();
const activity = require('../src/utils/memberActivity.js');
const command = require('../src/commands/quietmembers.js');
const { commandDisabledReason } = require('../src/utils/commandAvailability.js');

// Export copies are not written to the data folder.
const saved = [];
command.saveExport = async name => { saved.push(name); return name; };

beforeEach(() => {
  fakes.reset();
  saved.length = 0;
  // Tracking started 20 days ago.
  activity.updateActivityState({ trackingStartedAt: new Date(ago(20)).toISOString() });
});

const posts = () => [...fakes.posts.values()];
const post = title => posts().find(p => embedOf(p).title.includes(title));
const idOf = title => [...fakes.posts].find(([, p]) => embedOf(p).title.includes(title))?.[0];
const allText = () => posts().map(p => embedOf(p).description).join('\n');

async function run(options) {
  const i = interaction(fakes, options);
  await command.execute(i);
  return i;
}

const active = (id, days, kind = 'message') => activity.saveActivity([{ discordId: id, kind, at: new Date(ago(days)) }]);

test('does not load without its settings, and refuses without the Templar role', async () => {
  for (const key of ['DATABASE_URL', 'CLAN_ID', 'TEMPLAR_ROLE_ID', 'ADMIN_LOG_CHANNEL_ID']) {
    const env = { ...process.env, [key]: '' };
    assert.match(commandDisabledReason(command, env), new RegExp(key));
  }
  const i = await run({ roles: [] });
  assert.match(i.sent.replies[0].content, /Templar role/);
  assert.equal(i.commandDenied, true);
  assert.equal(fakes.posts.size, 0);
});

test('lists quiet members past the days limit in two lists, and labels them', async () => {
  fakes.members = [
    member('new-quiet', { joined: 10 }),
    member('old-quiet', { joined: 100 }),
    member('talker', { joined: 10 }),
    member('voicer', { joined: 100 }),
    member('too-new', { joined: 3 }),
    member('robot', { joined: 100, bot: true }),
  ];
  await active('talker', 9);
  await active('voicer', 1, 'voice');
  await run();

  assert.equal(fakes.posts.size, 3);
  const header = embedOf(post('Quiet Members')).description;
  assert.match(header, /Members checked:\*\* 4/);
  assert.match(header, /No activity recorded: \*\*1\*\*/);
  assert.match(header, /Unknown: \*\*1\*\*/);
  assert.match(header, /Backfill:\*\* not run/);
  assert.match(header, /couldn't \(fully\) read:\*\* no backfill run yet/);
  const noActivity = embedOf(post('No activity recorded'));
  assert.match(noActivity.description, /new-quiet/);
  assert.doesNotMatch(noActivity.description, /talker|too-new|robot/);
  const before = embedOf(post('Joined before tracking'));
  assert.match(before.title, /Unknown/);
  assert.match(before.description, /old-quiet/);
  assert.doesNotMatch(before.description, /voicer/);
});

test('the days option moves the limit', async () => {
  fakes.members = [member('three-days', { joined: 3 })];
  await run({ days: 2 });
  assert.match(allText(), /three-days/);
});

test('after a finished backfill, earlier joiners have no messages or commands found, even if a later run stopped', async () => {
  fakes.members = [member('old-quiet', { joined: 100 })];
  activity.updateActivityState({ lastFinished: { finishedAt: ago(1), unreachableCount: 4 }, backfill: { status: 'stopped', unreachable: [] } });
  await run();
  assert.match(embedOf(post('Joined before tracking')).title, /No messages or commands found/);
  const header = embedOf(post('Quiet Members')).description;
  assert.match(header, /finished .* \(a later run is stopped\)/);
  assert.match(header, /couldn't \(fully\) read:\*\* 4$/m);
});

test('before any finished backfill, the count includes failed channels and says it is partial', async () => {
  fakes.members = [member('a', { joined: 100 })];
  const entry = id => ({ id, name: id ?? 'Run', reason: 'error' });
  activity.updateActivityState({ backfill: { status: 'incomplete', unreachable: [entry('x'), entry('x')], failed: [entry('y'), entry(null)] } });
  await run();
  assert.match(embedOf(post('Quiet Members')).description, /couldn't \(fully\) read:\*\* 2 so far \(the run isn’t finished/);
});

test('activity before a rejoin does not count, and rejoins and unaccepted rules are marked', async () => {
  fakes.members = [member('back', { joined: 10, pending: true })];
  fakes.joins.set('back', 2);
  await active('back', 50);
  await run();
  assert.match(allText(), /back\*\*.*🔁 rejoined · 📜 rules not accepted/);
});

test('with nobody quiet, only the header is posted', async () => {
  fakes.members = [member('talker', { joined: 10 })];
  await active('talker', 1);
  await run();
  assert.equal(fakes.posts.size, 1);
  assert.match(allText(), /Nobody is quiet/);
});

test('a partial member list posts no report, tells the person and alerts the admin log', async () => {
  fakes.members = [member('a')];
  fakes.memberCount = 10;
  const i = await run();
  assert.match(i.sent.edits.at(-1), /only 1 of 10 members/);
  assert.equal(fakes.posts.size, 1);
  assert.match(posts()[0].embeds[0].toJSON().title, /\/quietmembers failed/);
  assert.ok(i.commandError);
});

test('when Discord limits the member request, a complete cached list is used, a partial one is refused', async () => {
  const { GatewayRateLimitError } = require('discord.js');
  const guild = size => ({
    memberCount: 10,
    members: {
      fetch: async () => { throw new GatewayRateLimitError({ opcode: 8, retry_after: 30, meta: {} }, {}); },
      cache: new Map(Array.from({ length: size }, (_, i) => [i, member(`c${i}`)])),
    },
  });
  assert.equal((await activity.fetchAllMembers(guild(10))).length, 10);
  await assert.rejects(activity.fetchAllMembers(guild(2)), /only 2 of 10/);
  const broken = { members: { fetch: async () => { throw new Error('other'); } } };
  await assert.rejects(activity.fetchAllMembers(broken), /other/);
});

test('outside the admin log the reply is a private link; inside it the post is the reply', async () => {
  fakes.members = [member('a', { joined: 10 })];
  const outside = await run();
  assert.ok(outside.sent.deferred.flags);
  assert.match(outside.sent.edits.at(-1), /discord\.com\/channels\/clan\/adminlog\/\d+/);

  fakes.posts.clear();
  fakes.files.delete('quietmembers.json');
  const inside = await run({ channelId: 'adminlog' });
  assert.deepEqual(inside.sent.deferred, {});
  assert.equal(inside.sent.edits.length, 1);
  assert.equal(inside.sent.edits[0].embeds[0].toJSON().title, '🤫 Quiet Members');
  assert.deepEqual(inside.sent.edits[0].allowedMentions, { parse: [] });
});

test('a new report replaces the previous one', async () => {
  fakes.members = [member('a', { joined: 10 })];
  await run();
  const first = [...fakes.posts.keys()];
  await run();
  assert.equal(fakes.posts.size, 2);
  assert.ok(first.every(id => !fakes.posts.has(id)));
  assert.ok(fakes.posts.has(fakes.files.get('quietmembers.json').list.header));
});

test('lists page 15 at a time, and both exports send a spreadsheet', async () => {
  fakes.members = Array.from({ length: 20 }, (_, i) => member(`m${String(i).padStart(2, '0')}`, { joined: 15 - i / 10 }));
  await run();
  const listId = idOf('No activity recorded');
  assert.match(embedOf(fakes.posts.get(listId)).footer.text, /Page 1\/2 · 20 members/);

  const next = button(fakes, 'quietmembers:next:noActivity', listId);
  await command.handleQuietMembersButton(next);
  assert.match(next.sent.updates[0].embeds[0].toJSON().description, /^\*\*16\.\*\* \*\*m15/);

  for (const [customId, id, suffix] of [
    ['quietmembers:export:noActivity', listId, '-no-activity.xlsx'],
    ['quietmembers:export', idOf('Quiet Members'), '.xlsx'],
  ]) {
    const press = button(fakes, customId, id);
    await command.handleQuietMembersButton(press);
    assert.ok(press.sent.replies[0].files[0].name.endsWith(suffix));
    assert.ok(press.sent.replies[0].flags);
  }
  assert.equal(saved.length, 2);
});

test('Update edits in place, and reposts when a list empties', async () => {
  fakes.members = [member('new', { joined: 10 }), member('old', { joined: 100 })];
  await run();
  const before = [...fakes.posts.keys()];
  const header = before[0];

  await command.handleQuietMembersButton(button(fakes, 'quietmembers:update:7', header));
  assert.deepEqual([...fakes.posts.keys()], before);

  await active('old', 0);
  await command.handleQuietMembersButton(button(fakes, 'quietmembers:update:7', header));
  assert.equal(fakes.posts.size, 2);
  assert.ok(!fakes.posts.has(header));
  assert.doesNotMatch(allText(), /\*\*old\*\*/);
});

test('Update posts the report again if a list message was deleted', async () => {
  fakes.members = [member('new', { joined: 10 }), member('old', { joined: 100 })];
  await run();
  const [header, kept, deleted] = [...fakes.posts.keys()];
  fakes.posts.delete(deleted);

  const press = button(fakes, 'quietmembers:update:7', header);
  await command.handleQuietMembersButton(press);
  assert.deepEqual(press.sent.followUps, []);
  assert.equal(fakes.posts.size, 3);
  assert.ok(![header, kept].some(id => fakes.posts.has(id)), 'the old messages are gone');
  assert.match(allText(), /\*\*old\*\*/);
  assert.ok(fakes.posts.has(fakes.files.get('quietmembers.json').list.header));
});

test('Update on a deleted report posts nothing', async () => {
  fakes.members = [member('new', { joined: 10 })];
  await run();
  const [header] = [...fakes.posts.keys()];
  fakes.posts.delete(header);
  const press = button(fakes, 'quietmembers:update:7', header);
  await command.handleQuietMembersButton(press);
  assert.match(press.sent.followUps[0].content, /deleted or replaced/);
  assert.equal(fakes.posts.size, 1);
});

test('buttons need the Templar role', async () => {
  fakes.members = [member('a', { joined: 10 })];
  await run();
  const press = button(fakes, 'quietmembers:export', idOf('Quiet Members'), { roles: ['owner'] });
  await command.handleQuietMembersButton(press);
  assert.match(press.sent.replies[0].content, /Templar role/);
});

test('after a restart, pages and exports say the list expired and Update still works', async () => {
  fakes.members = [member('a', { joined: 10 })];
  await run();
  // A fresh copy of the command has no lists in memory, as after a restart.
  delete require.cache[require.resolve('../src/commands/quietmembers.js')];
  const restarted = require('../src/commands/quietmembers.js');
  const listId = idOf('No activity recorded');

  const press = button(fakes, 'quietmembers:next:noActivity', listId);
  await restarted.handleQuietMembersButton(press);
  assert.match(press.sent.replies[0].content, /expired/);

  fakes.members.push(member('b', { joined: 9 }));
  await restarted.handleQuietMembersButton(button(fakes, 'quietmembers:update:7', idOf('Quiet Members')));
  assert.match(allText(), /\*\*b\*\*/);
});
