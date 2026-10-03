const { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { callServiceRpc } = require('../utils/clanAccountLink');

const CATEGORY_LABELS = {
  potential_rank_up: 'Potential rank-up review',
  recently_joined: 'Recently joined',
  insufficient_data: 'Insufficient data',
};

module.exports = {
  requiredEnv: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],

  data: new SlashCommandBuilder()
    .setName('rankreview')
    .setDescription('Generate the clan rank-review summary from configured rules')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption(option => option
      .setName('private')
      .setDescription('Show the summary only to you instead of posting it in this channel')),

  async execute(interaction) {
    const privateReply = interaction.options.getBoolean('private') ?? false;
    await interaction.deferReply({ flags: privateReply ? MessageFlags.Ephemeral : undefined });

    try {
      const rows = await callServiceRpc('get_clan_rank_reviews');
      const actionable = (Array.isArray(rows) ? rows : []).filter(row => row.category !== 'no_action');

      const embed = new EmbedBuilder()
        .setColor(0xd4a843)
        .setTitle('Members requiring rank review this week')
        .setDescription(actionable.length
          ? 'Recommendations are evidence for administrator review only; no ranks are changed automatically.'
          : 'No members currently match a configured review category.')
        .setTimestamp();

      for (const row of actionable.slice(0, 25)) {
        const recommendation = row.recommended_rank ? ` → **${row.recommended_rank}**` : '';
        embed.addFields({
          name: `${row.display_name} (${row.primary_rsn})`,
          value: [
            `${CATEGORY_LABELS[row.category] ?? row.category}: **${row.current_rank}**${recommendation}`,
            `Clan tenure: ${row.clan_days ?? 'unknown'} days · Time in rank: ${row.rank_days ?? 'unknown'} days`,
          ].join('\n'),
        });
      }

      if (actionable.length > 25) {
        embed.setFooter({ text: `${actionable.length - 25} additional reviews are available in /admin/roster.` });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply({ content: error?.response?.data?.message ?? error?.message ?? 'Unable to generate rank reviews.' });
    }
  },
};
