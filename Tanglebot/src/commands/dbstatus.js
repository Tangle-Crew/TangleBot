const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const dbStatus = require('../utils/dbStatus');
const dbHealth = require('../utils/dbHealth');
const { withTimeout, discordTimestamp, formatNumber } = require('../utils/common');
const { refuseWithoutRole } = require('../utils/roleCheck');
const { ALERT_COLOR, SUCCESS_COLOR } = require('../utils/embedColor');

// How long the connection check and the row counts may take (changed by the tests).
const timeouts = { connectMs: 5000, countsMs: 10_000 };

const fmt = formatNumber;
const ago = ms => discordTimestamp(ms, 'R');

function connectionField(info) {
  return [
    `Reachable, round trip ${fmt(info.ms)} ms`,
    `${info.server}`,
    `Database \`${info.database}\` as \`${info.user}\``,
    `Host \`${info.host}\``,
  ].join('\n');
}

function migrationsField(info) {
  return [
    `${fmt(info.applied.length)} applied${info.applied.length ? `, latest \`${info.applied.at(-1)}\`` : ''}`,
    `Pending: ${info.pending.length ? `${info.pending.map(f => `\`${f}\``).join(', ')} (applied on the next restart)` : 'none'}`,
  ].join('\n');
}

function monitorField(state) {
  if (!state) return 'Not running (`DB_HEALTH_CHECK_SECONDS` is 0)';
  const lines = [];
  lines.push(state.lastCheckAt ? `Last check ${ago(state.lastCheckAt)}: **${state.status}**` : 'No check yet');
  if (state.status === 'down') {
    lines.push(`Down since ${ago(state.downSince)} (${fmt(state.failures)} failed checks; alert after ${fmt(state.failuresBeforeAlert)})`);
  } else if (state.lastOutage) {
    lines.push(`Last outage ${ago(state.lastOutage.end)}, lasted ${dbHealth.formatDuration(state.lastOutage.end - state.lastOutage.start)}`);
  } else {
    lines.push('No outage since the bot started');
  }
  lines.push(`Checks every ${fmt(state.intervalSeconds)} s`);
  return lines.join('\n');
}

function poolField(pool) {
  return `${fmt(pool.total)} open, ${fmt(pool.idle)} idle, ${fmt(pool.waiting)} waiting`;
}

function dataField(c) {
  return [
    `Members: ${fmt(c.members)}`,
    `Donors: ${fmt(c.donors)}, ${fmt(c.gp)} GP in total`,
    `Collectors: ${fmt(c.collectors)}, ${fmt(c.petsOwned)} pets owned, ${fmt(c.catalog)} in the catalog`,
    `Logs: ${fmt(c.donationLog)} donation, ${fmt(c.petLog)} pet`,
    `Accounts: ${fmt(c.accounts)}, member events: ${fmt(c.memberEvents)}, competitions: ${fmt(c.competitions)}`,
    `Command log: ${fmt(c.commandLog)} rows${c.commandLogOldest ? `, oldest ${discordTimestamp(c.commandLogOldest, 'D')}` : ''}`,
    `Honeypot incidents: ${fmt(c.honeypotIncidents)}`,
    `Database size: ${(c.sizeBytes / 1024 / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`,
  ].join('\n');
}

module.exports = {
  timeouts,
  // Shown in the admin commands post.
  help: {
    category: 'Bot admin',
    access: 'Owner',
    examples: { '': '/dbstatus' },
  },
  requiredEnv: ['DATABASE_URL', 'OWNER_ROLE_ID'],

  data: new SlashCommandBuilder()
    .setName('dbstatus')
    .setDefaultMemberPermissions(0)
    .setDescription('Show the database connection, migrations, health monitor and row counts (Owner only)'),

  async execute(interaction) {
    if (await refuseWithoutRole(interaction, [process.env.OWNER_ROLE_ID], {
      logPrefix: '[DbStatus]', command: '/dbstatus', missing: 'missing Owner role',
      message: 'Only the Owner role can use this command.',
    })) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    console.log(`[DbStatus] ${interaction.user.tag} ran /dbstatus`);

    const embed = new EmbedBuilder().setTitle('🗄️ Database status').setTimestamp();
    const monitor = monitorField(dbHealth.getState());
    let pool = 'Unknown';
    try {
      pool = poolField(dbStatus.poolStats());
    } catch (err) {
      pool = `Unknown: ${err.message}`;
    }

    let info;
    try {
      info = await withTimeout(dbStatus.testConnection(), 'The database connection', timeouts.connectMs);
    } catch (err) {
      console.error('[DbStatus] Connection check failed:', err.message);
      interaction.commandError = err; // for the command log
      embed.setColor(ALERT_COLOR).addFields(
        { name: 'Connection', value: `**Not reachable:** ${dbHealth.describeDbError(err)}\n\`${String(err.message).slice(0, 300)}\`` },
        { name: 'Health monitor', value: monitor },
        { name: 'Connection pool', value: pool },
      );
      return interaction.editReply({ embeds: [embed] });
    }

    let data;
    try {
      data = dataField(await withTimeout(dbStatus.tableCounts(), 'Reading the row counts', timeouts.countsMs));
    } catch (err) {
      console.error('[DbStatus] Row counts failed:', err.message);
      interaction.commandError = err; // for the command log
      data = `Could not read the row counts: ${String(err.message).slice(0, 300)}`;
    }

    embed.setColor(interaction.commandError ? ALERT_COLOR : SUCCESS_COLOR).addFields(
      { name: 'Connection', value: connectionField(info) },
      { name: 'Migrations', value: migrationsField(info) },
      { name: 'Health monitor', value: monitor },
      { name: 'Connection pool', value: pool },
      { name: 'Data', value: data },
    );
    return interaction.editReply({ embeds: [embed] });
  },
};
