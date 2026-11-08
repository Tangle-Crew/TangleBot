import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const nodeRequire = createRequire(import.meta.url);
class Builder {
  setName(name) { this.name = name; return this; }
  setDescription() { return this; }
  setRequired() { return this; }
  setMaxLength() { return this; }
  setAutocomplete() { return this; }
  setImage() { return this; }
  setDefaultMemberPermissions() { return this; }
  addStringOption(fn) { fn(new Builder()); return this; }
  addBooleanOption(fn) { fn(new Builder()); return this; }
  addIntegerOption(fn) { fn(new Builder()); return this; }
  setMinValue() { return this; }
  setMaxValue() { return this; }
  setColor() { return this; }
  setTitle() { return this; }
  addFields() { return this; }
  setTimestamp() { return this; }
  setFooter() { return this; }
}
// mocks: replacements by require() name; fastTimers: setTimeout waits 0 ms.
function load(relative, { axios = {}, env = {}, logs = [], mocks = {}, fastTimers = false,
  fetch = async () => { throw new Error('Unexpected network request'); } } = {}) {
  const cache = new Map();
  function requireFile(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      module, fetch, process: { env }, console: { error: (...args) => logs.push(args), log() {} },
      ...(fastTimers ? { setTimeout: fn => setTimeout(fn, 0) } : {}),
      require: name => {
        if (name in mocks) return mocks[name];
        if (name === 'axios') return axios;
        if (name === '@wise-old-man/utils' || name === 'events') return nodeRequire(name);
        if (name === './db' || name === '../utils/db') return { readJson: () => ({}), writeJson() {}, withTimeout: promise => promise,
          truncate: (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text) };
        if (name === 'discord.js') return { SlashCommandBuilder: Builder, EmbedBuilder: Builder,
          MessageFlags: { Ephemeral: 64 }, PermissionFlagsBits: { ManageRoles: 1, ManageGuild: 2 },
          escapeMarkdown: text => text, ChannelType: { GuildCategory: 4 }, embedLength: () => 0 };
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

test('only required changes to uneditable roles are failures', async () => {
  const { reconcileGimRoles } = load('utils/gimRoleSync.js');
  const f = guildFixture({ editable: false });
  const result = await reconcileGimRoles(f.guild, plan([assignment(ids.a, ids.roleA)]));
  assert.equal(result.unchanged, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.failures.length, 1);
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
  for (const content of ['Drop: rate is awful lol', 'Boss: is annoying', 'Item: looks nice', 'KC: 42']) {
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

test('link commands show actionable database errors and log each failure once', async () => {
  const env = { SUPABASE_URL: 'url', SUPABASE_SERVICE_ROLE_KEY: 'key' };
  for (const commandName of ['link', 'linkalt']) {
    for (const message of ['Link a primary account with /link before adding an alt.', 'That account is already linked to another Discord member. Contact an administrator.']) {
      const logs = [];
      const command = load(`commands/${commandName}.js`, { env, logs, axios: {
        post: async () => { throw { response: { status: 400, data: { code: 'P0001', message } } }; },
      } });
      let reply;
      await command.execute({ user: { id: ids.a }, options: { getString: () => 'Player' },
        deferReply: async () => {}, editReply: async value => { reply = value.content; },
      });
      assert.equal(reply, message);
      assert.equal(logs.length, 1);
    }
  }
});

test('link commands keep auth, server and unknown database errors private, logging once', async () => {
  const env = { SUPABASE_URL: 'url', SUPABASE_SERVICE_ROLE_KEY: 'key' };
  for (const [status, code, message] of [[401, 'P0001', 'Invalid API key'], [500, 'P0001', 'internal failure'],
    [400, 'P0001', 'Service role access is required.'], [400, '42P01', 'missing table'], [400, 'P0001', 'Unexpected internal database problem']]) {
    const logs = [];
    const command = load('commands/link.js', { env, logs, axios: {
      post: async () => { throw { response: { status, data: { code, message } } }; },
    } });
    let reply;
    await command.execute({ user: { id: ids.a }, options: { getString: () => 'Player' },
      deferReply: async () => {}, editReply: async value => { reply = value.content; },
    });
    assert.match(reply, /clan service is unavailable/);
    assert.equal(reply.includes(message), false);
    assert.equal(logs.length, 1);
  }
});

test('complete proof text gets a missing-image reminder only in configured channels', async () => {
  const { handleSubmissionMessage } = load('utils/submissionIntake.js', { axios: {
    get: async (_, options) => ({ data: options.params.channel_id === 'eq.proofs' ? [{ event_id: 'event' }] : [] }),
  } });
  for (const channelId of ['proofs', 'chat']) {
    for (const content of ['Monster: Zulrah\nPhase: Start\nKC: 12', 'Task: Bandos\nDrop: Bandos chestplate']) {
      const replies = [];
      await handleSubmissionMessage({ channelId, author: { bot: false }, content, attachments: new Map(),
        reply: async text => replies.push(text),
      }, { enabled: true, supabaseUrl: 'url' });
      assert.equal(replies.length, channelId === 'proofs' ? 1 : 0);
      if (channelId === 'proofs') assert.match(replies[0], /exactly one image/);
    }
  }
});

test('concurrent GIM command reports already running and releases lock afterward', async () => {
  const f = guildFixture();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.guild.roles.fetch = () => pending;
  const command = load('commands/gimrolesync.js', {
    env: { SUPABASE_URL: 'url', SUPABASE_SERVICE_ROLE_KEY: 'key' },
    axios: { post: async () => ({ data: plan([assignment(ids.a, ids.roleA)]) }) },
  });
  const replies = [];
  const interaction = { guild: f.guild, deferReply: async () => {}, editReply: async value => replies.push(value) };
  const first = command.execute(interaction);
  // Let the first command acquire the lock and wait for roles.fetch.
  await new Promise(resolve => setImmediate(resolve));
  await command.execute(interaction);
  assert.match(replies[0].content, /already running/);
  assert.doesNotMatch(replies[0].content, /check.*permissions/);
  release();
  await first;
  await command.execute(interaction);
  assert.ok(replies.at(-1).embeds);
});

test('competitionMetrics lists every metric and falls back to the single metric', () => {
  const { competitionMetrics, competitionMetricLabel } = load('utils/womMetrics.js');
  const multi = { metric: 'attack', metrics: [{ metric: 'attack', weight: 1 }, { metric: 'strength', weight: 1 }] };
  assert.deepEqual([...competitionMetrics(multi)], ['attack', 'strength']);
  assert.equal(competitionMetricLabel(multi), 'Attack + Strength');
  assert.deepEqual([...competitionMetrics({ metric: 'the_gauntlet' })], ['the_gauntlet']);
  assert.deepEqual([...competitionMetrics({ metric: 'the_gauntlet', metrics: [] })], ['the_gauntlet']);
  assert.equal(competitionMetricLabel({ metric: 'the_gauntlet' }), 'Gauntlet');
});

const womMocks = () => ({ './wiseOldMan': { ...load('utils/wiseOldMan.js') }, '@napi-rs/canvas': {} });
const withMetrics = (title, ...metrics) => ({ title, metric: metrics[0], metrics: metrics.map(metric => ({ metric, weight: 1 })) });

test('titles split before their metrics, whichever order WOM lists them in', () => {
  const { splitTitle } = load('utils/weeklyAnnounce.js', { mocks: womMocks() });
  const split = competition => { const { prefix, name } = splitTitle(competition); return [prefix, name]; };
  for (const order of [['attack', 'strength'], ['strength', 'attack']]) {
    assert.deepEqual(split(withMetrics('SOTW T3 Attack + Strength', ...order)), ['SOTW T3 ', 'Attack + Strength']);
    assert.deepEqual(split(withMetrics('SOTW T3 Strength + Attack', ...order)), ['SOTW T3 ', 'Strength + Attack']);
  }
  for (const order of [['the_gauntlet', 'the_corrupted_gauntlet'], ['the_corrupted_gauntlet', 'the_gauntlet']]) {
    assert.deepEqual(split(withMetrics('BOTW T3 Gauntlet + Corrupted Gauntlet', ...order)), ['BOTW T3 ', 'Gauntlet + Corrupted Gauntlet']);
    assert.deepEqual(split(withMetrics('BOTW T3 Corrupted Gauntlet+Gauntlet', ...order)), ['BOTW T3 ', 'Corrupted Gauntlet+Gauntlet']);
  }
  assert.deepEqual(split({ title: 'BOTW T1: Amoxliatl', metric: 'amoxliatl' }), ['BOTW T1: ', 'Amoxliatl']);
  assert.deepEqual(split({ title: 'BOTW T3 The Gauntlet', metric: 'the_gauntlet' }), ['BOTW T3 ', 'The Gauntlet']);
  assert.deepEqual(split(withMetrics('Weekly event', 'attack', 'strength')), ['Weekly event', '']);
  // Only one of the two metrics named: not a match.
  assert.deepEqual(split(withMetrics('SOTW T3 Strength', 'attack', 'strength')), ['SOTW T3 Strength', '']);
});

const loadWeeklyComp = (options = {}) => load('commands/weeklycomp.js', {
  ...options,
  mocks: { '../utils/roleMenu': { notifyAdminLog() {} }, './weeklycompstats': { clearStandingsCache() {} },
    '../utils/wiseOldMan': {}, ...options.mocks },
});
const metricChoice = (value, name) => ({ value, name });

test('weeklycomp rejects metrics of mixed types and titles one competition for the rest', () => {
  const { hasMixedTypes, buildCompTitle } = loadWeeklyComp();
  const m = value => ({ value });
  assert.equal(hasMixedTypes([m('attack'), m('strength')]), false);
  assert.equal(hasMixedTypes([m('the_gauntlet'), m('zulrah')]), false);
  assert.equal(hasMixedTypes([m('attack'), m('zulrah')]), true);
  assert.equal(buildCompTitle('BOTW T2: God Wars Dungeon', [m('general_graardor'), m('kreearra')]), 'BOTW T2: God Wars Dungeon');
  assert.equal(buildCompTitle('SOTW', [m('sailing')]), 'SOTW Sailing');
});

test('event description is the title and link, plus a line per metric when there are several', () => {
  const { buildEventDescription } = loadWeeklyComp();
  const url = 'https://wiseoldman.net/competitions/162701';
  assert.equal(buildEventDescription('SOTW Sailing', url, [metricChoice('sailing', 'Sailing')]),
    `SOTW Sailing: ${url}`);
  assert.equal(
    buildEventDescription('BOTW GWD', url, [metricChoice('general_graardor', 'General Graardor'),
      metricChoice('commander_zilyana', 'Commander Zilyana'), metricChoice('kreearra', "Kree'arra")]),
    `BOTW GWD: ${url}\nGeneral Graardor\nCommander Zilyana\nKree'arra`);
});

test('event background is the first chosen metric that has one, else the generic icon', async () => {
  const probed = [];
  const withBackgrounds = backgrounds => async (url, options) => {
    probed.push(url);
    return { ok: backgrounds.some(name => url.endsWith(`/backgrounds/${name}.png`)) && options.method === 'HEAD' };
  };
  const base = 'https://raw.githubusercontent.com/wise-old-man/wise-old-man/master/app/public/img';
  const resolve = async (metrics, backgrounds) => {
    const wom = load('utils/wiseOldMan.js', { fetch: withBackgrounds(backgrounds) });
    return wom.resolveMetricImageUrl(metrics);
  };
  assert.equal(await resolve(['sailing'], ['sailing']), `${base}/backgrounds/sailing.png`);
  assert.equal(await resolve(['general_graardor', 'kreearra'], ['general_graardor', 'kreearra']), `${base}/backgrounds/general_graardor.png`);
  // The first pick (Mimic) has no background, so the next one is used.
  assert.equal(await resolve(['mimic', 'zulrah'], ['zulrah']), `${base}/backgrounds/zulrah.png`);
  assert.equal(await resolve(['mimic'], []), `${base}/fallback-icon.png`);
});

const participation = (id, name, progress, deltas) => ({
  player: { id, displayName: name }, progress: { start: 0, end: progress, gained: progress }, deltas,
});
const delta = (metric, gained) => ({ metric, values: { start: 0, end: gained, gained }, levels: { start: 1, end: 1, gained: 0 } });
const attackStrength = () => ({
  id: 7, groupId: 1, ...withMetrics('SOTW T3 Strength + Attack', 'attack', 'strength'),
  startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-01-03T00:00:00.000Z',
  participations: [
    participation(1, 'Alice', 1000, [delta('total', 1000), delta('attack', 600), delta('strength', 400)]),
    participation(2, 'Bob', 500, [delta('total', 500), delta('attack', 0), delta('strength', 500)]),
  ],
});

test('a multi-metric competition shows its per-metric breakdown without the total entry', () => {
  const wom = load('utils/wiseOldMan.js');
  const breakdown = wom.metricBreakdown(attackStrength());
  assert.equal(JSON.stringify([...breakdown.get(1)]), JSON.stringify([['attack', 600], ['strength', 400]]));
  assert.equal(JSON.stringify([...breakdown.get(2)]), JSON.stringify([['attack', 0], ['strength', 500]]));

  const stats = load('commands/weeklycompstats.js', { mocks: { '../utils/roleMenu': { notifyAdminLog() {} }, '../utils/embedColor': { DEFAULT_EMBED_COLOR: 0 } } });
  const competition = attackStrength();
  const ranked = wom.rankParticipants(competition);
  const [board] = stats.buildBoards([{ competition, ranked, total: 1500, breakdown }]);
  assert.deepEqual([...board.parts.map(part => part.metric)], ['attack', 'strength']);
  assert.equal(board.rows[0].name, 'Alice');
  const line = stats.formatRow(board.rows[0], board, { showBreakdown: true, highlightId: null });
  assert.match(line, /1,000 xp/);
  assert.match(line, /Attack 600 · Strength 400/);
  // A single-metric competition has no breakdown.
  const single = { id: 8, metric: 'zulrah', startsAt: competition.startsAt, endsAt: competition.endsAt };
  const [plain] = stats.buildBoards([{ competition: single, ranked: [{ id: 1, name: 'Alice', gained: 5 }], total: 5, breakdown: null }]);
  assert.equal(plain.parts.length, 1);
  assert.doesNotMatch(stats.formatRow(plain.rows[0], plain, { showBreakdown: true, highlightId: null }), /└/);
});

test('chart totals add up every metric of a multi-metric competition', async () => {
  const competition = attackStrength();
  const gainsCalls = [];
  const gains = {
    attack: [{ player: { id: 1 }, data: { gained: 200 } }, { player: { id: 2 }, data: { gained: 100 } }, { player: { id: 99 }, data: { gained: 50 } }],
    strength: [{ player: { id: 1 }, data: { gained: 300 } }],
  };
  const mocks = womMocks();
  Object.assign(mocks['./wiseOldMan'], {
    getCompetitionDetails: async () => competition,
    getCompetitionTopHistory: async () => [],
    getGroupGains: async (groupId, metric) => { gainsCalls.push(metric); return gains[metric]; },
  });
  const announce = load('utils/weeklyAnnounce.js', { mocks, fastTimers: true, env: { WOM_API_KEY: 'key' } });
  const [list] = await announce.loadWinnerLists([{ id: 7 }], { fresh: true });
  assert.deepEqual([...list.metrics].sort(), ['attack', 'strength']);
  assert.equal(list.names[0], 'Strength + Attack');

  const now = new Date(competition.endsAt).getTime();
  const data = await announce.loadChartData(list, { fresh: true, now });
  // Marks: start, one day in, the end. Players outside the competition are ignored.
  assert.deepEqual([...data.total], [0, 600, 1500]);
  assert.deepEqual([...gainsCalls].sort(), ['attack', 'strength']);
  assert.equal(data.players[0].values.at(-1), 1000);
});

test('the winners total line names every metric of a multi-metric competition', async () => {
  const mocks = womMocks();
  Object.assign(mocks['./wiseOldMan'], { getCompetitionDetails: async () => attackStrength() });
  const announce = load('utils/weeklyAnnounce.js', { mocks, fastTimers: true, env: { WOM_API_KEY: 'key' } });
  const [list] = await announce.loadWinnerLists([{ id: 7 }], { fresh: true });
  const text = announce.buildWinnersSection(list, { emojis: [], mentions: new Map() });
  assert.match(text, /\*\*Total\*\* \*\*Strength \+ Attack XP: 1,500\*\*/);
});

test('a multi-metric competition without metrics in its title is labelled by its title', async () => {
  const mocks = womMocks();
  const competition = { ...attackStrength(), title: 'BOTW T2: God Wars Dungeon' };
  Object.assign(mocks['./wiseOldMan'], { getCompetitionDetails: async () => competition });
  const announce = load('utils/weeklyAnnounce.js', { mocks, fastTimers: true, env: { WOM_API_KEY: 'key' } });
  const [list] = await announce.loadWinnerLists([{ id: 7 }], { fresh: true });
  assert.match(announce.buildWinnersSection(list, { emojis: [], mentions: new Map() }),
    /\*\*Total\*\* \*\*BOTW T2: God Wars Dungeon XP: 1,500\*\*/);
});
