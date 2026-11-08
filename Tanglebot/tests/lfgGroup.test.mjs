import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lfg = require('../src/utils/lfgGroup.js');

const minutes = (n) => Math.floor(Date.now() / 1000) + n * 60;

function sampleGroup(overrides = {}) {
  const activity = lfg.findActivityByRoleLabel(`${lfg.CATEGORY_OPTIONS[0].label}: ${lfg.getActivityOptions(lfg.CATEGORY_OPTIONS[0].key)[0].label}`);
  return {
    roleLabel: `${lfg.CATEGORY_OPTIONS[0].label}: ${lfg.getActivityOptions(lfg.CATEGORY_OPTIONS[0].key)[0].label}`,
    roleId: '123456789012345678',
    emoji: activity.emoji,
    timeEpoch: 1800000000,
    sizeLabel: '5 Players',
    sizeCap: 5,
    description: null,
    members: new Set(['111', '222']),
    queue: [],
    pendingOfferUserId: null,
    creatorTag: 'someone',
    ...overrides,
  };
}

test('parseSizeCap reads numbers and treats mass as uncapped', () => {
  assert.equal(lfg.parseSizeCap('5'), 5);
  assert.equal(lfg.parseSizeCap('mass'), Infinity);
});

test('describeStartCountdown picks the nearest bucket and reports Started', () => {
  assert.equal(lfg.describeStartCountdown(minutes(15)), 'in 15 Min');
  assert.equal(lfg.describeStartCountdown(minutes(60)), 'in 1 Hour');
  assert.equal(lfg.describeStartCountdown(minutes(2)), 'in 5 Min');
  assert.equal(lfg.describeStartCountdown(minutes(-1)), 'Started');
});

test('computeCountdownRefreshDelay is null once started and positive before', () => {
  assert.equal(lfg.computeCountdownRefreshDelay(minutes(-1)), null);
  const delay = lfg.computeCountdownRefreshDelay(minutes(45));
  assert.ok(delay >= 1000 && delay <= 45 * 60000);
});

test('resolveTimeEpoch adds the offset in seconds', () => {
  const now = Math.floor(Date.now() / 1000);
  const epoch = lfg.resolveTimeEpoch('30');
  assert.ok(epoch >= now + 1800 && epoch <= now + 1801);
});

test('isGroupFull ignores uncapped groups', () => {
  assert.equal(lfg.isGroupFull({ sizeCap: 2, members: new Set(['a', 'b']) }), true);
  assert.equal(lfg.isGroupFull({ sizeCap: 2, members: new Set(['a']) }), false);
  assert.equal(lfg.isGroupFull({ sizeCap: Infinity, members: new Set(['a', 'b']) }), false);
});

test('capMentionLines keeps everything that fits and summarizes the rest', () => {
  assert.equal(lfg.capMentionLines(['<@1>', '<@2>'], 100), '<@1>\n<@2>');
  const lines = Array.from({ length: 50 }, (_, i) => `<@${1000 + i}>`);
  const capped = lfg.capMentionLines(lines, 60);
  assert.ok(capped.length <= 60);
  assert.match(capped, /_…and \d+ more_$/);
});

test('buildGroupText / parseGroupText round trip', () => {
  const group = sampleGroup({
    description: 'Line one\nLine two with **bold**',
    queue: ['333', '444'],
    pendingOfferUserId: '333',
  });
  const parsed = lfg.parseGroupText(lfg.buildGroupText(group));
  assert.equal(parsed.roleId, group.roleId);
  assert.equal(parsed.roleLabel, group.roleLabel);
  assert.equal(parsed.timeEpoch, group.timeEpoch);
  assert.equal(parsed.sizeLabel, group.sizeLabel);
  assert.equal(parsed.description, group.description);
  assert.deepEqual(parsed.members, ['111', '222']);
  assert.deepEqual(parsed.queue, ['333', '444']);
  assert.equal(parsed.pendingOfferUserId, '333');
  assert.equal(parsed.creatorTag, 'someone');
  assert.equal(parsed.hiddenMembers, 0);
});

test('round trip works without a description, queue or cap', () => {
  const parsed = lfg.parseGroupText(lfg.buildGroupText(sampleGroup({ sizeCap: Infinity, sizeLabel: 'Mass' })));
  assert.equal(parsed.description, null);
  assert.deepEqual(parsed.queue, []);
  assert.equal(parsed.pendingOfferUserId, null);
});

test('a huge Mass roster stays under the post cap and reports hidden members', () => {
  const members = new Set(Array.from({ length: 300 }, (_, i) => String(100000000000000000n + BigInt(i))));
  const text = lfg.buildGroupText(sampleGroup({ sizeCap: Infinity, sizeLabel: 'Mass', members }));
  assert.ok(text.length <= 1900);
  const parsed = lfg.parseGroupText(text);
  assert.ok(parsed.hiddenMembers > 0);
  assert.equal(parsed.members.length + parsed.hiddenMembers, 300);
});

test('parseGroupText rejects text that is not a group post', () => {
  assert.equal(lfg.parseGroupText('hello'), null);
  assert.equal(lfg.parseGroupText(undefined), null);
});

const g = (over = {}) => ({
  id: 'g1', roleLabel: 'Bosses: Yama', status: 'open', threadId: 't1', creatorId: 'u1',
  sizeCap: 5, sizeLabel: '5 Players', timeEpoch: 1800000000,
  members: new Set(['u1']), queue: [], pendingOfferUserId: null, ...over,
});

test('findOpenGroupsOwnedBy skips other creators and disbanding groups', () => {
  const groups = [g(), g({ id: 'g2', status: 'disbanded' }), g({ id: 'g3', creatorId: 'u2' }), g({ id: 'g4', status: 'closed' })];
  assert.deepEqual(lfg.findOpenGroupsOwnedBy(groups, 'u1').map((x) => x.id), ['g1', 'g4']);
  assert.deepEqual(lfg.findOpenGroupsOwnedBy([], 'u1'), []);
});

test('findJoinableDuplicate needs the same activity, space and an open status', () => {
  assert.equal(lfg.findJoinableDuplicate([g()], 'Bosses: Yama').id, 'g1');
  assert.equal(lfg.findJoinableDuplicate([g()], 'Bosses: Zulrah'), undefined);
  assert.equal(lfg.findJoinableDuplicate([g({ status: 'closed' })], 'Bosses: Yama'), undefined);
  assert.equal(lfg.findJoinableDuplicate([g({ sizeCap: 1 })], 'Bosses: Yama'), undefined);
  assert.equal(lfg.findJoinableDuplicate([g({ threadId: null })], 'Bosses: Yama'), undefined);
  assert.equal(lfg.findJoinableDuplicate([g({ sizeCap: Infinity })], 'Bosses: Yama').id, 'g1');
});

test('planSizeChange', () => {
  const three = g({ members: new Set(['a', 'b', 'c']), status: 'open', sizeCap: 5 });
  assert.equal(lfg.planSizeChange(three, 2), 'refuse');
  assert.equal(lfg.planSizeChange(three, 3), 'full');
  assert.equal(lfg.planSizeChange(three, 4), 'update');
  assert.equal(lfg.planSizeChange(three, Infinity), 'update');
  const full = g({ members: new Set(['a', 'b']), status: 'closed', sizeCap: 2 });
  assert.equal(lfg.planSizeChange(full, 4), 'advance');
  assert.equal(lfg.planSizeChange(full, Infinity), 'advance');
  assert.equal(lfg.planSizeChange({ ...full, pendingOfferUserId: 'q1' }, 4), 'update');
});

test('planAfterMemberLeft', () => {
  assert.equal(lfg.planAfterMemberLeft(g(), true), 'advance');
  assert.equal(lfg.planAfterMemberLeft(g(), false), 'notice');
  assert.equal(lfg.planAfterMemberLeft(g({ members: new Set() }), false), 'empty');
  assert.equal(lfg.planAfterMemberLeft(g({ members: new Set() }), true), 'advance');
});

test('buildHistoryRecord keeps what stats need and is JSON-safe', () => {
  const group = g({ members: new Set(['u1']), participants: new Set(['u1', 'u2', 'u3']), createdAt: Date.parse('2026-01-02T02:00:00Z') });
  const record = lfg.buildHistoryRecord(group, 'inactive', new Date('2026-01-02T03:04:05Z'));
  assert.deepEqual(record, {
    closedAt: '2026-01-02T03:04:05.000Z', createdAt: '2026-01-02T02:00:00.000Z', id: 'g1', activity: 'Bosses: Yama',
    size: '5 Players', startEpoch: 1800000000, creatorId: 'u1', memberIds: ['u1'], participantIds: ['u1', 'u2', 'u3'],
    reason: 'inactive',
  });
  assert.equal(JSON.parse(JSON.stringify(record)).participantIds.length, 3);
});

test('buildHistoryRecord falls back to current members and a null created time', () => {
  const record = lfg.buildHistoryRecord(g({ members: new Set(['u1', 'u2']) }), 'empty');
  assert.deepEqual(record.participantIds, ['u1', 'u2']);
  assert.equal(record.createdAt, null);
});

test('the group row has Join, Leave, Start Now, Manage and Disband, all tied to the group id', () => {
  const row = lfg.buildGroupRow('abc');
  assert.deepEqual(row.components.map((c) => c.data.label), ['Join Group', 'Leave Group', 'Start Now', 'Manage', 'Disband Group']);
  assert.deepEqual(row.components.map((c) => c.data.custom_id.split(':')[1]), ['join', 'leave', 'startnow', 'manage', 'disband']);
  for (const c of row.components) assert.ok(c.data.custom_id.startsWith(`${lfg.GROUP_BUTTON_PREFIX}:`) && c.data.custom_id.endsWith(':abc'));
});

test('a description at the length cap survives the round trip', () => {
  const description = 'x'.repeat(lfg.MAX_DESCRIPTION_CHARS);
  const parsed = lfg.parseGroupText(lfg.buildGroupText(sampleGroup({ description })));
  assert.equal(parsed.description, description);
});

test('a description with blank lines or fake headers does not confuse parsing', () => {
  const description = 'first\n\n**Members (9/9):**\n<@999>\nlast';
  const parsed = lfg.parseGroupText(lfg.buildGroupText(sampleGroup({ description })));
  assert.deepEqual(parsed.members, ['111', '222']);
  assert.equal(parsed.description, description);
});

test('the queue and offer rows carry the group id', () => {
  assert.deepEqual(lfg.buildQueueOfferRow('abc').components.map((c) => c.data.custom_id), ['lfgpostgroup:queueaccept:abc', 'lfgpostgroup:queuedecline:abc']);
  assert.equal(lfg.buildCancelDisbandRow('abc').components[0].data.custom_id, 'lfgpostgroup:canceldisband:abc');
  assert.equal(lfg.buildKeepAliveRow('abc').components[0].data.custom_id, 'lfgpostgroup:keepalive:abc');
});
