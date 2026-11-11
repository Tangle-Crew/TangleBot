const database = require('./database');
const wiseOldMan = require('./wiseOldMan');

// Copies the clan's finished WOM competitions and their results into the competitions and
// competition_results tables. WOM is only read. A competition is saved once it has ended.

const CALL_GAP_MS = process.env.WOM_API_KEY ? 700 : 3500;
const DEFAULT_LIMIT = 120;
const INSERT_BATCH = 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let running = false;

// The real WOM, as an object so tests can replace it.
function womSource() {
  return {
    getCompetitions: groupId => wiseOldMan.getAllGroupCompetitions(groupId),
    getCompetitionDetails: id => wiseOldMan.getCompetitionDetails(id),
  };
}

// The players who gained anything, highest first, with their place. Ties share a place and the
// next place is skipped (a tie for 2nd leaves no 3rd).
function resultsFrom(details) {
  const players = (details.participations ?? [])
    .filter(p => (p.progress?.gained ?? 0) > 0)
    .map(p => ({ womPlayerId: p.player.id, rsn: p.player.displayName, gained: p.progress.gained }))
    .sort((a, b) => b.gained - a.gained);
  return players.map(p => ({ ...p, rank: 1 + players.filter(o => o.gained > p.gained).length }));
}

// Saves one competition and its results using one pg client (call it inside a transaction).
async function saveCompetition(client, details) {
  const results = resultsFrom(details);
  const total = results.reduce((sum, r) => sum + r.gained, 0);
  await client.query(
    `insert into competitions (wom_competition_id, title, metric, metrics, starts_at, ends_at, participant_count, total_gained)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (wom_competition_id) do nothing`,
    [
      details.id, details.title, details.metric, (details.metrics ?? []).map(m => m.metric),
      new Date(details.startsAt), new Date(details.endsAt), details.participantCount ?? results.length, total,
    ]
  );
  for (let i = 0; i < results.length; i += INSERT_BATCH) {
    const batch = results.slice(i, i + INSERT_BATCH);
    await client.query(
      `insert into competition_results (wom_competition_id, wom_player_id, account_id, rsn, rank, gained)
       select $1, u.player_id, a.id, u.rsn, u.rank, u.gained
       from unnest($2::int[], $3::text[], $4::int[], $5::float8[]) as u(player_id, rsn, rank, gained)
       left join accounts a on a.wom_player_id = u.player_id
       on conflict do nothing`,
      [details.id, batch.map(r => r.womPlayerId), batch.map(r => r.rsn), batch.map(r => r.rank), batch.map(r => r.gained)]
    );
  }
  return results.length;
}

// Competitions that have ended and are not saved yet, newest first.
async function pendingCompetitions({ groupId, source, db, now = Date.now() }) {
  const all = await source.getCompetitions(groupId);
  const saved = new Set((await db.query('select wom_competition_id from competitions')).rows.map(r => r.wom_competition_id));
  return all
    .filter(c => new Date(c.endsAt).getTime() <= now && !saved.has(c.id))
    .sort((a, b) => new Date(b.endsAt) - new Date(a.endsAt));
}

// Counts what a sync would read, without reading each competition. The first sync reads every
// finished competition, one WOM call each.
async function previewCompetitions({ groupId, source = womSource(), db = database.getPool(), limit = DEFAULT_LIMIT, gapMs = CALL_GAP_MS } = {}) {
  const pending = await pendingCompetitions({ groupId, source, db });
  const toRead = Math.min(pending.length, limit);
  return { pending: pending.length, toRead, minutes: Math.ceil((toRead * gapMs) / 60000) };
}

// Reads up to `limit` unsaved finished competitions (newest first) and saves them, each in its own
// transaction. Returns { competitions, results, remaining }.
async function syncCompetitions({ groupId, source = womSource(), db = database.getPool(), limit = DEFAULT_LIMIT, gapMs = CALL_GAP_MS, wait = sleep } = {}) {
  if (running) throw Object.assign(new Error('A competition sync is already running'), { code: 'SYNC_RUNNING' });
  running = true;
  try {
    const pending = await pendingCompetitions({ groupId, source, db });
    const batch = pending.slice(0, limit);
    let results = 0;
    for (const competition of batch) {
      await wait(gapMs);
      const details = await source.getCompetitionDetails(competition.id);
      results += await database.withTransaction(client => saveCompetition(client, details), db);
    }
    // Players saved before their account existed get their account now.
    await db.query(
      `update competition_results r set account_id = a.id
       from accounts a where a.wom_player_id = r.wom_player_id and r.account_id is null`
    );
    return { competitions: batch.length, results, remaining: pending.length - batch.length };
  } finally {
    running = false;
  }
}

// Counts for /memberdata status.
async function competitionStatus(db = database.getPool()) {
  const row = (await db.query(
    `select (select count(*) from competitions) as competitions,
            (select count(*) from competition_results) as results,
            (select max(ends_at) from competitions) as newest`
  )).rows[0];
  return { competitions: Number(row.competitions), results: Number(row.results), newest: row.newest ? new Date(row.newest) : null };
}

module.exports = { syncCompetitions, previewCompetitions, competitionStatus, resultsFrom, saveCompetition };
