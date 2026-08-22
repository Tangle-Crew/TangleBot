const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { hasHoneypotAdminAccess, isTestModeEnabled, setTestModeEnabled } = require('../utils/honeypot');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('honeypot')
    .setDescription('Manage the honeypot channel trap')
    .addSubcommand(subcommand =>
      subcommand
        .setName('testmode')
        .setDescription('Enable or disable honeypot testing mode')
        .addBooleanOption(option =>
          option
            .setName('enabled')
            .setDescription('Whether testing mode should be on')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Show whether honeypot testing mode is currently on')
    ),

  requiredEnvAny: ['HONEYPOT_CHANNEL_ID', 'HONEYPOT_VOICE_CHANNEL_ID'],

  async execute(interaction) {
    if (!hasHoneypotAdminAccess(interaction.member)) {
      return interaction.reply({
        content: 'You need the owner or templar role to manage the honeypot trap.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'status') {
      const enabled = isTestModeEnabled();
      return interaction.reply({
        content: `Honeypot testing mode is currently **${enabled ? 'ON' : 'OFF'}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'testmode') {
      const enabled = interaction.options.getBoolean('enabled', true);
      setTestModeEnabled(enabled);
      return interaction.reply({
        content: enabled
          ? '🧪 Honeypot testing mode is now **ON**. Triggering the trap will not time out, ban, or delete messages from anyone.'
          : 'Honeypot testing mode is now **OFF**. Triggering the trap will apply real moderation actions.',
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: 'Unknown honeypot command.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
