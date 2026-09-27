const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  ChannelType,
} = require('discord.js');
const { readJson, writeJson, truncate, hasAnyRole } = require('./db');
const {
  CATEGORY_OPTIONS,
  findCategoryOption,
  getActivityOptions,
  findActivityOption,
  findSizeOption,
  describeSizeOptions,
  parseSizeCap,
  TIME_OFFSET_OPTIONS,
  findTimeOption,
  resolveTimeEpoch,
  buildGroupText,
  parseGroupText,
  findActivityByRoleLabel,
  capMentionLines,
  buildGroupRow,
  buildQueueOfferRow,
  buildCancelDisbandRow,
  buildKeepAliveRow,
  makeGroupId,
  isGroupFull,
  describeStartCountdown,
  computeCountdownRefreshDelay,
} = require('./lfgGroup');
const {
  ensureRoleExists,
  lfgRoleName,
  notifyAdminLog,
  scheduleReplyCleanup,
  isAlreadyGoneError,
  replyEphemeral,
  followUpEphemeral,
  isValidColor,
  isValidEmoji,
} = require('./roleMenu');
const {
  createGroup: createBackendGroup,
  actOnGroup: actOnBackendGroup,
  syncGroupMetadata,
  isConfigured: isLfgBackendConfigured,
} = require('./lfgBackend');

// Forum Channel that /lfg-post creates its threads in.
const FORUM_CHANNEL_ID = process.env.LFG_FORUM_CHANNEL_ID;

// A post auto-closes only after sitting empty this long, or when a disband's grace period ends.
const EMPTY_GROUP_CLEANUP_DELAY_MS = 15 * 60 * 1000;

// How long the "post created" confirmation stays up.
const POST_CREATED_MESSAGE_LIFETIME_MS = 30 * 1000;

// How long a queued person has to accept an offered spot.
const QUEUE_OFFER_TIMEOUT_MS = 5 * 60 * 1000;

// Grace period before Disband closes the post, so it can be cancelled.
const DISBAND_DELAY_MS = 60 * 1000;

// How often an active group is asked "still active?", and how long it has to click Still Here.
const KEEP_ALIVE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const KEEP_ALIVE_REPLY_WINDOW_MS = 10 * 60 * 1000;

// Retry delay when a keep-alive check was skipped for a pending queue offer.
const KEEP_ALIVE_RETRY_DELAY_MS = 15 * 60 * 1000;

const setupSessions = new Map(); // userId -> { category, activity, size, time }; not saved
const activeGroups = new Map(); // groupId -> group state; saved to GROUPS_DATA_FILE

// Groups are saved here and restored on startup (see restoreLfgGroups).
const GROUPS_DATA_FILE = 'lfg-groups.json';
// Waits briefly before writing, so the several changes one click makes are saved together.
const SAVE_DELAY_MS = 500;
let saveTimeoutId = null;

function scheduleSave() {
  if (saveTimeoutId) return;
  saveTimeoutId = setTimeout(() => {
    saveTimeoutId = null;
    const groups = [...activeGroups.values()].filter((g) => g.threadId).map(serializeGroup);
    try {
      writeJson(GROUPS_DATA_FILE, { groups });
    } catch (err) {
      console.error('[LFG] Could not save groups:', err.message);
    }
  }, SAVE_DELAY_MS);
}

// The fields worth saving; timers are rebuilt on restore.
function serializeGroup(group) {
  return {
    id: group.id,
    creatorId: group.creatorId,
    creatorTag: group.creatorTag,
    roleLabel: group.roleLabel,
    roleId: group.roleId,
    color: group.color,
    emoji: group.emoji,
    timeEpoch: group.timeEpoch,
    sizeLabel: group.sizeLabel,
    sizeCap: Number.isFinite(group.sizeCap) ? group.sizeCap : null, // null = Mass
    description: group.description,
    members: [...group.members],
    status: group.status,
    threadId: group.threadId,
    activityMessageId: group.activityMessageId,
    queue: [...group.queue],
    pendingOfferUserId: group.pendingOfferUserId,
    backendGroupId: group.backendGroupId,
  };
}

// A group's in-memory state from saved (or parsed) fields, with no timers running yet.
function newGroupState(fields) {
  return {
    ...fields,
    sizeCap: fields.sizeCap ?? Infinity,
    members: new Set(fields.members),
    queue: [...fields.queue],
    cleanupTimeoutId: null,
    countdownTimeoutId: null,
    pendingOfferTimeoutId: null,
    keepAliveTimeoutId: null,
    keepAliveReplyTimeoutId: null,
  };
}

async function syncBackendQueueCount(group) {
  if (!group?.backendGroupId || !isLfgBackendConfigured()) {
    return;
  }

  try {
    await syncGroupMetadata({
      groupId: group.backendGroupId,
      queueCount: group.queue.length,
    });
  } catch (err) {
    console.error(`[LFG] Could not sync queue count for group ${group.id}:`, err.message);
  }
}

// The Discord action already went through, so a mirror failure is only reported to admins.
async function notifyBackendMirrorFailure(interaction, group, actionLabel, err) {
  console.error(`[LFG] Could not mirror ${actionLabel} for group ${group.id}:`, err.message);
  await notifyAdminLog(
    interaction.client,
    '⚠️ LFG Backend Mirror Failed',
    `Couldn't mirror **${actionLabel}** for <@${interaction.user.id}> on group **${group.roleLabel}** (thread <#${group.threadId}>) to the shared LFG backend: ${err.message}`
  );
}

// ---- Setup UI: Category -> Activity -> Size -> Start Time, then the description modal ----
function getSession(userId) {
  if (!setupSessions.has(userId)) {
    setupSessions.set(userId, { category: null, activity: null, size: null, time: null });
  }
  return setupSessions.get(userId);
}

function buildSetupComponents(session) {
  const rows = [];

  const categorySelect = new StringSelectMenuBuilder()
    .setCustomId('lfgpost:select:category')
    .setPlaceholder('1. Choose a category')
    .addOptions(
      CATEGORY_OPTIONS.map((o) => ({
        value: o.key,
        label: o.label,
        default: session.category === o.key,
      }))
    );
  rows.push(new ActionRowBuilder().addComponents(categorySelect));

  if (session.category) {
    const activitySelect = new StringSelectMenuBuilder()
      .setCustomId('lfgpost:select:activity')
      .setPlaceholder('2. Choose an activity')
      .addOptions(
        getActivityOptions(session.category).map((r) => ({
          value: r.value,
          label: `${r.label} (${describeSizeOptions(r)})`,
          default: session.activity === r.value,
        }))
      );
    rows.push(new ActionRowBuilder().addComponents(activitySelect));
  }

  if (session.category && session.activity) {
    const activityOption = findActivityOption(session.category, session.activity);
    const sizeSelect = new StringSelectMenuBuilder()
      .setCustomId('lfgpost:select:size')
      .setPlaceholder('3. Choose group size')
      .addOptions(
        activityOption.sizeOptions.map((o) => ({
          value: o.value,
          label: o.label,
          default: session.size === o.value,
        }))
      );
    rows.push(new ActionRowBuilder().addComponents(sizeSelect));
  }

  if (session.category && session.activity && session.size) {
    const timeSelect = new StringSelectMenuBuilder()
      .setCustomId('lfgpost:select:time')
      .setPlaceholder('4. Choose a start time')
      .addOptions(
        TIME_OFFSET_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
          default: session.time === o.value,
        }))
      );
    rows.push(new ActionRowBuilder().addComponents(timeSelect));
  }

  return rows;
}

function buildSetupContent(session) {
  const parts = [];
  if (session.category) parts.push(`**Category:** ${findCategoryOption(session.category)?.label ?? '?'}`);
  if (session.category && session.activity) {
    const opt = findActivityOption(session.category, session.activity);
    parts.push(`**Activity:** ${opt?.label ?? '?'}`);
  }
  if (session.category && session.activity && session.size) {
    const activityOption = findActivityOption(session.category, session.activity);
    parts.push(`**Size:** ${findSizeOption(activityOption, session.size)?.label ?? '?'}`);
  }
  if (session.time) parts.push(`**Start:** ${findTimeOption(session.time)?.label ?? '?'}`);

  const summary = parts.length ? parts.join('  •  ') + '\n\n' : '';
  return `${summary}Pick a category, an activity, a group size, and a start time. You'll be asked for an optional description once all four are picked.`;
}

async function sendSetupMenu(interaction) {
  if (!FORUM_CHANNEL_ID) {
    console.log('[LFG] /lfg-post aborted: LFG_FORUM_CHANNEL_ID is not set');
    return replyEphemeral(interaction, '⚠️ LFG_FORUM_CHANNEL_ID is not set. Ask an admin to set it in the bot\'s environment variables.');
  }

  const session = getSession(interaction.user.id);
  await interaction.reply({
    content: buildSetupContent(session),
    components: buildSetupComponents(session),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetupSelect(interaction, field) {
  const session = getSession(interaction.user.id);
  console.log(`[LFG] Setup selection: ${field}=${interaction.values[0]} for ${interaction.user.username}`);
  session[field] = interaction.values[0];

  if (field === 'category') {
    session.activity = null;
    session.size = null;
    session.time = null;
  }
  if (field === 'activity') {
    // Size options depend on the activity.
    session.size = null;
    const activityOption = findActivityOption(session.category, session.activity);
    const sizeChoices = activityOption.sizeOptions;
    if (sizeChoices.length === 1) {
      // Only one size (e.g. Yama): skip the step.
      session.size = sizeChoices[0].value;
    }
  }

  const allFilled = session.category && session.activity && session.size && session.time;
  if (allFilled) {
    return openDescriptionModal(interaction);
  }

  await interaction.update({
    content: buildSetupContent(session),
    components: buildSetupComponents(session),
  });
}

// ---- Description modal, opened once all four dropdowns are filled ----
async function openDescriptionModal(interaction) {
  console.log(`[LFG] Opening description modal for ${interaction.user.username}`);
  const modal = new ModalBuilder()
    .setCustomId('lfgpost:desc')
    .setTitle('Add a description');

  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Description (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000)
    .setPlaceholder('Add any extra details about this group...');

  modal.addComponents(new ActionRowBuilder().addComponents(descInput));
  await interaction.showModal(modal);
}

// Reports to the admin log and ends the setup flow with a warning.
async function abortWithAdminAlert(interaction, title, adminMessage, userMessage) {
  console.log(`[LFG] Aborting: ${title}`);
  await notifyAdminLog(interaction.client, title, adminMessage);
  return interaction.editReply({ content: userMessage, components: [] });
}

// ---- Modal submit creates the post ----
async function handleDescriptionModalSubmit(interaction) {
  // Creating the post can take longer than Discord's 3-second reply window.
  await interaction.deferUpdate();

  const session = getSession(interaction.user.id);
  if (!session.category || !session.activity || !session.size || !session.time) {
    return interaction.editReply({
      content: '⚠️ Something went wrong finding your selections — please run /lfg-post again.',
      components: [],
    });
  }

  const categoryOption = findCategoryOption(session.category);
  const activityOption = findActivityOption(session.category, session.activity);
  const sizeOption = findSizeOption(activityOption, session.size);
  const timeOption = findTimeOption(session.time);
  const description = interaction.fields.getTextInputValue('description')?.trim() || null;

  if (!isValidColor(activityOption.color) || !isValidEmoji(activityOption.emoji)) {
    return abortWithAdminAlert(
      interaction,
      '⚠️ LFG Activity Misconfigured',
      `**${activityOption.label}** is missing a valid color and/or emoji in roleMenu.js CATEGORIES — /lfg-post aborted for <@${interaction.user.id}>.`,
      `⚠️ **${activityOption.label}** isn't fully configured yet. Ask an admin to check its color/emoji in roleMenu.js.`
    );
  }

  const guildRole = await ensureRoleExists(interaction.guild, activityOption.label);
  if (!guildRole) {
    return abortWithAdminAlert(
      interaction,
      '⚠️ LFG Role Creation Failed',
      `Couldn't find or create **${lfgRoleName(activityOption.label)}** for <@${interaction.user.id}> via /lfg-post. Check the bot's **Manage Roles** permission.`,
      `⚠️ I couldn't find or create the role **${lfgRoleName(activityOption.label)}**. Make sure I have the **Manage Roles** permission.`
    );
  }

  const forumChannel = await interaction.guild.channels.fetch(FORUM_CHANNEL_ID).catch(() => null);
  if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
    return abortWithAdminAlert(
      interaction,
      '⚠️ LFG Forum Channel Misconfigured',
      `<@${interaction.user.id}> tried /lfg-post but LFG_FORUM_CHANNEL_ID doesn't point to a valid Forum Channel.`,
      '⚠️ LFG_FORUM_CHANNEL_ID doesn\'t point to a valid Forum Channel. Ask an admin to check the setup.'
    );
  }

  const groupId = makeGroupId();
  const timeEpoch = resolveTimeEpoch(timeOption.value);
  const sizeCap = parseSizeCap(sizeOption.value);
  const roleLabel = `${categoryOption.label}: ${activityOption.label}`;

  const group = {
    id: groupId,
    creatorId: interaction.user.id,
    creatorTag: interaction.user.username,
    roleLabel,
    roleId: guildRole.id,
    color: activityOption.color,
    emoji: activityOption.emoji,
    timeEpoch,
    sizeLabel: sizeOption.label,
    sizeCap,
    description,
    members: new Set([interaction.user.id]),
    status: 'open',
    threadId: null,
    activityMessageId: null,
    cleanupTimeoutId: null,
    countdownTimeoutId: null,
    queue: [], // FIFO of userIds waiting for a spot
    pendingOfferUserId: null,
    pendingOfferTimeoutId: null,
    keepAliveTimeoutId: null, // next "still active?" check
    keepAliveReplyTimeoutId: null, // reply window after a check
    backendGroupId: null,
  };
  activeGroups.set(groupId, group);

  const row = buildGroupRow(groupId);

  // Applies a forum tag named after the activity (e.g. "Yama"), if one exists.
  const matchingTag = forumChannel.availableTags?.find(
    (t) => t.name.toLowerCase() === activityOption.label.toLowerCase()
  );

  let thread;
  try {
    thread = await forumChannel.threads.create({
      name: buildThreadName(group, 'Open'),
      appliedTags: matchingTag ? [matchingTag.id] : [],
      message: {
        content: buildGroupText(group),
        components: [row],
      },
    });
  } catch (err) {
    activeGroups.delete(groupId);
    console.error(`[LFG] Could not create post for group ${groupId}:`, err.message);
    return abortWithAdminAlert(
      interaction,
      '⚠️ LFG Post Creation Failed',
      `Failed to create a post for <@${interaction.user.id}> (${roleLabel}): ${err.message}`,
      '⚠️ Something went wrong creating the post. Please try again.'
    );
  }

  group.threadId = thread.id;
  console.log(`[LFG] Post created: group ${groupId} (${roleLabel}, ${sizeOption.label}, ${timeOption.label}), thread ${thread.id}, by ${interaction.user.username}`);

  if (isLfgBackendConfigured()) {
    try {
      const backendGroup = await createBackendGroup({
        member: interaction.member,
        categoryKey: session.category,
        activityLabel: activityOption.label,
        description,
        startTimeIso: new Date(timeEpoch * 1000).toISOString(),
        maximumPlayers: Number.isFinite(sizeCap) ? sizeCap : null,
        discordChannelId: thread.id,
        discordMessageId: thread.id,
        idempotencyKey: interaction.id,
      });
      group.backendGroupId = backendGroup?.id ?? null;
      await syncBackendQueueCount(group);
    } catch (err) {
      console.error(`[LFG] Could not mirror created group ${groupId} to backend:`, err.message);
      await notifyAdminLog(
        interaction.client,
        '⚠️ LFG Backend Mirror Failed',
        `Discord group **${roleLabel}** was created in thread <#${thread.id}> but could not be mirrored to the shared LFG backend: ${err.message}`
      );
    }
  }

  // Best-effort; a failed reaction shouldn't block the post.
  try {
    const starterMessage = await thread.fetchStarterMessage();
    await starterMessage.react(group.emoji);
  } catch (err) {
    console.error(`[LFG] Could not react to post ${groupId} with its activity emoji:`, err.message);
  }

  // No empty-group cleanup: the creator is already a member.
  scheduleCountdownRefresh(interaction.client, group);
  scheduleKeepAliveCheck(interaction.client, group);
  setupSessions.delete(interaction.user.id);
  scheduleSave();

  const threadLink = `https://discord.com/channels/${interaction.guildId}/${thread.id}`;
  await interaction.editReply({
    content: `✅ Your LFG post has been created: [Click here to view it](${threadLink})`,
    components: [],
  });
  scheduleReplyCleanup(interaction, POST_CREATED_MESSAGE_LIFETIME_MS, '/lfg-post confirmation message');
}

// Kept short (thread names cap at 100 chars); counts and the creator are in the post body.
function buildThreadName(group, statusWord) {
  const countdown = describeStartCountdown(group.timeEpoch);
  // "Started" rather than "Start: Started".
  const startLabel = countdown === 'Started' ? countdown : `Start: ${countdown}`;
  const name = `[${statusWord}] - ${group.roleLabel} - ${startLabel}`;
  return truncate(name, 100);
}

function statusWordFor(group) {
  return group.status === 'closed' ? 'Full' : 'Open';
}

// Takes a channel so timers without an interaction can use it too.
async function renameThreadChannel(channel, group) {
  try {
    await channel.setName(buildThreadName(group, statusWordFor(group)));
  } catch (err) {
    console.error(`[LFG] Could not rename post thread ${group.id}:`, err.message);
  }
}

// Re-renders the main post for flows that have no interaction on it to .update().
async function updateMainPost(channel, group, components = [buildGroupRow(group.id)]) {
  scheduleSave();
  try {
    // A forum thread's starter message has the thread's id, so it can be edited without a fetch.
    await channel.messages.edit(channel.id, { content: buildGroupText(group), embeds: [], components });
  } catch (err) {
    if (!isAlreadyGoneError(err)) {
      console.error(`[LFG] Could not update post ${group.id}:`, err.message);
      return;
    }
    // The post was deleted; drop the group.
    cleanupStaleGroup(group);
  }
}

// Renames the thread as the "Start: in X" countdown changes, until the group starts or disbands.
// A full group keeps counting down.
function scheduleCountdownRefresh(client, group) {
  if (group.countdownTimeoutId) clearTimeout(group.countdownTimeoutId);
  const delay = computeCountdownRefreshDelay(group.timeEpoch);
  if (delay === null) return;

  group.countdownTimeoutId = setTimeout(async () => {
    try {
      const thread = await client.channels.fetch(group.threadId);
      await thread.setName(buildThreadName(group, statusWordFor(group)));
    } catch (err) {
      if (!isAlreadyGoneError(err)) console.error(`[LFG] Could not refresh post countdown ${group.id}:`, err.message);
    }
    scheduleCountdownRefresh(client, group);
  }, delay);
}

function stopCountdownRefresh(group) {
  if (group.countdownTimeoutId) {
    clearTimeout(group.countdownTimeoutId);
    group.countdownTimeoutId = null;
  }
}

// Mentions for every member that fit in maxChars, never cutting one in half.
function mentionAll(group, maxChars) {
  return capMentionLines([...group.members].map((id) => `<@${id}>`), maxChars);
}

// Pings the whole group. Only for notices everyone needs (formed, keep-alive, disband, start now),
// not for joins and leaves.
function memberNotice(group, text) {
  // The text always fits; only the mention list shrinks.
  const mentions = mentionAll(group, Math.max(0, 1900 - text.length - 1));
  return `${mentions}\n${text}`;
}

// Sends each notice as a new message (edits don't ping) and deletes the previous one, so only the
// newest is visible.
async function sendOrEditActivity(channel, group, text, components = []) {
  if (group.activityMessageId) {
    const previousMessageId = group.activityMessageId;
    group.activityMessageId = null;
    channel.messages.delete(previousMessageId).catch((err) => {
      if (!isAlreadyGoneError(err)) console.error(`[LFG] Could not delete previous activity message for group ${group.id}:`, err.message);
    });
  }

  // A Mass group's mentions can exceed Discord's 2000-char cap.
  const message = await channel.send({ content: truncate(text, 2000), components });
  group.activityMessageId = message.id;
  scheduleSave();
}

// Returns the group, or replies "no longer exists" and returns null if it's gone or disbanding.
async function requireGroup(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group || group.status === 'disbanded') {
    await replyEphemeral(interaction, '⚠️ This group no longer exists.');
    return null;
  }
  return group;
}

// Clears any pending queue offer without starting a new one.
function clearPendingOffer(group) {
  if (group.pendingOfferTimeoutId) clearTimeout(group.pendingOfferTimeoutId);
  group.pendingOfferTimeoutId = null;
  group.pendingOfferUserId = null;
}

// Stops a group's timers and forgets it.
function tearDownGroup(group) {
  clearPendingOffer(group);
  stopCountdownRefresh(group);
  stopKeepAliveCheck(group);
  activeGroups.delete(group.id);
  scheduleSave();
}

// The post is gone, so drop the group.
function cleanupStaleGroup(group) {
  console.log(`[LFG] Cleaning up stale group ${group.id} — its post no longer exists`);
  if (group.cleanupTimeoutId) clearTimeout(group.cleanupTimeoutId);
  tearDownGroup(group);
}

// For timers: drop the group if its thread is gone, otherwise log the error.
function cleanupStaleGroupOrLog(group, err, logMessage) {
  if (isAlreadyGoneError(err)) {
    cleanupStaleGroup(group);
  } else {
    console.error(logMessage, err.message);
  }
}

// Offers a freed spot to the front of the queue, or reopens the group if nobody's queued.
// precedingText is folded into the same notice.
async function advanceQueueOrReopen(client, channel, group, precedingText = '') {
  console.log(`[LFG] Advancing queue for group ${group.id}`);
  clearPendingOffer(group);

  if (group.queue.length === 0) {
    group.status = 'open';
    scheduleCountdownRefresh(client, group);
    refreshCleanupSchedule(client, group);
    const text = [precedingText, '🔓 **This group has space again and is accepting new members!**'].filter(Boolean).join('\n\n');
    await Promise.all([
      renameThreadChannel(channel, group),
      updateMainPost(channel, group),
      sendOrEditActivity(channel, group, text),
    ]);
    return;
  }

  const nextUserId = group.queue[0];
  group.pendingOfferUserId = nextUserId;
  // <t:...:R> counts down on its own in Discord.
  const offerExpiresEpoch = Math.floor((Date.now() + QUEUE_OFFER_TIMEOUT_MS) / 1000);
  const text = [
    precedingText,
    `<@${nextUserId}> 🎟️ **A spot opened up!** Accept <t:${offerExpiresEpoch}:R> or you'll be removed from the queue and it goes to the next person.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  // No rename: the group stays Full while an offer is pending.
  await Promise.all([
    updateMainPost(channel, group),
    sendOrEditActivity(channel, group, text, [buildQueueOfferRow(group.id)]),
  ]);
  group.pendingOfferTimeoutId = setTimeout(() => handleQueueOfferTimeout(client, group), QUEUE_OFFER_TIMEOUT_MS);
}

// Nobody answered the offer in time: remove them from the queue (like a Decline) and move on.
async function handleQueueOfferTimeout(client, group) {
  if (!activeGroups.has(group.id) || group.pendingOfferUserId === null) return;
  const skippedUserId = group.queue.shift();
  group.pendingOfferUserId = null;
  group.pendingOfferTimeoutId = null;

  try {
    const channel = await client.channels.fetch(group.threadId);
    await syncBackendQueueCount(group);
    await advanceQueueOrReopen(client, channel, group, `⌛ <@${skippedUserId}> didn't respond in time and was removed from the queue.`);
  } catch (err) {
    cleanupStaleGroupOrLog(group, err, `[LFG] Could not advance queue for group ${group.id}:`);
  }
}

// Re-renders the post through the button interaction. Pass components [] to remove the buttons.
// Returns false (caller should stop) if the post no longer exists.
async function updateGroupMessage(interaction, group, components = [buildGroupRow(group.id)]) {
  scheduleSave();
  try {
    await interaction.update({ content: buildGroupText(group), embeds: [], components });
    return true;
  } catch (err) {
    if (!isAlreadyGoneError(err)) throw err;
    cleanupStaleGroup(group);
    await replyEphemeral(interaction, '⚠️ This group\'s post no longer exists.').catch(() => {});
    return false;
  }
}

function isStaff(interaction) {
  return hasAnyRole(interaction.member, [process.env.COORDINATOR_ROLE_ID, process.env.OWNER_ROLE_ID]);
}

// Disband and Start Now: members or Coordinator/Owner staff.
function canManageGroup(interaction, group) {
  return group.members.has(interaction.user.id) || isStaff(interaction);
}

// Cancel Disband: also anyone in the queue.
function canCancelDisband(interaction, group) {
  return group.members.has(interaction.user.id) || group.queue.includes(interaction.user.id) || isStaff(interaction);
}

async function handleJoinButton(interaction, groupId) {
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  console.log(`[LFG] ${interaction.user.username} attempting to join group ${groupId}`);
  if (group.members.has(interaction.user.id)) {
    return replyEphemeral(interaction, 'You\'re already in this group.');
  }
  const queuePosition = group.queue.indexOf(interaction.user.id);
  if (queuePosition !== -1) {
    return replyEphemeral(interaction, `⏳ You're already in the queue (position ${queuePosition + 1}).`);
  }

  if (group.status === 'closed') {
    group.queue.push(interaction.user.id);
    if (!(await updateGroupMessage(interaction, group))) return;
    await syncBackendQueueCount(group);
    return followUpEphemeral(
      interaction,
      `⏳ This group is full — you're in the queue (position ${group.queue.length}). You'll be pinged here if a spot opens up.`
    );
  }

  group.members.add(interaction.user.id);
  // No longer empty.
  cancelScheduledCleanup(group);
  const justFilled = isGroupFull(group);
  if (justFilled) {
    group.status = 'closed';
  }

  if (!(await updateGroupMessage(interaction, group))) return;

  if (group.backendGroupId && isLfgBackendConfigured()) {
    try {
      await actOnBackendGroup({
        member: interaction.member,
        groupId: group.backendGroupId,
        action: 'join',
        idempotencyKey: interaction.id,
      });
    } catch (err) {
      await notifyBackendMirrorFailure(interaction, group, 'join', err);
    }
  }

  // A join shows the group is still active.
  resetKeepAliveCheck(interaction.client, group);

  if (justFilled) {
    // The countdown keeps running for a full group.
    await Promise.all([
      followUpEphemeral(interaction, '✅ You joined the group!', { autoDelete: true }),
      renameThreadChannel(interaction.channel, group),
      sendOrEditActivity(interaction.channel, group, memberNotice(group, '🎉 **Group formed, Good luck!**')),
    ]);
  } else {
    // No group-wide ping for a routine join.
    await Promise.all([
      followUpEphemeral(interaction, '✅ You joined the group!', { autoDelete: true }),
      sendOrEditActivity(interaction.channel, group, `🔔 <@${interaction.user.id}> joined the group!`),
    ]);
  }
}

async function handleLeaveButton(interaction, groupId) {
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  console.log(`[LFG] ${interaction.user.username} leaving group ${groupId}`);

  if (!group.members.has(interaction.user.id)) {
    const queueIndex = group.queue.indexOf(interaction.user.id);
    if (queueIndex === -1) {
      return replyEphemeral(interaction, 'You\'re not in this group.');
    }
    group.queue.splice(queueIndex, 1);
    if (!(await updateGroupMessage(interaction, group))) return;
    await syncBackendQueueCount(group);
    return followUpEphemeral(interaction, 'You left the queue.');
  }

  group.members.delete(interaction.user.id);
  const wasFull = group.status === 'closed';

  if (!(await updateGroupMessage(interaction, group))) return;
  await followUpEphemeral(interaction, 'You left the group.', { autoDelete: true });

  // No group-wide ping for a routine leave.
  const leftText = `⚠️ <@${interaction.user.id}> left the group.`;
  if (group.backendGroupId && isLfgBackendConfigured()) {
    try {
      await actOnBackendGroup({
        member: interaction.member,
        groupId: group.backendGroupId,
        action: 'leave',
        idempotencyKey: interaction.id,
      });
    } catch (err) {
      await notifyBackendMirrorFailure(interaction, group, 'leave', err);
    }
  }

  if (wasFull) {
    // The queue gets first refusal on the freed spot.
    await advanceQueueOrReopen(interaction.client, interaction.channel, group, leftText);
    return;
  }

  if (group.members.size > 0) {
    await sendOrEditActivity(interaction.channel, group, leftText);
  } else {
    // Empty: start the auto-close countdown and announce it.
    const closesAtEpoch = Math.floor((Date.now() + EMPTY_GROUP_CLEANUP_DELAY_MS) / 1000);
    await sendOrEditActivity(
      interaction.channel,
      group,
      `${leftText}\n\n💤 **This group is now empty.** It will automatically close <t:${closesAtEpoch}:R> unless someone rejoins.`
    );
    schedulePostGroupCleanup(interaction.client, group, EMPTY_GROUP_CLEANUP_DELAY_MS);
  }
}

// Only the person holding the offer can Accept/Decline it.
function requirePendingOffer(interaction, group) {
  if (group.pendingOfferUserId === interaction.user.id) return true;

  if (group.queue.includes(interaction.user.id)) {
    replyEphemeral(interaction, `⏳ That offer's moved on, but you're still queued (position ${group.queue.indexOf(interaction.user.id) + 1}).`);
  } else {
    replyEphemeral(interaction, '⚠️ This offer isn\'t for you.');
  }
  return false;
}

async function handleQueueAcceptButton(interaction, groupId) {
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  if (!requirePendingOffer(interaction, group)) return;
  console.log(`[LFG] ${interaction.user.username} accepted queue offer for group ${groupId}`);

  // Mutate before awaiting, so the offer timeout can't also shift this person off the queue.
  clearPendingOffer(group);
  group.queue.shift();
  group.members.add(interaction.user.id);
  group.status = isGroupFull(group) ? 'closed' : 'open';

  await interaction.deferUpdate();
  await syncBackendQueueCount(group);

  // No group-wide ping for a routine join.
  const acceptedText = `✅ <@${interaction.user.id}> accepted the open spot and joined!`;
  if (group.backendGroupId && isLfgBackendConfigured()) {
    try {
      await actOnBackendGroup({
        member: interaction.member,
        groupId: group.backendGroupId,
        action: 'join',
        idempotencyKey: interaction.id,
      });
    } catch (err) {
      await notifyBackendMirrorFailure(interaction, group, 'queue accept', err);
    }
  }
  resetKeepAliveCheck(interaction.client, group);

  if (group.status === 'open') {
    // Still room: keep serving the queue, with the accept notice folded in.
    await advanceQueueOrReopen(interaction.client, interaction.channel, group, acceptedText);
    return;
  }

  // Still full.
  await Promise.all([
    updateMainPost(interaction.channel, group),
    sendOrEditActivity(interaction.channel, group, acceptedText),
  ]);
}

async function handleQueueDeclineButton(interaction, groupId) {
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  if (!requirePendingOffer(interaction, group)) return;
  console.log(`[LFG] ${interaction.user.username} declined queue offer for group ${groupId}`);

  // Mutate before awaiting (see handleQueueAcceptButton).
  clearPendingOffer(group);
  const declinedUserId = group.queue.shift();

  await interaction.deferUpdate();
  await syncBackendQueueCount(group);

  await advanceQueueOrReopen(interaction.client, interaction.channel, group, `↪️ <@${declinedUserId}> declined the spot.`);
}

async function handleStartNowButton(interaction, groupId) {
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  if (!canManageGroup(interaction, group)) {
    return replyEphemeral(interaction, '⚠️ Only members of this group, or a Coordinator or higher, can start it early.');
  }
  if (group.timeEpoch * 1000 <= Date.now()) {
    return replyEphemeral(interaction, '⚠️ This group has already started.');
  }

  console.log(`[LFG] ${interaction.user.username} started group ${groupId} early`);
  group.timeEpoch = Math.floor(Date.now() / 1000);
  stopCountdownRefresh(group);
  // Keep-alive waits for the start time, so reschedule it from now (and drop any open reply window).
  stopKeepAliveCheck(group);
  scheduleKeepAliveCheck(interaction.client, group);

  if (!(await updateGroupMessage(interaction, group))) return;

  await Promise.all([
    followUpEphemeral(interaction, '✅ Started the group now!', { autoDelete: true }),
    renameThreadChannel(interaction.channel, group),
    sendOrEditActivity(interaction.channel, group, memberNotice(group, `🚀 **<@${interaction.user.id}> started this group now!**`)),
  ]);
}

// Starts the disband grace period: stops timers, posts the notice with Cancel Disband, and
// schedules the post's deletion. The caller removes the main post's buttons first.
async function beginDisband(client, channel, group, announcementText) {
  console.log(`[LFG] Beginning disband for group ${group.id}`);
  group.status = 'disbanded';
  clearPendingOffer(group);
  stopCountdownRefresh(group);
  stopKeepAliveCheck(group);

  const closesAtEpoch = Math.floor((Date.now() + DISBAND_DELAY_MS) / 1000);
  await sendOrEditActivity(
    channel,
    group,
    memberNotice(group, `${announcementText} It will close <t:${closesAtEpoch}:R>.`),
    [buildCancelDisbandRow(group.id)]
  );

  schedulePostGroupCleanup(client, group, DISBAND_DELAY_MS);
}

// Not requireGroup: a disbanding group gets its own reply here.
async function handleDisbandButton(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group) {
    return replyEphemeral(interaction, '⚠️ This group no longer exists.');
  }
  if (!canManageGroup(interaction, group)) {
    return replyEphemeral(interaction, '⚠️ Only members of this group, or a Coordinator or higher, can disband it.');
  }
  if (group.status === 'disbanded') {
    return replyEphemeral(interaction, '⚠️ This group is already disbanding — anyone in it (or its queue), or a Coordinator or higher, can cancel that with **Cancel Disband**.');
  }

  console.log(`[LFG] ${interaction.user.username} disbanding group ${groupId}`);
  // Remove the main post's buttons.
  if (!(await updateGroupMessage(interaction, group, []))) return;

  if (group.backendGroupId && isLfgBackendConfigured()) {
    try {
      await actOnBackendGroup({
        member: interaction.member,
        groupId: group.backendGroupId,
        action: 'close',
        idempotencyKey: interaction.id,
      });
    } catch (err) {
      await notifyBackendMirrorFailure(interaction, group, 'close', err);
    }
  }
  await beginDisband(interaction.client, interaction.channel, group, `🛑 <@${interaction.user.id}> has selected to disband this group.`);
}

// Not requireGroup: a disbanding group is exactly what this handles.
async function handleCancelDisbandButton(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group) {
    return replyEphemeral(interaction, '⚠️ This group has already closed.');
  }
  if (group.status !== 'disbanded') {
    return replyEphemeral(interaction, '⚠️ This group isn\'t disbanding.');
  }
  if (!canCancelDisband(interaction, group)) {
    return replyEphemeral(interaction, '⚠️ Only members of this group, someone in its queue, or a Coordinator or higher, can cancel this.');
  }

  await interaction.deferUpdate();

  // The thread may already be mid-delete.
  if (group.cleanupInFlight) {
    return followUpEphemeral(interaction, '⚠️ Too late — this group\'s post was already being removed. Start a new one with the usual command.');
  }

  console.log(`[LFG] ${interaction.user.username} cancelled disband for group ${groupId}`);
  group.status = isGroupFull(group) ? 'closed' : 'open';

  if (group.status === 'open') scheduleCountdownRefresh(interaction.client, group);
  refreshCleanupSchedule(interaction.client, group);
  scheduleKeepAliveCheck(interaction.client, group);
  await Promise.all([
    renameThreadChannel(interaction.channel, group),
    updateMainPost(interaction.channel, group),
    sendOrEditActivity(interaction.channel, group, memberNotice(group, `✅ <@${interaction.user.id}> cancelled the disband — this group is staying open!`)),
  ]);
}

function schedulePostGroupCleanup(client, group, delayMs) {
  if (group.cleanupTimeoutId) {
    clearTimeout(group.cleanupTimeoutId);
  }

  console.log(`[LFG] Cleanup scheduled for group ${group.id} (thread ${group.threadId}) in ${delayMs}ms`);
  group.cleanupTimeoutId = setTimeout(async () => {
    console.log(`[LFG] Cleanup timer fired for group ${group.id} (thread ${group.threadId})`);
    // Tells a racing Cancel Disband that it's too late.
    group.cleanupInFlight = true;
    const startedAt = Date.now();
    try {
      const thread = client.channels.cache.get(group.threadId) ?? await client.channels.fetch(group.threadId);
      await thread.delete();
      const tookMs = Date.now() - startedAt;
      // Usually means Discord rate-limited the delete.
      if (tookMs > 5000) console.log(`[LFG] Deleted expired post ${group.id}, but it took ${tookMs}ms — likely Discord API rate-limiting, not a bug in the timer.`);
    } catch (err) {
      if (!isAlreadyGoneError(err)) {
        // Nothing retries this, so the thread would be left behind; tell the admins.
        console.error(`[LFG] Could not delete expired post ${group.id}:`, err.message);
        await notifyAdminLog(
          client,
          '⚠️ LFG Post Cleanup Failed',
          `Could not delete the expired post for group **${group.roleLabel}** (thread <#${group.threadId}>): ${err.message}. It will need to be deleted manually.`
        );
      }
    }
    tearDownGroup(group);
  }, delayMs);
}

// Cancels a pending cleanup, e.g. when an empty group gets a member again.
function cancelScheduledCleanup(group) {
  if (group.cleanupTimeoutId) {
    console.log(`[LFG] Cleanup cancelled for group ${group.id} (thread ${group.threadId})`);
    clearTimeout(group.cleanupTimeoutId);
    group.cleanupTimeoutId = null;
  }
}

// Only an empty group has a cleanup countdown.
function refreshCleanupSchedule(client, group) {
  if (group.members.size > 0) {
    cancelScheduledCleanup(group);
  } else {
    schedulePostGroupCleanup(client, group, EMPTY_GROUP_CLEANUP_DELAY_MS);
  }
}

// Schedules the next "still active?" check, never before the group's start time.
function scheduleKeepAliveCheck(client, group, delayMs = KEEP_ALIVE_INTERVAL_MS) {
  console.log(`[LFG] Scheduling keep-alive check for group ${group.id}`);
  if (group.keepAliveTimeoutId) clearTimeout(group.keepAliveTimeoutId);
  const msUntilStart = group.timeEpoch * 1000 - Date.now();
  const effectiveDelay = Math.max(delayMs, msUntilStart);
  group.keepAliveTimeoutId = setTimeout(() => runKeepAliveCheck(client, group), effectiveDelay);
}

function stopKeepAliveCheck(group) {
  if (group.keepAliveTimeoutId) {
    clearTimeout(group.keepAliveTimeoutId);
    group.keepAliveTimeoutId = null;
  }
  if (group.keepAliveReplyTimeoutId) {
    clearTimeout(group.keepAliveReplyTimeoutId);
    group.keepAliveReplyTimeoutId = null;
  }
}

// Asks the group if it's still active; no Still Here in time auto-disbands it.
async function runKeepAliveCheck(client, group) {
  if (!activeGroups.has(group.id) || group.status === 'disbanded') return;

  // Don't replace a pending queue offer's message; retry later.
  if (group.pendingOfferUserId !== null) {
    scheduleKeepAliveCheck(client, group, KEEP_ALIVE_RETRY_DELAY_MS);
    return;
  }

  try {
    const channel = await client.channels.fetch(group.threadId);
    const expiresEpoch = Math.floor((Date.now() + KEEP_ALIVE_REPLY_WINDOW_MS) / 1000);
    await sendOrEditActivity(
      channel,
      group,
      memberNotice(group, `👋 **Is this group still active?** Click Still Here <t:${expiresEpoch}:R> or it will be automatically disbanded.`),
      [buildKeepAliveRow(group.id)]
    );
    group.keepAliveReplyTimeoutId = setTimeout(() => handleKeepAliveTimeout(client, group), KEEP_ALIVE_REPLY_WINDOW_MS);
  } catch (err) {
    cleanupStaleGroupOrLog(group, err, `[LFG] Could not send keep-alive check for group ${group.id}:`);
  }
}

// Cancels an open reply window and restarts the clock. No-op if no check is waiting.
function resetKeepAliveCheck(client, group) {
  if (!group.keepAliveReplyTimeoutId) return;

  clearTimeout(group.keepAliveReplyTimeoutId);
  group.keepAliveReplyTimeoutId = null;
  scheduleKeepAliveCheck(client, group);
}

// Nobody clicked Still Here: disband as if someone clicked Disband.
async function handleKeepAliveTimeout(client, group) {
  if (!activeGroups.has(group.id) || group.status === 'disbanded') return;
  group.keepAliveReplyTimeoutId = null;

  try {
    const channel = await client.channels.fetch(group.threadId);
    // Remove the main post's buttons.
    await updateMainPost(channel, group, []);
    await beginDisband(client, channel, group, '⌛ No one confirmed this group was still active, so it was automatically disbanded.');
    console.log(`[LFG] Group ${group.id} auto-disbanded after a missed keep-alive check.`);
  } catch (err) {
    cleanupStaleGroupOrLog(group, err, `[LFG] Could not auto-disband group ${group.id} after a missed keep-alive check:`);
  }
}

async function handleKeepAliveButton(interaction, groupId) {
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  if (!group.members.has(interaction.user.id) && !isStaff(interaction)) {
    return replyEphemeral(interaction, '⚠️ Only members of this group, or a Coordinator or higher, can confirm it\'s still active.');
  }

  console.log(`[LFG] ${interaction.user.username} confirmed group ${groupId} is still active`);
  resetKeepAliveCheck(interaction.client, group);

  // Edit the prompt in place; a confirmation doesn't need a new ping.
  await interaction.update({
    content: memberNotice(group, `✅ <@${interaction.user.id}> confirmed this group is still active.`),
    embeds: [],
    components: [],
  });
}

// ---- Restoring groups after a restart ----

// Restarts a restored group's timers from now, as if its current state had just begun.
async function resumeGroup(client, channel, group) {
  if (group.status === 'disbanded') {
    const closesAtEpoch = Math.floor((Date.now() + DISBAND_DELAY_MS) / 1000);
    await sendOrEditActivity(
      channel,
      group,
      `🛑 This group was closing when the bot restarted. It will close <t:${closesAtEpoch}:R>.`,
      [buildCancelDisbandRow(group.id)]
    );
    schedulePostGroupCleanup(client, group, DISBAND_DELAY_MS);
    return;
  }

  // The title's countdown or Open/Full may have changed while the bot was down. Not awaited:
  // Discord allows 2 renames per thread every 10 minutes, and a rate-limited rename would hold up
  // the rest of startup. renameThreadChannel logs its own errors.
  if (channel.name !== buildThreadName(group, statusWordFor(group))) renameThreadChannel(channel, group);

  scheduleCountdownRefresh(client, group);

  if (group.members.size === 0) {
    const closesAtEpoch = Math.floor((Date.now() + EMPTY_GROUP_CLEANUP_DELAY_MS) / 1000);
    await sendOrEditActivity(
      channel,
      group,
      `💤 **This group is empty.** It will automatically close <t:${closesAtEpoch}:R> unless someone rejoins.`
    );
    schedulePostGroupCleanup(client, group, EMPTY_GROUP_CLEANUP_DELAY_MS);
    return;
  }

  scheduleKeepAliveCheck(client, group);
  // A spot was being held for the queue: offer it again with a fresh window.
  if (group.status === 'closed' && !isGroupFull(group)) {
    await advanceQueueOrReopen(client, channel, group);
  }
}

// Called on startup: brings back the groups saved in GROUPS_DATA_FILE whose posts still exist,
// then rebuilds any other group posts from the forum.
async function restoreLfgGroups(client) {
  if (!FORUM_CHANNEL_ID) return;

  const saved = readJson(GROUPS_DATA_FILE).groups;
  const failed = [];
  let restored = 0;
  for (const fields of Array.isArray(saved) ? saved : []) {
    let group = null;
    try {
      const channel = await client.channels.fetch(fields.threadId);
      group = newGroupState(fields);
      activeGroups.set(group.id, group);
      await resumeGroup(client, channel, group);
      restored += 1;
    } catch (err) {
      if (group) {
        if (group.cleanupTimeoutId) clearTimeout(group.cleanupTimeoutId);
        tearDownGroup(group);
      }
      if (isAlreadyGoneError(err)) {
        console.log(`[LFG] Not restoring group ${fields.id}: its post was deleted.`);
      } else {
        console.error(`[LFG] Could not restore group ${fields.id}:`, err.message);
        failed.push(`<#${fields.threadId}> (**${fields.roleLabel}**): ${err.message}`);
      }
    }
  }
  // Drops groups whose posts are gone from the file.
  scheduleSave();
  console.log(`[LFG] Restored ${restored} group(s) from ${GROUPS_DATA_FILE}.`);

  if (failed.length) {
    await notifyAdminLog(
      client,
      '⚠️ LFG Groups Not Restored',
      truncate(`These groups couldn't be restored after the restart, so their buttons won't work:\n${failed.join('\n')}`, 4096)
    );
  }

  await recoverFromForum(client);
}

// Rebuilds groups from their posts when the save file didn't have them, e.g. if it was lost.
async function recoverFromForum(client) {
  const forum = await client.channels.fetch(FORUM_CHANNEL_ID).catch(() => null);
  if (forum?.type !== ChannelType.GuildForum) return;

  const { threads } = await forum.threads.fetchActive();
  const known = new Set([...activeGroups.values()].map((g) => g.threadId));
  const rebuilt = [];
  const unreadable = [];
  for (const thread of threads.values()) {
    if (thread.ownerId !== client.user.id || known.has(thread.id)) continue;
    try {
      const result = await recoverFromPost(client, thread);
      if (result?.unreadable) {
        unreadable.push(`<#${thread.id}>`);
      } else if (result) {
        const lost = result.hidden ? ` — ${result.hidden} player(s) hidden by "…and N more" couldn't be recovered` : '';
        rebuilt.push(`<#${thread.id}> (**${result.group.roleLabel}**)${lost}`);
      }
    } catch (err) {
      console.error(`[LFG] Could not rebuild group from post ${thread.id}:`, err.message);
      unreadable.push(`<#${thread.id}>: ${err.message}`);
    }
  }
  if (rebuilt.length === 0 && unreadable.length === 0) return;
  console.log(`[LFG] Rebuilt ${rebuilt.length} group(s) from forum posts; ${unreadable.length} couldn't be read.`);

  const sections = [];
  if (rebuilt.length) {
    sections.push(`Rebuilt from their posts, since the save file didn't have them:\n${rebuilt.join('\n')}`);
    if (isLfgBackendConfigured()) {
      sections.push('These groups no longer sync to the RuneLite plugin (the backend link was only in the save file).');
    }
  }
  if (unreadable.length) sections.push(`Couldn't be restored, so their buttons were removed:\n${unreadable.join('\n')}`);
  await notifyAdminLog(client, 'ℹ️ LFG Groups Rebuilt From Posts', truncate(sections.join('\n\n'), 4096));
}

// Rebuilds one group from its post. Returns null for posts that aren't /lfg-post groups with
// buttons (the start page, plugin posts, or a group already closing), { unreadable: true } if the
// post can't be read (its buttons are removed), or { group, hidden }.
async function recoverFromPost(client, thread) {
  const starter = await thread.messages.fetch(thread.id);
  const groupId = starter.components
    .flatMap((row) => row.components)
    .map((component) => component.customId ?? '')
    .find((customId) => customId.startsWith('lfgpostgroup:'))
    ?.split(':')[2];
  if (!groupId) return null;

  const parsed = parseGroupText(starter.content);
  const activity = parsed && findActivityByRoleLabel(parsed.roleLabel);
  const sizeOption = activity?.sizeOptions.find((o) => o.label === parsed.sizeLabel);
  if (!sizeOption) {
    await starter.edit({ components: [] });
    await thread.send('⚠️ This group couldn\'t be restored after the bot restarted. Start a new one with `/lfg-post`.');
    return { unreadable: true };
  }

  // The newest notice, so the next one replaces it as usual.
  const recent = await thread.messages.fetch({ limit: 20 });
  const latestNotice = recent.find((m) => m.author.id === client.user.id && m.id !== thread.id);

  const group = newGroupState({
    id: groupId,
    creatorId: null,
    creatorTag: parsed.creatorTag,
    roleLabel: parsed.roleLabel,
    roleId: parsed.roleId,
    color: activity.color,
    emoji: activity.emoji,
    timeEpoch: parsed.timeEpoch,
    sizeLabel: parsed.sizeLabel,
    sizeCap: parseSizeCap(sizeOption.value),
    description: parsed.description,
    members: parsed.members,
    status: 'open',
    threadId: thread.id,
    activityMessageId: latestNotice?.id ?? null,
    queue: parsed.queue,
    pendingOfferUserId: parsed.pendingOfferUserId,
    backendGroupId: null,
  });
  // Full, or holding a spot for the queue.
  group.status = isGroupFull(group) || group.queue.length > 0 ? 'closed' : 'open';

  activeGroups.set(group.id, group);
  try {
    await resumeGroup(client, thread, group);
  } catch (err) {
    if (group.cleanupTimeoutId) clearTimeout(group.cleanupTimeoutId);
    tearDownGroup(group);
    throw err;
  }
  console.log(`[LFG] Rebuilt group ${group.id} from post ${thread.id}`);
  return { group, hidden: parsed.hiddenMembers + parsed.hiddenQueued };
}

// ---- Entry points called from eventHandler.js ----
async function handleLfgPostSelectInteraction(interaction) {
  const field = interaction.customId.split(':')[2]; // "lfgpost:select:<field>"
  if (!['category', 'activity', 'size', 'time'].includes(field)) return;
  return handleSetupSelect(interaction, field);
}

async function handleLfgPostModalSubmit(interaction) {
  if (interaction.customId === 'lfgpost:desc') {
    return handleDescriptionModalSubmit(interaction);
  }
}

// Button action -> label for the click log line.
const GROUP_ACTION_LABELS = {
  join: 'Join',
  leave: 'Leave',
  queueaccept: 'Accept Spot',
  queuedecline: 'Decline Spot',
  startnow: 'Start Now',
  disband: 'Disband',
  canceldisband: 'Cancel Disband',
  keepalive: 'Still Here',
};

async function handleLfgPostGroupButtonInteraction(interaction) {
  const [, action, groupId] = interaction.customId.split(':'); // "lfgpostgroup:<action>:<groupId>"
  const label = GROUP_ACTION_LABELS[action];
  if (label) console.log(`[LFG] ${label} clicked: group ${groupId} by ${interaction.user.username}`);
  if (action === 'join') return handleJoinButton(interaction, groupId);
  if (action === 'leave') return handleLeaveButton(interaction, groupId);
  if (action === 'queueaccept') return handleQueueAcceptButton(interaction, groupId);
  if (action === 'queuedecline') return handleQueueDeclineButton(interaction, groupId);
  if (action === 'startnow') return handleStartNowButton(interaction, groupId);
  if (action === 'disband') return handleDisbandButton(interaction, groupId);
  if (action === 'canceldisband') return handleCancelDisbandButton(interaction, groupId);
  if (action === 'keepalive') return handleKeepAliveButton(interaction, groupId);
}

module.exports = {
  sendSetupMenu,
  handleLfgPostSelectInteraction,
  handleLfgPostModalSubmit,
  handleLfgPostGroupButtonInteraction,
  restoreLfgGroups,
};
