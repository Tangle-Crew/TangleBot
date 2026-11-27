// Docker health check: exits 0 when data/health.json is fresh and the database is not down, else 1.
// Uses nothing from the rest of the bot. An optional first argument is the file to read.
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'health.json');

// { ok, reason } for the health file.
function checkHealth({ file = DEFAULT_FILE, now = Date.now(), intervalSeconds } = {}) {
  const parsed = parseInt(intervalSeconds ?? process.env.DB_HEALTH_CHECK_SECONDS ?? '', 10);
  const seconds = Number.isNaN(parsed) || parsed < 0 ? 60 : parsed;
  if (seconds === 0) return { ok: true, reason: 'the database health monitor is off' };

  let health;
  try {
    health = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'no health file yet' : `health file unreadable: ${err.message}` };
  }
  const checkedAt = Date.parse(health.checkedAt);
  if (Number.isNaN(checkedAt)) return { ok: false, reason: 'health file has no check time' };
  const ageSeconds = Math.round((now - checkedAt) / 1000);
  if (ageSeconds > 3 * seconds) return { ok: false, reason: `last check was ${ageSeconds}s ago` };
  if (health.database === 'down') return { ok: false, reason: `database down: ${health.lastError ?? 'unknown error'}` };
  return { ok: true, reason: `database ${health.database}, checked ${ageSeconds}s ago` };
}

if (require.main === module) {
  const { ok, reason } = checkHealth({ file: process.argv[2] || DEFAULT_FILE });
  console.log(`${ok ? 'healthy' : 'unhealthy'}: ${reason}`);
  process.exit(ok ? 0 : 1);
}

module.exports = { checkHealth };
