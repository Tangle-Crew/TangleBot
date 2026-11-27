const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { refreshLeaderboard: refreshPetLeaderboard } = require('./pethighscore');
const { refreshLeaderboard: refreshDonationLeaderboard } = require('./donationhighscore');
const { refuseWithoutRole } = require('../utils/roleCheck');

const TEMPLAR_ROLE_ID = process.env.TEMPLAR_ROLE_ID;

const BOARDS = [
  { label: 'Pet high scores', refresh: refreshPetLeaderboard },
  { label: 'Donation high scores', refresh: refreshDonationLeaderboard },
];

module.exports = {
  // Shown in the admin commands post.
  help: {
    category: 'Leaderboards',
    access: 'Templar',
    examples: { '': '/refreshboards' },
  },
  requiredEnv: ['DATABASE_URL', 'TEMPLAR_ROLE_ID'],

  data: new SlashCommandBuilder()
    .setName('refreshboards')
    .setDefaultMemberPermissions(0)
    .setDescription('Repost every leaderboard (pet and donation high scores) from the database'),

  async execute(interaction) {
    if (await refuseWithoutRole(interaction, [TEMPLAR_ROLE_ID], {
      logPrefix: '[RefreshBoards]', command: `/refreshboards`, missing: 'missing Templar role',
      message: 'You need the Templar role to use this command.',
    })) return;

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
