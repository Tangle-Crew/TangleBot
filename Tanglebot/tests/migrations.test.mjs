import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);
const { runMigrations, MIGRATIONS_DIR } = require('../src/utils/database.js');

function migrationDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

test('applies only migrations not yet recorded, in order, each in its own transaction', async () => {
  const dir = migrationDir({
    '002_second.sql': 'create table second ();',
    '001_first.sql': 'create table first ();',
    '003_third.sql': 'create table third ();',
    'notes.txt': 'not a migration',
  });
  const db = mockPg(sql => {
    if (/select name from schema_migrations/.test(sql)) return { rows: [{ name: '001_first.sql' }] };
  });
  const logs = [];
  const ran = await runMigrations({ db: db.pool, dir, log: m => logs.push(m) });

  assert.deepEqual(ran, ['002_second.sql', '003_third.sql']);
  const sqls = db.calls.map(c => c.sql);
  assert.ok(!sqls.includes('create table first ();'));
  assert.ok(sqls.indexOf('create table second ();') < sqls.indexOf('create table third ();'));
  assert.equal(sqls.filter(s => s === 'begin').length, 2);
  assert.equal(sqls.filter(s => s === 'commit').length, 2);
  assert.deepEqual(
    db.find(/insert into schema_migrations/).map(c => c.params[0]),
    ['002_second.sql', '003_third.sql']
  );
  assert.deepEqual(logs, ['[Database] Applied migration 002_second.sql', '[Database] Applied migration 003_third.sql']);
  fs.rmSync(dir, { recursive: true });
});

test('does nothing when every migration is already recorded', async () => {
  const dir = migrationDir({ '001_first.sql': 'create table first ();' });
  const db = mockPg(sql => {
    if (/select name from schema_migrations/.test(sql)) return { rows: [{ name: '001_first.sql' }] };
  });
  const logs = [];
  assert.deepEqual(await runMigrations({ db: db.pool, dir, log: m => logs.push(m) }), []);
  assert.equal(db.find(/create table first/).length, 0);
  assert.equal(db.calls.filter(c => c.sql === 'begin').length, 0);
  assert.deepEqual(logs, ['[Database] Migrations up to date']);
  fs.rmSync(dir, { recursive: true });
});

test('skips a migration another instance applied while this one waited for the lock', async () => {
  const dir = migrationDir({ '001_first.sql': 'create table first ();' });
  const db = mockPg(sql => {
    if (/select 1 from schema_migrations/.test(sql)) return { rows: [{ '?column?': 1 }] };
  });
  assert.deepEqual(await runMigrations({ db: db.pool, dir, log: () => {} }), []);
  assert.equal(db.find(/create table first/).length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('a failing migration is rolled back, named in the error, and stops the later ones', async () => {
  const dir = migrationDir({
    '001_first.sql': 'create table first ();',
    '002_bad.sql': 'this is not sql;',
    '003_third.sql': 'create table third ();',
  });
  const db = mockPg(sql => {
    if (sql === 'this is not sql;') throw new Error('syntax error at or near "this"');
  });
  await assert.rejects(
    runMigrations({ db: db.pool, dir, log: () => {} }),
    err => /Migration 002_bad\.sql failed: syntax error/.test(err.message)
  );
  const sqls = db.calls.map(c => c.sql);
  assert.ok(sqls.includes('rollback'));
  assert.ok(!sqls.includes('create table third ();'));
  assert.deepEqual(db.find(/insert into schema_migrations/).map(c => c.params[0]), ['001_first.sql']);
  fs.rmSync(dir, { recursive: true });
});

test('the repo migrations are numbered in order and 001 has the high score tables', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 2);
  files.forEach((f, i) => assert.equal(f.slice(0, 3), String(i + 1).padStart(3, '0')));
  const first = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_high_scores.sql'), 'utf8');
  for (const table of ['members', 'donations', 'donation_log', 'pets', 'member_pets', 'pet_log']) {
    assert.match(first, new RegExp(`create table ${table} \\(`));
  }
});

test('losing the race to create schema_migrations is not an error', async () => {
  const dir = migrationDir({ '001_first.sql': 'create table first ();' });
  const db = mockPg(sql => {
    if (/create table if not exists schema_migrations/.test(sql)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
  });
  assert.deepEqual(await runMigrations({ db: db.pool, dir, log: () => {} }), ['001_first.sql']);
  fs.rmSync(dir, { recursive: true });
});
