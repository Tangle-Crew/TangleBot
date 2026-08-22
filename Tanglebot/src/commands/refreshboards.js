const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { refreshLeaderboardOnStartup: refreshPetLeaderboard } = require('./pethighscore');
const { refreshLeaderboardOnStartup: refreshDonationLeaderboard } = require('./donationhighscore');

const TEMPLAR_ROLE_ID = process.env.TEMPLAR_ROLE_ID;

module.exports = {
  requiredEnv: ['GOOGLE_SERVICE_ACCOUNT_JSON'],

  data: new SlashCommandBuilder()
    .setName('refreshboards')
    .setDescription('Repost every leaderboard (pet and donation high scores) from their sheets'),

  async execute(interaction) {
    if (TEMPLAR_ROLE_ID && !interaction.member.roles.cache.has(TEMPLAR_ROLE_ID)) {
      console.log(`[RB] ${interaction.user.tag} was denied /refreshboards (missing Templar role)`);
      return interaction.reply({
        content: 'You need the Templar role to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Each refresh no-ops (and logs) on its own if its env vars aren't set, so
    // one missing/misconfigured board doesn't stop the other from refreshing.
    await Promise.all([
      refreshPetLeaderboard(interaction.client),
      refreshDonationLeaderboard(interaction.client),
    ]);

    console.log(`[RB] ${interaction.user.tag} triggered /refreshboards`);
    await interaction.editReply('Refreshed the pet and donation high score leaderboards.');
  },
};
