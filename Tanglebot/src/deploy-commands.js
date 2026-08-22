require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const discordBotToken = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
const REQUIRED_ENV_KEYS = ['CLIENT_ID', 'CLAN_ID'];

const missingEnv = REQUIRED_ENV_KEYS.filter(key => !process.env[key]);
if (!discordBotToken) {
  missingEnv.unshift('DISCORD_BOT_TOKEN');
}
if (missingEnv.length > 0) {
  throw new Error(`Missing required deploy environment variable(s): ${missingEnv.join(', ')}. Copy Tanglebot/.env.example to Tanglebot/.env and fill in real values.`);
}

const commands = [];
const commandsPath = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  if (command.data) commands.push(command.data.toJSON());
}

const rest = new REST().setToken(discordBotToken);

(async () => {
  try {
    console.log(`Deploying ${commands.length} slash command(s)...`);
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.CLAN_ID),
      { body: commands }
    );
    console.log('Slash commands deployed successfully.');
  } catch (err) {
    if (err?.code === 50001) {
      console.error(
        [
          'Discord rejected the command deploy with Missing Access.',
          'Check that:',
          '- CLAN_ID is the Discord server ID where the bot is installed.',
          '- CLIENT_ID belongs to the same Discord application as DISCORD_BOT_TOKEN.',
          '- The bot was invited to that server with the applications.commands scope.',
          '- You have permission to add/manage the bot in that server.',
        ].join('\n')
      );
    }
    console.error(err);
  }
})();
