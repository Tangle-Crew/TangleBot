import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mockPg } from './helpers/mockPg.mjs';

const require = createRequire(import.meta.url);

Object.assign(process.env, { OWNER_ROLE_ID: 'owner', TEMPLAR_ROLE_ID: 'templar', DATABASE_URL: 'postgres://u:p@host:5432/db' });
delete process.env.ADMIN_LOG_CHANNEL_ID;

// Test mode is read from a file in data/; read it from a variable instead.
const dbUtils = require('../src/utils/db.js');
let testModeFile = false;
const realReadJson = dbUtils.readJson;
dbUtils.readJson = name => (name === 'honeypot-runtime-config.json' ? { testMode: testModeFile } : realReadJson(name));

const honeypotLog = require('../src/utils/honeypotLog.js');
const realRecordIncident = honeypotLog.recordIncident;
const honeypot = require('../src/utils/honeypot.js');
const profile = require('../src/utils/profile.js');

const incident = { discordId: '111', discordName: 'Snow', action: 'timeout', outcome: 'done', channelId: 'trap', details: { attachments: 1, messageDeleted: true } };

test('an incident is one insert with who, what happened, and where; the message itself is never stored', async () => {
  const db = mockPg();
  await realRecordIncident({ ...incident, byDiscordId: '9', byDiscordName: 'Admin' }, db.pool);
  const [call] = db.find(/insert into honeypot_incidents/);
  assert.deepEqual(call.params.slice(0, 8), ['111', 'Snow', 'timeout', 'done', false, 'trap', '9', 'Admin']);
  assert.deepEqual(JSON.parse(call.params[8]), { attachments: 1, messageDeleted: true });
});

test('a long error is cut, a failed write is swallowed, and nothing is written without a database', async () => {
  const db = mockPg();
  await realRecordIncident({ ...incident, details: { error: 'x'.repeat(500) } }, db.pool);
  assert.equal(JSON.parse(db.calls[0].params[8]).error.length, 300);

  await realRecordIncident(incident, { query: async () => { throw new Error('db down'); } });

  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await realRecordIncident(incident); // would throw on getPool() if it tried
  } finally {
    process.env.DATABASE_URL = saved;
  }
});

// ── The honeypot records what it does ────────────────────────────────────────

let saved;
let recorded;
beforeEach(() => {
  saved = honeypotLog.recordIncident;
  recorded = [];
  honeypotLog.recordIncident = async entry => { recorded.push(entry); };
  testModeFile = false;
});
afterEach(() => { honeypotLog.recordIncident = saved; });

const config = { enabled: true, trapChannelIds: ['trap'] };
function message({ member = true, timeoutFails = false, deleteFails = false } = {}) {
  return {
    author: { id: '111', tag: 'snow#0', username: 'snow', bot: false },
    channelId: 'trap',
    attachments: new Map(),
    member: member ? { displayName: 'Snow', timeout: async () => { if (timeoutFails) throw new Error('Missing Permissions'); } } : null,
    delete: async () => { if (deleteFails) throw new Error('Unknown Message'); },
  };
}

test('someone posting in the trap is recorded as a timeout that worked', async () => {
  await honeypot.handleHoneypotMessage(message(), config, {});
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    [recorded[0].discordId, recorded[0].discordName, recorded[0].action, recorded[0].outcome, recorded[0].testMode, recorded[0].channelId],
    ['111', 'Snow', 'timeout', 'done', false, 'trap']
  );
  assert.deepEqual(recorded[0].details, { attachments: 0, messageDeleted: true, error: null });
});

test('a failed timeout, a failed delete, an unknown member and test mode are each recorded as they were', async () => {
  await honeypot.handleHoneypotMessage(message({ timeoutFails: true, deleteFails: true }), config, {});
  assert.equal(recorded[0].outcome, 'failed');
  assert.deepEqual(recorded[0].details, { attachments: 0, messageDeleted: false, error: 'Missing Permissions' });

  await honeypot.handleHoneypotMessage(message({ member: false }), config, {});
  assert.equal(recorded[1].outcome, 'skipped');
  assert.equal(recorded[1].discordName, 'snow', 'falls back to the account name');

  testModeFile = true;
  await honeypot.handleHoneypotMessage(message(), config, {});
  assert.equal(recorded[2].outcome, 'test');
  assert.equal(recorded[2].testMode, true);
});

test('messages outside the trap, and from bots, are not recorded', async () => {
  await honeypot.handleHoneypotMessage({ ...message(), channelId: 'elsewhere' }, config, {});
  await honeypot.handleHoneypotMessage({ ...message(), author: { id: '1', tag: 'b', username: 'b', bot: true } }, config, {});
  assert.deepEqual(recorded, []);
});

function button(customId, { roles = ['owner'], banFails = false, timeoutFails = false } = {}) {
  const calls = { edits: 0 };
  return {
    calls,
    interaction: {
      customId,
      channelId: 'admin-log',
      user: { id: '9', tag: 'admin#0', username: 'admin' },
      member: { displayName: 'Admin', roles: { cache: { has: id => roles.includes(id) } } },
      message: { embeds: [] },
      guild: {
        members: {
          cache: new Map([['111', { displayName: 'Snow' }]]),
          ban: async () => { if (banFails) throw new Error('Missing Permissions'); },
          fetch: async () => ({ timeout: async () => { if (timeoutFails) throw new Error('Unknown Member'); } }),
        },
        me: null,
        channels: { cache: { filter: () => new Map() }, fetch: async () => new Map() },
      },
      reply: async () => {},
      deferUpdate: async () => {},
      editReply: async () => { calls.edits += 1; },
      followUp: async () => {},
    },
  };
}

test('the ban and false positive buttons are recorded with who pressed them and how it went', async () => {
  await honeypot.handleHoneypotButtonInteraction(button('hp:bandelete:111:l').interaction);
  assert.deepEqual(
    [recorded[0].action, recorded[0].outcome, recorded[0].discordId, recorded[0].discordName, recorded[0].byDiscordId, recorded[0].byDiscordName, recorded[0].channelId],
    ['ban', 'done', '111', 'Snow', '9', 'Admin', 'admin-log']
  );

  await honeypot.handleHoneypotButtonInteraction(button('hp:bandelete:111:l', { banFails: true }).interaction);
  assert.equal(recorded[1].outcome, 'failed');
  assert.equal(recorded[1].details.error, 'Missing Permissions');
  assert.equal(recorded[1].details.fallbackDeleted, 0);

  await honeypot.handleHoneypotButtonInteraction(button('hp:falsepositive:111:l').interaction);
  assert.deepEqual([recorded[2].action, recorded[2].outcome], ['false_positive', 'done']);

  await honeypot.handleHoneypotButtonInteraction(button('hp:falsepositive:111:l', { timeoutFails: true }).interaction);
  assert.deepEqual([recorded[3].outcome, recorded[3].details.error], ['failed', 'Unknown Member']);

  await honeypot.handleHoneypotButtonInteraction(button('hp:bandelete:111:t').interaction);
  assert.deepEqual([recorded[4].outcome, recorded[4].testMode], ['test', true]);
});

test('a button pressed without the Owner or Templar role does nothing and records nothing', async () => {
  const { interaction } = button('hp:bandelete:111:l', { roles: ['other'] });
  await honeypot.handleHoneypotButtonInteraction(interaction);
  assert.deepEqual(recorded, []);
});

// ── /profile shows it ────────────────────────────────────────────────────────

test('the member profile shows a Honeypot field only when there are incidents', () => {
  const base = {
    overview: { discordId: '111', displayName: 'Snow', donatedGp: 0, pets: 0, inServer: true, firstJoinedServerAt: null },
    nameChanges: [], stays: [], accounts: [], petNames: [], lastDonation: null, milestones: [],
  };
  const tiers = [];
  const none = profile.memberEmbed({ ...base, honeypot: [], honeypotCount: 0 }, { tiers, masterThreshold: 10 }).toJSON();
  assert.ok(!none.fields.some(f => f.name === 'Honeypot'));

  const some = profile.memberEmbed({
    ...base,
    honeypotCount: 2,
    honeypot: [
      { action: 'false_positive', outcome: 'done', created_at: new Date('2026-11-02T00:00:00Z') },
      { action: 'timeout', outcome: 'done', created_at: new Date('2026-11-01T00:00:00Z') },
    ],
  }, { tiers, masterThreshold: 10 }).toJSON();
  const field = some.fields.find(f => f.name === 'Honeypot').value;
  assert.match(field, /2 incidents, latest first:/);
  assert.match(field, /Cleared as a false positive \(<t:\d+:D>\)/);
  assert.match(field, /Timed out \(<t:\d+:D>\)/);
});
