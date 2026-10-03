const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { createAccountLinkChallenge } = require('../utils/clanAccountLink');

module.exports = {
  requiredEnv: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],

  data: new SlashCommandBuilder()
    .setName('linkalt')
    .setDescription('Securely add an alternate RuneScape account to your clan member profile')
    .addStringOption(option => option
      .setName('rsn')
      .setDescription('Alternate RuneScape name as shown in the clan WOM group')
      .setRequired(true)
      .setMaxLength(12)),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const challenge = await createAccountLinkChallenge({
        discordUserId: interaction.user.id,
        rsn: interaction.options.getString('rsn', true).trim(),
        linkKind: 'alt',
      });

      const expiresUnix = Math.floor(new Date(challenge.expiresAt).getTime() / 1000);
      await interaction.editReply({
        content: [
          `Confirm **${challenge.resolvedRsn}** as an alternate account on your existing clan profile:`,
          challenge.confirmationUrl,
          '',
          `This private, single-use link expires <t:${expiresUnix}:R>. You must sign in to the website with this Discord account.`,
        ].join('\n'),
      });
    } catch (error) {
      await interaction.editReply({ content: error instanceof Error ? error.message : 'Unable to start alternate-account linking.' });
    }
  },
};
