import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const health = require('../src/utils/dbHealth.js');

const refused = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });

// A monitor with a fake clock, query, notify and health file.
function setup({ failuresBeforeAlert = 3, reminderMinutes = 60, configured = true } = {}) {
  const t = { now: 1_000_000, fail: false, sent: [], written: [] };
  const monitor = health.createMonitor({
    configured,
    now: () => t.now,
    query: async () => { if (t.fail) throw refused(); },
    notify: async (_client, title, description, fields, color, components, content) => { t.sent.push({ title, description, fields, color, content }); },
    writeHealth: data => t.written.push(data),
    settings: { intervalSeconds: 60, failuresBeforeAlert, reminderMinutes },
    target: { host: 'tanglebot-db:5432', database: 'tanglebot' },
    ownerRoleId: '42',
  });
  const tick = async (minutes = 1) => { t.now += minutes * 60_000; await monitor.check(); };
  return { t, monitor, tick };
}

test('no alert below the threshold, then exactly one at it', async () => {
  const { t, tick } = setup();
  await tick();
  t.fail = true;
  await tick();
  await tick();
  assert.equal(t.sent.length, 0);
  await tick();
  assert.equal(t.sent.length, 1);
  const [alert] = t.sent;
  assert.equal(alert.title, '⚠️ Database unreachable');
  assert.equal(alert.content, '<@&42>');
  const fields = Object.fromEntries(alert.fields.map(f => [f.name, f.value]));
  assert.match(fields.Error, /Connection refused/);
  assert.equal(fields.Database, '`tanglebot-db:5432/tanglebot`');
  assert.match(fields['Not working until it is back'], /\/donationhighscore.*\/commandlog.*WOM sync/);
  await tick();
  assert.equal(t.sent.length, 1, 'no second alert straight after');
});

test('a reminder only after the reminder interval', async () => {
  const { t, tick } = setup({ reminderMinutes: 60 });
  t.fail = true;
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(t.sent.length, 1);
  for (let i = 0; i < 59; i++) await tick();
  assert.equal(t.sent.length, 1);
  await tick();
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[1].title, '⚠️ Database still unreachable');
});

test('no reminders when DB_HEALTH_REMINDER_MINUTES is 0', async () => {
  const { t, tick } = setup({ reminderMinutes: 0 });
  t.fail = true;
  for (let i = 0; i < 200; i++) await tick();
  assert.equal(t.sent.length, 1);
});

test('a recovery message only after an alert was sent, with how long it was down', async () => {
  const { t, monitor, tick } = setup();
  t.fail = true;
  for (let i = 0; i < 3; i++) await tick();
  t.fail = false;
  await tick();
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[1].title, '✅ Database reachable again');
  assert.match(t.sent[1].description, /unreachable for 3 min/);
  const state = monitor.getState();
  assert.equal(state.status, 'ok');
  assert.equal(state.lastOutage.end - state.lastOutage.start, 3 * 60_000);
});

test('recovering before the threshold sends nothing, but is kept as the last outage', async () => {
  const { t, monitor, tick } = setup();
  t.fail = true;
  await tick();
  await tick();
  t.fail = false;
  await tick();
  assert.equal(t.sent.length, 0);
  assert.ok(monitor.getState().lastOutage);
});

test('checkNow runs at most once every 10 seconds', async () => {
  let queries = 0;
  let now = 0;
  const monitor = health.createMonitor({
    configured: true, now: () => now, query: async () => { queries += 1; },
    notify: async () => {}, writeHealth: () => {}, settings: { intervalSeconds: 60, failuresBeforeAlert: 3, reminderMinutes: 60 },
  });
  await monitor.checkNow();
  now += 5000;
  await monitor.checkNow();
  assert.equal(queries, 1);
  now += 5000;
  await monitor.checkNow();
  assert.equal(queries, 2);
});

test('the module checkNow does nothing when no monitor is running', async () => {
  assert.equal(health.getState(), null);
  await health.checkNow();
});

test('health.json records the check time, the state and the error', async () => {
  const { t, tick } = setup();
  await tick();
  assert.deepEqual(t.written.at(-1), { checkedAt: new Date(t.now).toISOString(), database: 'ok', downSince: null, lastError: null });
  t.fail = true;
  await tick();
  const down = t.written.at(-1);
  assert.equal(down.database, 'down');
  assert.equal(down.downSince, new Date(t.now).toISOString());
  assert.match(down.lastError, /Connection refused/);
});

test('without DATABASE_URL nothing is queried and health.json says not configured', async () => {
  const { t, tick } = setup({ configured: false });
  t.fail = true;
  await tick();
  assert.equal(t.sent.length, 0);
  assert.equal(t.written.at(-1).database, 'not configured');
});

test('a hung query counts as a failure', async () => {
  const sent = [];
  const monitor = health.createMonitor({
    configured: true, now: () => Date.now(), notify: async (...a) => sent.push(a), writeHealth: () => {},
    query: () => require('../src/utils/db.js').withTimeout(new Promise(() => {}), 'Database check', 20),
    settings: { intervalSeconds: 60, failuresBeforeAlert: 1, reminderMinutes: 60 },
  });
  await monitor.check();
  assert.equal(monitor.getState().status, 'down');
  assert.match(monitor.getState().lastError, /Timed out/);
});

test('describeDbError and isConnectionError know each connection error', () => {
  const cases = {
    ECONNREFUSED: /Connection refused/, ENOTFOUND: /Host not found/, ETIMEDOUT: /Timed out/, ECONNRESET: /Connection reset/,
    '28P01': /Login failed/, '28000': /Login failed/, '3D000': /Database missing/, '53300': /Too many connections/,
    '57P01': /shutting down/, '57P02': /shutting down/, '57P03': /starting up/,
  };
  for (const [code, pattern] of Object.entries(cases)) {
    const err = Object.assign(new Error(`raw ${code}`), { code });
    assert.match(health.describeDbError(err), pattern, code);
    assert.equal(health.isConnectionError(err), true, code);
  }
  assert.match(health.describeDbError(new Error('timeout exceeded when trying to connect')), /Timed out/);
  assert.match(health.describeDbError(new Error('Connection terminated unexpectedly')), /Connection reset/);
  const aggregate = Object.assign(new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })], 'agg'));
  assert.match(health.describeDbError(aggregate), /Connection refused/);
  const wrapped = new Error('Saving failed', { cause: Object.assign(new Error('x'), { code: '53300' }) });
  assert.equal(health.isConnectionError(wrapped), true);

  const syntax = Object.assign(new Error('syntax error at or near "selec"'), { code: '42601' });
  assert.equal(health.describeDbError(syntax), 'syntax error at or near "selec"');
  assert.equal(health.isConnectionError(syntax), false);
  assert.equal(health.isConnectionError(null), false);
});

test('healthSettings reads the defaults and the overrides', () => {
  assert.deepEqual(health.healthSettings({}), { intervalSeconds: 60, failuresBeforeAlert: 3, reminderMinutes: 60 });
  assert.deepEqual(
    health.healthSettings({ DB_HEALTH_CHECK_SECONDS: '0', DB_HEALTH_FAILURES_BEFORE_ALERT: '5', DB_HEALTH_REMINDER_MINUTES: '0' }),
    { intervalSeconds: 0, failuresBeforeAlert: 5, reminderMinutes: 0 }
  );
  assert.equal(health.healthSettings({ DB_HEALTH_FAILURES_BEFORE_ALERT: '0' }).failuresBeforeAlert, 1);
});

test('start with the interval at 0 runs nothing', () => {
  const stop = health.start(null, { settings: { intervalSeconds: 0, failuresBeforeAlert: 3, reminderMinutes: 60 } });
  assert.equal(health.getState(), null);
  stop();
});

test('formatDuration', () => {
  assert.equal(health.formatDuration(45_000), '45 s');
  assert.equal(health.formatDuration(75_000), '1 min 15 s');
  assert.equal(health.formatDuration(2 * 3600_000 + 5 * 60_000), '2 h 5 min');
  assert.equal(health.formatDuration(0), '0 s');
});
