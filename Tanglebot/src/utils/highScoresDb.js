const database = require('./database');
const { databaseConfigured } = require('./commandAvailability');

// Cap on one member's total, so totals stay far inside Number.MAX_SAFE_INTEGER (about 9e15).
const MAX_TOTAL_GP = 10_000_000_000_000;

// The member's latest server_joined or server_left event (their kind says whether they are in).
const LAST_STAY_KIND = `(
  select e.kind from member_events e
  where e.member_id = $1 and e.kind in ('server_joined', 'server_left')
  order by e.occurred_at desc, e.id desc limit 1
)`;

// $1 member, $2 name: records a name different from the last one recorded.
const NAME_EVENT_SQL = `
  insert into member_events (member_id, kind, old_value, new_value, source, occurred_at)
  select $1::text, 'display_name_changed', last.name, $2::text, 'discord', now()
  from (select (
    select e.new_value from member_events e
    where e.member_id = $1 and e.kind = 'display_name_changed'
    order by e.occurred_at desc, e.id desc limit 1
  ) as name) last
  where $2::text is distinct from last.name
  on conflict do nothing`;

// $1 member, $2 join time: records a join unless the member is already recorded as in the server.
// A join is never dated before the leave it follows, so it always counts as the latest event.
const JOIN_EVENT_SQL = `
  insert into member_events (member_id, kind, source, occurred_at)
  select $1::text, 'server_joined', 'discord', greatest($2::timestamptz, last.at)
  from (select
    (select e.kind from member_events e where e.member_id = $1 and e.kind in ('server_joined', 'server_left')
      order by e.occurred_at desc, e.id desc limit 1) as kind,
    (select e.occurred_at from member_events e where e.member_id = $1 and e.kind in ('server_joined', 'server_left')
      order by e.occurred_at desc, e.id desc limit 1) as at
  ) last
  where last.kind is distinct from 'server_joined'
  on conflict do nothing`;

// $1 member: records a leave if the member is recorded as in the server.
const LEAVE_EVENT_SQL = `
  insert into member_events (member_id, kind, source, occurred_at)
  select $1::text, 'server_left', 'discord', greatest(now(), (
    select max(e.occurred_at) from member_events e where e.member_id = $1 and e.kind = 'server_joined'
  ))
  where ${LAST_STAY_KIND} = 'server_joined'
  on conflict do nothing`;

// Builds the storage functions on top of getDb() (a pg Pool or anything with connect/query).
function createStore(getDb) {
  const transaction = fn => database.withTransaction(fn, getDb());
  const query = (sql, params) => getDb().query(sql, params);

  // Upserts the member. A name different from the last one recorded adds a display_name_changed
  // event, and joinedAt (a Date, when known) adds a server_joined event unless they are already in.
  async function touchMember(client, { discordId, displayName, joinedAt = null }) {
    await client.query(
      `insert into members (discord_id, display_name) values ($1, $2)
       on conflict (discord_id) do update set display_name = excluded.display_name, updated_at = now()`,
      [discordId, displayName]
    );
    await client.query(NAME_EVENT_SQL, [discordId, displayName]);
    if (joinedAt) await client.query(JOIN_EVENT_SQL, [discordId, joinedAt]);
  }

  // ── Donations ──────────────────────────────────────────────────────────────

  async function getDonations() {
    const { rows } = await query(
      `select m.discord_id, m.display_name, d.total_gp
       from donations d join members m on m.discord_id = d.discord_id`
    );
    return rows.map(r => ({ discordId: r.discord_id, displayName: r.display_name, donated: Number(r.total_gp) }));
  }

  // Adds or removes amount (a positive integer) from a member's total, never going below 0.
  // action is 'add' or 'remove'. Returns { currentAmount, newAmount, clamped, noDonationsLogged }.
  async function changeDonation({ discordId, displayName, joinedAt, amount, action, byDiscordId }) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Amount must be a positive whole number');

    return transaction(async client => {
      if (action === 'add') {
        await touchMember(client, { discordId, displayName, joinedAt });
        await client.query(
          'insert into donations (discord_id, total_gp) values ($1, 0) on conflict (discord_id) do nothing',
          [discordId]
        );
      }
      const found = await client.query('select total_gp from donations where discord_id = $1 for update', [discordId]);
      const currentAmount = found.rows.length ? Number(found.rows[0].total_gp) : 0;

      if (action === 'remove' && currentAmount === 0) {
        return { currentAmount, newAmount: currentAmount, clamped: false, noDonationsLogged: true };
      }

      let newAmount = action === 'add' ? currentAmount + amount : currentAmount - amount;
      const clamped = newAmount < 0;
      if (clamped) newAmount = 0;
      if (newAmount > MAX_TOTAL_GP) {
        throw new Error(`That would take the total over ${MAX_TOTAL_GP.toLocaleString('en-US')} GP, which is probably a typo.`);
      }

      if (action === 'remove') await touchMember(client, { discordId, displayName, joinedAt });
      await client.query('update donations set total_gp = $2 where discord_id = $1', [discordId, newAmount]);
      await client.query(
        `insert into donation_log (discord_id, change_gp, total_after, by_discord_id, source)
         values ($1, $2, $3, $4, 'command')`,
        [discordId, newAmount - currentAmount, newAmount, byDiscordId]
      );
      return { currentAmount, newAmount, clamped, noDonationsLogged: false };
    });
  }

  // ── Pets ───────────────────────────────────────────────────────────────────

  // The pet catalog in display order.
  async function getPetCatalog() {
    const { rows } = await query('select key, name, emoji_id from pets order by sort_order, key');
    return rows.map(r => ({ key: r.key, name: r.name, emojiId: r.emoji_id || '' }));
  }

  // Adds a pet to the end of the catalog.
  async function addPetToCatalog({ key, name, emojiId }) {
    await query(
      `insert into pets (key, name, emoji_id, sort_order)
       values ($1, $2, $3, (select coalesce(max(sort_order), 0) + 1 from pets))`,
      [key, name, emojiId || null]
    );
  }

  // Members with at least one pet, with their pet keys (in no particular order).
  async function getMemberPets() {
    const { rows } = await query(
      `select m.discord_id, m.display_name, array_agg(mp.pet_key) as pet_keys
       from members m join member_pets mp on mp.discord_id = m.discord_id
       group by m.discord_id, m.display_name`
    );
    return rows.map(r => ({ discordId: r.discord_id, displayName: r.display_name, petKeys: r.pet_keys }));
  }

  // Adds ('add') or removes ('remove') petKeys for a member, logging each pet actually changed.
  // Returns { applied, skipped, petKeys } (keys changed, keys left alone, keys owned afterwards).
  // Nothing is written when no pet changes.
  async function changeMemberPets({ discordId, displayName, joinedAt, petKeys, action, byDiscordId }) {
    return transaction(async client => {
      let applied;
      if (action === 'add') {
        const owned = await client.query('select pet_key from member_pets where discord_id = $1', [discordId]);
        const ownedKeys = new Set(owned.rows.map(r => r.pet_key));
        const missing = petKeys.filter(k => !ownedKeys.has(k));
        applied = [];
        if (missing.length) {
          await touchMember(client, { discordId, displayName, joinedAt });
          const added = await client.query(
            `insert into member_pets (discord_id, pet_key, added_by)
             select $1, k, $3 from unnest($2::text[]) as k
             on conflict (discord_id, pet_key) do nothing
             returning pet_key`,
            [discordId, missing, byDiscordId]
          );
          applied = added.rows.map(r => r.pet_key);
        }
      } else {
        const removed = await client.query(
          'delete from member_pets where discord_id = $1 and pet_key = any($2::text[]) returning pet_key',
          [discordId, petKeys]
        );
        applied = removed.rows.map(r => r.pet_key);
        if (applied.length) await touchMember(client, { discordId, displayName, joinedAt });
      }

      if (applied.length) {
        await client.query(
          `insert into pet_log (discord_id, pet_key, action, by_discord_id)
           select $1, k, $3, $4 from unnest($2::text[]) as k`,
          [discordId, applied, action, byDiscordId]
        );
      }
      const now = await client.query('select pet_key from member_pets where discord_id = $1', [discordId]);
      return {
        applied: petKeys.filter(k => applied.includes(k)),
        skipped: petKeys.filter(k => !applied.includes(k)),
        petKeys: now.rows.map(r => r.pet_key),
      };
    });
  }

  // ── Members ────────────────────────────────────────────────────────────────

  // Records milestones ({ kind, oldValue, newValue, data }) for a member, dated now. byDiscordId is
  // who made the change that caused them.
  async function recordMilestones(discordId, milestones, byDiscordId = null) {
    for (const m of milestones) {
      await query(
        `insert into member_events (member_id, kind, old_value, new_value, data, source, occurred_at)
         values ($1, $2, $3, $4, $5, 'bot', now())
         on conflict do nothing`,
        [discordId, m.kind, m.oldValue, m.newValue, JSON.stringify({ ...m.data, by: byDiscordId })]
      );
    }
  }

  // Saves a display name the leaderboard found on the server. Only members already stored.
  async function updateDisplayName({ discordId, displayName }) {
    return transaction(async client => {
      const changed = await client.query(
        'update members set display_name = $2, updated_at = now() where discord_id = $1 and display_name <> $2',
        [discordId, displayName]
      );
      if (!changed.rowCount) return false;
      await client.query(NAME_EVENT_SQL, [discordId, displayName]);
      return true;
    });
  }

  // A member joined the server (or rejoined).
  async function recordJoin({ discordId, displayName, joinedAt }) {
    return transaction(client => touchMember(client, { discordId, displayName, joinedAt: joinedAt ?? new Date() }));
  }

  // A member left the server: a server_left event, if they were recorded as in it.
  async function recordLeave({ discordId }) {
    await query(LEAVE_EVENT_SQL, [discordId]);
  }

  // A member's display name changed on the server.
  async function recordNameChange({ discordId, displayName, joinedAt }) {
    return transaction(client => touchMember(client, { discordId, displayName, joinedAt }));
  }

  // Brings the member tables in line with the server's current members (an array of
  // { discordId, displayName, joinedAt }): stores new members, name changes and joins, and records
  // a leave for anyone recorded as in the server who is gone. Does nothing for an empty roster.
  async function syncRoster(roster) {
    if (!roster.length) return { members: 0, left: 0 };
    const ids = roster.map(m => m.discordId);
    const names = roster.map(m => m.displayName);
    const joined = roster.map(m => m.joinedAt ?? null);
    return transaction(async client => {
      await client.query(
        `insert into members (discord_id, display_name)
         select * from unnest($1::text[], $2::text[])
         on conflict (discord_id) do update set display_name = excluded.display_name, updated_at = now()
         where members.display_name is distinct from excluded.display_name`,
        [ids, names]
      );
      await client.query(
        `insert into member_events (member_id, kind, old_value, new_value, source, occurred_at)
         select u.id, 'display_name_changed', last.name, u.name, 'discord', now()
         from unnest($1::text[], $2::text[]) as u(id, name)
         left join lateral (
           select e.new_value as name from member_events e
           where e.member_id = u.id and e.kind = 'display_name_changed'
           order by e.occurred_at desc, e.id desc limit 1
         ) last on true
         where u.name is distinct from last.name
         on conflict do nothing`,
        [ids, names]
      );
      await client.query(
        `insert into member_events (member_id, kind, source, occurred_at)
         select u.id, 'server_joined', 'discord', greatest(u.at, last.at)
         from unnest($1::text[], $2::timestamptz[]) as u(id, at)
         left join lateral (
           select e.kind, e.occurred_at as at from member_events e
           where e.member_id = u.id and e.kind in ('server_joined', 'server_left')
           order by e.occurred_at desc, e.id desc limit 1
         ) last on true
         where u.at is not null and last.kind is distinct from 'server_joined'
         on conflict do nothing`,
        [ids, joined]
      );
      const left = await client.query(
        `insert into member_events (member_id, kind, source, occurred_at)
         select m.discord_id, 'server_left', 'discord', now()
         from members m
         where m.discord_id <> all($1::text[]) and (
           select e.kind from member_events e
           where e.member_id = m.discord_id and e.kind in ('server_joined', 'server_left')
           order by e.occurred_at desc, e.id desc limit 1
         ) = 'server_joined'
         on conflict do nothing
         returning member_id`,
        [ids]
      );
      return { members: roster.length, left: left.rowCount };
    });
  }

  return {
    getDonations,
    changeDonation,
    getPetCatalog,
    addPetToCatalog,
    getMemberPets,
    changeMemberPets,
    updateDisplayName,
    recordMilestones,
    recordJoin,
    recordLeave,
    recordNameChange,
    syncRoster,
  };
}

// The store on the shared pool. Commands call these through the module object.
module.exports = {
  createStore,
  MAX_TOTAL_GP,
  usingDatabase: databaseConfigured,
  ...createStore(() => database.getPool()),
};
