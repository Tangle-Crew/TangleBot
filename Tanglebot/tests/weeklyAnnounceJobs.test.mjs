import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// An in-memory state layer, so the tests never touch data/weeklyannounce.json. The real one mirrors
// every writeState to bot_state (see state.test.mjs).
const files = new Map();
const writes = [];
const stub = (relative, exports) => {
  const resolved = require.resolve(relative);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
stub('../src/utils/state.js', {
  readState: file => JSON.parse(JSON.stringify(files.get(file) ?? {})),
  writeState: (file, value) => { writes.push(file); files.set(file, JSON.parse(JSON.stringify(value))); },
});
// The chart module needs a native canvas binding these tests don't use.
stub('../src/utils/weeklyAnnounceChart.js', { renderProgressChart() {}, chartFileName() {} });
const announce = require('../src/utils/weeklyAnnounce.js');

beforeEach(() => {
  files.clear();
  writes.length = 0;
});

function newJob({ channelId = '2', hours = 1, competitions = [] } = {}) {
  const draft = announce.createDraft({
    ownerId: '1', channelId, sendAt: new Date(Date.now() + hours * 3600e3), fixedSendAt: false, competitions, choices: [],
  });
  announce.updateDraft(draft.id, d => d.announcements.push('hello'));
  return announce.acceptDraft(draft.id, '1');
}

test('cancelJob removes a scheduled job and refuses one that is sending', () => {
  const job = newJob();
  assert.ok(announce.cancelJob(job.id));
  assert.equal(announce.getJob(job.id), null);
  const other = newJob();
  announce.updateJob(other.id, j => { j.status = 'sending'; });
  assert.equal(announce.cancelJob(other.id), null);
  assert.equal(announce.getJob(other.id).status, 'sending');
});

test('reopenJob turns a scheduled job back into a draft with its announcements', () => {
  const job = newJob();
  const draft = announce.reopenJob(job.id);
  assert.equal(draft.id, job.id);
  assert.deepEqual(draft.announcements, ['hello']);
  for (const field of ['status', 'acceptedBy', 'acceptedAt', 'claimedAt', 'resumed', 'sent']) assert.equal(field in draft, false);
  assert.equal(announce.getJob(job.id), null);
  assert.deepEqual(announce.getDraft(job.id).announcements, ['hello']);
  assert.ok(announce.acceptDraft(job.id, '1'), 'accepting again schedules it');
});

test('reopenJob refuses a job that is sending, sent or failed', () => {
  for (const status of ['sending', 'sent', 'failed']) {
    const job = newJob();
    announce.updateJob(job.id, j => { j.status = status; });
    assert.equal(announce.reopenJob(job.id), null, status);
    assert.equal(announce.getJob(job.id).status, status);
  }
});

test('cancelling and reopening are saved through the state layer', () => {
  const job = newJob();
  writes.length = 0;
  announce.cancelJob(job.id);
  assert.deepEqual(writes, ['weeklyannounce.json']);
  assert.equal(files.get('weeklyannounce.json').jobs[job.id], undefined);
  const other = newJob();
  writes.length = 0;
  announce.reopenJob(other.id);
  assert.deepEqual(writes, ['weeklyannounce.json']);
  assert.ok(files.get('weeklyannounce.json').drafts[other.id]);
});

const draftFor = ({ channelId = '2', hours = 1, competitions = [] }) => ({
  id: 'new', channelId, sendAt: new Date(Date.now() + hours * 3600e3).toISOString(), competitions,
});

test('findDuplicateJob matches the same channel within a day or with a shared competition', () => {
  const job = newJob({ competitions: [{ id: 7, title: 'A' }] });
  assert.equal(announce.findDuplicateJob(draftFor({ hours: 5 }))?.id, job.id, 'close send time');
  assert.equal(announce.findDuplicateJob(draftFor({ hours: 24 * 7, competitions: [{ id: 7, title: 'A' }] }))?.id, job.id, 'same competition');
  assert.equal(announce.findDuplicateJob(draftFor({ hours: 24 * 7, competitions: [{ id: 8, title: 'B' }] })), null, 'a week later, other competition');
  assert.equal(announce.findDuplicateJob(draftFor({ channelId: '3', hours: 1 })), null, 'other channel');
});

test('findDuplicateJob ignores jobs that are not scheduled and the draft itself', () => {
  const job = newJob();
  assert.equal(announce.findDuplicateJob({ ...draftFor({}), id: job.id }), null);
  announce.updateJob(job.id, j => { j.status = 'sent'; });
  assert.equal(announce.findDuplicateJob(draftFor({})), null);
});

test('findJobsCovering matches a picked competition, or Automatic when it is the last to end by the send time', () => {
  const comp = (id, hours) => ({ id, endsAt: new Date(Date.now() + hours * 3600e3).toISOString() });
  const all = [comp(7, 0.5), comp(8, 48)];
  const covering = id => announce.findJobsCovering(all.find(c => c.id === id), all).map(j => j.id);
  assert.deepEqual(covering(7), []);

  const picked = newJob({ hours: 100, competitions: [{ id: 7, title: 'A' }] });
  assert.deepEqual(covering(7), [picked.id]);
  assert.deepEqual(covering(8), []);

  announce.cancelJob(picked.id);
  const automatic = newJob({ hours: 1 });
  assert.deepEqual(covering(7), [automatic.id]);
  assert.deepEqual(covering(8), [], 'still running at the send time');

  announce.updateJob(automatic.id, j => { j.sendAt = new Date(Date.now() + 72 * 3600e3).toISOString(); });
  assert.deepEqual(covering(7), [], 'a later competition ends before the send');
  assert.deepEqual(covering(8), [automatic.id]);

  announce.updateJob(automatic.id, j => { j.status = 'sent'; });
  assert.deepEqual(covering(8), []);
});
