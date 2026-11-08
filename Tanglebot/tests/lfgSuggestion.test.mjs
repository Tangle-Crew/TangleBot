import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const suggestion = require('../src/utils/lfgSuggestion.js');

function fakeInteraction({ category = 'Boss', item = ' Hueycoatl ', userId = 'u1', sent = [], replies = [], fail = false } = {}) {
  return {
    customId: 'lfgsuggest:submit',
    user: { id: userId, username: 'tester' },
    fields: {
      getStringSelectValues: () => [category],
      getTextInputValue: () => item,
    },
    client: { channels: { fetch: async () => ({ send: async (m) => { if (fail) throw new Error('nope'); sent.push(m); } }) } },
    reply: async (r) => { replies.push(r); },
    sent,
    replies,
  };
}

function withEnv(env, fn) {
  const saved = { a: process.env.ADMIN_LOG_CHANNEL_ID, o: process.env.OWNER_ROLE_ID };
  process.env.ADMIN_LOG_CHANNEL_ID = env.admin;
  process.env.OWNER_ROLE_ID = env.owner;
  if (env.admin === undefined) delete process.env.ADMIN_LOG_CHANNEL_ID;
  if (env.owner === undefined) delete process.env.OWNER_ROLE_ID;
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of [['ADMIN_LOG_CHANNEL_ID', saved.a], ['OWNER_ROLE_ID', saved.o]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

test('no button without an admin log; the Owner role is optional', async () => {
  await withEnv({ admin: undefined, owner: '9' }, () => assert.deepEqual(suggestion.buildSuggestRows(), []));
  await withEnv({ admin: '1', owner: undefined }, () => assert.equal(suggestion.buildSuggestRows().length, 1));
  await withEnv({ admin: '1', owner: '9' }, () => {
    const rows = suggestion.buildSuggestRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].components[0].data.custom_id, 'lfgsuggest:open');
  });
});

test('a suggestion pings the Owner role in the message and only that role', async () => {
  await withEnv({ admin: '1', owner: '9' }, async () => {
    const i = fakeInteraction({ userId: 'ping-test' });
    await suggestion.handleSuggestModalSubmit(i);
    assert.equal(i.sent.length, 1);
    assert.equal(i.sent[0].content, '<@&9>');
    assert.deepEqual(i.sent[0].allowedMentions, { roles: ['9'] });
    const fields = i.sent[0].embeds[0].data.fields;
    assert.equal(fields.find((f) => f.name === 'Category').value, 'Boss');
    assert.equal(fields.find((f) => f.name === 'Suggestion').value, 'Hueycoatl');
    assert.match(i.replies[0].content, /Thanks/);
  });
});

test('a second suggestion within the cooldown is refused', async () => {
  await withEnv({ admin: '1', owner: '9' }, async () => {
    const first = fakeInteraction({ userId: 'cooldown-test' });
    await suggestion.handleSuggestModalSubmit(first);
    const second = fakeInteraction({ userId: 'cooldown-test' });
    await suggestion.handleSuggestModalSubmit(second);
    assert.equal(second.sent.length, 0);
    assert.match(second.replies[0].content, /wait/);
  });
});

test('blank or unknown input is rejected without sending', async () => {
  await withEnv({ admin: '1', owner: '9' }, async () => {
    const blank = fakeInteraction({ userId: 'blank-test', item: '   ' });
    await suggestion.handleSuggestModalSubmit(blank);
    assert.equal(blank.sent.length, 0);
    const odd = fakeInteraction({ userId: 'odd-test', category: 'Hacks' });
    await suggestion.handleSuggestModalSubmit(odd);
    assert.equal(odd.sent.length, 0);
  });
});

test('a failed send tells the user and does not start the cooldown', async () => {
  await withEnv({ admin: '1', owner: '9' }, async () => {
    const failed = fakeInteraction({ userId: 'fail-test', fail: true });
    await suggestion.handleSuggestModalSubmit(failed);
    assert.match(failed.replies[0].content, /went wrong/);
    const retry = fakeInteraction({ userId: 'fail-test' });
    await suggestion.handleSuggestModalSubmit(retry);
    assert.equal(retry.sent.length, 1);
  });
});

test('without OWNER_ROLE_ID the suggestion is sent with no ping', async () => {
  await withEnv({ admin: '1', owner: undefined }, async () => {
    const i = fakeInteraction({ userId: 'noowner-test' });
    await suggestion.handleSuggestModalSubmit(i);
    assert.equal(i.sent.length, 1);
    assert.equal(i.sent[0].content, undefined);
    assert.deepEqual(i.sent[0].allowedMentions, { roles: [] });
  });
});

test('two simultaneous submissions from one person send only one', async () => {
  await withEnv({ admin: '1', owner: '9' }, async () => {
    const sent = [];
    const a = fakeInteraction({ userId: 'race-test', sent });
    const b = fakeInteraction({ userId: 'race-test', sent });
    await Promise.all([suggestion.handleSuggestModalSubmit(a), suggestion.handleSuggestModalSubmit(b)]);
    assert.equal(sent.length, 1);
  });
});
