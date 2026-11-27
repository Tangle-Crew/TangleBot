import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// spinwheel needs a native canvas binding that is irrelevant here; stub it.
const canvasPath = require.resolve('@napi-rs/canvas');
require.cache[canvasPath] = { id: canvasPath, filename: canvasPath, loaded: true, exports: {} };
const { availableCommands, registerCommands } = require('../src/handlers/commandHandler.js');

test('availableCommands skips commands whose settings are missing', () => {
  const saved = process.env.LFG_FORUM_CHANNEL_ID;
  delete process.env.LFG_FORUM_CHANNEL_ID;
  const names = availableCommands('[Test]').map(c => c.data.name);
  assert.ok(names.includes('lfg-roles'));
  assert.ok(!names.includes('lfg-post'));
  if (saved !== undefined) process.env.LFG_FORUM_CHANNEL_ID = saved;
});

test('registerCommands does nothing without CLIENT_ID and CLAN_ID', async () => {
  const saved = { CLIENT_ID: process.env.CLIENT_ID, CLAN_ID: process.env.CLAN_ID };
  delete process.env.CLIENT_ID;
  delete process.env.CLAN_ID;
  assert.equal(await registerCommands([], '[Test]'), false);
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});
