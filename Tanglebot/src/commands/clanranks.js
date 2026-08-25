const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { truncate } = require('../utils/db');
const {
  ensureRankRoles,
  computePendingChanges,
  runWeeklyRankSync,
  upsertRsnLink,
  removeRsnLink,
  bootstrapLinksFromGuild,
} = require('../utils/clanRanks');

const OWNER_ROLE_ID = process.env.OWNER_ROLE_ID;

function formatChangesSummary({ changes, renames, unmatched }) {
  const lines = [];

  if (changes.length === 0) {
    lines.push('No rank changes pending.');
  } else {
    lines.push(`**${changes.length} pending change(s):**`);
    for (const c of changes) {
      lines.push(`<@${c.discordId}> — ${c.fromRank} → **${c.toRank}** (${c.tenureDays}d tenure)`);
    }
  }

  if (renames.length) {
    lines.push('', `**${renames.length} RSN update(s) detected:**`);
    for (const r of renames) lines.push(`<@${r.discordId}> — \`${r.renamedFrom}\` → \`${r.rsn}\``);
  }

  if (unmatched.length) {
    lines.push('', `**${unmatched.length} unmatched link(s):**`);
    for (const u of unmatched) lines.push(`<@${u.discordId}> — RSN on file: \`${u.rsn || '(blank)'}\``);
  }

  return truncate(lines.join('\n'), 1900);
}

module.exports = {
  requiredEnv: ['WOM_GROUP_ID', 'CLAN_RANKS_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON'],

  data: new SlashCommandBuilder()
    .setName('clanranks')
    .setDescription('Manage the automatic clan rank ladder')
    .addSubcommand((sub) => sub.setName('setup').setDescription('Create/refresh Discord roles for every configured rank'))
    .addSubcommand((sub) => sub.setName('preview').setDescription('Preview pending rank changes without applying them'))
    .addSubcommand((sub) => sub.setName('sync').setDescription('Run the full rank sync now (reports to admin log, then applies changes)'))
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription("Link (or update) a member's RSN for rank tracking")
        .addUserOption((o) => o.setName('member').setDescription('Member to link').setRequired(true))
        .addStringOption((o) => o.setName('rsn').setDescription('Their RuneScape username').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('unlink')
        .setDescription("Remove a member's RSN link")
        .addUserOption((o) => o.setName('member').setDescription('Member to unlink').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub.setName('firstrun').setDescription('Seed the RSN sheet from the current member list, auto-matching against WOM where possible')
    ),

  async execute(interaction) {
    if (OWNER_ROLE_ID && !interaction.member.roles.cache.has(OWNER_ROLE_ID)) {
      console.log(`[ClanRanks] ${interaction.user.tag} was denied /clanranks (missing Owner role)`);
      return interaction.reply({ content: 'You need the Owner role to use this command.', flags: MessageFlags.Ephemeral });
    }

    const subcommand = interaction.options.getSubcommand();
    const guild = interaction.guild;

    try {
      if (subcommand === 'setup') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await ensureRankRoles(guild);
        console.log(`[ClanRanks] ${interaction.user.tag} ran /clanranks setup`);
        await interaction.editReply(
          `Roles created: ${result.created.length ? result.created.join(', ') : 'none'}\n` +
            `Roles updated: ${result.updated.length ? result.updated.join(', ') : 'none'}` +
            (result.failed.length ? `\n⚠️ Failed: ${result.failed.join(', ')}` : '')
        );
        return;
      }

      if (subcommand === 'preview') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await computePendingChanges(guild);
        console.log(`[ClanRanks] ${interaction.user.tag} ran /clanranks preview`);
        await interaction.editReply(formatChangesSummary(result));
        return;
      }

      if (subcommand === 'sync') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await runWeeklyRankSync(interaction.client);
        console.log(`[ClanRanks] ${interaction.user.tag} ran /clanranks sync`);
        await interaction.editReply('Rank sync complete — see the admin log for details.');
        return;
      }

      if (subcommand === 'add') {
        const member = interaction.options.getUser('member', true);
        const rsn = interaction.options.getString('rsn', true).trim();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guildMember = await guild.members.fetch(member.id).catch(() => null);
        const displayName = guildMember?.displayName || member.username;
        await upsertRsnLink(member.id, displayName, rsn);
        console.log(`[ClanRanks] ${interaction.user.tag} linked ${member.tag} to RSN "${rsn}"`);
        await interaction.editReply(`Linked <@${member.id}> to RSN **${rsn}**.`);
        return;
      }

      if (subcommand === 'unlink') {
        const member = interaction.options.getUser('member', true);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const removed = await removeRsnLink(member.id);
        console.log(`[ClanRanks] ${interaction.user.tag} unlinked ${member.tag}`);
        await interaction.editReply(removed ? `Unlinked <@${member.id}>.` : `<@${member.id}> wasn't linked.`);
        return;
      }

      if (subcommand === 'firstrun') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await bootstrapLinksFromGuild(guild);
        console.log(`[ClanRanks] ${interaction.user.tag} ran /clanranks firstrun`);

        const lines = [`Added ${result.added} new row(s), auto-matched ${result.autoMatched}.`];
        if (result.needsReview.length) {
          lines.push('', `**${result.needsReview.length} possible match(es) to confirm:**`);
          for (const r of result.needsReview.slice(0, 25)) {
            lines.push(`<@${r.discordId}> (${r.displayName}) — maybe **${r.suggestedRsn}**? (${r.score}% match)`);
          }
          if (result.needsReview.length > 25) lines.push(`…and ${result.needsReview.length - 25} more.`);
        }
        if (result.unmatchedWom.length) {
          lines.push('', `**${result.unmatchedWom.length} WOM member(s) with no Discord match found:**`);
          for (const u of result.unmatchedWom.slice(0, 25)) lines.push(`\`${u.rsn}\``);
          if (result.unmatchedWom.length > 25) lines.push(`…and ${result.unmatchedWom.length - 25} more.`);
        }
        await interaction.editReply(truncate(lines.join('\n'), 1900));
        return;
      }
    } catch (err) {
      console.error(`[ClanRanks] /clanranks ${subcommand} failed:`, err);
      const content = `Error: ${err.message}`;
      if (interaction.deferred) await interaction.editReply(content);
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  },
};
