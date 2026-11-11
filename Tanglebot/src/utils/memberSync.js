const database = require('./database');
const wiseOldMan = require('./wiseOldMan');
const { databaseConfigured } = require('./commandAvailability');
const { intEnv } = require('./db');

// Copies the clan's Wise Old Man (WOM) group into the accounts and member_events tables: who is in
// the group with which rank, plus the join, leave, rank change and name change history.
// WOM is only read. The caller decides whether anything is saved.

const PAGE_SIZE = 50;
const MAX_PAGES = 400;
const INSERT_BATCH = 1000;
// WOM allows 20 requests a minute (100 with a key); stay well under it for the bot's other features.
const CALL_GAP_MS = process.env.WOM_API_KEY ? 700 : 3500;
const DAY_MS = 24 * 60 * 60 * 1000;
// An incremental read goes back past the newest saved event, to catch late arrivals. Name changes
// are listed by when they were asked for, but dated by when they were approved, so they need more.
const ACTIVITY_MARGIN_MS = DAY_MS;
const NAME_CHANGE_MARGIN_MS = 30 * DAY_MS;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const toDate = value => (value ? new Date(value) : null);
const time = value => new Date(value).getTime();

// The real WOM, as an object so tests can replace it.
function womSource() {
  return {
    getGroupDetails: groupId => wiseOldMan.getGroupDetails(groupId),
    getGroupActivity: (groupId, page) => wiseOldMan.getGroupActivity(groupId, page),
    getGroupNameChanges: (groupId, page) => wiseOldMan.getGroupNameChanges(groupId, page),
  };
}

// Reads a newest-first feed page by page. Stops at a short page, or once a page reaches back to
// `since`. truncated is true if it hit the page limit first.
async function readFeed(fetchPage, { since, timeOf, gapMs, wait }) {
  const items = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await wait(gapMs);
    const batch = await fetchPage({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return { items, truncated: false };
    if (since && Math.min(...batch.map(timeOf)) <= since) return { items, truncated: false };
  }
  return { items, truncated: true };
}

// The group, its activity and its name changes. activitySince and nameChangeSince (ms, or null for
// everything) limit how far back the feeds are read.
async function readWom(source, { groupId, activitySince = null, nameChangeSince = null, gapMs = CALL_GAP_MS, wait = sleep }) {
  const details = await source.getGroupDetails(groupId);
  await wait(gapMs);
  const activity = await readFeed(page => source.getGroupActivity(groupId, page), {
    since: activitySince, timeOf: a => time(a.createdAt), gapMs, wait,
  });
  await wait(gapMs);
  const names = await readFeed(page => source.getGroupNameChanges(groupId, page), {
    since: nameChangeSince, timeOf: n => time(n.resolvedAt ?? n.createdAt), gapMs, wait,
  });
  return {
    details,
    activity: activity.items,
    nameChanges: names.items.filter(n => n.status === 'approved'),
    truncated: activity.truncated || names.truncated,
  };
}

const ACTIVITY_KINDS = { joined: 'joined', left: 'left', changed_role: 'rank_changed' };

// The accounts and events WOM describes, ready to save. Current members are active; players seen
// only in the activity feed are former members.
function buildPlan({ details, activity, nameChanges }) {
  const accounts = new Map();
  for (const m of details.memberships) {
    const { player, ...membership } = m;
    accounts.set(m.playerId, {
      womPlayerId: m.playerId,
      username: player.username,
      rsn: player.displayName,
      role: m.role,
      status: 'active',
      womJoinedAt: toDate(m.createdAt),
      clientJoinedAt: toDate(m.clientSyncJoinedAt),
      data: { membership, player },
    });
  }
  for (const a of activity) {
    if (accounts.has(a.playerId) || !a.player) continue;
    accounts.set(a.playerId, {
      womPlayerId: a.playerId,
      username: a.player.username,
      rsn: a.player.displayName,
      role: null,
      status: 'left',
      womJoinedAt: null,
      clientJoinedAt: null,
      data: { player: a.player },
    });
  }

  const events = [];
  for (const a of activity) {
    const kind = ACTIVITY_KINDS[a.type];
    if (!kind) continue;
    events.push({ womPlayerId: a.playerId, kind, oldValue: a.previousRole ?? null, newValue: a.role ?? null, occurredAt: toDate(a.createdAt), data: {} });
  }
  for (const n of nameChanges) {
    events.push({
      womPlayerId: n.playerId, kind: 'name_changed', oldValue: n.oldName, newValue: n.newName,
      occurredAt: toDate(n.resolvedAt ?? n.createdAt), data: { womNameChangeId: n.id },
    });
  }
  return { accounts, events };
}

const EVENT_KINDS = ['joined', 'left', 'rank_changed', 'name_changed'];

// Saves the plan using one pg client (call it inside a transaction). Returns what changed.
async function applyPlan(client, plan) {
  const existing = new Map((await client.query('select wom_player_id, rsn, wom_role, status from accounts')).rows.map(r => [r.wom_player_id, r]));
  const counts = {
    accountsNew: 0, accountsChanged: 0, accountsMarkedLeft: 0, eventsSkipped: 0,
    events: Object.fromEntries(EVENT_KINDS.map(kind => [kind, 0])),
  };

  const idByPlayer = new Map();
  for (const a of plan.accounts.values()) {
    const before = existing.get(a.womPlayerId);
    if (!before) counts.accountsNew += 1;
    else if (before.rsn !== a.rsn || (a.role !== null && before.wom_role !== a.role) || before.status !== a.status) {
      counts.accountsChanged += 1;
      if (before.status === 'active' && a.status === 'left') counts.accountsMarkedLeft += 1;
    }
    const saved = await client.query(
      `insert into accounts (wom_player_id, username, rsn, wom_role, status, wom_joined_at, client_joined_at, wom_data)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (wom_player_id) do update set
         username = excluded.username, rsn = excluded.rsn, wom_role = coalesce(excluded.wom_role, accounts.wom_role),
         status = excluded.status,
         wom_joined_at = coalesce(excluded.wom_joined_at, accounts.wom_joined_at),
         client_joined_at = coalesce(excluded.client_joined_at, accounts.client_joined_at),
         wom_data = excluded.wom_data, synced_at = now()
       returning id`,
      [a.womPlayerId, a.username, a.rsn, a.role, a.status, a.womJoinedAt, a.clientJoinedAt, JSON.stringify(a.data)]
    );
    idByPlayer.set(a.womPlayerId, saved.rows[0].id);
  }

  // Anyone saved as active who is no longer in the group has left.
  const gone = await client.query(
    `update accounts set status = 'left', synced_at = now()
     where status = 'active' and wom_player_id <> all($1::int[]) returning id`,
    [[...plan.accounts.keys()]]
  );
  counts.accountsMarkedLeft += gone.rowCount;
  counts.accountsChanged += gone.rowCount;

  const events = plan.events.filter(e => idByPlayer.has(e.womPlayerId));
  counts.eventsSkipped = plan.events.length - events.length;
  for (let i = 0; i < events.length; i += INSERT_BATCH) {
    const batch = events.slice(i, i + INSERT_BATCH);
    const inserted = await client.query(
      `insert into member_events (account_id, kind, old_value, new_value, data, source, occurred_at)
       select u.account_id, u.kind, u.old_value, u.new_value, u.data::jsonb, 'wom', u.occurred_at
       from unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[])
         as u(account_id, kind, old_value, new_value, data, occurred_at)
       on conflict do nothing
       returning kind`,
      [
        batch.map(e => idByPlayer.get(e.womPlayerId)),
        batch.map(e => e.kind),
        batch.map(e => e.oldValue),
        batch.map(e => e.newValue),
        batch.map(e => JSON.stringify(e.data)),
        batch.map(e => e.occurredAt),
      ]
    );
    for (const row of inserted.rows) counts.events[row.kind] = (counts.events[row.kind] ?? 0) + 1;
  }

  // First join is the earliest of WOM's two dates and the first join event. A former member's
  // leave date is their latest leave event, or when the bot noticed.
  await client.query(
    `update accounts a set
       first_joined_at = least(a.wom_joined_at, a.client_joined_at,
         (select min(e.occurred_at) from member_events e where e.account_id = a.id and e.kind = 'joined')),
       left_at = case when a.status = 'left'
         then coalesce((select max(e.occurred_at) from member_events e where e.account_id = a.id and e.kind = 'left'), a.left_at, now())
       end`
  );
  return counts;
}

// Thrown to roll back a preview's transaction.
class PreviewDone extends Error {
  constructor(counts) {
    super('preview');
    this.counts = counts;
  }
}

let syncRunning = false;

// Reads WOM and, with apply, saves it; without, reports what would change and saves nothing. The
// first run (no accounts yet) reads the whole history; later runs read back from the newest saved
// event. Returns { counts, backfill, truncated }.
async function syncMembers({ apply, groupId, source = womSource(), db = database.getPool(), gapMs, wait } = {}) {
  if (syncRunning) throw new Error('A member data sync is already running');
  syncRunning = true;
  try {
    const backfill = await accountsEmpty(db);
    const newest = backfill ? null : (await db.query("select max(occurred_at) as t from member_events where source = 'wom'")).rows[0].t;
    const newestMs = newest ? new Date(newest).getTime() : null;
    const wom = await readWom(source, {
      groupId,
      activitySince: newestMs && newestMs - ACTIVITY_MARGIN_MS,
      nameChangeSince: newestMs && newestMs - NAME_CHANGE_MARGIN_MS,
      gapMs,
      wait,
    });
    const plan = buildPlan(wom);

    if (apply) {
      const counts = await database.withTransaction(client => applyPlan(client, plan), db);
      return { counts, backfill, truncated: wom.truncated };
    }
    try {
      await database.withTransaction(async client => {
        throw new PreviewDone(await applyPlan(client, plan));
      }, db);
    } catch (err) {
      if (err instanceof PreviewDone) return { counts: err.counts, backfill, truncated: wom.truncated };
      throw err;
    }
  } finally {
    syncRunning = false;
  }
}

async function accountsEmpty(db) {
  return !(await db.query('select exists (select 1 from accounts) as has_accounts')).rows[0].has_accounts;
}

// Compares WOM's current members with the saved active accounts. Reads WOM's group only (one request).
async function verifyMembers({ groupId, source = womSource(), db = database.getPool() } = {}) {
  const details = await source.getGroupDetails(groupId);
  const saved = new Map((await db.query('select wom_player_id, rsn, wom_role, status from accounts')).rows.map(r => [r.wom_player_id, r]));
  const differences = [];
  const current = new Set();
  for (const m of details.memberships) {
    current.add(m.playerId);
    const row = saved.get(m.playerId);
    const label = `${m.player.displayName} (WOM ${m.playerId})`;
    if (!row) differences.push(`${label}: in the WOM group, not saved.`);
    else {
      if (row.status !== 'active') differences.push(`${label}: in the WOM group, saved as ${row.status}.`);
      if (row.wom_role !== m.role) differences.push(`${label}: WOM rank is ${m.role}, saved as ${row.wom_role ?? 'none'}.`);
      if (row.rsn !== m.player.displayName) differences.push(`${label}: saved under the name ${row.rsn}.`);
    }
  }
  for (const [playerId, row] of saved) {
    if (row.status === 'active' && !current.has(playerId)) differences.push(`${row.rsn} (WOM ${playerId}): saved as active, not in the WOM group.`);
  }
  return { differences, members: details.memberships.length };
}

// Counts for /memberdata status.
async function memberDataStatus(db = database.getPool()) {
  const accounts = (await db.query(`select
    count(*) as total,
    count(*) filter (where status = 'active') as active,
    count(*) filter (where status = 'left') as left_group,
    count(*) filter (where member_id is not null) as linked,
    max(synced_at) as synced_at
    from accounts`)).rows[0];
  const events = (await db.query(`select kind, count(*) as n, max(occurred_at) as newest
    from member_events where account_id is not null group by kind order by kind`)).rows;
  return {
    accounts: {
      total: Number(accounts.total), active: Number(accounts.active), left: Number(accounts.left_group),
      linked: Number(accounts.linked), syncedAt: accounts.synced_at ? new Date(accounts.synced_at) : null,
    },
    events: events.map(r => ({ kind: r.kind, count: Number(r.n), newest: r.newest ? new Date(r.newest) : null })),
  };
}

// Minutes between automatic syncs (MEMBER_SYNC_INTERVAL_MINUTES, default 60). 0 means manual only.
function syncIntervalMinutes() {
  const minutes = intEnv('MEMBER_SYNC_INTERVAL_MINUTES', 60);
  return minutes < 0 ? 60 : minutes;
}

// Syncs on a timer. Does nothing until the first sync has been run by hand with /memberdata, so
// the first full read is always checked by a person. Returns a function that stops it.
function startMemberSync() {
  const groupId = Number(process.env.WOM_GROUP_ID);
  const minutes = syncIntervalMinutes();
  if (!databaseConfigured() || !groupId || minutes === 0) return () => {};

  let announced = false;
  const run = async () => {
    try {
      if (await accountsEmpty(database.getPool())) {
        if (!announced) console.log('[MemberSync] Waiting for the first /memberdata sync before syncing automatically');
        announced = true;
        return;
      }
      const { counts, truncated } = await syncMembers({ apply: true, groupId });
      const events = Object.values(counts.events).reduce((a, b) => a + b, 0);
      console.log(`[MemberSync] Synced: ${counts.accountsNew} new and ${counts.accountsChanged} changed accounts, ${events} new events${truncated ? ' (stopped at the page limit)' : ''}`);
    } catch (err) {
      console.error('[MemberSync] Automatic sync failed:', err.message);
    }
  };
  const first = setTimeout(run, 60_000);
  first.unref();
  const timer = setInterval(run, minutes * 60_000);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

module.exports = {
  syncMembers, verifyMembers, memberDataStatus, startMemberSync, syncIntervalMinutes,
  readWom, buildPlan, applyPlan,
};
