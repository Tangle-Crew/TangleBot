const { WOMClient } = require('@wise-old-man/utils');

const WOM_ASSETS_BASE_URL = 'https://raw.githubusercontent.com/wise-old-man/wise-old-man/master/app/public/img';
const FALLBACK_IMAGE_URL = `${WOM_ASSETS_BASE_URL}/fallback-icon.png`;

let client = null;
function womClient() {
  if (!client) {
    client = new WOMClient({
      apiKey: process.env.WOM_API_KEY || undefined,
      userAgent: 'tanglebot',
    });
  }
  return client;
}

// Not every metric has a background image on WOM's site (e.g. Mimic); fall back to their generic
// icon rather than hand Discord a 404 page as image data.
async function resolveMetricImageUrl(metric) {
  const url = `${WOM_ASSETS_BASE_URL}/backgrounds/${metric}.png`;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (res.ok) return url;
  } catch (err) {
    console.warn(`[WOM] Failed to probe background image for ${metric}:`, err.message);
  }
  return FALLBACK_IMAGE_URL;
}

// Participants aren't passed — WOM auto-populates them from the group's member list.
// groupId/groupVerificationCode fall back to their env vars if omitted.
async function createGroupCompetition({ title, metric, startsAt, endsAt, groupId, groupVerificationCode }) {
  groupId = groupId ?? Number(process.env.WOM_GROUP_ID);
  groupVerificationCode = groupVerificationCode ?? process.env.WOM_GROUP_VERIFICATION_CODE;
  return womClient().competitions.createCompetition({
    title,
    metric,
    startsAt,
    endsAt,
    groupId,
    groupVerificationCode,
  });
}

module.exports = { resolveMetricImageUrl, createGroupCompetition };
