const { ChannelType, ChannelFlags, EmbedBuilder } = require('discord.js');
const { readJson, writeJson, truncate } = require('./db');
const { CATEGORIES, emojiLabel, isAlreadyGoneError, notifyAdminLog } = require('./roleMenu');
const { DEFAULT_EMBED_COLOR } = require('./embedColor');

// Same forum /lfg-post creates group threads in — the start page lives there too.
const FORUM_CHANNEL_ID = process.env.LFG_FORUM_CHANNEL_ID;

const START_POST_DATA_FILE = 'lfg-start-post.json';

// Doubles as the fallback match target for findExistingStartThread — keep stable.
const START_POST_TITLE = '📌 Start Here — How to Use LFG';

// Discord embed caps (25 fields, 1024 chars/value) — keeps a huge CATEGORIES edit from erroring.
const MAX_EMBED_FIELDS = 25;
const MAX_FIELD_VALUE_LENGTH = 1024;

// Shared accent color for all three embeds, so they read as one post despite being built separately.
const EMBED_COLOR = DEFAULT_EMBED_COLOR;

// Thin rule separating a category's name from its activity list — see buildActivitiesEmbed.
const FIELD_DIVIDER = '─'.repeat(20);

// Pulled from the repo's master branch (not a pinned commit) so pushing a new gif there
// updates the embed automatically — no redeploy or code change needed.
const HOW_TO_GIF_URL = 'https://raw.githubusercontent.com/Pdiddy973/TangleCrew/master/assets/lfg-tour.gif';

function buildInstructionsEmbed() {
  return new EmbedBuilder()
    .setTitle(START_POST_TITLE)
    .setImage(HOW_TO_GIF_URL)
    .setDescription(
      [
        'Use this forum to find, or start, groups for OSRS bosses, raids, and minigames.',
        '',
        '**Commands**',
        '• `/lfg-post` — create a new LFG group: pick a category, activity, group size, and start time.',
        '• `/lfg-roles` — opt in/out of ping roles for specific activities, so you get notified when a group forms.',
        '',
        '_See the gif below for how joining, leaving, and the queue work on a group post._',
      ].join('\n')
    )
    .setColor(EMBED_COLOR);
}

// Covers the automatic/behind-the-scenes behavior that isn't a button someone clicks — worth
// surfacing on its own so a group closing (or getting pinged) on its own doesn't look like a bug.
function buildAutomationEmbed() {
  return new EmbedBuilder()
    .setTitle('⏱️ Automations')
    .setDescription(
      [
        'A few things happen on their own, without anyone clicking a button:',
        '',
        '• **Empty groups auto-close** after 15 minutes.',
        '• **Keep-alive checks** every 2 hours — no response in 10 minutes closes the group.',
        '• **Queue offers expire** after 5 minutes.',
        '• **Disband has a 60s grace period** to cancel.',
        '• **The post tidies itself up** — old notices get replaced automatically.',
      ].join('\n')
    )
    .setColor(EMBED_COLOR);
}

// Reads categories/activities live from CATEGORIES — a new one shows up on the next restart.
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
        // A thin rule under the category name — addFields' name/value gap alone reads too
        // cramped once the value is a long, comma-packed activity list.
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

// Every active + archived thread in the forum, as one list — shared by both fallback lookups
// below so a missing/stale stored id only costs one pair of fetches, not two.
async function fetchAllThreads(forumChannel) {
  const [active, archived] = await Promise.all([
    forumChannel.threads.fetchActive().catch(() => null),
    forumChannel.threads.fetchArchived().catch(() => null),
  ]);
  return [...(active?.threads.values() ?? []), ...(archived?.threads.values() ?? [])];
}

// Fallback for a missing/stale stored id — finds a bot-owned thread with our title.
// Ownership check stops it from adopting an unrelated thread that shares the title.
function findExistingStartThread(threads, botUserId) {
  return threads.find((t) => t.ownerId === botUserId && t.name === START_POST_TITLE) ?? null;
}

// Last resort: forums only allow a small, fixed number of pinned posts, so creating a fresh
// thread and pinning it fails once that cap is already taken by something else. Rather than
// erroring out, adopt whatever's already pinned — only its starter message gets replaced, so any
// replies already in that thread are left alone.
function findAnyPinnedThread(threads) {
  return threads.find((t) => t.flags?.has(ChannelFlags.Pinned)) ?? null;
}

// Creates a fresh start post and remembers its id so future restarts don't duplicate it.
async function createStartPost(forumChannel, embeds) {
  const thread = await forumChannel.threads.create({
    name: START_POST_TITLE,
    message: { embeds },
  });
  await thread.pin();
  writeJson(START_POST_DATA_FILE, { threadId: thread.id });
  console.log(`[LFG] Created start page post: thread ${thread.id}`);
}

// Called on ClientReady — reuses an existing thread if found, otherwise creates one.
// Never throws, so eventHandler.js calls it unwrapped, like sendHoneypotStartupMessage.
async function ensureLfgStartPost(client) {
  if (!FORUM_CHANNEL_ID) return;

  const forumChannel = await client.channels.fetch(FORUM_CHANNEL_ID).catch(() => null);
  if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
    const message = 'LFG_FORUM_CHANNEL_ID doesn\'t point to a valid Forum Channel — the LFG start page was not set up.';
    console.error(`[LFG] ${message}`);
    await notifyAdminLog(client, '⚠️ LFG Start Page Misconfigured', message);
    return;
  }

  const stored = readJson(START_POST_DATA_FILE);
  let thread = stored.threadId ? await forumChannel.threads.fetch(stored.threadId).catch(() => null) : null;

  let adopted = false;
  if (!thread) {
    const threads = await fetchAllThreads(forumChannel);
    thread = findExistingStartThread(threads, client.user.id);
    if (!thread) {
      thread = findAnyPinnedThread(threads);
      adopted = Boolean(thread);
    }
  }

  const embeds = buildStartPageEmbeds();

  if (thread) {
    try {
      if (thread.archived) await thread.setArchived(false);
      await thread.messages.edit(thread.id, { embeds });
      if (!thread.flags?.has(ChannelFlags.Pinned)) await thread.pin();
      writeJson(START_POST_DATA_FILE, { threadId: thread.id });
      if (adopted) {
        console.log(`[LFG] Adopted the already-pinned thread as the LFG start page: ${thread.id}`);
        await notifyAdminLog(
          client,
          'ℹ️ LFG Start Page Adopted an Existing Pinned Post',
          `The forum's pin slot was already taken, so <#${thread.id}> was turned into the LFG start page instead of creating a new post. Its replies were left as-is — only the starter message changed.`
        );
      }
      return;
    } catch (err) {
      if (!isAlreadyGoneError(err)) {
        console.error('[LFG] Could not update existing start page post:', err.message);
        return;
      }
      // Thread or starter message was deleted out-of-band — recreate instead of leaving no post.
    }
  }

  try {
    await createStartPost(forumChannel, embeds);
  } catch (err) {
    console.error('[LFG] Could not create LFG start page post:', err.message);
    await notifyAdminLog(client, '⚠️ LFG Start Page Creation Failed', `Failed to create the LFG start page post: ${err.message}`);
  }
}

module.exports = { ensureLfgStartPost };
