import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);
const comps = require('../src/utils/competitionSync.js');

const noWait = async () => {};
const d = iso => new Date(iso);
const player = (id, name) => ({ id, username: name.toLowerCase(), displayName: name });
const details = (id, over = {}) => ({
  id, title: `Comp ${id}`, metric: 'zulrah', metrics: [{ metric: 'zulrah', weight: 1 }],
  startsAt: d('2026-10-01T00:00:00Z'), endsAt: d('2026-10-08T00:00:00Z'), participantCount: 5,
  participations: [
    { player: player(1, 'Alpha'), progress: { gained: 50 } },
    { player: player(2, 'Bravo'), progress: { gained: 80 } },
    { player: player(3, 'Charlie'), progress: { gained: 50 } },
    { player: player(4, 'Delta'), progress: { gained: 0 } },
    { player: player(5, 'Echo'), progress: { gained: 10 } },
  ],
  ...over,
});

test('resultsFrom keeps players who gained, highest first, with ties sharing a place', () => {
  const results = comps.resultsFrom(details(1));
  assert.deepEqual(results.map(r => [r.rsn, r.gained, r.rank]), [
    ['Bravo', 80, 1], ['Alpha', 50, 2], ['Charlie', 50, 2], ['Echo', 10, 4],
  ]);
  assert.deepEqual(comps.resultsFrom({ participations: [] }), []);
});

test('saveCompetition saves the competition with its totals and the results with their accounts', async () => {
  const db = mockPg();
  const count = await comps.saveCompetition(db.client, details(7));
  assert.equal(count, 4);

  const [competition] = db.find(/insert into competitions/);
  assert.deepEqual(competition.params.slice(0, 4), [7, 'Comp 7', 'zulrah', ['zulrah']]);
  assert.equal(competition.params[7], 190, 'the total gained');
  assert.match(competition.sql, /on conflict \(wom_competition_id\) do nothing/);

  const [results] = db.find(/insert into competition_results/);
  assert.match(results.sql, /left join accounts a on a\.wom_player_id = u\.player_id/);
  assert.deepEqual(results.params[0], 7);
  assert.deepEqual(results.params[1], [2, 1, 3, 5]);
  assert.deepEqual(results.params[3], [1, 2, 2, 4]);
});

function source(all, byId = {}) {
  return {
    getCompetitions: async () => all,
    getCompetitionDetails: async id => { source.read.push(id); return byId[id] ?? details(id); },
  };
}
source.read = [];

const finished = (id, end) => ({ id, endsAt: d(end) });
const dbWith = saved => mockPg(sql => {
  if (/select wom_competition_id from competitions/.test(sql)) return { rows: saved.map(id => ({ wom_competition_id: id })) };
  if (/select \(select count/.test(sql)) return { rows: [{ competitions: '2', results: '9', newest: d('2026-11-01T00:00:00Z') }] };
});

test('a sync reads only finished, unsaved competitions, newest first, up to the limit', async () => {
  source.read = [];
  const all = [
    finished(1, '2026-10-01T00:00:00Z'), finished(2, '2026-10-20T00:00:00Z'), finished(3, '2026-10-10T00:00:00Z'),
    finished(4, '2026-10-15T00:00:00Z'), { id: 99, endsAt: d('2099-01-01T00:00:00Z') },
  ];
  const db = dbWith([4]);
  const result = await comps.syncCompetitions({ groupId: 9, source: source(all), db: db.pool, limit: 2, wait: noWait });
  assert.deepEqual(source.read, [2, 3], 'the two newest unsaved ones, not the saved 4 or the one still running');
  assert.deepEqual(result, { competitions: 2, results: 8, remaining: 1 });
  assert.equal(db.calls.filter(c => c.sql === 'commit').length, 2, 'each competition is its own transaction');
  assert.match(db.find(/update competition_results r set account_id/)[0].sql, /r\.account_id is null/);
});

test('a preview counts without reading the competitions', async () => {
  source.read = [];
  const all = Array.from({ length: 5 }, (_, i) => finished(i + 1, `2026-10-0${i + 1}T00:00:00Z`));
  const preview = await comps.previewCompetitions({ groupId: 9, source: source(all), db: dbWith([]).pool, limit: 3, gapMs: 20_000 });
  assert.deepEqual(preview, { pending: 5, toRead: 3, minutes: 1 });
  assert.deepEqual(source.read, []);
});

test('only one competition sync runs at a time', async () => {
  let release;
  const slow = {
    getCompetitions: async () => [finished(1, '2026-10-01T00:00:00Z')],
    getCompetitionDetails: async () => { await new Promise(resolve => { release = resolve; }); return details(1); },
  };
  const db = dbWith([]);
  const first = comps.syncCompetitions({ groupId: 9, source: slow, db: db.pool, wait: noWait });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(comps.syncCompetitions({ groupId: 9, source: slow, db: db.pool, wait: noWait }), /already running/);
  release();
  await first;
});

test('competitionStatus returns Numbers and a date', async () => {
  assert.deepEqual(await comps.competitionStatus(dbWith([]).pool), { competitions: 2, results: 9, newest: d('2026-11-01T00:00:00Z') });
});
