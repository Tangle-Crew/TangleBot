const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const memberSync = require('../utils/memberSync');
const milestones = require('../utils/milestones');
const donationHighscore = require('./donationhighscore');
const petHighscore = require('./pethighscore');
const { codeBlock } = require('../utils/discordText');

const OWNER_ROLE_ID = process.env.OWNER_ROLE_ID;
const MAX_DIFFERENCES = 15;
const fmt = n => n.toLocaleString('en-US');

const EVENT_LABELS = {
  joined: 'joined the clan', left: 'left the clan', rank_changed: 'rank changes', name_changed: 'name changes',
};

function countLines(result) {
  const { counts, backfill, truncated } = result;
  const events = Object.entries(counts.events).filter(([, n]) => n > 0);
  const lines = [
    backfill ? 'First read: the whole WOM history.' : 'Read the recent WOM history.',
    `Accounts: ${fmt(counts.accountsNew)} new, ${fmt(counts.accountsChanged)} changed (${fmt(counts.accountsMarkedLeft)} now marked as left)`,
    `New events: ${events.length ? events.map(([kind, n]) => `${fmt(n)} ${EVENT_LABELS[kind] ?? kind}`).join(', ') : 'none'}`,
  ];
  if (counts.eventsSkipped) lines.push(`Skipped ${fmt(counts.eventsSkipped)} events for players WOM did not list.`);
  if (truncated) lines.push('Stopped at the page limit: run it again to read further back.');
  return lines;
}

const SUBCOMMANDS = {
  async status() {
    const { accounts, events } = await memberSync.memberDataStatus();
    return [
      `Accounts: ${fmt(accounts.total)} (${fmt(accounts.active)} in the group, ${fmt(accounts.left)} left, ${fmt(accounts.linked)} linked to a person)`,
      `Last synced: ${accounts.syncedAt ? accounts.syncedAt.toISOString() : 'never'}`,
      ...(events.length
        ? events.map(e => `  ${fmt(e.count)} ${EVENT_LABELS[e.kind] ?? e.kind}, newest ${e.newest ? e.newest.toISOString().slice(0, 10) : 'none'}`)
        : ['  No events yet.']),
      `Automatic sync: ${memberSync.syncIntervalMinutes() === 0 ? 'off' : `every ${memberSync.syncIntervalMinutes()} minutes, once the first sync has been run`}`,
    ];
  },

  async preview(interaction, groupId) {
    await interaction.editReply('Reading Wise Old Man (the first read can take a few minutes)...');
    const result = await memberSync.syncMembers({ apply: false, groupId });
    return ['Preview (nothing was saved):', ...countLines(result)];
  },

  async sync(interaction, groupId) {
    if (!interaction.options.getBoolean('confirm')) {
      return ['Nothing was synced. Run /memberdata preview first, then run this again with confirm set to True.'];
    }
    await interaction.editReply('Reading Wise Old Man (the first read can take a few minutes)...');
    const result = await memberSync.syncMembers({ apply: true, groupId });
    const check = await memberSync.verifyMembers({ groupId });
    return [
      'Synced:',
      ...countLines(result),
      check.differences.length ? `${check.differences.length} difference(s) from WOM afterwards (see /memberdata verify).` : 'Checked against WOM: no differences.',
    ];
  },

  async milestones(interaction) {
    const apply = Boolean(interaction.options.getBoolean('confirm'));
    const result = await milestones.backfillMilestones({
      tiers: donationHighscore.DONATION_TIERS,
      masterThreshold: petHighscore.PET_MASTER_THRESHOLD,
      apply,
    });
    const { counts, notes } = result;
    const lines = [
      apply ? 'Milestones saved from the donation and pet logs:' : 'Preview (nothing was saved). Milestones the donation and pet logs show:',
      `  ${fmt(counts.tierChanges)} donation tier changes`,
      `  ${fmt(counts.masterReached)} Pet Master reached, ${fmt(counts.masterLost)} Pet Master lost`,
    ];
    if (notes.importedBasis) lines.push(`${fmt(notes.importedBasis)} tier(s) were held at the sheets import: dated to the import, not to when they were reached.`);
    if (notes.alreadyMasterBeforeLog) lines.push(`${fmt(notes.alreadyMasterBeforeLog)} member(s) were already Pet Masters before their logged changes: no date is known for that.`);
    if (!apply) lines.push('Run again with confirm set to True to save them. Already saved milestones are never added twice.');
    return lines;
  },

  async verify(interaction, groupId) {
    const { differences, members } = await memberSync.verifyMembers({ groupId });
    if (!differences.length) return [`Verified: the ${fmt(members)} members in the WOM group match the saved accounts.`];
    const lines = [`${differences.length} difference(s) from the ${fmt(members)} members in the WOM group:`];
    lines.push(...differences.slice(0, MAX_DIFFERENCES).map(d => `  - ${d}`));
    if (differences.length > MAX_DIFFERENCES) lines.push(`  ... and ${differences.length - MAX_DIFFERENCES} more`);
    return lines;
  },
};

module.exports = {
  requiredEnv: ['DATABASE_URL', 'WOM_GROUP_ID', 'OWNER_ROLE_ID'],

  data: new SlashCommandBuilder()
    .setName('memberdata')
    .setDefaultMemberPermissions(0)
    .setDescription('Keep the member accounts and clan history in step with Wise Old Man (Owner only)')
    .addSubcommand(sub => sub.setName('status').setDescription('Show what is saved: accounts, history and when it last synced'))
    .addSubcommand(sub => sub.setName('preview').setDescription('Read Wise Old Man and show what a sync would change, without saving'))
    .addSubcommand(sub =>
      sub
        .setName('sync')
        .setDescription('Read Wise Old Man and save the accounts and history, then check them')
        .addBooleanOption(o => o.setName('confirm').setDescription('Set to True to save').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('milestones')
        .setDescription('Rebuild donation tier and Pet Master milestones from the logs (a preview unless confirmed)')
        .addBooleanOption(o => o.setName('confirm').setDescription('Set to True to save them'))
    )
    .addSubcommand(sub => sub.setName('verify').setDescription('Compare the saved accounts with the WOM group; writes nothing')),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (!OWNER_ROLE_ID || !interaction.member.roles.cache.has(OWNER_ROLE_ID)) {
      console.log(`[MemberData] ${interaction.user.tag} was denied /memberdata ${subcommand} (missing Owner role)`);
      interaction.commandDenied = true; // for the command log
      return interaction.reply({ content: 'Only the Owner role can use this command.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    console.log(`[MemberData] ${interaction.user.tag} ran /memberdata ${subcommand}`);

    try {
      const lines = await SUBCOMMANDS[subcommand](interaction, Number(process.env.WOM_GROUP_ID));
      await interaction.editReply(codeBlock(lines));
    } catch (err) {
      console.error(`[MemberData] /memberdata ${subcommand} failed:`, err);
      interaction.commandError = err; // for the command log
      await interaction.editReply(codeBlock([`/memberdata ${subcommand} failed: ${err.message}`]));
    }
  },
};
