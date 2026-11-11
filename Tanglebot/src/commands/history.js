const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const history = require('../utils/history');
const { hasAnyRole } = require('../utils/db');

// Coordinator, Templar or Owner. Reads the database only, so DATABASE_URL is required.
const allowedRoles = () => [process.env.COORDINATOR_ROLE_ID, process.env.TEMPLAR_ROLE_ID, process.env.OWNER_ROLE_ID];

const memberOption = o => o.setName('member').setDescription('Only this member (leave empty for the whole clan)');
const pageOption = o => o.setName('page').setDescription('Page number (10 a page, newest first)').setMinValue(1);

module.exports = {
  requiredEnv: ['DATABASE_URL'],
  requiredEnvAny: ['COORDINATOR_ROLE_ID', 'TEMPLAR_ROLE_ID', 'OWNER_ROLE_ID'],

  data: new SlashCommandBuilder()
    .setName('history')
    .setDefaultMemberPermissions(0)
    .setDescription('Donation history and pet timeline, for a member or the whole clan')
    .addSubcommand(sub =>
      sub.setName('donations').setDescription('Every donation change, newest first, with monthly totals')
        .addUserOption(memberOption).addIntegerOption(pageOption)
    )
    .addSubcommand(sub =>
      sub.setName('pets').setDescription('Pets added and removed, newest first, with pets added per month')
        .addUserOption(memberOption).addIntegerOption(pageOption)
    ),

  async execute(interaction) {
    if (!hasAnyRole(interaction.member, allowedRoles())) {
      console.log(`[History] ${interaction.user.tag} was denied /history (needs Coordinator, Templar or Owner)`);
      interaction.commandDenied = true; // for the command log
      return interaction.reply({
        content: 'You need the Coordinator role or higher to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const subcommand = interaction.options.getSubcommand();
    const user = interaction.options.getUser('member');
    const page = interaction.options.getInteger('page') ?? 1;

    try {
      const kind = subcommand === 'donations'
        ? { get: history.getDonationHistory, embed: history.donationEmbed }
        : { get: history.getPetHistory, embed: history.petEmbed };
      const data = await kind.get({ discordId: user?.id ?? null, page });

      const pages = history.pagesOf(data.total);
      if (page > pages) {
        return interaction.editReply(`There ${pages === 1 ? 'is only 1 page' : `are only ${pages} pages`} of history.`);
      }
      if (user && data.total === 0 && !(data.current > 0 || data.owned > 0)) {
        return interaction.editReply(`Nothing is recorded for <@${user.id}> yet.`);
      }
      // The member's stored name, falling back to their Discord name.
      const subject = user ? (data.rows[0]?.member_name ?? user.username) : null;
      await interaction.editReply({ embeds: [kind.embed(data, { subject, page })] });
    } catch (err) {
      console.error(`[History] /history ${subcommand} failed:`, err);
      interaction.commandError = err; // for the command log
      await interaction.editReply(`Could not read the history: ${err.message}`);
    }
  },
};
