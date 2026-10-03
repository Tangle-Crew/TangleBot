const { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { callServiceRpc } = require('../utils/clanAccountLink');
const { reconcileGimRoles } = require('../utils/gimRoleSync');
const { logClanError } = require('../utils/clanErrors');

module.exports = {
  requiredFeature: 'CLAN_ROSTER_COMMANDS_ENABLED',
  requiredEnv: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],

  data: new SlashCommandBuilder()
    .setName('gimrolesync')
    .setDescription('Synchronize configured GIM group roles from the clan roster')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const plan = await callServiceRpc('get_clan_gim_role_sync');
      const { updated, unchanged, failures, unusableRoleIds, unprocessed } = await reconcileGimRoles(interaction.guild, plan);

      const embed = new EmbedBuilder()
        .setColor(failures.length || unusableRoleIds.length || unprocessed ? 0xd4a017 : 0x2e8b57)
        .setTitle(failures.length || unusableRoleIds.length || unprocessed ? 'GIM role synchronization needs attention' : 'GIM role synchronization complete')
        .addFields(
          { name: 'Updated members', value: String(updated), inline: true },
          { name: 'Already correct', value: String(unchanged), inline: true },
          { name: 'Failures', value: String(failures.length), inline: true },
          { name: 'Not processed (run again)', value: String(unprocessed), inline: true },
        )
        .setTimestamp();

      if (unusableRoleIds.length) {
        embed.addFields({ name: 'Unusable role IDs', value: unusableRoleIds.map(id => `\`${id}\``).join(', ').slice(0, 1024) });
      }
      if (failures.length) {
        embed.addFields({ name: 'Member errors', value: failures.slice(0, 12).join('\n').slice(0, 1024) });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logClanError('/gimrolesync', error);
      await interaction.editReply({ content: 'Unable to synchronize GIM roles. Ask an administrator to check the bot permissions and logs.' });
    }
  },
};
