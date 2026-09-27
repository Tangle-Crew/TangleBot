const { EventEmitter } = require('events');
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

// Not every metric has a background image (e.g. Mimic); use WOM's generic icon then.
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

// Every competition the group has hosted. WOM currently ignores limit/offset and returns them all
// at once, which ends the loop; paging covers it if WOM starts honouring them.
const GROUP_COMPETITIONS_PAGE_SIZE = 50;
const GROUP_COMPETITIONS_MAX_PAGES = 20;
async function getAllGroupCompetitions(groupId) {
  const byId = new Map();
  for (let page = 0; page < GROUP_COMPETITIONS_MAX_PAGES; page++) {
    const batch = await womClient().groups.getGroupCompetitions(groupId, {
      limit: GROUP_COMPETITIONS_PAGE_SIZE,
      offset: page * GROUP_COMPETITIONS_PAGE_SIZE,
    });
    const sizeBefore = byId.size;
    for (const competition of batch) byId.set(competition.id, competition);
    if (batch.length !== GROUP_COMPETITIONS_PAGE_SIZE || byId.size === sizeBefore) break;
  }
  return [...byId.values()];
}

// Emits 'updateAll' ({ groupId, count, source }) after each successful update all, so other
// features can reuse the fresh data.
const womEvents = new EventEmitter();

// Queues a hiscores update for every outdated member of the group. `source` names the calling
// feature for womEvents listeners.
async function updateAllGroupMembers(groupId, groupVerificationCode, source = 'another bot feature') {
  const result = await womClient().groups.updateAll(groupId, groupVerificationCode);
  womEvents.emit('updateAll', { groupId, count: result?.count ?? 0, source });
  return result;
}

// The group with every membership (player and clan rank).
function getGroupDetails(groupId) {
  return womClient().groups.getGroupDetails(groupId);
}

// Each tracked member's gains in `metric` between the two dates. WOM returns every member at once.
// Members with no snapshots in the range (e.g. never tracked) are left out.
function getGroupGains(groupId, metric, startDate, endDate) {
  return womClient().groups.getGroupGains(groupId, { metric, startDate, endDate });
}

function getCompetitionDetails(competitionId) {
  return womClient().competitions.getCompetitionDetails(competitionId);
}

function isCompetitionOngoing(competition, now = Date.now()) {
  return new Date(competition.startsAt).getTime() <= now && new Date(competition.endsAt).getTime() > now;
}

// Participants with any progress, highest gains first.
function rankParticipants(details) {
  return (details.participations ?? [])
    .filter(p => (p.progress?.gained ?? 0) > 0)
    .map(p => ({ id: p.player.id, name: p.player.displayName, gained: p.progress.gained }))
    .sort((a, b) => b.gained - a.gained);
}

function competitionUrl(id) {
  return `https://wiseoldman.net/competitions/${id}`;
}

module.exports = {
  resolveMetricImageUrl,
  createGroupCompetition,
  getAllGroupCompetitions,
  updateAllGroupMembers,
  womEvents,
  getGroupDetails,
  getGroupGains,
  getCompetitionDetails,
  isCompetitionOngoing,
  rankParticipants,
  competitionUrl,
};
