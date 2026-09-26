const { EmbedBuilder } = require('discord.js');
const { MetricProps } = require('@wise-old-man/utils');
const { getAllGroupCompetitions, updateAllGroupMembers, getCompetitionDetails } = require('./wiseOldMan');
const { truncate } = require('./db');

// Cron-style schedule, equivalent to `*/15 * * * *`: checks run on the clock at :00, :15, :30
// and :45 rather than every 15 minutes from whenever the bot started.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
// A competition gets its reminder on the first check within this long of it ending. Already
// reminded competitions are skipped by the later checks inside the window.
const REMINDER_WINDOW_MS = 60 * 60 * 1000;
// update all only queues the updates — give WOM a few minutes to work through them before
// reading the standings, so the top 3 reflect everyone's fresh stats.
const UPDATE_SETTLE_MS = 5 * 60 * 1000;
// Competitions reminded while the bot has been running. Nothing written to disk survives a
// redeploy on DigitalOcean App Platform, so across restarts the admin log channel itself is the
// record: see findRemindedInChannel.
const remindedIds = new Set();

// How far back through the admin log channel to look for an earlier reminder. A reminder is only
// ever sent inside a competition's last hour, so the search stops at messages older than that.
const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_PAGES = 5;

const REMINDER_TITLE_PREFIX = '⏰ WOM Competition';
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
    .setTitle(`${REMINDER_TITLE_PREFIX}${results.length === 1 ? '' : 's'} Ending Soon`)
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
    console.warn('[CompReminder] Skipping update all: WOM_GROUP_VERIFICATION_CODE is not set.');
    return { status: '⚠️ Skipped update all — `WOM_GROUP_VERIFICATION_CODE` is not set.', queued: 0 };
  }
  try {
    console.log(`[CompReminder] Running update all on WOM group ${config.groupId}...`);
    const result = await updateAllGroupMembers(config.groupId, config.verificationCode);
    const count = result?.count ?? 0;
    console.log(`[CompReminder] Update all queued ${count} player(s) in WOM group ${config.groupId}.`);
    return { status: `🔄 Ran update all — ${count} player${count === 1 ? '' : 's'} queued for an update.`, queued: count };
  } catch (err) {
    console.error('[CompReminder] Update all failed:', err.message);
    return { status: `⚠️ Update all failed: ${err.message}`, queued: 0 };
  }
}

// IDs of the given competitions that already have a reminder from this bot in the admin log
// channel, found by the WOM competition links in the reminder embed's description.
async function findRemindedInChannel(channel, botUserId, competitions) {
  const ids = new Set(competitions.map(c => c.id));
  const oldestEnd = Math.min(...competitions.map(c => new Date(c.endsAt).getTime()));
  const since = oldestEnd - REMINDER_WINDOW_MS;
  const found = new Set();

  let before;
  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    let messages;
    try {
      messages = await channel.messages.fetch({ limit: HISTORY_PAGE_SIZE, ...(before ? { before } : {}) });
    } catch (err) {
      throw new Error(`could not read the admin log channel's history (the bot needs Read Message History there): ${err.message}`);
    }
    for (const message of messages.values()) {
      if (message.author?.id !== botUserId || message.createdTimestamp < since) continue;
      for (const embed of message.embeds) {
        if (!embed.title?.startsWith(REMINDER_TITLE_PREFIX)) continue;
        for (const match of (embed.description ?? '').matchAll(/wiseoldman\.net\/competitions\/(\d+)/g)) {
          const id = Number(match[1]);
          if (ids.has(id)) found.add(id);
        }
      }
    }
    const oldest = messages.last();
    if (messages.size < HISTORY_PAGE_SIZE || !oldest || oldest.createdTimestamp < since) break;
    before = oldest.id;
  }
  return found;
}

// Drops competitions that already have a reminder in the channel (remembering them so later
// checks skip the lookup) and returns the rest.
async function withoutChannelReminders(channel, client, competitions, when) {
  const found = await findRemindedInChannel(channel, client.user.id, competitions);
  const alreadySent = competitions.filter(c => found.has(c.id));
  if (alreadySent.length > 0) {
    for (const c of alreadySent) remindedIds.add(c.id);
    console.log(`[CompReminder] Found a reminder already in the admin log ${when}, skipping: ${alreadySent.map(describeCompetition).join(', ')}`);
  }
  return competitions.filter(c => !found.has(c.id));
}

async function checkEndingCompetitions(client, config) {
  const now = Date.now();

  console.log(`[CompReminder] Checking WOM group ${config.groupId} for competitions ending within the hour...`);
  const competitions = await getAllGroupCompetitions(config.groupId);
  const ongoing = competitions.filter(c => new Date(c.startsAt).getTime() <= now && new Date(c.endsAt).getTime() > now);
  const inWindow = ongoing.filter(c => new Date(c.endsAt).getTime() - now <= REMINDER_WINDOW_MS);
  const alreadyReminded = inWindow.filter(c => remindedIds.has(c.id));
  const candidates = inWindow.filter(c => !remindedIds.has(c.id));

  console.log(
    `[CompReminder] Found ${competitions.length} competition(s) in the group, ${ongoing.length} ongoing, ` +
    `${inWindow.length} ending within the hour.`
  );
  if (alreadyReminded.length > 0) {
    console.log(`[CompReminder] Already reminded, skipping: ${alreadyReminded.map(describeCompetition).join(', ')}`);
  }
  if (candidates.length === 0) {
    console.log('[CompReminder] Nothing new to remind about.');
    return;
  }

  // Checked before update all (so a restart doesn't re-run it for a comp already reminded) and
  // again right before sending: during a deploy the old and new bot briefly run side by side,
  // and the other one may have sent the reminder while this one was waiting on update all.
  const channel = await client.channels.fetch(config.adminLogChannelId);
  let ending = await withoutChannelReminders(channel, client, candidates, 'from before a restart');
  if (ending.length === 0) {
    console.log('[CompReminder] Nothing new to remind about.');
    return;
  }

  console.log(`[CompReminder] ${ending.length} competition(s) need a reminder: ${ending.map(describeCompetition).join(', ')}`);

  // One update all covers every ending comp — they're all group comps, so the group's members
  // are their participants.
  const update = await runUpdateAll(config);
  if (update.queued > 0) {
    console.log(`[CompReminder] Waiting ${UPDATE_SETTLE_MS / 60000} minutes for WOM to process the updates before reading standings...`);
    await new Promise(resolve => setTimeout(resolve, UPDATE_SETTLE_MS));
    console.log('[CompReminder] Wait finished, loading standings.');
  } else {
    console.log('[CompReminder] No updates queued, loading standings now.');
  }

  const results = [];
  for (const competition of ending) {
    try {
      const details = await getCompetitionDetails(competition.id);
      const ranked = rankParticipants(details);
      const leader = ranked[0] ? `${ranked[0].name} (${formatAmount(ranked[0].gained, competition.metric)})` : 'nobody yet';
      console.log(
        `[CompReminder] Loaded ${describeCompetition(competition)}: ${ranked.length} participant(s) with progress, leader ${leader}.`
      );
      results.push({ competition, ranked });
    } catch (err) {
      console.error(`[CompReminder] Failed to load competition ${competition.id}:`, err.message);
      results.push({ competition, ranked: [], error: err.message });
    }
  }

  ending = await withoutChannelReminders(channel, client, ending, 'sent while this check was waiting');
  const toSend = results.filter(r => ending.includes(r.competition));
  if (toSend.length === 0) {
    console.log('[CompReminder] Nothing left to remind about.');
    return;
  }

  // Remembered before sending so nothing after a successful send can repeat it; a failed send
  // forgets them again so the next check retries.
  for (const c of ending) remindedIds.add(c.id);
  try {
    const ping = config.templarRoleId ? `<@&${config.templarRoleId}> ` : '';
    await channel.send({
      content: `${ping}${toSend.length === 1 ? 'A WOM competition is' : `${toSend.length} WOM competitions are`} ending within the hour — please make the announcement.`,
      embeds: [buildReminderEmbed(toSend, update.status)],
      allowedMentions: { roles: config.templarRoleId ? [config.templarRoleId] : [] },
    });
  } catch (err) {
    for (const c of ending) remindedIds.delete(c.id);
    console.error('[CompReminder] Failed to send the reminder, will retry on the next check:', err.message);
    return;
  }
  console.log(
    `[CompReminder] Sent reminder for ${toSend.length} competition(s) to admin log channel ${config.adminLogChannelId}` +
    `${config.templarRoleId ? ', pinging Templar' : ' (TEMPLAR_ROLE_ID not set, no ping)'}.`
  );
}

function describeCompetition(competition) {
  return `"${competition.title}" (#${competition.id}, ends ${new Date(competition.endsAt).toISOString()})`;
}

function startCompEndingReminder(client) {
  const config = compConfig();
  if (!config.groupId || !config.adminLogChannelId) {
    console.log('[CompReminder] Disabled: WOM_GROUP_ID or ADMIN_LOG_CHANNEL_ID is missing.');
    return () => {};
  }

  console.log(
    `[CompReminder] Enabled for WOM group ${config.groupId}: checking every ${CHECK_INTERVAL_MS / 60000} minutes ` +
    `(:00/:15/:30/:45), reminding ${REMINDER_WINDOW_MS / 60000} minutes before a competition ends.`
  );

  let inFlight = false;
  const tick = async () => {
    // Skips a check that lands while the previous one is still waiting on update all to settle.
    if (inFlight) {
      console.log('[CompReminder] Previous check still running, skipping this one.');
      return;
    }
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
    console.log(`[CompReminder] Next check at ${new Date(Date.now() + delay).toISOString()}.`);
    timer = setTimeout(() => {
      tick();
      scheduleNext();
    }, delay);
  };

  console.log('[CompReminder] Running startup check.');
  tick();
  scheduleNext();
  return () => clearTimeout(timer);
}

module.exports = { startCompEndingReminder };
