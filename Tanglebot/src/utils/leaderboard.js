const { readJson, writeJson } = require('./db');

// Discord caps a message at 10 embeds and ~6000 chars combined (separate from each embed's own
// ~4096 description cap, enforced by the caller's buildEmbeds). Packing must respect both or a
// big leaderboard gets rejected outright.
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_MESSAGE_TOTAL_CHARS = 5800;

// A mention only renders as a clickable chip if the viewer's client has the user cached, which
// for a member who's left the guild it won't — falls back to their last known display name so
// the leaderboard doesn't show raw "<@id>" text for former members.
function mentionOrName(entry, memberIds) {
  return memberIds.has(entry.discordId) ? `<@${entry.discordId}>` : `**${entry.displayName}**`;
}

function embedCharCount(embed) {
  const data = embed.data;
  return (data.title?.length || 0) + (data.description?.length || 0);
}

function packEmbedsIntoMessages(embeds) {
  const messages = [];
  let current = [];
  let currentTotal = 0;

  for (const embed of embeds) {
    const size = embedCharCount(embed);
    const overCount = current.length >= MAX_EMBEDS_PER_MESSAGE;
    const overTotal = currentTotal + size > MAX_MESSAGE_TOTAL_CHARS;

    if (current.length > 0 && (overCount || overTotal)) {
      messages.push(current);
      current = [];
      currentTotal = 0;
    }

    current.push(embed);
    currentTotal += size;
  }

  if (current.length) messages.push(current);
  return messages;
}

// Fallback for stale stored message IDs (message deleted, data file reset by a redeploy, etc.) —
// scans recent channel history for the bot's own previous leaderboard post(s) so we can edit in
// place instead of spamming. isOwnLeaderboardMessage(firstEmbed) tells a leaderboard's own post
// apart from any other message the bot has sent in the channel.
async function findPreviousLeaderboardMessages(channel, botUserId, isOwnLeaderboardMessage) {
  const fetched = await channel.messages.fetch({ limit: 50 });
  return [...fetched.values()]
    .filter((m) => m.author.id === botUserId && isOwnLeaderboardMessage(m.embeds[0]))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

// entries is the FULL, freshly re-sorted leaderboard each run — message index i always gets
// whatever lands there this time, so a member moving between embeds just shows up correctly next
// post; no per-member state to patch.
//
// options:
//   buildEmbeds(entries, memberIds) -> Embed[]   builds this leaderboard's embeds
//   dataFile                                     data/ JSON file storing the last-posted message IDs
//   logPrefix                                    tag for console logs, e.g. "PHS" / "DHS"
//   isOwnLeaderboardMessage(firstEmbed) -> bool   identifies this leaderboard's own post during recovery
async function postLeaderboard(guild, channelId, entries, botUserId, { buildEmbeds, dataFile, logPrefix, isOwnLeaderboardMessage }) {
  const channel = await guild.channels.fetch(channelId);
  // Warmed once per post so mentionOrName can tell current members from
  // former ones without a fetch per leaderboard entry.
  await guild.members.fetch().catch(() => null);
  const memberIds = new Set(guild.members.cache.keys());
  const groups = packEmbedsIntoMessages(buildEmbeds(entries, memberIds));

  const stored = readJson(dataFile);
  const prevIds = Array.isArray(stored.messageIds) ? stored.messageIds : [];

  let prevMessages = await Promise.all(prevIds.map((id) => channel.messages.fetch(id).catch(() => null)));

  if (!(prevIds.length > 0 && prevMessages.every((m) => m))) {
    console.log(`[${logPrefix}] Stored leaderboard message ID(s) missing or stale — scanning channel history to recover`);
    const recovered = await findPreviousLeaderboardMessages(channel, botUserId, isOwnLeaderboardMessage);
    if (recovered.length) prevMessages = recovered;
  }

  const newIds = [];
  for (let i = 0; i < groups.length; i++) {
    const existing = prevMessages[i];
    if (existing) {
      try {
        await existing.edit({ embeds: groups[i] });
        newIds.push(existing.id);
        continue;
      } catch (err) {
        console.error(`[${logPrefix}] Could not edit message ${existing.id} (${err.message}), sending new...`);
      }
    }
    const sent = await channel.send({ embeds: groups[i] });
    newIds.push(sent.id);
  }

  // Delete any leftover messages from a previous run that had more chunks.
  for (let i = groups.length; i < prevMessages.length; i++) {
    const leftover = prevMessages[i];
    if (!leftover) continue;
    try {
      await leftover.delete();
    } catch {
      // Already deleted — ignore
    }
  }

  writeJson(dataFile, { messageIds: newIds });
  console.log(`[${logPrefix}] Leaderboard updated (${newIds.length} message${newIds.length === 1 ? '' : 's'})`);
}

module.exports = {
  mentionOrName,
  postLeaderboard,
};
