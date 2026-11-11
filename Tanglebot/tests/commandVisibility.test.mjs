import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// spinwheel needs a native canvas binding that is irrelevant here; stub it.
const canvasPath = require.resolve('@napi-rs/canvas');
require.cache[canvasPath] = { id: canvasPath, filename: canvasPath, loaded: true, exports: {} };

const load = name => require(`../src/commands/${name}.js`);

const STAFF = [
  'donationhighscore', 'pethighscore', 'refreshboards', 'migration', 'stalemembers',
  'weeklyannounce', 'weeklycomp', 'honeypot', 'spinwheel', 'submission',
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
