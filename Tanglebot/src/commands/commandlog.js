const { SlashCommandBuilder, MessageFlags, EmbedBuilder, escapeMarkdown } = require('discord.js');
const { hasAnyRole, discordTimestamp, truncate } = require('../utils/db');
const commandLog = require('../utils/commandLog');
const { DEFAULT_EMBED_COLOR } = require('../utils/embedColor');

const PAGE_SIZE = 10;
const STATUS_ICONS = { ok: '✅', error: '❌', denied: '🚫' };

// Coordinator, Templar or Owner. Loaded from the database only, so DATABASE_URL is required.
const allowedRoles = () => [process.env.COORDINATOR_ROLE_ID, process.env.TEMPLAR_ROLE_ID, process.env.OWNER_ROLE_ID];

// One log row as two lines: when, who, what; then how it went.
function formatRow(row) {
  const name = escapeMarkdown(row.discord_name || 'unknown');
  const options = Object.entries(row.options ?? {}).map(([key, value]) => `${key}:${value}`).join(' ');
  const optionsText = options ? ` \`${truncate(options, 80).replace(/`/g, "'")}\`` : '';
  const detail = row.error ? `: ${escapeMarkdown(truncate(row.error, 120))}` : '';
  return [
    `${discordTimestamp(row.created_at, 'f')} · **${name}** (${row.discord_id}) · /${row.command}${optionsText}`,
    `${STATUS_ICONS[row.status] ?? ''} ${row.status}${detail}`,
  ].join('\n');
}

module.exports = {
  requiredEnv: ['DATABASE_URL'],
  requiredEnvAny: ['COORDINATOR_ROLE_ID', 'TEMPLAR_ROLE_ID', 'OWNER_ROLE_ID'],

  data: new SlashCommandBuilder()
    .setName('commandlog')
    .setDefaultMemberPermissions(0)
    .setDescription('Show recent command runs: who ran what, when, and whether it worked')
    .addUserOption(o => o.setName('user').setDescription('Only commands run by this person'))
    .addStringOption(o => o.setName('command').setDescription('Only this command, e.g. migration or donationhighscore add'))
    .addStringOption(o =>
      o
        .setName('status')
        .setDescription('Only runs with this result')
        .addChoices(...commandLog.STATUSES.map(status => ({ name: status, value: status })))
    )
    .addIntegerOption(o => o.setName('page').setDescription('Page number (10 runs a page, newest first)').setMinValue(1)),

  async execute(interaction) {
    if (!hasAnyRole(interaction.member, allowedRoles())) {
      console.log(`[CommandLog] ${interaction.user.tag} was denied /commandlog (needs Coordinator, Templar or Owner)`);
      interaction.commandDenied = true; // for the command log
      return interaction.reply({
        content: 'You need the Coordinator role or higher to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const user = interaction.options.getUser('user');
    const command = interaction.options.getString('command')?.trim().replace(/^\//, '') || null;
    const status = interaction.options.getString('status');
    const page = interaction.options.getInteger('page') ?? 1;

    try {
      const { rows, total } = await commandLog.queryLog({
        discordId: user?.id ?? null,
        command,
        status,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });

      const filters = [
        user && `user ${user.id}`,
        command && `command "${command}"`,
        status && `status ${status}`,
      ].filter(Boolean);
      const filterText = filters.length ? ` matching ${filters.join(', ')}` : '';

      if (total === 0) return interaction.editReply(`No command runs found${filterText}.`);
      const pages = Math.ceil(total / PAGE_SIZE);
      if (page > pages) return interaction.editReply(`There ${pages === 1 ? 'is only 1 page' : `are only ${pages} pages`} of results${filterText}.`);

      const embed = new EmbedBuilder()
        .setTitle('Command log')
        .setDescription(rows.map(formatRow).join('\n\n'))
        .setFooter({ text: `Page ${page} of ${pages} · ${total} run${total === 1 ? '' : 's'}${filterText}` })
        .setColor(DEFAULT_EMBED_COLOR);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[CommandLog] /commandlog failed:', err);
      interaction.commandError = err; // for the command log
      await interaction.editReply(`Could not read the command log: ${err.message}`);
    }
  },
};
