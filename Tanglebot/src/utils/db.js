const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// A corrupt file (e.g. from a crash mid-write) is treated as empty rather than taking down
// whatever called this.
function readJson(filename) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Could not parse ${filename}, treating it as empty:`, err.message);
    return {};
  }
}

// Writes to a temp file and renames it into place so a crash mid-write can never leave a
// truncated, unparseable file behind — the rename is atomic on the same filesystem.
let writeCounter = 0;

function writeJson(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  console.log(`Writing data file: ${filename}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Unique per call, not just per-process — two unlocked concurrent writes to the same filename
  // would otherwise share one temp path and race each other's write/rename.
  const tempPath = `${filePath}.${process.pid}.${++writeCounter}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

const fileLocks = new Map(); // filename -> tail of its pending operation chain

// Serializes async read-modify-write sequences against the same data file within this process —
// e.g. reading stored state, awaiting some Discord API calls, then writing it back — so two
// concurrent callers can't interleave and clobber each other's write.
function withFileLock(filename, fn) {
  const previous = fileLocks.get(filename) || Promise.resolve();
  const run = previous.then(fn, fn);
  fileLocks.set(filename, run.catch(() => {}));
  return run;
}

// Shared text-truncation helper — anything displayed back to Discord (embed fields/values,
// message content) that could exceed a length cap needs this.
function truncate(text, max) {
  if (!text) return text;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// True if `member` has any of the given role IDs — used to gate staff/admin-only actions.
// Falsy entries in roleIds (an unset env var) are ignored rather than matched.
function hasAnyRole(member, roleIds) {
  if (!member) return false;
  return roleIds.filter(Boolean).some((roleId) => member.roles?.cache?.has(roleId));
}

module.exports = { readJson, writeJson, withFileLock, truncate, hasAnyRole };
