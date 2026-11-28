import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// In-memory state and a stubbed Wise Old Man, so the tests touch no files or network.
let store = {};
const stub = (relative, exports) => {
  const resolved = require.resolve(relative);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
stub('../src/utils/state.js', {
  readState: () => structuredClone(store),
  writeState: (file, value) => { store = structuredClone(value); },
});
stub('../src/utils/weeklyAnnounceChart.js', { renderProgressChart() {}, chartFileName() {} });

const HOUR = 3600e3;
let competition;
const wom = require('../src/utils/wiseOldMan.js');
Object.assign(wom, {
  getAllGroupCompetitions: async () => [competition],
  getCompetitionDetails: async () => ({ ...competition, participations: [] }),
  rankParticipants: () => [],
});
Object.assign(process.env, { WOM_GROUP_ID: '1', ADMIN_LOG_CHANNEL_ID: '99' });
delete process.env.WOM_GROUP_VERIFICATION_CODE;
const announce = require('../src/utils/weeklyAnnounce.js');

beforeEach(() => {
  store = {};
  competition = {
    id: 7, title: 'BOTW Vorkath', metric: 'vorkath',
    startsAt: new Date(Date.now() - 24 * HOUR).toISOString(), endsAt: new Date(Date.now() + HOUR / 2).toISOString(),
  };
});

// A scheduled post with an admin log entry 'old'. hours is its send time from now.
function schedule({ hours = 1, picked = true, change = () => {} } = {}) {
  const draft = announce.createDraft({
    ownerId: '1', channelId: '2', sendAt: new Date(Date.now() + hours * HOUR), fixedSendAt: false,
    competitions: picked ? [{ id: 7, title: competition.title }] : [],
  });
  const job = announce.acceptDraft(draft.id, '1');
  return announce.updateJob(job.id, j => { j.logMessageId = 'old'; change(j); });
}

// Runs the reminder's startup check. onSend(n) runs while the nth message is sending; a throw fails it.
async function runReminder(onSend = () => {}) {
  const sent = [];
  const deleted = [];
  const channel = {
    id: '99', guild: null,
    messages: {
      fetch: async () => Object.assign(new Map(), { last: () => undefined }),
      delete: async id => { deleted.push(id); },
    },
    send: async message => {
      onSend(sent.length + 1);
      sent.push(message);
      return { id: `m${sent.length}` };
    },
  };
  const path = require.resolve('../src/utils/compEndingReminder.js');
  delete require.cache[path];
  const stop = require(path).startCompEndingReminder({ user: { id: 'bot' }, channels: { fetch: async () => channel } });
  await new Promise(resolve => setTimeout(resolve, 50));
  stop();
  const description = sent[0].embeds[0].data.description;
  return { sent, deleted, content: sent[0].content, description };
}

test('a scheduled post gets a new entry after the reminder, replacing the earlier one', async () => {
  const job = schedule({ change: j => { j.logNote = 'could not be replaced'; } });
  const { sent, deleted, content } = await runReminder();
  assert.match(content, /already scheduled/);
  assert.equal(sent.length, 2);
  assert.match(sent[1].embeds[0].data.description, /could not be replaced\nPosted again/);
  assert.deepEqual(deleted, ['old']);
  assert.equal(announce.getJob(job.id).logMessageId, 'm2');
});

test('nothing is re-posted for a post cancelled while the reminder is sending', async () => {
  const job = schedule();
  const { sent, deleted } = await runReminder(n => { if (n === 1) announce.cancelJob(job.id); });
  assert.equal(sent.length, 1);
  assert.deepEqual(deleted, []);
});

test('a post cancelled or reopened while re-posting keeps its earlier entry and loses the new one', async () => {
  for (const change of [id => announce.cancelJob(id), id => announce.reopenJob(id)]) {
    store = {};
    const job = schedule();
    const { deleted } = await runReminder(n => { if (n === 2) change(job.id); });
    assert.deepEqual(deleted, ['m2']);
  }
});

test('the earlier entry is kept when the new one cannot be sent', async () => {
  const job = schedule();
  const { deleted } = await runReminder(n => { if (n === 2) throw new Error('Discord down'); });
  assert.deepEqual(deleted, []);
  assert.equal(announce.getJob(job.id).logMessageId, 'old');
});

test('a post being sent is reported as sending and its entry left alone', async () => {
  schedule({ change: j => { j.status = 'sending'; } });
  const { sent, deleted, content, description } = await runReminder();
  assert.match(content, /being sent now/);
  assert.doesNotMatch(description, /already scheduled|Preview, Edit/);
  assert.equal(sent.length, 1);
  assert.deepEqual(deleted, []);
});

test('a post sending before the competition ends is flagged', async () => {
  schedule({ hours: 0.25 });
  const { content, description } = await runReminder();
  assert.match(content, /please check it/);
  assert.match(description, /not the final results/);
});

test('an Automatic post sending over a day after the end is flagged', async () => {
  schedule({ hours: 14 * 24, picked: false });
  const { content, description } = await runReminder();
  assert.match(content, /please check it/);
  assert.match(description, /it will announce that one instead/);
});

test('with nothing scheduled the reminder asks for the announcement', async () => {
  const { sent, content } = await runReminder();
  assert.match(content, /please make the announcement/);
  assert.equal(sent.length, 1);
});
