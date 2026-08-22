const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

function loadCommands(client) {
  const commandsPath = path.join(__dirname, '..', 'commands');
  const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

  for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    if (!command.data || !command.execute) continue;

    if (command.requiredEnv) {
      const missing = command.requiredEnv.filter(k => !process.env[k]);
      if (missing.length > 0) {
        console.log(`Skipping /${command.data.name}: missing env var(s): ${missing.join(', ')}`);
        continue;
      }
    }

    if (command.requiredEnvAny && !command.requiredEnvAny.some(k => process.env[k])) {
      console.log(`Skipping /${command.data.name}: none of the env var(s) set: ${command.requiredEnvAny.join(', ')}`);
      continue;
    }

    client.commands.set(command.data.name, command);
  }

  console.log(`Loaded ${client.commands.size} command(s).`);
}

async function syncCommands(client) {
  const { CLIENT_ID, CLAN_ID } = process.env;
  const discordBotToken = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
  if (!CLIENT_ID || !CLAN_ID) {
    console.warn('Skipping slash command sync: CLIENT_ID and/or CLAN_ID is not set.');
    return;
  }

  const commands = client.commands.map(command => command.data.toJSON());
  const rest = new REST().setToken(discordBotToken);

  try {
    console.log(`Syncing ${commands.length} slash command(s) (this replaces any existing ones)...`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, CLAN_ID), { body: commands });
    console.log('Slash commands synced successfully.');
  } catch (err) {
    if (err?.code === 50001) {
      console.error(
        [
          'Discord rejected the command sync with Missing Access.',
          'Check that:',
          '- CLAN_ID is the Discord server ID where the bot is installed.',
          '- CLIENT_ID belongs to the same Discord application as DISCORD_BOT_TOKEN.',
          '- The bot was invited to that server with the applications.commands scope.',
        ].join('\n')
      );
    }
    console.error('Failed to sync slash commands:', err);
  }
}

module.exports = { loadCommands, syncCommands };
