import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sendStartupAlert, startupReason } = require('../src/utils/startupAlert.js');

const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanglebot-startup-'));
  const t = { now: Date.parse('2026-11-27T12:00:00Z'), sent: [] };
  const opts = {
    token: 'x', channelId: '1', ownerRoleId: '42', file: path.join(dir, 'startup-alert.json'),
    now: () => t.now, send: async body => { t.sent.push(body); },
  };
  return { t, opts };
}

test('the startup alert is sent at most once an hour', async () => {
  const { t, opts } = setup();
  assert.equal(await sendStartupAlert(refused, opts), true);
  t.now += 59 * 60_000;
  assert.equal(await sendStartupAlert(refused, opts), false);
  t.now += 60_000;
  assert.equal(await sendStartupAlert(refused, opts), true);
  assert.equal(t.sent.length, 2);
  assert.match(t.sent[0].content, /^<@&42> ⚠️ \*\*Bot did not start:\*\* the database is unreachable\. Connection refused/);
  assert.deepEqual(t.sent[0].allowed_mentions, { roles: ['42'] });
});

test('a failed send is only logged and is tried again on the next start', async () => {
  const { t, opts } = setup();
  assert.equal(await sendStartupAlert(refused, { ...opts, send: async () => { throw new Error('Discord down'); } }), false);
  assert.equal(await sendStartupAlert(refused, opts), true);
  assert.equal(t.sent.length, 1);
});

test('nothing is sent without a token or an admin log channel', async () => {
  const { t, opts } = setup();
  assert.equal(await sendStartupAlert(refused, { ...opts, channelId: '' }), false);
  assert.equal(t.sent.length, 0);
});

test('the reason names a failed migration file or the connection error', () => {
  assert.match(startupReason(new Error('Migration 011_x.sql failed: syntax error')), /^a migration file failed\. Migration 011_x\.sql failed/);
  assert.match(startupReason(Object.assign(new Error('x'), { code: '28P01' })), /^the database is unreachable\. Login failed/);
});
