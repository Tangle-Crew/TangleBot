const { ChannelType, ChannelFlags, EmbedBuilder } = require('discord.js');
const { truncate } = require('./db');
const { readState, writeState } = require('./state');
const { CATEGORIES, emojiLabel, isAlreadyGoneError, notifyAdminLog } = require('./roleMenu');
const { DEFAULT_EMBED_COLOR } = require('./embedColor');
const { buildSuggestRows } = require('./lfgSuggestion');

// The /lfg-post forum; the start page is pinned there.
const FORUM_CHANNEL_ID = process.env.LFG_FORUM_CHANNEL_ID;

const START_POST_DATA_FILE = 'lfg-start-post.json';

// Also used to find the post again, so keep it stable.
const START_POST_TITLE = '📌 Start Here — How to Use LFG';

// Discord embed limits.
const MAX_EMBED_FIELDS = 25;
const MAX_FIELD_VALUE_LENGTH = 1024;

const EMBED_COLOR = DEFAULT_EMBED_COLOR;

const FIELD_DIVIDER = '─'.repeat(20);

function buildInstructionsEmbed() {
  return new EmbedBuilder()
    .setTitle(START_POST_TITLE)
    .setDescription(
      [
        'Find or start groups for OSRS bosses, raids and minigames.',
        '',
        '**Commands**',
        '• `/lfg-post` — Start a new group.',
        '• `/lfg-roles` — Choose which activities ping you.',
        '',
        '**Buttons**',
        '• **Join / Leave** — Take or give up a spot (a full group has a queue).',
        '• **Start Now** — Start the group early.',
        '• **Manage** — Remove a member or edit the details.',
        '• **Disband** — Close the group after a short grace period.',
        '',
        '**Missing an activity?** Use **Make a Suggestion** below.',
      ].join('\n')
    )
    .setColor(EMBED_COLOR);
}

// Explains what happens without a button click, so it doesn't look like a bug.
function buildAutomationEmbed() {
  return new EmbedBuilder()
    .setTitle('⏱️ Automations')
    .setDescription(
      [
        '• **Start ping** — Members are pinged when the start time arrives.',
        '• **Empty groups** — Close after 15 minutes.',
        '• **Keep-alive** — Every 2 hours; no reply in 10 minutes closes the group.',
        '• **Queue offers** — Expire after 5 minutes.',
        '• **Closed groups** — Locked and archived, not deleted.',
        '• **Limit** — 2 open groups per person.',
      ].join('\n')
    )
    .setColor(EMBED_COLOR);
}

// Built from CATEGORIES on each startup.
function buildActivitiesEmbed() {
  const activityFields = Object.values(CATEGORIES)
    .slice(0, MAX_EMBED_FIELDS)
    .map((category) => {
      const roleList = truncate(
        category.roles.map((r) => emojiLabel(r.emoji, r.label)).join(', '),
        MAX_FIELD_VALUE_LENGTH
      );
      return {
        name: emojiLabel(category.buttonEmoji, category.label),
        value: `${FIELD_DIVIDER}\n${roleList}`,
      };
    });

  return new EmbedBuilder()
    .setTitle('🗂️ Loaded Activities')
    .setDescription('Everything currently available to queue up for:')
    .addFields(activityFields)
    .setColor(EMBED_COLOR);
}

function buildStartPageEmbeds() {
  return [buildInstructionsEmbed(), buildAutomationEmbed(), buildActivitiesEmbed()];
}

// Every active and archived thread in the forum.
async function fetchAllThreads(forumChannel) {
  console.log('[LFG] Fetching active + archived forum threads to locate the start post');
  const [active, archived] = await Promise.all([
    forumChannel.threads.fetchActive().catch(() => null),
    forumChannel.threads.fetchArchived().catch(() => null),
  ]);
  return [...(active?.threads.values() ?? []), ...(archived?.threads.values() ?? [])];
}

// A bot-owned thread with the start page title.
function findExistingStartThread(threads, botUserId) {
  return threads.find((t) => t.ownerId === botUserId && t.name === START_POST_TITLE) ?? null;
}

// Last resort: a pinned post of the bot's own, e.g. the start page under an old title. Posts by
// anyone else are left alone, since the bot can't edit them.
function findOwnPinnedThread(threads, botUserId) {
  return threads.find((t) => t.ownerId === botUserId && t.flags?.has(ChannelFlags.Pinned)) ?? null;
}

// Pins the start post if it isn't already. A forum allows only one pinned post, so this fails if
// another post has the slot; that's reported rather than treated as the whole setup failing.
async function pinStartPost(client, thread) {
  if (thread.flags?.has(ChannelFlags.Pinned)) return;
  try {
    await thread.pin();
  } catch (err) {
    console.error('[LFG] Could not pin the LFG start page post:', err.message);
    await notifyAdminLog(
      client,
      '⚠️ LFG Start Page Not Pinned',
      `<#${thread.id}> is the LFG start page but couldn't be pinned: ${err.message}. A forum can only have one pinned post, so unpin the other one and pin this one.`
    );
  }
}

// Creates and pins the start post. Its id is stored first, so a failed pin doesn't lead to a
// second post on the next restart.
async function createStartPost(client, forumChannel, embeds) {
  const thread = await forumChannel.threads.create({
    name: START_POST_TITLE,
    message: { embeds, components: buildSuggestRows() },
  });
  writeState(START_POST_DATA_FILE, { threadId: thread.id });
  console.log(`[LFG] Created start page post: thread ${thread.id}`);
  await pinStartPost(client, thread);
}

// Called on startup: updates the existing start post, or creates one.
async function ensureLfgStartPost(client) {
  if (!FORUM_CHANNEL_ID) return;

  const forumChannel = await client.channels.fetch(FORUM_CHANNEL_ID).catch(() => null);
  if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
    const message = 'LFG_FORUM_CHANNEL_ID doesn\'t point to a valid Forum Channel — the LFG start page was not set up.';
    console.error(`[LFG] ${message}`);
    await notifyAdminLog(client, '⚠️ LFG Start Page Misconfigured', message);
    return;
  }

  const stored = readState(START_POST_DATA_FILE);
  let thread = stored.threadId ? await forumChannel.threads.fetch(stored.threadId).catch(() => null) : null;

  let adopted = false;
  if (!thread) {
    const threads = await fetchAllThreads(forumChannel);
    thread = findExistingStartThread(threads, client.user.id);
    if (!thread) {
      thread = findOwnPinnedThread(threads, client.user.id);
      adopted = Boolean(thread);
    }
  }

  const embeds = buildStartPageEmbeds();

  if (thread) {
    try {
      if (thread.archived) await thread.setArchived(false);
      await thread.messages.edit(thread.id, { embeds, components: buildSuggestRows() });
      writeState(START_POST_DATA_FILE, { threadId: thread.id });
      await pinStartPost(client, thread);
      console.log(`[LFG] Updated start page post: thread ${thread.id}`);
      if (adopted) {
        console.log(`[LFG] Adopted the bot's pinned thread as the LFG start page: ${thread.id}`);
        await notifyAdminLog(
          client,
          'ℹ️ LFG Start Page Adopted an Existing Pinned Post',
          `The start page post couldn't be found, so the bot's pinned post <#${thread.id}> was turned into the LFG start page instead of creating a new one. Its replies were left as-is — only the starter message changed.`
        );
      }
      return;
    } catch (err) {
      if (!isAlreadyGoneError(err)) {
        // The post exists but is stale until the next restart.
        console.error('[LFG] Could not update existing start page post:', err.message);
        await notifyAdminLog(client, '⚠️ LFG Start Page Update Failed', `The LFG start page post exists but couldn't be updated: ${err.message}`);
        return;
      }
      // The thread or its starter message was deleted; recreate it below.
    }
  }

  try {
    await createStartPost(client, forumChannel, embeds);
  } catch (err) {
    console.error('[LFG] Could not create LFG start page post:', err.message);
    await notifyAdminLog(client, '⚠️ LFG Start Page Creation Failed', `Failed to create the LFG start page post: ${err.message}`);
  }
}

module.exports = { ensureLfgStartPost };
