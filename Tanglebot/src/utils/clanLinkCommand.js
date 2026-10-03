const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { createAccountLinkChallenge } = require('./clanAccountLink');
const { logClanError } = require('./clanErrors');

function createLinkCommand({ name, linkKind, description, rsnDescription }) {
  return {
    requiredFeature: 'CLAN_ROSTER_COMMANDS_ENABLED',
    requiredEnv: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    data: new SlashCommandBuilder().setName(name).setDescription(description)
      .addStringOption(option => option.setName('rsn').setDescription(rsnDescription).setRequired(true).setMaxLength(12)),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const challenge = await createAccountLinkChallenge({
          discordUserId: interaction.user.id,
          rsn: interaction.options.getString('rsn', true).trim(),
          linkKind,
        });
        const expiresUnix = Math.floor(new Date(challenge.expiresAt).getTime() / 1000);
        await interaction.editReply({ content: [
          linkKind === 'primary'
            ? `Confirm that **${challenge.resolvedRsn}** is your primary account:`
            : `Confirm **${challenge.resolvedRsn}** as an alternate account on your existing clan profile:`,
          challenge.confirmationUrl,
          '',
          `This private, single-use link expires <t:${expiresUnix}:R>. You must sign in to the website with this Discord account.`,
        ].join('\n') });
      } catch (error) {
        logClanError(`/${name}`, error);
        await interaction.editReply({ content: 'Unable to start account linking. Please contact an administrator.' });
      }
    },
  };
}
module.exports = { createLinkCommand };
