const fs = require('fs');
const path = require('path');
const { ApplicationCommandOptionType } = require('discord.js');
const database = require('./database');
const { databaseConfigured } = require('./commandAvailability');
const { DATA_DIR, intEnv } = require('./db');

const MAX_VALUE_CHARS = 200;
const MAX_ERROR_CHARS = 500;
const LOG_FILE = 'command-log.jsonl';
const STATUSES = ['ok', 'error', 'denied'];
const DAY_MS = 24 * 60 * 60 * 1000;

// Options that may hold a secret are not stored.
const SECRET_OPTION = /url|token|secret|key|password/i;

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Collects a command's subcommand names and option values from interaction.options.data.
function readOptions(data = [], names = [], values = {}) {
  for (const option of data) {
    if (
      option.type === ApplicationCommandOptionType.Subcommand ||
      option.type === ApplicationCommandOptionType.SubcommandGroup
    ) {
      names.push(option.name);
      readOptions(option.options, names, values);
    } else if (option.value !== undefined) {
      if (SECRET_OPTION.test(option.name)) values[option.name] = '[not stored]';
      else values[option.name] = typeof option.value === 'string' ? cut(option.value, MAX_VALUE_CHARS) : option.value;
    }
  }
  return { names, values };
}

// The row for one command run. error is the thrown error or message when it failed; denied means
// the person lacked the role for it.
function buildEntry(interaction, { startedAt, error = null, denied = false }) {
  const { names, values } = readOptions(interaction.options?.data);
  return {
    discordId: interaction.user.id,
    // The server display name, or the account name when it isn't available.
    discordName: interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username ?? null,
    command: [interaction.commandName, ...names].join(' '),
    options: values,
    status: error ? 'error' : denied ? 'denied' : 'ok',
    error: error ? cut(String(error.message ?? error), MAX_ERROR_CHARS) : null,
    durationMs: Date.now() - startedAt,
    channelId: interaction.channelId ?? null,
    createdAt: new Date(),
  };
}

// Saves the entry to the database, or to data/command-log.jsonl when DATABASE_URL is unset.
async function writeEntry(entry, { useDatabase = databaseConfigured(), getDb = () => database.getPool(), dir = DATA_DIR } = {}) {
  if (useDatabase) {
    await getDb().query(
      `insert into command_log (discord_id, discord_name, command, options, status, error, duration_ms, channel_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [entry.discordId, entry.discordName, entry.command, JSON.stringify(entry.options), entry.status, entry.error, entry.durationMs, entry.channelId, entry.createdAt]
    );
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, LOG_FILE), `${JSON.stringify(entry)}\n`, 'utf8');
}

// Records a command run. Never throws, so logging can't break a command.
async function logCommand(interaction, outcome, deps) {
  try {
    await writeEntry(buildEntry(interaction, outcome), deps);
  } catch (err) {
    console.error('[CommandLog] Failed to record a command run:', err.message);
  }
}

// A page of the log, newest first, plus how many rows match. Filters: discordId, command (starts
// with, e.g. "migration" matches "migration import"), status.
async function queryLog({ discordId = null, command = null, status = null, limit = 10, offset = 0 } = {}, db = database.getPool()) {
  const where = [];
  const params = [];
  if (discordId) { params.push(discordId); where.push(`discord_id = $${params.length}`); }
  if (command) { params.push(`${command.replace(/[\\%_]/g, '\\$&')}%`); where.push(`command ilike $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  const clause = where.length ? `where ${where.join(' and ')}` : '';

  const total = Number((await db.query(`select count(*) as n from command_log ${clause}`, params)).rows[0].n);
  const { rows } = await db.query(
    `select id, discord_id, discord_name, command, options, status, error, duration_ms, created_at
     from command_log ${clause} order by id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { rows, total };
}

// Days of log to keep (COMMAND_LOG_RETENTION_DAYS, default 365). 0 keeps everything.
function retentionDays() {
  const days = intEnv('COMMAND_LOG_RETENTION_DAYS', 365);
  return days < 0 ? 365 : days;
}

// Deletes rows older than days. Returns how many were removed.
async function pruneCommandLog(days = retentionDays(), db = database.getPool()) {
  if (!(days > 0)) return 0;
  const result = await db.query('delete from command_log where created_at < now() - make_interval(days => $1)', [days]);
  return result.rowCount;
}

// Prunes now and then daily. Returns a function that stops it. Does nothing without the database.
function startCommandLogPrune() {
  if (!databaseConfigured()) return () => {};
  const run = async () => {
    try {
      const removed = await pruneCommandLog();
      if (removed) console.log(`[CommandLog] Removed ${removed} row(s) older than ${retentionDays()} days`);
    } catch (err) {
      console.error('[CommandLog] Failed to prune the command log:', err.message);
    }
  };
  run();
  const timer = setInterval(run, DAY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { logCommand, buildEntry, writeEntry, queryLog, pruneCommandLog, startCommandLogPrune, retentionDays, STATUSES };
