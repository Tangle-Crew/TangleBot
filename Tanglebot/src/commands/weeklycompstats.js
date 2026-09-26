const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  escapeMarkdown,
  embedLength,
} = require('discord.js');
const {
  getAllGroupCompetitions,
  getCompetitionDetails,
  isCompetitionOngoing,
  rankParticipants,
  competitionUrl,
} = require('../utils/wiseOldMan');
const { CATEGORY_LABELS, shortMetricName, metricCategory, formatNumber, formatAmount } = require('../utils/womMetrics');
const { DEFAULT_EMBED_COLOR } = require('../utils/embedColor');
const { truncate } = require('../utils/db');
const { notifyAdminLog } = require('../utils/roleMenu');

const PAGE_SIZE = 10;
// WOM allows 20 requests a minute (100 with an API key), and a load costs one plus one per running
// competition, so every run shares one load, refreshed at most this often.
const CACHE_TTL_MS = 5 * 60 * 1000;
// A load that hit an error is retried sooner.
const FAILED_CACHE_TTL_MS = 60 * 1000;
// The WOM client sets no timeout of its own, and every run waits on the shared load.
const REQUEST_TIMEOUT_MS = 20 * 1000;
// Per person, to keep the channel from being flooded.
const USER_COOLDOWN_MS = 60 * 1000;
const ENDING_SOON_MS = 24 * 60 * 60 * 1000;
// Stops a minute before the 15-minute interaction token expires, so removing the buttons still works.
const PAGER_LIFETIME_MS = 14 * 60 * 1000;
const RANK_MEDALS = ['🥇', '🥈', '🥉'];
const MAX_FIELD_CHARS = 1024;
const MAX_EMBED_CHARS = 6000;
const TITLE = '🏆 Weekly Competition Standings';
// RuneScape names are 1-12 letters, numbers, spaces, hyphens and underscores. Enforcing this also
// keeps typed text from becoming a masked link in the bot's embed.
const RSN_PATTERN = /^[a-z0-9 _-]{1,12}$/i;

let cached = null; // { results, upcoming, loadedAt } or { error, loadedAt }
let pending = null;
let cacheGeneration = 0;
const lastRunByUser = new Map();

function discordTimestamp(date, style) {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;
}

function describeCompetition(competition) {
  return `"${competition.title}" (#${competition.id}, ${competition.metric})`;
}

// Brackets are dropped so a title can't break its own link. `<url>` stops Discord adding a link
// preview when the link is in message text rather than an embed.
function competitionLink(competition, { noPreview = false } = {}) {
  const url = competitionUrl(competition.id);
  return `[${escapeMarkdown(competition.title.replace(/[[\]]/g, ''))}](${noPreview ? `<${url}>` : url})`;
}

function categoryLabel(category) {
  return CATEGORY_LABELS[category] ?? 'Other';
}

function totalLabel(metric) {
  return metricCategory(metric) === 'boss' ? 'Total KC' : 'Total gained';
}

// RuneScape treats spaces, underscores and hyphens in names as the same.
function normalizeName(name) {
  return String(name ?? '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)), REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function reportError(interaction, title, detail) {
  return notifyAdminLog(
    interaction.client,
    `⚠️ /weeklycompstats: ${title}`,
    truncate(`${interaction.user} ran /weeklycompstats in ${interaction.channel ?? 'an unknown channel'}.\n\n${detail}`, 4096)
  );
}

// Running competitions with their ranked participants (oldest first), plus the next competition(s)
// to start. One that fails to load is kept with its error so it's still listed.
async function loadStandings(groupId) {
  const now = Date.now();
  console.log(`[WeeklyCompStats] Loading competitions for WOM group ${groupId}...`);
  const all = await withTimeout(getAllGroupCompetitions(groupId), 'Loading the group competitions');
  const running = all
    .filter(c => isCompetitionOngoing(c, now))
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt) || a.id - b.id);
  const future = all.filter(c => new Date(c.startsAt).getTime() > now);
  const nextStart = Math.min(...future.map(c => new Date(c.startsAt).getTime()));
  const upcoming = future.filter(c => new Date(c.startsAt).getTime() === nextStart).sort((a, b) => a.id - b.id);
  console.log(
    `[WeeklyCompStats] Found ${all.length} competition(s) in the group, ${running.length} running, ` +
    `${upcoming.length} starting next${upcoming.length ? ` (${new Date(nextStart).toISOString()})` : ''}.`
  );

  const settled = await Promise.allSettled(
    running.map(c => withTimeout(getCompetitionDetails(c.id), `Loading competition #${c.id}`))
  );
  const results = running.map((competition, i) => {
    const result = settled[i];
    if (result.status === 'rejected') {
      const error = result.reason?.message ?? 'unknown error';
      console.error(`[WeeklyCompStats] Failed to load ${describeCompetition(competition)}:`, error);
      return { competition, ranked: [], total: 0, error };
    }
    const ranked = rankParticipants(result.value);
    const total = ranked.reduce((sum, row) => sum + row.gained, 0);
    const leader = ranked[0] ? `${ranked[0].name} (${formatAmount(ranked[0].gained, competition.metric)})` : 'nobody yet';
    console.log(
      `[WeeklyCompStats] Loaded ${describeCompetition(competition)}: ${ranked.length} player(s) with gains, ` +
      `total ${formatAmount(total, competition.metric)}, leader ${leader}.`
    );
    return { competition, ranked, total };
  });
  return { results, upcoming };
}

// Why a load can't be reused anymore, or null if it still can.
function staleReason(load, now) {
  const failed = load.error || load.results.some(r => r.error);
  if (now - load.loadedAt >= (failed ? FAILED_CACHE_TTL_MS : CACHE_TTL_MS)) return 'expired';
  if (load.error) return null;
  if (load.results.some(r => !isCompetitionOngoing(r.competition, now))) return 'a competition has ended';
  if (load.upcoming.some(c => new Date(c.startsAt).getTime() <= now)) return 'a competition has started';
  return null;
}

// Reuses the last load until it goes stale, and runs arriving mid-load share it. `fresh` is only
// true for the run that started the load, so its errors reach the admin log once.
async function getStandings(groupId) {
  if (cached) {
    const reason = staleReason(cached, Date.now());
    if (!reason) {
      console.log(`[WeeklyCompStats] Using standings loaded ${Math.round((Date.now() - cached.loadedAt) / 1000)}s ago.`);
      return { ...cached, fresh: false };
    }
    console.log(`[WeeklyCompStats] Reloading standings: ${reason}.`);
  }
  if (pending) {
    console.log('[WeeklyCompStats] Waiting on the load already in progress.');
    return { ...(await pending), fresh: false };
  }

  const loadGeneration = cacheGeneration;
  const load = loadStandings(groupId)
    .then(standings => ({ ...standings, loadedAt: Date.now() }))
    .catch(error => ({ error, loadedAt: Date.now() }))
    .then(result => {
      // A load that started before clearStandingsCache() may predate a new competition.
      if (loadGeneration === cacheGeneration) cached = result;
      if (pending === load) pending = null;
      return result;
    });
  pending = load;
  return { ...(await load), fresh: true };
}

// Called by /weeklycomp after creating competitions, so the next run shows them straight away.
function clearStandingsCache() {
  cached = null;
  pending = null;
  cacheGeneration++;
  console.log('[WeeklyCompStats] Cleared saved standings after a competition was created.');
}

// Milliseconds until this user can run the command again, or 0.
function cooldownRemaining(userId, now) {
  for (const [id, at] of lastRunByUser) {
    if (now - at >= USER_COOLDOWN_MS) lastRunByUser.delete(id);
  }
  const last = lastRunByUser.get(userId);
  return last ? last + USER_COOLDOWN_MS - now : 0;
}

function noneRunningMessage(upcoming) {
  if (upcoming.length === 0) return 'No competitions are running right now, and none are scheduled.';
  const { startsAt } = upcoming[0];
  return (
    `No competitions are running right now. Next up, starting ${discordTimestamp(startsAt, 'f')} (${discordTimestamp(startsAt, 'R')}):\n` +
    upcoming.map(c => `• ${competitionLink(c, { noPreview: true })}`).join('\n')
  );
}

// One leaderboard per category. Competitions in a category are summed per player; categories are
// never mixed, so KC and XP stay separate.
function buildBoards(results) {
  const byCategory = new Map();
  for (const r of results) {
    const category = metricCategory(r.competition.metric);
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(r);
  }

  return [...byCategory].map(([category, comps]) => {
    const players = new Map();
    for (const r of comps) {
      for (const row of r.ranked) {
        const entry = players.get(row.id) ?? { id: row.id, name: row.name, total: 0, byComp: new Map() };
        entry.total += row.gained;
        entry.byComp.set(r.competition.id, row.gained);
        players.set(row.id, entry);
      }
    }

    const rows = [...players.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    // Ties share a rank and the next rank skips ahead: 1, 1, 3.
    rows.forEach((row, i) => {
      row.rank = i > 0 && row.total === rows[i - 1].total ? rows[i - 1].rank : i + 1;
    });

    // Competitions in a category share a unit, so the first one's metric formats the totals.
    return { category, comps, rows, metric: comps[0].competition.metric };
  });
}

// The player whose name matches `query` and their placing on each board, or null.
function findPlayer(boards, query) {
  const target = normalizeName(query);
  const match = boards.flatMap(b => b.rows).find(row => normalizeName(row.name) === target);
  if (!match) return null;
  const placements = boards.map(board => {
    const index = board.rows.findIndex(row => row.id === match.id);
    return { board, row: board.rows[index] ?? null, page: index === -1 ? null : Math.floor(index / PAGE_SIZE) };
  });
  return { id: match.id, name: match.name, placements };
}

function playerSummary(player, query) {
  if (!player) return `🔎 **${escapeMarkdown(query)}** has no gains in the running competitions yet.`;
  const parts = player.placements.map(({ board, row }) => {
    const label = categoryLabel(board.category);
    return row ? `#${row.rank} ${label} (${formatAmount(row.total, board.metric)})` : `no ${label} gains yet`;
  });
  return `🔎 **${escapeMarkdown(player.name)}** — ${parts.join(' · ')}`;
}

function formatRow(row, board, { showBreakdown, highlightId }) {
  const label = RANK_MEDALS[row.rank - 1] ?? `**${row.rank}.**`;
  const name = row.id === highlightId ? `__**${escapeMarkdown(row.name)}**__ ◀` : `**${escapeMarkdown(row.name)}**`;
  let line = `${label} ${name} — ${formatAmount(row.total, board.metric)}`;
  if (showBreakdown && board.comps.length > 1) {
    line += '\n└ ' + board.comps
      .map(r => `${shortMetricName(r.competition.metric)} ${formatNumber(row.byComp.get(r.competition.id) ?? 0, r.competition.metric)}`)
      .join(' · ');
  }
  return line;
}

function emptyBoardText(board) {
  const loaded = board.comps.filter(r => !r.error);
  if (loaded.length === 0) return "⚠️ Couldn't load the standings from Wise Old Man.";
  const names = loaded.map(r => `**${escapeMarkdown(r.competition.title)}**`).join(', ');
  return `${names} ${loaded.length === 1 ? 'is' : 'are'} active, but no gains have been recorded yet.`;
}

// A board's rows for one page, split into as many 1024-character fields as needed.
function boardPageFields(board, page, rowOptions) {
  const name = truncate(
    `${board.comps.length > 1 ? '🧮 Combined ' : ''}${categoryLabel(board.category)} — ` +
    board.comps.map(r => shortMetricName(r.competition.metric)).join(' + '),
    256
  );

  if (board.rows.length === 0) return [{ name, value: emptyBoardText(board) }];

  const pageRows = board.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  if (pageRows.length === 0) return [{ name, value: 'No more players on this page.' }];

  const values = [];
  let current = '';
  for (const block of pageRows.map(row => formatRow(row, board, rowOptions))) {
    const candidate = current ? `${current}\n${block}` : block;
    if (candidate.length > MAX_FIELD_CHARS && current) {
      values.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  values.push(current);

  return values.map((value, i) => ({ name: i === 0 ? name : '​', value: truncate(value, MAX_FIELD_CHARS) }));
}

// The looked-up player (if any), each competition with its total and active players (⏰ if it ends
// within a day), combined totals for categories with 2+ competitions, then the start/end times
// (Discord shows them in each viewer's timezone).
function buildSummary(results, boards, playerLine) {
  const now = Date.now();
  const dateKey = r => `${new Date(r.competition.startsAt).getTime()}|${new Date(r.competition.endsAt).getTime()}`;
  const sharedDates = new Set(results.map(dateKey)).size === 1;

  const lines = results.map(r => {
    const { competition } = r;
    const endingSoon = new Date(competition.endsAt).getTime() - now <= ENDING_SOON_MS ? '⏰ ' : '';
    let line;
    if (r.error) line = `⚠️ ${competitionLink(competition)} — couldn't load standings`;
    else if (r.total === 0) line = `${endingSoon}${competitionLink(competition)} — no gains yet`;
    else {
      const participants = competition.participantCount ? `/${competition.participantCount}` : '';
      line = `${endingSoon}${competitionLink(competition)} — ${totalLabel(competition.metric)}: ` +
        `**${formatAmount(r.total, competition.metric)}** · ` +
        `${r.ranked.length}${participants} active`;
    }
    if (!sharedDates) {
      line += `\n└ ${discordTimestamp(competition.startsAt, 'f')} → ${discordTimestamp(competition.endsAt, 'f')} ` +
        `(ends ${discordTimestamp(competition.endsAt, 'R')})`;
    }
    return line;
  });

  const combinedLines = boards
    .filter(b => b.comps.length > 1)
    .map(b => {
      const total = b.comps.reduce((sum, r) => sum + r.total, 0);
      const amount = total > 0 ? `Total combined: **${formatAmount(total, b.metric)}**` : 'no gains yet';
      return `🧮 Combined ${categoryLabel(b.category)} — ${amount}`;
    });

  const sections = [];
  if (playerLine) sections.push(playerLine);
  sections.push(lines.join('\n'));
  if (combinedLines.length > 0) sections.push(combinedLines.join('\n'));
  if (sharedDates) {
    const { startsAt, endsAt } = results[0].competition;
    sections.push(
      `**Started:** ${discordTimestamp(startsAt, 'f')} (${discordTimestamp(startsAt, 'R')})\n` +
      `**Ends:** ${discordTimestamp(endsAt, 'f')} (${discordTimestamp(endsAt, 'R')})`
    );
  }
  return truncate(sections.join('\n\n'), 4096);
}

function pageCount(boards) {
  return Math.max(1, ...boards.map(b => Math.ceil(b.rows.length / PAGE_SIZE)));
}

function composeEmbed(view, page, showBreakdown) {
  const { results, boards, loadedAt, playerLine, highlightId } = view;
  const boardFields = boards.map(b => boardPageFields(b, page, { showBreakdown, highlightId }));
  // Categories sit side by side, unless a board spilled into a second field.
  const inline = boards.length > 1 && boardFields.every(fields => fields.length === 1);
  const players = new Set(boards.flatMap(b => b.rows.map(row => row.id))).size;
  const footer = [
    `Page ${page + 1}/${pageCount(boards)}`,
    `${players} active player${players === 1 ? '' : 's'}`,
    ...(showBreakdown ? [] : ['Per-competition gains hidden to fit']),
    `Wise Old Man data, updated every ${CACHE_TTL_MS / 60000} min`,
  ].join(' · ');

  return new EmbedBuilder()
    .setColor(DEFAULT_EMBED_COLOR)
    .setTitle(TITLE)
    .setDescription(buildSummary(results, boards, playerLine))
    .addFields(boardFields.flat().slice(0, 25).map(f => ({ ...f, inline })))
    .setFooter({ text: footer })
    .setTimestamp(loadedAt);
}

// Drops the per-competition lines if the embed would go over Discord's 6000-character limit.
function buildEmbed(view, page) {
  const embed = composeEmbed(view, page, true);
  if (embedLength(embed.data) <= MAX_EMBED_CHARS) return embed;
  console.warn(`[WeeklyCompStats] Page ${page + 1} is over ${MAX_EMBED_CHARS} characters, hiding per-competition gains.`);
  return composeEmbed(view, page, false);
}

function buildPager(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('weeklycompstats:prev')
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId('weeklycompstats:next')
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1)
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('weeklycompstats')
    .setDescription('Show the leaderboard for the running Wise Old Man competitions')
    .addStringOption(o =>
      o.setName('player')
        .setDescription("Jump to a player's rank (RuneScape name)")
        .setMaxLength(12)
        .setAutocomplete(true)
    ),

  requiredEnv: ['WOM_GROUP_ID'],

  clearStandingsCache,

  // Suggests names from the last load only, so typing never calls WOM.
  async autocomplete(interaction) {
    const query = normalizeName(interaction.options.getFocused());
    const names = new Map();
    for (const r of cached?.results ?? []) {
      for (const row of r.ranked) names.set(row.id, row.name);
    }
    const choices = [...names.values()]
      .filter(name => normalizeName(name).includes(query))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 25);
    await interaction.respond(choices.map(name => ({ name, value: name })));
  },

  async execute(interaction) {
    const playerQuery = interaction.options.getString('player')?.trim() || null;
    console.log(
      `[WeeklyCompStats] ${interaction.user.tag} ran /weeklycompstats in #${interaction.channel?.name ?? interaction.channelId}` +
      `${playerQuery ? ` for player "${playerQuery}"` : ''}.`
    );

    // Checked before the cooldown, so a typo doesn't use it up.
    if (playerQuery && !RSN_PATTERN.test(playerQuery)) {
      console.log(`[WeeklyCompStats] Rejected invalid player name "${playerQuery}".`);
      return interaction.reply({
        content: "That isn't a valid RuneScape name: use up to 12 letters, numbers, spaces, hyphens or underscores.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const now = Date.now();
    const wait = cooldownRemaining(interaction.user.id, now);
    if (wait > 0) {
      console.log(`[WeeklyCompStats] ${interaction.user.tag} is on cooldown for ${Math.ceil(wait / 1000)}s more.`);
      return interaction.reply({
        content: `You can run \`/weeklycompstats\` again ${discordTimestamp(now + wait, 'R')}.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    lastRunByUser.set(interaction.user.id, now);

    try {
      await interaction.deferReply();
    } catch (err) {
      console.error('[WeeklyCompStats] Failed to defer the reply:', err);
      await reportError(interaction, 'Could not reply', `Deferring the reply failed: ${err.message}`);
      return;
    }

    const groupId = Number(process.env.WOM_GROUP_ID);
    const standings = await getStandings(groupId);

    if (standings.error) {
      console.error('[WeeklyCompStats] Failed to load group competitions:', standings.error);
      await interaction.editReply(`Couldn't load the competitions from Wise Old Man: ${standings.error.message}`).catch(() => {});
      if (standings.fresh) {
        await reportError(interaction, 'Could not load competitions', `Loading WOM group ${groupId}'s competitions failed: ${standings.error.message}`);
      }
      return;
    }

    const { results, upcoming } = standings;
    if (results.length === 0) {
      console.log(`[WeeklyCompStats] No competitions running, replying with ${upcoming.length} upcoming.`);
      return interaction.editReply(noneRunningMessage(upcoming));
    }

    const failed = results.filter(r => r.error);
    if (failed.length > 0 && standings.fresh) {
      await reportError(
        interaction,
        `Could not load ${failed.length} of ${results.length} competitions`,
        failed.map(r => `• ${competitionLink(r.competition)}: ${r.error}`).join('\n') +
        '\n\nThe leaderboard was still shown, marking these as not loaded.'
      );
    }

    const boards = buildBoards(results);
    const totalPages = pageCount(boards);
    const player = playerQuery ? findPlayer(boards, playerQuery) : null;
    // Opens on the first page the player appears on.
    let page = player ? Math.min(...player.placements.filter(p => p.row).map(p => p.page)) : 0;
    console.log(
      `[WeeklyCompStats] Built ${boards.length} leaderboard(s) ` +
      `(${boards.map(b => `${b.category}: ${b.comps.length} comp(s), ${b.rows.length} player(s)`).join('; ')}), ${totalPages} page(s)` +
      `${playerQuery ? `; player "${playerQuery}" ${player ? `found, opening page ${page + 1}` : 'not found'}` : ''}.`
    );

    const view = {
      results,
      boards,
      loadedAt: standings.loadedAt,
      playerLine: playerQuery ? playerSummary(player, playerQuery) : null,
      highlightId: player?.id ?? null,
    };
    const render = () => ({
      embeds: [buildEmbed(view, page)],
      components: totalPages > 1 ? [buildPager(page, totalPages)] : [],
    });

    let message;
    try {
      message = await interaction.editReply(render());
    } catch (err) {
      console.error('[WeeklyCompStats] Failed to send the leaderboard:', err);
      await reportError(interaction, 'Could not send the leaderboard', `Sending the leaderboard failed: ${err.message}`);
      await interaction.editReply('Something went wrong showing the leaderboard. The admins have been notified.').catch(() => {});
      return;
    }
    console.log('[WeeklyCompStats] Sent the leaderboard.');
    if (totalPages === 1) return;

    // Timed from when the command was run, since loading may have taken a while. A time of 0 would
    // mean no limit, hence the floor.
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: Math.max(1000, interaction.createdTimestamp + PAGER_LIFETIME_MS - Date.now()),
    });

    collector.on('collect', async (button) => {
      try {
        if (button.user.id !== interaction.user.id) {
          console.log(`[WeeklyCompStats] ${button.user.tag} tried to page ${interaction.user.tag}'s leaderboard.`);
          await button.reply({ content: 'Run `/weeklycompstats` to page through your own copy.', flags: MessageFlags.Ephemeral });
          return;
        }
        page = button.customId === 'weeklycompstats:prev'
          ? Math.max(0, page - 1)
          : Math.min(totalPages - 1, page + 1);
        console.log(`[WeeklyCompStats] ${button.user.tag} moved to page ${page + 1}/${totalPages}.`);
        await button.update(render());
      } catch (err) {
        console.error('[WeeklyCompStats] Page button failed:', err);
        await reportError(interaction, 'Page button failed', `Changing to page ${page + 1}/${totalPages} failed: ${err.message}`);
        if (!button.replied && !button.deferred) {
          await button.reply({ content: "Couldn't change the page. The admins have been notified.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
    });

    collector.on('end', async () => {
      console.log('[WeeklyCompStats] Page buttons expired, removing them.');
      try {
        await interaction.editReply({ components: [] });
      } catch (err) {
        // 10008 Unknown Message: the leaderboard was deleted first.
        if (err?.code === 10008) return;
        console.error('[WeeklyCompStats] Failed to remove the page buttons:', err);
        await reportError(interaction, 'Could not remove page buttons', `Removing the expired page buttons failed: ${err.message}`);
      }
    });
  },
};
