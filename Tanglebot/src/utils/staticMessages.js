const crypto = require('crypto');
const state = require('./state');
const { isAlreadyGoneError, notifyAdminLog } = require('./roleMenu');

function hashOf(payloads) {
  return crypto.createHash('sha256').update(JSON.stringify(payloads)).digest('hex');
}

// Deletes messages, ignoring ones that are already gone.
async function deleteMessages(channel, ids) {
  for (const id of ids) {
    try {
      await channel.messages.delete(id);
    } catch (err) {
      if (!isAlreadyGoneError(err)) console.error(`[StaticMessages] Could not delete message ${id}:`, err.message);
    }
  }
}

// Keeps a fixed set of bot messages in a channel in step with payloads (message options, in order).
// State in the file for key: { channelId, messageIds, hash }. Does nothing when the hash is
// unchanged. After a change, refresh({ ids, channel }) may return new payloads for the first
// messages (for links that need the final message ids). Returns 'unchanged', 'updated', 'reposted' or 'failed'.
async function syncStaticMessages(client, { key, channelId, payloads, label = key, refresh = null }) {
  const hash = hashOf(payloads);
  const stored = state.readState(key);
  const storedIds = Array.isArray(stored.messageIds) ? stored.messageIds : [];
  const sameChannel = stored.channelId === channelId;

  if (sameChannel && stored.hash === hash && storedIds.length === payloads.length) {
    console.log(`[StaticMessages] ${label}: unchanged.`);
    return 'unchanged';
  }

  let sent = [];
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.messages || !channel.send) throw new Error('not a channel the bot can post in');

    // The old messages live in the old channel when the channel changed.
    const oldChannel = sameChannel ? channel : await client.channels.fetch(stored.channelId).catch(() => null);
    let ids = sameChannel ? [...storedIds] : [];
    let repost = !sameChannel;

    // Edit in order. A missing message means the rest are removed and everything is reposted.
    const common = Math.min(ids.length, payloads.length);
    for (let i = 0; i < common && !repost; i++) {
      try {
        await channel.messages.edit(ids[i], payloads[i]);
      } catch (err) {
        if (!isAlreadyGoneError(err)) throw err;
        repost = true;
      }
    }

    if (repost) {
      if (oldChannel && storedIds.length) await deleteMessages(oldChannel, storedIds);
      ids = [];
      sent = ids;
      for (const payload of payloads) ids.push((await channel.send(payload)).id);
    } else {
      sent = ids;
      for (let i = ids.length; i < payloads.length; i++) ids.push((await channel.send(payloads[i])).id);
      if (ids.length > payloads.length) {
        await deleteMessages(channel, ids.slice(payloads.length));
        ids.length = payloads.length;
      }
    }

    if (refresh) {
      const updates = refresh({ ids, channel });
      for (let i = 0; i < updates.length; i++) await channel.messages.edit(ids[i], updates[i]);
    }

    state.writeState(key, { channelId, messageIds: ids, hash });
    console.log(`[StaticMessages] ${label}: ${repost ? 'reposted' : 'updated'} ${ids.length} message(s).`);
    return repost ? 'reposted' : 'updated';
  } catch (err) {
    console.error(`[StaticMessages] ${label} failed:`, err.message);
    // Keep what was sent, so the next run edits it instead of posting again. No hash: not done.
    if (sent.length) state.writeState(key, { channelId, messageIds: sent, hash: null });
    await notifyAdminLog(client, '⚠️ Static Messages Update Failed', `${label}: ${err.message}`);
    return 'failed';
  }
}

module.exports = { syncStaticMessages };
