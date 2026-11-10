import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);
const { parseSheets, importData } = require('../scripts/import-sheets.js');

const catalog = [
  { key: 'heron', name: 'Heron', emojiId: '1' },
  { key: 'rocky', name: 'Rocky', emojiId: '' },
];

// history: what donation_log already holds, by member: { other, last }.
function importDb(history = {}) {
  return mockPg((sql, params) => {
    if (/from donation_log where discord_id/.test(sql)) {
      const h = history[params[0]] ?? { other: 0, last: null };
      return { rows: [{ other: String(h.other), last_total: h.last === null ? null : String(h.last) }] };
    }
    if (/insert into members/.test(sql)) return { rowCount: 1 };
    if (/^\s*select/.test(sql)) return { rows: [{ n: '0' }] };
  });
}

test('parseSheets reads rows the way the commands do', () => {
  const data = parseSheets({
    donationRows: [['1', 'A', '1,500,000'], ['', 'blank id', '5'], ['2', 'B']],
    highscoreRows: [['1', 'A', 'heron, rocky ,'], ['3', 'C', '']],
    catalogRows: [['heron', 'Heron', '123'], [], ['rocky', 'Rocky']],
  });
  assert.deepEqual(data.donations, [
    { discordId: '1', displayName: 'A', donated: 1500000 },
    { discordId: '2', displayName: 'B', donated: 0 },
  ]);
  assert.deepEqual(data.highscores[0].petKeys, ['heron', 'rocky']);
  assert.deepEqual(data.highscores[1].petKeys, []);
  assert.deepEqual(data.catalog, [
    { key: 'heron', name: 'Heron', emojiId: '123' },
    { key: 'rocky', name: 'Rocky', emojiId: '' },
  ]);
});

test('imports members, totals, one import log row each, the catalog in order and owned pets', async () => {
  const db = importDb();
  const logs = [];
  await importData(db.client, {
    donations: [{ discordId: '1', displayName: 'A', donated: 100 }, { discordId: '2', displayName: 'B', donated: 0 }],
    highscores: [{ discordId: '1', displayName: 'A', petKeys: ['heron', 'rocky'] }],
    catalog,
  }, m => logs.push(m));

  assert.deepEqual(db.find(/insert into pets/).map(c => [c.params[0], c.params[2], c.params[3]]), [
    ['heron', '1', 1],
    ['rocky', null, 2],
  ]);
  assert.deepEqual(db.find(/insert into donations/).map(c => c.params), [['1', 100], ['2', 0]]);
  assert.deepEqual(db.find(/insert into donation_log/).map(c => c.params), [['1', 100, 100], ['2', 0, 0]]);
  assert.match(db.find(/insert into donation_log/)[0].sql, /'import'/);
  assert.deepEqual(db.find(/insert into member_pets/).map(c => c.params), [['1', 'heron'], ['1', 'rocky']]);
  assert.equal(db.find(/insert into member_names/).length, 2);
  assert.deepEqual(logs, []);
});

test('running it again adds no duplicate log rows', async () => {
  const db = importDb({ 1: { other: 0, last: 100 } });
  await importData(db.client, {
    donations: [{ discordId: '1', displayName: 'A', donated: 100 }],
    highscores: [],
    catalog,
  }, () => {});
  assert.equal(db.find(/insert into donation_log/).length, 0);
  assert.equal(db.find(/insert into donations/).length, 1);
});

test('a re-run after the sheet changed logs the difference', async () => {
  const db = importDb({ 1: { other: 0, last: 100 } });
  await importData(db.client, { donations: [{ discordId: '1', displayName: 'A', donated: 250 }], highscores: [], catalog }, () => {});
  assert.deepEqual(db.find(/insert into donation_log/).map(c => c.params), [['1', 150, 250]]);
});

test('a member changed in the database since the import is left alone', async () => {
  const db = importDb({ 1: { other: 2, last: 900 } });
  const logs = [];
  await importData(db.client, { donations: [{ discordId: '1', displayName: 'A', donated: 100 }], highscores: [], catalog }, m => logs.push(m));
  assert.equal(db.find(/insert into donations/).length, 0);
  assert.equal(db.find(/insert into donation_log/).length, 0);
  assert.match(logs[0], /left alone/);
});

test('pet keys missing from the catalog are warned about and skipped', async () => {
  const db = importDb();
  const logs = [];
  await importData(db.client, {
    donations: [],
    highscores: [{ discordId: '1', displayName: 'A', petKeys: ['heron', 'mystery_pet', 'heron'] }],
    catalog,
  }, m => logs.push(m));
  assert.deepEqual(db.find(/insert into member_pets/).map(c => c.params), [['1', 'heron']]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"mystery_pet".*not in the Pets catalog/);
});

test('the summary has the sheet numbers and the database numbers', async () => {
  const db = mockPg(sql => {
    if (/^\s*select/.test(sql)) {
      if (/sum\(total_gp\)/.test(sql)) return { rows: [{ n: '350' }] };
      if (/from member_pets/.test(sql) && /count/.test(sql) && !/union/.test(sql)) return { rows: [{ n: '3' }] };
      return { rows: [{ n: '2' }] };
    }
  });
  const summary = await importData(db.client, {
    donations: [{ discordId: '1', displayName: 'A', donated: 100 }, { discordId: '2', displayName: 'B', donated: 250 }],
    highscores: [{ discordId: '1', displayName: 'A', petKeys: ['heron', 'rocky', 'gone'] }],
    catalog,
  }, () => {});
  assert.deepEqual(summary.sheets, { members: 2, gp: 350, pets: 3, catalog: 2 });
  assert.equal(summary.database.gp, 350);
  assert.equal(typeof summary.database.members, 'number');
});
