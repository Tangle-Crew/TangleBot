import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);
const { createStore, MAX_TOTAL_GP } = require('../src/utils/highScoresDb.js');

const MEMBER = { discordId: '111111111111111111', displayName: 'Snow', joinedAt: new Date('2024-03-01T12:00:00Z'), byDiscordId: '999' };

// A mock where the donations row holds `total` (a bigint, so a string like pg returns).
function donationDb(total) {
  const db = mockPg(sql => {
    if (/select total_gp from donations/.test(sql)) return { rows: total === null ? [] : [{ total_gp: total }] };
  });
  return { ...db, store: createStore(() => db.pool) };
}

test('adding a donation upserts the member, updates the total and writes a log row in one transaction', async () => {
  const { store, calls, find } = donationDb('50000000');
  const result = await store.changeDonation({ ...MEMBER, amount: 100000000, action: 'add' });

  assert.deepEqual(result, { currentAmount: 50000000, newAmount: 150000000, clamped: false, noDonationsLogged: false });
  assert.equal(calls[0].sql, 'begin');
  assert.equal(calls.at(-1).sql, 'commit');
  assert.equal(find(/insert into members/).length, 1);
  assert.deepEqual(find(/insert into members/)[0].params, [MEMBER.discordId, 'Snow']);
  assert.deepEqual(find(/update donations/)[0].params, [MEMBER.discordId, 150000000]);
  const log = find(/insert into donation_log/)[0];
  assert.deepEqual(log.params, [MEMBER.discordId, 100000000, 150000000, '999']);
  assert.match(log.sql, /'command'/);
});

test('adding for a member with no donations starts at 0', async () => {
  const db = mockPg(sql => {
    if (/select total_gp from donations/.test(sql)) return { rows: [{ total_gp: '0' }] };
  });
  const store = createStore(() => db.pool);
  const result = await store.changeDonation({ ...MEMBER, amount: 5000, action: 'add' });
  assert.equal(result.newAmount, 5000);
  assert.equal(db.find(/insert into donations/).length, 1);
});

test('removing subtracts and logs a negative change', async () => {
  const { store, find } = donationDb('200');
  const result = await store.changeDonation({ ...MEMBER, amount: 50, action: 'remove' });
  assert.deepEqual(result, { currentAmount: 200, newAmount: 150, clamped: false, noDonationsLogged: false });
  assert.deepEqual(find(/insert into donation_log/)[0].params, [MEMBER.discordId, -50, 150, '999']);
});

test('removing more than the total clamps at 0 and logs the real change', async () => {
  const { store, find } = donationDb('30');
  const result = await store.changeDonation({ ...MEMBER, amount: 100, action: 'remove' });
  assert.deepEqual(result, { currentAmount: 30, newAmount: 0, clamped: true, noDonationsLogged: false });
  assert.deepEqual(find(/update donations/)[0].params, [MEMBER.discordId, 0]);
  assert.deepEqual(find(/insert into donation_log/)[0].params, [MEMBER.discordId, -30, 0, '999']);
});

test('removing from a member with no donations writes nothing', async () => {
  for (const total of [null, '0']) {
    const { store, calls, find } = donationDb(total);
    const result = await store.changeDonation({ ...MEMBER, amount: 100, action: 'remove' });
    assert.equal(result.noDonationsLogged, true);
    assert.equal(find(/^(insert|update)/).length, 0);
    assert.equal(calls.at(-1).sql, 'commit');
  }
});

test('totals come back as Numbers, not bigint strings', async () => {
  const db = mockPg(sql => {
    if (/from donations d join members/.test(sql)) {
      return { rows: [{ discord_id: '1', display_name: 'A', total_gp: '1500000000' }] };
    }
  });
  const [entry] = await createStore(() => db.pool).getDonations();
  assert.strictEqual(entry.donated, 1500000000);
  assert.strictEqual(entry.discordId, '1');
});

test('a total over the cap, or an unsafe amount, is rejected and rolled back', async () => {
  const { store, find, calls } = donationDb(String(MAX_TOTAL_GP));
  await assert.rejects(store.changeDonation({ ...MEMBER, amount: 1, action: 'add' }), /probably a typo/);
  assert.equal(find(/update donations|insert into donation_log/).length, 0);
  assert.ok(calls.some(c => c.sql === 'rollback'));

  await assert.rejects(store.changeDonation({ ...MEMBER, amount: Number.MAX_SAFE_INTEGER + 2, action: 'add' }), /positive whole number/);
  await assert.rejects(store.changeDonation({ ...MEMBER, amount: 0, action: 'add' }), /positive whole number/);
});

test('a failed write rolls back and releases the client', async () => {
  const db = mockPg(sql => {
    if (/select total_gp from donations/.test(sql)) return { rows: [{ total_gp: '10' }] };
    if (/insert into donation_log/.test(sql)) throw new Error('boom');
  });
  const store = createStore(() => db.pool);
  await assert.rejects(store.changeDonation({ ...MEMBER, amount: 5, action: 'add' }), /boom/);
  assert.ok(db.calls.some(c => c.sql === 'rollback'));
  assert.ok(!db.calls.some(c => c.sql === 'commit'));
  assert.equal(db.client.released, true);
});

test('a name or join date is recorded with the member as events', async () => {
  const { store, find } = donationDb('0');
  await store.changeDonation({ ...MEMBER, amount: 1, action: 'add' });
  const name = find(/insert into member_events[\s\S]*display_name_changed/)[0];
  assert.deepEqual(name.params, [MEMBER.discordId, 'Snow']);
  assert.match(name.sql, /on conflict do nothing/);
  const join = find(/insert into member_events[\s\S]*server_joined/)[0];
  assert.deepEqual(join.params, [MEMBER.discordId, MEMBER.joinedAt]);

  // Without a join date (the member isn't in the server) no join is recorded.
  const other = donationDb('0');
  await other.store.changeDonation({ ...MEMBER, joinedAt: null, amount: 1, action: 'add' });
  assert.equal(other.find(/server_joined/).length, 0);
});

// ── Pets ─────────────────────────────────────────────────────────────────────

function petDb({ owned = [], deleted = [], added }) {
  const db = mockPg(sql => {
    if (/^select pet_key from member_pets/.test(sql.trim())) {
      // Called before and after the change; the second call sees the result.
      return { rows: db.changed ? db.after.map(k => ({ pet_key: k })) : owned.map(k => ({ pet_key: k })) };
    }
    if (/insert into member_pets/.test(sql)) { db.changed = true; return { rows: added.map(k => ({ pet_key: k })) }; }
    if (/delete from member_pets/.test(sql)) { db.changed = true; return { rows: deleted.map(k => ({ pet_key: k })) }; }
  });
  db.store = createStore(() => db.pool);
  return db;
}

test('adding pets skips owned ones, stores the rest and writes a pet_log row for them', async () => {
  const db = petDb({ owned: ['heron'], added: ['rocky', 'tangleroot'] });
  db.after = ['heron', 'rocky', 'tangleroot'];
  const result = await db.store.changeMemberPets({ ...MEMBER, petKeys: ['heron', 'rocky', 'tangleroot'], action: 'add' });

  assert.deepEqual(result, { applied: ['rocky', 'tangleroot'], skipped: ['heron'], petKeys: ['heron', 'rocky', 'tangleroot'] });
  assert.deepEqual(db.find(/insert into member_pets/)[0].params, [MEMBER.discordId, ['rocky', 'tangleroot'], '999']);
  const log = db.find(/insert into pet_log/)[0];
  assert.deepEqual(log.params, [MEMBER.discordId, ['rocky', 'tangleroot'], 'add', '999']);
  assert.equal(db.find(/insert into members/).length, 1);
  assert.equal(db.calls.at(-1).sql, 'commit');
});

test('adding pets the member already has writes nothing', async () => {
  const db = petDb({ owned: ['heron'], added: [] });
  const result = await db.store.changeMemberPets({ ...MEMBER, petKeys: ['heron'], action: 'add' });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, ['heron']);
  assert.equal(db.find(/^insert/).length, 0);
});

test('removing pets deletes the owned ones and logs a remove per pet', async () => {
  const db = petDb({ deleted: ['heron'] });
  db.after = ['rocky'];
  const result = await db.store.changeMemberPets({ ...MEMBER, petKeys: ['heron', 'chompy'], action: 'remove' });

  assert.deepEqual(result, { applied: ['heron'], skipped: ['chompy'], petKeys: ['rocky'] });
  assert.deepEqual(db.find(/delete from member_pets/)[0].params, [MEMBER.discordId, ['heron', 'chompy']]);
  assert.deepEqual(db.find(/insert into pet_log/)[0].params, [MEMBER.discordId, ['heron'], 'remove', '999']);
});

test('removing pets the member does not have writes nothing', async () => {
  const db = petDb({ deleted: [] });
  db.after = [];
  const result = await db.store.changeMemberPets({ ...MEMBER, petKeys: ['heron'], action: 'remove' });
  assert.deepEqual(result.applied, []);
  assert.equal(db.find(/^insert/).length, 0);
});

test('the catalog loads in sort order and a new pet goes on the end', async () => {
  const db = mockPg(sql => {
    if (/from pets order by/.test(sql)) {
      return { rows: [{ key: 'heron', name: 'Heron', emoji_id: '123' }, { key: 'rocky', name: 'Rocky', emoji_id: null }] };
    }
  });
  const store = createStore(() => db.pool);
  assert.deepEqual(await store.getPetCatalog(), [
    { key: 'heron', name: 'Heron', emojiId: '123' },
    { key: 'rocky', name: 'Rocky', emojiId: '' },
  ]);
  await store.addPetToCatalog({ key: 'new_pet', name: 'New pet', emojiId: '456' });
  const insert = db.find(/insert into pets/)[0];
  assert.deepEqual(insert.params, ['new_pet', 'New pet', '456']);
  assert.match(insert.sql, /max\(sort_order\)/);
});

test('member pets are returned with string ids', async () => {
  const db = mockPg(() => ({ rows: [{ discord_id: '5', display_name: 'B', pet_keys: ['x', 'y'] }] }));
  assert.deepEqual(await createStore(() => db.pool).getMemberPets(), [{ discordId: '5', displayName: 'B', petKeys: ['x', 'y'] }]);
});

// ── Members: names, joins and leaves ─────────────────────────────────────────

test('a leaderboard name refresh updates only the name, and records a name event only when it changed', async () => {
  const changed = mockPg(sql => (/update members/.test(sql) ? { rowCount: 1 } : undefined));
  assert.equal(await createStore(() => changed.pool).updateDisplayName({ discordId: '1', displayName: 'New' }), true);
  assert.equal(changed.find(/display_name_changed/).length, 1);
  assert.equal(changed.find(/donations|member_pets|donation_log/).length, 0);

  const same = mockPg(sql => (/update members/.test(sql) ? { rowCount: 0 } : undefined));
  assert.equal(await createStore(() => same.pool).updateDisplayName({ discordId: '1', displayName: 'Same' }), false);
  assert.equal(same.find(/display_name_changed/).length, 0);
});

test('a join is a server_joined event unless already in, and a leave a server_left event if in', async () => {
  const db = mockPg();
  const store = createStore(() => db.pool);
  await store.recordJoin({ discordId: '1', displayName: 'A', joinedAt: new Date('2025-01-01T00:00:00Z') });
  const join = db.find(/server_joined/)[0];
  assert.match(join.sql, /is distinct from 'server_joined'/);
  assert.match(join.sql, /greatest\(\$2::timestamptz, last\.at\)/, 'never dated before the leave it follows');
  assert.deepEqual(join.params, ['1', new Date('2025-01-01T00:00:00Z')]);

  await store.recordLeave({ discordId: '1' });
  const leave = db.find(/'server_left', 'discord'/)[0];
  assert.match(leave.sql, /= 'server_joined'/);
  assert.deepEqual(leave.params, ['1']);
});

test('a roster sync records name changes and joins, and leaves for members who are gone', async () => {
  const db = mockPg(sql => (/select m\.discord_id, 'server_left'/.test(sql) ? { rows: [{ member_id: '8' }, { member_id: '9' }], rowCount: 2 } : undefined));
  const store = createStore(() => db.pool);
  const joinedAt = new Date('2023-05-05T00:00:00Z');
  const result = await store.syncRoster([
    { discordId: '1', displayName: 'A', joinedAt },
    { discordId: '2', displayName: 'B', joinedAt: null },
  ]);
  assert.deepEqual(result, { members: 2, left: 2 });
  assert.deepEqual(db.find(/insert into members/)[0].params, [['1', '2'], ['A', 'B']]);
  assert.deepEqual(db.find(/display_name_changed/)[0].params, [['1', '2'], ['A', 'B']]);
  assert.deepEqual(db.find(/select u\.id, 'server_joined'/)[0].params[1], [joinedAt, null]);
  assert.deepEqual(db.find(/select m\.discord_id, 'server_left'/)[0].params, [['1', '2']]);

  // An empty roster (e.g. a failed fetch) must never record everyone as having left.
  const empty = mockPg();
  assert.deepEqual(await createStore(() => empty.pool).syncRoster([]), { members: 0, left: 0 });
  assert.equal(empty.calls.length, 0);
});
