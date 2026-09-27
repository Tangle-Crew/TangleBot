const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { refreshLeaderboard: refreshPetLeaderboard } = require('./pethighscore');
const { refreshLeaderboard: refreshDonationLeaderboard } = require('./donationhighscore');

const TEMPLAR_ROLE_ID = process.env.TEMPLAR_ROLE_ID;

const BOARDS = [
  { label: 'Pet high scores', refresh: refreshPetLeaderboard },
  { label: 'Donation high scores', refresh: refreshDonationLeaderboard },
];

module.exports = {
  requiredEnv: ['GOOGLE_SERVICE_ACCOUNT_JSON'],

  data: new SlashCommandBuilder()
    .setName('refreshboards')
    .setDescription('Repost every leaderboard (pet and donation high scores) from their sheets'),

  async execute(interaction) {
    if (TEMPLAR_ROLE_ID && !interaction.member.roles.cache.has(TEMPLAR_ROLE_ID)) {
      console.log(`[RefreshBoards] ${interaction.user.tag} was denied /refreshboards (missing Templar role)`);
      return interaction.reply({
        content: 'You need the Templar role to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    console.log(`[RefreshBoards] ${interaction.user.tag} triggered /refreshboards`);

    // Each board runs on its own, so one failing doesn't stop the other.
    const results = await Promise.allSettled(BOARDS.map(board => board.refresh(interaction.client)));

    const lines = results.map((result, i) => {
      const { label } = BOARDS[i];
      if (result.status === 'rejected') {
        console.error(`[RefreshBoards] Failed to refresh ${label}:`, result.reason);
        return `⚠️ **${label}** failed: ${result.reason?.message ?? 'unknown error'}`;
      }
      return result.value ? `✅ **${label}** refreshed.` : `➖ **${label}** skipped (not set up).`;
    });

    await interaction.editReply(lines.join('\n'));
  },
};
