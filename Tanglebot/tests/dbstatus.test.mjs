import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);
const { commandDisabledReason } = require('../src/utils/commandAvailability.js');
const dbStatus = require('../src/utils/dbStatus.js');
const dbHealth = require('../src/utils/dbHealth.js');
const command = require('../src/commands/dbstatus.js');

const COUNTS = {
  members: 120, donors: 40, gp: 1_234_567_890, collectors: 30, petsOwned: 210, catalog: 60, donationLog: 400, petLog: 250,
  accounts: 150, memberEvents: 900, competitions: 12, commandLog: 5000, commandLogOldest: new Date('2025-11-27T00:00:00Z'),
  honeypotIncidents: 3, sizeBytes: 12.5 * 1024 * 1024,
};
const INFO = { server: 'PostgreSQL 17.2', database: 'tanglebot', user: 'tanglebot', host: 'tanglebot-db:5432', ms: 4, applied: ['001_a.sql', '010_b.sql'], pending: [] };

let saved;
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.OWNER_ROLE_ID = 'owner';
  saved = { ...dbStatus, getState: dbHealth.getState };
  dbStatus.testConnection = async () => INFO;
  dbStatus.tableCounts = async () => COUNTS;
  dbStatus.poolStats = () => ({ total: 3, idle: 2, waiting: 0 });
  dbHealth.getState = () => ({ status: 'ok', lastCheckAt: Date.now(), failures: 0, failuresBeforeAlert: 3, intervalSeconds: 60, lastOutage: null });
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  const { getState, ...rest } = saved;
  Object.assign(dbStatus, rest);
  dbHealth.getState = getState;
});

async function run({ owner = true } = {}) {
  const replies = [];
  const interaction = {
    user: { id: '1', tag: 'someone' },
    member: { roles: { cache: { has: id => owner && id === 'owner' } } },
    reply: async r => { replies.push(r); },
    deferReply: async () => {},
    editReply: async r => { replies.push(r); },
  };
  await command.execute(interaction);
  const embed = replies.at(-1).embeds?.[0]?.toJSON();
  const fields = embed ? Object.fromEntries(embed.fields.map(f => [f.name, f.value])) : {};
  return { replies, interaction, embed, fields };
}

test('it only loads with DATABASE_URL and OWNER_ROLE_ID, and is hidden by default', () => {
  const env = { DATABASE_URL: 'postgres://x', OWNER_ROLE_ID: 'o' };
  assert.equal(commandDisabledReason(command, env), null);
  assert.match(commandDisabledReason(command, { ...env, DATABASE_URL: '' }), /DATABASE_URL/);
  assert.match(commandDisabledReason(command, { ...env, OWNER_ROLE_ID: '' }), /OWNER_ROLE_ID/);
  assert.equal(command.data.toJSON().default_member_permissions, '0');
});

test('a non-Owner is refused and nothing is read', async () => {
  let called = false;
  dbStatus.testConnection = async () => { called = true; return INFO; };
  const { replies, interaction } = await run({ owner: false });
  assert.equal(called, false);
  assert.match(replies[0].content, /Only the Owner role/);
  assert.equal(interaction.commandDenied, true);
});

test('an Owner gets the connection, migrations, monitor, pool and counts', async () => {
  const { embed, fields, interaction } = await run();
  assert.equal(embed.color, 0x2e7d32);
  assert.match(fields.Connection, /round trip 4 ms/);
  assert.match(fields.Connection, /Host `tanglebot-db:5432`/);
  assert.doesNotMatch(JSON.stringify(embed), /password/i);
  assert.match(fields.Migrations, /2 applied, latest `010_b\.sql`/);
  assert.match(fields.Migrations, /Pending: none/);
  assert.match(fields['Health monitor'], /\*\*ok\*\*/);
  assert.match(fields['Health monitor'], /every 60 s/);
  assert.equal(fields['Connection pool'], '3 open, 2 idle, 0 waiting');
  assert.match(fields.Data, /Donors: 40, 1,234,567,890 GP/);
  assert.match(fields.Data, /Command log: 5,000 rows, oldest <t:\d+:D>/);
  assert.match(fields.Data, /Database size: 12\.5 MB/);
  assert.equal(interaction.commandError, undefined);
});

test('an outage shows in the monitor section', async () => {
  dbHealth.getState = () => ({ status: 'down', lastCheckAt: Date.now(), downSince: Date.now() - 120_000, failures: 2, failuresBeforeAlert: 3, intervalSeconds: 60 });
  const { fields } = await run();
  assert.match(fields['Health monitor'], /Down since <t:\d+:R> \(2 failed checks; alert after 3\)/);
});

test('a failing connection gives the plain error and the monitor, and sets commandError', async () => {
  dbStatus.testConnection = async () => { throw Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:5432'), { code: 'ECONNREFUSED' }); };
  const { embed, fields, interaction } = await run();
  assert.equal(embed.color, 0xed4245);
  assert.match(fields.Connection, /Not reachable:\*\* Connection refused/);
  assert.ok(fields['Health monitor']);
  assert.equal(interaction.commandError.code, 'ECONNREFUSED');
});

test('a hung connection still answers within the timeout', async () => {
  dbStatus.testConnection = () => new Promise(() => {});
  const started = Date.now();
  const { fields } = await run();
  assert.ok(Date.now() - started < 7000);
  assert.match(fields.Connection, /Timed out/);
});

test('failing row counts are shown as an error and set commandError', async () => {
  dbStatus.tableCounts = async () => { throw new Error('relation "accounts" does not exist'); };
  const { fields, interaction } = await run();
  assert.match(fields.Data, /Could not read the row counts: relation "accounts"/);
  assert.match(interaction.commandError.message, /accounts/);
});

// ── dbStatus ─────────────────────────────────────────────────────────────────

test('testConnection reads the server and the applied migrations', async () => {
  const db = mockPg(sql => {
    if (/version\(\)/.test(sql)) return { rows: [{ version: 'PostgreSQL 17.2 on x86_64-pc-linux-musl', user_name: 'tanglebot', database_name: 'tanglebot' }] };
    if (/from schema_migrations/.test(sql)) return { rows: [{ name: '001_high_scores.sql' }] };
  });
  const info = await saved.testConnection(db.pool);
  assert.equal(info.server, 'PostgreSQL 17.2');
  assert.deepEqual(info.applied, ['001_high_scores.sql']);
  assert.ok(info.pending.includes('002_member_history.sql'));
});

test('testConnection on a database with no schema_migrations table lists everything as pending', async () => {
  const db = mockPg(sql => {
    if (/version\(\)/.test(sql)) return { rows: [{ version: 'PostgreSQL 17.2', user_name: 'u', database_name: 'd' }] };
    if (/from schema_migrations/.test(sql)) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
  });
  const info = await saved.testConnection(db.pool);
  assert.deepEqual(info.applied, []);
  assert.ok(info.pending.length >= 3);
});

test('tableCounts turns the counts into numbers', async () => {
  const db = mockPg(() => ({ rows: [{
    members: '2', donors: '1', gp: '5000000000', collectors: '1', pets_owned: '4', catalog: '9', donation_log: '3', pet_log: '4',
    accounts: '5', member_events: '6', competitions: '7', command_log: '8', command_log_oldest: '2026-01-01T00:00:00Z',
    honeypot_incidents: '0', size_bytes: '1048576',
  }] }));
  const c = await saved.tableCounts(db.pool);
  assert.equal(c.gp, 5_000_000_000);
  assert.equal(c.petsOwned, 4);
  assert.equal(c.sizeBytes, 1048576);
  assert.deepEqual(c.commandLogOldest, new Date('2026-01-01T00:00:00Z'));
  assert.equal(db.calls.length, 1);
});

test('connectionTarget never includes the user or password', () => {
  assert.deepEqual(saved.connectionTarget('postgres://bot:s3cret@tanglebot-db:5432/tanglebot'), { host: 'tanglebot-db:5432', database: 'tanglebot' });
  assert.deepEqual(saved.connectionTarget('postgres://bot:s3cret@db/clan'), { host: 'db:5432', database: 'clan' });
  assert.equal(saved.connectionTarget('not a url').host, 'unknown');
});

test('poolStats reads the pool counters', () => {
  assert.deepEqual(saved.poolStats({ totalCount: 4, idleCount: 1, waitingCount: 2 }), { total: 4, idle: 1, waiting: 2 });
});
