const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
  buildMenuEmbed,
  buildCategoryButtonsRow,
  buildClearAllRow,
  MENU_MESSAGE_LIFETIME_MS,
  scheduleReplyCleanup,
} = require('../utils/roleMenu');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lfg-roles')
    .setDescription('Get your private LFG Roles menu (Bosses / Raids)'),

  async execute(interaction) {
    const embed = buildMenuEmbed();
    const row = buildCategoryButtonsRow();
    const clearRow = buildClearAllRow();

    await interaction.reply({ embeds: [embed], components: [row, clearRow], flags: MessageFlags.Ephemeral });

    // Auto-delete this menu after 60 seconds. Roles already picked stay assigned.
    scheduleReplyCleanup(interaction, MENU_MESSAGE_LIFETIME_MS, '/lfg-roles menu message');
  },
};
