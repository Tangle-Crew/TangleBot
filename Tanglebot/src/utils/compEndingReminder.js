const { EmbedBuilder } = require('discord.js');
const { MetricProps } = require('@wise-old-man/utils');
const { getAllGroupCompetitions, updateAllGroupMembers, getCompetitionDetails } = require('./wiseOldMan');
const { readJson, writeJson, truncate } = require('./db');

// Cron-style schedule, equivalent to `*/15 * * * *`: checks run on the clock at :00, :15, :30
// and :45 rather than every 15 minutes from whenever the bot started.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
// A competition gets its reminder on the first check within this long of it ending. Already
// reminded competitions are skipped by the later checks inside the window.
const REMINDER_WINDOW_MS = 60 * 60 * 1000;
// update all only queues the updates — give WOM a few minutes to work through them before
// reading the standings, so the top 3 reflect everyone's fresh stats.
const UPDATE_SETTLE_MS = 3 * 60 * 1000;
// Reminded competitions are forgotten this long after they end, keeping the data file small.
const REMINDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const REMINDERS_FILE = 'comp-ending-reminders.json';

const REMINDER_COLOR = 0xe67e22;
const MAX_EMBED_FIELDS = 25;
const PER_COMP_TOP = 3;
const COMBINED_TOP = 5;
const RANK_LABELS = ['🥇', '🥈', '🥉', '4.', '5.'];

// Comps are only combined with others of the same category — bossing KC is never summed with
// skilling XP.
const CATEGORY_LABELS = {
  boss: 'Bossing',
  skill: 'Skilling',
  activity: 'Activities',
  computed: 'Efficiency',
};

const MEASURE_UNITS = {
  experience: 'xp',
  kills: 'kc',
  score: 'score',
  value: '',
};

function compConfig() {
  return {
    groupId: process.env.WOM_GROUP_ID ? Number(process.env.WOM_GROUP_ID) : null,
    verificationCode: process.env.WOM_GROUP_VERIFICATION_CODE || null,
    adminLogChannelId: process.env.ADMIN_LOG_CHANNEL_ID || null,
    templarRoleId: process.env.TEMPLAR_ROLE_ID || null,
  };
}

function metricCategory(metric) {
  return MetricProps[metric]?.type ?? 'other';
}

function formatAmount(amount, metric) {
  const unit = MEASURE_UNITS[MetricProps[metric]?.measure] ?? '';
  return `${Math.round(amount).toLocaleString('en-US')}${unit ? ` ${unit}` : ''}`;
}

function formatStandings(rows, metric) {
  if (rows.length === 0) return 'No progress yet.';
  return rows
    .map((row, i) => `${RANK_LABELS[i]} **${row.name}** — ${formatAmount(row.gained, metric)}`)
    .join('\n');
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

function discordTimestamp(date, style) {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;
}

function buildReminderEmbed(results, updateStatus) {
  const endsAtList = [...new Set(results.map(r => discordTimestamp(r.competition.endsAt, 'R')))];
  const embed = new EmbedBuilder()
    .setColor(REMINDER_COLOR)
    .setTitle(`⏰ WOM Competition${results.length === 1 ? '' : 's'} Ending Soon`)
    .setDescription(truncate(
      `${results.length === 1 ? 'This competition ends' : `These ${results.length} competitions end`} ${endsAtList.join(' / ')} — time to make the announcement!\n\n` +
      results.map(r => `• [${r.competition.title}](${competitionUrl(r.competition.id)})`).join('\n') +
      `\n\n${updateStatus}`,
      4096
    ))
    .setTimestamp();

  const fields = [];

  for (const r of results) {
    const value = r.error
      ? `⚠️ Couldn't load standings: ${r.error}`
      : formatStandings(r.ranked.slice(0, PER_COMP_TOP), r.competition.metric);
    fields.push({
      name: truncate(`🏆 ${r.competition.title} — Top ${PER_COMP_TOP}`, 256),
      value: truncate(value, 1024),
    });
  }

  // Combined leaderboard per category, only where that category has more than one comp to add up.
  const byCategory = new Map();
  for (const r of results) {
    if (r.error) continue;
    const category = metricCategory(r.competition.metric);
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(r);
  }

  for (const [category, group] of byCategory) {
    if (group.length < 2) continue;
    const totals = new Map();
    for (const r of group) {
      for (const row of r.ranked) {
        const entry = totals.get(row.id) ?? { name: row.name, gained: 0 };
        entry.gained += row.gained;
        totals.set(row.id, entry);
      }
    }
    const top = [...totals.values()].sort((a, b) => b.gained - a.gained).slice(0, COMBINED_TOP);
    const label = CATEGORY_LABELS[category] ?? 'Other';
    // All comps in a category share a unit (bosses are all KC, skills all XP), so any one
    // comp's metric formats the combined totals.
    fields.push({
      name: truncate(`🧮 Combined ${label} — Top ${COMBINED_TOP}`, 256),
      value: truncate(
        `*${group.map(r => MetricProps[r.competition.metric]?.name ?? r.competition.metric).join(' + ')}*\n` +
        formatStandings(top, group[0].competition.metric),
        1024
      ),
    });
  }

  embed.addFields(fields.slice(0, MAX_EMBED_FIELDS));
  return embed;
}

async function runUpdateAll(config) {
  if (!config.verificationCode) {
    return { status: '⚠️ Skipped update all — `WOM_GROUP_VERIFICATION_CODE` is not set.', queued: 0 };
  }
  try {
    const result = await updateAllGroupMembers(config.groupId, config.verificationCode);
    const count = result?.count ?? 0;
    console.log(`[CompReminder] Update all queued ${count} player(s) in WOM group ${config.groupId}.`);
    return { status: `🔄 Ran update all — ${count} player${count === 1 ? '' : 's'} queued for an update.`, queued: count };
  } catch (err) {
    console.error('[CompReminder] Update all failed:', err.message);
    return { status: `⚠️ Update all failed: ${err.message}`, queued: 0 };
  }
}

async function checkEndingCompetitions(client, config) {
  const reminded = readJson(REMINDERS_FILE);
  const now = Date.now();

  const competitions = await getAllGroupCompetitions(config.groupId);
  const ending = competitions.filter(c => {
    const startsAt = new Date(c.startsAt).getTime();
    const endsAt = new Date(c.endsAt).getTime();
    return !reminded[c.id] && startsAt <= now && endsAt > now && endsAt - now <= REMINDER_WINDOW_MS;
  });
  if (ending.length === 0) return;

  console.log(`[CompReminder] ${ending.length} competition(s) ending within the hour: ${ending.map(c => c.id).join(', ')}`);

  // One update all covers every ending comp — they're all group comps, so the group's members
  // are their participants.
  const update = await runUpdateAll(config);
  if (update.queued > 0) {
    await new Promise(resolve => setTimeout(resolve, UPDATE_SETTLE_MS));
  }

  const results = [];
  for (const competition of ending) {
    try {
      const details = await getCompetitionDetails(competition.id);
      results.push({ competition, ranked: rankParticipants(details) });
    } catch (err) {
      console.error(`[CompReminder] Failed to load competition ${competition.id}:`, err.message);
      results.push({ competition, ranked: [], error: err.message });
    }
  }

  const channel = await client.channels.fetch(config.adminLogChannelId);
  const ping = config.templarRoleId ? `<@&${config.templarRoleId}> ` : '';
  await channel.send({
    content: `${ping}${results.length === 1 ? 'A WOM competition is' : `${results.length} WOM competitions are`} ending within the hour — please make the announcement.`,
    embeds: [buildReminderEmbed(results, update.status)],
    allowedMentions: { roles: config.templarRoleId ? [config.templarRoleId] : [] },
  });

  // Only recorded once the message is out, so a failed send is retried on the next poll.
  const latest = readJson(REMINDERS_FILE);
  for (const c of ending) latest[c.id] = new Date(c.endsAt).toISOString();
  for (const [id, endsAt] of Object.entries(latest)) {
    if (now - new Date(endsAt).getTime() > REMINDED_RETENTION_MS) delete latest[id];
  }
  writeJson(REMINDERS_FILE, latest);
}

function startCompEndingReminder(client) {
  const config = compConfig();
  if (!config.groupId || !config.adminLogChannelId) {
    console.log('[CompReminder] Disabled: WOM_GROUP_ID or ADMIN_LOG_CHANNEL_ID is missing.');
    return () => {};
  }

  let inFlight = false;
  const tick = async () => {
    // Skips a check that lands while the previous one is still waiting on update all to settle.
    if (inFlight) return;
    inFlight = true;
    try {
      await checkEndingCompetitions(client, config);
    } catch (err) {
      console.error('[CompReminder] Check failed:', err.message);
    } finally {
      inFlight = false;
    }
  };

  // Rescheduled from the clock each time, rather than setInterval, so checks stay pinned to
  // the quarter hour instead of drifting.
  let timer = null;
  const scheduleNext = () => {
    const delay = CHECK_INTERVAL_MS - (Date.now() % CHECK_INTERVAL_MS);
    timer = setTimeout(() => {
      tick();
      scheduleNext();
    }, delay);
  };

  tick();
  scheduleNext();
  return () => clearTimeout(timer);
}

module.exports = { startCompEndingReminder };
