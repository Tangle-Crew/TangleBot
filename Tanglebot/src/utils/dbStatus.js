// Read-only facts about the database for /dbstatus: the connection, the migrations, the pool and row counts.
const fs = require('fs');
const database = require('./database');

// host:port and database name from a postgres:// URL, never the user or password.
function connectionTarget(url = process.env.DATABASE_URL) {
  try {
    const parsed = new URL(url);
    return {
      host: `${parsed.hostname}:${parsed.port || 5432}`,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || null,
    };
  } catch {
    return { host: 'unknown', database: null };
  }
}

// Connects, and reports the server, how long a round trip took, and which migrations are applied.
async function testConnection(db = database.getPool()) {
  const started = Date.now();
  const { rows } = await db.query('select version() as version, current_user as user_name, current_database() as database_name');
  const ms = Date.now() - started;
  let applied = [];
  try {
    applied = (await db.query('select name from schema_migrations order by name')).rows.map(r => r.name);
  } catch (err) {
    if (err.code !== '42P01') throw err; // no schema_migrations table yet
  }
  const files = fs.readdirSync(database.MIGRATIONS_DIR).filter(f => database.MIGRATION_FILE.test(f)).sort();
  return {
    server: /PostgreSQL [\d.]+/.exec(rows[0].version)?.[0] ?? rows[0].version,
    user: rows[0].user_name,
    database: rows[0].database_name,
    host: connectionTarget().host,
    ms,
    applied,
    pending: files.filter(f => !applied.includes(f)),
  };
}

// Row counts for the bot's tables, the oldest command log entry and the database size.
async function tableCounts(db = database.getPool()) {
  const { rows } = await db.query(`select
    (select count(*) from members) as members,
    (select count(*) from donations) as donors,
    (select coalesce(sum(total_gp), 0) from donations) as gp,
    (select count(distinct discord_id) from member_pets) as collectors,
    (select count(*) from member_pets) as pets_owned,
    (select count(*) from pets) as catalog,
    (select count(*) from donation_log) as donation_log,
    (select count(*) from pet_log) as pet_log,
    (select count(*) from accounts) as accounts,
    (select count(*) from member_events) as member_events,
    (select count(*) from competitions) as competitions,
    (select count(*) from command_log) as command_log,
    (select min(created_at) from command_log) as command_log_oldest,
    (select count(*) from honeypot_incidents) as honeypot_incidents,
    pg_database_size(current_database()) as size_bytes`);
  const r = rows[0];
  const n = key => Number(r[key]);
  return {
    members: n('members'),
    donors: n('donors'),
    gp: n('gp'),
    collectors: n('collectors'),
    petsOwned: n('pets_owned'),
    catalog: n('catalog'),
    donationLog: n('donation_log'),
    petLog: n('pet_log'),
    accounts: n('accounts'),
    memberEvents: n('member_events'),
    competitions: n('competitions'),
    commandLog: n('command_log'),
    commandLogOldest: r.command_log_oldest ? new Date(r.command_log_oldest) : null,
    honeypotIncidents: n('honeypot_incidents'),
    sizeBytes: n('size_bytes'),
  };
}

// Open, idle and waiting clients in a pg Pool.
function poolStats(pool = database.getPool()) {
  return { total: pool.totalCount ?? 0, idle: pool.idleCount ?? 0, waiting: pool.waitingCount ?? 0 };
}

module.exports = { connectionTarget, testConnection, tableCounts, poolStats };
