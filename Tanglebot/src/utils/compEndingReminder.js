const { EmbedBuilder } = require('discord.js');
const {
  getAllGroupCompetitions,
  updateAllGroupMembers,
  getCompetitionDetails,
  isCompetitionOngoing,
  rankParticipants,
  competitionUrl,
} = require('./wiseOldMan');
const { CATEGORY_LABELS, metricName, metricCategory, formatAmount } = require('./womMetrics');
const { truncate } = require('./db');

// Checks run on the clock at :00, :15, :30 and :45, like a `*/15 * * * *` cron job.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
// A competition is reminded on the first check within its last hour.
const REMINDER_WINDOW_MS = 60 * 60 * 1000;
// Time for WOM to process the queued updates before the standings are read.
const UPDATE_SETTLE_MS = 5 * 60 * 1000;
// Competitions reminded since the bot started. Files don't survive a deploy on the host, so
// across restarts the admin log channel is the record (see findRemindedInChannel).
const remindedIds = new Set();

// Limits for searching the admin log channel for an earlier reminder.
const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_PAGES = 5;

const REMINDER_TITLE_PREFIX = '⏰ WOM Competition';
const REMINDER_COLOR = 0xe67e22;
const MAX_EMBED_FIELDS = 25;
const PER_COMP_TOP = 3;
const COMBINED_TOP = 5;
const RANK_LABELS = ['🥇', '🥈', '🥉', '4.', '5.'];

function compConfig() {
  return {
    groupId: process.env.WOM_GROUP_ID ? Number(process.env.WOM_GROUP_ID) : null,
    verificationCode: process.env.WOM_GROUP_VERIFICATION_CODE || null,
    adminLogChannelId: process.env.ADMIN_LOG_CHANNEL_ID || null,
    templarRoleId: process.env.TEMPLAR_ROLE_ID || null,
  };
}

function formatStandings(rows, metric) {
  if (rows.length === 0) return 'No progress yet.';
  return rows
    .map((row, i) => `${RANK_LABELS[i]} **${row.name}** — ${formatAmount(row.gained, metric)}`)
    .join('\n');
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

  // Combined top 5 for each category with two or more competitions.
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
    // Every competition in a category shares a unit, so the first one's metric formats the totals.
    fields.push({
      name: truncate(`🧮 Combined ${label} — Top ${COMBINED_TOP}`, 256),
      value: truncate(
        `*${group.map(r => metricName(r.competition.metric)).join(' + ')}*\n` +
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

// IDs of the given competitions this bot has already reminded in the admin log channel, read
// from the competition links in its reminder embeds. Stops at messages older than the window.
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

// Returns the competitions not yet reminded in the channel, remembering the rest.
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
  const ongoing = competitions.filter(c => isCompetitionOngoing(c, now));
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

  // Checked here so a restart doesn't repeat a reminder, and again right before sending in case
  // another bot instance sent it meanwhile (the old and new bot overlap briefly during a deploy).
  const channel = await client.channels.fetch(config.adminLogChannelId);
  let ending = await withoutChannelReminders(channel, client, candidates, 'from before a restart');
  if (ending.length === 0) {
    console.log('[CompReminder] Nothing new to remind about.');
    return;
  }

  console.log(`[CompReminder] ${ending.length} competition(s) need a reminder: ${ending.map(describeCompetition).join(', ')}`);

  // One update all covers every ending competition, since they're all group competitions.
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

  // Marked before sending; a failed send unmarks them so the next check retries.
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
    // The previous check may still be waiting on update all.
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

  // Scheduled from the clock each time so checks stay on the quarter hour.
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
