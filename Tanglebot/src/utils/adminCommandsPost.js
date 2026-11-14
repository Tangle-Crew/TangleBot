const { EmbedBuilder } = require('discord.js');
const { DEFAULT_EMBED_COLOR } = require('./embedColor');
const { describeCommands, buildCommandEmbeds, packEmbeds, shorten, BLANK, MAX_FIELD_VALUE } = require('./commandDocs');
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
    'Staff commands the bot has loaded. Each command has its own message below, listed under the lowest role that can use it.',
    '',
    counts,
    'Owner also holds Templar, and each role above can use the commands of the roles below it. Server admins see every command.',
  ];
  return new EmbedBuilder().setTitle('📋 Admin commands').setDescription(lines.join('\n')).setColor(DEFAULT_EMBED_COLOR);
}

// A one-line summary of a command for the start page.
function blurb(group) {
  if (group.length === 1) return shorten(group[0].description, 60);
  const subs = group.map(e => e.path.slice(e.name.length).trim());
  return shorten(subs.join(', '), 60);
}

// Lines grouped into field values that stay under Discord's limit.
function chunkLines(lines) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > MAX_FIELD_VALUE) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

// One start page message for a role: its commands by category, each linking to its message.
function buildTierMessage(tier, urlOf) {
  const embed = new EmbedBuilder().setTitle(tier.role.title).setDescription(roleLabel(tier.role)).setColor(tier.color);
  const byCategory = new Map();
  for (const item of tier.items) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category).push(`[/${item.name}](${urlOf(item.messageIndex)}) ${blurb(item.group)}`);
  }
  for (const [category, lines] of byCategory) {
    chunkLines(lines).forEach((value, i) => embed.addFields({ name: i === 0 ? category : BLANK, value }));
  }
  return { embeds: [embed], allowedMentions: NO_PINGS };
}

const placeholderUrl = index => `https://discord.com/channels/0/0/${index}`;

// The start page, then one message per command (more when a command is long).
function buildAdmin(client) {
  const all = describeCommands(client.commands ?? []).filter(e => e.role !== 'everyone');
  // A command used by several roles is shown once, under the lowest of them.
  const lowest = new Map();
  for (const e of all) {
    const rank = ROLES.findIndex(r => r.key === e.role);
    if (rank > (lowest.get(e.name) ?? -1)) lowest.set(e.name, rank);
  }
  const entries = all.map(e => ({ ...e, role: ROLES[lowest.get(e.name)].key }));
  const byRole = Object.fromEntries(ROLES.map(r => [r.key, entries.filter(e => e.role === r.key)]));
  const guild = getGuild(client);

  // The start page is the overview plus one message per role, so command messages follow it.
  const roles = ROLES.filter(r => byRole[r.key].length);
  const startCount = 1 + roles.length;
  const tiers = [];
  const commandPayloads = [];
  for (const role of roles) {
    const color = roleColor(guild, role);
    const groups = new Map();
    for (const entry of sortByCategory(byRole[role.key])) {
      if (!groups.has(entry.name)) groups.set(entry.name, []);
      groups.get(entry.name).push(entry);
    }
    const tier = { role, color, items: [] };
    for (const [name, group] of groups) {
      tier.items.push({ name, group, category: group[0].category, messageIndex: startCount + commandPayloads.length });
      for (const messageEmbeds of packEmbeds(buildCommandEmbeds(group, { color }))) {
        messageEmbeds[messageEmbeds.length - 1].setFooter({ text: `${role.name} · ${group[0].category}` });
        commandPayloads.push({ embeds: messageEmbeds, allowedMentions: NO_PINGS });
      }
    }
    tiers.push(tier);
  }

  const startFor = urlOf => [
    { embeds: [buildOverviewEmbed(byRole)], allowedMentions: NO_PINGS },
    ...tiers.map(tier => buildTierMessage(tier, urlOf)),
  ];
  // Links need the real message ids, so the saved payloads carry placeholder links.
  const payloads = [...startFor(placeholderUrl), ...commandPayloads];
  return { payloads, startFor };
}

// All messages in order.
function buildAdminPayloads(client) {
  return buildAdmin(client).payloads;
}

// Called on startup: keeps the admin commands post in ADMIN_COMMANDS_CHANNEL_ID up to date.
async function ensureAdminCommandsPost(client) {
  const channelId = process.env.ADMIN_COMMANDS_CHANNEL_ID;
  if (!channelId) return;

  try {
    const { payloads, startFor } = buildAdmin(client);
    // After posting, the start page is edited with links to the real messages.
    const refresh = ({ ids, channel }) => {
      const base = `https://discord.com/channels/${channel.guildId ?? '@me'}/${channel.id}/`;
      return startFor(index => base + ids[index]);
    };
    await syncStaticMessages(client, { key: STATE_KEY, channelId, payloads, label: 'Admin commands post', refresh });
  } catch (err) {
    console.error('[AdminCommands] Could not build the admin commands post:', err);
    await notifyAdminLog(client, '⚠️ Admin Commands Post Failed', err.message);
  }
}

module.exports = { ensureAdminCommandsPost, buildAdminPayloads };
