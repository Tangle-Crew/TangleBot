import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);
const dbUtils = require('../src/utils/db.js');
const database = require('../src/utils/database.js');
const state = require('../src/utils/state.js');

// Real files in data/, under names nothing else uses; removed after each test.
const A = 'zz-test-state-a.json';
const B = 'zz-test-state-b.json';
const file = name => path.join(dbUtils.DATA_DIR, name);
const remove = () => { for (const f of [A, B]) fs.rmSync(file(f), { force: true }); };

let savedGetPool;
beforeEach(() => {
  remove();
  state.resetState();
  savedGetPool = database.getPool;
  process.env.DATABASE_URL = 'postgres://u:p@host:5432/db';
});
afterEach(() => {
  remove();
  state.resetState();
  database.getPool = savedGetPool;
});

const rowsFor = rows => mockPg(sql => (/select key, value from bot_state/.test(sql) ? { rows } : undefined));

test('without a database, readState and writeState are readJson and writeJson', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.deepEqual(await state.hydrateState(), { loaded: 0, imported: 0, restored: 0 });
    state.writeState(A, { messageIds: ['1'] });
    assert.deepEqual(JSON.parse(fs.readFileSync(file(A), 'utf8')), { messageIds: ['1'] });
    assert.deepEqual(state.readState(A), { messageIds: ['1'] });
    assert.deepEqual(state.readState(B), {});
  } finally {
    process.env.DATABASE_URL = saved;
  }
});

test('hydrating copies a file with no saved state into the table, and writes a missing file back from it', async () => {
  fs.writeFileSync(file(A), JSON.stringify({ messageIds: ['10', '11'] }));
  const pg = rowsFor([{ key: B, value: { testMode: true } }]);
  const result = await state.hydrateState({ pool: pg.pool, files: [A, B] });

  assert.deepEqual(result, { loaded: 1, imported: 1, restored: 1 });
  const upsert = pg.find(/insert into bot_state/)[0];
  assert.deepEqual(upsert.params, [A, JSON.stringify({ messageIds: ['10', '11'] })]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file(B), 'utf8')), { testMode: true }, 'the lost file is back');
  assert.deepEqual(state.readState(A), { messageIds: ['10', '11'] });
  assert.deepEqual(state.readState(B), { testMode: true });
});

test('the saved state wins over a file when both exist, and an existing file is left alone', async () => {
  fs.writeFileSync(file(A), JSON.stringify({ old: true }));
  const pg = rowsFor([{ key: A, value: { fresh: true } }]);
  const result = await state.hydrateState({ pool: pg.pool, files: [A] });
  assert.deepEqual(result, { loaded: 1, imported: 0, restored: 0 });
  assert.deepEqual(state.readState(A), { fresh: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file(A), 'utf8')), { old: true }, 'the file is not overwritten');
});

test('a write goes to the file, to memory and to the table; a read returns a copy', async () => {
  const pg = rowsFor([]);
  database.getPool = () => pg.pool;
  await state.hydrateState({ pool: pg.pool, files: [] });

  const value = { list: { header: '1' } };
  state.writeState(A, value);
  await state.flushState();
  assert.deepEqual(JSON.parse(fs.readFileSync(file(A), 'utf8')), value);
  assert.deepEqual(pg.find(/insert into bot_state/).at(-1).params, [A, JSON.stringify(value)]);

  value.list.header = 'changed after writing';
  assert.equal(state.readState(A).list.header, '1', 'later changes to the object do not leak in');
  const read = state.readState(A);
  read.list.header = 'changed after reading';
  assert.equal(state.readState(A).list.header, '1', 'a read is a copy');
});

test('a failed save to the table is logged and never stops the write', async () => {
  const pg = mockPg(sql => {
    if (/select key, value/.test(sql)) return { rows: [] };
    if (/insert into bot_state/.test(sql)) throw new Error('db down');
  });
  database.getPool = () => pg.pool;
  await state.hydrateState({ pool: pg.pool, files: [] });
  state.writeState(A, { ok: true });
  await state.flushState();
  assert.deepEqual(state.readState(A), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file(A), 'utf8')), { ok: true });
});

test('before the state is loaded, or if loading failed, the files are used', async () => {
  fs.writeFileSync(file(A), JSON.stringify({ from: 'file' }));
  assert.deepEqual(state.readState(A), { from: 'file' });
  const failing = { query: async () => { throw new Error('db down'); } };
  await assert.rejects(state.hydrateState({ pool: failing, files: [A] }), /db down/);
  assert.deepEqual(state.readState(A), { from: 'file' });
  state.writeState(A, { from: 'file', again: true }); // not loaded: nothing is sent to a database
  assert.deepEqual(JSON.parse(fs.readFileSync(file(A), 'utf8')), { from: 'file', again: true });
});

test('the files that are mirrored are the simple ones', () => {
  assert.deepEqual(state.STATE_FILES.sort(), [
    'donationhighscores_message.json', 'honeypot-runtime-config.json', 'last-submission.json', 'lfg-start-post.json',
    'pethighscores_message.json', 'stalemembers.json', 'submission-runtime-config.json',
  ]);
  // The ones whose "claim once" logic relies on the files stay out.
  assert.ok(!state.STATE_FILES.includes('weeklyannounce.json'));
  assert.ok(!state.STATE_FILES.includes('lfg-groups.json'));
});
