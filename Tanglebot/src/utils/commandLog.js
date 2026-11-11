const fs = require('fs');
const path = require('path');
const { ApplicationCommandOptionType } = require('discord.js');
const database = require('./database');
const { databaseConfigured } = require('./commandAvailability');
const { DATA_DIR } = require('./db');

const MAX_VALUE_CHARS = 200;
const MAX_ERROR_CHARS = 500;
const LOG_FILE = 'command-log.jsonl';

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

// The row for one command run. error is the thrown error or message when it failed.
function buildEntry(interaction, { startedAt, error = null }) {
  const { names, values } = readOptions(interaction.options?.data);
  return {
    discordId: interaction.user.id,
    command: [interaction.commandName, ...names].join(' '),
    options: values,
    status: error ? 'error' : 'ok',
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
      `insert into command_log (discord_id, command, options, status, error, duration_ms, channel_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entry.discordId, entry.command, JSON.stringify(entry.options), entry.status, entry.error, entry.durationMs, entry.channelId, entry.createdAt]
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

module.exports = { logCommand, buildEntry, writeEntry };
