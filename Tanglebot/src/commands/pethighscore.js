const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { DEFAULT_EMBED_COLOR } = require('../utils/embedColor');
const { mentionOrName, postLeaderboard: postLeaderboardShared } = require('../utils/leaderboard');
const { notifyAdminLog } = require('../utils/adminLog');
const { withFileLock, intEnv } = require('../utils/common');
const highScoresDb = require('../utils/highScoresDb');
const { databaseConfigured } = require('../utils/commandAvailability');
const milestones = require('../utils/milestones');
const { refuseWithoutRole } = require('../utils/roleCheck');

const TEMPLAR_ROLE_ID = process.env.TEMPLAR_ROLE_ID;
const OWNER_ROLE_ID = process.env.OWNER_ROLE_ID;
const PET_MASTER_THRESHOLD = intEnv('PET_MASTER_THRESHOLD', 10);

// withFileLock key (not a file) serializing reading the members and posting them.
const PET_LOCK_KEY = 'pethighscores-board';

// Pet slots exposed on add/remove; only the first is required.
const PET_OPTION_NAMES = ['pet', 'pet2', 'pet3', 'pet4', 'pet5'];

let PETS = [];
const PET_BY_KEY = new Map();
const PET_ORDER = new Map();

// Rebuild after PETS changes.
function rebuildPetIndexes() {
  PET_BY_KEY.clear();
  PET_ORDER.clear();
  PETS.forEach((p, i) => {
    PET_BY_KEY.set(p.key, p);
    PET_ORDER.set(p.key, i);
  });
}

// Reads the pet catalog from the database.
function fetchPetCatalog() {
  return highScoresDb.getPetCatalog();
}

// The pet catalog, shared by autocomplete and commands. Reloaded by reloadPets.
let petsLoadPromise = null;
function ensurePetsLoaded() {
  if (!petsLoadPromise) {
    petsLoadPromise = fetchPetCatalog()
      .then(pets => {
        PETS = pets;
        rebuildPetIndexes();
      })
      .catch(err => {
        petsLoadPromise = null; // retry next call instead of caching the failure
        console.error('[PetHighscore] Failed to load pet catalog from the database:', err);
        throw err;
      });
  }
  return petsLoadPromise;
}

// Re-reads the pet catalog. On failure the current catalog stays in use.
function reloadPets() {
  petsLoadPromise = null;
  return ensurePetsLoaded();
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

// ❔ if the pet has no EmojiID yet.
function petEmoji(pet) {
  if (!pet || !pet.emojiId) return '❔';
  return `<:${pet.key}:${pet.emojiId}>`;
}

// Orders pet keys by the catalog's order.
function sortPetKeys(keys) {
  return [...keys].sort((a, b) => (PET_ORDER.get(a) ?? 999) - (PET_ORDER.get(b) ?? 999));
}

const ROCK_EMOJI = '<:Rock:1534395676421521601>';
const LEADERBOARD_TITLE = `${ROCK_EMOJI} Pet High Scores ${ROCK_EMOJI}`;
const HEADER_TITLE = `${ROCK_EMOJI} How to Get on the Leaderboard ${ROCK_EMOJI}`;
const EMBED_COLOR = DEFAULT_EMBED_COLOR;
const RANK_MEDALS = ['🥇', '🥈', '🥉'];

// Instructions embed shown above the leaderboard.
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

// Each member's emoji row is a "# " heading so the emoji render larger.
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

  // entries is sorted highest first. Dense ranking, so ties share a medal.
  let rank = 0;
  let prevCount = null;
  const blocks = entries.map((entry) => {
    if (entry.count !== prevCount) {
      rank += 1;
      prevCount = entry.count;
    }
    const emojiLine = entry.petKeys.map(k => petEmoji(PET_BY_KEY.get(k))).join(' ');
    const petWord = entry.count === 1 ? 'pet' : 'pets';
    const medal = RANK_MEDALS[rank - 1] ? `${RANK_MEDALS[rank - 1]} ` : '';
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

// Recognizes this leaderboard's messages by the header or leaderboard title.
function isOwnLeaderboardMessage(embed) {
  const title = embed?.title;
  return title === HEADER_TITLE || title?.startsWith(LEADERBOARD_TITLE);
}

async function postLeaderboard(guild, channelId, entries, botUserId) {
  return postLeaderboardShared(guild, channelId, entries, botUserId, {
    buildEmbeds,
    dataFile: 'pethighscores_message.json',
    logPrefix: 'PetHighscore',
    isOwnLeaderboardMessage,
    onDisplayNameChange: async (entry) => {
      try {
        await highScoresDb.updateDisplayName(entry);
      } catch (err) {
        console.error(`[PetHighscore] Failed to persist refreshed display name for ${entry.discordId}:`, err);
      }
    },
  });
}

async function fetchEntries() {
  const members = await highScoresDb.getMemberPets();
  return members.map(e => {
    const petKeys = sortPetKeys(e.petKeys);
    return { ...e, petKeys, count: petKeys.length };
  });
}

// Members cached for autocomplete. Refreshed each time the leaderboard is posted.
let entriesLoadPromise = null;
function ensureEntriesLoaded() {
  if (!entriesLoadPromise) {
    entriesLoadPromise = fetchEntries().catch(err => {
      entriesLoadPromise = null;
      console.error('[PetHighscore] Failed to load entries from the database:', err);
      throw err;
    });
  }
  return entriesLoadPromise;
}

function sortedForDisplay(entries) {
  return entries
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName));
}

// Reads the members from the database and posts them. Serialized so posts land in write order.
function postFromDatabase(guild, channelId, botUserId) {
  return withFileLock(PET_LOCK_KEY, async () => {
    const entries = await fetchEntries();
    entriesLoadPromise = Promise.resolve(entries); // keeps autocomplete current
    await postLeaderboard(guild, channelId, sortedForDisplay(entries), botUserId);
  });
}

// Reposts the leaderboard from the database. Runs on startup and from /refreshboards. Returns false
// if the leaderboard isn't configured; errors are thrown to the caller.
async function refreshLeaderboard(client) {
  const channelId = process.env.PET_HIGHSCORES_CHANNEL_ID;
  if (!channelId || !databaseConfigured()) return false;

  await reloadPets();
  // Without it, fetch() returns every server instead of one and the post fails with a cryptic error.
  if (!process.env.CLAN_ID) throw new Error('CLAN_ID is not set, so the server to post in is unknown.');
  const guild = await client.guilds.fetch(process.env.CLAN_ID);
  await postFromDatabase(guild, channelId, client.user.id);
  return true;
}

// Records becoming or ceasing to be a Pet Master as a milestone. A failure is logged, never shown.
async function recordMasterMilestone(discordId, before, after, byDiscordId) {
  try {
    const milestone = milestones.masterMilestone(PET_MASTER_THRESHOLD, before, after);
    if (milestone) await highScoresDb.recordMilestones(discordId, [milestone], byDiscordId);
  } catch (err) {
    console.error(`[PetHighscore] Failed to record the Pet Master milestone for ${discordId}:`, err.message);
  }
}

async function syncMasterRole(guild, discordId, count) {
  const roleId = process.env.PET_MASTER_ROLE_ID;
  if (!roleId) return null;

  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) {
    console.warn(`[PetHighscore] Could not fetch member ${discordId} to sync Pet Master role`);
    return null;
  }

  const role = guild.roles.cache.get(roleId);
  if (!role) {
    console.warn(`[PetHighscore] PET_MASTER_ROLE_ID (${roleId}) not found in this guild`);
    return null;
  }

  const qualifies = count >= PET_MASTER_THRESHOLD;
  const hasRole = member.roles.cache.has(roleId);

  if (qualifies && !hasRole) {
    await member.roles.add(role);
    console.log(`[PetHighscore] Granted Pet Master role to ${member.user.tag}`);
    return 'added';
  }
  if (!qualifies && hasRole) {
    await member.roles.remove(role);
    console.log(`[PetHighscore] Removed Pet Master role from ${member.user.tag}`);
    return 'removed';
  }
  return null;
}

async function handleNewPet(interaction) {
  if (await refuseWithoutRole(interaction, [OWNER_ROLE_ID], {
    logPrefix: '[PetHighscore]', command: '/pethighscore new', missing: 'missing Owner role',
    message: 'Only the Owner role can register new pets.',
  })) return;

  const name = interaction.options.getString('name', true).trim();
  const emojiInput = interaction.options.getString('emoji', true);
  const emojiId = parseEmojiId(emojiInput);

  if (!name) {
    return interaction.reply({ content: 'Pet name cannot be empty.', flags: MessageFlags.Ephemeral });
  }
  if (!emojiId) {
    console.warn(`[PetHighscore] ${interaction.user.tag} gave an unreadable emoji "${emojiInput}" for /pethighscore new`);
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
    console.log(`[PetHighscore] ${interaction.user.tag} tried to add "${name}", which already exists`);
    return interaction.reply({ content: `A pet named **${name}** already exists.`, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const pet = { key, name, emojiId };

  try {
    await highScoresDb.addPetToCatalog(pet);
  } catch (err) {
    console.error('[PetHighscore] Failed to add the pet to the database:', err);
    return interaction.editReply(`Error saving the new pet: ${err.message}`);
  }

  PETS.push(pet);
  rebuildPetIndexes();

  console.log(`[PetHighscore] ${interaction.user.tag} added new pet "${name}" (${key})`);

  await interaction.editReply(
    `Added **${name}** (\`${key}\`) ${petEmoji(pet)} to the pet list — available in \`/pethighscore add\` and \`/pethighscore remove\` immediately, no restart needed.`
  );
}

module.exports = {
  // Shown in the admin commands post.
  help: {
    category: 'Leaderboards',
    access: { '': 'Templar', new: 'Owner' },
    examples: {
      add: '/pethighscore add user:@Zezima pet:Abyssal orphan',
      remove: '/pethighscore remove user:@Zezima pet:Abyssal orphan',
      new: '/pethighscore new name:Abyssal orphan emoji:<:abyssal_orphan:123456789012345678>',
    },
    options: {
      pet: 'pet name (autocompletes)',
      pet2: 'another pet',
      pet3: 'another pet',
      pet4: 'another pet',
      pet5: 'another pet',
      emoji: 'the custom emoji, or its numeric ID',
    },
  },
  requiredEnv: ['DATABASE_URL', 'PET_HIGHSCORES_CHANNEL_ID', 'TEMPLAR_ROLE_ID', 'OWNER_ROLE_ID'],
  refreshLeaderboard,
  PET_MASTER_THRESHOLD,

  data: new SlashCommandBuilder()
    .setName('pethighscore')
    .setDefaultMemberPermissions(0)
    .setDescription('Manage the OSRS pet high scores leaderboard')
    .addSubcommand(sub => {
      sub
        .setName('add')
        .setDescription("Add one or more pets to a member's collection")
        .addUserOption(o => o.setName('user').setDescription('Member who got the pet(s)').setRequired(true));
      PET_OPTION_NAMES.forEach((name, i) => {
        sub.addStringOption(o =>
          o
            .setName(name)
            .setDescription(i === 0 ? 'Pet name' : `Another pet name (optional)`)
            .setRequired(i === 0)
            .setAutocomplete(true)
        );
      });
      return sub;
    })
    .addSubcommand(sub => {
      sub
        .setName('remove')
        .setDescription("Remove one or more pets from a member's collection (for fixing mistakes)")
        .addUserOption(o => o.setName('user').setDescription('Member to remove the pet(s) from').setRequired(true));
      PET_OPTION_NAMES.forEach((name, i) => {
        sub.addStringOption(o =>
          o
            .setName(name)
            .setDescription(i === 0 ? 'Pet name' : `Another pet name (optional)`)
            .setRequired(i === 0)
            .setAutocomplete(true)
        );
      });
      return sub;
    })
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

    const subcommand = interaction.options.getSubcommand();
    const focused = interaction.options.getFocused(true);
    const query = String(focused.value || '').toLowerCase();

    // Don't re-suggest a pet already picked in one of this command's other pet slots.
    const pickedKeys = new Set(
      PET_OPTION_NAMES
        .filter(name => name !== focused.name)
        .map(name => interaction.options.getString(name))
        .filter(Boolean)
    );

    let pool = PETS;

    if (subcommand === 'add' || subcommand === 'remove') {
      const targetUser = interaction.options.getUser('user');
      if (targetUser) {
        const entries = await ensureEntriesLoaded().catch(() => null);
        if (entries) {
          const entry = entries.find(e => e.discordId === targetUser.id);
          const ownedKeys = new Set(entry ? entry.petKeys : []);
          pool = subcommand === 'remove'
            ? PETS.filter(p => ownedKeys.has(p.key))
            : PETS.filter(p => !ownedKeys.has(p.key));
        }
      }
    }

    const choices = pool
      .filter(p => !pickedKeys.has(p.key))
      .filter(p => p.name.toLowerCase().includes(query))
      .slice(0, 25);

    await interaction.respond(choices.map(p => ({ name: p.name, value: p.key })));
  },

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'new') {
      return handleNewPet(interaction);
    }

    if (await refuseWithoutRole(interaction, [TEMPLAR_ROLE_ID], {
      logPrefix: '[PetHighscore]', command: `/pethighscore ${subcommand}`, missing: 'missing Templar role',
      message: 'You need the Templar role to use this command.',
    })) return;

    await ensurePetsLoaded();

    const channelId = process.env.PET_HIGHSCORES_CHANNEL_ID;

    const targetUser = interaction.options.getUser('user', true);
    const petInputs = PET_OPTION_NAMES.map(name => interaction.options.getString(name)).filter(Boolean);

    const pets = [];
    const unknownInputs = [];
    const duplicateSlotNames = [];
    for (const input of petInputs) {
      const pet = findPet(input);
      if (!pet) {
        unknownInputs.push(input);
      } else if (pets.some(p => p.key === pet.key)) {
        duplicateSlotNames.push(pet.name);
      } else {
        pets.push(pet);
      }
    }

    if (unknownInputs.length > 0) {
      console.warn(`[PetHighscore] ${interaction.user.tag} submitted unknown pet(s) "${unknownInputs.join('", "')}" for /pethighscore ${subcommand}`);
      return interaction.reply({
        content: `Unknown pet${unknownInputs.length === 1 ? '' : 's'} "${unknownInputs.join('", "')}". Pick from the autocomplete suggestions.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (duplicateSlotNames.length > 0) {
      console.warn(`[PetHighscore] ${interaction.user.tag} listed the same pet more than once ("${duplicateSlotNames.join('", "')}") for /pethighscore ${subcommand}`);
      return interaction.reply({
        content: `You listed ${duplicateSlotNames.length === 1 ? 'a pet' : 'pets'} more than once: **${duplicateSlotNames.join(', ')}**. Pick each pet in only one slot.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const guild = interaction.guild;
      const member = await guild.members.fetch(targetUser.id).catch(() => null);
      if (!member) console.warn(`[PetHighscore] Could not fetch member ${targetUser.id} (${targetUser.tag}) — falling back to username`);
      const displayName = member?.displayName || targetUser.username;

      // Changes the pets in one transaction, then reposts the leaderboard unless nothing changed.
      const result = await highScoresDb.changeMemberPets({
        discordId: targetUser.id,
        displayName,
        joinedAt: member?.joinedAt ?? null,
        petKeys: pets.map(p => p.key),
        action: subcommand,
        byDiscordId: interaction.user.id,
      });
      const toApply = pets.filter(p => result.applied.includes(p.key));
      const skipped = pets.filter(p => result.skipped.includes(p.key));
      const newKeys = result.petKeys;
      const appliedNames = toApply.map(p => p.name).join(', ');
      const noOp = toApply.length === 0;
      if (!noOp) {
        try {
          await postFromDatabase(guild, channelId, interaction.client.user.id);
        } catch (err) {
          console.error('[PetHighscore] Failed to update leaderboard post after a pet edit:', err.message);
        }
      }

      if (noOp) {
        const names = skipped.map(p => `**${p.name}**`).join(', ');
        const msg = subcommand === 'add'
          ? `<@${targetUser.id}> already has ${names} logged.`
          : `<@${targetUser.id}> doesn't have ${names} logged.`;
        console.log(`[PetHighscore] ${interaction.user.tag} tried to ${subcommand} ${skipped.map(p => p.name).join(', ')} for ${targetUser.tag} — no change`);
        return interaction.editReply(msg);
      }

      if (subcommand === 'add') {
        console.log(`[PetHighscore] ${interaction.user.tag} added "${appliedNames}" to ${targetUser.tag} (now ${newKeys.length} pets)`);
        notifyAdminLog(
          interaction.client,
          '🐾 Pet Added',
          `${interaction.user} has added **${appliedNames}** to ${targetUser}'s pet collection. They now have **${newKeys.length}** pet${newKeys.length === 1 ? '' : 's'}.`,
          [],
          EMBED_COLOR
        );
      } else {
        console.log(`[PetHighscore] ${interaction.user.tag} removed "${appliedNames}" from ${targetUser.tag} (now ${newKeys.length} pets)`);
        notifyAdminLog(
          interaction.client,
          '🐾 Pet Removed',
          `${interaction.user} has removed **${appliedNames}** from ${targetUser}'s pet collection. They now have **${newKeys.length}** pet${newKeys.length === 1 ? '' : 's'}.`,
          [],
          EMBED_COLOR
        );
      }

      const before = subcommand === 'add' ? newKeys.length - toApply.length : newKeys.length + toApply.length;
      await recordMasterMilestone(targetUser.id, before, newKeys.length, interaction.user.id);
      const roleChange = await syncMasterRole(guild, targetUser.id, newKeys.length);

      const verb = subcommand === 'add' ? 'Added' : 'Removed';
      const prep = subcommand === 'add' ? 'to' : 'from';
      let summary = `${verb} **${appliedNames}** ${prep} <@${targetUser.id}>'s collection. They now have **${newKeys.length}** pet${newKeys.length === 1 ? '' : 's'}.`;

      if (skipped.length > 0) {
        const skippedNames = skipped.map(p => `**${p.name}**`).join(', ');
        summary += subcommand === 'add'
          ? `\n(Skipped ${skippedNames} — already logged.)`
          : `\n(Skipped ${skippedNames} — not logged.)`;
      }

      if (roleChange === 'added') {
        summary += `\n<@${targetUser.id}> reached ${PET_MASTER_THRESHOLD}+ pets and was given the Pet Master role.`;
      } else if (roleChange === 'removed') {
        summary += `\n<@${targetUser.id}> dropped below ${PET_MASTER_THRESHOLD} pets and lost the Pet Master role.`;
      }

      await interaction.editReply(summary);
    } catch (err) {
      console.error('[PetHighscore] Fatal error:', err);
      interaction.commandError = err; // for the command log
      await interaction.editReply(`Error: ${err.message}`);
    }
  },
};
