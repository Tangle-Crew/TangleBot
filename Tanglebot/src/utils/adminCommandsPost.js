const { EmbedBuilder } = require('discord.js');
const { DEFAULT_EMBED_COLOR } = require('./embedColor');
const { describeCommands, buildCommandEmbeds, packEmbeds } = require('./commandDocs');
const { syncStaticMessages } = require('./staticMessages');
const { notifyAdminLog } = require('./roleMenu');

const STATE_KEY = 'admin-commands-post.json';

// In display order. Commands of a role are the ones only that role (or above) can use.
const ROLES = [
  { key: 'owner', name: 'Owner', title: '📋 Owner commands', roleEnv: 'OWNER_ROLE_ID' },
  { key: 'templar', name: 'Templar', title: '📋 Templar commands', roleEnv: 'TEMPLAR_ROLE_ID' },
  { key: 'coordinator', name: 'Coordinator', title: '📋 Coordinator commands', roleEnv: 'COORDINATOR_ROLE_ID' },
  { key: 'admin', name: 'Server admins', title: '📋 Server admin commands', note: 'Manage Server / Manage Roles' },
];

// Only these mentions are written as text; none of them ever ping.
const NO_PINGS = { parse: [] };

function getGuild(client) {
  return client.guilds?.cache?.get(process.env.CLAN_ID) ?? client.guilds?.cache?.first?.() ?? null;
}

// The role's colour in the server, or the default when it has none.
function roleColor(guild, role) {
  const id = role.roleEnv ? process.env[role.roleEnv] : null;
  const color = id ? guild?.roles?.cache?.get(id)?.color : 0;
  return color || DEFAULT_EMBED_COLOR;
}

function roleLabel(role) {
  const id = role.roleEnv ? process.env[role.roleEnv] : null;
  if (id) return `<@&${id}>`;
  return role.note ?? role.name;
}

function sortByCategory(entries) {
  return [...entries].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function commandNames(entries) {
  return new Set(entries.map(e => e.name));
}

function buildOverviewEmbed(byRole) {
  const counts = ROLES.map(r => `**${r.name}** ${commandNames(byRole[r.key]).size}`).join(' · ');
  const lines = [
    'Staff commands the bot has loaded.',
    '',
    counts,
    'Owner also holds Templar, and each role above can use the commands of the roles below it. Server admins see every command.',
  ];
  return new EmbedBuilder().setTitle('📋 Admin commands').setDescription(lines.join('\n')).setColor(DEFAULT_EMBED_COLOR);
}

// The messages for each role: a header embed with the role mention, then its commands.
function buildRolePayloads(role, entries, color) {
  const header = new EmbedBuilder().setTitle(role.title).setDescription(roleLabel(role)).setColor(color);
  const embeds = [header, ...buildCommandEmbeds(sortByCategory(entries), { color })];
  return packEmbeds(embeds).map(group => ({ embeds: group, allowedMentions: NO_PINGS }));
}

// All messages in order.
function buildAdminPayloads(client) {
  const entries = describeCommands(client.commands ?? []).filter(e => e.role !== 'everyone');
  const byRole = Object.fromEntries(ROLES.map(r => [r.key, entries.filter(e => e.role === r.key)]));
  const guild = getGuild(client);

  const payloads = [{ embeds: [buildOverviewEmbed(byRole)], allowedMentions: NO_PINGS }];
  for (const role of ROLES) {
    if (byRole[role.key].length) payloads.push(...buildRolePayloads(role, byRole[role.key], roleColor(guild, role)));
  }
  return payloads;
}

// Called on startup: keeps the admin commands post in ADMIN_COMMANDS_CHANNEL_ID up to date.
async function ensureAdminCommandsPost(client) {
  const channelId = process.env.ADMIN_COMMANDS_CHANNEL_ID;
  if (!channelId) return;

  try {
    const payloads = buildAdminPayloads(client);
    await syncStaticMessages(client, { key: STATE_KEY, channelId, payloads, label: 'Admin commands post' });
  } catch (err) {
    console.error('[AdminCommands] Could not build the admin commands post:', err);
    await notifyAdminLog(client, '⚠️ Admin Commands Post Failed', err.message);
  }
}

module.exports = { ensureAdminCommandsPost, buildAdminPayloads, STATE_KEY };
