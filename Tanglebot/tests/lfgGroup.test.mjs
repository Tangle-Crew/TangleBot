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
