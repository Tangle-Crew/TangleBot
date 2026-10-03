const { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { callServiceRpc } = require('../utils/clanAccountLink');

module.exports = {
  requiredEnv: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],

  data: new SlashCommandBuilder()
    .setName('gimrolesync')
    .setDescription('Synchronize configured GIM group roles from the clan roster')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const plan = await callServiceRpc('get_clan_gim_role_sync');
      const configuredRoleIds = Array.isArray(plan?.roleIds) ? plan.roleIds.filter(Boolean) : [];
      const assignments = Array.isArray(plan?.assignments) ? plan.assignments : [];

      await interaction.guild.roles.fetch();
      const usableRoleIds = configuredRoleIds.filter(roleId => interaction.guild.roles.cache.get(roleId)?.editable);
      const unusableRoleIds = configuredRoleIds.filter(roleId => !usableRoleIds.includes(roleId));
      let updated = 0;
      let unchanged = 0;
      const failures = [];

      for (const assignment of assignments) {
        const member = await interaction.guild.members.fetch(assignment.discordUserId).catch(() => null);
        if (!member) {
          failures.push(`${assignment.displayName}: Discord member not found`);
          continue;
        }

        const desiredRoleId = usableRoleIds.includes(assignment.roleId) ? assignment.roleId : null;
        const rolesToRemove = usableRoleIds.filter(roleId => roleId !== desiredRoleId && member.roles.cache.has(roleId));
        const shouldAdd = desiredRoleId && !member.roles.cache.has(desiredRoleId);

        try {
          if (rolesToRemove.length) await member.roles.remove(rolesToRemove, 'Clan roster GIM role synchronization');
          if (shouldAdd) await member.roles.add(desiredRoleId, 'Clan roster GIM role synchronization');
          if (rolesToRemove.length || shouldAdd) updated += 1;
          else unchanged += 1;
        } catch (error) {
          failures.push(`${assignment.displayName}: ${error.message}`);
        }
      }

      const embed = new EmbedBuilder()
        .setColor(failures.length || unusableRoleIds.length ? 0xd4a017 : 0x2e8b57)
        .setTitle('GIM role synchronization complete')
        .addFields(
          { name: 'Updated members', value: String(updated), inline: true },
          { name: 'Already correct', value: String(unchanged), inline: true },
          { name: 'Failures', value: String(failures.length), inline: true },
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
      await interaction.editReply({ content: error?.response?.data?.message ?? error?.message ?? 'Unable to synchronize GIM roles.' });
    }
  },
};
