import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkHealth } = require('../src/healthcheck.js');
const script = path.join(import.meta.dirname, '..', 'src', 'healthcheck.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanglebot-health-'));
function file(name, data) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}
const NOW = Date.parse('2026-11-27T12:00:00Z');
const at = secondsAgo => new Date(NOW - secondsAgo * 1000).toISOString();

test('a fresh ok file is healthy', () => {
  const r = checkHealth({ file: file('ok.json', { checkedAt: at(30), database: 'ok' }), now: NOW, intervalSeconds: 60 });
  assert.equal(r.ok, true);
});

test('a file older than 3 intervals is unhealthy', () => {
  const r = checkHealth({ file: file('stale.json', { checkedAt: at(181), database: 'ok' }), now: NOW, intervalSeconds: 60 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /181s ago/);
});

test('a database that is down is unhealthy', () => {
  const r = checkHealth({ file: file('down.json', { checkedAt: at(10), database: 'down', lastError: 'Connection refused' }), now: NOW, intervalSeconds: 60 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Connection refused/);
});

test('a missing file is unhealthy', () => {
  const r = checkHealth({ file: path.join(dir, 'missing.json'), now: NOW, intervalSeconds: 60 });
  assert.equal(r.ok, false);
});

test('not configured is healthy, and a monitor set to 0 is always healthy', () => {
  assert.equal(checkHealth({ file: file('nc.json', { checkedAt: at(5), database: 'not configured' }), now: NOW, intervalSeconds: 60 }).ok, true);
  assert.equal(checkHealth({ file: path.join(dir, 'missing.json'), now: NOW, intervalSeconds: 0 }).ok, true);
});

test('the script exits 0 when healthy and 1 when not', () => {
  const env = { ...process.env, DB_HEALTH_CHECK_SECONDS: '60' };
  const fresh = file('fresh.json', { checkedAt: new Date().toISOString(), database: 'ok' });
  assert.equal(spawnSync(process.execPath, [script, fresh], { env }).status, 0);
  assert.equal(spawnSync(process.execPath, [script, path.join(dir, 'missing.json')], { env }).status, 1);
});
