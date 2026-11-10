const database = require('./database');
const { databaseConfigured } = require('./commandAvailability');

// Cap on one member's total, so totals stay far inside Number.MAX_SAFE_INTEGER (about 9e15).
const MAX_TOTAL_GP = 10_000_000_000_000;

// Builds the storage functions on top of getDb() (a pg Pool or anything with connect/query).
function createStore(getDb) {
  const transaction = fn => database.withTransaction(fn, getDb());
  const query = (sql, params) => getDb().query(sql, params);

  // Upserts the member. A name different from the last logged one is added to member_names, and
  // joinedAt (a Date, when known) opens a stay if the member has none open.
  async function touchMember(client, { discordId, displayName, joinedAt = null }) {
    await client.query(
      `insert into members (discord_id, display_name) values ($1, $2)
       on conflict (discord_id) do update set display_name = excluded.display_name, updated_at = now()`,
      [discordId, displayName]
    );
    await client.query(
      `insert into member_names (discord_id, display_name)
       select $1::text, $2::text
       where $2::text is distinct from
         (select display_name from member_names where discord_id = $1 order by id desc limit 1)`,
      [discordId, displayName]
    );
    if (joinedAt) {
      await client.query(
        `insert into member_stays (discord_id, joined_at)
         select $1::text, $2::timestamptz
         where not exists (
           select 1 from member_stays where discord_id = $1 and (left_at is null or joined_at = $2::timestamptz)
         )`,
        [discordId, joinedAt]
      );
    }
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

  // Saves a display name the leaderboard found on the server. Only members already stored.
  async function updateDisplayName({ discordId, displayName }) {
    return transaction(async client => {
      const changed = await client.query(
        'update members set display_name = $2, updated_at = now() where discord_id = $1 and display_name <> $2',
        [discordId, displayName]
      );
      if (!changed.rowCount) return false;
      await client.query(
        `insert into member_names (discord_id, display_name)
         select $1::text, $2::text
         where $2::text is distinct from
           (select display_name from member_names where discord_id = $1 order by id desc limit 1)`,
        [discordId, displayName]
      );
      return true;
    });
  }

  // A member joined the server (or rejoined).
  async function recordJoin({ discordId, displayName, joinedAt }) {
    return transaction(client => touchMember(client, { discordId, displayName, joinedAt: joinedAt ?? new Date() }));
  }

  // A member left the server. Closes their open stay, if they have one.
  async function recordLeave({ discordId }) {
    await query(
      'update member_stays set left_at = greatest(now(), joined_at) where discord_id = $1 and left_at is null',
      [discordId]
    );
  }

  // A member's display name changed on the server.
  async function recordNameChange({ discordId, displayName, joinedAt }) {
    return transaction(client => touchMember(client, { discordId, displayName, joinedAt }));
  }

  // Brings the member tables in line with the server's current members (an array of
  // { discordId, displayName, joinedAt }): stores new members, names and joins, and closes the
  // stay of anyone stored as present who is gone. Does nothing for an empty roster.
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
        `insert into member_names (discord_id, display_name)
         select u.id, u.name from unnest($1::text[], $2::text[]) as u(id, name)
         where u.name is distinct from
           (select n.display_name from member_names n where n.discord_id = u.id order by n.id desc limit 1)`,
        [ids, names]
      );
      await client.query(
        `insert into member_stays (discord_id, joined_at)
         select u.id, u.at from unnest($1::text[], $2::timestamptz[]) as u(id, at)
         where u.at is not null and not exists (
           select 1 from member_stays s where s.discord_id = u.id and (s.left_at is null or s.joined_at = u.at)
         )`,
        [ids, joined]
      );
      const left = await client.query(
        `update member_stays set left_at = greatest(now(), joined_at)
         where left_at is null and discord_id <> all($1::text[])`,
        [ids]
      );
      return { members: roster.length, left: left.rowCount };
    });
  }

  return {
    touchMember,
    getDonations,
    changeDonation,
    getPetCatalog,
    addPetToCatalog,
    getMemberPets,
    changeMemberPets,
    updateDisplayName,
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
