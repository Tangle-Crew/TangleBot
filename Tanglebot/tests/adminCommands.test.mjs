import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// spinwheel needs a native canvas binding that is irrelevant here; stub it.
const canvasPath = require.resolve('@napi-rs/canvas');
require.cache[canvasPath] = { id: canvasPath, filename: canvasPath, loaded: true, exports: {} };

process.env.OWNER_ROLE_ID = '111';
process.env.TEMPLAR_ROLE_ID = '222';
process.env.COORDINATOR_ROLE_ID = '333';

// State files are kept in memory, so the tests never touch the data folder.
const db = require('../src/utils/state.js');
const files = new Map();
db.readState = name => structuredClone(files.get(name) ?? {});
db.writeState = (name, value) => { files.set(name, structuredClone(value)); };

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const docs = require('../src/utils/commandDocs.js');
const post = require('../src/utils/adminCommandsPost.js');
const { syncStaticMessages } = require('../src/utils/staticMessages.js');

const commandsDir = path.join(import.meta.dirname, '..', 'src', 'commands');
const real = new Map();
for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  if (command.data && command.execute) real.set(command.data.name, command);
}
const entries = docs.describeCommands(real);
const staff = [...real.values()].filter(c => c.data.toJSON().default_member_permissions != null);
const subPathOf = e => e.path.slice(e.name.length).trim();

const KNOWN_ACCESS = ['Everyone', 'Owner', 'Templar', 'Coordinator', 'Manage Server', 'Manage Roles'];

test('help.access only uses known role names', () => {
  for (const c of real.values()) {
    if (!c.help?.access) continue;
    const values = typeof c.help.access === 'string' ? [c.help.access] : Object.values(c.help.access);
    for (const v of values) assert.ok(KNOWN_ACCESS.includes(v), `/${c.data.name} access "${v}"`);
  }
});

test('an option with null help text is hidden', () => {
  const data = new SlashCommandBuilder().setName('x').setDescription('X').addStringOption(o => o.setName('a').setDescription('A')).addStringOption(o => o.setName('b').setDescription('B'));
  const [entry] = docs.describeCommands([{ data, help: { options: { b: null } } }]);
  assert.deepEqual(entry.options.map(o => o.name), ['a']);
});

test('no block of the real commands is cut short', () => {
  const embeds = docs.buildCommandEmbeds(entries.filter(e => e.role !== 'everyone'));
  for (const e of embeds) for (const f of e.toJSON().fields) assert.ok(!f.value.endsWith('…') && f.value.length < 1024, f.value);
});

test('every staff command has a help.access', () => {
  assert.ok(staff.length >= 12);
  for (const c of staff) assert.ok(c.help?.access, `/${c.data.name} has no help.access`);
});

test('every help example, access and option key matches the command', () => {
  for (const c of real.values()) {
    if (!c.help) continue;
    const mine = entries.filter(e => e.name === c.data.name);
    const subPaths = mine.map(subPathOf);
    for (const key of Object.keys(c.help.examples ?? {})) assert.ok(subPaths.includes(key), `/${c.data.name} example "${key}"`);
    if (typeof c.help.access === 'object') {
      for (const key of Object.keys(c.help.access)) assert.ok(key === '' || subPaths.includes(key), `/${c.data.name} access "${key}"`);
    }
    const optionNames = new Set(mine.flatMap(e => e.options.map(o => o.name)));
    for (const [key, text] of Object.entries(c.help.options ?? {})) assert.ok(text === null || optionNames.has(key), `/${c.data.name} option "${key}"`);
  }
});

test('every subcommand of a staff command has a written example', () => {
  for (const c of staff) {
    for (const e of entries.filter(x => x.name === c.data.name)) {
      assert.ok(c.help.examples?.[subPathOf(e)], `/${e.path} has no example`);
      assert.ok(e.example.startsWith(`/${e.path}`), `/${e.path} example starts with the command`);
    }
  }
});

test('pethighscore new is Owner and the rest of pethighscore is Templar', () => {
  const pet = entries.filter(e => e.name === 'pethighscore');
  assert.equal(pet.find(e => e.path === 'pethighscore new').role, 'owner');
  for (const e of pet.filter(x => x.path !== 'pethighscore new')) assert.equal(e.role, 'templar');
});

test('submission intake commands are Manage Server and the rest Templar', () => {
  const sub = entries.filter(e => e.name === 'submission');
  assert.equal(sub.find(e => e.path === 'submission setintakeurl').access, 'Manage Server');
  assert.equal(sub.find(e => e.path === 'submission showintakeurl').role, 'admin');
  assert.equal(sub.find(e => e.path === 'submission format').role, 'templar');
});

function fakeClient(commands, roles = new Map()) {
  return {
    commands,
    guilds: { cache: { get: () => ({ roles: { cache: { get: id => roles.get(id) } } }) } },
  };
}

const messageText = payload => payload.embeds.map(e => JSON.stringify(e.toJSON())).join('\n');

test('the post leaves out everyone commands and groups the rest by role', () => {
  const payloads = post.buildAdminPayloads(fakeClient(real));
  const all = payloads.map(messageText).join('\n');
  for (const name of ['lfg-post', 'lfg-roles', 'link', 'weeklycompstats']) assert.ok(!all.includes(`**/${name}`), name);
  const titles = payloads.flatMap(p => p.embeds.map(e => e.toJSON().title)).filter(t => t?.startsWith('📋'));
  assert.deepEqual(titles, [
    '📋 Admin commands', '📋 Owner commands', '📋 Templar commands', '📋 Coordinator commands', '📋 Server admin commands',
  ]);
  const owner = messageText(payloads[1]);
  assert.ok(owner.includes('**/migration') && owner.includes('**/pethighscore new'));
  assert.ok(!owner.includes('**/pethighscore add'));
});

test('role headers mention the role and use its colour; nothing pings', () => {
  const roles = new Map([['333', { color: 0x00aa88 }], ['222', { color: 0 }]]);
  const payloads = post.buildAdminPayloads(fakeClient(real, roles));
  const coordinator = payloads.find(p => p.embeds[0].toJSON().title === '📋 Coordinator commands');
  assert.equal(coordinator.embeds[0].toJSON().description, '<@&333>');
  for (const e of coordinator.embeds) assert.equal(e.toJSON().color, 0x00aa88);
  const templar = payloads.find(p => p.embeds[0].toJSON().title === '📋 Templar commands');
  assert.equal(templar.embeds[0].toJSON().description, '<@&222>');
  assert.equal(templar.embeds[0].toJSON().color, require('../src/utils/embedColor.js').DEFAULT_EMBED_COLOR);
  for (const p of payloads) assert.deepEqual(p.allowedMentions, { parse: [] });
});

test('no environment variable names appear in the post', () => {
  const text = post.buildAdminPayloads(fakeClient(real)).map(messageText).join(' ');
  assert.equal(text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g), null);
  assert.ok(!text.includes('Updated'));
});

test('describeCommands walks subcommands and groups', () => {
  const data = new SlashCommandBuilder().setName('demo').setDescription('Demo').setDefaultMemberPermissions(0)
    .addSubcommand(s => s.setName('one').setDescription('First').addUserOption(o => o.setName('who').setDescription('Someone').setRequired(true)))
    .addSubcommandGroup(g => g.setName('grp').setDescription('Group')
      .addSubcommand(s => s.setName('two').setDescription('Second')
        .addStringOption(o => o.setName('kind').setDescription('x'.repeat(90)).setRequired(true).addChoices({ name: 'A', value: 'a' }))
        .addIntegerOption(o => o.setName('n').setDescription('A number'))));
  const out = docs.describeCommands([{ data }]);
  assert.deepEqual(out.map(e => e.path), ['demo one', 'demo grp two']);
  assert.equal(out[0].example, '/demo one who:@member');
  assert.equal(out[1].example, '/demo grp two kind:a');
  assert.equal(out[1].access, 'Staff');
  assert.equal(out[1].role, 'admin');
  assert.equal(out[1].category, 'Other');
  assert.deepEqual(out[1].options.map(o => [o.name, o.required]), [['kind', true], ['n', false]]);
  assert.ok(out[1].options[0].text.length <= 60 && out[1].options[0].text.endsWith('…'));
});

test('access falls back to the default permissions', () => {
  assert.equal(docs.fallbackAccess(null), 'Everyone');
  assert.equal(docs.fallbackAccess('32'), 'Manage Server');
  assert.equal(docs.fallbackAccess('268435456'), 'Manage Roles');
  assert.equal(docs.fallbackAccess('0'), 'Staff');
});

test('a block follows the mockup layout', () => {
  const [embed] = docs.buildCommandEmbeds([{
    name: 'profile', path: 'profile', role: 'coordinator', description: 'What is stored.', access: 'Coordinator', category: 'Members',
    example: '/profile rsn:Zezima', options: [{ name: 'member', required: false, text: 'a member' }, { name: 'rsn', required: true, text: 'a name' }],
  }]);
  assert.equal(embed.toJSON().fields[0].value,
    '**/profile** What is stored.\n**Example:** `/profile rsn:Zezima`\n**Options:**\n`member` [optional] a member\n`rsn` a name');
});

test('categories title the first embed of each category', () => {
  const e = (name, category) => ({ name, path: name, category, description: 'd', example: `/${name}`, options: [] });
  const embeds = docs.buildCommandEmbeds([e('a', 'One'), e('b', 'One'), e('c', 'Two')], { categories: true });
  assert.deepEqual(embeds.map(x => x.toJSON().title), ['One', undefined, 'Two']);
  assert.equal(docs.buildCommandEmbeds([e('a', 'One')])[0].toJSON().title, undefined);
});

test('the role messages show categories', () => {
  const owner = post.buildAdminPayloads(fakeClient(real))[1];
  assert.ok(owner.embeds.some(x => ['Bot admin', 'Leaderboards', 'Members'].includes(x.toJSON().title)));
});

test('a block without options has no Options line', () => {
  const [embed] = docs.buildCommandEmbeds([{ name: 'a', path: 'a', description: 'd', example: '/a', options: [] }]);
  assert.ok(!embed.toJSON().fields[0].value.includes('Options'));
});

test('a long command continues in a (cont.) embed within the field limits', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: 'big', path: `big s${i}`, description: 'd', example: '/big', options: [] }));
  const embeds = docs.buildCommandEmbeds(many);
  assert.equal(embeds.length, 2);
  assert.equal(embeds[0].toJSON().fields.length, 25);
  assert.equal(embeds[1].toJSON().title, '/big (cont.)');
  const huge = docs.buildCommandEmbeds([{ name: 'h', path: 'h', description: 'x'.repeat(2000), example: '/h', options: [] }]);
  assert.ok(huge[0].toJSON().fields[0].value.length <= 1024);
});

test('packEmbeds stays within Discord limits for the real commands', () => {
  const payloads = post.buildAdminPayloads(fakeClient(real));
  for (const p of payloads) {
    assert.ok(p.embeds.length <= 10);
    assert.ok(p.embeds.reduce((n, e) => n + docs.embedLength(e), 0) <= 6000);
  }
  const many = Array.from({ length: 25 }, () => new EmbedBuilder().setDescription('x'.repeat(900)));
  for (const group of docs.packEmbeds(many)) {
    assert.ok(group.length <= 10 && group.reduce((n, e) => n + docs.embedLength(e), 0) <= 5500);
  }
});

// A mock channel holding messages by id.
function mockChannel() {
  let next = 1;
  const messages = new Map();
  const log = [];
  const gone = () => Object.assign(new Error('Unknown Message'), { code: 10008 });
  const channel = {
    id: 'c1',
    messages: {
      edit: async (id, payload) => { log.push(`edit ${id}`); if (!messages.has(id)) throw gone(); messages.set(id, payload); },
      delete: async id => { log.push(`delete ${id}`); if (!messages.delete(id)) throw gone(); },
    },
    send: async payload => { const id = `m${next++}`; log.push(`send ${id}`); messages.set(id, payload); return { id }; },
  };
  const client = { channels: { fetch: async () => channel } };
  return { client, messages, log };
}

const payload = text => ({ embeds: [new EmbedBuilder().setDescription(text)] });

test('syncStaticMessages posts, skips when unchanged, then edits', async () => {
  const key = 'sync-a.json';
  const { client, log } = mockChannel();
  assert.equal(await syncStaticMessages(client, { key, channelId: 'c1', payloads: [payload('a'), payload('b')] }), 'reposted');
  assert.deepEqual(log, ['send m1', 'send m2']);
  log.length = 0;
  assert.equal(await syncStaticMessages(client, { key, channelId: 'c1', payloads: [payload('a'), payload('b')] }), 'unchanged');
  assert.deepEqual(log, []);
  assert.equal(await syncStaticMessages(client, { key, channelId: 'c1', payloads: [payload('a'), payload('c')] }), 'updated');
  assert.deepEqual(log, ['edit m1', 'edit m2']);
  assert.deepEqual(db.readState(key).messageIds, ['m1', 'm2']);
});

test('syncStaticMessages sends extras and deletes leftovers', async () => {
  const key = 'sync-b.json';
  const { client, log } = mockChannel();
  await syncStaticMessages(client, { key, channelId: 'c1', payloads: [payload('a'), payload('b')] });
  log.length = 0;
  await syncStaticMessages(client, { key, channelId: 'c1', payloads: [payload('a'), payload('b'), payload('c')] });
  assert.deepEqual(log, ['edit m1', 'edit m2', 'send m3']);
  log.length = 0;
  await syncStaticMessages(client, { key, channelId: 'c1', payloads: [payload('z')] });
  assert.deepEqual(log, ['edit m1', 'delete m2', 'delete m3']);
  assert.deepEqual(db.readState(key).messageIds, ['m1']);
});

test('syncStaticMessages reposts everything when a message is gone', async () => {
  const key = 'sync-c.json';
  const { client, log, messages } = mockChannel();
  await syncStaticMessages(client, { key, channelId: 'c1', payloads: [payload('a'), payload('b')] });
  messages.delete('m1');
  log.length = 0;
  assert.equal(await syncStaticMessages(client, { key, channelId: 'c1', payloads: [payload('a'), payload('x')] }), 'reposted');
  assert.deepEqual(log, ['edit m1', 'delete m1', 'delete m2', 'send m3', 'send m4']);
  assert.deepEqual(db.readState(key).messageIds, ['m3', 'm4']);
});

test('syncStaticMessages reposts when the channel changed', async () => {
  const key = 'sync-d.json';
  const { client, log } = mockChannel();
  await syncStaticMessages(client, { key, channelId: 'c1', payloads: [payload('a')] });
  log.length = 0;
  assert.equal(await syncStaticMessages(client, { key, channelId: 'c2', payloads: [payload('a')] }), 'reposted');
  assert.deepEqual(log, ['delete m1', 'send m2']);
  assert.equal(db.readState(key).channelId, 'c2');
});

test('ensureAdminCommandsPost does nothing without a channel', async () => {
  delete process.env.ADMIN_COMMANDS_CHANNEL_ID;
  await post.ensureAdminCommandsPost({ get commands() { throw new Error('should not be read'); } });
});

test('ensureAdminCommandsPost posts once and is quiet on a second run', async () => {
  process.env.ADMIN_COMMANDS_CHANNEL_ID = 'c1';
  const { client, log } = mockChannel();
  client.commands = real;
  client.guilds = { cache: { get: () => null } };
  await post.ensureAdminCommandsPost(client);
  assert.ok(log.length >= 5);
  log.length = 0;
  await post.ensureAdminCommandsPost(client);
  assert.deepEqual(log, []);
  delete process.env.ADMIN_COMMANDS_CHANNEL_ID;
});
