import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);
// Some commands need a native canvas binding that is irrelevant here; stub it.
const canvasPath = require.resolve('@napi-rs/canvas');
require.cache[canvasPath] = { id: canvasPath, filename: canvasPath, loaded: true, exports: {} };

// Roles are read when the commands load.
Object.assign(process.env, {
  DATABASE_URL: 'postgres://u:p@host:5432/db',
  COORDINATOR_ROLE_ID: 'coord', TEMPLAR_ROLE_ID: 'templar', OWNER_ROLE_ID: 'owner',
  WOM_GROUP_ID: '1', ADMIN_LOG_CHANNEL_ID: 'admin', HONEYPOT_CHANNEL_ID: 'trap',
});

const { commandDisabledReason } = require('../src/utils/commandAvailability.js');
const commandLog = require('../src/utils/commandLog.js');
const command = require('../src/commands/commandlog.js');

let saved;
beforeEach(() => {
  saved = commandLog.queryLog;
});
afterEach(() => {
  commandLog.queryLog = saved;
});

function member(...roles) {
  return { roles: { cache: { has: id => roles.includes(id) } } };
}

function run(cmd, { roles = [], values = {}, subcommand = 'add' } = {}) {
  const replies = [];
  const interaction = {
    user: { id: '1', tag: 'someone' },
    member: member(...roles),
    options: {
      getSubcommand: () => subcommand,
      getUser: name => values[name] ?? null,
      getString: name => values[name] ?? null,
      getInteger: name => values[name] ?? null,
      getBoolean: name => values[name] ?? null,
    },
    deferred: false,
    reply: async r => { replies.push(r); },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async r => { replies.push(r); },
  };
  return cmd.execute(interaction).then(() => ({ replies, interaction }));
}

const row = (over = {}) => ({
  id: 1, discord_id: '999', discord_name: 'Pauli (Owner)', command: 'migration import', options: { confirm: true },
  status: 'ok', error: null, duration_ms: 12, created_at: new Date('2026-11-10T20:00:00Z'), ...over,
});

test('/commandlog loads only with the database and at least one staff role set', () => {
  const env = { DATABASE_URL: 'postgres://x', COORDINATOR_ROLE_ID: 'c' };
  assert.equal(commandDisabledReason(command, env), null);
  assert.match(commandDisabledReason(command, { COORDINATOR_ROLE_ID: 'c' }), /DATABASE_URL/);
  assert.match(commandDisabledReason(command, { DATABASE_URL: 'postgres://x' }), /none of the env var/);
});

test('Coordinator, Templar and Owner can use it; anyone else is refused and logged as denied', async () => {
  commandLog.queryLog = async () => ({ rows: [], total: 0 });
  for (const role of ['coord', 'templar', 'owner']) {
    const { replies, interaction } = await run(command, { roles: [role] });
    assert.equal(replies.at(-1), 'No command runs found.', role);
    assert.equal(interaction.commandDenied, undefined);
  }
  const { replies, interaction } = await run(command, { roles: ['somerole'] });
  assert.match(replies[0].content, /Coordinator role or higher/);
  assert.equal(interaction.commandDenied, true);
});

test('it passes the filters and page to the query and shows who, what, when and the result', async () => {
  let args;
  commandLog.queryLog = async a => {
    args = a;
    return { rows: [row(), row({ id: 2, status: 'error', error: 'boom', discord_name: '*bold* name' }), row({ id: 3, status: 'denied' })], total: 23 };
  };
  const { replies } = await run(command, {
    roles: ['coord'],
    values: { user: { id: '999' }, command: '/migration', status: 'error', page: 2 },
  });
  assert.deepEqual(args, { discordId: '999', command: 'migration', status: 'error', limit: 10, offset: 10 });

  const embed = replies[0].embeds[0].data;
  assert.match(embed.description, /Pauli \(Owner\)\*\* \(999\) · \/migration import `confirm:true`/);
  assert.match(embed.description, /✅ ok/);
  assert.match(embed.description, /❌ error: boom/);
  assert.match(embed.description, /🚫 denied/);
  assert.match(embed.description, /\\\*bold\\\* name/, 'markdown in names is escaped');
  assert.match(embed.footer.text, /Page 2 of 3 · 23 runs matching user 999, command "migration", status error/);
});

test('a page past the end and an empty result say so', async () => {
  commandLog.queryLog = async () => ({ rows: [], total: 5 });
  const past = await run(command, { roles: ['owner'], values: { page: 3 } });
  assert.equal(past.replies.at(-1), 'There is only 1 page of results.');

  commandLog.queryLog = async () => ({ rows: [], total: 0 });
  const none = await run(command, { roles: ['owner'], values: { status: 'denied' } });
  assert.equal(none.replies.at(-1), 'No command runs found matching status denied.');
});

test('a database error is reported and logged as a failure', async () => {
  commandLog.queryLog = async () => { throw new Error('db down'); };
  const { replies, interaction } = await run(command, { roles: ['owner'] });
  assert.match(replies.at(-1), /Could not read the command log: db down/);
  assert.equal(interaction.commandError.message, 'db down');
});

test('queryLog filters by user, command prefix and status, newest first, with a total', async () => {
  const db = mockPg(sql => (/count\(\*\)/.test(sql) ? { rows: [{ n: '3' }] } : { rows: [row()] }));
  const result = await saved({ discordId: '999', command: '100%_off', status: 'error', limit: 10, offset: 20 }, db.pool);
  assert.equal(result.total, 3);
  const [count, page] = db.calls;
  assert.match(count.sql, /where discord_id = \$1 and command ilike \$2 and status = \$3/);
  assert.deepEqual(count.params, ['999', '100\\%\\_off%', 'error']);
  assert.match(page.sql, /order by id desc limit \$4 offset \$5/);
  assert.deepEqual(page.params, ['999', '100\\%\\_off%', 'error', 10, 20]);

  const all = mockPg(() => ({ rows: [{ n: '0' }] }));
  await saved({}, all.pool);
  assert.doesNotMatch(all.calls[0].sql, /where/);
});

// Every staff command that refuses a person for lacking a role flags it for the command log.
const DENIAL_CASES = [
  ['donationhighscore', {}], ['pethighscore', {}], ['pethighscore', { subcommand: 'new' }], ['refreshboards', {}],
  ['migration', { subcommand: 'status' }], ['spinwheel', {}], ['honeypot', {}],
  ['stalemembers', { values: { time: 6, minxp: '250k' } }], ['weeklycomp', {}],
  ['weeklyannounce', { subcommand: 'setup' }],
];
for (const [name, opts] of DENIAL_CASES) {
  test(`/${name}${opts.subcommand ? ` ${opts.subcommand}` : ''} flags a role refusal as denied`, async () => {
    const cmd = require(`../src/commands/${name}.js`);
    const { interaction, replies } = await run(cmd, { roles: [], ...opts });
    assert.equal(interaction.commandDenied, true, 'commandDenied should be set');
    assert.ok(replies.length >= 1, 'the person is told');
  });
}
