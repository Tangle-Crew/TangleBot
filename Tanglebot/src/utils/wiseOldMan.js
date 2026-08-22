const axios = require('axios');

const WOM_BASE_URL = 'https://api.wiseoldman.net/v2';

// WOM's Cloudflare-fronted API 403s requests with no User-Agent — required, not just polite.
const USER_AGENT = 'TangleCrew-DiscordBot (https://github.com) contact: clan admin';

function womHeaders() {
  const headers = { 'User-Agent': USER_AGENT };
  const apiKey = process.env.WOM_API_KEY?.trim();
  if (apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

// Normalizes so "Zezima"/"zezima"/"Ze Zima"/"ze_zima" all compare equal — WOM stores usernames
// lowercase-with-spaces internally.
function normalizeRsn(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// clientSyncJoinedAt (backfilled by WOM's clan-chat sync) is the actual join date; createdAt is
// just when the WOM DB row was created, which can lag far behind.
async function getGroupMemberships(groupId) {
  const res = await axios.get(`${WOM_BASE_URL}/groups/${groupId}`, {
    headers: womHeaders(),
    timeout: 15000,
  });

  const memberships = res.data?.memberships || [];
  return memberships.map((m) => ({
    playerId: m.player?.id ?? m.playerId,
    username: m.player?.username ?? '',
    displayName: m.player?.displayName ?? m.player?.username ?? '',
    joinedAt: new Date(m.clientSyncJoinedAt ?? m.createdAt),
  }));
}

module.exports = {
  getGroupMemberships,
  normalizeRsn,
};
