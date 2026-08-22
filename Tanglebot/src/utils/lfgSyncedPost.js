const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { actOnGroupDetailed } = require('./lfgBackend');
const { followUpEphemeral, replyEphemeral, isAlreadyGoneError } = require('./roleMenu');

const SYNCED_GROUP_BUTTON_PREFIX = 'lfgsyncgroup';

// FULL is included here too — the backend's `join` action already queues the caller instead of
// erroring once a group is full, so Join Group is the only button needed either way.
function isJoinableStatus(status) {
  return status === 'OPEN' || status === 'FULL' || status === 'STARTED';
}

function isClosableStatus(status) {
  return !['CLOSED', 'CANCELLED', 'EXPIRED'].includes(status ?? '');
}

function isStartedStatus(status) {
  return status === 'STARTED';
}

function syncedStatusPrefix(status) {
  if (status === 'FULL') return '[Full]';
  if (status === 'STARTED') return '[Started]';
  if (status === 'CLOSED') return '[Closed]';
  if (status === 'CANCELLED') return '[Cancelled]';
  if (status === 'EXPIRED') return '[Expired]';
  return '[Open]';
}

function describeStartLabel(group) {
  const startMs = group?.startTime ? new Date(group.startTime).getTime() : Date.now();
  const minutesRemaining = Math.ceil((startMs - Date.now()) / 60000);

  if (isStartedStatus(group?.status) || minutesRemaining <= 0) {
    return 'Started';
  }
  if (minutesRemaining <= 5) {
    return 'Start: in 5 Min';
  }
  if (minutesRemaining <= 15) {
    return 'Start: in 15 Min';
  }
  if (minutesRemaining <= 30) {
    return 'Start: in 30 Min';
  }
  if (minutesRemaining <= 60) {
    return 'Start: in 1 Hour';
  }

  const roundedHours = Math.min(6, Math.ceil(minutesRemaining / 60));
  return `Start: in ${roundedHours} Hour${roundedHours === 1 ? '' : 's'}`;
}

function capDisplay(maximumPlayers) {
  return maximumPlayers == null ? 'Unlimited' : String(maximumPlayers);
}

function startEpoch(group) {
  const value = group?.startTime ? new Date(group.startTime).getTime() : Date.now();
  return Math.floor(value / 1000);
}

function memberLabel(member) {
  if (member?.discordUserId) {
    return `<@${member.discordUserId}>`;
  }
  return member?.rsn || 'Unknown';
}

function buildSyncedThreadName(group) {
  const name = `${syncedStatusPrefix(group?.status)} ${group?.category?.displayName ?? 'LFG'}: ${group?.activity ?? 'Group'} - ${describeStartLabel(group)}`;
  return name.length > 100 ? `${name.slice(0, 99)}…` : name;
}

function buildSyncedGroupEmbed(group) {
  const members = Array.isArray(group?.members) ? group.members : [];
  const queueMembers = Array.isArray(group?.queueMembers) ? group.queueMembers : [];
  const description = [
    `**Activity:** ${group?.category?.displayName ?? 'LFG'}: ${group?.activity ?? 'Unknown'}`,
    `**Start:** <t:${startEpoch(group)}:t> (<t:${startEpoch(group)}:R>)`,
    `**Group Size:** ${members.length}/${capDisplay(group?.maximumPlayers)}`,
    group?.description ? `**Description:** ${group.description}` : null,
    '',
    `**Members (${members.length}/${capDisplay(group?.maximumPlayers)}):**`,
    members.length ? members.map(memberLabel).join('\n') : '_none yet_',
    '',
    `**Queue (${group?.queueCount ?? queueMembers.length}):**`,
    queueMembers.length ? queueMembers.map(memberLabel).join('\n') : '_none_',
  ].filter(Boolean).join('\n');

  let title = 'Looking For Group';
  if (group?.status === 'FULL') {
    title = '🔒 Looking For Group — Full';
  } else if (group?.status === 'STARTED') {
    title = '⏱️ Looking For Group — Started';
  } else if (group?.status === 'CLOSED') {
    title = '🛑 Looking For Group — Closed';
  } else if (group?.status === 'CANCELLED') {
    title = '🚫 Looking For Group — Cancelled';
  } else if (group?.status === 'EXPIRED') {
    title = '⌛ Looking For Group — Expired';
  }

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(
      group?.status === 'FULL'
        ? 0x2ecc71
        : ['CLOSED', 'CANCELLED', 'EXPIRED'].includes(group?.status ?? '')
          ? 0xed4245
          : 0xc2a24c
    )
    .setFooter({ text: `Started by ${group?.creator?.rsn ?? 'Unknown'}` });
}

function buildSyncedGroupRow(groupId, group) {
  const join = new ButtonBuilder()
    .setCustomId(`${SYNCED_GROUP_BUTTON_PREFIX}:join:${groupId}`)
    .setLabel('Join Group')
    .setStyle(ButtonStyle.Success)
    .setDisabled(!isJoinableStatus(group?.status));

  const leave = new ButtonBuilder()
    .setCustomId(`${SYNCED_GROUP_BUTTON_PREFIX}:leave:${groupId}`)
    .setLabel('Leave Group')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!isClosableStatus(group?.status));

  const close = new ButtonBuilder()
    .setCustomId(`${SYNCED_GROUP_BUTTON_PREFIX}:close:${groupId}`)
    .setLabel('Close Group')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(!isClosableStatus(group?.status));

  return new ActionRowBuilder().addComponents(join, leave, close);
}

async function applySyncedGroupUpdate(interaction, group, action = null) {
  const channel = interaction.channel;
  if (!channel) {
    return;
  }

  const components = ['CLOSED', 'CANCELLED', 'EXPIRED'].includes(group?.status ?? '')
    ? []
    : [buildSyncedGroupRow(group.id, group)];

  try {
    await interaction.update({
      embeds: [buildSyncedGroupEmbed(group)],
      components,
    });
  } catch (err) {
    if (!isAlreadyGoneError(err)) {
      throw err;
    }
    await replyEphemeral(interaction, '⚠️ This group post no longer exists.');
    return;
  }

  try {
    await channel.setName(buildSyncedThreadName(group));
  } catch (err) {
    if (!isAlreadyGoneError(err)) {
      console.error(`[LFG] Could not rename synced thread ${group?.id}:`, err.message);
    }
  }
}

async function handleSyncedGroupButtonInteraction(interaction) {
  const [, action, groupId] = interaction.customId.split(':');
  if (!['join', 'leave', 'close'].includes(action) || !groupId) {
    return;
  }

  let result;
  try {
    result = await actOnGroupDetailed({
      member: interaction.member,
      groupId,
      action,
    });
  } catch (err) {
    console.error(`[LFG] Synced group ${action} failed for ${groupId}:`, err.message);
    return replyEphemeral(interaction, `⚠️ ${err.message}`);
  }

  if (!result?.success) {
    return replyEphemeral(interaction, `⚠️ ${result?.message ?? 'Unable to update group.'}`);
  }

  if (!result.group) {
    return replyEphemeral(interaction, '⚠️ Group updated, but no refreshed state was returned.');
  }

  await applySyncedGroupUpdate(interaction, result.group, action);
  await followUpEphemeral(interaction, `✅ ${result.message ?? 'Group updated.'}`, { autoDelete: true });
}

module.exports = {
  SYNCED_GROUP_BUTTON_PREFIX,
  buildSyncedThreadName,
  buildSyncedGroupEmbed,
  buildSyncedGroupRow,
  handleSyncedGroupButtonInteraction,
};
