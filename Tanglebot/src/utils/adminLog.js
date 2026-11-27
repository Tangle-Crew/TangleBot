const { EmbedBuilder } = require('discord.js');

const ADMIN_LOG_ALERT_COLOR = 0xed4245;

// Posts an embed to ADMIN_LOG_CHANNEL_ID, if set, with optional component rows. color defaults to
// alert red.
// content is optional message text above the embed, e.g. a role ping.
async function notifyAdminLog(client, title, description, fields = [], color = ADMIN_LOG_ALERT_COLOR, components = [], content = undefined) {
  const adminLogChannelId = process.env.ADMIN_LOG_CHANNEL_ID;
  if (!adminLogChannelId) return;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
  if (fields.length) embed.addFields(fields);

  try {
    const channel = await client.channels.fetch(adminLogChannelId);
    await channel.send({ ...(content ? { content } : {}), embeds: [embed], components });
  } catch (err) {
    console.error(`[AdminLog] Could not send "${title}":`, err.message);
  }
}

module.exports = { notifyAdminLog, ADMIN_LOG_ALERT_COLOR };
