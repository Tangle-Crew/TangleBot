const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getRows, updateRow, appendRow, parseAppendedRowNumber } = require('../utils/googleSheets');
const { DEFAULT_EMBED_COLOR } = require('../utils/embedColor');
const { withFileLock, intEnv } = require('../utils/db');
const { mentionOrName, postLeaderboard: postLeaderboardShared } = require('../utils/leaderboard');
const { notifyAdminLog } = require('../utils/roleMenu');

const TEMPLAR_ROLE_ID = process.env.TEMPLAR_ROLE_ID;

// Tab name from Tanglebot/example/donationhighscores_template.xlsx.
const SHEET_TAB = 'Donations';
const DATA_RANGE = `${SHEET_TAB}!A2:C`;
const APPEND_RANGE = `${SHEET_TAB}!A:C`;

// Highest tier first, so the first match is a total's highest tier. Tiers below it stack.
const DONATION_TIERS = [
  {
    name:      'Zenyte',
    threshold: intEnv('DONATION_ZENYTE_THRESHOLD', 1_000_000_000),
    roleEnv:   'DONATION_ZENYTE_ROLE_ID',
    emoji:     '<:Zenyte:1534398798384861214>',
  },
  {
    name:      'Onyx',
    threshold: intEnv('DONATION_ONYX_THRESHOLD', 600_000_000),
    roleEnv:   'DONATION_ONYX_ROLE_ID',
    emoji:     '<:Onyx:1534398660916543661>',
  },
  {
    name:      'Dragonstone',
    threshold: intEnv('DONATION_DRAGONSTONE_THRESHOLD', 300_000_000),
    roleEnv:   'DONATION_DRAGONSTONE_ROLE_ID',
    emoji:     '<:Dragonstone:1534398539201904700>',
  },
  {
    name:      'Diamond',
    threshold: intEnv('DONATION_DIAMOND_THRESHOLD', 150_000_000),
    roleEnv:   'DONATION_DIAMOND_ROLE_ID',
    emoji:     '<:Diamond:1534398533074157568>',
  },
  {
    name:      'Ruby',
    threshold: intEnv('DONATION_RUBY_THRESHOLD', 75_000_000),
    roleEnv:   'DONATION_RUBY_ROLE_ID',
    emoji:     '<:Ruby:1534398699961188533>',
  },
];

function highestTierFor(donated) {
  return DONATION_TIERS.find(t => donated >= t.threshold) || null;
}

// withFileLock key (not a file) serializing edits to the donations sheet.
const DONATION_LOCK_KEY = 'donations-sheet';

// Parses "300M", "10.1m", "75,000,000", etc. Returns null if unreadable.
function parseDonationAmount(raw) {
  const str = String(raw).trim().toUpperCase().replace(/,/g, '');
  const m = str.match(/^([\d.]+)([KMBT]?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  const suffix = m[2];
  if (suffix === 'K') return Math.round(n * 1_000);
  if (suffix === 'M') return Math.round(n * 1_000_000);
  if (suffix === 'B') return Math.round(n * 1_000_000_000);
  if (suffix === 'T') return Math.round(n * 1_000_000_000_000);
  return Math.round(n);
}

function formatGP(amount) {
  return amount.toLocaleString('en-US');
}

const COINS_EMOJI = '<:coins:1534943128145105158>';
const HEADER_TITLE = `${COINS_EMOJI} How to Get on the Leaderboard ${COINS_EMOJI}`;
const EMBED_COLOR = DEFAULT_EMBED_COLOR;

// The donor's highest tier emoji, or '' if none.
function donorBadge(entry) {
  const tier = highestTierFor(entry.donated);
  return tier ? tier.emoji : '';
}

// Instructions embed shown above the leaderboard. The title is a "# " heading in the description
// so it renders larger than an embed title can.
function buildHeaderEmbed() {
  const templarMention = TEMPLAR_ROLE_ID ? `<@&${TEMPLAR_ROLE_ID}>` : '@Templar';

  return new EmbedBuilder()
    .setDescription(
      [
        `# ${HEADER_TITLE}`,
        '',
        'This is a list of donations to the clan! To make a donation, please reach out to ' +
          `${templarMention} directly, or add straight to the clan coffer in the Clan Hall and ` +
          `send a screenshot of your donation to ${templarMention} to get added or updated.`,
      ].join('\n')
    )
    .setColor(EMBED_COLOR);
}

// The leaderboard heading shows the combined total.
function totalDonatedHeading(totalDonated) {
  return `${COINS_EMOJI} Total Donated: ${formatGP(totalDonated)} ${COINS_EMOJI}`;
}

function buildEmbeds(entries) {
  const header = buildHeaderEmbed();

  if (entries.length === 0) {
    return [
      header,
      new EmbedBuilder()
        .setDescription(`# ${totalDonatedHeading(0)}\n\nNo donations logged yet.`)
        .setColor(EMBED_COLOR),
    ];
  }

  const totalDonated = entries.reduce((sum, e) => sum + e.donated, 0);
  const heading = totalDonatedHeading(totalDonated);

  // entries is sorted highest first; the top donor gets "# ", everyone else "### ".
  const blocks = entries.map((entry, i) => {
    const badge = donorBadge(entry);
    const namePart = mentionOrName(entry);
    const line = badge
      ? `${badge} ${namePart} | **${formatGP(entry.donated)}**`
      : `${namePart} | **${formatGP(entry.donated)}**`;
    return i === 0 ? `# ${line}` : `### ${line}`;
  });

  const bodies = [];
  let current = '';
  for (const block of blocks) {
    const candidate = current ? `${current}\n${block}` : block;
    if (candidate.length > 3900) {
      bodies.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) bodies.push(current);

  return [
    header,
    ...bodies.map((body) =>
      new EmbedBuilder()
        .setDescription(`# ${heading}\n\n${body}`)
        .setColor(EMBED_COLOR)
    ),
  ];
}

// Recognizes this leaderboard's messages: both embeds start with "# " and the coins emoji.
function isOwnLeaderboardMessage(embed) {
  return embed?.description?.startsWith(`# ${COINS_EMOJI}`);
}

async function postLeaderboard(guild, channelId, entries, botUserId) {
  return postLeaderboardShared(guild, channelId, entries, botUserId, {
    buildEmbeds,
    dataFile: 'donationhighscores_message.json',
    logPrefix: 'DHS',
    isOwnLeaderboardMessage,
    onDisplayNameChange: async (entry) => {
      try {
        await updateRow(
          process.env.DONATIONS_SHEET_ID,
          `${SHEET_TAB}!A${entry.rowNumber}:C${entry.rowNumber}`,
          [entry.discordId, entry.displayName, entry.donated]
        );
        console.log(`[DHS] Refreshed stored display name for ${entry.discordId} -> "${entry.displayName}"`);
      } catch (err) {
        console.error(`[DHS] Failed to persist refreshed display name for ${entry.discordId}:`, err);
      }
    },
  });
}

async function loadEntries() {
  console.log('[DHS] Fetching donation entries from sheet');
  const rows = await getRows(process.env.DONATIONS_SHEET_ID, DATA_RANGE);
  return rows
    .map((r, i) => ({
      rowNumber: i + 2, // header row + 1-indexed; set before filtering out blank rows
      discordId: r[0] ? String(r[0]).trim() : '',
      displayName: r[1] ? String(r[1]).trim() : '',
      donated: r[2] ? parseInt(String(r[2]).replace(/,/g, '').trim(), 10) || 0 : 0,
    }))
    .filter(e => e.discordId);
}

function sortedForDisplay(entries) {
  return entries
    .filter(e => e.donated > 0)
    .sort((a, b) => b.donated - a.donated || a.displayName.localeCompare(b.displayName));
}

// Reposts the leaderboard from the sheet. Runs on startup and from /refreshboards. Returns false
// if the leaderboard isn't configured; errors are thrown to the caller.
async function refreshLeaderboard(client) {
  const channelId = process.env.DONATIONS_CHANNEL_ID;
  if (!process.env.DONATIONS_SHEET_ID || !channelId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return false;

  const guild = await client.guilds.fetch(process.env.CLAN_ID);
  // Locked because the display-name refresh writes rows too.
  await withFileLock(DONATION_LOCK_KEY, async () => {
    const entries = await loadEntries();
    await postLeaderboard(guild, channelId, sortedForDisplay(entries), client.user.id);
  });
  return true;
}

// Grants the tier roles the new total qualifies for and removes the rest. Returns { tier } if the
// highest tier changed (tier null if none now), otherwise null.
async function syncDonationRoles(guild, discordId, previousDonated, newDonated) {
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) {
    console.warn(`[DHS] Could not fetch member ${discordId} to sync donation tier roles`);
    return null;
  }

  const highestIndex = DONATION_TIERS.findIndex(t => newDonated >= t.threshold);

  for (let i = 0; i < DONATION_TIERS.length; i++) {
    const tier = DONATION_TIERS[i];
    const roleId = process.env[tier.roleEnv];
    if (!roleId) continue;

    const role = guild.roles.cache.get(roleId);
    if (!role) {
      console.warn(`[DHS] ${tier.roleEnv} (${roleId}) not found in this guild`);
      continue;
    }

    const qualifies = highestIndex !== -1 && i >= highestIndex;
    const hasRole = member.roles.cache.has(roleId);

    if (qualifies && !hasRole) {
      await member.roles.add(role);
      console.log(`[DHS] Granted ${tier.name} donation role to ${member.user.tag}`);
    } else if (!qualifies && hasRole) {
      await member.roles.remove(role);
      console.log(`[DHS] Removed ${tier.name} donation role from ${member.user.tag}`);
    }
  }

  const prevTier = highestTierFor(previousDonated);
  const newTier = highestTierFor(newDonated);
  return prevTier?.name !== newTier?.name ? { tier: newTier } : null;
}

module.exports = {
  requiredEnv: ['DONATIONS_SHEET_ID', 'DONATIONS_CHANNEL_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON'],
  refreshLeaderboard,

  data: new SlashCommandBuilder()
    .setName('donationhighscore')
    .setDescription('Manage the donation high scores leaderboard')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription("Add to a member's donation total")
        .addUserOption(o => o.setName('player').setDescription('Member who donated').setRequired(true))
        .addStringOption(o =>
          o.setName('amount').setDescription('Amount donated, e.g. 10m, 10k, 1b, 10.1m, or a raw number').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription("Remove from a member's donation total (for fixing mistakes)")
        .addUserOption(o => o.setName('player').setDescription('Member to adjust').setRequired(true))
        .addStringOption(o =>
          o.setName('amount').setDescription('Amount to subtract, e.g. 10m, 10k, 1b, 10.1m, or a raw number').setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (TEMPLAR_ROLE_ID && !interaction.member.roles.cache.has(TEMPLAR_ROLE_ID)) {
      console.log(`[DHS] ${interaction.user.tag} was denied /donationhighscore ${subcommand} (missing Templar role)`);
      return interaction.reply({
        content: 'You need the Templar role to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const sheetId = process.env.DONATIONS_SHEET_ID;
    const channelId = process.env.DONATIONS_CHANNEL_ID;

    const targetUser = interaction.options.getUser('player', true);
    const amountInput = interaction.options.getString('amount', true);
    const amount = parseDonationAmount(amountInput);

    if (amount === null || amount <= 0) {
      console.warn(`[DHS] ${interaction.user.tag} submitted invalid amount "${amountInput}" for /donationhighscore ${subcommand}`);
      return interaction.reply({
        content: `Couldn't read a donation amount from "${amountInput}" — use a raw number or shorthand like \`10m\`, \`10k\`, \`1b\`, or \`10.1m\`.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const guild = interaction.guild;
      const member = await guild.members.fetch(targetUser.id).catch(() => null);
      if (!member) console.warn(`[DHS] Could not fetch member ${targetUser.id} (${targetUser.tag}) — falling back to username`);
      const displayName = member?.displayName || targetUser.username;

      const { currentAmount, newAmount, clamped, noDonationsLogged } = await withFileLock(DONATION_LOCK_KEY, async () => {
        const loadedEntries = await loadEntries();
        const existingIndex = loadedEntries.findIndex(e => e.discordId === targetUser.id);
        const existing = existingIndex === -1 ? null : loadedEntries[existingIndex];
        const currentAmount = existing ? existing.donated : 0;

        if (subcommand === 'remove' && currentAmount === 0) {
          return { currentAmount, newAmount: currentAmount, clamped: false, noDonationsLogged: true };
        }

        let clamped = false;
        let newAmount;
        if (subcommand === 'add') {
          newAmount = currentAmount + amount;
        } else {
          newAmount = currentAmount - amount;
          if (newAmount < 0) {
            clamped = true;
            newAmount = 0;
          }
        }

        const rowValues = [targetUser.id, displayName, newAmount];

        if (existing) {
          await updateRow(sheetId, `${SHEET_TAB}!A${existing.rowNumber}:C${existing.rowNumber}`, rowValues);
          loadedEntries[existingIndex] = { ...existing, displayName, donated: newAmount };
        } else {
          const appendResult = await appendRow(sheetId, APPEND_RANGE, rowValues);
          const rowNumber = parseAppendedRowNumber(appendResult?.updates?.updatedRange);
          loadedEntries.push({ discordId: targetUser.id, displayName, donated: newAmount, rowNumber });
        }

        // Inside the lock so posts land in write order. A failed post doesn't abort the command.
        try {
          await postLeaderboard(guild, channelId, sortedForDisplay(loadedEntries), interaction.client.user.id);
        } catch (err) {
          console.error('[DHS] Failed to update leaderboard post after a donation edit:', err.message);
        }

        return { currentAmount, newAmount, clamped };
      });

      if (noDonationsLogged) {
        console.log(`[DHS] ${interaction.user.tag} tried to remove from ${targetUser.tag}, who has no donations logged`);
        return interaction.editReply(`<@${targetUser.id}> doesn't have any donations logged.`);
      }

      if (subcommand === 'add') {
        console.log(`[DHS] ${interaction.user.tag} added ${formatGP(amount)} to ${targetUser.tag} (now ${formatGP(newAmount)})`);
        notifyAdminLog(
          interaction.client,
          '💰 Donation Added',
          `${interaction.user} has added **${formatGP(amount)}** GP donation to ${targetUser}. New total: **${formatGP(newAmount)}** GP.`,
          [],
          EMBED_COLOR
        );
      } else {
        console.log(`[DHS] ${interaction.user.tag} removed ${formatGP(amount)} from ${targetUser.tag} (now ${formatGP(newAmount)})`);
        if (clamped) console.warn(`[DHS] ${targetUser.tag}'s total would have gone negative — clamped to 0`);
        notifyAdminLog(
          interaction.client,
          '💰 Donation Removed',
          `${interaction.user} has removed **${formatGP(amount)}** GP donation from ${targetUser}. New total: **${formatGP(newAmount)}** GP.`,
          [],
          EMBED_COLOR
        );
      }

      const tierChange = await syncDonationRoles(guild, targetUser.id, currentAmount, newAmount);

      const verb = subcommand === 'add' ? 'Added' : 'Removed';
      const prep = subcommand === 'add' ? 'to' : 'from';
      let summary = `${verb} **${formatGP(amount)}** ${prep} <@${targetUser.id}>'s donation total. They now have **${formatGP(newAmount)}** GP donated.`;
      if (clamped) summary += ' (Clamped at 0 — they had less than that logged.)';

      if (tierChange) {
        summary += tierChange.tier
          ? `\n<@${targetUser.id}> is now at the **${tierChange.tier.name}** donation tier — roles updated.`
          : `\n<@${targetUser.id}> dropped below every donation tier and lost their tier role(s).`;
      }

      await interaction.editReply(summary);
    } catch (err) {
      console.error('[DHS] Fatal error:', err);
      await interaction.editReply(`Error: ${err.message}`);
    }
  },
};
