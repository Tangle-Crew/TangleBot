const {
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
} = require('discord.js');
const { parseDateInput } = require('./weeklycomp');
const { findNextEnding } = require('../utils/weeklyAnnounce');
const { competitionUrl } = require('../utils/wiseOldMan');
const { discordTimestamp } = require('../utils/db');

const TEMPLAR_ROLE_ID = process.env.TEMPLAR_ROLE_ID;
const WOM_GROUP_ID = Number(process.env.WOM_GROUP_ID);
// Posts following the competitions send this long after they end, so WOM's final totals are in.
const SEND_DELAY_MS = 5 * 60 * 1000;
// When set, every post goes here and the command has no channel option.
const CHANNEL_ID = process.env.WEEKLY_ANNOUNCE_CHANNEL_ID?.trim() || null;

// What the bot needs in the target channel to post the winners chart and announcements.
const SEND_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.AttachFiles, 'Attach Files'],
];

function buildCommandData() {
  return new SlashCommandBuilder()
    .setName('weeklyannounce')
    .setDescription('Schedule the weekly winners and announcements post')
    .addSubcommand(sub => {
      sub.setName('setup').setDescription('Build and schedule the post for 5 minutes after the next competition ends');
      // Required options must come first, so the channel goes before start.
      if (!CHANNEL_ID) {
        sub.addChannelOption(o =>
          o.setName('channel')
            .setDescription('Where to post (WEEKLY_ANNOUNCE_CHANNEL_ID is not set in the bot config)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        );
      }
      sub.addStringOption(o =>
        o.setName('start')
          .setDescription('Send time, Eastern Time (default: 5 min after the next competition ends), as in /weeklycomp')
      );
      return sub;
    });
}

function competitionLink(competition) {
  return `[${escapeMarkdown(competition.title.replace(/[[\]]/g, ''))}](<${competitionUrl(competition.id)}>)`;
}

// The permissions from SEND_PERMISSIONS the bot is missing in channel, by name.
function missingSendPermissions(channel, botUser) {
  const permissions = channel.permissionsFor(botUser);
  return SEND_PERMISSIONS.filter(([flag]) => !permissions?.has(flag)).map(([, name]) => name);
}

module.exports = {
  requiredEnv: ['TEMPLAR_ROLE_ID', 'WOM_GROUP_ID', 'ADMIN_LOG_CHANNEL_ID'],

  data: buildCommandData(),

  async execute(interaction) {
    console.log(`[WeeklyAnnounce] ${interaction.user.tag} ran /weeklyannounce ${interaction.options.getSubcommand()}`);
    // Logs why the command was turned down, then tells the user privately.
    const reject = (content) => {
      console.log(`[WeeklyAnnounce] Rejected /weeklyannounce from ${interaction.user.tag}: ${content}`);
      return interaction.deferred
        ? interaction.editReply({ content })
        : interaction.reply({ content, flags: MessageFlags.Ephemeral });
    };

    if (!interaction.member.roles.cache.has(TEMPLAR_ROLE_ID)) {
      return reject('You need the Templar role to use this command.');
    }

    const startInput = interaction.options.getString('start');
    let sendAt = null;
    if (startInput) {
      sendAt = parseDateInput(startInput);
      if (!sendAt) {
        const example = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        return reject(`Could not parse the start time. Use \`YYYY-MM-DD\`, \`YYYY/MM/DD\`, or \`MM/DD/YYYY\` (Eastern Time), optionally with an hour — \`HH\` (24-hour) or \`H\` + \`am\`/\`pm\`, e.g. \`${example} 18\` or \`${example} 6pm\`. Leave it blank to send 5 minutes after the next competition ends.`);
      }
      if (sendAt <= new Date()) {
        return reject(`The start time (${discordTimestamp(sendAt, 'F')}) has already passed. Pick a time in the future.`);
      }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channelId = CHANNEL_ID ?? interaction.options.getChannel('channel', true).id;
    let channel;
    try {
      channel = await interaction.client.channels.fetch(channelId);
    } catch (err) {
      console.error(`[WeeklyAnnounce] Could not fetch channel ${channelId}:`, err.message);
    }
    if (!channel?.isTextBased()) {
      return reject(CHANNEL_ID
        ? `\`WEEKLY_ANNOUNCE_CHANNEL_ID\` (${channelId}) isn't a text channel the bot can see. Ask an admin to check it.`
        : `The bot can't see <#${channelId}>. Pick another channel or give the bot access.`);
    }
    const missing = missingSendPermissions(channel, interaction.client.user);
    if (missing.length > 0) {
      return reject(`The bot is missing **${missing.join(', ')}** in ${channel}. Give it those permissions and try again.`);
    }

    let ending = [];
    if (!sendAt) {
      try {
        const next = await findNextEnding(WOM_GROUP_ID);
        sendAt = next.endsAt && new Date(next.endsAt.getTime() + SEND_DELAY_MS);
        ending = next.competitions;
      } catch (err) {
        console.error('[WeeklyAnnounce] Failed to load the group competitions:', err);
        return reject(`Couldn't load the group's competitions from Wise Old Man: ${err.message}. Try again, or type a \`start\` time.`);
      }
      if (!sendAt) {
        return reject('No competition in the Wise Old Man group ends in the future. Create one with `/weeklycomp`, or type a `start` time.');
      }
    }

    console.log(
      `[WeeklyAnnounce] ${interaction.user.tag} set up a post in #${channel.name} for ${sendAt.toISOString()} ` +
      `(${ending.length ? `when ${ending.map(c => `#${c.id}`).join(', ')} end${ending.length === 1 ? 's' : ''}` : 'typed start'})`
    );

    const lines = [
      '**Weekly announcement setup**',
      `**Channel:** ${channel}`,
      `**Sends:** ${discordTimestamp(sendAt, 'F')} (${discordTimestamp(sendAt, 'R')})`,
    ];
    if (ending.length) {
      lines.push(`**When ${ending.length === 1 ? 'this competition ends' : 'these competitions end'}:**`, ...ending.map(c => `• ${competitionLink(c)}`));
    }
    lines.push('', 'Nothing is scheduled yet.');
    await interaction.editReply({ content: lines.join('\n') });
  },
};
