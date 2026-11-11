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
const profile = require('../src/utils/profile.js');
const command = require('../src/commands/profile.js');

const d = iso => new Date(iso);
const tiers = [
  { name: 'Onyx', threshold: 600_000_000, emoji: '<:Onyx:1>' },
  { name: 'Diamond', threshold: 150_000_000, emoji: '<:Diamond:2>' },
  { name: 'Ruby', threshold: 75_000_000, emoji: '<:Ruby:3>' },
];
const options = { tiers, masterThreshold: 10 };
const text = embed => {
  const json = embed.toJSON();
  return Object.fromEntries(json.fields.map(f => [f.name, f.value]));
};

const memberData = (over = {}) => ({
  overview: { discordId: '111', displayName: 'Snow', donatedGp: 160_000_000, pets: 2, inServer: true, firstJoinedServerAt: d('2023-03-01T00:00:00Z') },
  nameChanges: [
    { old_value: 'Snow II', new_value: 'Snow III', occurred_at: d('2025-02-01T00:00:00Z') },
    { old_value: 'Snow', new_value: 'Snow II', occurred_at: d('2024-02-01T00:00:00Z') },
    { old_value: null, new_value: 'Snow', occurred_at: d('2023-03-01T00:00:00Z') },
  ],
  stays: [{ kind: 'server_joined', occurred_at: d('2023-03-01T00:00:00Z') }],
  accounts: [{ rsn: 'Snow Main', wom_role: 'templar', status: 'active', is_main: true, first_joined_at: d('2023-03-01T00:00:00Z'), left_at: null }],
  petNames: ['Heron', 'Rocky'],
  lastDonation: d('2026-11-01T00:00:00Z'),
  milestones: [
    { kind: 'pet_master_reached', old_value: null, new_value: null, occurred_at: d('2026-10-01T00:00:00Z') },
    { kind: 'donation_tier_changed', old_value: 'Ruby', new_value: 'Diamond', occurred_at: d('2026-09-01T00:00:00Z') },
    { kind: 'donation_tier_changed', old_value: 'Diamond', new_value: null, occurred_at: d('2026-08-01T00:00:00Z') },
    { kind: 'pet_master_lost', old_value: null, new_value: null, occurred_at: d('2026-07-01T00:00:00Z') },
  ],
  ...over,
});

test('normalizeRsn reads a name the way WOM stores it', () => {
  assert.equal(profile.normalizeRsn('  Some_Name-Here  '), 'some name here');
  assert.equal(profile.normalizeRsn('A   B'), 'a b');
});

test('a member embed shows the Discord side, accounts, donations with tier and next tier, and pets', () => {
  const fields = text(profile.memberEmbed(memberData(), options));
  assert.match(fields.Discord, /In the server/);
  assert.match(fields.Discord, /First joined: <t:\d+:D>/);
  assert.match(fields.Discord, /Previous names: Snow II, Snow/);
  assert.match(fields['Clan accounts'], /⭐ \*\*Snow Main\*\*, templar/);
  assert.match(fields.Donations, /\*\*160,000,000\*\* GP, <:Diamond:2> Diamond/);
  assert.match(fields.Donations, /440,000,000 GP to Onyx/);
  assert.match(fields.Donations, /Last change: <t:\d+:D>/);
  assert.match(fields.Pets, /\*\*2\*\* pets/);
  assert.match(fields.Pets, /Heron, Rocky/);
  assert.doesNotMatch(fields.Pets, /Pet Master/);
  assert.equal(profile.memberEmbed(memberData(), options).toJSON().footer.text, 'Discord ID 111');
  assert.match(fields.Milestones, /Became a Pet Master \(<t:\d+:D>\)/);
  assert.match(fields.Milestones, /Donation tier: Ruby → Diamond/);
  assert.match(fields.Milestones, /Donation tier: Diamond → none/);
  assert.match(fields.Milestones, /No longer a Pet Master/);
});

test('a member who left, has nothing logged and no accounts says so plainly', () => {
  const fields = text(profile.memberEmbed(memberData({
    overview: { discordId: '9', displayName: 'Gone', donatedGp: 0, pets: 0, inServer: false, firstJoinedServerAt: null },
    stays: [{ kind: 'server_left', occurred_at: d('2024-05-05T00:00:00Z') }],
    nameChanges: [], accounts: [], petNames: [], lastDonation: null,
  }), options));
  assert.match(fields.Discord, /Not in the server \(left <t:\d+:D>\)/);
  assert.equal(fields['Clan accounts'], 'No clan accounts are linked to this person yet.');
  assert.equal(fields.Donations, 'No donations logged.');
  assert.equal(fields.Pets, 'No pets logged.');
  assert.equal(text(profile.memberEmbed(memberData({ milestones: [] }), options)).Milestones, 'None recorded.');
});

test('the top tier has no next tier, Pet Master is shown, and a long pet list is cut', () => {
  const names = Array.from({ length: 30 }, (_, i) => `Pet ${i}`);
  const fields = text(profile.memberEmbed(memberData({
    overview: { discordId: '1', displayName: 'Rich', donatedGp: 700_000_000, pets: 30, inServer: true, firstJoinedServerAt: null },
    petNames: names,
  }), options));
  assert.doesNotMatch(fields.Donations, /to /);
  assert.match(fields.Donations, /<:Onyx:1> Onyx/);
  assert.match(fields.Pets, /, Pet Master/);
  assert.match(fields.Pets, /Pet 19 and 10 more/);
  assert.doesNotMatch(fields.Pets, /Pet 20/);
});

const accountData = (over = {}) => ({
  account: {
    id: 5, wom_player_id: 77, rsn: 'Some Name', member_id: null, wom_role: 'minion', status: 'active',
    wom_joined_at: d('2024-01-01T00:00:00Z'), client_joined_at: d('2023-12-25T00:00:00Z'), first_joined_at: d('2023-12-25T00:00:00Z'), left_at: null,
  },
  events: [
    { kind: 'rank_changed', old_value: 'recruit', new_value: 'minion', occurred_at: d('2024-06-01T00:00:00Z') },
    { kind: 'joined', old_value: null, new_value: 'recruit', occurred_at: d('2024-01-01T00:00:00Z') },
    { kind: 'name_changed', old_value: 'Old Name', new_value: 'Some Name', occurred_at: d('2024-03-01T00:00:00Z') },
  ],
  member: null,
  competitions: { entered: 12, wins: 2, podiums: 5 },
  recentCompetitions: [{ title: 'BOTW T1: Zulrah', rank: 1, gained: 160702, ends_at: d('2026-11-07T16:00:00Z') }],
  ...over,
});

test('an account embed shows rank, dates, history and that it is not linked', () => {
  const fields = text(profile.accountEmbed(accountData()));
  assert.match(fields.Clan, /Rank: minion, in the clan/);
  assert.match(fields.Clan, /First joined: <t:\d+:D>/);
  assert.match(fields.Clan, /Joined \(RuneLite plugin\)/);
  assert.match(fields['Rank history'], /recruit → minion \(<t:\d+:D>\)/);
  assert.match(fields['Name history'], /Old Name → Some Name/);
  assert.match(fields['Joins and leaves'], /Joined <t:\d+:D>/);
  assert.equal(fields.Discord, 'Not linked to a Discord member yet.');
  assert.match(fields.Competitions, /Entered 12, won 2, top 3 5/);
  assert.match(fields.Competitions, /BOTW T1: Zulrah: place 1, 160,702 gained \(<t:\d+:D>\)/);
  assert.equal(profile.accountEmbed(accountData()).toJSON().footer.text, 'WOM player 77');
});

test('a former member shows when they left, a linked account shows the person, empty history says so', () => {
  const left = text(profile.accountEmbed(accountData({
    account: { ...accountData().account, status: 'left', left_at: d('2025-05-05T00:00:00Z') },
    events: [], member: { discord_id: '111', display_name: 'Snow' },
  })));
  assert.match(left.Clan, /left the clan/);
  assert.match(left.Clan, /Left: <t:\d+:D>/);
  assert.equal(left['Rank history'], 'None recorded.');
  assert.equal(left['Name history'], 'No name changes.');
  assert.equal(left['Joins and leaves'], 'None recorded.');
  assert.equal(left.Discord, '<@111> (Snow)');
  assert.equal(text(profile.accountEmbed(accountData({ competitions: { entered: 0, wins: 0, podiums: 0 }, recentCompetitions: [] }))).Competitions, 'No competitions recorded.');
});

test('findAccounts tries the exact name first, reads _ as a space, and treats % as plain text', async () => {
  const exact = mockPg(() => ({ rows: [{ id: 1, rsn: 'Some Name', wom_role: 'minion', status: 'active' }] }));
  assert.equal((await profile.findAccounts('Some_Name', exact.pool)).length, 1);
  assert.equal(exact.calls.length, 1);
  assert.deepEqual(exact.calls[0].params, ['some name']);

  const partial = mockPg(sql => (/username = \$1/.test(sql) ? { rows: [] } : { rows: [{ id: 2, rsn: 'Somebody', wom_role: null, status: 'left' }] }));
  const found = await profile.findAccounts('50%_off', partial.pool);
  assert.equal(found.length, 1);
  assert.deepEqual(partial.calls[1].params, ['%50\\% off%', 5]);
});

test('suggestAccounts matches names containing the text, starting-with first, and escapes %', async () => {
  const db = mockPg(() => ({ rows: [{ rsn: 'Alpha', wom_role: 'owner', status: 'active' }] }));
  assert.deepEqual(await profile.suggestAccounts('Al', db.pool), [{ rsn: 'Alpha', wom_role: 'owner', status: 'active' }]);
  assert.deepEqual(db.calls[0].params, ['%al%', 'al%']);
  assert.match(db.calls[0].sql, /order by \(username like \$2\) desc, \(status = 'active'\) desc, rsn limit 25/);
  await profile.suggestAccounts('100%', db.pool);
  assert.deepEqual(db.calls[1].params, ['%100\\%%', '100\\%%']);
  await profile.suggestAccounts('', db.pool);
  assert.deepEqual(db.calls[2].params, ['%%', '%'], 'empty text lists everyone, current members first');
});

test('an autocomplete choice shows the rank, or left, beside the name', () => {
  assert.deepEqual(profile.accountChoice({ rsn: 'Some Name', wom_role: 'minion', status: 'active' }), { name: 'Some Name · minion', value: 'Some Name' });
  assert.equal(profile.accountChoice({ rsn: 'X', wom_role: null, status: 'active' }).name, 'X · no rank');
  assert.equal(profile.accountChoice({ rsn: 'Old One', wom_role: 'owner', status: 'left' }).name, 'Old One · left');
  assert.ok(profile.accountChoice({ rsn: 'n'.repeat(120), wom_role: 'owner', status: 'active' }).name.length <= 100);
});

test('getMemberProfile turns the rows into numbers and dates, and is null for an unknown person', async () => {
  const db = mockPg(sql => {
    if (/from member_overview/.test(sql)) {
      return { rows: [{ discord_id: '111', display_name: 'Snow', donated_gp: '160000000', pets: '2', in_server: true, first_joined_server_at: d('2023-03-01T00:00:00Z') }] };
    }
    if (/from member_pets/.test(sql)) return { rows: [{ name: 'Heron' }, { name: 'Rocky' }] };
    if (/max\(created_at\)/.test(sql)) return { rows: [{ at: d('2026-11-01T00:00:00Z') }] };
    if (/count\(\*\) as n from honeypot_incidents/.test(sql)) return { rows: [{ n: '2' }] };
    return { rows: [] };
  });
  const data = await profile.getMemberProfile('111', db.pool);
  assert.strictEqual(data.overview.donatedGp, 160_000_000);
  assert.strictEqual(data.overview.pets, 2);
  assert.deepEqual(data.petNames, ['Heron', 'Rocky']);
  assert.deepEqual(data.lastDonation, d('2026-11-01T00:00:00Z'));
  assert.strictEqual(data.honeypotCount, 2);

  assert.equal(await profile.getMemberProfile('x', mockPg(() => ({ rows: [] })).pool), null);
});

// ── The command ──────────────────────────────────────────────────────────────

let saved;
beforeEach(() => { saved = { ...profile }; });
afterEach(() => { Object.assign(profile, saved); });

const member = (...roles) => ({ roles: { cache: { has: id => roles.includes(id) } } });
function run({ roles = ['coord'], values = {} } = {}) {
  const replies = [];
  const interaction = {
    user: { id: '1', tag: 'someone' },
    member: member(...roles),
    options: { getUser: n => values[n] ?? null, getString: n => values[n] ?? null },
    reply: async r => { replies.push(r); },
    deferReply: async () => {},
    editReply: async r => { replies.push(r); },
  };
  return command.execute(interaction).then(() => ({ replies, interaction }));
}

test('/profile needs the database and a staff role to load, and is hidden by default', () => {
  assert.equal(commandDisabledReason(command, { DATABASE_URL: 'x', COORDINATOR_ROLE_ID: 'c' }), null);
  assert.match(commandDisabledReason(command, { COORDINATOR_ROLE_ID: 'c' }), /DATABASE_URL/);
  assert.match(commandDisabledReason(command, { DATABASE_URL: 'x' }), /none of the env var/);
  assert.equal(command.data.toJSON().default_member_permissions, '0');
});

test('Coordinator, Templar and Owner can use it; anyone else is refused and logged as denied', async () => {
  profile.getMemberProfile = async () => null;
  for (const role of ['coord', 'templar', 'owner']) {
    const { replies } = await run({ roles: [role], values: { member: { id: '5' } } });
    assert.match(replies.at(-1), /Nothing is stored about <@5> yet/, role);
  }
  const { replies, interaction } = await run({ roles: ['other'], values: { member: { id: '5' } } });
  assert.match(replies[0].content, /Coordinator role or higher/);
  assert.equal(interaction.commandDenied, true);
});

test('it needs exactly one of member and rsn', async () => {
  for (const values of [{}, { member: { id: '5' }, rsn: 'x' }]) {
    const { replies } = await run({ values });
    assert.match(replies[0].content, /either a `member` or an `rsn`/);
  }
});

test('by member it shows the profile embed', async () => {
  profile.getMemberProfile = async id => { assert.equal(id, '111'); return memberData(); };
  const { replies } = await run({ values: { member: { id: '111' } } });
  assert.equal(replies.at(-1).embeds[0].toJSON().title, 'Profile: Snow');
});

test('by rsn it shows the one matching account, or explains none or several', async () => {
  profile.findAccounts = async () => [{ id: 5, rsn: 'Some Name', wom_role: 'minion', status: 'active' }];
  profile.getAccountProfile = async id => { assert.equal(id, 5); return accountData(); };
  const one = await run({ values: { rsn: 'some name' } });
  assert.equal(one.replies.at(-1).embeds[0].toJSON().title, 'Profile: Some Name');

  profile.findAccounts = async () => [];
  assert.match((await run({ values: { rsn: 'nobody' } })).replies.at(-1), /No clan account matches "nobody"/);

  profile.findAccounts = async () => [
    { id: 1, rsn: 'Some One', wom_role: 'owner', status: 'active' },
    { id: 2, rsn: 'Some Two', wom_role: null, status: 'left' },
  ];
  const many = (await run({ values: { rsn: 'some' } })).replies.at(-1);
  assert.match(many, /More than one account matches "some": Some One \(owner\), Some Two \(left\)\. Type the full name/);
});

test('a database error is shown and logged as a failure', async () => {
  profile.getMemberProfile = async () => { throw new Error('db down'); };
  const { replies, interaction } = await run({ values: { member: { id: '1' } } });
  assert.match(replies.at(-1), /Could not read the profile: db down/);
  assert.equal(interaction.commandError.message, 'db down');
});

test('autocomplete suggests account names for staff only', async () => {
  profile.suggestAccounts = async text => { assert.equal(text, 'so'); return [{ rsn: 'Some Name', wom_role: 'minion', status: 'active' }]; };
  const respond = [];
  const ask = roles => ({
    member: member(...roles),
    options: { getFocused: () => 'so' },
    respond: async choices => { respond.push(choices); },
  });
  await command.autocomplete(ask(['coord']));
  await command.autocomplete(ask(['other']));
  assert.deepEqual(respond, [[{ name: 'Some Name · minion', value: 'Some Name' }], []]);
});
