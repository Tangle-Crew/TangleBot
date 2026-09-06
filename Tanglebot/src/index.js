require('dotenv').config();
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

// Last-resort safety net: log and keep running instead of letting a missed
// await/catch anywhere in the codebase take down the whole bot.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});

loadCommands(client);
loadEvents(client);

client.login(discordBotToken).catch((err) => {
  console.error('Failed to log in to Discord:', err);
  process.exit(1);
});
