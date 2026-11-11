const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { databaseConfigured } = require('./commandAvailability');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');
const MIGRATION_FILE = /^\d{3}_.+\.sql$/;
// Arbitrary key so two bots starting together don't run the same migration twice.
const MIGRATION_LOCK_KEY = 7_265_001;

let pool = null;

// The shared pool, created on first use from DATABASE_URL.
function getPool() {
  if (!pool) {
    if (!databaseConfigured()) throw new Error('DATABASE_URL is not set');
    // Timeouts so an unreachable database fails a command instead of hanging it.
    pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
    pool.on('error', err => console.error('[Database] Idle client error:', err.message));
  }
  return pool;
}

async function closePool() {
  if (!pool) return;
  const old = pool;
  pool = null;
  await old.end();
}

// Runs fn(client) in a transaction; rolls back and rethrows if it throws.
async function withTransaction(fn, db = getPool()) {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Applies every migrations/NNN_name.sql not yet in schema_migrations, in name order, each in its
// own transaction. Throws (naming the file) if one fails; later files are not run.
async function runMigrations({ db = getPool(), dir = MIGRATIONS_DIR, log = console.log } = {}) {
  try {
    await db.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())'
    );
  } catch (err) {
    // Two bots starting together can both try to create it; the other one won.
    if (err.code !== '23505' && err.code !== '42P07') throw err;
  }
  const applied = new Set((await db.query('select name from schema_migrations')).rows.map(r => r.name));
  const files = fs.readdirSync(dir).filter(f => MIGRATION_FILE.test(f)).sort();

  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      const didRun = await withTransaction(async client => {
        await client.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
        // Another instance may have applied it while this one waited for the lock.
        const done = await client.query('select 1 from schema_migrations where name = $1', [file]);
        if (done.rows.length) return false;
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        return true;
      }, db);
      if (didRun) {
        ran.push(file);
        log(`[Database] Applied migration ${file}`);
      }
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err.message}`, { cause: err });
    }
  }
  if (!ran.length) log('[Database] Migrations up to date');
  return ran;
}

module.exports = { getPool, closePool, withTransaction, runMigrations, MIGRATIONS_DIR };
