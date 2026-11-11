import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);
// The event handler loads modules that need a native canvas binding; stub it.
const canvasPath = require.resolve('@napi-rs/canvas');
require.cache[canvasPath] = { id: canvasPath, filename: canvasPath, loaded: true, exports: {} };
const { buildEntry, writeEntry, logCommand } = require('../src/utils/commandLog.js');
const { runCommand } = require('../src/handlers/eventHandler.js');

// ApplicationCommandOptionType: Subcommand 1, String 3, User 6.
const interaction = (over = {}) => ({
  commandName: 'donationhighscore',
  user: { id: '999', tag: 'staff' },
  channelId: 'chan1',
  options: {
    data: [{ name: 'add', type: 1, options: [
      { name: 'player', type: 6, value: '123456789012345678' },
      { name: 'amount', type: 3, value: '10m' },
    ] }],
  },
  ...over,
});

test('an entry has who, what (command, subcommand, options), where, status and time', () => {
  const entry = buildEntry(interaction(), { startedAt: Date.now() - 5 });
  assert.equal(entry.discordId, '999');
  assert.equal(entry.command, 'donationhighscore add');
  assert.deepEqual(entry.options, { player: '123456789012345678', amount: '10m' });
  assert.equal(entry.status, 'ok');
  assert.equal(entry.error, null);
  assert.equal(entry.channelId, 'chan1');
  assert.ok(entry.durationMs >= 5);
  assert.ok(entry.createdAt instanceof Date);
});

test('subcommand groups are part of the command name and long text is cut', () => {
  const entry = buildEntry(interaction({
    commandName: 'x',
    options: { data: [{ name: 'grp', type: 2, options: [{ name: 'sub', type: 1, options: [{ name: 'text', type: 3, value: 'a'.repeat(500) }] }] }] },
  }), { startedAt: Date.now() });
  assert.equal(entry.command, 'x grp sub');
  assert.equal(entry.options.text.length, 200);
});

test('an error makes the entry a failure with its message', () => {
  const entry = buildEntry(interaction(), { startedAt: Date.now(), error: new Error('boom') });
  assert.equal(entry.status, 'error');
  assert.equal(entry.error, 'boom');
  assert.equal(buildEntry(interaction(), { startedAt: Date.now(), error: 'Command is not loaded' }).error, 'Command is not loaded');
});

test('with the database an entry is one insert into command_log', async () => {
  const db = mockPg();
  const entry = buildEntry(interaction(), { startedAt: Date.now() });
  await writeEntry(entry, { useDatabase: true, getDb: () => db.pool });
  const [call] = db.find(/insert into command_log/);
  assert.equal(call.params[0], '999');
  assert.equal(call.params[1], 'donationhighscore add');
  assert.equal(call.params[2], JSON.stringify(entry.options));
  assert.equal(call.params[3], 'ok');
});

test('without the database an entry is appended to data/command-log.jsonl', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdlog-'));
  await writeEntry(buildEntry(interaction(), { startedAt: Date.now() }), { useDatabase: false, dir });
  await writeEntry(buildEntry(interaction(), { startedAt: Date.now(), error: 'nope' }), { useDatabase: false, dir });
  const lines = fs.readFileSync(path.join(dir, 'command-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => [l.discordId, l.command, l.status]), [['999', 'donationhighscore add', 'ok'], ['999', 'donationhighscore add', 'error']]);
  fs.rmSync(dir, { recursive: true });
});

test('a logging failure is swallowed', async () => {
  const db = { query: async () => { throw new Error('db down'); } };
  await logCommand(interaction(), { startedAt: Date.now() }, { useDatabase: true, getDb: () => db });
});

test('runCommand logs a command that ran, one that threw, and one that reported its own error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdlog-'));
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  // The file goes to data/ by default, so point logCommand's file writes at the temp dir.
  const original = fs.appendFileSync;
  const lines = [];
  fs.appendFileSync = (file, text) => { if (String(file).endsWith('command-log.jsonl')) lines.push(JSON.parse(text)); else original(file, text); };
  const replies = [];
  const withReplies = i => ({ ...i, replied: false, deferred: false, reply: async r => { replies.push(r); } });
  try {
    await runCommand(withReplies(interaction()), { execute: async () => {} });
    await runCommand(withReplies(interaction()), { execute: async () => { throw new Error('exploded'); } });
    const selfHandled = withReplies(interaction());
    await runCommand(selfHandled, { execute: async i => { i.commandError = new Error('sheet unreachable'); } });
  } finally {
    fs.appendFileSync = original;
    if (saved !== undefined) process.env.DATABASE_URL = saved;
    fs.rmSync(dir, { recursive: true });
  }
  assert.deepEqual(lines.map(l => [l.status, l.error]), [['ok', null], ['error', 'exploded'], ['error', 'sheet unreachable']]);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /Something went wrong/);
});

test('options that may hold a secret are not stored', () => {
  const entry = buildEntry(interaction({
    options: { data: [{ name: 'setintakeurl', type: 1, options: [{ name: 'url', type: 3, value: 'https://x.example/f?token=abc' }] }] },
  }), { startedAt: Date.now() });
  assert.deepEqual(entry.options, { url: '[not stored]' });
});
