import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, DAY, ago, snowflake, message, voice } from './helpers/quietFakes.mjs';

const require = createRequire(import.meta.url);
// spinwheel needs a native canvas binding that is irrelevant here; stub it.
const canvasPath = require.resolve('@napi-rs/canvas');
require.cache[canvasPath] = { id: canvasPath, filename: canvasPath, loaded: true, exports: {} };
const fakes = setup();
const activity = require('../src/utils/memberActivity.js');
const { MessageType, InteractionType } = require('discord.js');

beforeEach(() => {
  fakes.reset();
  activity.resetThrottle();
});

const kindOf = m => activity.classifyMessage(m)?.kind ?? null;

test('a normal message and a reply count, a join notice and other system messages do not', () => {
  assert.equal(kindOf(message({ author: 'u1' })), 'message');
  assert.equal(kindOf(message({ author: 'u1', type: MessageType.Reply })), 'message');
  for (const type of [MessageType.UserJoin, MessageType.GuildBoost, MessageType.ChannelPinnedMessage]) {
    assert.equal(kindOf(message({ author: 'u1', type, system: true })), null);
  }
});

test("another bot's slash command reply counts for the person who ran it, a button reply does not", () => {
  const reply = type => message({ author: 'musicbot', bot: true, webhookId: 'app', interaction: { type, user: { id: 'u2', bot: false } } });
  const command = reply(InteractionType.ApplicationCommand);
  assert.deepEqual(activity.classifyMessage(command), { discordId: 'u2', kind: 'command', at: new Date(command.createdTimestamp) });
  assert.equal(kindOf(reply(InteractionType.MessageComponent)), null);
  assert.equal(kindOf(reply(InteractionType.ModalSubmit)), null);
  assert.equal(kindOf(message({ author: 'musicbot', bot: true })), null);
  assert.equal(kindOf(message({ author: 'hook', webhookId: 'w' })), null);
});

test('the honeypot channels and their threads never count', async () => {
  assert.equal(kindOf(message({ author: 'u1', channelId: 'trap' })), null);
  assert.equal(kindOf({ ...message({ author: 'u1', channelId: 'thread' }), channel: { parentId: 'trap' } }), null);
  await activity.handleVoiceState(voice('u1', null), voice('u1', 'trapvoice'));
  assert.equal(fakes.rows.size, 0);
});

test('commands run in a honeypot channel or its threads do not count, live or from the command log', async () => {
  const command = (id, channelId, parentId) => ({ guildId: 'clan', channelId, channel: { parentId }, user: { id, bot: false } });
  await activity.recordCommand(command('u1', 'trap', 'category'));
  await activity.recordCommand(command('u2', 'thread', 'trap'));
  assert.equal(fakes.rows.size, 0);
  await activity.recordCommand(command('u3', 'general', 'category'));
  fakes.commandLog = [
    { discordId: 'u4', channelId: 'trapvoice', at: new Date() },
    { discordId: 'u5', channelId: 'general', at: new Date() },
  ];
  await activity.copyCommandLog();
  assert.deepEqual([...fakes.rows.keys()].sort(), ['u3:command', 'u5:command']);
});

test('messages in another server or a DM are ignored', async () => {
  await activity.handleMessage(message({ author: 'u1', guildId: 'elsewhere' }));
  await activity.handleMessage(message({ author: 'u1', guildId: null }));
  assert.equal(fakes.rows.size, 0);
});

test('joining voice counts, moving, muting, leaving and bots do not', async () => {
  await activity.handleVoiceState(voice('u1', 'a'), voice('u1', 'b'));
  await activity.handleVoiceState(voice('u1', 'a'), voice('u1', 'a'));
  await activity.handleVoiceState(voice('u1', 'a'), voice('u1', null));
  await activity.handleVoiceState(voice('b1', null), voice('b1', 'a', { bot: true }));
  assert.equal(fakes.rows.size, 0);
  await activity.handleVoiceState(voice('u1', null), voice('u1', 'a'));
  assert.ok(fakes.rows.has('u1:voice'));
});

test('moving out of the trap voice channel into a normal one counts', async () => {
  await activity.handleVoiceState(voice('u1', 'trapvoice'), voice('u1', 'trapvoice'));
  await activity.handleVoiceState(voice('u1', 'trapvoice'), voice('u1', null));
  assert.equal(fakes.rows.size, 0);
  await activity.handleVoiceState(voice('u1', 'trapvoice'), voice('u1', 'general'));
  assert.ok(fakes.rows.has('u1:voice'));
});

test('saves keep the earliest and latest times, and one save can hold the same person twice', async () => {
  const at = days => new Date(ago(days));
  await activity.saveActivity([{ discordId: 'u1', kind: 'message', at: at(5) }, { discordId: 'u1', kind: 'message', at: at(9) }]);
  await activity.saveActivity([{ discordId: 'u1', kind: 'message', at: at(7) }]);
  await activity.saveActivity([{ discordId: 'u1', kind: 'message', at: at(1) }]);
  const row = fakes.rows.get('u1:message');
  assert.equal(Math.round((Date.now() - row.firstAt) / DAY), 9);
  assert.equal(Math.round((Date.now() - row.lastAt) / DAY), 1);
});

test('the first activity saves at once, then at most hourly, and a leave clears the limit', async () => {
  const now = Date.now();
  const inserts = () => fakes.pg.find(/insert into member_activity/).length;
  await activity.recordActivity('u1', 'message', new Date(), { now });
  await activity.recordActivity('u1', 'message', new Date(), { now: now + 1000 });
  assert.equal(inserts(), 1);
  await activity.recordActivity('u1', 'voice', new Date(), { now: now + 1000 });
  assert.equal(inserts(), 2);
  await activity.recordActivity('u1', 'message', new Date(), { now: now + activity.THROTTLE_MS });
  assert.equal(inserts(), 3);
  activity.forgetThrottle('u1');
  await activity.recordActivity('u1', 'message', new Date(), { now: now + activity.THROTTLE_MS + 1000 });
  assert.equal(inserts(), 4);
});

test('a failed save does not throw and is tried again next time', async () => {
  fakes.failDatabase = true;
  await activity.recordActivity('u1', 'message');
  fakes.failDatabase = false;
  await activity.recordActivity('u1', 'message');
  assert.ok(fakes.rows.has('u1:message'));
});

test('nothing is recorded without a database', async () => {
  const url = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await activity.recordActivity('u1', 'message');
    assert.equal(fakes.pg.calls.length, 0);
  } finally {
    process.env.DATABASE_URL = url;
  }
});

test('startup saves the tracking start once and records people already in voice', async () => {
  fakes.voiceStates.set('u1', { id: 'u1', channelId: 'a', member: { user: { bot: false } } });
  fakes.voiceStates.set('u2', { id: 'u2', channelId: 'trapvoice', member: { user: { bot: false } } });
  fakes.voiceStates.set('b1', { id: 'b1', channelId: 'a', member: { user: { bot: true } } });
  await activity.startTracking(fakes.client);
  const started = activity.readActivityState().trackingStartedAt;
  assert.ok(started);
  assert.deepEqual([...fakes.rows.keys()], ['u1:voice']);
  await activity.startTracking(fakes.client);
  assert.equal(activity.readActivityState().trackingStartedAt, started);
});

test('running a command on this bot counts as activity, even one that failed', async () => {
  const { runCommand } = require('../src/handlers/eventHandler.js');
  const interaction = {
    guildId: 'clan', channelId: 'c', commandName: 'x', user: { id: snowflake(), bot: false, tag: 't' }, options: { data: [] },
    reply: async () => {},
  };
  // The command log writes through the same fake pool and is ignored by it.
  await runCommand(interaction, { execute: async () => { throw new Error('boom'); } });
  assert.ok(fakes.rows.has(`${interaction.user.id}:command`));
});
