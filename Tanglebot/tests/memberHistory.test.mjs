import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Events } = require('discord.js');
const highScoresDb = require('../src/utils/highScoresDb.js');
const { registerMemberHistory, syncMemberRoster } = require('../src/utils/memberHistory.js');

let saved;
let recorded;
beforeEach(() => {
  saved = { ...highScoresDb };
  recorded = [];
  process.env.DATABASE_URL = 'postgres://u:p@host:5432/db';
  process.env.CLAN_ID = 'guild1';
  for (const name of ['recordJoin', 'recordLeave', 'recordNameChange', 'syncRoster']) {
    highScoresDb[name] = async arg => { recorded.push([name, arg]); return { members: 0, left: 0 }; };
  }
});
afterEach(() => {
  Object.assign(highScoresDb, saved);
  delete process.env.DATABASE_URL;
  delete process.env.CLAN_ID;
});

const member = (over = {}) => ({
  id: '42', displayName: 'Snow', joinedAt: new Date('2025-02-02T00:00:00Z'), guild: { id: 'guild1' }, user: { bot: false }, partial: false, ...over,
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('joins, leaves and name changes are recorded', async () => {
  const client = new EventEmitter();
  registerMemberHistory(client);

  client.emit(Events.GuildMemberAdd, member());
  client.emit(Events.GuildMemberRemove, member());
  client.emit(Events.GuildMemberUpdate, member({ displayName: 'Old' }), member({ displayName: 'New' }));
  await tick();

  assert.deepEqual(recorded, [
    ['recordJoin', { discordId: '42', displayName: 'Snow', joinedAt: new Date('2025-02-02T00:00:00Z') }],
    ['recordLeave', { discordId: '42' }],
    ['recordNameChange', { discordId: '42', displayName: 'New', joinedAt: new Date('2025-02-02T00:00:00Z') }],
  ]);
});

test('role-only updates, partial members, bots and other servers are ignored', async () => {
  const client = new EventEmitter();
  registerMemberHistory(client);

  client.emit(Events.GuildMemberUpdate, member(), member());
  client.emit(Events.GuildMemberUpdate, member({ partial: true, displayName: undefined }), member({ displayName: 'New' }));
  client.emit(Events.GuildMemberAdd, member({ user: { bot: true } }));
  client.emit(Events.GuildMemberAdd, member({ guild: { id: 'other' } }));
  await tick();
  assert.deepEqual(recorded, []);
});

test('nothing is recorded without DATABASE_URL', async () => {
  delete process.env.DATABASE_URL;
  const client = new EventEmitter();
  registerMemberHistory(client);
  client.emit(Events.GuildMemberAdd, member());
  await syncMemberRoster({});
  await tick();
  assert.deepEqual(recorded, []);
});

test('the startup sync sends every non-bot member, and a database failure does not throw', async () => {
  const members = new Map([
    ['1', member({ id: '1', displayName: 'A' })],
    ['2', member({ id: '2', displayName: 'Bot', user: { bot: true } })],
  ]);
  const client = { guilds: { fetch: async () => ({ members: { fetch: async () => members } }) } };
  await syncMemberRoster(client);
  assert.deepEqual(recorded, [['syncRoster', [{ discordId: '1', displayName: 'A', joinedAt: new Date('2025-02-02T00:00:00Z') }]]]);

  highScoresDb.syncRoster = async () => { throw new Error('db down'); };
  await syncMemberRoster(client);
});

test('a partial member fetch does not run the sync', async () => {
  const members = new Map([['1', member({ id: '1', displayName: 'A' })]]);
  const client = { guilds: { fetch: async () => ({ memberCount: 100, members: { fetch: async () => members } }) } };
  await syncMemberRoster(client);
  assert.deepEqual(recorded, []);
});
