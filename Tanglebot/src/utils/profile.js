const { EmbedBuilder } = require('discord.js');
const database = require('./database');
const { discordTimestamp, truncate } = require('./db');
const { DEFAULT_EMBED_COLOR } = require('./embedColor');

// Everything the database knows about one person (by Discord ID) or one OSRS account, and the
// embeds that show it. Read only.

const FIELD_MAX = 1024;
const fmt = n => n.toLocaleString('en-US');
const day = date => discordTimestamp(date, 'D');
const field = (name, lines) => ({ name, value: truncate(lines.join('\n') || '-', FIELD_MAX) });

// WOM's form of a name: lower case, with _ and - as spaces.
function normalizeRsn(name) {
  return String(name).toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
}

const escapeLike = text => text.replace(/[\\%_]/g, '\\$&');

// ── Queries ──────────────────────────────────────────────────────────────────

// A person: overview, previous names, server history, linked accounts, donations and pets.
// Returns null if the person is not stored.
async function getMemberProfile(discordId, db = database.getPool()) {
  const overview = (await db.query('select * from member_overview where discord_id = $1', [discordId])).rows[0];
  if (!overview) return null;
  const rows = async (sql) => (await db.query(sql, [discordId])).rows;
  return {
    overview: {
      discordId: overview.discord_id,
      displayName: overview.display_name,
      donatedGp: Number(overview.donated_gp),
      pets: Number(overview.pets),
      inServer: overview.in_server,
      firstJoinedServerAt: overview.first_joined_server_at,
    },
    nameChanges: await rows(`select old_value, new_value, occurred_at from member_events
      where member_id = $1 and kind = 'display_name_changed' order by occurred_at desc, id desc limit 6`),
    stays: await rows(`select kind, occurred_at from member_events
      where member_id = $1 and kind in ('server_joined', 'server_left') order by occurred_at desc, id desc limit 4`),
    accounts: await rows(`select rsn, wom_role, status, is_main, first_joined_at, left_at from accounts
      where member_id = $1 order by is_main desc, first_joined_at`),
    petNames: (await rows(`select p.name from member_pets mp join pets p on p.key = mp.pet_key
      where mp.discord_id = $1 order by p.sort_order, p.key`)).map(r => r.name),
    lastDonation: (await rows('select max(created_at) as at from donation_log where discord_id = $1'))[0]?.at ?? null,
  };
}

// Accounts matching a name: an exact match (WOM's form), otherwise names containing the text.
async function findAccounts(search, db = database.getPool(), limit = 5) {
  const exact = await db.query('select id, rsn, wom_role, status from accounts where username = $1', [normalizeRsn(search)]);
  if (exact.rows.length) return exact.rows;
  const like = `%${escapeLike(normalizeRsn(search))}%`;
  return (await db.query(
    `select id, rsn, wom_role, status from accounts where username like $1
     order by (status = 'active') desc, rsn limit $2`,
    [like, limit]
  )).rows;
}

// Accounts whose name contains the text, for autocomplete: names starting with it first, then
// current members before former ones. Empty text lists current members.
async function suggestAccounts(text, db = database.getPool()) {
  const typed = escapeLike(normalizeRsn(text));
  return (await db.query(
    `select rsn, wom_role, status from accounts where username like $1
     order by (username like $2) desc, (status = 'active') desc, rsn limit 25`,
    [`%${typed}%`, `${typed}%`]
  )).rows;
}

// An autocomplete choice: the name, with the rank (or "left") beside it to tell similar names apart.
function accountChoice(account) {
  const note = account.status === 'active' ? account.wom_role ?? 'no rank' : 'left';
  return { name: truncate(`${account.rsn} · ${note}`, 100), value: account.rsn };
}

// An account: its row, recent history, and the person it is linked to (if any).
async function getAccountProfile(accountId, db = database.getPool()) {
  const account = (await db.query(
    `select id, wom_player_id, rsn, member_id, wom_role, status, wom_joined_at, client_joined_at, first_joined_at, left_at
     from accounts where id = $1`,
    [accountId]
  )).rows[0];
  if (!account) return null;
  const events = (await db.query(
    `select kind, old_value, new_value, occurred_at from member_events
     where account_id = $1 order by occurred_at desc, id desc limit 60`,
    [accountId]
  )).rows;
  const member = account.member_id
    ? (await db.query('select discord_id, display_name from members where discord_id = $1', [account.member_id])).rows[0] ?? null
    : null;
  return { account, events, member };
}

// ── Embeds ───────────────────────────────────────────────────────────────────

const rankLine = e => `${e.old_value ?? 'new'} → ${e.new_value ?? 'none'} (${day(e.occurred_at)})`;
const nameLine = e => `${e.old_value ?? 'first seen as'} → ${e.new_value} (${day(e.occurred_at)})`;

// tiers: the donation tiers, highest first, each { name, threshold, emoji }; masterThreshold: pets
// needed for Pet Master.
function memberEmbed(profile, { tiers, masterThreshold }) {
  const { overview, nameChanges, stays, accounts, petNames, lastDonation } = profile;

  const discord = [
    overview.inServer === false
      ? `Not in the server${stays[0]?.kind === 'server_left' ? ` (left ${day(stays[0].occurred_at)})` : ''}`
      : overview.inServer ? 'In the server' : 'Server status not known',
  ];
  if (overview.firstJoinedServerAt) discord.push(`First joined: ${day(overview.firstJoinedServerAt)}`);
  const previous = [...new Set(nameChanges.map(e => e.old_value).filter(Boolean))].slice(0, 5);
  if (previous.length) discord.push(`Previous names: ${previous.join(', ')}`);

  const clan = accounts.length
    ? accounts.map(a => `${a.is_main ? '⭐ ' : ''}**${a.rsn}**, ${a.wom_role ?? 'no rank'}${a.status === 'left' ? ' (left the clan)' : ''}`)
    : ['No clan accounts are linked to this person yet.'];

  const tier = tiers.find(t => overview.donatedGp >= t.threshold) ?? null;
  const next = [...tiers].reverse().find(t => t.threshold > overview.donatedGp) ?? null;
  const donations = overview.donatedGp > 0
    ? [
        `**${fmt(overview.donatedGp)}** GP${tier ? `, ${tier.emoji} ${tier.name}` : ''}`,
        ...(next ? [`${fmt(next.threshold - overview.donatedGp)} GP to ${next.name}`] : []),
        ...(lastDonation ? [`Last change: ${day(lastDonation)}`] : []),
      ]
    : ['No donations logged.'];

  const shown = petNames.slice(0, 20).join(', ');
  const pets = overview.pets > 0
    ? [
        `**${overview.pets}** pet${overview.pets === 1 ? '' : 's'}${overview.pets >= masterThreshold ? ', Pet Master' : ''}`,
        `${shown}${petNames.length > 20 ? ` and ${petNames.length - 20} more` : ''}`,
      ]
    : ['No pets logged.'];

  return new EmbedBuilder()
    .setTitle(`Profile: ${overview.displayName}`)
    .setDescription(`<@${overview.discordId}>`)
    .addFields(field('Discord', discord), field('Clan accounts', clan), field('Donations', donations), field('Pets', pets))
    .setFooter({ text: `Discord ID ${overview.discordId}` })
    .setColor(DEFAULT_EMBED_COLOR);
}

function accountEmbed({ account, events, member }) {
  const of = kind => events.filter(e => e.kind === kind);
  const clan = [
    `Rank: ${account.wom_role ?? 'none'}, ${account.status === 'active' ? 'in the clan' : 'left the clan'}`,
  ];
  if (account.first_joined_at) clan.push(`First joined: ${day(account.first_joined_at)}`);
  if (account.wom_joined_at) clan.push(`Added to WOM group: ${day(account.wom_joined_at)}`);
  if (account.client_joined_at) clan.push(`Joined (RuneLite plugin): ${day(account.client_joined_at)}`);
  if (account.status === 'left' && account.left_at) clan.push(`Left: ${day(account.left_at)}`);

  const movements = events.filter(e => e.kind === 'joined' || e.kind === 'left').slice(0, 6)
    .map(e => `${e.kind === 'joined' ? 'Joined' : 'Left'} ${day(e.occurred_at)}`);
  const ranks = of('rank_changed').slice(0, 6).map(rankLine);
  const names = of('name_changed').slice(0, 5).map(nameLine);

  return new EmbedBuilder()
    .setTitle(`Profile: ${account.rsn}`)
    .addFields(
      field('Clan', clan),
      field('Joins and leaves', movements.length ? movements : ['None recorded.']),
      field('Rank history', ranks.length ? ranks : ['None recorded.']),
      field('Name history', names.length ? names : ['No name changes.']),
      field('Discord', member ? [`<@${member.discord_id}> (${member.display_name})`] : ['Not linked to a Discord member yet.'])
    )
    .setFooter({ text: `WOM player ${account.wom_player_id}` })
    .setColor(DEFAULT_EMBED_COLOR);
}

module.exports = {
  normalizeRsn, getMemberProfile, findAccounts, suggestAccounts, accountChoice, getAccountProfile, memberEmbed, accountEmbed,
};
