import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);
const sync = require('../src/utils/memberSync.js');

const noWait = async () => {};
const d = iso => new Date(iso);

// A WOM group: two current members, plus feeds.
const player = (id, name) => ({ id, username: name.toLowerCase(), displayName: name });
const details = {
  memberships: [
    { playerId: 1, groupId: 9, role: 'owner', createdAt: d('2024-01-01T00:00:00Z'), updatedAt: d('2024-02-01T00:00:00Z'), clientSyncJoinedAt: d('2023-12-25T00:00:00Z'), player: player(1, 'Alpha') },
    { playerId: 2, groupId: 9, role: 'minion', createdAt: d('2024-03-01T00:00:00Z'), updatedAt: d('2024-03-01T00:00:00Z'), clientSyncJoinedAt: null, player: player(2, 'Bravo') },
  ],
};
const activity = [
  { playerId: 2, type: 'changed_role', role: 'minion', previousRole: 'recruit', createdAt: d('2024-06-01T00:00:00Z'), player: player(2, 'Bravo') },
  { playerId: 3, type: 'left', role: null, previousRole: 'recruit', createdAt: d('2024-05-01T00:00:00Z'), player: player(3, 'Charlie') },
  { playerId: 3, type: 'joined', role: 'recruit', previousRole: null, createdAt: d('2024-04-01T00:00:00Z'), player: player(3, 'Charlie') },
  { playerId: 1, type: 'something_new', role: null, previousRole: null, createdAt: d('2024-04-01T00:00:00Z'), player: player(1, 'Alpha') },
];
const nameChanges = [
  { id: 7, playerId: 2, oldName: 'Bravo Old', newName: 'Bravo', status: 'approved', createdAt: d('2024-02-01T00:00:00Z'), resolvedAt: d('2024-02-03T00:00:00Z') },
  { id: 8, playerId: 2, oldName: 'x', newName: 'y', status: 'denied', createdAt: d('2024-02-01T00:00:00Z'), resolvedAt: null },
];

test('buildPlan makes current members active, activity-only players former members, and maps the feeds to events', () => {
  const plan = sync.buildPlan({ details, activity, nameChanges: nameChanges.filter(n => n.status === 'approved') });

  assert.deepEqual([...plan.accounts.values()].map(a => [a.womPlayerId, a.rsn, a.status, a.role]), [
    [1, 'Alpha', 'active', 'owner'],
    [2, 'Bravo', 'active', 'minion'],
    [3, 'Charlie', 'left', null],
  ]);
  const alpha = plan.accounts.get(1);
  assert.deepEqual(alpha.womJoinedAt, d('2024-01-01T00:00:00Z'));
  assert.deepEqual(alpha.clientJoinedAt, d('2023-12-25T00:00:00Z'));
  assert.equal(alpha.data.player.username, 'alpha');
  assert.equal(alpha.data.membership.role, 'owner');

  assert.deepEqual(plan.events.map(e => [e.womPlayerId, e.kind, e.oldValue, e.newValue, e.occurredAt.toISOString().slice(0, 10)]), [
    [2, 'rank_changed', 'recruit', 'minion', '2024-06-01'],
    [3, 'left', 'recruit', null, '2024-05-01'],
    [3, 'joined', null, 'recruit', '2024-04-01'],
    [2, 'name_changed', 'Bravo Old', 'Bravo', '2024-02-03'],
  ]);
});

test('readWom reads every page of each feed, paced, and keeps only approved name changes', async () => {
  const page = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const calls = [];
  const source = {
    getGroupDetails: async () => details,
    getGroupActivity: async (_id, p) => { calls.push(['activity', p.offset]); return p.offset === 0 ? page(50, i => ({ ...activity[0], playerId: 2, createdAt: d(`2024-06-${String(i % 28 + 1).padStart(2, '0')}T00:00:00Z`) })) : activity.slice(0, 3); },
    getGroupNameChanges: async (_id, p) => { calls.push(['names', p.offset]); return nameChanges; },
  };
  let waits = 0;
  const wom = await sync.readWom(source, { groupId: 9, gapMs: 1, wait: async () => { waits += 1; } });
  assert.deepEqual(calls, [['activity', 0], ['activity', 50], ['names', 0]]);
  assert.equal(wom.activity.length, 53);
  assert.deepEqual(wom.nameChanges.map(n => n.id), [7]);
  assert.equal(wom.truncated, false);
  assert.equal(waits, 3, 'a pause between each of the 4 WOM calls');
});

test('an incremental read stops at the first page that reaches back to the last saved event', async () => {
  const full = Array.from({ length: 50 }, (_, i) => ({ ...activity[0], createdAt: new Date(Date.UTC(2024, 5, 30 - i)) }));
  let pages = 0;
  const source = {
    getGroupDetails: async () => details,
    getGroupActivity: async () => { pages += 1; return full; },
    getGroupNameChanges: async () => [],
  };
  const since = Date.UTC(2024, 5, 20);
  await sync.readWom(source, { groupId: 9, activitySince: since, wait: noWait });
  assert.equal(pages, 1, 'the first page already reaches back past the cut-off');

  pages = 0;
  const limited = await sync.readWom(source, { groupId: 9, wait: noWait });
  assert.equal(pages, 400, 'with no cut-off it stops at the page limit');
  assert.equal(limited.truncated, true);
});

// A mock database for applyPlan: existing accounts by player id.
function applyDb({ existing = [], inserted = [], gone = 0 } = {}) {
  let accountId = 100;
  return mockPg((sql, params) => {
    if (/select wom_player_id, rsn, wom_role, status from accounts/.test(sql)) return { rows: existing };
    if (/insert into accounts/.test(sql)) return { rows: [{ id: ++accountId }] };
    if (/update accounts set status = 'left'/.test(sql)) return { rowCount: gone };
    if (/insert into member_events/.test(sql)) return { rows: inserted.map(kind => ({ kind })) };
  });
}

test('applyPlan counts new and changed accounts, marks absent members as left and saves the events', async () => {
  const plan = sync.buildPlan({ details, activity, nameChanges: [nameChanges[0]] });
  const db = applyDb({
    existing: [
      { wom_player_id: 1, rsn: 'Alpha', wom_role: 'owner', status: 'active' },
      { wom_player_id: 2, rsn: 'Bravo Old', wom_role: 'recruit', status: 'active' },
    ],
    inserted: ['joined', 'left', 'rank_changed', 'name_changed'],
    gone: 2,
  });
  const counts = await sync.applyPlan(db.client, plan);

  assert.equal(counts.accountsNew, 1);
  assert.equal(counts.accountsChanged, 1 + 2, 'Bravo changed, plus two no longer in the group');
  assert.equal(counts.accountsMarkedLeft, 2);
  assert.deepEqual(counts.events, { joined: 1, left: 1, rank_changed: 1, name_changed: 1 });

  const gone = db.find(/update accounts set status = 'left'/)[0];
  assert.deepEqual(gone.params, [[1, 2, 3]]);
  const events = db.find(/insert into member_events/)[0];
  assert.match(events.sql, /on conflict do nothing/);
  assert.deepEqual(events.params[0], [102, 103, 103, 102], 'events are attached to the saved account ids');
  assert.deepEqual(events.params[1], ['rank_changed', 'left', 'joined', 'name_changed']);
  assert.ok(db.find(/update accounts a set/).length === 1, 'first join and leave dates are recomputed');
});

test('events for players WOM did not list are skipped, not saved', async () => {
  const plan = sync.buildPlan({ details, activity: [], nameChanges: [] });
  plan.events.push({ womPlayerId: 999, kind: 'joined', oldValue: null, newValue: null, occurredAt: d('2024-01-01T00:00:00Z'), data: {} });
  const db = applyDb();
  const counts = await sync.applyPlan(db.client, plan);
  assert.equal(counts.eventsSkipped, 1);
  assert.equal(db.find(/insert into member_events/).length, 0);
});

test('a preview applies the plan and rolls it back; a sync commits it', async () => {
  const source = { getGroupDetails: async () => details, getGroupActivity: async () => [], getGroupNameChanges: async () => [] };
  const respond = sql => {
    if (/exists \(select 1 from accounts\)/.test(sql)) return { rows: [{ has_accounts: false }] };
    if (/select wom_player_id, rsn/.test(sql)) return { rows: [] };
    if (/insert into accounts/.test(sql)) return { rows: [{ id: 1 }] };
  };
  const preview = mockPg(respond);
  const previewResult = await sync.syncMembers({ apply: false, groupId: 9, source, db: preview.pool, wait: noWait });
  assert.equal(previewResult.backfill, true);
  assert.equal(previewResult.counts.accountsNew, 2);
  assert.ok(preview.calls.some(c => c.sql === 'rollback'));
  assert.ok(!preview.calls.some(c => c.sql === 'commit'));

  const apply = mockPg(respond);
  await sync.syncMembers({ apply: true, groupId: 9, source, db: apply.pool, wait: noWait });
  assert.ok(apply.calls.some(c => c.sql === 'commit'));
});

test('after the first sync only the recent history is read, and only one sync runs at a time', async () => {
  let activitySince;
  const newest = new Date('2024-06-01T00:00:00Z');
  const db = mockPg(sql => {
    if (/exists \(select 1 from accounts\)/.test(sql)) return { rows: [{ has_accounts: true }] };
    if (/max\(occurred_at\)/.test(sql)) return { rows: [{ t: newest }] };
    if (/select wom_player_id, rsn/.test(sql)) return { rows: [] };
    if (/insert into accounts/.test(sql)) return { rows: [{ id: 1 }] };
  });
  let release;
  const source = {
    getGroupDetails: async () => { await new Promise(resolve => { release = resolve; }); return details; },
    getGroupActivity: async (_id, p) => { activitySince = p; return []; },
    getGroupNameChanges: async () => [],
  };
  const first = sync.syncMembers({ apply: false, groupId: 9, source, db: db.pool, wait: noWait });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(sync.syncMembers({ apply: false, groupId: 9, source, db: db.pool, wait: noWait }), /already running/);
  release();
  const result = await first;
  assert.equal(result.backfill, false);
  assert.ok(activitySince, 'the activity feed was read');
});

test('verifyMembers lists members missing, wrongly ranked, renamed or no longer in the group', async () => {
  const db = mockPg(() => ({
    rows: [
      { wom_player_id: 1, rsn: 'Alpha', wom_role: 'owner', status: 'active' },
      { wom_player_id: 2, rsn: 'Old Bravo', wom_role: 'recruit', status: 'left' },
      { wom_player_id: 5, rsn: 'Echo', wom_role: 'minion', status: 'active' },
    ],
  }));
  const source = { getGroupDetails: async () => details };
  const { differences, members } = await sync.verifyMembers({ groupId: 9, source, db: db.pool });
  assert.equal(members, 2);
  assert.deepEqual(differences, [
    'Bravo (WOM 2): in the WOM group, saved as left.',
    'Bravo (WOM 2): WOM rank is minion, saved as recruit.',
    'Bravo (WOM 2): saved under the name Old Bravo.',
    'Echo (WOM 5): saved as active, not in the WOM group.',
  ]);

  const clean = mockPg(() => ({ rows: details.memberships.map(m => ({ wom_player_id: m.playerId, rsn: m.player.displayName, wom_role: m.role, status: 'active' })) }));
  assert.deepEqual((await sync.verifyMembers({ groupId: 9, source, db: clean.pool })).differences, []);
});

test('memberDataStatus turns the counts into Numbers and dates', async () => {
  const db = mockPg(sql => {
    if (/from accounts/.test(sql)) return { rows: [{ total: '368', active: '261', left_group: '107', linked: '0', synced_at: d('2026-11-10T20:00:00Z') }] };
    return { rows: [{ kind: 'joined', n: '372', newest: d('2026-11-08T00:00:00Z') }] };
  });
  const status = await sync.memberDataStatus(db.pool);
  assert.deepEqual(status.accounts, { total: 368, active: 261, left: 107, linked: 0, syncedAt: d('2026-11-10T20:00:00Z') });
  assert.deepEqual(status.events, [{ kind: 'joined', count: 372, newest: d('2026-11-08T00:00:00Z') }]);
});

test('the automatic sync interval defaults to 60 minutes; 0 turns it off', () => {
  const saved = process.env.MEMBER_SYNC_INTERVAL_MINUTES;
  try {
    delete process.env.MEMBER_SYNC_INTERVAL_MINUTES;
    assert.equal(sync.syncIntervalMinutes(), 60);
    process.env.MEMBER_SYNC_INTERVAL_MINUTES = '15';
    assert.equal(sync.syncIntervalMinutes(), 15);
    process.env.MEMBER_SYNC_INTERVAL_MINUTES = '0';
    assert.equal(sync.syncIntervalMinutes(), 0);
    process.env.MEMBER_SYNC_INTERVAL_MINUTES = '-3';
    assert.equal(sync.syncIntervalMinutes(), 60);
  } finally {
    if (saved === undefined) delete process.env.MEMBER_SYNC_INTERVAL_MINUTES; else process.env.MEMBER_SYNC_INTERVAL_MINUTES = saved;
  }
});

test('the timer does nothing without the database, a group, or with the interval at 0', () => {
  const saved = { ...process.env };
  try {
    delete process.env.DATABASE_URL;
    process.env.WOM_GROUP_ID = '9';
    sync.startMemberSync()();
    process.env.DATABASE_URL = 'postgres://x';
    delete process.env.WOM_GROUP_ID;
    sync.startMemberSync()();
    process.env.WOM_GROUP_ID = '9';
    process.env.MEMBER_SYNC_INTERVAL_MINUTES = '0';
    sync.startMemberSync()();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});


// ── The automatic sync and its alerts ────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
function fakeRun(over = {}) {
  const sent = [];
  let clock = 1_000_000_000_000;
  const state = {
    sent,
    advance: ms => { clock += ms; },
    run: (deps = {}) => sync.automaticRun({
      client: { tag: 'client' }, groupId: 9, intervalMinutes: 60,
      deps: {
        isEmpty: async () => false,
        syncMembers: async () => ({ counts: { accountsNew: 1, accountsChanged: 2, events: { joined: 3, left: 0 } }, truncated: false }),
        competitionStatus: async () => ({ competitions: 0 }),
        syncCompetitions: async () => ({ competitions: 0 }),
        notify: async (client, title, description, fields, color) => { sent.push({ client, title, description, color }); },
        now: () => clock,
        ...over, ...deps,
      },
    }),
  };
  return state;
}

test('a working automatic sync records its summary and sends no alert', async () => {
  sync.resetAutomaticState();
  const t = fakeRun({ competitionStatus: async () => ({ competitions: 5 }), syncCompetitions: async () => ({ competitions: 2 }) });
  await t.run();
  assert.deepEqual(t.sent, []);
  const last = sync.lastAutomaticRun();
  assert.equal(last.ok, true);
  assert.match(last.summary, /1 new and 2 changed accounts, 3 new events, 2 competition\(s\)/);
});

test('a failure alerts the admin log once, repeats only after six hours, and a recovery is announced', async () => {
  sync.resetAutomaticState();
  const t = fakeRun({ syncMembers: async () => { throw new Error('WOM is down'); } });
  await t.run();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].title, '⚠️ Member sync failed');
  assert.match(t.sent[0].description, /WOM is down/);
  assert.match(t.sent[0].description, /every 60 minutes/);
  assert.deepEqual(t.sent[0].client, { tag: 'client' });
  assert.equal(sync.lastAutomaticRun().ok, false);
  assert.equal(sync.lastAutomaticRun().error, 'WOM is down');

  t.advance(HOUR);
  await t.run();
  t.advance(HOUR);
  await t.run();
  assert.equal(t.sent.length, 1, 'still failing, but no new alert within six hours');

  t.advance(5 * HOUR);
  await t.run();
  assert.equal(t.sent.length, 2, 'repeated after six hours');

  await t.run({ syncMembers: async () => ({ counts: { accountsNew: 0, accountsChanged: 0, events: {} }, truncated: false }) });
  assert.equal(t.sent.length, 3);
  assert.equal(t.sent[2].title, '✅ Member sync recovered');
  assert.match(t.sent[2].description, /failing since <t:\d+:R>/);
  assert.equal(sync.lastAutomaticRun().ok, true);

  await t.run({ syncMembers: async () => ({ counts: { accountsNew: 0, accountsChanged: 0, events: {} }, truncated: false }) });
  assert.equal(t.sent.length, 3, 'no second recovery message');
});

test('a competition failure is reported as such, and a manual sync in progress is not a failure', async () => {
  sync.resetAutomaticState();
  const t = fakeRun({
    competitionStatus: async () => ({ competitions: 3 }),
    syncCompetitions: async () => { throw new Error('WOM rate limited'); },
  });
  await t.run();
  assert.match(t.sent[0].description, /Saving finished competitions: WOM rate limited/);

  sync.resetAutomaticState();
  const busy = fakeRun({ syncMembers: async () => { throw Object.assign(new Error('A member data sync is already running'), { code: 'SYNC_RUNNING' }); } });
  await busy.run();
  assert.deepEqual(busy.sent, []);
  assert.equal(sync.lastAutomaticRun(), null);
});

test('before the first manual sync the automatic one waits, quietly', async () => {
  sync.resetAutomaticState();
  let called = false;
  const t = fakeRun({ isEmpty: async () => true, syncMembers: async () => { called = true; } });
  await t.run();
  assert.equal(called, false);
  assert.deepEqual(t.sent, []);
  assert.equal(sync.lastAutomaticRun(), null);
});
