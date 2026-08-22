const { SlashCommandBuilder } = require('discord.js');
const { sendSetupMenu } = require('../utils/lfgPost');

module.exports = {
  requiredEnv: ['LFG_FORUM_CHANNEL_ID'],

  data: new SlashCommandBuilder()
    .setName('lfg-post')
    .setDescription('Create a Looking For Group post as a forum thread'),

  async execute(interaction) {
    await sendSetupMenu(interaction);
  },
};
