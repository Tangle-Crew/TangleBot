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
const { WOM_METRICS, findMetric } = require('../utils/womMetrics');
const { resolveMetricImageUrl, createGroupCompetition } = require('../utils/wiseOldMan');
const { notifyAdminLog } = require('../utils/roleMenu');

const TEMPLAR_ROLE_ID = process.env.TEMPLAR_ROLE_ID;
const DISCORD_GREEN = 0x1a5c2e;

// Discord doesn't tell bots a user's local timezone, so bare dates/hours are read as Eastern
// Time (the clan's default) rather than UTC.
const DEFAULT_TIME_ZONE = 'America/New_York';

// Converts a wall-clock date/hour as read in `timeZone` to the UTC instant it represents,
// accounting for that zone's offset (including DST) at the given date.
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

// A bare date in YYYY-MM-DD, YYYY/MM/DD, or MM/DD/YYYY — optionally followed by an hour, either
// 24-hour (0-23) or 12-hour with am/pm — has no timezone of its own and is read as a wall-clock
// time in DEFAULT_TIME_ZONE. Anything else (full ISO 8601 with an offset/Z, etc.) already carries
// its own timezone and is passed straight to Date.
// A trailing ":mm" on the hour is tolerated and discarded, rather than falling through to Date's
// own parsing of a bare "date hour:mm" string — which it reads as the bot host's local time.
const DATE_PATTERNS = [
  { re: /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2})(?::\d{2})?\s*([AaPp][Mm])?)?$/, order: 'ymd' },
  { re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{1,2})(?::\d{2})?\s*([AaPp][Mm])?)?$/, order: 'ymd' },
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2})(?::\d{2})?\s*([AaPp][Mm])?)?$/, order: 'mdy' },
];

// 12-hour "12am"/"12pm" follow clock convention (12am = hour 0, 12pm = hour 12); without am/pm,
// the hour is read as-is (24-hour).
function normalizeHour(hourStr, meridiem) {
  let hour = Number(hourStr ?? 0);
  if (meridiem) {
    hour %= 12;
    if (meridiem.toLowerCase() === 'pm') hour += 12;
  }
  return hour;
}

function parseDateInput(raw) {
  const trimmed = String(raw ?? '').trim();

  for (const { re, order } of DATE_PATTERNS) {
    const m = trimmed.match(re);
    if (!m) continue;
    const [, a, b, c, hourRaw, meridiem] = m;
    const [year, month, day] = order === 'ymd' ? [a, b, c] : [c, a, b];
    const hour = normalizeHour(hourRaw, meridiem);
    return zonedTimeToUtc(Number(year), Number(month), Number(day), hour, DEFAULT_TIME_ZONE);
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('weeklycomp')
    .setDescription('Create a Discord event with a linked Wise Old Man competition')
    .addStringOption(o =>
      o.setName('name')
        .setDescription('Event / competition name')
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName('metric')
        .setDescription('Boss or skill to track for the competition')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o.setName('start')
        .setDescription('Start date, Eastern Time — YYYY-MM-DD, YYYY/MM/DD, or MM/DD/YYYY (add HH or H[am/pm])')
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('duration')
        .setDescription('How many days the competition runs for (default: 7)')
        .setMinValue(1)
        .setMaxValue(365)
    )
    .addIntegerOption(o =>
      o.setName('group_id')
        .setDescription('WOM group ID (only needed if WOM_GROUP_ID is not set in the bot config)')
        .setMinValue(1)
    )
    .addStringOption(o =>
      o.setName('verification_code')
        .setDescription('WOM verification code if not set in config — WARNING: visible to the whole channel')
    ),

  async autocomplete(interaction) {
    const query = String(interaction.options.getFocused() || '').toLowerCase();
    const choices = WOM_METRICS.filter(m => m.name.toLowerCase().includes(query)).slice(0, 25);
    await interaction.respond(choices.map(m => ({ name: m.name, value: m.value })));
  },

  async execute(interaction) {
    if (!interaction.member.roles.cache.has(TEMPLAR_ROLE_ID)) {
      return interaction.reply({ content: 'You need the Templar role to use this command.', flags: MessageFlags.Ephemeral });
    }

    const name = interaction.options.getString('name', true).trim();
    const metricInput = interaction.options.getString('metric', true);
    const metric = findMetric(metricInput);

    if (!name) {
      return interaction.reply({ content: 'Event name cannot be empty.', flags: MessageFlags.Ephemeral });
    }
    if (!metric) {
      return interaction.reply({
        content: `Unknown boss/skill "${metricInput}". Pick one from the autocomplete suggestions.`,
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

    const endsAt = new Date(startsAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

    if (endsAt <= new Date()) {
      return interaction.reply({ content: 'The end date (start + duration) must be in the future.', flags: MessageFlags.Ephemeral });
    }

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

    const confirmEmbed = new EmbedBuilder()
      .setColor(DISCORD_GREEN)
      .setTitle(`Confirm: ${name}`)
      .setDescription(
        `**Metric:** ${metric.name}\n` +
        `**Starts:** <t:${Math.floor(startsAt.getTime() / 1000)}:F>\n` +
        `**Ends:** <t:${Math.floor(endsAt.getTime() / 1000)}:F>\n` +
        `**Duration:** ${durationDays} day${durationDays === 1 ? '' : 's'}\n\n` +
        'This creates a public Discord event and a Wise Old Man competition. Confirm?'
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
      embeds: [EmbedBuilder.from(confirmEmbed).setTitle(`Creating: ${name}`).setDescription('Creating the competition and event…')],
      components: [],
    });

    console.log(`[weeklycomp] ${interaction.user.tag} creating "${name}" (${metric.value}) ${startsAt.toISOString()} -> ${endsAt.toISOString()} in WOM group ${groupId}`);

    let competition;
    try {
      const result = await createGroupCompetition({ title: name, metric: metric.value, startsAt, endsAt, groupId, groupVerificationCode });
      competition = result.competition;
    } catch (err) {
      console.error('[weeklycomp] Failed to create WOM competition:', err);
      return interaction.editReply(`Failed to create the Wise Old Man competition: ${err.message}`);
    }

    const competitionUrl = `https://wiseoldman.net/competitions/${competition.id}`;
    const imageUrl = await resolveMetricImageUrl(metric.value);

    const description = [
      name,
      `Track on Wise Old Man: ${competitionUrl}`,
    ].join('\n');

    let event;
    try {
      event = await interaction.guild.scheduledEvents.create({
        name,
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
      await interaction.editReply(
        `Created the Wise Old Man competition, but failed to create the Discord event: ${err.message}\n` +
        `Competition: ${competitionUrl}`
      );
      notifyAdminLog(
        interaction.client,
        '⚠️ /weeklycomp: Discord event failed',
        `${interaction.user} created the WOM competition **${name}** (${metric.name}) but the Discord event failed to create: ${err.message}\n[WOM Competition](${competitionUrl})`,
        [],
        0xc0392b
      );
      return;
    }

    console.log(`[weeklycomp] Created event ${event.id} and WOM competition ${competition.id}`);

    const embed = new EmbedBuilder()
      .setColor(DISCORD_GREEN)
      .setTitle(`📅 ${name}`)
      .setDescription(
        `**Metric:** ${metric.name}\n` +
        `**Starts:** <t:${Math.floor(startsAt.getTime() / 1000)}:F>\n` +
        `**Ends:** <t:${Math.floor(endsAt.getTime() / 1000)}:F>\n\n` +
        `[Discord Event](${event.url}) • [WOM Competition](${competitionUrl})`
      )
      .setImage(imageUrl)
      .setFooter({ text: `Created by ${interaction.user.username}` });

    await interaction.editReply({ embeds: [embed] });

    notifyAdminLog(
      interaction.client,
      '📅 Event Created',
      `${interaction.user} created **${name}** (${metric.name}) via /weeklycomp.\n[Discord Event](${event.url}) • [WOM Competition](${competitionUrl})`,
      [],
      DISCORD_GREEN
    );
  },
};
