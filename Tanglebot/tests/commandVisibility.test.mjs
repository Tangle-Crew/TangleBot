import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// spinwheel needs a native canvas binding that is irrelevant here; stub it.
const canvasPath = require.resolve('@napi-rs/canvas');
require.cache[canvasPath] = { id: canvasPath, filename: canvasPath, loaded: true, exports: {} };

const load = name => require(`../src/commands/${name}.js`);

const STAFF = [
  'donationhighscore', 'pethighscore', 'refreshboards', 'dbstatus', 'commandlog', 'memberdata', 'profile', 'history', 'stalemembers',
  'weeklyannounce', 'weeklycomp', 'honeypot', 'spinwheel', 'submission', 'quietmembers', 'activitybackfill',
];
const PUBLIC = ['lfg-post', 'lfg-roles', 'link', 'linkalt', 'weeklycompstats'];

for (const name of STAFF) {
  test(`/${name} is hidden from members by default`, () => {
    const json = load(name).data.toJSON();
    assert.equal(json.name, name);
    assert.equal(json.default_member_permissions, '0');
  });
}

for (const name of PUBLIC) {
  test(`/${name} stays visible to everyone`, () => {
    const json = load(name).data.toJSON();
    assert.equal(json.name, name);
    assert.ok(json.default_member_permissions == null);
  });
}

const { commandDisabledReason } = require('../src/utils/commandAvailability.js');

test('staff commands do not load without the role they check', () => {
  assert.match(commandDisabledReason(load('spinwheel'), {}), /COORDINATOR_ROLE_ID/);
  assert.equal(commandDisabledReason(load('spinwheel'), { COORDINATOR_ROLE_ID: 'c' }), null);
  assert.match(commandDisabledReason(load('weeklycomp'), {}), /TEMPLAR_ROLE_ID/);
  assert.equal(commandDisabledReason(load('weeklycomp'), { TEMPLAR_ROLE_ID: 't' }), null);
});

test('requiredEnvAny with several groups needs one from each', () => {
  const honeypot = load('honeypot');
  assert.match(commandDisabledReason(honeypot, { HONEYPOT_CHANNEL_ID: 'h' }), /OWNER_ROLE_ID, TEMPLAR_ROLE_ID/);
  assert.match(commandDisabledReason(honeypot, { TEMPLAR_ROLE_ID: 't' }), /HONEYPOT_CHANNEL_ID/);
  assert.equal(commandDisabledReason(honeypot, { HONEYPOT_VOICE_CHANNEL_ID: 'v', OWNER_ROLE_ID: 'o' }), null);
  assert.equal(commandDisabledReason({ requiredEnvAny: ['A', 'B'] }, { B: 'x' }), null);
});
