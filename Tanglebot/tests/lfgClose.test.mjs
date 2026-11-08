import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { finishGroupThread, recordFinishedGroup } = require('../src/utils/lfgPost.js');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfg-history-'));
  process.env.LFG_HISTORY_DIR = dir;
  process.env.ADMIN_LOG_CHANNEL_ID = 'admin';
  delete process.env.LFG_LOG_CHANNEL_ID;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.LFG_HISTORY_DIR;
  delete process.env.ADMIN_LOG_CHANNEL_ID;
  delete process.env.LFG_LOG_CHANNEL_ID;
});

function makeGroup(over = {}) {
  return {
    id: 'g1', roleLabel: 'Bosses: Yama', sizeLabel: '5 Players', timeEpoch: 1800000000, threadId: 't1',
    creatorId: 'u1', members: new Set(['u1']), participants: new Set(['u1', 'u2']), createdAt: 1700000000000,
    closeReason: null, ...over,
  };
}

// Records calls in order; a step named in `failing` throws the given error.
function makeThread(calls, failing = {}) {
  const step = (name, result) => async (...args) => {
    calls.push(name);
    if (failing[name]) throw failing[name];
    return result ?? args;
  };
  return {
    id: 't1',
    messages: { edit: step('buttons') },
    setName: failing.rename === 'hang' ? () => { calls.push('rename'); return new Promise(() => {}); } : step('rename'),
    setLocked: step('lock'),
    setArchived: step('archive'),
  };
}

function makeClient(posted) {
  return { channels: { fetch: async (id) => ({ send: async (m) => { posted.push({ id, ...m }); } }) } };
}

const history = () => fs.readFileSync(path.join(dir, 'lfg-history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('closing removes buttons, records, then renames, locks and archives in that order', async () => {
  const calls = [];
  const posted = [];
  const client = makeClient(posted);
  const thread = makeThread(calls);
  await finishGroupThread(client, thread, makeGroup({ closeReason: 'disbanded' }));
  assert.deepEqual(calls, ['buttons', 'rename', 'lock', 'archive']);
  const [record] = history();
  assert.equal(record.reason, 'disbanded');
  assert.deepEqual(record.participantIds, ['u1', 'u2']);
  assert.equal(posted.length, 1);
  assert.match(posted[0].embeds[0].data.description, /was disbanded/);
});

test('an empty group with no close reason is recorded as empty with its past participants', async () => {
  await recordFinishedGroup(makeClient([]), makeGroup({ members: new Set() }));
  const [record] = history();
  assert.equal(record.reason, 'empty');
  assert.deepEqual(record.memberIds, []);
  assert.deepEqual(record.participantIds, ['u1', 'u2']);
});

test('a lock failure still archives and records, and tells the admins', async () => {
  const calls = [];
  const posted = [];
  const thread = makeThread(calls, { lock: new Error('Missing Permissions') });
  await finishGroupThread(makeClient(posted), thread, makeGroup());
  assert.deepEqual(calls, ['buttons', 'rename', 'lock', 'archive']);
  assert.equal(history().length, 1);
  const alert = posted.find((p) => p.embeds[0].data.title.includes('Incomplete'));
  assert.ok(alert);
  assert.match(alert.embeds[0].data.description, /lock: Missing Permissions/);
});

test('a rename stuck on a rate limit is given up on and the thread is still archived', async () => {
  const calls = [];
  const thread = makeThread(calls, { rename: 'hang' });
  await finishGroupThread(makeClient([]), thread, makeGroup(), { renameWaitMs: 20 });
  assert.deepEqual(calls, ['buttons', 'rename', 'lock', 'archive']);
});

test('a thread that is already gone raises no alert', async () => {
  const gone = Object.assign(new Error('Unknown Channel'), { code: 10003 });
  const posted = [];
  const thread = makeThread([], { buttons: gone, lock: gone, archive: gone });
  await finishGroupThread(makeClient(posted), thread, makeGroup());
  assert.equal(posted.filter((p) => p.embeds[0].data.title.includes('Incomplete')).length, 0);
});

test('the closed-group line goes to LFG_LOG_CHANNEL_ID when set, else the admin log', async () => {
  const posted = [];
  process.env.LFG_LOG_CHANNEL_ID = 'lfglog';
  await recordFinishedGroup(makeClient(posted), makeGroup());
  assert.equal(posted[0].id, 'lfglog');
  delete process.env.LFG_LOG_CHANNEL_ID;
  await recordFinishedGroup(makeClient(posted), makeGroup());
  assert.equal(posted[1].id, 'admin');
});
