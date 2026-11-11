require('dotenv').config({ quiet: true });
const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const { loadCommands } = require('./handlers/commandHandler');
const { loadEvents } = require('./handlers/eventHandler');
const { databaseConfigured } = require('./utils/commandAvailability');
const { runMigrations } = require('./utils/database');
const { hydrateState } = require('./utils/state');

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

async function main() {
  // Migrations run before the commands load. A failed one stops startup.
  if (databaseConfigured()) {
    try {
      await runMigrations();
    } catch (err) {
      console.error(`[Database] Startup stopped: ${err.message}`);
      process.exit(1);
    }
    // The state files are mirrored in the database. If that fails, they are simply used as files.
    try {
      const { loaded, imported, restored } = await hydrateState();
      console.log(`[State] Loaded ${loaded} saved state(s) from the database; ${imported} copied in from files, ${restored} files restored`);
    } catch (err) {
      console.error('[State] Could not load the saved state from the database, using the files:', err.message);
    }
  }

  loadCommands(client);
  loadEvents(client);

  await client.login(discordBotToken).catch((err) => {
    console.error('[Bot] Failed to log in to Discord:', err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('[Bot] Startup failed:', err);
  process.exit(1);
});
