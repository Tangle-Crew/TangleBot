// Checks the database on a timer, alerts the admin log when it stays unreachable and when it is back,
// and writes data/health.json for the Docker health check.
const fs = require('fs');
const path = require('path');
const database = require('./database');
const { databaseConfigured } = require('./commandAvailability');
const { DATA_DIR, withTimeout, discordTimestamp } = require('./db');
const { connectionTarget } = require('./dbStatus');

const CHECK_TIMEOUT_MS = 5000;
const CHECK_NOW_MIN_GAP_MS = 10_000;
const DOWN_COLOR = 0xed4245;
const RECOVERED_COLOR = 0x2e7d32;
const HEALTH_FILE = 'health.json';
const AFFECTED = '/donationhighscore, /pethighscore, /refreshboards, /history, /profile, /commandlog, /memberdata and the automatic WOM sync, and the command log';

// Plain words for each known error code.
const CODE_TEXT = {
  ECONNREFUSED: 'Connection refused: nothing is accepting connections at the database address (is the database container running?)',
  ENOTFOUND: 'Host not found: the database host name does not resolve',
  EAI_AGAIN: 'Host not found: the database host name does not resolve',
  ETIMEDOUT: 'Timed out: the database did not answer in time',
  ECONNRESET: 'Connection reset: the database closed the connection',
  '28P01': 'Login failed: wrong user or password',
  '28000': 'Login failed: this user is not allowed to connect',
  '3D000': 'Database missing: the database named in DATABASE_URL does not exist',
  '53300': 'Too many connections: the database refused a new connection',
  '57P01': 'The database is shutting down',
  '57P02': 'The database is shutting down',
  '57P03': 'The database is starting up and not accepting connections yet',
};
const TIMEOUT_MESSAGE = /timed out|timeout exceeded|connection timeout/i;
const CONNECTION_MESSAGE = /connection terminated|Connection ended unexpectedly/i;

// The first known code on err, its causes, or the errors inside an AggregateError.
function errorCode(err, depth = 0) {
  if (!err || depth > 5) return null;
  if (err.code && CODE_TEXT[err.code]) return err.code;
  for (const inner of err.errors ?? []) {
    const code = errorCode(inner, depth + 1);
    if (code) return code;
  }
  return errorCode(err.cause, depth + 1);
}

function errorMessages(err, depth = 0) {
  if (!err || depth > 5) return '';
  return `${err.message ?? ''} ${errorMessages(err.cause, depth + 1)}`;
}

// A database error in plain words.
function describeDbError(err) {
  const code = errorCode(err);
  if (code) return CODE_TEXT[code];
  const text = errorMessages(err);
  if (TIMEOUT_MESSAGE.test(text)) return CODE_TEXT.ETIMEDOUT;
  if (CONNECTION_MESSAGE.test(text)) return CODE_TEXT.ECONNRESET;
  return err?.message ?? String(err);
}

// True for errors that mean the database can't be reached, not a bad query.
function isConnectionError(err) {
  if (!err) return false;
  if (errorCode(err)) return true;
  const text = errorMessages(err);
  return TIMEOUT_MESSAGE.test(text) || CONNECTION_MESSAGE.test(text);
}

// 75000 -> "1 min 15 s", 7200000 -> "2 h".
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [d && `${d} d`, h && `${h} h`, m && `${m} min`, !d && !h && s && `${s} s`].filter(Boolean);
  return parts.length ? parts.join(' ') : '0 s';
}

// The monitor's settings from the environment.
function healthSettings(env = process.env) {
  const read = (name, fallback) => {
    const value = parseInt(env[name] ?? '', 10);
    return Number.isNaN(value) || value < 0 ? fallback : value;
  };
  return {
    intervalSeconds: read('DB_HEALTH_CHECK_SECONDS', 60),
    failuresBeforeAlert: Math.max(1, read('DB_HEALTH_FAILURES_BEFORE_ALERT', 3)),
    reminderMinutes: read('DB_HEALTH_REMINDER_MINUTES', 60),
  };
}

// Writes data/health.json through a temp file, without the data file log line.
function writeHealthFile(data, dir = DATA_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, HEALTH_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

// One monitor. Every dependency can be replaced for tests.
function createMonitor({
  client = null,
  configured = databaseConfigured(),
  query = () => withTimeout(database.getPool().query('select 1'), 'Database check', CHECK_TIMEOUT_MS),
  notify = (...args) => require('./adminLog').notifyAdminLog(...args),
  writeHealth = writeHealthFile,
  now = () => Date.now(),
  settings = healthSettings(),
  target = connectionTarget(),
  ownerRoleId = process.env.OWNER_ROLE_ID,
} = {}) {
  const state = {
    status: configured ? null : 'not configured', // null until the first check
    failures: 0,
    lastCheckAt: null,
    lastOkAt: null,
    downSince: null,
    lastError: null,
    lastOutage: null,
    alerted: false,
    lastAlertAt: null,
    intervalSeconds: settings.intervalSeconds,
  };
  let running = null;
  let lastCheckNowAt = -Infinity;

  const ping = () => (ownerRoleId ? `<@&${ownerRoleId}>` : undefined);
  const where = target.database ? `${target.host}/${target.database}` : target.host;

  function downAlert(reminder) {
    const raw = state.lastError?.message;
    const plain = describeDbError(state.lastError);
    const errorText = raw && raw !== plain ? `${plain}\n\`${String(raw).slice(0, 300)}\`` : plain;
    const reminderText = settings.reminderMinutes > 0
      ? `This reminder repeats every ${settings.reminderMinutes} minutes while it stays down.`
      : 'No reminders will be sent while it stays down.';
    return notify(
      client,
      reminder ? '⚠️ Database still unreachable' : '⚠️ Database unreachable',
      `The bot cannot reach the database (${state.failures} failed checks in a row). It checks every ${settings.intervalSeconds} seconds. ${reminderText}`,
      [
        { name: 'Error', value: errorText.slice(0, 1024) },
        { name: 'Since', value: `${discordTimestamp(state.downSince, 'f')} (${discordTimestamp(state.downSince, 'R')})`, inline: true },
        { name: 'Database', value: `\`${where}\``, inline: true },
        { name: 'Not working until it is back', value: AFFECTED },
      ],
      DOWN_COLOR,
      [],
      ping()
    );
  }

  function healthData() {
    return {
      checkedAt: state.lastCheckAt ? new Date(state.lastCheckAt).toISOString() : new Date(now()).toISOString(),
      database: state.status ?? 'ok',
      downSince: state.downSince ? new Date(state.downSince).toISOString() : null,
      lastError: state.lastError ? describeDbError(state.lastError) : null,
    };
  }

  async function runCheck() {
    const at = now();
    state.lastCheckAt = at;
    if (!configured) return;
    try {
      await query();
      if (state.failures > 0) {
        state.lastOutage = { start: state.downSince, end: at, error: describeDbError(state.lastError) };
        console.log(`[DbHealth] Database reachable again after ${formatDuration(at - state.downSince)}`);
        if (state.alerted) {
          await notify(
            client,
            '✅ Database reachable again',
            `The database is answering again. It was unreachable for ${formatDuration(at - state.downSince)}, since ${discordTimestamp(state.downSince, 'f')}.`,
            [],
            RECOVERED_COLOR
          );
        }
      }
      Object.assign(state, { status: 'ok', failures: 0, lastOkAt: at, downSince: null, lastError: null, alerted: false, lastAlertAt: null });
    } catch (err) {
      state.failures += 1;
      if (state.failures === 1) state.downSince = at;
      state.status = 'down';
      state.lastError = err;
      console.error(`[DbHealth] Check failed (${state.failures} in a row): ${describeDbError(err)}`);
      if (!state.alerted && state.failures >= settings.failuresBeforeAlert) {
        state.alerted = true;
        state.lastAlertAt = at;
        await downAlert(false);
      } else if (state.alerted && settings.reminderMinutes > 0 && at - state.lastAlertAt >= settings.reminderMinutes * 60_000) {
        state.lastAlertAt = at;
        await downAlert(true);
      }
    }
  }

  // Runs one check, or joins the one already running. Never rejects.
  function check() {
    if (!running) {
      running = runCheck()
        .catch(err => console.error('[DbHealth] Check error:', err))
        .then(() => {
          try {
            writeHealth(healthData());
          } catch (err) {
            console.error('[DbHealth] Could not write health.json:', err.message);
          }
        })
        .finally(() => { running = null; });
    }
    return running;
  }

  // A check straight away, at most once every 10 seconds.
  function checkNow() {
    const at = now();
    if (running) return running;
    if (at - lastCheckNowAt < CHECK_NOW_MIN_GAP_MS) return Promise.resolve();
    lastCheckNowAt = at;
    return check();
  }

  function getState() {
    const { lastError, ...rest } = state;
    return { ...rest, lastError: lastError ? describeDbError(lastError) : null, failuresBeforeAlert: settings.failuresBeforeAlert };
  }

  return { check, checkNow, getState };
}

let monitor = null;

// Starts the timer. Returns a function that stops it. DB_HEALTH_CHECK_SECONDS=0 turns it off.
function start(client, deps = {}) {
  const settings = deps.settings ?? healthSettings();
  if (settings.intervalSeconds === 0) return () => {};
  monitor = createMonitor({ client, settings, ...deps });
  monitor.check();
  const timer = setInterval(() => monitor?.check(), settings.intervalSeconds * 1000);
  timer.unref();
  return () => {
    clearInterval(timer);
    monitor = null;
  };
}

// The running monitor's state, or null when it is not running.
function getState() {
  return monitor ? monitor.getState() : null;
}

// Asks the running monitor for a check now. Does nothing when it is not running.
function checkNow() {
  return monitor ? monitor.checkNow() : Promise.resolve();
}

module.exports = {
  start, getState, checkNow, createMonitor, healthSettings,
  describeDbError, isConnectionError, formatDuration, writeHealthFile, HEALTH_FILE,
};
