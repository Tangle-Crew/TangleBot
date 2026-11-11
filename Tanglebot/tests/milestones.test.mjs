import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);

Object.assign(process.env, { DATABASE_URL: 'postgres://u:p@host:5432/db' });
delete process.env.TEMPLAR_ROLE_ID;
delete process.env.PET_MASTER_ROLE_ID;
for (const tier of ['ZENYTE', 'ONYX', 'DRAGONSTONE', 'DIAMOND', 'RUBY']) delete process.env[`DONATION_${tier}_ROLE_ID`];

const milestones = require('../src/utils/milestones.js');
const highScoresDb = require('../src/utils/highScoresDb.js');
const donation = require('../src/commands/donationhighscore.js');
const pet = require('../src/commands/pethighscore.js');

const d = iso => new Date(iso);
const tiers = [{ name: 'Diamond', threshold: 150_000_000 }, { name: 'Ruby', threshold: 75_000_000 }];

test('a donation tier change is a milestone only when the highest tier changes', () => {
  assert.deepEqual(milestones.tierMilestone(tiers, 70_000_000, 80_000_000), {
    kind: 'donation_tier_changed', oldValue: null, newValue: 'Ruby', data: { total: 80_000_000 },
  });
  assert.equal(milestones.tierMilestone(tiers, 80_000_000, 100_000_000), null);
  assert.equal(milestones.tierMilestone(tiers, 10, 20), null);
  const lost = milestones.tierMilestone(tiers, 160_000_000, 10);
  assert.deepEqual([lost.oldValue, lost.newValue], ['Diamond', null]);
});

test('Pet Master is reached at the threshold and lost below it', () => {
  assert.equal(milestones.masterMilestone(10, 9, 10).kind, 'pet_master_reached');
  assert.equal(milestones.masterMilestone(10, 10, 9).kind, 'pet_master_lost');
  assert.equal(milestones.masterMilestone(10, 10, 11), null);
  assert.equal(milestones.masterMilestone(10, 3, 4), null);
  assert.equal(milestones.masterMilestone(10, 9, 12).kind, 'pet_master_reached', 'several pets at once');
});

const plan = over => milestones.planMilestones({
  donationRows: [], petRows: [], petCounts: new Map(), existing: [], tiers, masterThreshold: 10, ...over,
});

test('the donation log is replayed into tier changes, and a tier held at the import is dated to it', () => {
  const { events, notes } = plan({
    donationRows: [
      { discord_id: 'A', total_after: '80000000', source: 'import', created_at: d('2026-11-01T00:00:00Z') },
      { discord_id: 'A', total_after: '90000000', source: 'command', created_at: d('2026-11-02T00:00:00Z') },
      { discord_id: 'A', total_after: '160000000', source: 'command', created_at: d('2026-11-03T00:00:00Z') },
      { discord_id: 'A', total_after: '60000000', source: 'command', created_at: d('2026-11-04T00:00:00Z') },
    ],
  });
  assert.deepEqual(events.map(e => [e.oldValue, e.newValue, e.data.basis]), [
    [null, 'Ruby', 'import'], ['Ruby', 'Diamond', 'log'], ['Diamond', null, 'log'],
  ]);
  assert.equal(notes.importedBasis, 1);
});

test('the pet log is replayed from the count the member started with', () => {
  const rows = ['add', 'add', 'remove', 'remove'].map((action, i) => ({ discord_id: 'B', action, created_at: d(`2026-11-0${i + 1}T00:00:00Z`) }));
  const { events } = plan({ petRows: rows, petCounts: new Map([['B', 9]]) });
  assert.deepEqual(events.map(e => [e.kind, e.data.pets]), [['pet_master_reached', 10], ['pet_master_lost', 9]]);

  // 12 pets now with one logged removal: they started with 13, so no crossing is known.
  const early = plan({ petRows: [{ discord_id: 'C', action: 'remove', created_at: d('2026-11-01T00:00:00Z') }], petCounts: new Map([['C', 12]]) });
  assert.deepEqual(early.events, []);
  assert.equal(early.notes.alreadyMasterBeforeLog, 1);
});

test('a milestone within a few seconds of a saved one is the same event', () => {
  const at = d('2026-11-03T00:00:00Z');
  const { events } = plan({
    donationRows: [{ discord_id: 'D', total_after: '160000000', source: 'command', created_at: at }],
    existing: [{ member_id: 'D', kind: 'donation_tier_changed', new_value: 'Diamond', occurred_at: new Date(at.getTime() + 800) }],
  });
  assert.deepEqual(events, []);
  const later = plan({
    donationRows: [{ discord_id: 'D', total_after: '160000000', source: 'command', created_at: at }],
    existing: [{ member_id: 'D', kind: 'donation_tier_changed', new_value: 'Diamond', occurred_at: new Date(at.getTime() + 60_000) }],
  });
  assert.equal(later.events.length, 1);
});

test('the backfill previews without saving and saves the planned events when confirmed', async () => {
  const respond = sql => {
    if (/from donation_log/.test(sql)) return { rows: [{ discord_id: 'A', total_after: '80000000', source: 'command', created_at: d('2026-11-01T00:00:00Z') }] };
    return { rows: [] };
  };
  const preview = mockPg(respond);
  const result = await milestones.backfillMilestones({ tiers, masterThreshold: 10, apply: false, db: preview.pool });
  assert.deepEqual(result.counts, { tierChanges: 1, masterReached: 0, masterLost: 0 });
  assert.equal(preview.find(/insert into member_events/).length, 0);

  const apply = mockPg(respond);
  await milestones.backfillMilestones({ tiers, masterThreshold: 10, apply: true, db: apply.pool });
  const insert = apply.find(/insert into member_events/)[0];
  assert.match(insert.sql, /'bot'/);
  assert.match(insert.sql, /on conflict do nothing/);
  assert.deepEqual(insert.params[0], ['A']);
  assert.deepEqual(insert.params[1], ['donation_tier_changed']);
  assert.deepEqual(insert.params[3], ['Ruby']);
});

test('recordMilestones saves each as a bot event for the member, with who caused it', async () => {
  const db = mockPg();
  const store = highScoresDb.createStore(() => db.pool);
  await store.recordMilestones('A', [{ kind: 'pet_master_reached', oldValue: null, newValue: null, data: { pets: 10 } }], '999');
  const [call] = db.find(/insert into member_events/);
  assert.match(call.sql, /'bot', now\(\)/);
  assert.deepEqual(call.params.slice(0, 4), ['A', 'pet_master_reached', null, null]);
  assert.deepEqual(JSON.parse(call.params[4]), { pets: 10, by: '999' });
});

// ── The commands record them ─────────────────────────────────────────────────

let saved;
let recorded;
beforeEach(() => {
  saved = { ...highScoresDb };
  recorded = [];
  highScoresDb.recordMilestones = async (id, list, by) => { recorded.push({ id, list, by }); };
});
afterEach(() => { Object.assign(highScoresDb, saved); });

function interaction(subcommand, values) {
  const replies = [];
  const member = { displayName: 'Snow', joinedAt: null, roles: { cache: { has: () => false } }, user: { tag: 'snow' } };
  return {
    replies,
    interaction: {
      guild: { members: { fetch: async () => member }, roles: { cache: new Map() }, channels: { fetch: async () => { throw new Error('no channel in tests'); } } },
      user: { id: '999', tag: 'staff' },
      client: { user: { id: 'bot' }, channels: { fetch: async () => { throw new Error('no admin log'); } } },
      member: { roles: { cache: { has: () => true } } },
      options: {
        getSubcommand: () => subcommand,
        getUser: () => ({ id: '123456789012345678', tag: 'snow', username: 'snow' }),
        getString: name => values[name] ?? null,
      },
      reply: async r => { replies.push(r); },
      deferReply: async () => {},
      editReply: async r => { replies.push(r); },
    },
  };
}

test('/donationhighscore records a change of tier as a milestone, and nothing when the tier is the same', async () => {
  highScoresDb.changeDonation = async () => ({ currentAmount: 70_000_000, newAmount: 160_000_000, clamped: false, noDonationsLogged: false });
  const first = interaction('add', { amount: '90m' });
  await donation.execute(first.interaction);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].id, '123456789012345678');
  assert.equal(recorded[0].by, '999');
  assert.deepEqual([recorded[0].list[0].kind, recorded[0].list[0].oldValue, recorded[0].list[0].newValue], ['donation_tier_changed', null, 'Diamond']);

  recorded = [];
  highScoresDb.changeDonation = async () => ({ currentAmount: 160_000_000, newAmount: 170_000_000, clamped: false, noDonationsLogged: false });
  await donation.execute(interaction('add', { amount: '10m' }).interaction);
  assert.deepEqual(recorded, []);
});

test('a failure to record a milestone never fails the donation command', async () => {
  highScoresDb.changeDonation = async () => ({ currentAmount: 0, newAmount: 80_000_000, clamped: false, noDonationsLogged: false });
  highScoresDb.recordMilestones = async () => { throw new Error('db down'); };
  const { interaction: i, replies } = interaction('add', { amount: '80m' });
  await donation.execute(i);
  assert.match(replies.at(-1), /Added \*\*80,000,000\*\*/);
});

test('/pethighscore records becoming a Pet Master', async () => {
  const catalog = Array.from({ length: 12 }, (_, i) => ({ key: `p${i}`, name: `Pet ${i}`, emojiId: '' }));
  highScoresDb.getPetCatalog = async () => catalog;
  highScoresDb.getMemberPets = async () => [];
  highScoresDb.changeMemberPets = async () => ({ applied: ['p9'], skipped: [], petKeys: catalog.slice(0, 10).map(p => p.key) });
  const { interaction: i, replies } = interaction('add', { pet: 'p9' });
  await pet.execute(i);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].list[0].kind, 'pet_master_reached');
  assert.match(replies.at(-1), /They now have \*\*10\*\* pets/);

  recorded = [];
  highScoresDb.changeMemberPets = async () => ({ applied: ['p10'], skipped: [], petKeys: catalog.slice(0, 11).map(p => p.key) });
  await pet.execute(interaction('add', { pet: 'p10' }).interaction);
  assert.deepEqual(recorded, [], 'already a Pet Master, so nothing new');
});
