const fs = require('fs');
const path = require('path');
const db = require('./db');
const database = require('./database');
const { databaseConfigured } = require('./commandAvailability');

// Small pieces of bot state that used to live only in data/*.json. With DATABASE_URL set, each is
// also kept in the bot_state table, so a lost data volume doesn't lose it:
//   - At startup (hydrateState) the table is loaded into memory. A file that has no row yet is
//     copied into the table, and a row whose file is missing is written back to disk.
//   - readState then reads from memory, writeState writes the file as before and the table too.
// The file is still written on every change, so removing DATABASE_URL (the rollback) finds current
// files. Without DATABASE_URL both functions are exactly readJson and writeJson.
// Files that two bot instances share while one replaces the other (a deploy) are DISK_FIRST: they are
// always read from the file, as before, so each instance sees the other's changes, and the table is
// only a copy to restore from (see DATABASE.md).

const STATE_FILES = [
  'pethighscores_message.json',
  'donationhighscores_message.json',
  'stalemembers.json',
  'lfg-start-post.json',
  'honeypot-runtime-config.json',
  'submission-runtime-config.json',
  'last-submission.json',
  'lfg-groups.json',
  'weeklyannounce.json',
  'admin-commands-post.json',
];

// Always read from disk, never from memory.
const DISK_FIRST_FILES = new Set(['weeklyannounce.json']);

const cache = new Map();
const pending = new Set();
let hydrated = false;

const clone = value => JSON.parse(JSON.stringify(value));
const fileExists = file => fs.existsSync(path.join(db.DATA_DIR, file));

function upsert(pool, key, value) {
  return pool.query(
    `insert into bot_state (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

// Loads the saved state into memory and reconciles it with the files. Returns the counts.
async function hydrateState({ pool = null, files = STATE_FILES } = {}) {
  if (!pool && !databaseConfigured()) return { loaded: 0, imported: 0, restored: 0 };
  const p = pool ?? database.getPool();

  const rows = (await p.query('select key, value from bot_state')).rows;
  for (const row of rows) cache.set(row.key, row.value);

  let imported = 0;
  let restored = 0;
  for (const file of files) {
    if (cache.has(file)) {
      if (!fileExists(file)) {
        db.writeJson(file, cache.get(file));
        restored += 1;
      }
    } else if (fileExists(file)) {
      const value = db.readJson(file);
      cache.set(file, clone(value));
      await upsert(p, file, value);
      imported += 1;
    }
  }
  hydrated = true;
  return { loaded: rows.length, imported, restored };
}

// The saved state for a file ({} if there is none), like readJson.
function readState(file) {
  return hydrated && cache.has(file) && !DISK_FIRST_FILES.has(file) ? clone(cache.get(file)) : db.readJson(file);
}

// Saves state for a file, like writeJson, and also to the table. A table failure is logged only:
// the file is written first and is still current.
function writeState(file, value) {
  db.writeJson(file, value);
  if (!hydrated) return;
  cache.set(file, clone(value));
  const job = upsert(database.getPool(), file, value)
    .catch(err => console.error(`[State] Failed to save ${file} to the database:`, err.message))
    .finally(() => pending.delete(job));
  pending.add(job);
}

// Waits for saves to the table that are still running.
async function flushState() {
  await Promise.all([...pending]);
}

// Forgets everything held in memory (for tests).
function resetState() {
  cache.clear();
  pending.clear();
  hydrated = false;
}

module.exports = { hydrateState, readState, writeState, flushState, resetState, STATE_FILES, DISK_FIRST_FILES };
