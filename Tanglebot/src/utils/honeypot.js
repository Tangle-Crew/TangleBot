const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const axios = require('axios');
const { readJson, writeJson, truncate, hasAnyRole } = require('./db');

const RUNTIME_CONFIG_FILE = 'honeypot-runtime-config.json';
const TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const TRAP_MESSAGE_FETCH_LIMIT = 100;
const DELETE_SCAN_FETCH_LIMIT = 100;

const DISCORD_RED = 0xb02020;
const DISCORD_YELLOW = 0xd4a017;

const CUSTOM_ID_PREFIX = 'hp';

function loadHoneypotConfig(env = process.env) {
  const channelId = env.HONEYPOT_CHANNEL_ID?.trim() || null;
  const voiceChannelId = env.HONEYPOT_VOICE_CHANNEL_ID?.trim() || null;
  const trapChannelIds = [channelId, voiceChannelId].filter(Boolean);
  return {
    enabled: trapChannelIds.length > 0,
    channelId,
    voiceChannelId,
    trapChannelIds,
  };
}

function getRuntimeConfig() {
  const config = readJson(RUNTIME_CONFIG_FILE);
  return config && typeof config === 'object' ? config : {};
}

function isTestModeEnabled() {
  return getRuntimeConfig().testMode === true;
}

function setTestModeEnabled(enabled) {
  const runtimeConfig = getRuntimeConfig();
  runtimeConfig.testMode = !!enabled;
  writeJson(RUNTIME_CONFIG_FILE, runtimeConfig);
  return runtimeConfig.testMode;
}

function hasHoneypotAdminAccess(member, env = process.env) {
  return hasAnyRole(member, [env.OWNER_ROLE_ID, env.TEMPLAR_ROLE_ID]);
}

async function clearHoneypotChannel(channel) {
  let totalDeleted = 0;
  // Bounded loop: a honeypot channel should be near-empty, this just guards against runaway scans.
  for (let i = 0; i < 20; i += 1) {
    const messages = await channel.messages.fetch({ limit: TRAP_MESSAGE_FETCH_LIMIT });
    if (messages.size === 0) break;

    const deleted = await channel.bulkDelete(messages, true);
    totalDeleted += deleted.size;

    if (deleted.size < messages.size) {
      // Remaining messages are older than 14 days and weren't bulk-deletable; remove individually.
      const remaining = messages.filter(msg => !deleted.has(msg.id));
      for (const msg of remaining.values()) {
        try {
          await msg.delete();
          totalDeleted += 1;
        } catch (err) {
          console.error('Honeypot: failed to delete individual old message:', err);
        }
      }
    }

    if (messages.size < TRAP_MESSAGE_FETCH_LIMIT) break;
  }
  return totalDeleted;
}

function buildWarningEmbed() {
  return new EmbedBuilder()
    .setColor(DISCORD_RED)
    .setTitle('⚠️ Do Not Post In This Channel')
    .setDescription(
      'This channel is monitored. Sending **any** message here will result in an ' +
      'automatic **1 week timeout** and/or a **permanent ban**.'
    );
}

async function sendHoneypotStartupMessage(client, config) {
  if (!config.enabled) return;

  for (const channelId of config.trapChannelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      await clearHoneypotChannel(channel);
      await channel.send({ embeds: [buildWarningEmbed()] });
    } catch (err) {
      console.error(`Honeypot: failed to reset honeypot channel ${channelId} on startup:`, err);
    }
  }
}

const MAX_GALLERY_IMAGES = 10; // Discord's per-message attachment cap.

const IMAGE_EXTENSIONS_BY_CONTENT_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

function findImageAttachments(message) {
  return [...message.attachments.values()]
    .filter(attachment => attachment.contentType?.startsWith('image/'))
    .slice(0, MAX_GALLERY_IMAGES);
}

async function downloadImageAttachment(attachment, index) {
  try {
    const response = await axios.get(attachment.url, { responseType: 'arraybuffer', timeout: 10000 });
    // Deterministic, ASCII-safe name - avoids attachment://-reference mismatches from special
    // characters or duplicate original filenames (e.g. multiple screenshots both named "image.png").
    const ext = IMAGE_EXTENSIONS_BY_CONTENT_TYPE[attachment.contentType] || 'png';
    const name = `honeypot-image-${index}.${ext}`;
    return new AttachmentBuilder(Buffer.from(response.data), { name });
  } catch (err) {
    console.error('Honeypot: failed to download trap message image attachment:', err);
    return null;
  }
}

async function downloadImageAttachments(attachments) {
  const files = await Promise.all(attachments.map((attachment, index) => downloadImageAttachment(attachment, index)));
  return files.filter(Boolean);
}

function buildAdminLogEmbeds({ message, testMode }) {
  const isVoiceChannel = message.channel?.type === ChannelType.GuildVoice;

  const embed = new EmbedBuilder()
    .setColor(DISCORD_RED)
    .setTitle('🍯 Honeypot Triggered')
    .addFields(
      { name: 'User', value: `${message.author} (${message.author.tag})`, inline: true },
      { name: 'User ID', value: message.author.id, inline: true },
      { name: 'Trap Channel', value: isVoiceChannel ? `🔊 Voice channel chat (${message.channel})` : `${message.channel}`, inline: true },
      { name: 'Message Content', value: truncate(message.content, 1024) || '*(no text content)*' },
    )
    .setTimestamp(message.createdAt);

  embed.addFields({
    name: 'Button Guide',
    value: [
      '🔨 **Ban & Delete Messages** — bans the account and deletes their recent messages across the server.',
      '✅ **False Positive (Un-Timeout)** — dismisses this alert and lifts the timeout applied to this user.',
    ].join('\n'),
  });

  if (testMode) {
    embed.addFields({
      name: '🧪 Testing Mode',
      value: 'Testing mode is enabled — the user was **not** timed out, banned, or had messages deleted.',
    });
  }

  // Images are sent as plain attachments (see handleHoneypotMessage), not referenced from the
  // embed - Discord natively grids multiple image attachments together, and this avoids the
  // embed `attachment://` + shared-url gallery trick misbehaving on the post-button-click edit.
  return [embed];
}

const ACTION_LABELS = {
  bandelete: 'Ban & Delete Messages',
  falsepositive: 'False Positive (Un-Timeout)',
};

function buildAdminLogComponents({ userId, testMode }) {
  const mode = testMode ? 't' : 'l';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:bandelete:${userId}:${mode}`)
      .setLabel('Ban & Delete Messages')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:falsepositive:${userId}:${mode}`)
      .setLabel('False Positive (Un-Timeout)')
      .setStyle(ButtonStyle.Secondary),
  );

  return [row];
}

async function handleHoneypotMessage(message, config, client) {
  if (!config.enabled) return;
  if (message.author.bot) return;
  if (!config.trapChannelIds.includes(message.channelId)) return;

  const testMode = isTestModeEnabled();

  if (!testMode) {
    try {
      await message.member?.timeout(TIMEOUT_MS, 'Posted in honeypot channel');
    } catch (err) {
      console.error('Honeypot: failed to timeout user:', err);
    }
  }

  // Download before deleting the trap message, since its CDN links aren't guaranteed to work afterward.
  const imageAttachments = findImageAttachments(message);
  const imageFiles = imageAttachments.length ? await downloadImageAttachments(imageAttachments) : [];

  try {
    await message.delete();
  } catch (err) {
    console.error('Honeypot: failed to delete trap message:', err);
  }

  const adminLogChannelId = process.env.ADMIN_LOG_CHANNEL_ID;
  if (!adminLogChannelId) return;

  try {
    const adminChannel = await client.channels.fetch(adminLogChannelId);
    await adminChannel.send({
      embeds: buildAdminLogEmbeds({ message, testMode }),
      components: buildAdminLogComponents({ userId: message.author.id, testMode }),
      files: imageFiles,
    });
  } catch (err) {
    console.error('Honeypot: failed to send admin log message:', err);
  }
}

const REQUIRED_DELETE_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
];

// Discord error codes for channels the bot can't act in (private channels, threads it's not in, etc.) - expected, not a failure.
const ACCESS_DENIED_CODES = new Set([50001, 50013]);

function canScanChannel(channel, botMember) {
  if (!botMember) return true; // no cached bot member to check against; let the API call decide
  const perms = channel.permissionsFor(botMember);
  const allowed = !!perms && perms.has(REQUIRED_DELETE_PERMISSIONS);
  if (!allowed) {
    console.log(`Honeypot: skipping #${channel.name ?? channel.id} (${channel.id}) for message deletion - missing permissions.`);
  }
  return allowed;
}

async function deleteAllUserMessages(guild, userId) {
  const botMember = guild.members.me;
  const textChannels = guild.channels.cache.filter(channel => [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
    ChannelType.GuildVoice,
    ChannelType.GuildStageVoice,
  ].includes(channel.type) && canScanChannel(channel, botMember));

  let deletedCount = 0;

  for (const channel of textChannels.values()) {
    try {
      const messages = await channel.messages.fetch({ limit: DELETE_SCAN_FETCH_LIMIT });
      const userMessages = messages.filter(msg => msg.author.id === userId);
      if (userMessages.size === 0) continue;

      const deleted = await channel.bulkDelete(userMessages, true);
      deletedCount += deleted.size;
    } catch (err) {
      if (ACCESS_DENIED_CODES.has(err?.code)) {
        console.log(`Honeypot: skipping #${channel.name ?? channel.id} (${channel.id}) for message deletion - access denied (${err.code}).`);
        continue;
      }
      console.error(`Honeypot: failed to scan/delete messages in channel ${channel.id}:`, err);
    }
  }

  return deletedCount;
}

function parseCustomId(customId) {
  const [prefix, action, userId, mode] = customId.split(':');
  if (prefix !== CUSTOM_ID_PREFIX) return null;
  return { action, userId, testMode: mode === 't' };
}

async function handleHoneypotButtonInteraction(interaction) {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;

  if (!hasHoneypotAdminAccess(interaction.member)) {
    await interaction.reply({
      content: 'You do not have permission to use this action.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { action, userId, testMode } = parsed;
  await interaction.deferUpdate();

  let resultText;

  if (action === 'bandelete') {
    if (testMode) {
      resultText = `🧪 Testing mode: would have banned <@${userId}> and deleted their recent messages.`;
    } else {
      const outcomes = [];
      try {
        await interaction.guild.members.ban(userId, { reason: 'Honeypot: banned via admin action' });
        outcomes.push(`Banned <@${userId}>.`);
      } catch (err) {
        console.error('Honeypot: failed to ban user:', err);
        outcomes.push(`Failed to ban <@${userId}>: ${err.message}`);
      }
      try {
        const count = await deleteAllUserMessages(interaction.guild, userId);
        outcomes.push(`Deleted ${count} recent message(s) across the server.`);
      } catch (err) {
        console.error('Honeypot: failed to delete user messages:', err);
        outcomes.push(`Failed to delete messages: ${err.message}`);
      }
      resultText = outcomes.join(' ');
    }
  } else if (action === 'falsepositive') {
    if (testMode) {
      resultText = `🧪 Testing mode: no timeout was applied to <@${userId}>.`;
    } else {
      try {
        const member = await interaction.guild.members.fetch(userId);
        await member.timeout(null, 'Honeypot: marked as false positive via admin action');
        resultText = `Removed the timeout for <@${userId}>.`;
      } catch (err) {
        console.error('Honeypot: failed to remove timeout:', err);
        resultText = `Failed to remove the timeout for <@${userId}>: ${err.message}`;
      }
    }
  } else {
    return;
  }

  const resolvedAtSeconds = Math.floor(Date.now() / 1000);
  const actionField = {
    name: 'Action Taken',
    value: [
      `**${ACTION_LABELS[action]}**`,
      `By: ${interaction.user} (${interaction.user.tag})`,
      `When: <t:${resolvedAtSeconds}:F> (<t:${resolvedAtSeconds}:R>)`,
      resultText,
    ].join('\n'),
  };

  const [originalEmbed, ...restEmbeds] = interaction.message.embeds;
  const updatedEmbed = originalEmbed
    ? EmbedBuilder.from(originalEmbed).addFields(actionField)
    : new EmbedBuilder().setColor(DISCORD_YELLOW).addFields(actionField);

  await interaction.editReply({
    embeds: [updatedEmbed, ...restEmbeds.map(embed => EmbedBuilder.from(embed))],
    components: [],
  });

  await interaction.followUp({ content: resultText, flags: MessageFlags.Ephemeral });
}

module.exports = {
  handleHoneypotButtonInteraction,
  handleHoneypotMessage,
  hasHoneypotAdminAccess,
  isTestModeEnabled,
  loadHoneypotConfig,
  sendHoneypotStartupMessage,
  setTestModeEnabled,
};
