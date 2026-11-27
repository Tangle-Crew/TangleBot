const { commandDisabledReason } = require('../utils/commandAvailability');
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

// Every command whose required settings are set. Logs each one it skips.
function availableCommands(logPrefix = '[Commands]') {
  const commandsPath = path.join(__dirname, '..', 'commands');
  const available = [];
  for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
    const command = require(path.join(commandsPath, file));
    if (!command.data || !command.execute) continue;

    const disabledReason = commandDisabledReason(command);
    if (disabledReason) {
      console.log(`${logPrefix} Skipping /${command.data.name}: ${disabledReason}`);
      continue;
    }
    available.push(command);
  }
  return available;
}

function loadCommands(client) {
  for (const command of availableCommands()) client.commands.set(command.data.name, command);
  console.log(`[Commands] Loaded ${client.commands.size} command(s).`);
}

// Registers commands with the CLAN_ID server, replacing the ones there. Returns true if it worked.
async function registerCommands(commands, logPrefix = '[Commands]') {
  const { CLIENT_ID, CLAN_ID } = process.env;
  const discordBotToken = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
  if (!CLIENT_ID || !CLAN_ID || !discordBotToken) {
    console.warn(`${logPrefix} Skipping slash command registration: CLIENT_ID, CLAN_ID or DISCORD_BOT_TOKEN is not set.`);
    return false;
  }

  try {
    console.log(`${logPrefix} Registering ${commands.length} slash command(s) (this replaces any existing ones)...`);
    await new REST().setToken(discordBotToken).put(Routes.applicationGuildCommands(CLIENT_ID, CLAN_ID), {
      body: commands.map(command => command.data.toJSON()),
    });
    console.log(`${logPrefix} Slash commands registered.`);
    return true;
  } catch (err) {
    if (err?.code === 50001) {
      console.error(
        [
          `${logPrefix} Discord rejected the registration with Missing Access.`,
          'Check that:',
          '- CLAN_ID is the Discord server ID where the bot is installed.',
          '- CLIENT_ID belongs to the same Discord application as DISCORD_BOT_TOKEN.',
          '- The bot was invited to that server with the applications.commands scope.',
        ].join('\n')
      );
    }
    console.error(`${logPrefix} Failed to register slash commands:`, err);
    return false;
  }
}

// Registers the loaded commands. Runs on every startup.
function syncCommands(client) {
  return registerCommands([...client.commands.values()]);
}

module.exports = { availableCommands, loadCommands, registerCommands, syncCommands };
