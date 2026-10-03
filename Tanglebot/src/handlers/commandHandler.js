const { commandDisabledReason } = require('../utils/commandAvailability');
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

function loadCommands(client) {
  const commandsPath = path.join(__dirname, '..', 'commands');
  const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

  for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    if (!command.data || !command.execute) continue;

    const disabledReason = commandDisabledReason(command);
    if (disabledReason) {
      console.log(`[Commands] Skipping /${command.data.name}: ${disabledReason}`);
      continue;
    }

    client.commands.set(command.data.name, command);
  }

  console.log(`[Commands] Loaded ${client.commands.size} command(s).`);
}

async function syncCommands(client) {
  const { CLIENT_ID, CLAN_ID } = process.env;
  const discordBotToken = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
  if (!CLIENT_ID || !CLAN_ID) {
    console.warn('[Commands] Skipping slash command sync: CLIENT_ID and/or CLAN_ID is not set.');
    return;
  }

  const commands = client.commands.map(command => command.data.toJSON());
  const rest = new REST().setToken(discordBotToken);

  try {
    console.log(`[Commands] Syncing ${commands.length} slash command(s) (this replaces any existing ones)...`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, CLAN_ID), { body: commands });
    console.log('[Commands] Slash commands synced successfully.');
  } catch (err) {
    if (err?.code === 50001) {
      console.error(
        [
          '[Commands] Discord rejected the command sync with Missing Access.',
          'Check that:',
          '- CLAN_ID is the Discord server ID where the bot is installed.',
          '- CLIENT_ID belongs to the same Discord application as DISCORD_BOT_TOKEN.',
          '- The bot was invited to that server with the applications.commands scope.',
        ].join('\n')
      );
    }
    console.error('[Commands] Failed to sync slash commands:', err);
  }
}

module.exports = { loadCommands, syncCommands };
