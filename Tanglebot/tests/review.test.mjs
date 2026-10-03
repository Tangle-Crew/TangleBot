import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(new URL('../src/', import.meta.url).pathname);
class Builder {
  setName(name) { this.name = name; return this; }
  setDescription() { return this; }
  setRequired() { return this; }
  setMaxLength() { return this; }
  setDefaultMemberPermissions() { return this; }
  addStringOption(fn) { fn(new Builder()); return this; }
  addBooleanOption(fn) { fn(new Builder()); return this; }
  setColor() { return this; }
  setTitle() { return this; }
  addFields() { return this; }
  setTimestamp() { return this; }
  setFooter() { return this; }
}
function load(relative, { axios = {}, env = {}, logs = [], fetch = async () => { throw new Error('Unexpected network request'); } } = {}) {
  const cache = new Map();
  function requireFile(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      module, fetch, process: { env }, console: { error: (...args) => logs.push(args), log() {} },
      require: name => {
        if (name === 'axios') return axios;
        if (name === './db') return { readJson: () => ({}), writeJson() {} };
        if (name === 'discord.js') return { SlashCommandBuilder: Builder, EmbedBuilder: Builder,
          MessageFlags: { Ephemeral: 64 }, PermissionFlagsBits: { ManageRoles: 1, ManageGuild: 2 } };
        if (name.startsWith('.')) return requireFile(path.resolve(path.dirname(file), name + '.js'));
        throw new Error(`Unexpected dependency: ${name}`);
      },
    }, { filename: file });
    return module.exports;
  }
  return requireFile(path.join(root, relative));
}
const ids = { a: '100000000000000001', b: '100000000000000002', stale: '100000000000000003',
  roleA: '200000000000000001', roleB: '200000000000000002', other: '200000000000000003' };
function guildFixture({ permission = true, editable = true } = {}) {
  const changes = [];
  function member(id, roles = []) {
    const cache = new Map(roles.map(role => [role, {}]));
    return { id, manageable: true, roles: { cache,
      add: async role => { changes.push(['add', id, role]); cache.set(role, {}); },
      remove: async role => { changes.push(['remove', id, role]); cache.delete(role); },
    } };
  }
  const members = new Map([
    [ids.a, member(ids.a, [ids.roleA, ids.other])], [ids.b, member(ids.b)],
    [ids.stale, member(ids.stale, [ids.roleA, ids.other])],
  ]);
  const roles = new Map([ids.roleA, ids.roleB].map(id => [id, { editable,
    get members() { return new Map([...members].filter(([, m]) => m.roles.cache.has(id))); },
  }]));
  const fetches = [];
  const guild = { id: 'guild', roles: { fetch: async () => roles, cache: roles }, members: {
    fetchMe: async () => ({ permissions: { has: () => permission } }),
    fetch: async options => { fetches.push(options); return members; },
  } };
  return { guild, changes, members, fetches };
}
const assignment = (discordUserId, roleId) => ({ discordUserId, roleId });
const plan = assignments => ({ roleIds: [ids.roleA, ids.roleB], assignments });

test('GIM sync removes stale holders, merges duplicate users and is idempotent', async () => {
  const { reconcileGimRoles } = load('utils/gimRoleSync.js');
  const f = guildFixture();
  const desired = plan([assignment(ids.a, ids.roleA), assignment(ids.a, ids.roleB), assignment(ids.b, ids.roleB)]);
  const first = await reconcileGimRoles(f.guild, desired);
  assert.equal(first.updated, 3);
  assert.equal(first.failures.length, 0);
  assert.equal(f.members.get(ids.a).roles.cache.has(ids.roleA), true);
  assert.equal(f.members.get(ids.a).roles.cache.has(ids.roleB), true);
  assert.equal(f.members.get(ids.stale).roles.cache.has(ids.roleA), false);
  assert.equal(f.members.get(ids.stale).roles.cache.has(ids.other), true);
  assert.equal(f.fetches.length, 1);
  assert.equal(typeof f.fetches[0], 'object');
  const second = await reconcileGimRoles(f.guild, desired);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 2);
});

test('null Discord IDs are reported without stopping remaining assignments', async () => {
  const { reconcileGimRoles } = load('utils/gimRoleSync.js');
  const f = guildFixture();
  const result = await reconcileGimRoles(f.guild, plan([assignment(null, ids.roleA), assignment(ids.b, ids.roleB)]));
  assert.equal(result.failures.length, 1);
  assert.equal(f.members.get(ids.b).roles.cache.has(ids.roleB), true);
  assert.equal(f.fetches.length, 1);
});

test('uneditable roles are failures, not Already correct', async () => {
  const { reconcileGimRoles } = load('utils/gimRoleSync.js');
  const f = guildFixture({ editable: false });
  const result = await reconcileGimRoles(f.guild, plan([assignment(ids.a, ids.roleA)]));
  assert.equal(result.unchanged, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.failures.length, 2);
  assert.equal(f.changes.length, 0);
});

test('missing permissions and malformed plans do not change roles', async () => {
  const { reconcileGimRoles } = load('utils/gimRoleSync.js');
  const f = guildFixture({ permission: false });
  await assert.rejects(reconcileGimRoles(f.guild, plan([])), /Manage Roles/);
  await assert.rejects(reconcileGimRoles(f.guild, {}), /Invalid GIM/);
  assert.equal(f.changes.length, 0);
});

test('Discord failures are logged without exposing raw API errors', async () => {
  const logs = [];
  const { reconcileGimRoles } = load('utils/gimRoleSync.js', { logs });
  const f = guildFixture();
  f.members.get(ids.b).roles.add = async () => { throw new Error('private API details'); };
  const result = await reconcileGimRoles(f.guild, plan([assignment(ids.b, ids.roleB)]));
  assert.equal(result.failures.some(message => message.includes('private API details')), false);
  assert.equal(logs.length, 1);
  assert.match(JSON.stringify(logs), /private API details/);
});

test('time budget returns unprocessed members rather than false success', async () => {
  const { reconcileGimRoles } = load('utils/gimRoleSync.js');
  const f = guildFixture();
  const result = await reconcileGimRoles(f.guild, plan([assignment(ids.b, ids.roleB)]), { deadline: 0 });
  assert.equal(result.unprocessed, 3);
  assert.equal(result.updated, 0);
  assert.equal(f.changes.length, 0);
});

test('blank website URL falls back to the absolute clan website', async () => {
  const { getConfig, createAccountLinkChallenge } = load('utils/clanAccountLink.js', { axios: {
    post: async () => ({ data: { challenge_token: 'test', expires_at: '2026-10-03T20:00:00Z', resolved_rsn: 'Player', link_kind: 'primary' } }),
  } });
  for (const value of [undefined, '', '   ']) assert.equal(getConfig({ CLAN_WEBSITE_URL: value }).websiteUrl, 'https://tanglecrew.group');
  const result = await createAccountLinkChallenge({ discordUserId: ids.a, rsn: 'Player', linkKind: 'primary' }, {
    SUPABASE_URL: 'https://example.test/', SUPABASE_SERVICE_ROLE_KEY: 'key', CLAN_WEBSITE_URL: '',
  });
  assert.match(result.confirmationUrl, /^https:\/\/tanglecrew.group\/login\?next=/);
});

test('service errors are sanitized for users and secrets redacted from logs', async () => {
  const logs = [];
  const env = { SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'super-secret-key' };
  const { callServiceRpc } = load('utils/clanAccountLink.js', { env, logs, axios: {
    post: async () => { throw { response: { status: 401, data: { message: 'Invalid API key super-secret-key' } } }; },
  } });
  await assert.rejects(callServiceRpc('example'), error => {
    assert.match(error.message, /clan service is unavailable/);
    assert.doesNotMatch(error.message, /Invalid API key/);
    return true;
  });
  assert.match(JSON.stringify(logs), /Invalid API key/);
  assert.doesNotMatch(JSON.stringify(logs), /super-secret-key/);
});

test('all four roster commands require explicit true opt-in', () => {
  const { commandDisabledReason } = load('utils/commandAvailability.js');
  const env = { SUPABASE_URL: 'url', SUPABASE_SERVICE_ROLE_KEY: 'key' };
  for (const file of ['link', 'linkalt', 'rankreview', 'gimrolesync']) {
    const command = load(`commands/${file}.js`);
    for (const flag of [undefined, '', 'false']) assert.ok(commandDisabledReason(command, { ...env, CLAN_ROSTER_COMMANDS_ENABLED: flag }));
    assert.equal(commandDisabledReason(command, { ...env, CLAN_ROSTER_COMMANDS_ENABLED: 'true' }), null);
  }
});

test('rank reviews default private but allow explicit public output', async () => {
  const env = { SUPABASE_URL: 'url', SUPABASE_SERVICE_ROLE_KEY: 'key' };
  const command = load('commands/rankreview.js', { env, axios: { post: async () => ({ data: [] }) } });
  for (const [option, flags] of [[null, 64], [false, undefined], [true, 64]]) {
    let actual;
    await command.execute({ options: { getBoolean: () => option },
      deferReply: async value => { actual = value.flags; }, editReply: async () => {},
    });
    assert.equal(actual, flags);
  }
});

test('parser accepts phase aliases, partial names, and either identifier', () => {
  const { parseSubmissionBody, isKcSubmission, isDropSubmission } = load('utils/submissionIntake.js');
  for (const [phase, expected] of [['Start or End: Start', 'starting'], ['Phase: End', 'ending'], ['Starting or Ending: Starting', 'starting']]) {
    for (const identity of ['Task name on Board: Zulra', 'Monster: Zulra']) {
      for (const body of [`${phase}\nKC: 1,234`, `KC: 1,234\n${phase}`]) {
        const parsed = parseSubmissionBody(`${identity}\n${body}`);
        assert.equal(parsed.phase, expected);
        assert.equal(parsed.kcValue, 1234);
        assert.equal(isKcSubmission(parsed), true);
      }
    }
  }
  assert.equal(isDropSubmission(parseSubmissionBody('Task: Bandos\nDrop: Bandos chesplate')), true);
  assert.equal(isKcSubmission(parseSubmissionBody('KC: 12')), false);
});

test('ordinary text chat never routes or replies, even with submission labels', async () => {
  let requests = 0;
  const { handleSubmissionMessage } = load('utils/submissionIntake.js', { axios: {
    get: async () => { requests++; throw new Error('Must not route ordinary chat'); },
  } });
  for (const content of ['Drop: rate is awful lol', 'Boss: is annoying', 'Item: looks nice', 'KC: 42', 'Monster: Zulrah\nStart KC: 123']) {
    const replies = [];
    await handleSubmissionMessage({ author: { bot: false }, content, attachments: new Map(), reply: async message => replies.push(message) }, { enabled: true });
    assert.equal(replies.length, 0);
  }
  assert.equal(requests, 0);
});

test('intake still rejects multiple photos and forwards valid monster-only proof', async () => {
  const bodies = [];
  const { handleSubmissionMessage } = load('utils/submissionIntake.js', {
    axios: { get: async () => ({ data: [{ event_id: 'event' }] }) },
    fetch: async (_, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, text: async () => '{}' }; },
  });
  const config = { enabled: true, supabaseUrl: 'https://example.test', intakeUrl: 'https://example.test/intake', intakeSecret: 'test' };
  const image = { contentType: 'image/png', name: 'proof.png', url: 'https://example.test/proof.png' };
  const replies = [];
  const edits = [];
  const message = { id: 'message', channelId: 'channel', guildId: 'guild', author: { bot: false, username: 'Player' },
    content: 'Monster: Zulra\nPhase: Start\nKC: 123', attachments: new Map([['a', image], ['b', image]]),
    reply: async text => { replies.push(text); return { edit: async text => edits.push(text) }; },
  };
  await handleSubmissionMessage(message, config);
  assert.match(replies[0], /exactly one image/);
  assert.equal(bodies.length, 0);
  message.attachments.delete('b');
  await handleSubmissionMessage(message, config);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].taskName, null);
  assert.equal(bodies[0].monsterName, 'Zulra');
  assert.equal(bodies[0].phase, 'starting');
  assert.match(edits[0], /sent to the site/);
});
