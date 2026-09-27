const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { WOM_METRICS, findMetric, shortMetricName } = require('../utils/womMetrics');
const { resolveMetricImageUrl, createGroupCompetition } = require('../utils/wiseOldMan');
const { notifyAdminLog } = require('../utils/roleMenu');
const { clearStandingsCache } = require('./weeklycompstats');

const TEMPLAR_ROLE_ID = process.env.TEMPLAR_ROLE_ID;
const DISCORD_GREEN = 0x1a5c2e;

// Metric slots exposed on the command; only the first is required.
const METRIC_OPTION_NAMES = ['metric', 'metric2', 'metric3', 'metric4'];

// Bots can't see a user's timezone, so dates are read as Eastern Time.
const DEFAULT_TIME_ZONE = 'America/New_York';

// "<prefix> <metric>", e.g. "BOTW T3 Gauntlet".
function buildCompTitle(prefix, metric) {
  return `${prefix} ${shortMetricName(metric.value)}`;
}

// A wall-clock date and hour in timeZone (DST included) as a Date.
function zonedTimeToUtc(year, month, day, hour, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, 0, 0);
  if (timeZone === 'UTC') return new Date(utcGuess);

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcGuess)).map(p => [p.type, p.value])
  );
  const asIfLocal = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return new Date(utcGuess - (asIfLocal - utcGuess));
}

// YYYY-MM-DD, YYYY/MM/DD or MM/DD/YYYY, optionally with an hour (24-hour, or with am/pm), read in
// DEFAULT_TIME_ZONE. A ":mm" after the hour is accepted and ignored. Anything else, such as ISO 8601
// with an offset, goes to Date.
const DATE_PATTERNS = [
  { re: /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2})(?::\d{2})?\s*([AaPp][Mm])?)?$/, order: 'ymd' },
  { re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{1,2})(?::\d{2})?\s*([AaPp][Mm])?)?$/, order: 'ymd' },
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2})(?::\d{2})?\s*([AaPp][Mm])?)?$/, order: 'mdy' },
];

// 12am is hour 0 and 12pm is hour 12; without am/pm the hour is 24-hour. Null if out of range.
function normalizeHour(hourStr, meridiem) {
  let hour = Number(hourStr ?? 0);
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour %= 12;
    if (meridiem.toLowerCase() === 'pm') hour += 12;
  }
  return hour <= 23 ? hour : null;
}

// True if the day exists in that month, e.g. false for Feb 31 (which Date would roll into March).
function isRealDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseDateInput(raw) {
  const trimmed = String(raw ?? '').trim();

  for (const { re, order } of DATE_PATTERNS) {
    const m = trimmed.match(re);
    if (!m) continue;
    const [, a, b, c, hourRaw, meridiem] = m;
    const [year, month, day] = (order === 'ymd' ? [a, b, c] : [c, a, b]).map(Number);
    const hour = normalizeHour(hourRaw, meridiem);
    if (hour === null || !isRealDate(year, month, day)) return null;
    return zonedTimeToUtc(year, month, day, hour, DEFAULT_TIME_ZONE);
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildCommandData() {
  const data = new SlashCommandBuilder()
    .setName('weeklycomp')
    .setDescription('Create a Discord event with a linked Wise Old Man competition')
    .addStringOption(o =>
      o.setName('prefix')
        .setDescription('Prefix for the event/competition names, e.g. "BOTW T3" -> "BOTW T3 <metric>"')
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName('start')
        .setDescription('Start date, Eastern Time — YYYY-MM-DD, YYYY/MM/DD, or MM/DD/YYYY (add HH or H[am/pm])')
        .setRequired(true)
    );

  METRIC_OPTION_NAMES.forEach((optName, i) => {
    data.addStringOption(o =>
      o.setName(optName)
        .setDescription(i === 0 ? 'Boss or skill to track for the competition' : 'Another boss or skill to track (optional)')
        .setRequired(i === 0)
        .setAutocomplete(true)
    );
  });

  data.addIntegerOption(o =>
    o.setName('duration')
      .setDescription('How many days the competition runs for (default: 7)')
      .setMinValue(1)
      .setMaxValue(365)
  );

  // Only offered when not set in the bot config.
  if (!process.env.WOM_GROUP_ID) {
    data.addIntegerOption(o =>
      o.setName('group_id')
        .setDescription('WOM group ID (WOM_GROUP_ID is not set in the bot config)')
        .setMinValue(1)
    );
  }
  if (!process.env.WOM_GROUP_VERIFICATION_CODE) {
    data.addStringOption(o =>
      o.setName('verification_code')
        .setDescription('WOM verification code (not set in config) — WARNING: visible to the whole channel')
    );
  }

  return data;
}

module.exports = {
  data: buildCommandData(),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const query = String(focused.value || '').toLowerCase();

    // Don't re-suggest a metric already picked in one of this command's other metric slots.
    const pickedValues = new Set(
      METRIC_OPTION_NAMES
        .filter(optName => optName !== focused.name)
        .map(optName => interaction.options.getString(optName))
        .filter(Boolean)
    );

    const choices = WOM_METRICS
      .filter(m => !pickedValues.has(m.value))
      .filter(m => m.name.toLowerCase().includes(query))
      .slice(0, 25);
    await interaction.respond(choices.map(m => ({ name: m.name, value: m.value })));
  },

  async execute(interaction) {
    if (!interaction.member.roles.cache.has(TEMPLAR_ROLE_ID)) {
      return interaction.reply({ content: 'You need the Templar role to use this command.', flags: MessageFlags.Ephemeral });
    }

    const prefix = interaction.options.getString('prefix', true).trim();
    const metricInputs = METRIC_OPTION_NAMES.map(optName => interaction.options.getString(optName)).filter(Boolean);

    if (!prefix) {
      return interaction.reply({ content: 'Prefix cannot be empty.', flags: MessageFlags.Ephemeral });
    }

    const metrics = [];
    const unknownInputs = [];
    const duplicateNames = [];
    for (const input of metricInputs) {
      const metric = findMetric(input);
      if (!metric) {
        unknownInputs.push(input);
      } else if (metrics.some(m => m.value === metric.value)) {
        duplicateNames.push(metric.name);
      } else {
        metrics.push(metric);
      }
    }

    if (unknownInputs.length > 0) {
      return interaction.reply({
        content: `Unknown boss/skill${unknownInputs.length === 1 ? '' : 's'} "${unknownInputs.join('", "')}". Pick from the autocomplete suggestions.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (duplicateNames.length > 0) {
      return interaction.reply({
        content: `You listed ${duplicateNames.length === 1 ? 'a metric' : 'metrics'} more than once: **${duplicateNames.join(', ')}**. Pick each boss/skill in only one slot.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const startsAt = parseDateInput(interaction.options.getString('start', true));
    const durationDays = interaction.options.getInteger('duration') ?? 7;

    if (!startsAt) {
      return interaction.reply({
        content: 'Could not parse the start date. Use `YYYY-MM-DD`, `YYYY/MM/DD`, or `MM/DD/YYYY` (Eastern Time), optionally with an hour — `HH` (24-hour) or `H` + `am`/`pm`, e.g. `2025-09-20 18` or `2025-09-20 6pm`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // WOM and Discord both reject a start in the past, so catch it before anything is created.
    if (startsAt <= new Date()) {
      return interaction.reply({
        content: `The start time (<t:${Math.floor(startsAt.getTime() / 1000)}:F>) has already passed. Pick a time in the future.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const endsAt = new Date(startsAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

    const groupId = interaction.options.getInteger('group_id') ?? (process.env.WOM_GROUP_ID ? Number(process.env.WOM_GROUP_ID) : null);
    if (!groupId) {
      return interaction.reply({
        content: 'No WOM group ID configured. Set `WOM_GROUP_ID` in the bot config, or pass the `group_id` option.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const groupVerificationCode = interaction.options.getString('verification_code') ?? process.env.WOM_GROUP_VERIFICATION_CODE ?? null;
    if (!groupVerificationCode) {
      return interaction.reply({
        content: 'No WOM group verification code configured. Set `WOM_GROUP_VERIFICATION_CODE` in the bot config, or pass the `verification_code` option.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const metricsLabel = metrics.map(m => m.name).join(', ');
    // The event is named after the first metric; each competition after its own.
    const eventTitle = buildCompTitle(prefix, metrics[0]);

    const confirmEmbed = new EmbedBuilder()
      .setColor(DISCORD_GREEN)
      .setTitle(`Confirm: ${eventTitle}`)
      .setDescription(
        `**Metric${metrics.length === 1 ? '' : 's'}:** ${metricsLabel}\n` +
        `**Starts:** <t:${Math.floor(startsAt.getTime() / 1000)}:F>\n` +
        `**Ends:** <t:${Math.floor(endsAt.getTime() / 1000)}:F>\n` +
        `**Duration:** ${durationDays} day${durationDays === 1 ? '' : 's'}\n\n` +
        `This creates a public Discord event and ${metrics.length === 1 ? 'a Wise Old Man competition' : `${metrics.length} Wise Old Man competitions`}. Confirm?`
      );

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('weeklycomp:confirm').setLabel('Confirm').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('weeklycomp:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
    );

    await interaction.editReply({ embeds: [confirmEmbed], components: [confirmRow] });

    const confirmReply = await interaction.fetchReply();
    let confirmation;
    try {
      confirmation = await confirmReply.awaitMessageComponent({
        filter: i => i.user.id === interaction.user.id,
        time: 60_000,
      });
    } catch {
      return interaction.editReply({ content: 'Confirmation timed out — nothing was created.', embeds: [], components: [] });
    }

    if (confirmation.customId === 'weeklycomp:cancel') {
      return confirmation.update({ content: 'Cancelled — nothing was created.', embeds: [], components: [] });
    }

    await confirmation.update({
      embeds: [EmbedBuilder.from(confirmEmbed).setTitle(`Creating: ${eventTitle}`).setDescription('Creating the competition and event…')],
      components: [],
    });

    console.log(`[weeklycomp] ${interaction.user.tag} creating "${prefix}" (${metrics.map(m => m.value).join(', ')}) ${startsAt.toISOString()} -> ${endsAt.toISOString()} in WOM group ${groupId}`);

    // One WOM competition per metric.
    const created = [];
    for (const metric of metrics) {
      const title = buildCompTitle(prefix, metric);
      try {
        const result = await createGroupCompetition({ title, metric: metric.value, startsAt, endsAt, groupId, groupVerificationCode });
        created.push({ metric, title, competition: result.competition, url: `https://wiseoldman.net/competitions/${result.competition.id}` });
        clearStandingsCache();
      } catch (err) {
        console.error(`[weeklycomp] Failed to create WOM competition for ${metric.name}:`, err);
        if (created.length === 0) {
          return interaction.editReply(`Failed to create the Wise Old Man competition: ${err.message}`);
        }
        const createdLines = created.map(c => `${c.title}: ${c.url}`).join('\n');
        await interaction.editReply(
          `Created ${created.length} of ${metrics.length} Wise Old Man competitions before **${metric.name}** failed: ${err.message}\n\n` +
          `Created so far:\n${createdLines}`
        );
        notifyAdminLog(
          interaction.client,
          '⚠️ /weeklycomp: Partial competition creation',
          `${interaction.user} ran /weeklycomp for **${prefix}** — created ${created.length}/${metrics.length} competitions before **${metric.name}** failed: ${err.message}\n${createdLines}`,
          [],
          0xc0392b
        );
        return;
      }
    }

    const imageUrl = await resolveMetricImageUrl(metrics[0].value);

    const description = [
      eventTitle,
      '',
      ...created.map(c => `${c.title}: ${c.url}`),
    ].join('\n');

    let event;
    try {
      event = await interaction.guild.scheduledEvents.create({
        name: eventTitle,
        scheduledStartTime: startsAt,
        scheduledEndTime: endsAt,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: 'OSRS' },
        description,
        image: imageUrl,
        reason: `Created by /weeklycomp (${interaction.user.tag})`,
      });
    } catch (err) {
      console.error('[weeklycomp] Failed to create Discord event:', err);
      const createdLines = created.map(c => `${c.title}: ${c.url}`).join('\n');
      await interaction.editReply(
        `Created the Wise Old Man competition${created.length === 1 ? '' : 's'}, but failed to create the Discord event: ${err.message}\n\n` +
        `${createdLines}`
      );
      notifyAdminLog(
        interaction.client,
        '⚠️ /weeklycomp: Discord event failed',
        `${interaction.user} created the WOM competition${created.length === 1 ? '' : 's'} for **${prefix}** (${metricsLabel}) but the Discord event failed to create: ${err.message}\n${createdLines}`,
        [],
        0xc0392b
      );
      return;
    }

    console.log(`[weeklycomp] Created event ${event.id} and WOM competition${created.length === 1 ? '' : 's'} ${created.map(c => c.competition.id).join(', ')}`);

    const embed = new EmbedBuilder()
      .setColor(DISCORD_GREEN)
      .setTitle(`📅 ${eventTitle}`)
      .setDescription(
        `**Metric${metrics.length === 1 ? '' : 's'}:** ${metricsLabel}\n` +
        `**Starts:** <t:${Math.floor(startsAt.getTime() / 1000)}:F>\n` +
        `**Ends:** <t:${Math.floor(endsAt.getTime() / 1000)}:F>\n\n` +
        `[Discord Event](${event.url})\n` +
        created.map(c => `[${c.title}](${c.url})`).join('\n')
      )
      .setImage(imageUrl)
      .setFooter({ text: `Created by ${interaction.user.username}` });

    await interaction.editReply({ embeds: [embed] });

    notifyAdminLog(
      interaction.client,
      '📅 Event Created',
      `${interaction.user} created **${prefix}** (${metricsLabel}) via /weeklycomp.\n[Discord Event](${event.url})\n${created.map(c => `[${c.title}](${c.url})`).join('\n')}`,
      [],
      DISCORD_GREEN
    );
  },
};
