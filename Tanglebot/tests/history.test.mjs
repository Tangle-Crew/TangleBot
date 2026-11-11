import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);

Object.assign(process.env, {
  DATABASE_URL: 'postgres://u:p@host:5432/db',
  COORDINATOR_ROLE_ID: 'coord', TEMPLAR_ROLE_ID: 'templar', OWNER_ROLE_ID: 'owner',
});

const { commandDisabledReason } = require('../src/utils/commandAvailability.js');
const history = require('../src/utils/history.js');
const command = require('../src/commands/history.js');

const d = iso => new Date(iso);
const donationRow = (over = {}) => ({
  change_gp: 100_000_000, total_after: 180_000_000, source: 'command', created_at: d('2026-10-05T00:00:00Z'),
  member_name: 'Alice', by_name: 'Staff', ...over,
});
const donationData = (over = {}) => ({
  rows: [
    donationRow(),
    donationRow({ change_gp: -20_000_000, total_after: 160_000_000, created_at: d('2026-10-20T00:00:00Z') }),
    donationRow({ change_gp: 80_000_000, total_after: 80_000_000, source: 'import', by_name: null, created_at: d('2026-09-01T00:00:00Z') }),
    donationRow({ change_gp: 5_000_000, total_after: 5_000_000, source: 'manual', created_at: d('2026-08-01T00:00:00Z') }),
  ],
  total: 4, current: 160_000_000, donors: 7,
  months: [{ month: d('2026-10-01T00:00:00Z'), added: 100_000_000, removed: -20_000_000, changes: 2 }],
  ...over,
});

test('a member donation history shows each change with the new total and who made it', () => {
  const embed = history.donationEmbed(donationData(), { subject: 'Alice', page: 1 }).toJSON();
  assert.equal(embed.title, 'Donation history: Alice');
  assert.match(embed.description, /Total now: \*\*160,000,000\*\* GP/);
  assert.match(embed.description, /<t:\d+:d> \+100,000,000 → 180,000,000 GP by Staff/);
  assert.match(embed.description, /-20,000,000 → 160,000,000 GP by Staff/);
  assert.match(embed.description, /imported at 80,000,000 GP/);
  assert.match(embed.description, /\+5,000,000 → 5,000,000 GP by Staff \(manual\)/);
  assert.equal(embed.footer.text, 'Page 1 of 1 · 4 changes');
  assert.match(embed.fields[0].value, /Oct 2026: \+100,000,000 \/ -20,000,000 GP \(2 changes\)/);
});

test('the clan view names each member and counts the donors', () => {
  const embed = history.donationEmbed(donationData({ total: 23 }), { subject: null, page: 2 }).toJSON();
  assert.equal(embed.title, 'Donation history: the clan');
  assert.match(embed.description, /from 7 donors/);
  assert.match(embed.description, /\*\*Alice\*\* \+100,000,000/);
  assert.equal(embed.footer.text, 'Page 2 of 3 · 23 changes');
});

test('names are escaped so they cannot change the formatting, and an empty history says so', () => {
  const embed = history.donationEmbed(donationData({ rows: [donationRow({ member_name: '*x*', by_name: '_y_' })] }), { subject: null, page: 1 }).toJSON();
  assert.match(embed.description, /\\\*x\\\*/);
  assert.match(embed.description, /by \\_y\\_/);
  const empty = history.donationEmbed(donationData({ rows: [], total: 0, months: [] }), { subject: 'Alice', page: 1 }).toJSON();
  assert.match(empty.description, /No donation changes recorded\./);
  assert.equal(empty.fields, undefined);
});

const petData = (over = {}) => ({
  rows: [
    { action: 'remove', created_at: d('2026-10-17T00:00:00Z'), pet_name: 'Tangleroot', member_name: 'Alice', by_name: 'Staff' },
    { action: 'add', created_at: d('2026-10-01T00:00:00Z'), pet_name: 'Heron', member_name: 'Alice', by_name: null },
  ],
  total: 2, owned: 5, months: [{ month: d('2026-10-01T00:00:00Z'), added: 3 }],
  ...over,
});

test('a pet timeline shows adds and removals with who made them, and what has no date', () => {
  const embed = history.petEmbed(petData(), { subject: 'Alice', page: 1 }).toJSON();
  assert.equal(embed.title, 'Pet timeline: Alice');
  assert.match(embed.description, /Pets now: \*\*5\*\*/);
  assert.match(embed.description, /<t:\d+:d> ➖ Tangleroot \(by Staff\)/);
  assert.match(embed.description, /<t:\d+:d> ➕ Heron\n/);
  assert.match(embed.description, /Pets owned before the sheets were imported have no date/);
  assert.equal(embed.fields[0].name, 'Pets added by month');
  assert.equal(embed.fields[0].value, 'Oct 2026: 3');

  const clan = history.petEmbed(petData(), { subject: null, page: 1 }).toJSON();
  assert.match(clan.description, /\*\*Alice\*\* ➖ Tangleroot/);
  assert.doesNotMatch(clan.description, /before the sheets/);
});

test('getDonationHistory asks for one member or the whole clan, a page at a time', async () => {
  const respond = sql => {
    if (/count\(\*\) as n from donation_log/.test(sql)) return { rows: [{ n: '23' }] };
    if (/date_trunc/.test(sql)) return { rows: [{ month: d('2026-10-01T00:00:00Z'), added: '100', removed: '-20', changes: '2' }] };
    if (/from donations/.test(sql)) return { rows: [{ total_gp: '160000000' }] };
    return { rows: [{ ...donationRow(), change_gp: '100000000', total_after: '180000000' }] };
  };
  const one = mockPg(respond);
  const data = await history.getDonationHistory({ discordId: 'A', page: 3 }, one.pool);
  assert.equal(data.total, 23);
  assert.equal(data.current, 160_000_000);
  assert.deepEqual(data.months, [{ month: d('2026-10-01T00:00:00Z'), added: 100, removed: -20, changes: 2 }]);
  assert.strictEqual(data.rows[0].change_gp, 100_000_000);
  const page = one.calls.find(c => /order by l\.id desc limit/.test(c.sql));
  assert.match(page.sql, /where l\.discord_id = \$1/);
  assert.deepEqual(page.params, ['A', 10, 20]);

  const clan = mockPg(respond);
  await history.getDonationHistory({}, clan.pool);
  assert.doesNotMatch(clan.calls[0].sql, /where/);
  assert.deepEqual(clan.calls.find(c => /order by l\.id desc limit/.test(c.sql)).params, [10, 0]);
});

// ── The command ──────────────────────────────────────────────────────────────

let saved;
beforeEach(() => { saved = { ...history }; });
afterEach(() => { Object.assign(history, saved); });

const member = (...roles) => ({ roles: { cache: { has: id => roles.includes(id) } } });
function run(subcommand, { roles = ['coord'], user = null, page = null } = {}) {
  const replies = [];
  const interaction = {
    user: { id: '1', tag: 'someone' },
    member: member(...roles),
    options: { getSubcommand: () => subcommand, getUser: () => user, getInteger: () => page },
    reply: async r => { replies.push(r); },
    deferReply: async () => {},
    editReply: async r => { replies.push(r); },
  };
  return command.execute(interaction).then(() => ({ replies, interaction }));
}

test('/history needs the database and a staff role to load, is hidden by default, and has two subcommands', () => {
  assert.equal(commandDisabledReason(command, { DATABASE_URL: 'x', COORDINATOR_ROLE_ID: 'c' }), null);
  assert.match(commandDisabledReason(command, { COORDINATOR_ROLE_ID: 'c' }), /DATABASE_URL/);
  assert.match(commandDisabledReason(command, { DATABASE_URL: 'x' }), /none of the env var/);
  const json = command.data.toJSON();
  assert.equal(json.default_member_permissions, '0');
  assert.deepEqual(json.options.map(o => o.name), ['donations', 'pets']);
});

test('Coordinator, Templar and Owner can use it; anyone else is refused and logged as denied', async () => {
  history.getDonationHistory = async () => donationData();
  for (const role of ['coord', 'templar', 'owner']) {
    const { replies } = await run('donations', { roles: [role] });
    assert.equal(replies.at(-1).embeds[0].toJSON().title, 'Donation history: the clan', role);
  }
  const { replies, interaction } = await run('donations', { roles: ['other'] });
  assert.match(replies[0].content, /Coordinator role or higher/);
  assert.equal(interaction.commandDenied, true);
});

test('donations and pets for a member pass the member and page through', async () => {
  const calls = [];
  history.getDonationHistory = async a => { calls.push(['donations', a]); return donationData({ total: 25 }); };
  history.getPetHistory = async a => { calls.push(['pets', a]); return petData({ total: 25 }); };
  const user = { id: '111', username: 'alice' };

  const donations = await run('donations', { user, page: 3 });
  const pets = await run('pets', { user, page: 1 });
  assert.deepEqual(calls, [['donations', { discordId: '111', page: 3 }], ['pets', { discordId: '111', page: 1 }]]);
  assert.equal(donations.replies.at(-1).embeds[0].toJSON().title, 'Donation history: Alice');
  assert.equal(pets.replies.at(-1).embeds[0].toJSON().title, 'Pet timeline: Alice');
});

test('a page past the end, and a member with nothing recorded, are explained', async () => {
  history.getDonationHistory = async () => donationData({ total: 4 });
  assert.equal((await run('donations', { page: 5 })).replies.at(-1), 'There is only 1 page of history.');

  history.getPetHistory = async () => petData({ rows: [], total: 0, owned: 0, months: [] });
  assert.equal((await run('pets', { user: { id: '9', username: 'x' } })).replies.at(-1), 'Nothing is recorded for <@9> yet.');

  // Pets owned from the import but no logged changes still shows the timeline.
  history.getPetHistory = async () => petData({ rows: [], total: 0, owned: 4, months: [] });
  const owned = await run('pets', { user: { id: '9', username: 'x' } });
  assert.match(owned.replies.at(-1).embeds[0].toJSON().description, /Pets now: \*\*4\*\*/);
});

test('a database error is shown and logged as a failure', async () => {
  history.getPetHistory = async () => { throw new Error('db down'); };
  const { replies, interaction } = await run('pets');
  assert.match(replies.at(-1), /Could not read the history: db down/);
  assert.equal(interaction.commandError.message, 'db down');
});
