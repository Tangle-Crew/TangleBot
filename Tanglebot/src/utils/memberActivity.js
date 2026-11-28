// Member activity (messages, voice joins, slash commands): what counts, the member_activity table,
// and live tracking. Only times are saved, never message content. Does nothing unless DATABASE_URL
// and CLAN_ID are set.
const { Events, InteractionType, GatewayRateLimitError } = require('discord.js');
const database = require('./database');
const { databaseConfigured } = require('./commandAvailability');
const { readState, writeState } = require('./state');
const { loadHoneypotConfig } = require('./honeypot');

// { trackingStartedAt, backfill, lastFinished, channelPost }
const STATE_FILE = 'member-activity.json';
// After a save, the same person and kind is saved again at most this often.
const THROTTLE_MS = 60 * 60 * 1000;

// "id:kind" -> when it was last saved.
const savedAt = new Map();
const KINDS = ['message', 'voice', 'command'];

function trackingEnabled() {
  return databaseConfigured() && Boolean(process.env.CLAN_ID);
}

function readActivityState() {
  const state = readState(STATE_FILE);
  return state && typeof state === 'object' ? state : {};
}

// Merges `changes` into the saved state.
function updateActivityState(changes) {
  writeState(STATE_FILE, { ...readActivityState(), ...changes });
}

// The honeypot channels never count.
function ignoredChannelIds() {
  return new Set(loadHoneypotConfig().trapChannelIds);
}

// What a message counts as: { discordId, kind, at }, or null. Used live and by the backfill.
function classifyMessage(message, ignored = ignoredChannelIds()) {
  // A thread's parent is checked too; for other channels the parent is a category.
  if (ignored.has(message.channelId) || ignored.has(message.channel?.parentId)) return null;
  const at = new Date(message.createdTimestamp);

  // A reply to a slash or context menu command counts for whoever ran it. Checked first, since a bot
  // wrote it. Replies to buttons and menus have another type and fall through.
  const interaction = message.interactionMetadata;
  if (interaction?.type === InteractionType.ApplicationCommand) {
    const { user } = interaction;
    return user && !user.bot ? { discordId: user.id, kind: 'command', at } : null;
  }
  if (!message.author || message.author.bot || message.webhookId) return null;
  // Join, boost and pin notices have the person as their author.
  if (message.system) return null;
  return { discordId: message.author.id, kind: 'message', at };
}

// [{ discordId, kind, at }] -> one { discordId, kind, firstAt, lastAt } per person and kind, since
// one upsert can't touch a row twice.
function combine(activity) {
  const rows = new Map();
  for (const { discordId, kind, at } of activity) {
    const key = `${discordId}:${kind}`;
    const row = rows.get(key);
    if (!row) rows.set(key, { discordId, kind, firstAt: at, lastAt: at });
    else {
      if (at < row.firstAt) row.firstAt = at;
      if (at > row.lastAt) row.lastAt = at;
    }
  }
  return [...rows.values()];
}

// Keeps the earliest first_at and the latest last_at, so saving the same activity again is harmless.
const KEEP_WIDEST = `on conflict (discord_id, kind) do update set
  first_at = least(member_activity.first_at, excluded.first_at),
  last_at = greatest(member_activity.last_at, excluded.last_at)`;

async function saveActivity(activity, db = database.getPool()) {
  const rows = combine(activity);
  if (!rows.length) return;
  await db.query(
    `insert into member_activity (discord_id, kind, first_at, last_at)
     select * from unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[])
     ${KEEP_WIDEST}`,
    [rows.map(r => r.discordId), rows.map(r => r.kind), rows.map(r => r.firstAt), rows.map(r => r.lastAt)]
  );
}

// Each person's earliest and latest command in the command log, of any status, leaving out those run
// in a honeypot channel. The log has no parent channel, so threads can't be told apart.
async function copyCommandLog(db = database.getPool()) {
  const result = await db.query(
    `insert into member_activity (discord_id, kind, first_at, last_at)
     select discord_id, 'command', min(created_at), max(created_at) from command_log
     where channel_id is null or channel_id <> all($1::text[])
     group by discord_id
     ${KEEP_WIDEST}`,
    [[...ignoredChannelIds()]]
  );
  return result.rowCount;
}

// Discord ID -> the latest activity of any kind.
async function latestActivity(discordIds, db = database.getPool()) {
  const { rows } = await db.query(
    'select discord_id, max(last_at) as last_at from member_activity where discord_id = any($1) group by discord_id',
    [discordIds]
  );
  return new Map(rows.map(r => [r.discord_id, new Date(r.last_at)]));
}

// Discord ID -> how many server joins the bot has recorded.
async function joinCounts(discordIds, db = database.getPool()) {
  const { rows } = await db.query(
    `select member_id, count(*) as joins from member_events
     where kind = 'server_joined' and member_id = any($1) group by member_id`,
    [discordIds]
  );
  return new Map(rows.map(r => [r.member_id, Number(r.joins)]));
}

// Every server member. Throws if Discord returns only part of the list (as syncMemberRoster
// checks), since anyone missing would be left out. Discord limits how often the whole list can be
// requested; then the cached list is used, which member events keep current.
async function fetchAllMembers(guild) {
  let members;
  try {
    members = await guild.members.fetch();
  } catch (err) {
    if (!(err instanceof GatewayRateLimitError)) throw err;
    members = guild.members.cache;
  }
  if (guild.memberCount && members.size < guild.memberCount * 0.9) {
    throw new Error(`Discord returned only ${members.size} of ${guild.memberCount} members. Try again in a few minutes.`);
  }
  return [...members.values()];
}

// Saves one live activity, throttled. Never throws.
async function recordActivity(discordId, kind, at = new Date(), { now = Date.now(), db } = {}) {
  if (!trackingEnabled()) return;
  const key = `${discordId}:${kind}`;
  const last = savedAt.get(key);
  if (last !== undefined && now - last < THROTTLE_MS) return;
  try {
    await saveActivity([{ discordId, kind, at }], db);
    // Only after it is saved, so a failed save is tried again next time.
    savedAt.set(key, now);
  } catch (err) {
    console.error(`[Activity] Failed to record a ${kind} for ${discordId}:`, err.message);
  }
}

// A slash command run on this bot, including ones refused or failed.
function recordCommand(interaction, at = new Date()) {
  if (interaction.guildId !== process.env.CLAN_ID || interaction.user.bot) return Promise.resolve();
  const ignored = ignoredChannelIds();
  if (ignored.has(interaction.channelId) || ignored.has(interaction.channel?.parentId)) return Promise.resolve();
  return recordActivity(interaction.user.id, 'command', at);
}

function forgetThrottle(discordId) {
  for (const kind of KINDS) savedAt.delete(`${discordId}:${kind}`);
}

// Forgets every throttle (for tests).
function resetThrottle() {
  savedAt.clear();
}

function handleMessage(message) {
  if (message.guildId !== process.env.CLAN_ID) return Promise.resolve();
  const activity = classifyMessage(message);
  return activity ? recordActivity(activity.discordId, activity.kind, activity.at) : Promise.resolve();
}

// Only joining voice counts: not moving, muting or leaving. Moving out of the honeypot voice channel
// is a join, since joining that one didn't count.
function handleVoiceState(oldState, newState) {
  if (!newState.channelId || newState.guild.id !== process.env.CLAN_ID || newState.member?.user.bot) return Promise.resolve();
  const ignored = ignoredChannelIds();
  if (ignored.has(newState.channelId) || (oldState.channelId && !ignored.has(oldState.channelId))) return Promise.resolve();
  return recordActivity(newState.id, 'voice');
}

function registerMemberActivity(client) {
  const run = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[Activity] Failed to handle ${label}:`, err);
    }
  };
  client.on(Events.MessageCreate, message => run('a message', () => handleMessage(message)));
  client.on(Events.VoiceStateUpdate, (oldState, newState) => run('a voice change', () => handleVoiceState(oldState, newState)));
  // So activity after a rejoin is saved at once.
  client.on(Events.GuildMemberRemove, member => forgetThrottle(member.id));
}

// On startup: saves when tracking started (once), and records everyone already in voice, who may
// have joined while the bot was down. Never throws.
async function startTracking(client) {
  if (!trackingEnabled()) return;
  try {
    if (!readActivityState().trackingStartedAt) {
      updateActivityState({ trackingStartedAt: new Date().toISOString() });
      console.log('[Activity] Live activity tracking started.');
    }
    const guild = await client.guilds.fetch(process.env.CLAN_ID);
    const ignored = ignoredChannelIds();
    const inVoice = [...guild.voiceStates.cache.values()]
      .filter(state => state.channelId && !ignored.has(state.channelId) && !state.member?.user.bot);
    for (const state of inVoice) await recordActivity(state.id, 'voice');
    if (inVoice.length) console.log(`[Activity] Recorded ${inVoice.length} member(s) already in voice.`);
  } catch (err) {
    console.error('[Activity] Failed to start activity tracking:', err);
  }
}

module.exports = {
  STATE_FILE,
  THROTTLE_MS,
  readActivityState,
  updateActivityState,
  ignoredChannelIds,
  classifyMessage,
  saveActivity,
  copyCommandLog,
  latestActivity,
  joinCounts,
  fetchAllMembers,
  recordActivity,
  recordCommand,
  forgetThrottle,
  resetThrottle,
  handleMessage,
  handleVoiceState,
  registerMemberActivity,
  startTracking,
};
