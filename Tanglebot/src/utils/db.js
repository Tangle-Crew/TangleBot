const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// A missing or corrupt file reads as {}.
function readJson(filename) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[Data] Could not parse ${filename}, treating it as empty:`, err.message);
    return {};
  }
}

// Writes a temp file and renames it into place, so a crash can't leave a truncated file.
let writeCounter = 0;

function writeJson(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  console.log(`[Data] Writing data file: ${filename}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Unique per call, so concurrent writes don't share a temp file.
  const tempPath = `${filePath}.${process.pid}.${++writeCounter}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

const fileLocks = new Map(); // filename -> tail of its pending operation chain

// Runs fn after every earlier call with the same key has finished. Don't nest calls with the same
// key; they would wait on each other forever.
function withFileLock(filename, fn) {
  const previous = fileLocks.get(filename) || Promise.resolve();
  const run = previous.then(fn, fn);
  fileLocks.set(filename, run.catch(() => {}));
  return run;
}

// Cuts text to max characters, ending with "…".
function truncate(text, max) {
  if (!text) return text;
  if (max <= 0) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// True if member has any of roleIds. Unset (falsy) IDs are ignored.
function hasAnyRole(member, roleIds) {
  if (!member) return false;
  return roleIds.filter(Boolean).some((roleId) => member.roles?.cache?.has(roleId));
}

// An integer env var, or fallback if it's unset, blank or not a number.
function intEnv(name, fallback) {
  const value = parseInt(process.env[name] ?? '', 10);
  return Number.isNaN(value) ? fallback : value;
}

// A Discord timestamp, shown in each viewer's timezone. Styles: t, T, d, D, f, F, R.
function discordTimestamp(date, style) {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;
}

// Rejects with "<label> timed out after Ns" if promise hasn't settled within ms. For calls with no
// timeout of their own, like the Wise Old Man client's.
function withTimeout(promise, label, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = {
  DATA_DIR,
  readJson,
  writeJson,
  withFileLock,
  truncate,
  hasAnyRole,
  intEnv,
  discordTimestamp,
  withTimeout,
};
