const { readJson, writeJson, withFileLock } = require('./db');

// Discord's per-message limits: 10 embeds and 6000 characters (kept under, to be safe).
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_MESSAGE_TOTAL_CHARS = 5800;

function mentionOrName(entry) {
  return `**${entry.displayName}**`;
}

// Updates display names from the server; members who left keep their stored name. onNameChange
// is awaited for each changed entry so the caller can save it to the sheet.
async function refreshDisplayNames(guild, entries, onNameChange) {
  console.log(`Refreshing display names for ${entries.length} leaderboard entrie(s)`);
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

// Finds the bot's previous leaderboard messages in recent history, for when the stored IDs are
// missing or stale, so they're edited instead of reposted.
async function findPreviousLeaderboardMessages(channel, botUserId, isOwnLeaderboardMessage) {
  const fetched = await channel.messages.fetch({ limit: 50 });
  return [...fetched.values()]
    .filter((m) => m.author.id === botUserId && isOwnLeaderboardMessage(m.embeds[0]))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

// Posts the full leaderboard, editing the previous messages in place.
//
// options:
//   buildEmbeds(entries) -> Embed[]              builds this leaderboard's embeds
//   dataFile                                     data/ JSON file storing the last-posted message IDs
//   logPrefix                                    tag for console logs, e.g. "PHS" / "DHS"
//   isOwnLeaderboardMessage(firstEmbed) -> bool   identifies this leaderboard's own post during recovery
//   onDisplayNameChange(entry) -> Promise         (optional) persists a refreshed display name back to the sheet
async function postLeaderboard(guild, channelId, entries, botUserId, options) {
  // One post at a time per leaderboard.
  return withFileLock(options.dataFile, () => postLeaderboardLocked(guild, channelId, entries, botUserId, options));
}

async function postLeaderboardLocked(guild, channelId, entries, botUserId, { buildEmbeds, dataFile, logPrefix, isOwnLeaderboardMessage, onDisplayNameChange }) {
  const channel = await guild.channels.fetch(channelId);
  const freshEntries = await refreshDisplayNames(guild, entries, onDisplayNameChange);
  const groups = packEmbedsIntoMessages(buildEmbeds(freshEntries));

  const stored = readJson(dataFile);
  const prevIds = Array.isArray(stored.messageIds) ? stored.messageIds : [];

  let prevMessages = await Promise.all(prevIds.map((id) => channel.messages.fetch(id).catch(() => null)));

  // Rescan if any stored ID is stale; filling a gap with a new message would reorder the board.
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

  // Delete leftover messages from a longer previous post.
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
