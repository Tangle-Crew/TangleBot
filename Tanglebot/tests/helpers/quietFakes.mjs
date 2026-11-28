// Fakes for the quiet members tests: the activity table in memory, state in memory and a small
// Discord server with an admin log. setup() must run before the code under test is required.
import { createRequire } from 'node:module';
import { mockPg } from './mockPg.mjs';

const require = createRequire(import.meta.url);

export const DAY = 24 * 60 * 60 * 1000;
export const ago = days => Date.now() - days * DAY;

const DISCORD_EPOCH = 1420070400000n;
let sequence = 0n;
// A Discord ID made at `time`.
export const snowflake = (time = Date.now()) => String(((BigInt(Math.floor(time)) - DISCORD_EPOCH) << 22n) + (sequence++ % 4000000n));

export function message({
  author, bot = false, type = 0, system = false, webhookId = null, interaction = null, channelId = 'general', guildId = 'clan', at = Date.now(),
}) {
  return {
    id: snowflake(at), createdTimestamp: at, channelId, guildId, type, system, webhookId,
    author: { id: author, bot }, interactionMetadata: interaction,
  };
}

export function voice(id, channelId, { bot = false } = {}) {
  return { id, channelId, guild: { id: 'clan' }, member: { user: { bot } } };
}

export function member(id, { joined = 30, bot = false, name = id, pending = false } = {}) {
  return { id, displayName: name, joinedTimestamp: ago(joined), pending, user: { id, username: `${name}_user`, bot } };
}

export function setup() {
  Object.assign(process.env, {
    CLAN_ID: 'clan', DATABASE_URL: 'postgres://u:p@host:5432/db', ADMIN_LOG_CHANNEL_ID: 'adminlog',
    OWNER_ROLE_ID: 'owner', TEMPLAR_ROLE_ID: 'templar', HONEYPOT_CHANNEL_ID: 'trap', HONEYPOT_VOICE_CHANNEL_ID: 'trapvoice',
  });

  const files = new Map();
  const state = require('../../src/utils/state.js');
  state.readState = name => structuredClone(files.get(name) ?? {});
  state.writeState = (name, value) => { files.set(name, JSON.parse(JSON.stringify(value))); };

  const fakes = { files, rows: new Map(), commandLog: [], joins: new Map(), failDatabase: false, voiceStates: new Map() };

  const upsert = (discordId, kind, firstAt, lastAt) => {
    const key = `${discordId}:${kind}`;
    const row = fakes.rows.get(key);
    fakes.rows.set(key, {
      discordId, kind,
      firstAt: row && row.firstAt < firstAt ? row.firstAt : firstAt,
      lastAt: row && row.lastAt > lastAt ? row.lastAt : lastAt,
    });
  };

  const respond = (sql, params) => {
    if (fakes.failDatabase) throw new Error('database down');
    if (/insert into member_activity .*unnest/s.test(sql)) {
      params[0].forEach((id, i) => upsert(id, params[1][i], params[2][i], params[3][i]));
    } else if (/insert into member_activity .*from command_log/s.test(sql)) {
      const rows = fakes.commandLog.filter(row => !params[0].includes(row.channelId));
      for (const row of rows) upsert(row.discordId, 'command', row.at, row.at);
      return { rowCount: rows.length };
    } else if (/from member_activity where/.test(sql)) {
      const latest = new Map();
      for (const row of fakes.rows.values()) {
        if (!params[0].includes(row.discordId)) continue;
        if (!latest.has(row.discordId) || latest.get(row.discordId) < row.lastAt) latest.set(row.discordId, row.lastAt);
      }
      return { rows: [...latest].map(([discord_id, last_at]) => ({ discord_id, last_at })) };
    } else if (/from member_events/.test(sql)) {
      return { rows: [...fakes.joins].filter(([id]) => params[0].includes(id)).map(([member_id, joins]) => ({ member_id, joins: String(joins) })) };
    }
    return undefined;
  };

  const database = require('../../src/utils/database.js');
  database.getPool = () => fakes.pg.pool;

  fakes.reset = () => {
    files.clear();
    fakes.rows.clear();
    fakes.joins.clear();
    fakes.voiceStates.clear();
    fakes.commandLog = [];
    fakes.failDatabase = false;
    fakes.pg = mockPg(respond);

    // The admin log: message ID -> its latest payload.
    fakes.posts = new Map();
    const gone = () => Object.assign(new Error('Unknown Message'), { code: 10008 });
    fakes.adminChannel = {
      send: async payload => {
        const id = snowflake();
        fakes.posts.set(id, payload);
        return { id };
      },
      messages: {
        edit: async (id, payload) => {
          if (!fakes.posts.has(id)) throw gone();
          fakes.posts.set(id, payload);
        },
        delete: async id => {
          if (!fakes.posts.delete(id)) throw gone();
        },
      },
    };

    fakes.members = [];
    fakes.memberCount = null;
    fakes.guildChannels = [];
    fakes.activeThreads = [];
    const guild = {
      get memberCount() { return fakes.memberCount ?? fakes.members.length; },
      members: {
        fetch: async () => new Map(fakes.members.map(m => [m.id, m])),
        fetchMe: async () => ({ id: 'me' }),
      },
      channels: {
        fetch: async () => new Map(fakes.guildChannels.map(c => [c.id, c])),
        fetchActiveThreads: async () => ({ threads: new Map(fakes.activeThreads.map(t => [t.id, t])) }),
      },
      voiceStates: { cache: fakes.voiceStates },
    };
    fakes.client = { guilds: { fetch: async () => guild }, channels: { fetch: async () => fakes.adminChannel } };
  };

  fakes.reset();
  return fakes;
}

// A slash command interaction. Its public reply lands in the admin log when run there.
export function interaction(fakes, { channelId = 'elsewhere', roles = ['owner', 'templar'], subcommand = null, days = null } = {}) {
  const sent = { replies: [], edits: [], followUps: [], deleted: false };
  let replyId = null;
  return {
    sent,
    client: fakes.client,
    guildId: 'clan',
    channelId,
    member: { displayName: 'Staff', roles: { cache: new Set(roles) } },
    user: { id: 'staff', username: 'staff', tag: 'staff#0', toString: () => '<@staff>' },
    options: { getSubcommand: () => subcommand, getInteger: () => days },
    reply: async payload => { sent.replies.push(payload); },
    deferReply: async options => { sent.deferred = options; },
    deleteReply: async () => { sent.deleted = true; },
    followUp: async payload => { sent.followUps.push(payload); },
    editReply: async payload => {
      sent.edits.push(payload);
      if (channelId !== 'adminlog' || typeof payload === 'string') return { id: replyId };
      replyId = snowflake();
      fakes.posts.set(replyId, payload);
      return { id: replyId };
    },
  };
}

export function button(fakes, customId, messageId, { roles = ['owner', 'templar'] } = {}) {
  const sent = { replies: [], updates: [], followUps: [] };
  return {
    sent,
    customId,
    client: fakes.client,
    guildId: 'clan',
    message: { id: messageId },
    member: { displayName: 'Staff', roles: { cache: new Set(roles) } },
    user: { id: 'staff', username: 'staff', tag: 'staff#0', toString: () => '<@staff>' },
    reply: async payload => { sent.replies.push(payload); },
    update: async payload => { sent.updates.push(payload); },
    deferUpdate: async () => {},
    followUp: async payload => { sent.followUps.push(payload); },
  };
}

// The title and text of a posted payload's first embed.
export const embedOf = payload => payload.embeds[0].toJSON();
