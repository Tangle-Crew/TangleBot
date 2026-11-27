import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRateLimiter } = require('../src/utils/wiseOldMan.js');

// A limiter on a fake clock: wait() moves the clock forward instead of sleeping.
function setup(limit) {
  const t = { now: 0, waits: [] };
  const take = createRateLimiter({ limit, windowMs: 60_000, now: () => t.now, wait: async ms => { t.waits.push(ms); t.now += ms; } });
  return { t, take };
}

test('calls under the limit start straight away', async () => {
  const { t, take } = setup(3);
  for (let i = 0; i < 3; i++) await take();
  assert.deepEqual(t.waits, []);
});

test('a call over the limit waits until the oldest is a minute old', async () => {
  const { t, take } = setup(2);
  await take();
  t.now = 10_000;
  await take();
  t.now = 20_000;
  await take();
  assert.deepEqual(t.waits, [40_000]);
  assert.equal(t.now, 60_000);
});

test('callers from different features share the limit, in order', async () => {
  const { t, take } = setup(2);
  const order = [];
  await Promise.all(['sync', 'announce', 'stats'].map(name => take().then(() => order.push([name, t.now]))));
  assert.deepEqual(order, [['sync', 0], ['announce', 0], ['stats', 60_000]]);
});
