import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);
const { verifyData } = require('../scripts/import-sheets.js');

const data = {
  catalog: [{ key: 'heron', name: 'Heron', emojiId: '1' }, { key: 'rocky', name: 'Rocky', emojiId: '' }],
  donations: [
    { discordId: '1', displayName: 'A', donated: 100 },
    { discordId: '2', displayName: 'B', donated: 250 },
  ],
  highscores: [{ discordId: '1', displayName: 'A', petKeys: ['heron', 'rocky', 'gone'] }],
};

// The database as the import leaves it, with overrides per table.
function db(over = {}) {
  const tables = {
    pets: [{ key: 'heron', name: 'Heron', emoji_id: '1' }, { key: 'rocky', name: 'Rocky', emoji_id: null }],
    donations: [{ discord_id: '1', total_gp: '100' }, { discord_id: '2', total_gp: '250' }],
    donation_log: [],
    member_pets: [{ discord_id: '1', pet_key: 'heron' }, { discord_id: '1', pet_key: 'rocky' }],
    pet_log: [],
    ...over,
  };
  return mockPg(sql => {
    if (/from pets/.test(sql)) return { rows: tables.pets };
    if (/from donation_log/.test(sql)) return { rows: tables.donation_log };
    if (/from donations/.test(sql)) return { rows: tables.donations };
    if (/from member_pets/.test(sql)) return { rows: tables.member_pets };
    if (/from pet_log/.test(sql)) return { rows: tables.pet_log };
  }).pool;
}

test('a faithful import verifies clean, with a note for the pet key the import skipped', async () => {
  const { differences, notes } = await verifyData(db(), data);
  assert.deepEqual(differences, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /not in the catalog.*gone/);
});

test('wrong totals, missing donors and pet differences are listed per member', async () => {
  const { differences } = await verifyData(db({
    donations: [{ discord_id: '1', total_gp: '90' }],
    member_pets: [{ discord_id: '1', pet_key: 'heron' }, { discord_id: '1', pet_key: 'zulrah' }, { discord_id: '9', pet_key: 'heron' }],
  }), data);
  assert.deepEqual(differences, [
    'A (1): sheet has 100 GP donated, database has 90.',
    'B (2): sheet has 250 GP donated, the database has no row.',
    'A (1): missing from the database: rocky.',
    'A (1): in the database but not on the sheet: zulrah.',
    '1 member(s) have pets in the database but are not on the Highscores tab.',
  ]);
});

test('catalog differences are reported: missing, renamed and reordered pets', async () => {
  const missing = await verifyData(db({ pets: [{ key: 'heron', name: 'Heron', emoji_id: '1' }] }), data);
  assert.ok(missing.differences.includes('Pet "rocky" is on the Pets tab but not in the database.'));

  const renamed = await verifyData(db({ pets: [{ key: 'heron', name: 'Heron!', emoji_id: '1' }, { key: 'rocky', name: 'Rocky', emoji_id: null }] }), data);
  assert.match(renamed.differences[0], /Pet "heron": sheet has "Heron"/);

  const reordered = await verifyData(db({ pets: [{ key: 'rocky', name: 'Rocky', emoji_id: null }, { key: 'heron', name: 'Heron', emoji_id: '1' }] }), data);
  assert.deepEqual(reordered.differences, ['The pet catalog is in a different order than the Pets tab.']);
});

test('members changed since the import, and new pets, are notes and not differences', async () => {
  const { differences, notes } = await verifyData(db({
    pets: [
      { key: 'heron', name: 'Heron', emoji_id: '1' }, { key: 'rocky', name: 'Rocky', emoji_id: null },
      { key: 'zulrah', name: 'Zulrah', emoji_id: null },
    ],
    donations: [{ discord_id: '1', total_gp: '5000' }, { discord_id: '2', total_gp: '250' }, { discord_id: '3', total_gp: '7' }],
    donation_log: [{ discord_id: '1' }],
    member_pets: [{ discord_id: '1', pet_key: 'heron' }],
    pet_log: [{ discord_id: '1' }],
  }), data);
  assert.deepEqual(differences, []);
  assert.ok(notes.some(n => /zulrah/.test(n)));
  assert.ok(notes.some(n => /A \(1\): donations changed/.test(n)));
  assert.ok(notes.some(n => /A \(1\): pets changed/.test(n)));
  assert.ok(notes.some(n => /1 donor\(s\) only in the database/.test(n)));
});
