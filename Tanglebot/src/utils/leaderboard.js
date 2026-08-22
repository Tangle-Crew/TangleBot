const { readJson, writeJson } = require('./db');

// Discord caps a message at 10 embeds and ~6000 chars combined (separate from each embed's own
// ~4096 description cap, enforced by the caller's buildEmbeds). Packing must respect both or a
// big leaderboard gets rejected outright.
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_MESSAGE_TOTAL_CHARS = 5800;

function mentionOrName(entry) {
  return `**${entry.displayName}**`;
}

// Refreshes each entry's display name from the guild so nickname changes show up without a
// throwaway add/remove. Departed members keep their last stored name. onNameChange, if given, is
// awaited per changed entry so the caller can persist it back to its sheet row.
async function refreshDisplayNames(guild, entries, onNameChange) {
  const fetchedMembers = await guild.members.fetch().catch(() => null);
  if (!fetchedMembers) return entries;

  const fresh = [];
  for (const entry of entries) {
    const member = fetchedMembers.get(entry.discordId);
    if (member && member.displayName !== entry.displayName) {
      const updated = { ...entry, displayName: member.displayName };
      if (onNameChange && entry.rowNumber != null) await onNameChange(updated);
      fresh.push(updated);
    } else {
      fresh.push(entry);
    }
  }
  return fresh;
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
//   buildEmbeds(entries) -> Embed[]              builds this leaderboard's embeds
//   dataFile                                     data/ JSON file storing the last-posted message IDs
//   logPrefix                                    tag for console logs, e.g. "PHS" / "DHS"
//   isOwnLeaderboardMessage(firstEmbed) -> bool   identifies this leaderboard's own post during recovery
//   onDisplayNameChange(entry) -> Promise         (optional) persists a refreshed display name back to the sheet
async function postLeaderboard(guild, channelId, entries, botUserId, { buildEmbeds, dataFile, logPrefix, isOwnLeaderboardMessage, onDisplayNameChange }) {
  const channel = await guild.channels.fetch(channelId);
  const freshEntries = await refreshDisplayNames(guild, entries, onDisplayNameChange);
  const groups = packEmbedsIntoMessages(buildEmbeds(freshEntries));

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
