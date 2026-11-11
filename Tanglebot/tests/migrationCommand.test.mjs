import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);
const { commandDisabledReason } = require('../src/utils/commandAvailability.js');
const tools = require('../src/utils/migrationTools.js');

const ENV = {
  DATABASE_URL: 'postgres://u:p@host:5432/db', GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
  DONATIONS_SHEET_ID: 's1', PET_HIGHSCORES_SHEET_ID: 's2', OWNER_ROLE_ID: 'owner',
};

let savedTools;
let savedEnv;
let command;
let pet;
let donation;
let savedBoards;
beforeEach(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, ENV);
  savedTools = { ...tools };
  delete require.cache[require.resolve('../src/commands/migration.js')];
  command = require('../src/commands/migration.js');
  pet = require('../src/commands/pethighscore.js');
  donation = require('../src/commands/donationhighscore.js');
  savedBoards = [pet.refreshLeaderboard, donation.refreshLeaderboard];
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  Object.assign(tools, savedTools);
  [pet.refreshLeaderboard, donation.refreshLeaderboard] = savedBoards;
});

function run(subcommand, { owner = true, confirm = undefined } = {}) {
  const replies = [];
  const interaction = {
    user: { id: '1', tag: 'owner' },
    client: {},
    member: { roles: { cache: { has: id => owner && id === 'owner' } } },
    options: { getSubcommand: () => subcommand, getBoolean: () => confirm },
    reply: async r => { replies.push(r); },
    deferReply: async () => {},
    editReply: async r => { replies.push(r); },
  };
  return command.execute(interaction).then(() => ({ replies, interaction }));
}

test('the command only loads when the database, the sheets and the Owner role are all configured', () => {
  assert.equal(commandDisabledReason(command, ENV), null);
  for (const key of Object.keys(ENV)) {
    const env = { ...ENV, [key]: '' };
    assert.match(commandDisabledReason(command, env), new RegExp(key), `${key} should be required`);
  }
});

test('it offers the connection, sheets, status, dry run, import and verify checks', () => {
  const names = command.data.toJSON().options.map(o => o.name);
  assert.deepEqual(names, ['dbconnection', 'sheets', 'status', 'dryrun', 'import', 'verify']);
  const importOptions = command.data.toJSON().options.find(o => o.name === 'import').options;
  assert.equal(importOptions[0].name, 'confirm');
  assert.equal(importOptions[0].required, true);
});

test('only the Owner role can use it, and nothing runs for anyone else', async () => {
  let called = false;
  tools.testConnection = async () => { called = true; return {}; };
  const { replies } = await run('dbconnection', { owner: false });
  assert.equal(called, false);
  assert.match(replies[0].content, /Only the Owner role/);
});

test('dbconnection reports the server, user, speed and migrations', async () => {
  tools.testConnection = async () => ({
    server: 'PostgreSQL 17.2', database: 'tanglebot', user: 'tanglebot', ms: 12,
    applied: ['001_a.sql'], pending: ['002_b.sql'],
  });
  const { replies } = await run('dbconnection');
  assert.match(replies[0], /Connected: PostgreSQL 17\.2, database "tanglebot" as "tanglebot" \(12 ms\)/);
  assert.match(replies[0], /applied: 001_a\.sql/);
  assert.match(replies[0], /pending: 002_b\.sql/);
});

test('a failing check replies with the error instead of throwing', async () => {
  tools.testConnection = async () => { throw new Error('connect ECONNREFUSED'); };
  const { replies, interaction } = await run('dbconnection');
  assert.match(replies[0], /dbconnection failed: connect ECONNREFUSED/);
  assert.equal(interaction.commandError.message, 'connect ECONNREFUSED');
});

test('sheets shows what each tab holds and the pet keys the import would skip', async () => {
  tools.readSheets = async () => ({
    donations: [{ discordId: '1', displayName: 'A', donated: 100 }],
    highscores: [{ discordId: '1', displayName: 'A', petKeys: ['heron', 'mystery'] }],
    catalog: [{ key: 'heron', name: 'Heron', emojiId: '' }],
  });
  const { replies } = await run('sheets');
  assert.match(replies[0], /Donations tab: 1 members, 100 GP/);
  assert.match(replies[0], /Highscores tab: 1 members, 2 pets owned/);
  assert.match(replies[0], /missing from the catalog.*mystery/);
});

test('import without confirm does nothing', async () => {
  let imported = false;
  tools.runImport = async () => { imported = true; };
  const { replies } = await run('import', { confirm: false });
  assert.equal(imported, false);
  assert.match(replies[0], /Nothing was imported/);
});

test('import with confirm imports, shows the check and warnings, and reposts both boards', async () => {
  tools.runImport = async ({ log }) => {
    log('Warning: pet key "x" (1) is not in the Pets catalog; skipped.');
    return {
      summary: { sheets: { members: 2, gp: 350, pets: 3, catalog: 2 }, database: { members: 2, gp: 350, pets: 3, catalog: 2 } },
      verification: { differences: [], notes: [] },
    };
  };
  const refreshed = [];
  pet.refreshLeaderboard = async () => { refreshed.push('pets'); return true; };
  donation.refreshLeaderboard = async () => { refreshed.push('donations'); return true; };

  const { replies } = await run('import', { confirm: true });
  assert.deepEqual(refreshed, ['pets', 'donations']);
  assert.match(replies[0], /Imported:/);
  assert.match(replies[0], /Total GP donated\s+350\s+350/);
  assert.match(replies[0], /Warning: pet key "x"/);
  assert.match(replies[0], /Verified: every donation total/);
  assert.match(replies[0], /Pet high scores reposted/);
});

test('a differing verification and a failed repost are shown, not hidden', async () => {
  tools.runImport = async () => ({
    summary: { sheets: { members: 1, gp: 1, pets: 0, catalog: 0 }, database: { members: 1, gp: 1, pets: 0, catalog: 0 } },
    verification: { differences: ['A (1): sheet has 100 GP donated, database has 90.'], notes: [] },
  });
  pet.refreshLeaderboard = async () => { throw new Error('no channel'); };
  donation.refreshLeaderboard = async () => false;
  const { replies } = await run('import', { confirm: true });
  assert.match(replies[0], /1 difference\(s\) found/);
  assert.match(replies[0], /database has 90/);
  assert.match(replies[0], /Pet high scores not reposted: no channel/);
  assert.match(replies[0], /Donation high scores not reposted \(channel not set up\)/);
});

test('a long reply is cut to fit a Discord message', async () => {
  tools.runVerify = async () => ({ differences: Array.from({ length: 200 }, (_, i) => `member ${i} differs by a lot of text here`), notes: [] });
  const { replies } = await run('verify');
  assert.ok(replies[0].length < 2000);
  assert.match(replies[0], /cut, see the bot log/);
});

// ── migrationTools ───────────────────────────────────────────────────────────

test('testConnection reads the server and the applied migrations', async () => {
  const db = mockPg(sql => {
    if (/version\(\)/.test(sql)) return { rows: [{ version: 'PostgreSQL 17.2 on x86_64-pc-linux-musl', user_name: 'tanglebot', database_name: 'tanglebot' }] };
    if (/from schema_migrations/.test(sql)) return { rows: [{ name: '001_high_scores.sql' }] };
  });
  const info = await savedTools.testConnection(db.pool);
  assert.equal(info.server, 'PostgreSQL 17.2');
  assert.deepEqual(info.applied, ['001_high_scores.sql']);
  assert.ok(info.pending.includes('002_member_history.sql'));
});

test('testConnection on a database with no schema_migrations table lists everything as pending', async () => {
  const db = mockPg(sql => {
    if (/version\(\)/.test(sql)) return { rows: [{ version: 'PostgreSQL 17.2', user_name: 'u', database_name: 'd' }] };
    if (/from schema_migrations/.test(sql)) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
  });
  const info = await savedTools.testConnection(db.pool);
  assert.deepEqual(info.applied, []);
  assert.ok(info.pending.length >= 3);
});

test('waitingForImport is true until a donation or member pet is stored', async () => {
  for (const [has, expected] of [[false, true], [true, false]]) {
    const db = mockPg(() => ({ rows: [{ has_data: has }] }));
    assert.equal(await savedTools.waitingForImport(db.pool), expected);
  }
});

const sheetData = {
  donations: [{ discordId: '1', displayName: 'A', donated: 100 }],
  highscores: [{ discordId: '1', displayName: 'A', petKeys: ['heron'] }],
  catalog: [{ key: 'heron', name: 'Heron', emojiId: '1' }],
};

test('a dry run rolls back and never commits', async () => {
  const db = mockPg(sql => (/^\s*select/.test(sql) ? { rows: [{ n: '0', other: '0', last_total: null }] } : undefined));
  const result = await savedTools.runImport({ dryRun: true, db: db.pool, data: sheetData, log: () => {} });
  const sqls = db.calls.map(c => c.sql);
  assert.ok(sqls.includes('rollback'));
  assert.ok(!sqls.includes('commit'));
  assert.ok(result.summary && result.verification);
});

test('a real import commits, then checks the result', async () => {
  const db = mockPg(sql => (/^\s*select/.test(sql) ? { rows: [{ n: '0', other: '0', last_total: null }] } : undefined));
  const result = await savedTools.runImport({ db: db.pool, data: sheetData, log: () => {} });
  assert.ok(db.calls.some(c => c.sql === 'commit'));
  assert.ok(result.verification.differences.length > 0); // the mock database stays empty
});

test('only one import runs at a time', async () => {
  let release;
  const slow = mockPg(async sql => {
    if (/insert into pets/.test(sql)) await new Promise(resolve => { release = resolve; });
    if (/^\s*select/.test(sql)) return { rows: [{ n: '0', other: '0', last_total: null }] };
  });
  const first = savedTools.runImport({ db: slow.pool, data: sheetData, log: () => {} });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(savedTools.runImport({ db: slow.pool, data: sheetData, log: () => {} }), /already running/);
  release();
  await first;
});

// ── Startup: no empty boards while the import is pending ─────────────────────

test('the boards are not reposted at startup while the database waits for the import', async () => {
  const canvasPath = require.resolve('@napi-rs/canvas');
  require.cache[canvasPath] = { id: canvasPath, filename: canvasPath, loaded: true, exports: {} };
  const { boardsWaitForImport } = require('../src/handlers/eventHandler.js');

  tools.waitingForImport = async () => true;
  assert.equal(await boardsWaitForImport(), true);

  tools.waitingForImport = async () => false;
  assert.equal(await boardsWaitForImport(), false);

  // No sheets configured: a fresh database is simply the start, so post as usual.
  tools.waitingForImport = async () => true;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  assert.equal(await boardsWaitForImport(), false);

  // No database: the sheets are in use.
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{}';
  delete process.env.DATABASE_URL;
  assert.equal(await boardsWaitForImport(), false);

  // A failing check never blocks the boards.
  process.env.DATABASE_URL = ENV.DATABASE_URL;
  tools.waitingForImport = async () => { throw new Error('db down'); };
  assert.equal(await boardsWaitForImport(), false);
});
