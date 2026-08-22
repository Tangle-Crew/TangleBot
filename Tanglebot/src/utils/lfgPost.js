const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  ChannelType,
} = require('discord.js');
const { truncate, hasAnyRole } = require('./db');
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

// The Discord Forum Channel where /lfg-post posts get created as threads — create one in your server, copy its ID, and set this in .env.
const FORUM_CHANNEL_ID = process.env.LFG_FORUM_CHANNEL_ID;

// The only two ways a post auto-closes: sitting empty this long (nobody left in it — see
// schedulePostGroupCleanup's callers), or an explicit disband finishing its grace period
// (DISBAND_DELAY_MS below). A non-empty group otherwise stays up regardless of its start time.
const EMPTY_GROUP_CLEANUP_DELAY_MS = 15 * 60 * 1000;

// How long the "✅ post created" confirmation stays up before auto-deleting.
const POST_CREATED_MESSAGE_LIFETIME_MS = 30 * 1000;

// How long an offered spot stays open before Accept/Decline auto-skips to the next in the queue.
const QUEUE_OFFER_TIMEOUT_MS = 5 * 60 * 1000;

// Grace period before Disband actually closes the post — long enough to Cancel Disband on a mis-click.
const DISBAND_DELAY_MS = 60 * 1000;

// How often an active group gets asked "is this still active?" (see scheduleKeepAliveCheck),
// and how long it waits for someone to click Still Here before auto-disbanding as if they'd
// clicked Disband themselves (see handleKeepAliveTimeout).
const KEEP_ALIVE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const KEEP_ALIVE_REPLY_WINDOW_MS = 10 * 60 * 1000;

// How soon to retry when a check got skipped for a live queue offer (see runKeepAliveCheck) —
// much shorter than normal, so a skip doesn't mean waiting up to 2 more hours.
const KEEP_ALIVE_RETRY_DELAY_MS = 15 * 60 * 1000;

// In-memory state — lost on restart/redeploy, fine for same-day posts but worth knowing.
const setupSessions = new Map(); // userId -> { category, activity, size, time }
const activeGroups = new Map(); // groupId -> group state

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

// Best-effort mirror — the Discord-side action already went through, so there's nothing to roll
// back here. But a silent failure means the shared backend just drifted out of sync unnoticed,
// unlike a creation failure (which aborts the post) — this is the only place admins find out.
async function notifyBackendMirrorFailure(interaction, group, actionLabel, err) {
  console.error(`[LFG] Could not mirror ${actionLabel} for group ${group.id}:`, err.message);
  await notifyAdminLog(
    interaction.client,
    '⚠️ LFG Backend Mirror Failed',
    `Couldn't mirror **${actionLabel}** for <@${interaction.user.id}> on group **${group.roleLabel}** (thread <#${group.threadId}>) to the shared LFG backend: ${err.message}`
  );
}

// ---- Setup UI (accordion: Category -> Activity -> Size -> Start Time) ----
// No separate "Create" button.
// Once Start Time (the last dropdown) is filled, this opens the description modal directly.
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
  session[field] = interaction.values[0];

  if (field === 'category') {
    session.activity = null;
    session.size = null;
    session.time = null;
  }
  if (field === 'activity') {
    // Size options depend on the chosen activity's max player count.
    session.size = null;
    const activityOption = findActivityOption(session.category, session.activity);
    const sizeChoices = activityOption.sizeOptions;
    if (sizeChoices.length === 1) {
      // Only one possible size (e.g. Yama) — skip the step instead of making them click a non-choice.
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

// ---- Once all 4 dropdowns are filled: open the description modal directly ----
async function openDescriptionModal(interaction) {
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

// Reports to admin log, then aborts the setup flow with an ⚠️ message — shared by every /lfg-post failure path, so the pairing only needs to change in one place.
async function abortWithAdminAlert(interaction, title, adminMessage, userMessage) {
  await notifyAdminLog(interaction.client, title, adminMessage);
  return interaction.update({ content: userMessage, components: [] });
}

// ---- Modal submit actually creates the LFG post ----
async function handleDescriptionModalSubmit(interaction) {
  const session = getSession(interaction.user.id);
  if (!session.category || !session.activity || !session.size || !session.time) {
    return interaction.update({
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
    queue: [], // FIFO of userIds waiting for a freed spot — see advanceQueueOrReopen
    pendingOfferUserId: null,
    pendingOfferTimeoutId: null,
    keepAliveTimeoutId: null, // the recurring "ask every 2 hours" timer — see scheduleKeepAliveCheck
    keepAliveReplyTimeoutId: null, // the 10-minute reply window after an ask — see runKeepAliveCheck
    backendGroupId: null,
  };
  activeGroups.set(groupId, group);

  const row = buildGroupRow(groupId);

  // Auto-applies a matching forum tag if one exists with the activity's base name (e.g. "Yama", not the "LFG-" prefixed role) — entirely optional, skipped if none matches.
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

  // Best-effort — a failed reaction (e.g. missing Add Reactions permission) shouldn't block the post.
  try {
    const starterMessage = await thread.fetchStarterMessage();
    await starterMessage.react(group.emoji);
  } catch (err) {
    console.error(`[LFG] Could not react to post ${groupId} with its activity emoji:`, err.message);
  }

  // No cleanup timer yet — the creator already counts as a member, so the group isn't empty.
  scheduleCountdownRefresh(interaction.client, group);
  scheduleKeepAliveCheck(interaction.client, group);
  setupSessions.delete(interaction.user.id);

  const threadLink = `https://discord.com/channels/${interaction.guildId}/${thread.id}`;
  await interaction.update({
    content: `✅ Your LFG post has been created: [Click here to view it](${threadLink})`,
    components: [],
  });
  scheduleReplyCleanup(interaction, POST_CREATED_MESSAGE_LIFETIME_MS, '/lfg-post confirmation message');
}

// Member/queue counts live in the main post's body text instead, not the title — the creator
// isn't included either (it's in the body's footer line), to keep the title short since Discord
// thread names cap at 100 characters.
function buildThreadName(group, statusWord) {
  const countdown = describeStartCountdown(group.timeEpoch);
  // "Start: Started" reads oddly once it's actually begun — drop the "Start:" label at that point.
  const startLabel = countdown === 'Started' ? countdown : `Start: ${countdown}`;
  const name = `[${statusWord}] - ${group.roleLabel} - ${startLabel}`;
  return truncate(name, 100);
}

function statusWordFor(group) {
  return group.status === 'closed' ? 'Full' : 'Open';
}

// Takes a channel, not an interaction, so this also works with no interaction to hand — e.g. the queue-offer timeout firing on its own.
async function renameThreadChannel(channel, group) {
  try {
    await channel.setName(buildThreadName(group, statusWordFor(group)));
  } catch (err) {
    console.error(`[LFG] Could not rename post thread ${group.id}:`, err.message);
  }
}

// Re-renders the main post (body text + button row) by editing its starter message directly. Used
// by flows with no interaction of their own to call .update() on — e.g. the queue-offer buttons live
// on their own activity message (see sendOrEditActivity), and the timeout-triggered skip has none at all.
async function updateMainPost(channel, group, components = [buildGroupRow(group.id)]) {
  try {
    // A forum thread's starter message shares the thread's own id, so this edits it directly
    // by id (one PATCH) instead of fetchStarterMessage() + edit() (a GET followed by a PATCH).
    // embeds: [] is explicit, not just omitted — a post edited before the embed-to-text switch
    // still has its old embed attached, and omitting the field here would leave it dangling.
    await channel.messages.edit(channel.id, { content: buildGroupText(group), embeds: [], components });
  } catch (err) {
    if (!isAlreadyGoneError(err)) {
      console.error(`[LFG] Could not update post ${group.id}:`, err.message);
      return;
    }
    // The post is gone but nothing else on this path checks for that (unlike updateGroupMessage) —
    // clean up here so a deleted-out-of-band thread doesn't leak in activeGroups forever.
    cleanupStaleGroup(group);
  }
}

// Re-renames the thread title as the "Start: in X" countdown bucket ticks down (see
// describeStartCountdown/computeCountdownRefreshDelay in lfgGroup.js). Self-reschedules until the
// start time passes or the group disbands/starts early (stopCountdownRefresh) — filling up does
// NOT stop it, since the countdown still matters for a full group.
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

function mentionAll(group) {
  return [...group.members].map((id) => `<@${id}>`).join('\n');
}

// Pings the whole group before a message — reserved for notices where everyone genuinely needs
// pinging (a formed group, a time-sensitive keep-alive/disband/start-now). Routine membership
// churn (someone joining, leaving, or taking a freed spot) doesn't get this — see the individual
// handlers below, which pass their notice text straight to sendOrEditActivity instead.
function memberNotice(group, text) {
  return `${mentionAll(group)}\n${text}`;
}

// Every notice (join/leave/formed/reopened/queue/keep-alive/disband) gets its own fresh message,
// since Discord only pings on a genuinely new message, not one edited to add a mention later.
// Whatever notice was showing before gets deleted first, so only the newest one is ever visible —
// no delay needed. components defaults to none, which also clears a resolved queue offer's buttons.
async function sendOrEditActivity(channel, group, text, components = []) {
  if (group.activityMessageId) {
    const previousMessageId = group.activityMessageId;
    group.activityMessageId = null;
    channel.messages.delete(previousMessageId).catch((err) => {
      if (!isAlreadyGoneError(err)) console.error(`[LFG] Could not delete previous activity message for group ${group.id}:`, err.message);
    });
  }

  const message = await channel.send({ content: text, components });
  group.activityMessageId = message.id;
}

// Looks up the group for a button interaction, replying "no longer exists" and returning null if
// it's gone or already disbanding (nothing else is actionable during that grace period —
// handleDisbandButton/handleCancelDisbandButton look it up directly for a more specific reply).
async function requireGroup(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group || group.status === 'disbanded') {
    await replyEphemeral(interaction, '⚠️ This group no longer exists.');
    return null;
  }
  return group;
}

// Clears any in-flight queue offer without starting a new one — used whenever the group's state
// changes in a way that invalidates it (accepted/declined, torn down, or disbanding started), so
// a stale pendingOfferUserId doesn't linger and misreport who the "🎟️ (offer pending)" marker
// points at.
function clearPendingOffer(group) {
  if (group.pendingOfferTimeoutId) clearTimeout(group.pendingOfferTimeoutId);
  group.pendingOfferTimeoutId = null;
  group.pendingOfferUserId = null;
}

// Common teardown for a group that's going away for good (expired, disbanded, or its post vanished) —
// everything cleanupStaleGroup and schedulePostGroupCleanup's own expiry both need.
function tearDownGroup(group) {
  clearPendingOffer(group);
  stopCountdownRefresh(group);
  stopKeepAliveCheck(group);
  activeGroups.delete(group.id);
}

// The post is gone — drop the now-stale in-memory group instead of leaking it forever. Otherwise,
// every future click on the dead button would keep hitting the same error.
function cleanupStaleGroup(group) {
  if (group.cleanupTimeoutId) clearTimeout(group.cleanupTimeoutId);
  tearDownGroup(group);
}

// Decides what happens to a freed spot: if anyone's queued, hold it for whoever's waited longest
// and start their offer clock (QUEUE_OFFER_TIMEOUT_MS); otherwise reopen to the public Join button.
// precedingText, if given, folds into the same notice (e.g. "X left" + "offered to Y" as one message).
async function advanceQueueOrReopen(client, channel, group, precedingText = '') {
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
  // <t:...:R> is a live, auto-localizing Discord timestamp (same trick as the main post's Start
  // line) — it counts down client-side instead of needing a re-edit every second.
  const offerExpiresEpoch = Math.floor((Date.now() + QUEUE_OFFER_TIMEOUT_MS) / 1000);
  const text = [
    precedingText,
    `<@${nextUserId}> 🎟️ **A spot opened up!** Accept <t:${offerExpiresEpoch}:R> or you'll be removed from the queue and it goes to the next person.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  // No rename here — an offer being held doesn't change the group's status word (it stays 'closed'/Full
  // the whole time an offer is pending). Neither call below depends on the other's result — the main
  // post and the activity notice are separate messages (see sendOrEditActivity's header comment).
  await Promise.all([
    updateMainPost(channel, group),
    sendOrEditActivity(channel, group, text, [buildQueueOfferRow(group.id)]),
  ]);
  group.pendingOfferTimeoutId = setTimeout(() => handleQueueOfferTimeout(client, group), QUEUE_OFFER_TIMEOUT_MS);
}

// Nobody responded to the offer in time. Unlike a late responder cycling back around, an ignored
// offer means they're out — drop them from the queue entirely (same as an explicit Decline)
// rather than re-offering them later. Has no interaction to work with (it fired on its own), so
// it fetches the thread directly.
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
    if (!isAlreadyGoneError(err)) console.error(`[LFG] Could not advance queue for group ${group.id}:`, err.message);
  }
}

// Updates the group's post with fresh body text, cleaning up and replying if the post is already gone.
// components defaults to the normal Join/Leave/Start Now/Disband row — pass [] once nothing on the post
// should be actionable anymore (e.g. once disbanding starts). Returns false (the caller should stop)
// if the update failed because the post no longer exists. embeds: [] is explicit — see updateMainPost.
async function updateGroupMessage(interaction, group, components = [buildGroupRow(group.id)]) {
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

// Disbanding and starting early are both limited to current members of the group, or Coordinator/Owner staff.
function canManageGroup(interaction, group) {
  return group.members.has(interaction.user.id) || isStaff(interaction);
}

// Cancelling an in-progress disband is a lower bar — anyone with a stake in the group getting
// this far (a member, or someone still queued for a spot) can call it off, not just staff.
function canCancelDisband(interaction, group) {
  return group.members.has(interaction.user.id) || group.queue.includes(interaction.user.id) || isStaff(interaction);
}

async function handleJoinButton(interaction, groupId) {
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  if (group.members.has(interaction.user.id)) {
    return replyEphemeral(interaction, 'You\'re already in this group.');
  }
  const queuePosition = group.queue.indexOf(interaction.user.id);
  if (queuePosition !== -1) {
    return replyEphemeral(interaction, `⏳ You're already in the queue (position ${queuePosition + 1}).`);
  }

  if (group.status === 'closed') {
    group.queue.push(interaction.user.id);
    // No rename — joining the queue doesn't change the group's status word.
    if (!(await updateGroupMessage(interaction, group))) return;
    await syncBackendQueueCount(group);
    return followUpEphemeral(
      interaction,
      `⏳ This group is full — you're in the queue (position ${group.queue.length}). You'll be pinged here if a spot opens up.`
    );
  }

  group.members.add(interaction.user.id);
  // Not empty anymore either way (whether this fills it or not) — drop any empty-group cleanup countdown.
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
      });
    } catch (err) {
      await notifyBackendMirrorFailure(interaction, group, 'join', err);
    }
  }

  // Independent Discord resources (the ephemeral reply, the thread name, the activity message) —
  // run them concurrently instead of one after another. updateGroupMessage above must still go first:
  // it's what acknowledges the interaction, which followUpEphemeral below requires.
  // Someone just joined — proof the group's still active, so reset the keep-alive clock either way.
  resetKeepAliveCheck(interaction.client, group);

  if (justFilled) {
    // Full doesn't mean "started" — the countdown keeps running (it still self-stops once the
    // start time actually passes, see computeCountdownRefreshDelay). Stopping it here used to
    // freeze the title forever on whatever bucket it was in when the group filled, since nothing
    // else naturally re-triggers it for a group nobody leaves.
    await Promise.all([
      followUpEphemeral(interaction, '✅ You joined the group!', { autoDelete: true }),
      renameThreadChannel(interaction.channel, group),
      // Replaces whatever notice was showing before (leave, keep-alive prompt, empty-group notice,
      // etc.) — see sendOrEditActivity's header comment.
      sendOrEditActivity(interaction.channel, group, memberNotice(group, '🎉 **Group formed, Good luck!**')),
    ]);
  } else {
    // No rename — still under capacity, so the status word doesn't change. No group-wide ping
    // either — routine membership churn, not the "you're locked in" moment group-formed is.
    await Promise.all([
      followUpEphemeral(interaction, '✅ You joined the group!', { autoDelete: true }),
      sendOrEditActivity(interaction.channel, group, `🔔 <@${interaction.user.id}> joined the group!`),
    ]);
  }
}

async function handleLeaveButton(interaction, groupId) {
  const group = await requireGroup(interaction, groupId);
  if (!group) return;

  if (!group.members.has(interaction.user.id)) {
    const queueIndex = group.queue.indexOf(interaction.user.id);
    if (queueIndex === -1) {
      return replyEphemeral(interaction, 'You\'re not in this group.');
    }
    group.queue.splice(queueIndex, 1);
    // No rename — leaving the queue doesn't change the group's status word.
    if (!(await updateGroupMessage(interaction, group))) return;
    await syncBackendQueueCount(group);
    return followUpEphemeral(interaction, 'You left the queue.');
  }

  group.members.delete(interaction.user.id);
  const wasFull = group.status === 'closed';

  if (!(await updateGroupMessage(interaction, group))) return;
  await followUpEphemeral(interaction, 'You left the group.', { autoDelete: true });

  // No group-wide ping — routine membership churn, same as a join.
  const leftText = `⚠️ <@${interaction.user.id}> left the group.`;
  if (group.backendGroupId && isLfgBackendConfigured()) {
    try {
      await actOnBackendGroup({
        member: interaction.member,
        groupId: group.backendGroupId,
        action: 'leave',
      });
    } catch (err) {
      await notifyBackendMirrorFailure(interaction, group, 'leave', err);
    }
  }

  if (wasFull) {
    // A full group doesn't just reopen the instant a spot frees — if anyone's queued, they get first refusal
    // (see advanceQueueOrReopen); only reopens to the public Join button once the queue's empty.
    await advanceQueueOrReopen(interaction.client, interaction.channel, group, leftText);
    return;
  }

  if (group.members.size > 0) {
    // No rename — still non-empty and under capacity, so the status word doesn't change.
    await sendOrEditActivity(interaction.channel, group, leftText);
  } else {
    // Nobody left in the group — starts the empty-group countdown (EMPTY_GROUP_CLEANUP_DELAY_MS)
    // and says so, the same way a Disband click announces its own closing grace period.
    const closesAtEpoch = Math.floor((Date.now() + EMPTY_GROUP_CLEANUP_DELAY_MS) / 1000);
    // No rename — an empty (but not full) group doesn't change the status word either.
    await sendOrEditActivity(
      interaction.channel,
      group,
      `${leftText}\n\n💤 **This group is now empty.** It will automatically close <t:${closesAtEpoch}:R> unless someone rejoins.`
    );
    schedulePostGroupCleanup(interaction.client, group, EMPTY_GROUP_CLEANUP_DELAY_MS);
  }
}

// Only the person currently holding the offer (front of the queue array, see advanceQueueOrReopen)
// can Accept/Decline it. Clicking late — after a timeout already cycled it to the next person —
// isn't an error though: handleQueueOfferTimeout already moved them to the back of the queue, so
// this just confirms that rather than showing a dead-end rejection.
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

  await interaction.deferUpdate();

  clearPendingOffer(group);
  group.queue.shift();
  group.members.add(interaction.user.id);
  group.status = isGroupFull(group) ? 'closed' : 'open';
  await syncBackendQueueCount(group);

  // No group-wide ping — filling a freed spot is routine membership churn, same as a join.
  const acceptedText = `✅ <@${interaction.user.id}> accepted the open spot and joined!`;
  if (group.backendGroupId && isLfgBackendConfigured()) {
    try {
      await actOnBackendGroup({
        member: interaction.member,
        groupId: group.backendGroupId,
        action: 'join',
      });
    } catch (err) {
      await notifyBackendMirrorFailure(interaction, group, 'queue accept', err);
    }
  }
  // Someone just joined — proof the group's still active, so reset the keep-alive clock.
  resetKeepAliveCheck(interaction.client, group);

  if (group.status === 'open') {
    // Capacity allows for more than this one accept covered — keep serving the queue (or reopen
    // if it's now empty). advanceQueueOrReopen already re-renders the main post and activity
    // notice itself, so folding this accept notice into its precedingText lands both as one edit
    // instead of one edit here immediately overwritten by a second one there.
    await advanceQueueOrReopen(interaction.client, interaction.channel, group, acceptedText);
    return;
  }

  // Still full — no rename, since a pending offer only ever exists for a group that was already 'closed'
  // and stays that way the whole time (see advanceQueueOrReopen). No queue left to keep serving either,
  // so this is the only update the accept needs.
  await Promise.all([
    updateMainPost(interaction.channel, group),
    sendOrEditActivity(interaction.channel, group, acceptedText),
  ]);
}

async function handleQueueDeclineButton(interaction, groupId) {
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  if (!requirePendingOffer(interaction, group)) return;

  await interaction.deferUpdate();

  clearPendingOffer(group);
  const declinedUserId = group.queue.shift();
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

  group.timeEpoch = Math.floor(Date.now() / 1000);
  stopCountdownRefresh(group);

  if (!(await updateGroupMessage(interaction, group))) return;

  await Promise.all([
    followUpEphemeral(interaction, '✅ Started the group now!', { autoDelete: true }),
    renameThreadChannel(interaction.channel, group),
    sendOrEditActivity(interaction.channel, group, memberNotice(group, `🚀 **<@${interaction.user.id}> started this group now!**`)),
  ]);
}

// Shared core of "this group is now disbanding" — sets status, stops its timers, posts the
// closing-in-X-time announcement with the Cancel Disband escape hatch, and starts the closing
// timer. Used by both an explicit Disband click and an auto-disband with no interaction to work
// from (a missed keep-alive check). The caller clears the main post's button row first.
async function beginDisband(client, channel, group, announcementText) {
  group.status = 'disbanded';
  // Also drops pendingOfferUserId, not just its timer — otherwise a later Cancel Disband would
  // reopen the group still marking a stale offer as "pending" for no one in particular.
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

  // Reuses the normal expiry timer (see schedulePostGroupCleanup) rather than a bespoke one — it
  // already does exactly what's needed here: delete the thread and drop the group after a delay.
  schedulePostGroupCleanup(client, group, DISBAND_DELAY_MS);
}

// Looks the group up directly rather than via requireGroup, since requireGroup treats an already-disbanded
// group as gone. Here that's a distinct, more useful reply — "already disbanding, here's how to cancel it" —
// instead of a generic "no longer exists".
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

  // Nothing else is actionable on the main post once disbanding starts — clear its row.
  if (!(await updateGroupMessage(interaction, group, []))) return;

  if (group.backendGroupId && isLfgBackendConfigured()) {
    try {
      await actOnBackendGroup({
        member: interaction.member,
        groupId: group.backendGroupId,
        action: 'close',
      });
    } catch (err) {
      await notifyBackendMirrorFailure(interaction, group, 'close', err);
    }
  }
  await beginDisband(interaction.client, interaction.channel, group, `🛑 <@${interaction.user.id}> has selected to disband this group.`);
}

// Cancelling looks the group up directly (not via requireGroup), same as disbanding does — a
// disbanded group is exactly the case this handles, not one to reject as "gone".
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

  group.status = isGroupFull(group) ? 'closed' : 'open';

  if (group.status === 'open') scheduleCountdownRefresh(interaction.client, group);
  refreshCleanupSchedule(interaction.client, group);
  scheduleKeepAliveCheck(interaction.client, group);
  await Promise.all([
    renameThreadChannel(interaction.channel, group),
    updateMainPost(interaction.channel, group),
    // Replaces the "disbanding, closes soon" notice — see sendOrEditActivity's header comment.
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
    const startedAt = Date.now();
    try {
      // Cache hit avoids a network round-trip entirely — the thread should still be
      // cached from earlier activity, so this only falls back to fetch() if it's somehow already evicted.
      const thread = client.channels.cache.get(group.threadId) ?? await client.channels.fetch(group.threadId);
      await thread.delete(); // deletes the entire post, no need to remove messages individually
      const tookMs = Date.now() - startedAt;
      // Slower than a normal API round-trip usually means Discord rate-limited this call and
      // discord.js queued/retried it — logging when that happens (rather than every time) makes
      // a recurring "why did this take longer than the grace period" report diagnosable.
      if (tookMs > 5000) console.log(`[LFG] Deleted expired post ${group.id}, but it took ${tookMs}ms — likely Discord API rate-limiting, not a bug in the timer.`);
    } catch (err) {
      if (!isAlreadyGoneError(err)) console.error(`[LFG] Could not delete expired post ${group.id}:`, err.message);
    }
    tearDownGroup(group);
  }, delayMs);
}

// Cancels a pending cleanup without scheduling a new one — for the moment a group stops being
// empty (a join, an accept, a cancelled disband), when nothing should still be counting down.
function cancelScheduledCleanup(group) {
  if (group.cleanupTimeoutId) {
    console.log(`[LFG] Cleanup cancelled for group ${group.id} (thread ${group.threadId})`);
    clearTimeout(group.cleanupTimeoutId);
    group.cleanupTimeoutId = null;
  }
}

// A non-empty group has nothing counting down — an empty one gets EMPTY_GROUP_CLEANUP_DELAY_MS.
// Used wherever membership just changed and the cleanup schedule needs to catch up with it.
function refreshCleanupSchedule(client, group) {
  if (group.members.size > 0) {
    cancelScheduledCleanup(group);
  } else {
    schedulePostGroupCleanup(client, group, EMPTY_GROUP_CLEANUP_DELAY_MS);
  }
}

// Self-reschedules every KEEP_ALIVE_INTERVAL_MS while the group stays open, restarted (not left
// running) on any sign of life. delayMs defaults to that interval; runKeepAliveCheck passes the
// shorter KEEP_ALIVE_RETRY_DELAY_MS instead when a check got skipped for a live queue offer.
function scheduleKeepAliveCheck(client, group, delayMs = KEEP_ALIVE_INTERVAL_MS) {
  if (group.keepAliveTimeoutId) clearTimeout(group.keepAliveTimeoutId);
  group.keepAliveTimeoutId = setTimeout(() => runKeepAliveCheck(client, group), delayMs);
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

// Pings everyone in the group asking if it's still active, then starts the
// KEEP_ALIVE_REPLY_WINDOW_MS clock — nobody clicking Still Here in time auto-disbands the group
// exactly as if a member had clicked Disband themselves (see handleKeepAliveTimeout). Has no
// interaction to work with (it fired on its own), so it fetches the thread directly.
async function runKeepAliveCheck(client, group) {
  if (!activeGroups.has(group.id) || group.status === 'disbanded') return;

  // Don't interrupt a live queue offer — sendOrEditActivity would replace its Accept/Decline
  // message with this ping before it's actually resolved. Just retry next interval instead.
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
    if (!isAlreadyGoneError(err)) console.error(`[LFG] Could not send keep-alive check for group ${group.id}:`, err.message);
  }
}

// Someone joining counts as proof the group's still active — cancels the pending reply window (if
// any) and restarts the clock. The stale prompt needs no explicit cleanup: sendOrEditActivity
// deletes it automatically once the next notice is sent. A no-op if no check is outstanding.
function resetKeepAliveCheck(client, group) {
  if (!group.keepAliveReplyTimeoutId) return;

  clearTimeout(group.keepAliveReplyTimeoutId);
  group.keepAliveReplyTimeoutId = null;
  scheduleKeepAliveCheck(client, group);
}

// Nobody clicked Still Here in time — auto-disband exactly like an explicit Disband click
// (beginDisband), just with no interaction to work from (same shape as handleQueueOfferTimeout).
async function handleKeepAliveTimeout(client, group) {
  if (!activeGroups.has(group.id) || group.status === 'disbanded') return;
  group.keepAliveReplyTimeoutId = null;

  try {
    const channel = await client.channels.fetch(group.threadId);
    // Nothing else is actionable on the main post once disbanding starts — clear its row (same as
    // handleDisbandButton does via updateGroupMessage, just with no interaction to .update() with).
    await updateMainPost(channel, group, []);
    await beginDisband(client, channel, group, '⌛ No one confirmed this group was still active, so it was automatically disbanded.');
    console.log(`[LFG] Group ${group.id} auto-disbanded after a missed keep-alive check.`);
  } catch (err) {
    if (!isAlreadyGoneError(err)) console.error(`[LFG] Could not auto-disband group ${group.id} after a missed keep-alive check:`, err.message);
  }
}

async function handleKeepAliveButton(interaction, groupId) {
  const group = await requireGroup(interaction, groupId);
  if (!group) return;
  if (!group.members.has(interaction.user.id) && !isStaff(interaction)) {
    return replyEphemeral(interaction, '⚠️ Only members of this group, or a Coordinator or higher, can confirm it\'s still active.');
  }

  resetKeepAliveCheck(interaction.client, group);

  // Edits the prompt message directly (the button the user just clicked lives on it) instead of
  // going through sendOrEditActivity — confirming isn't news anyone needs pinged for, so this
  // doesn't need to be a new message, just this one losing its button.
  await interaction.update({
    content: memberNotice(group, `✅ <@${interaction.user.id}> confirmed this group is still active.`),
    embeds: [],
    components: [],
  });
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

// Labels the shared "<Action> clicked" log line below — every group-button handler used to log
// this itself with only the action word differing, so it's hoisted here instead.
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
};
