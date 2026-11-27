// Posts "Bot did not start" to the admin log through Discord's REST API (no login needed), at most
// once an hour, so a restart loop can't flood the channel.
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const { DATA_DIR } = require('./common');
const { describeDbError } = require('./dbHealth');

const ALERT_FILE = path.join(DATA_DIR, 'startup-alert.json');
const MIN_GAP_MS = 60 * 60 * 1000;

// The reason a startup failed, in plain words.
function startupReason(err) {
  if (/^Migration \S+ failed/.test(err?.message ?? '')) return `a migration file failed. ${err.message}`;
  return `the database is unreachable. ${describeDbError(err)}`;
}

function lastSentAt(file) {
  try {
    return Number(JSON.parse(fs.readFileSync(file, 'utf8')).sentAt) || 0;
  } catch {
    return 0;
  }
}

// Sends the alert unless one was sent in the last hour. Returns true if it was sent. Never throws.
async function sendStartupAlert(err, {
  token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN,
  channelId = process.env.ADMIN_LOG_CHANNEL_ID,
  ownerRoleId = process.env.OWNER_ROLE_ID,
  file = ALERT_FILE,
  now = () => Date.now(),
  send = (body) => new REST({ version: '10' }).setToken(token).post(Routes.channelMessages(channelId), { body }),
} = {}) {
  if (!token || !channelId) return false;
  try {
    if (now() - lastSentAt(file) < MIN_GAP_MS) {
      console.log('[Startup] A startup alert was already sent in the last hour; not sending another.');
      return false;
    }
    const ping = ownerRoleId ? `<@&${ownerRoleId}> ` : '';
    const content = `${ping}⚠️ **Bot did not start:** ${startupReason(err)}\n` +
      'It keeps restarting until this is fixed. This message is sent at most once an hour.';
    await send({ content: content.slice(0, 2000), allowed_mentions: { roles: ownerRoleId ? [ownerRoleId] : [] } });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sentAt: now() }), 'utf8');
    console.log('[Startup] Sent the startup alert to the admin log.');
    return true;
  } catch (sendErr) {
    console.error('[Startup] Could not send the startup alert:', sendErr.message);
    return false;
  }
}

module.exports = { sendStartupAlert, startupReason, ALERT_FILE };
