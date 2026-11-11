const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const database = require('./database');
const { discordTimestamp, truncate } = require('./db');
const { DEFAULT_EMBED_COLOR } = require('./embedColor');

// The donation and pet history from donation_log and pet_log, for one member or the whole clan,
// and the embeds that show it. Read only.

const PAGE_SIZE = 10;
const MONTHS_SHOWN = 6;
const fmt = n => n.toLocaleString('en-US');
const day = date => discordTimestamp(date, 'd');
const name = row => escapeMarkdown(row || 'unknown');
const signed = n => `${n >= 0 ? '+' : '-'}${fmt(Math.abs(n))}`;
const monthLabel = date => new Date(date).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

// ── Queries ──────────────────────────────────────────────────────────────────

// A page of donation changes (newest first), how many there are, the monthly totals, and the
// total now. discordId null means the whole clan.
async function getDonationHistory({ discordId = null, page = 1 } = {}, db = database.getPool()) {
  const where = discordId ? 'where l.discord_id = $1' : '';
  const params = discordId ? [discordId] : [];
  const total = Number((await db.query(`select count(*) as n from donation_log l ${where}`, params)).rows[0].n);
  const rows = (await db.query(
    `select l.change_gp, l.total_after, l.source, l.created_at, m.display_name as member_name, b.display_name as by_name
     from donation_log l
     join members m on m.discord_id = l.discord_id
     left join members b on b.discord_id = l.by_discord_id
     ${where} order by l.id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
  )).rows;
  const months = (await db.query(
    `select date_trunc('month', l.created_at) as month,
            coalesce(sum(l.change_gp) filter (where l.change_gp > 0), 0) as added,
            coalesce(sum(l.change_gp) filter (where l.change_gp < 0), 0) as removed,
            count(*) as changes
     from donation_log l where l.source <> 'import' ${discordId ? 'and l.discord_id = $1' : ''}
     group by 1 order by 1 desc limit ${MONTHS_SHOWN}`,
    params
  )).rows;
  const current = discordId
    ? (await db.query('select total_gp from donations where discord_id = $1', [discordId])).rows[0]
    : (await db.query('select coalesce(sum(total_gp), 0) as total_gp, count(*) filter (where total_gp > 0) as donors from donations')).rows[0];
  return {
    rows: rows.map(r => ({ ...r, change_gp: Number(r.change_gp), total_after: Number(r.total_after) })),
    total,
    months: months.map(r => ({ month: r.month, added: Number(r.added), removed: Number(r.removed), changes: Number(r.changes) })),
    current: current ? Number(current.total_gp) : 0,
    donors: current?.donors === undefined ? null : Number(current.donors),
  };
}

// A page of pet additions and removals (newest first), how many there are, and pets added per month.
async function getPetHistory({ discordId = null, page = 1 } = {}, db = database.getPool()) {
  const where = discordId ? 'where l.discord_id = $1' : '';
  const params = discordId ? [discordId] : [];
  const total = Number((await db.query(`select count(*) as n from pet_log l ${where}`, params)).rows[0].n);
  const rows = (await db.query(
    `select l.action, l.created_at, p.name as pet_name, m.display_name as member_name, b.display_name as by_name
     from pet_log l
     join members m on m.discord_id = l.discord_id
     join pets p on p.key = l.pet_key
     left join members b on b.discord_id = l.by_discord_id
     ${where} order by l.id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
  )).rows;
  const months = (await db.query(
    `select date_trunc('month', l.created_at) as month, count(*) as added
     from pet_log l where l.action = 'add' ${discordId ? 'and l.discord_id = $1' : ''}
     group by 1 order by 1 desc limit ${MONTHS_SHOWN}`,
    params
  )).rows;
  const owned = discordId
    ? Number((await db.query('select count(*) as n from member_pets where discord_id = $1', [discordId])).rows[0].n)
    : Number((await db.query('select count(*) as n from member_pets')).rows[0].n);
  return { rows, total, months: months.map(r => ({ month: r.month, added: Number(r.added) })), owned };
}

// ── Embeds ───────────────────────────────────────────────────────────────────

function pagesOf(total) {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

// subject: the member's name, or null for the whole clan.
function donationEmbed(history, { subject, page }) {
  const lines = history.rows.map(r => {
    const who = subject ? '' : `**${name(r.member_name)}** `;
    const by = r.by_name ? ` by ${name(r.by_name)}` : '';
    const what = r.source === 'import'
      ? `${who}imported at ${fmt(r.total_after)} GP`
      : `${who}${signed(r.change_gp)} → ${fmt(r.total_after)} GP${by}`;
    return `${day(r.created_at)} ${what}${r.source === 'manual' ? ' (manual)' : ''}`;
  });
  const embed = new EmbedBuilder()
    .setTitle(subject ? `Donation history: ${subject}` : 'Donation history: the clan')
    .setDescription([
      subject
        ? `Total now: **${fmt(history.current)}** GP`
        : `Total now: **${fmt(history.current)}** GP from ${fmt(history.donors ?? 0)} donors`,
      '',
      ...(lines.length ? lines : ['No donation changes recorded.']),
    ].join('\n'))
    .setFooter({ text: `Page ${page} of ${pagesOf(history.total)} · ${fmt(history.total)} change${history.total === 1 ? '' : 's'}` })
    .setColor(DEFAULT_EMBED_COLOR);
  if (history.months.length) {
    embed.addFields({
      name: 'By month (changes made by commands)',
      value: truncate(history.months.map(m =>
        `${monthLabel(m.month)}: ${signed(m.added)}${m.removed ? ` / ${signed(m.removed)}` : ''} GP (${m.changes} change${m.changes === 1 ? '' : 's'})`
      ).join('\n'), 1024),
    });
  }
  return embed;
}

function petEmbed(history, { subject, page }) {
  const lines = history.rows.map(r => {
    const who = subject ? '' : `**${name(r.member_name)}** `;
    const by = r.by_name ? ` (by ${name(r.by_name)})` : '';
    return `${day(r.created_at)} ${who}${r.action === 'add' ? '➕' : '➖'} ${name(r.pet_name)}${by}`;
  });
  const embed = new EmbedBuilder()
    .setTitle(subject ? `Pet timeline: ${subject}` : 'Pet timeline: the clan')
    .setDescription([
      subject ? `Pets now: **${fmt(history.owned)}**` : `Pets owned across the clan: **${fmt(history.owned)}**`,
      '',
      ...(lines.length ? lines : ['No pet changes recorded.']),
      ...(subject ? ['', '_Pets owned before the sheets were imported have no date._'] : []),
    ].join('\n'))
    .setFooter({ text: `Page ${page} of ${pagesOf(history.total)} · ${fmt(history.total)} change${history.total === 1 ? '' : 's'}` })
    .setColor(DEFAULT_EMBED_COLOR);
  if (history.months.length) {
    embed.addFields({
      name: 'Pets added by month',
      value: truncate(history.months.map(m => `${monthLabel(m.month)}: ${m.added}`).join('\n'), 1024),
    });
  }
  return embed;
}

module.exports = { pagesOf, getDonationHistory, getPetHistory, donationEmbed, petEmbed };
