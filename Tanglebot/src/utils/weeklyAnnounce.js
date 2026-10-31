const { getAllGroupCompetitions } = require('./wiseOldMan');
const { withTimeout } = require('./db');

// The WOM client sets no timeout of its own.
const REQUEST_TIMEOUT_MS = 20 * 1000;

// The group's competitions with the earliest end time still in the future. Competitions created
// together by /weeklycomp share that end time exactly. { endsAt: null, competitions: [] } if none.
async function findNextEnding(groupId, now = Date.now()) {
  const all = await withTimeout(getAllGroupCompetitions(groupId), 'Loading the group competitions', REQUEST_TIMEOUT_MS);
  const future = all.filter(c => new Date(c.endsAt).getTime() > now);
  if (future.length === 0) return { endsAt: null, competitions: [] };
  const endsAt = Math.min(...future.map(c => new Date(c.endsAt).getTime()));
  return {
    endsAt: new Date(endsAt),
    competitions: future.filter(c => new Date(c.endsAt).getTime() === endsAt),
  };
}

module.exports = { findNextEnding };
