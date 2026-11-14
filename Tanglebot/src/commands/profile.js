const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const profile = require('../utils/profile');
const { hasAnyRole } = require('../utils/db');
const donationHighscore = require('./donationhighscore');
const petHighscore = require('./pethighscore');

// Coordinator, Templar or Owner. Reads the database only, so DATABASE_URL is required.
const allowedRoles = () => [process.env.COORDINATOR_ROLE_ID, process.env.TEMPLAR_ROLE_ID, process.env.OWNER_ROLE_ID];

module.exports = {
  // Shown in the admin commands post.
  help: {
    category: 'Members',
    access: 'Coordinator',
    examples: { '': '/profile rsn:Zezima' },
    options: {
      member: 'a Discord member',
      rsn: 'an OSRS name (autocompletes)',
    },
  },
  requiredEnv: ['DATABASE_URL'],
  requiredEnvAny: ['COORDINATOR_ROLE_ID', 'TEMPLAR_ROLE_ID', 'OWNER_ROLE_ID'],

  data: new SlashCommandBuilder()
    .setName('profile')
    .setDefaultMemberPermissions(0)
    .setDescription('Show what is stored about a clan member or an OSRS account')
    .addUserOption(o => o.setName('member').setDescription('A Discord member'))
    .addStringOption(o => o.setName('rsn').setDescription('An OSRS account name').setAutocomplete(true)),

  async autocomplete(interaction) {
    if (!hasAnyRole(interaction.member, allowedRoles())) return interaction.respond([]);
    const typed = String(interaction.options.getFocused() ?? '');
    const accounts = await profile.suggestAccounts(typed).catch(() => []);
    await interaction.respond(accounts.map(profile.accountChoice));
  },

  async execute(interaction) {
    if (!hasAnyRole(interaction.member, allowedRoles())) {
      console.log(`[Profile] ${interaction.user.tag} was denied /profile (needs Coordinator, Templar or Owner)`);
      interaction.commandDenied = true; // for the command log
      return interaction.reply({
        content: 'You need the Coordinator role or higher to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const user = interaction.options.getUser('member');
    const rsn = interaction.options.getString('rsn')?.trim();
    if ((user && rsn) || (!user && !rsn)) {
      return interaction.reply({ content: 'Give either a `member` or an `rsn`.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (user) {
        const data = await profile.getMemberProfile(user.id);
        if (!data) return interaction.editReply(`Nothing is stored about <@${user.id}> yet.`);
        const embed = profile.memberEmbed(data, {
          tiers: donationHighscore.DONATION_TIERS,
          masterThreshold: petHighscore.PET_MASTER_THRESHOLD,
        });
        return interaction.editReply({ embeds: [embed] });
      }

      const matches = await profile.findAccounts(rsn);
      if (matches.length === 0) {
        return interaction.editReply(`No clan account matches "${rsn}". Accounts come from Wise Old Man (\`/memberdata\`).`);
      }
      if (matches.length > 1) {
        const list = matches.map(a => `${a.rsn} (${a.status === 'active' ? a.wom_role : 'left'})`).join(', ');
        return interaction.editReply(`More than one account matches "${rsn}": ${list}. Type the full name.`);
      }
      const data = await profile.getAccountProfile(matches[0].id);
      return interaction.editReply({ embeds: [profile.accountEmbed(data)] });
    } catch (err) {
      console.error('[Profile] /profile failed:', err);
      interaction.commandError = err; // for the command log
      await interaction.editReply(`Could not read the profile: ${err.message}`);
    }
  },
};
