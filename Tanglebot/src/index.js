require('dotenv').config({ quiet: true });
const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const { loadCommands } = require('./handlers/commandHandler');
const { loadEvents } = require('./handlers/eventHandler');

const discordBotToken = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;

if (!discordBotToken) {
  throw new Error('Missing required environment variable: DISCORD_BOT_TOKEN. Copy Tanglebot/.env.example to Tanglebot/.env and fill in your bot token.');
}

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

const client = new Client({
  intents,
  partials: [Partials.Channel, Partials.Message],
});

client.commands = new Collection();

// Log a missed rejection instead of crashing the bot.
process.on('unhandledRejection', (err) => {
  console.error('[Bot] Unhandled promise rejection:', err);
});

loadCommands(client);
loadEvents(client);

client.login(discordBotToken).catch((err) => {
  console.error('[Bot] Failed to log in to Discord:', err);
  process.exit(1);
});
