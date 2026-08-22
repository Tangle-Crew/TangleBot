const { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  SUBMISSION_FORMAT_MESSAGE,
  getConfiguredIntakeUrl,
  getLastAcceptedSubmission,
  setConfiguredIntakeUrl,
} = require('../utils/submissionIntake');

const DISCORD_GREEN = 0x1a5c2e;
const DISCORD_PURPLE = 0x4a235a;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('submission')
    .setDescription('Post proof submission help or show the latest accepted proof')
    .addSubcommand(subcommand =>
      subcommand
        .setName('format')
        .setDescription('Post the KC and drop proof formats for players')
        .addBooleanOption(option =>
          option
            .setName('private')
            .setDescription('Only show this response to you')
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('last')
        .setDescription('Show the latest accepted KC or drop proof submission')
        .addBooleanOption(option =>
          option
            .setName('private')
            .setDescription('Only show this response to you')
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('showintakeurl')
        .setDescription('Show the currently configured Discord KC intake URL')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('setintakeurl')
        .setDescription('Set the Discord KC intake URL override stored locally on the bot')
        .addStringOption(option =>
          option
            .setName('url')
            .setDescription('Full intake URL to use for Discord KC submissions')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const privateReply = interaction.options.getBoolean('private') ?? false;
    const flags = privateReply ? MessageFlags.Ephemeral : undefined;

    if (subcommand === 'format') {
      return interaction.reply({
        content: SUBMISSION_FORMAT_MESSAGE,
        flags,
      });
    }

    if (subcommand === 'last') {
      const submission = getLastAcceptedSubmission();
      if (!submission?.acceptedAt) {
        return interaction.reply({
          content: 'No accepted KC or drop proof submissions have been recorded yet.',
          flags,
        });
      }

      return interaction.reply({
        embeds: [buildLastSubmissionEmbed(submission)],
        flags,
      });
    }

    if (subcommand === 'showintakeurl') {
      if (!hasSubmissionAdminAccess(interaction)) {
        return interaction.reply({
          content: 'You need Manage Server permission to view the intake URL override.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const currentUrl = getConfiguredIntakeUrl();
      return interaction.reply({
        content: currentUrl
          ? `Current intake URL:\n\`${currentUrl}\``
          : 'No intake URL is configured. Set `SUPABASE_DISCORD_KC_INTAKE_URL` in env or use `/submission setintakeurl`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'setintakeurl') {
      if (!hasSubmissionAdminAccess(interaction)) {
        return interaction.reply({
          content: 'You need Manage Server permission to update the intake URL override.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const url = interaction.options.getString('url', true).trim();
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('Unsupported protocol');
        }
      } catch {
        return interaction.reply({
          content: 'That is not a valid absolute URL.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const storedUrl = setConfiguredIntakeUrl(url);
      interaction.client.submissionConfig.intakeUrl = storedUrl;

      return interaction.reply({
        content: `Stored the local intake URL override.\n\`${storedUrl}\``,
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: 'Unknown submission command.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

function buildLastSubmissionEmbed(submission) {
  const acceptedTime = Math.floor(new Date(submission.acceptedAt).getTime() / 1000);
  const isDrop = submission.type === 'drop';

  const fields = [
    { name: 'Task', value: submission.taskName ?? 'Unknown', inline: true },
    { name: 'Submitted by', value: submission.discordName ?? 'Unknown', inline: true },
  ];

  if (isDrop) {
    fields.push({ name: 'Item Dropped', value: submission.itemDropped ?? 'Unknown', inline: true });
  } else {
    fields.push(
      { name: 'Monster', value: submission.monsterName ?? 'Unknown', inline: true },
      { name: 'Phase', value: submission.phase ?? 'Unknown', inline: true },
      { name: 'Kill Count', value: String(submission.kcValue ?? 'Unknown'), inline: true },
    );
  }

  if (submission.messageUrl) {
    fields.push({ name: 'Discord Message', value: `[Jump to submission](${submission.messageUrl})`, inline: false });
  }

  fields.push({ name: 'Accepted', value: `<t:${acceptedTime}:R>`, inline: true });

  const embed = new EmbedBuilder()
    .setColor(isDrop ? DISCORD_PURPLE : DISCORD_GREEN)
    .setTitle(isDrop ? 'Latest Accepted Drop Proof' : 'Latest Accepted KC Proof')
    .addFields(fields)
    .setTimestamp(new Date(submission.acceptedAt));

  if (submission.imageUrl) {
    embed.setImage(submission.imageUrl);
  }

  return embed;
}

function hasSubmissionAdminAccess(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}
