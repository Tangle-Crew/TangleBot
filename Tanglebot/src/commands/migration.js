const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const tools = require('../utils/migrationTools');
const { codeBlock } = require('../utils/discordText');
const petHighscore = require('./pethighscore');
const donationHighscore = require('./donationhighscore');

const OWNER_ROLE_ID = process.env.OWNER_ROLE_ID;
const MAX_WARNINGS = 15;

// Only loaded while both the database and the sheets are configured, so retiring either one
// removes the command. OWNER_ROLE_ID is required, so it fails closed.
const REQUIRED_ENV = [
  'DATABASE_URL', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'DONATIONS_SHEET_ID', 'PET_HIGHSCORES_SHEET_ID', 'OWNER_ROLE_ID',
];

const fmt = n => n.toLocaleString('en-US');

function connectionLines(info) {
  return [
    `Connected: ${info.server}, database "${info.database}" as "${info.user}" (${info.ms} ms)`,
    `Migrations applied: ${info.applied.length ? info.applied.join(', ') : 'none'}`,
    `Migrations pending: ${info.pending.length ? `${info.pending.join(', ')} (applied on the next restart)` : 'none'}`,
  ];
}

function sheetLines(s) {
  return [
    'Read the sheets:',
    `  Donations tab: ${fmt(s.donors)} members, ${fmt(s.gp)} GP`,
    `  Highscores tab: ${fmt(s.collectors)} members, ${fmt(s.pets)} pets owned`,
    `  Pets tab: ${fmt(s.catalog)} pets in the catalog`,
    s.unknownKeys.length
      ? `  Pet keys missing from the catalog (the import skips them): ${s.unknownKeys.join(', ')}`
      : '  Every pet key is in the catalog.',
  ];
}

function statusLines(s) {
  return [
    'Database:',
    `  Donations: ${fmt(s.donors)} members, ${fmt(s.gp)} GP`,
    `  Pets: ${fmt(s.collectors)} members, ${fmt(s.pets)} pets owned, ${fmt(s.catalog)} in the catalog`,
    `  Members stored: ${fmt(s.members)}`,
    `  Last import: ${s.lastImport ? s.lastImport.toISOString() : 'never'}`,
    `  Donation changes made by commands or by hand: ${fmt(s.changesSinceImport)}`,
  ];
}

// A log function that keeps its lines, so warnings can be shown in the reply.
function collect() {
  const warnings = [];
  return { warnings, log: message => warnings.push(String(message)) };
}

function warningLines(warnings) {
  const shown = warnings.filter(w => /^Warning/.test(w));
  if (!shown.length) return [];
  const lines = shown.slice(0, MAX_WARNINGS);
  if (shown.length > MAX_WARNINGS) lines.push(`... and ${shown.length - MAX_WARNINGS} more warnings (see the bot log)`);
  return ['', ...lines];
}

function importLines({ summary, verification }, warnings) {
  const lines = [];
  tools.printSummary(summary, m => lines.push(m));
  lines.push(...warningLines(warnings), '');
  tools.printVerification(verification, m => lines.push(m));
  return lines.filter((line, i) => line !== '' || lines[i - 1] !== '');
}

const SUBCOMMANDS = {
  async dbconnection() {
    return connectionLines(await tools.testConnection());
  },

  async sheets() {
    const { log } = collect();
    return sheetLines(tools.describeSheets(await tools.readSheets(log)));
  },

  async status() {
    return statusLines(await tools.databaseStatus());
  },

  async verify() {
    const { log } = collect();
    const verification = await tools.runVerify({ log });
    const lines = [];
    tools.printVerification(verification, m => lines.push(m));
    return lines;
  },

  async dryrun() {
    const { warnings, log } = collect();
    const result = await tools.runImport({ dryRun: true, log });
    return ['Dry run (nothing was saved):', ...importLines(result, warnings)];
  },

  async import(interaction) {
    if (!interaction.options.getBoolean('confirm')) {
      return ['Nothing was imported. Run /migration dryrun first, then run this again with confirm set to True.'];
    }
    const { warnings, log } = collect();
    const result = await tools.runImport({ log });
    const lines = ['Imported:', ...importLines(result, warnings)];

    // The running bot still holds the empty catalog and member lists, so repost the boards from the data.
    for (const [label, board] of [['Pet high scores', petHighscore], ['Donation high scores', donationHighscore]]) {
      try {
        const done = await board.refreshLeaderboard(interaction.client);
        lines.push(done ? `${label} reposted.` : `${label} not reposted (channel not set up).`);
      } catch (err) {
        lines.push(`${label} not reposted: ${err.message}`);
      }
    }
    return lines;
  },
};

module.exports = {
  // Shown in the admin commands post.
  help: {
    category: 'Bot admin',
    access: 'Owner',
    examples: {
      dbconnection: '/migration dbconnection',
      sheets: '/migration sheets',
      status: '/migration status',
      dryrun: '/migration dryrun',
      import: '/migration import confirm:true',
      verify: '/migration verify',
    },
    options: {
      confirm: 'true to run the import',
    },
  },
  requiredEnv: REQUIRED_ENV,

  data: new SlashCommandBuilder()
    .setName('migration')
    .setDefaultMemberPermissions(0)
    .setDescription('Move the donation and pet sheets into the database (Owner only)')
    .addSubcommand(sub => sub.setName('dbconnection').setDescription('Test the connection to the database and show its migrations'))
    .addSubcommand(sub => sub.setName('sheets').setDescription('Test reading the Google Sheets and show what they hold'))
    .addSubcommand(sub => sub.setName('status').setDescription('Show what the database holds now'))
    .addSubcommand(sub => sub.setName('dryrun').setDescription('Run the import and check it, then undo it'))
    .addSubcommand(sub =>
      sub
        .setName('import')
        .setDescription('Import the sheets into the database, check it, and repost the leaderboards')
        .addBooleanOption(o => o.setName('confirm').setDescription('Set to True to run the import').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('verify').setDescription('Compare the sheets with the database member by member')),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (!OWNER_ROLE_ID || !interaction.member.roles.cache.has(OWNER_ROLE_ID)) {
      console.log(`[Migration] ${interaction.user.tag} was denied /migration ${subcommand} (missing Owner role)`);
      interaction.commandDenied = true; // for the command log
      return interaction.reply({ content: 'Only the Owner role can use this command.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    console.log(`[Migration] ${interaction.user.tag} ran /migration ${subcommand}`);

    try {
      const lines = await SUBCOMMANDS[subcommand](interaction);
      await interaction.editReply(codeBlock(lines));
    } catch (err) {
      console.error(`[Migration] /migration ${subcommand} failed:`, err);
      interaction.commandError = err; // for the command log
      await interaction.editReply(codeBlock([`/migration ${subcommand} failed: ${err.message}`]));
    }
  },
};
