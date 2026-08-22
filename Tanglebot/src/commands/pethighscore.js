const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getRows, updateRow, appendRow } = require('../utils/googleSheets');
const { DEFAULT_EMBED_COLOR } = require('../utils/embedColor');
const { mentionOrName, postLeaderboard: postLeaderboardShared } = require('../utils/leaderboard');
const { notifyAdminLog } = require('../utils/roleMenu');

const TEMPLAR_ROLE_ID = process.env.TEMPLAR_ROLE_ID;
const OWNER_ROLE_ID = process.env.OWNER_ROLE_ID;
const PET_MASTER_THRESHOLD = parseInt(process.env.PET_MASTER_THRESHOLD ?? '10', 10);

// Fixed tab names matching Tanglebot/example/pethighscores_template.xlsx —
// the setup docs have users copy that file as their sheet, so these aren't
// configurable.
const SHEET_TAB = 'Highscores';
const DATA_RANGE = `${SHEET_TAB}!A2:C`;
const APPEND_RANGE = `${SHEET_TAB}!A:C`;

const PET_CATALOG_SHEET_TAB = 'Pets';
const PET_CATALOG_RANGE = `${PET_CATALOG_SHEET_TAB}!A2:C`;
const PET_CATALOG_APPEND_RANGE = `${PET_CATALOG_SHEET_TAB}!A:C`;

let PETS = [];
const PET_BY_KEY = new Map();
const PET_ORDER = new Map();

// New pets are appended to the end of PETS, so indexes need refreshing.
function rebuildPetIndexes() {
  PET_BY_KEY.clear();
  PET_ORDER.clear();
  PETS.forEach((p, i) => {
    PET_BY_KEY.set(p.key, p);
    PET_ORDER.set(p.key, i);
  });
}

// Cached so autocomplete keystrokes and command runs reuse the same PETS
// array instead of re-fetching; a restart re-reads from the sheet.
let petsLoadPromise = null;
function ensurePetsLoaded() {
  if (!petsLoadPromise) {
    petsLoadPromise = getRows(process.env.PET_HIGHSCORES_SHEET_ID, PET_CATALOG_RANGE)
      .then(rows => {
        PETS = rows
          .filter(r => r[0])
          .map(r => ({
            key: String(r[0]).trim(),
            name: String(r[1] || '').trim(),
            emojiId: String(r[2] || '').trim(),
          }));
        rebuildPetIndexes();
      })
      .catch(err => {
        petsLoadPromise = null; // retry next call instead of caching the failure
        console.error('[PHS] Failed to load pet catalog from the Pets sheet tab:', err);
        throw err;
      });
  }
  return petsLoadPromise;
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Accepts a pasted custom emoji (<:name:id> / <a:name:id>) or a bare numeric ID.
function parseEmojiId(input) {
  const raw = String(input).trim();
  const mentionMatch = raw.match(/^<a?:\w+:(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  if (/^\d{15,25}$/.test(raw)) return raw;
  return null;
}

function findPet(input) {
  const raw = String(input).trim();
  if (PET_BY_KEY.has(raw)) return PET_BY_KEY.get(raw);
  const lower = raw.toLowerCase();
  return PETS.find(p => p.name.toLowerCase() === lower) || null;
}

// Placeholder emoji if the pet's EmojiID isn't set yet on the Pets tab.
function petEmoji(pet) {
  if (!pet || !pet.emojiId) return '❔';
  return `<:${pet.key}:${pet.emojiId}>`;
}

// Keeps each member's pets ordered per the Pets tab, not logging order.
function sortPetKeys(keys) {
  return [...keys].sort((a, b) => (PET_ORDER.get(a) ?? 999) - (PET_ORDER.get(b) ?? 999));
}

const ROCK_EMOJI = '<:Rock:1534395676421521601>';
const LEADERBOARD_TITLE = `${ROCK_EMOJI} Pet High Scores ${ROCK_EMOJI}`;
const HEADER_TITLE = `${ROCK_EMOJI} How to Get on the Leaderboard ${ROCK_EMOJI}`;
const EMBED_COLOR = DEFAULT_EMBED_COLOR;
const RANK_MEDALS = ['🥇', '🥈', '🥉'];

// Static instructions embed, prepended to the leaderboard on every post.
function buildHeaderEmbed() {
  const templarMention = TEMPLAR_ROLE_ID ? `<@&${TEMPLAR_ROLE_ID}>` : '@Templar';
  const masterRoleId = process.env.PET_MASTER_ROLE_ID;
  const masterMention = masterRoleId ? `<@&${masterRoleId}>` : 'Pet Master';

  return new EmbedBuilder()
    .setTitle(HEADER_TITLE)
    .setDescription(
      [
        'This is a list of pets that people have in the clan! If you want to add your list here, ' +
          `please ping ${templarMention} with a screenshot of your full pet collection log, or a ` +
          'screenshot of you getting a pet, to get added or updated.',
        '',
        'If you have multiple accounts, please only submit your main account — or whichever account ' +
          'you want on the high scores.',
        '',
        `If you have ${PET_MASTER_THRESHOLD}+ pets you'll also receive the ${masterMention} role!`,
      ].join('\n')
    )
    .setColor(EMBED_COLOR);
}

// The "# " markdown heading renders emoji noticeably larger than plain text.
function buildEmbeds(entries) {
  const header = buildHeaderEmbed();

  if (entries.length === 0) {
    return [
      header,
      new EmbedBuilder()
        .setTitle(LEADERBOARD_TITLE)
        .setDescription('No pets logged yet.')
        .setColor(EMBED_COLOR),
    ];
  }

  // entries is already sorted highest-first, so index doubles as rank.
  const blocks = entries.map((entry, i) => {
    const emojiLine = entry.petKeys.map(k => petEmoji(PET_BY_KEY.get(k))).join(' ');
    const petWord = entry.count === 1 ? 'pet' : 'pets';
    const medal = RANK_MEDALS[i] ? `${RANK_MEDALS[i]} ` : '';
    return `${medal}${mentionOrName(entry)} | **${entry.count}** ${petWord}\n# ${emojiLine}`;
  });

  const descriptions = [];
  let current = '';
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > 3900) {
      descriptions.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) descriptions.push(current);

  return [
    header,
    ...descriptions.map((desc) =>
      new EmbedBuilder()
        .setTitle(LEADERBOARD_TITLE)
        .setDescription(desc)
        .setColor(EMBED_COLOR)
    ),
  ];
}

// Identifies this leaderboard's own post during history-scan recovery — message 0 leads with the
// header embed instead of the leaderboard title, so both are matched.
function isOwnLeaderboardMessage(embed) {
  const title = embed?.title;
  return title === HEADER_TITLE || title?.startsWith(LEADERBOARD_TITLE);
}

async function postLeaderboard(guild, channelId, entries, botUserId) {
  return postLeaderboardShared(guild, channelId, entries, botUserId, {
    buildEmbeds,
    dataFile: 'pethighscores_message.json',
    logPrefix: 'PHS',
    isOwnLeaderboardMessage,
    onDisplayNameChange: async (entry) => {
      try {
        await updateRow(
          process.env.PET_HIGHSCORES_SHEET_ID,
          `${SHEET_TAB}!A${entry.rowNumber}:C${entry.rowNumber}`,
          [entry.discordId, entry.displayName, entry.petKeys.join(', ')]
        );
        console.log(`[PHS] Refreshed stored display name for ${entry.discordId} -> "${entry.displayName}"`);
      } catch (err) {
        console.error(`[PHS] Failed to persist refreshed display name for ${entry.discordId}:`, err);
      }
    },
  });
}

async function loadEntries() {
  const rows = await getRows(process.env.PET_HIGHSCORES_SHEET_ID, DATA_RANGE);
  return rows
    .map((r, i) => ({
      rowNumber: i + 2, // +2: header row + 1-indexed; kept pre-filter so blank rows don't shift it
      discordId: r[0] ? String(r[0]).trim() : '',
      displayName: r[1] ? String(r[1]).trim() : '',
      petKeys: r[2] ? String(r[2]).split(',').map(k => k.trim()).filter(Boolean) : [],
    }))
    .filter(e => e.discordId)
    .map(e => ({ ...e, count: e.petKeys.length }));
}

function sortedForDisplay(entries) {
  return entries
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName));
}

// Reposts the leaderboard once on bot startup, so manual edits to the
// Highscores sheet (bulk imports, fixes, etc.) show up after a restart
// without needing a throwaway /pethighscore add or remove. Checks the same
// vars as requiredEnv, since this runs outside commandHandler.
async function refreshLeaderboardOnStartup(client) {
  const channelId = process.env.PET_HIGHSCORES_CHANNEL_ID;
  if (!process.env.PET_HIGHSCORES_SHEET_ID || !channelId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return;

  try {
    await ensurePetsLoaded();
    const guild = await client.guilds.fetch(process.env.CLAN_ID);
    const entries = await loadEntries();
    await postLeaderboard(guild, channelId, sortedForDisplay(entries), client.user.id);
  } catch (err) {
    console.error('[PHS] Failed to refresh leaderboard on startup:', err);
  }
}

async function syncMasterRole(guild, discordId, count) {
  const roleId = process.env.PET_MASTER_ROLE_ID;
  if (!roleId) return null;

  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) {
    console.warn(`[PHS] Could not fetch member ${discordId} to sync Pet Master role`);
    return null;
  }

  const role = guild.roles.cache.get(roleId);
  if (!role) {
    console.warn(`[PHS] PET_MASTER_ROLE_ID (${roleId}) not found in this guild`);
    return null;
  }

  const qualifies = count >= PET_MASTER_THRESHOLD;
  const hasRole = member.roles.cache.has(roleId);

  if (qualifies && !hasRole) {
    await member.roles.add(role);
    console.log(`[PHS] Granted Pet Master role to ${member.user.tag}`);
    return 'added';
  }
  if (!qualifies && hasRole) {
    await member.roles.remove(role);
    console.log(`[PHS] Removed Pet Master role from ${member.user.tag}`);
    return 'removed';
  }
  return null;
}

async function handleNewPet(interaction) {
  if (OWNER_ROLE_ID && !interaction.member.roles.cache.has(OWNER_ROLE_ID)) {
    console.log(`[PHS] ${interaction.user.tag} was denied /pethighscore new (missing Owner role)`);
    return interaction.reply({
      content: 'Only the Owner role can register new pets.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const name = interaction.options.getString('name', true).trim();
  const emojiInput = interaction.options.getString('emoji', true);
  const emojiId = parseEmojiId(emojiInput);

  if (!name) {
    return interaction.reply({ content: 'Pet name cannot be empty.', flags: MessageFlags.Ephemeral });
  }
  if (!emojiId) {
    return interaction.reply({
      content: "Couldn't read an emoji ID from that — paste the custom emoji itself (type `:` and pick it from the list) or its raw numeric ID.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await ensurePetsLoaded();

  const key = slugify(name);
  if (!key) {
    return interaction.reply({ content: 'Pet name must contain at least one letter or number.', flags: MessageFlags.Ephemeral });
  }
  if (PET_BY_KEY.has(key) || PETS.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    return interaction.reply({ content: `A pet named **${name}** already exists.`, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const pet = { key, name, emojiId };

  try {
    await appendRow(process.env.PET_HIGHSCORES_SHEET_ID, PET_CATALOG_APPEND_RANGE, [key, name, emojiId]);
  } catch (err) {
    console.error('[PHS] Failed to append to the Pets sheet tab:', err);
    return interaction.editReply(`Error saving the new pet: ${err.message}`);
  }

  PETS.push(pet);
  rebuildPetIndexes();

  console.log(`[PHS] ${interaction.user.tag} added new pet "${name}" (${key})`);

  await interaction.editReply(
    `Added **${name}** (\`${key}\`) ${petEmoji(pet)} to the pet list — available in \`/pethighscore add\` and \`/pethighscore remove\` immediately, no restart needed.`
  );
}

module.exports = {
  requiredEnv: ['PET_HIGHSCORES_SHEET_ID', 'PET_HIGHSCORES_CHANNEL_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON'],
  refreshLeaderboardOnStartup,

  data: new SlashCommandBuilder()
    .setName('pethighscore')
    .setDescription('Manage the OSRS pet high scores leaderboard')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription("Add a pet to a member's collection")
        .addUserOption(o => o.setName('user').setDescription('Member who got the pet').setRequired(true))
        .addStringOption(o =>
          o.setName('pet').setDescription('Pet name').setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription("Remove a pet from a member's collection (for fixing mistakes)")
        .addUserOption(o => o.setName('user').setDescription('Member to remove the pet from').setRequired(true))
        .addStringOption(o =>
          o.setName('pet').setDescription('Pet name').setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('new')
        .setDescription('Register a new pet type on the leaderboard (Owner only)')
        .addStringOption(o => o.setName('name').setDescription('Pet display name').setRequired(true))
        .addStringOption(o =>
          o.setName('emoji').setDescription('The custom emoji itself, or its numeric ID').setRequired(true)
        )
    ),

  async autocomplete(interaction) {
    await ensurePetsLoaded();
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = PETS.filter(p => p.name.toLowerCase().includes(focused)).slice(0, 25);
    await interaction.respond(choices.map(p => ({ name: p.name, value: p.key })));
  },

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'new') {
      return handleNewPet(interaction);
    }

    if (TEMPLAR_ROLE_ID && !interaction.member.roles.cache.has(TEMPLAR_ROLE_ID)) {
      console.log(`[PHS] ${interaction.user.tag} was denied /pethighscore ${subcommand} (missing Templar role)`);
      return interaction.reply({
        content: 'You need the Templar role to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await ensurePetsLoaded();

    const sheetId = process.env.PET_HIGHSCORES_SHEET_ID;
    const channelId = process.env.PET_HIGHSCORES_CHANNEL_ID;

    const targetUser = interaction.options.getUser('user', true);
    const petInput = interaction.options.getString('pet', true);
    const pet = findPet(petInput);

    if (!pet) {
      console.warn(`[PHS] ${interaction.user.tag} submitted unknown pet "${petInput}" for /pethighscore ${subcommand}`);
      return interaction.reply({
        content: `Unknown pet "${petInput}". Pick one from the autocomplete suggestions.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const guild = interaction.guild;
      const member = await guild.members.fetch(targetUser.id).catch(() => null);
      if (!member) console.warn(`[PHS] Could not fetch member ${targetUser.id} (${targetUser.tag}) — falling back to username`);
      const displayName = member?.displayName || targetUser.username;

      const entries = await loadEntries();
      const existingIndex = entries.findIndex(e => e.discordId === targetUser.id);
      const existing = existingIndex === -1 ? null : entries[existingIndex];
      const currentKeys = existing ? existing.petKeys : [];
      const hasPet = currentKeys.includes(pet.key);

      if (subcommand === 'add' && hasPet) {
        console.log(`[PHS] ${interaction.user.tag} tried to add "${pet.name}" to ${targetUser.tag}, who already has it`);
        return interaction.editReply(`<@${targetUser.id}> already has **${pet.name}** logged.`);
      }
      if (subcommand === 'remove' && !hasPet) {
        console.log(`[PHS] ${interaction.user.tag} tried to remove "${pet.name}" from ${targetUser.tag}, who doesn't have it`);
        return interaction.editReply(`<@${targetUser.id}> doesn't have **${pet.name}** logged.`);
      }

      const newKeys = subcommand === 'add'
        ? sortPetKeys([...currentKeys, pet.key])
        : sortPetKeys(currentKeys.filter(k => k !== pet.key));

      const rowValues = [targetUser.id, displayName, newKeys.join(', ')];

      if (existing) {
        await updateRow(sheetId, `${SHEET_TAB}!A${existing.rowNumber}:C${existing.rowNumber}`, rowValues);
        entries[existingIndex] = { ...existing, displayName, petKeys: newKeys, count: newKeys.length };
      } else {
        await appendRow(sheetId, APPEND_RANGE, rowValues);
        entries.push({ discordId: targetUser.id, displayName, petKeys: newKeys, count: newKeys.length });
      }

      if (subcommand === 'add') {
        console.log(`[PHS] ${interaction.user.tag} added "${pet.name}" to ${targetUser.tag} (now ${newKeys.length} pets)`);
        notifyAdminLog(
          interaction.client,
          '🐾 Pet Added',
          `${interaction.user} has added **${pet.name}** to ${targetUser}'s pet collection. They now have **${newKeys.length}** pet${newKeys.length === 1 ? '' : 's'}.`,
          [],
          EMBED_COLOR
        );
      } else {
        console.log(`[PHS] ${interaction.user.tag} removed "${pet.name}" from ${targetUser.tag} (now ${newKeys.length} pets)`);
        notifyAdminLog(
          interaction.client,
          '🐾 Pet Removed',
          `${interaction.user} has removed **${pet.name}** from ${targetUser}'s pet collection. They now have **${newKeys.length}** pet${newKeys.length === 1 ? '' : 's'}.`,
          [],
          EMBED_COLOR
        );
      }

      const roleChange = await syncMasterRole(guild, targetUser.id, newKeys.length);

      await postLeaderboard(guild, channelId, sortedForDisplay(entries), interaction.client.user.id);

      const verb = subcommand === 'add' ? 'Added' : 'Removed';
      const prep = subcommand === 'add' ? 'to' : 'from';
      let summary = `${verb} **${pet.name}** ${prep} <@${targetUser.id}>'s collection. They now have **${newKeys.length}** pet${newKeys.length === 1 ? '' : 's'}.`;

      if (roleChange === 'added') {
        summary += `\n<@${targetUser.id}> reached ${PET_MASTER_THRESHOLD}+ pets and was given the Pet Master role.`;
      } else if (roleChange === 'removed') {
        summary += `\n<@${targetUser.id}> dropped below ${PET_MASTER_THRESHOLD} pets and lost the Pet Master role.`;
      }

      await interaction.editReply(summary);
    } catch (err) {
      console.error('[PHS] Fatal error:', err);
      await interaction.editReply(`Error: ${err.message}`);
    }
  },
};
