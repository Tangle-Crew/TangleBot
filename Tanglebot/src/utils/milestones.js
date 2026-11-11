const database = require('./database');

// Milestones are person events in member_events (source 'bot'):
//   donation_tier_changed  old_value and new_value are the highest tier before and after (empty: none)
//   pet_master_reached / pet_master_lost
// They are written as they happen by the donation and pet commands, and this file also rebuilds
// the earlier ones from donation_log and pet_log.

const SAME_EVENT_WINDOW_MS = 5000;
const INSERT_BATCH = 1000;

// Highest tier a total reaches. tiers are { name, threshold }, highest first.
function tierFor(tiers, total) {
  return tiers.find(t => total >= t.threshold)?.name ?? null;
}

// The donation tier change a new total makes, as a milestone, or null if the tier is the same.
function tierMilestone(tiers, before, after) {
  const oldValue = tierFor(tiers, before);
  const newValue = tierFor(tiers, after);
  return oldValue === newValue ? null : { kind: 'donation_tier_changed', oldValue, newValue, data: { total: after } };
}

// The Pet Master change a new pet count makes, or null.
function masterMilestone(threshold, before, after) {
  if (before < threshold && after >= threshold) return { kind: 'pet_master_reached', oldValue: null, newValue: null, data: { pets: after } };
  if (before >= threshold && after < threshold) return { kind: 'pet_master_lost', oldValue: null, newValue: null, data: { pets: after } };
  return null;
}

// Replays the logs to find milestones. donationRows and petRows are oldest first per member;
// petCounts is each member's pet count now; existing are the milestones already saved. An event
// within a few seconds of a saved one for the same change is the same event and is left out.
function planMilestones({ donationRows, petRows, petCounts, existing, tiers, masterThreshold }) {
  const events = [];
  const notes = { importedBasis: 0, alreadyMasterBeforeLog: 0 };

  const saved = new Map();
  for (const e of existing) {
    const key = `${e.member_id}|${e.kind}|${e.new_value ?? ''}`;
    if (!saved.has(key)) saved.set(key, []);
    saved.get(key).push(new Date(e.occurred_at).getTime());
  }
  const isSaved = (memberId, kind, newValue, at) =>
    (saved.get(`${memberId}|${kind}|${newValue ?? ''}`) ?? []).some(t => Math.abs(t - at.getTime()) <= SAME_EVENT_WINDOW_MS);
  const add = (memberId, milestone, occurredAt) => {
    if (!isSaved(memberId, milestone.kind, milestone.newValue, new Date(occurredAt))) {
      events.push({ memberId, ...milestone, occurredAt: new Date(occurredAt) });
    }
  };

  const previousTier = new Map();
  for (const row of donationRows) {
    const before = previousTier.get(row.discord_id) ?? null;
    const after = tierFor(tiers, Number(row.total_after));
    previousTier.set(row.discord_id, after);
    if (before === after) continue;
    // A tier already held when the sheets were imported has no known date; it is dated to the import.
    const basis = row.source === 'import' ? 'import' : 'log';
    if (basis === 'import') notes.importedBasis += 1;
    add(row.discord_id, { kind: 'donation_tier_changed', oldValue: before, newValue: after, data: { total: Number(row.total_after), basis } }, row.created_at);
  }

  const net = new Map();
  for (const row of petRows) net.set(row.discord_id, (net.get(row.discord_id) ?? 0) + (row.action === 'add' ? 1 : -1));
  const count = new Map();
  for (const row of petRows) {
    if (!count.has(row.discord_id)) {
      const start = Math.max((petCounts.get(row.discord_id) ?? 0) - net.get(row.discord_id), 0);
      count.set(row.discord_id, start);
      if (start >= masterThreshold) notes.alreadyMasterBeforeLog += 1;
    }
    const before = count.get(row.discord_id);
    const after = before + (row.action === 'add' ? 1 : -1);
    count.set(row.discord_id, after);
    const milestone = masterMilestone(masterThreshold, before, after);
    if (milestone) add(row.discord_id, { ...milestone, data: { ...milestone.data, basis: 'log' } }, row.created_at);
  }
  return { events, notes };
}

// Reads the logs and plans the milestones; with apply, saves them. Returns the counts.
async function backfillMilestones({ tiers, masterThreshold, apply, db = database.getPool() }) {
  const rows = async sql => (await db.query(sql)).rows;
  const plan = planMilestones({
    donationRows: await rows('select discord_id, total_after, source, created_at from donation_log order by discord_id, id'),
    petRows: await rows('select discord_id, action, created_at from pet_log order by discord_id, id'),
    petCounts: new Map((await rows('select discord_id, count(*) as n from member_pets group by discord_id')).map(r => [r.discord_id, Number(r.n)])),
    existing: await rows(`select member_id, kind, new_value, occurred_at from member_events
      where kind in ('donation_tier_changed', 'pet_master_reached', 'pet_master_lost')`),
    tiers,
    masterThreshold,
  });

  const counts = { tierChanges: 0, masterReached: 0, masterLost: 0 };
  for (const e of plan.events) {
    if (e.kind === 'donation_tier_changed') counts.tierChanges += 1;
    else if (e.kind === 'pet_master_reached') counts.masterReached += 1;
    else counts.masterLost += 1;
  }

  if (apply) {
    for (let i = 0; i < plan.events.length; i += INSERT_BATCH) {
      const batch = plan.events.slice(i, i + INSERT_BATCH);
      await db.query(
        `insert into member_events (member_id, kind, old_value, new_value, data, source, occurred_at)
         select u.member_id, u.kind, u.old_value, u.new_value, u.data::jsonb, 'bot', u.occurred_at
         from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[])
           as u(member_id, kind, old_value, new_value, data, occurred_at)
         on conflict do nothing`,
        [
          batch.map(e => e.memberId),
          batch.map(e => e.kind),
          batch.map(e => e.oldValue),
          batch.map(e => e.newValue),
          batch.map(e => JSON.stringify(e.data)),
          batch.map(e => e.occurredAt),
        ]
      );
    }
  }
  return { counts, notes: plan.notes, applied: Boolean(apply) };
}

module.exports = { tierMilestone, masterMilestone, planMilestones, backfillMilestones };
