// npm run deploy: registers the slash commands without starting the bot. The bot also does this
// on every startup.
require('dotenv').config({ quiet: true });
const { availableCommands, registerCommands } = require('./handlers/commandHandler');

const missing = ['CLIENT_ID', 'CLAN_ID'].filter(key => !process.env[key]);
if (!process.env.DISCORD_BOT_TOKEN && !process.env.DISCORD_TOKEN) missing.unshift('DISCORD_BOT_TOKEN');
if (missing.length) {
  throw new Error(`Missing required deploy environment variable(s): ${missing.join(', ')}. Copy Tanglebot/.env.example to Tanglebot/.env and fill in real values.`);
}

registerCommands(availableCommands('[Deploy]'), '[Deploy]').then(ok => {
  if (!ok) process.exitCode = 1;
});
