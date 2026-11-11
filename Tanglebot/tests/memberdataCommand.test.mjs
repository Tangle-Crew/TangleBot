import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

Object.assign(process.env, { DATABASE_URL: 'postgres://u:p@host:5432/db', WOM_GROUP_ID: '9', OWNER_ROLE_ID: 'owner' });
delete process.env.MEMBER_SYNC_INTERVAL_MINUTES;

const { commandDisabledReason } = require('../src/utils/commandAvailability.js');
const memberSync = require('../src/utils/memberSync.js');
const milestones = require('../src/utils/milestones.js');
const competitionSync = require('../src/utils/competitionSync.js');
const command = require('../src/commands/memberdata.js');

let saved;
let savedMilestones;
let savedCompetitions;
beforeEach(() => { saved = { ...memberSync }; savedMilestones = { ...milestones }; savedCompetitions = { ...competitionSync }; });
afterEach(() => { Object.assign(memberSync, saved); Object.assign(milestones, savedMilestones); Object.assign(competitionSync, savedCompetitions); });

function run(subcommand, { owner = true, confirm } = {}) {
  const replies = [];
  const interaction = {
    user: { id: '1', tag: 'someone' },
    member: { roles: { cache: { has: id => owner && id === 'owner' } } },
    options: { getSubcommand: () => subcommand, getBoolean: () => confirm },
    reply: async r => { replies.push(r); },
    deferReply: async () => {},
    editReply: async r => { replies.push(r); },
  };
  return command.execute(interaction).then(() => ({ replies, interaction }));
}

const counts = (over = {}) => ({
  accountsNew: 368, accountsChanged: 0, accountsMarkedLeft: 0, eventsSkipped: 0,
  events: { joined: 372, left: 113, rank_changed: 1265, name_changed: 182 }, ...over,
});

test('/memberdata needs the database, the WOM group and the Owner role', () => {
  const env = { DATABASE_URL: 'postgres://x', WOM_GROUP_ID: '9', OWNER_ROLE_ID: 'o' };
  assert.equal(commandDisabledReason(command, env), null);
  for (const key of Object.keys(env)) assert.match(commandDisabledReason(command, { ...env, [key]: '' }), new RegExp(key));
});

test('it offers status, preview, sync, competitions, milestones and verify, and sync needs a confirm', () => {
  const options = command.data.toJSON().options;
  assert.deepEqual(options.map(o => o.name), ['status', 'preview', 'sync', 'competitions', 'milestones', 'verify']);
  const confirm = options.find(o => o.name === 'sync').options[0];
  assert.equal(confirm.name, 'confirm');
  assert.equal(confirm.required, true);
});

test('only the Owner can use it; anyone else is refused, told, and logged as denied', async () => {
  let called = false;
  memberSync.syncMembers = async () => { called = true; };
  const { replies, interaction } = await run('sync', { owner: false, confirm: true });
  assert.equal(called, false);
  assert.match(replies[0].content, /Only the Owner role/);
  assert.equal(interaction.commandDenied, true);
});

test('status shows the accounts, the history counts and the automatic sync setting', async () => {
  competitionSync.competitionStatus = async () => ({ competitions: 24, results: 288, newest: new Date('2026-11-07T16:00:00Z') });
  memberSync.memberDataStatus = async () => ({
    accounts: { total: 368, active: 261, left: 107, linked: 0, syncedAt: new Date('2026-11-10T20:00:00Z') },
    events: [{ kind: 'joined', count: 372, newest: new Date('2026-11-08T02:03:47Z') }, { kind: 'rank_changed', count: 1265, newest: null }],
  });
  const { replies } = await run('status');
  assert.match(replies[0], /Accounts: 368 \(261 in the group, 107 left, 0 linked to a person\)/);
  assert.match(replies[0], /Last synced: 2026-11-10T20:00:00.000Z/);
  assert.match(replies[0], /372 joined the clan, newest 2026-11-08/);
  assert.match(replies[0], /1,265 rank changes, newest none/);
  assert.match(replies[0], /every 60 minutes, once the first sync has been run/);
  assert.match(replies[0], /Competitions: 24 saved, 288 results, newest ended 2026-11-07/);
});

test('preview reads without saving and reports what a sync would change', async () => {
  let args;
  memberSync.syncMembers = async a => { args = a; return { counts: counts(), backfill: true, truncated: false }; };
  const { replies } = await run('preview');
  assert.equal(args.apply, false);
  assert.equal(args.groupId, 9);
  assert.match(replies.at(-1), /Preview \(nothing was saved\)/);
  assert.match(replies.at(-1), /First read: the whole WOM history/);
  assert.match(replies.at(-1), /Accounts: 368 new, 0 changed/);
  assert.match(replies.at(-1), /372 joined the clan, 113 left the clan, 1,265 rank changes, 182 name changes/);
});

test('sync without confirm does nothing', async () => {
  let called = false;
  memberSync.syncMembers = async () => { called = true; };
  const { replies } = await run('sync', { confirm: false });
  assert.equal(called, false);
  assert.match(replies[0], /Nothing was synced/);
});

test('sync with confirm saves, then checks against WOM', async () => {
  let args;
  memberSync.syncMembers = async a => { args = a; return { counts: counts(), backfill: false, truncated: true }; };
  memberSync.verifyMembers = async () => ({ differences: [], members: 261 });
  const { replies } = await run('sync', { confirm: true });
  assert.equal(args.apply, true);
  assert.match(replies.at(-1), /Synced:/);
  assert.match(replies.at(-1), /Stopped at the page limit/);
  assert.match(replies.at(-1), /Checked against WOM: no differences/);

  memberSync.verifyMembers = async () => ({ differences: ['x', 'y'], members: 261 });
  const again = await run('sync', { confirm: true });
  assert.match(again.replies.at(-1), /2 difference\(s\) from WOM afterwards/);
});

test('verify lists differences, cut to a few with a count of the rest', async () => {
  memberSync.verifyMembers = async () => ({ differences: Array.from({ length: 20 }, (_, i) => `member ${i} differs`), members: 261 });
  const { replies } = await run('verify');
  assert.match(replies[0], /20 difference\(s\) from the 261 members/);
  assert.match(replies[0], /member 14 differs/);
  assert.doesNotMatch(replies[0], /member 15 differs/);
  assert.match(replies[0], /and 5 more/);

  memberSync.verifyMembers = async () => ({ differences: [], members: 261 });
  assert.match((await run('verify')).replies[0], /Verified: the 261 members in the WOM group match/);
});

test('a WOM or database failure is shown and logged as an error', async () => {
  memberSync.syncMembers = async () => { throw new Error('WOM is down'); };
  const { replies, interaction } = await run('preview');
  assert.match(replies.at(-1), /memberdata preview failed: WOM is down/);
  assert.equal(interaction.commandError.message, 'WOM is down');
});

test('milestones previews unless confirmed, then saves, and explains what cannot be dated', async () => {
  const calls = [];
  milestones.backfillMilestones = async args => {
    calls.push(args.apply);
    return { counts: { tierChanges: 12, masterReached: 4, masterLost: 1 }, notes: { importedBasis: 9, alreadyMasterBeforeLog: 2 }, applied: args.apply };
  };
  const preview = await run('milestones');
  assert.deepEqual(calls, [false]);
  assert.match(preview.replies.at(-1), /Preview \(nothing was saved\)/);
  assert.match(preview.replies.at(-1), /12 donation tier changes/);
  assert.match(preview.replies.at(-1), /4 Pet Master reached, 1 Pet Master lost/);
  assert.match(preview.replies.at(-1), /9 tier\(s\) were held at the sheets import/);
  assert.match(preview.replies.at(-1), /2 member\(s\) were already Pet Masters/);
  assert.match(preview.replies.at(-1), /Run again with confirm set to True/);

  const saved = await run('milestones', { confirm: true });
  assert.deepEqual(calls, [false, true]);
  assert.match(saved.replies.at(-1), /Milestones saved from the donation and pet logs/);
  assert.doesNotMatch(saved.replies.at(-1), /Run again/);
});

test('competitions previews unless confirmed, then saves a batch and says how many remain', async () => {
  let previewArgs;
  competitionSync.previewCompetitions = async args => { previewArgs = args; return { pending: 69, toRead: 69, minutes: 5 }; };
  let syncCalls = 0;
  competitionSync.syncCompetitions = async () => { syncCalls += 1; return { competitions: 120, results: 1500, remaining: 30 }; };

  const preview = await run('competitions');
  assert.equal(previewArgs.groupId, 9);
  assert.equal(syncCalls, 0);
  assert.match(preview.replies.at(-1), /69 finished competitions are not saved yet/);
  assert.match(preview.replies.at(-1), /about 5 minute\(s\)/);
  assert.match(preview.replies.at(-1), /confirm set to True/);

  const saved = await run('competitions', { confirm: true });
  assert.equal(syncCalls, 1);
  assert.match(saved.replies.at(-1), /Saved 120 competitions and 1,500 results/);
  assert.match(saved.replies.at(-1), /30 more are not saved yet: run it again/);

  competitionSync.syncCompetitions = async () => ({ competitions: 3, results: 20, remaining: 0 });
  assert.match((await run('competitions', { confirm: true })).replies.at(-1), /Every finished competition is saved/);
});
