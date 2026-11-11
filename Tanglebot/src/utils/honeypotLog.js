const database = require('./database');
const { databaseConfigured } = require('./commandAvailability');

// Records honeypot activity in honeypot_incidents: the automatic timeout when someone posts in a trap
// channel (action 'timeout'), and the admin buttons (action 'ban' and 'false_positive'). The outcome
// is 'done', 'failed', 'skipped' (not a known server member) or 'test' (test mode, nothing happened).
// Only what happened is stored, never the message. Does nothing without DATABASE_URL.

const cut = (text, max) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text ?? null);

// Saves one incident. Never throws, so logging can't break the honeypot.
async function recordIncident({
  discordId, discordName = null, action, outcome, testMode = false, channelId = null,
  byDiscordId = null, byDiscordName = null, details = {},
}, db = null) {
  if (!db && !databaseConfigured()) return;
  try {
    const clean = { ...details };
    if (clean.error) clean.error = cut(String(clean.error), 300);
    await (db ?? database.getPool()).query(
      `insert into honeypot_incidents
         (discord_id, discord_name, action, outcome, test_mode, channel_id, by_discord_id, by_discord_name, details)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [discordId, discordName, action, outcome, testMode, channelId, byDiscordId, byDiscordName, JSON.stringify(clean)]
    );
  } catch (err) {
    console.error('[HoneypotLog] Failed to record an incident:', err.message);
  }
}

module.exports = { recordIncident };
