const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');

// How long the ephemeral role menus stay open before auto-deleting; already-assigned roles aren't affected.
const MENU_MESSAGE_LIFETIME_MS = 60 * 1000;

// Roles this system manages get this prefix (e.g. "LFG-Yama") so they're easy to spot in the role list.
const ROLE_PREFIX = 'LFG-';

function lfgRoleName(baseName) {
  return `${ROLE_PREFIX}${baseName}`;
}

// Default color for admin log embeds — red, signaling an operational issue that needs attention.
const ADMIN_LOG_ALERT_COLOR = 0xed4245;

// Reports something to ADMIN_LOG_CHANNEL_ID as an embed. Silently skipped if unset.
// fields is optional — pass named {name, value, inline} entries for structured details (e.g.
// "Suggested By", "Changes") instead of cramming everything into description, matching the field-
// based embeds honeypot.js's admin alerts already use.
// color defaults to red (an alert); pass a different color for non-alert notices (e.g. suggestions).
async function notifyAdminLog(client, title, description, fields = [], color = ADMIN_LOG_ALERT_COLOR) {
  const adminLogChannelId = process.env.ADMIN_LOG_CHANNEL_ID;
  if (!adminLogChannelId) return;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
  if (fields.length) embed.addFields(fields);

  try {
    const channel = await client.channels.fetch(adminLogChannelId);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[LFG] Could not send admin log notification:', err.message);
  }
}

// Shorthand for the ephemeral status reply shape, so {content, flags: Ephemeral} only needs to change in one place.
function replyEphemeral(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

// autoDelete removes the follow-up after MENU_MESSAGE_LIFETIME_MS, for confirmations that don't need to stick around.
function followUpEphemeral(interaction, content, { autoDelete = false } = {}) {
  const promise = interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  if (autoDelete) {
    promise.then((message) => {
      setTimeout(() => {
        // Not message.delete() — resolving message.channel needs the client's channel cache,
        // which fails for a thread that's since fallen out of it. The webhook needs no channel lookup.
        interaction.webhook.deleteMessage(message.id).catch((err) => {
          if (!isAlreadyGoneError(err)) console.error('Could not delete ephemeral follow-up:', err.message);
        });
      }, MENU_MESSAGE_LIFETIME_MS);
    }).catch(() => {});
  }
  return promise;
}

// Reports an issue to admin log, then replies to the user with an ephemeral, ⚠️-prefixed message.
// Shared by every /lfg-roles failure path, so the pairing only needs to change in one place.
async function notifyAdminLogAndReply(interaction, title, adminMessage, userMessage) {
  await notifyAdminLog(interaction.client, title, adminMessage);
  return replyEphemeral(interaction, userMessage);
}

// Discord's "Unknown Message" (10008) and "Unknown Channel" (10003) — thrown when the message or
// thread/channel was already gone (dismissed, auto-cleaned, manually deleted, etc.) before this
// call got to it. Covers both since callers delete/rename/update either a reply message or
// a forum thread, depending on which cleanup path hit them.
const ALREADY_GONE_ERROR_CODES = new Set([10003, 10008]);
function isAlreadyGoneError(err) {
  return ALREADY_GONE_ERROR_CODES.has(err?.code);
}

// Deletes interaction's reply after delayMs. An already-gone reply (dismissed, or already cleaned
// up elsewhere) is expected and isn't logged; anything else is a real error.
function scheduleReplyCleanup(interaction, delayMs, logLabel) {
  setTimeout(() => {
    interaction.deleteReply().catch((err) => {
      if (isAlreadyGoneError(err)) return;
      console.error(`Could not delete ${logLabel}:`, err.message);
    });
  }, delayMs);
}

// Builds the default 2..max size-options list, for activities with no "Mass" option.
function sizeRange(max) {
  const options = [];
  for (let n = 2; n <= max; n++) {
    options.push({ value: String(n), label: n === max ? `${n} Players (Max)` : `${n} Players` });
  }
  return options;
}

// Builds a size-options list of 2..max players, plus an appended "Mass" option (for "N/mass" activities).
function sizeRangeWithMass(max) {
  const options = [];
  for (let n = 2; n <= max; n++) {
    options.push({ value: String(n), label: `${n} Players` });
  }
  options.push({ value: 'mass', label: 'Mass' });
  return options;
}

// Builds a size-options list with exactly one choice — for activities that need an exact player count
function sizeFixed(n) {
  return [{ value: String(n), label: `${n} Players (Fixed)` }];
}

function summarizeSizeOptions(sizeOptions = []) {
  const numericValues = sizeOptions
    .map((option) => Number.parseInt(option.value, 10))
    .filter((value) => Number.isFinite(value));

  return {
    maximumPlayers: numericValues.length ? Math.max(...numericValues) : null,
    supportsMass: sizeOptions.some((option) => option.value === 'mass'),
  };
}

// Derives a role's stable identifier (used in customIds and select-menu values) from its
// display label, e.g. "Royal Titans" -> "royal_titans", "Vet'ion" -> "vetion".
function slugify(label) {
  return label
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ---- Category definitions ----
// Feeds /lfg-roles (buttons) and the /lfg-post Category -> Activity accordion.
// Missing roles are auto-created as "LFG-<label>" on first use (see ensureRoleExists below).
// Rename any pre-existing plain-named role to add the "LFG-" prefix so it's reused, not duplicated.
// label doubles as the exact Discord role name — spell it how the role should read (e.g. "Royal Titans", not "Titans").
//
// ---- Copy/paste template ----
// New role:
//   { label: 'Display Name', emoji: 'PUT_EMOJI_ID_HERE', color: '#006400', sizeOptions: sizeRange(N) },
// A missing/invalid color or emoji isn't defaulted — /lfg-post will refuse to post that activity
// and alert ADMIN_LOG_CHANNEL_ID instead (see isValidColor/isValidEmoji below).
//
// New category:
//   new_key: {
//     // label is lowercased into the picker prompt's noun (e.g. "Pick the bosses...") —
//     // spell it as a plural noun, not a gerund (e.g. "Bosses", not "Bossing").
//     label: 'Label',
//     buttonEmoji: '🔥',
//     buttonStyle: ButtonStyle.Primary, // optional, defaults to Primary
//     roles: [ /* role entries above */ ],
//   },
const CATEGORIES = {
  bossing: {
    label: 'Bosses',
    buttonEmoji: '1534226736361902170',
    roles: [
      { label: 'Yama', emoji: '1534395643416543282', color: '#8B0000', sizeOptions: sizeRange(2) },
      { label: 'Nightmare', emoji: '1534395696201863198', color: '#6B2470', sizeOptions: sizeRangeWithMass(5) },
      { label: 'Royal Titans', emoji: '1534395741282369658', color: '#6B4C9A', sizeOptions: sizeRange(2) },
      { label: 'Hueycoatl', emoji: '1534395712379293918', color: '#1B7340', sizeOptions: sizeRangeWithMass(5) },
      { label: 'DKS', emoji: '1534395732038258718', color: '#2C7873', sizeOptions: sizeRange(3) },
      { label: 'Scurrius', emoji: '1534395671543681065', color: '#7B5C3E', sizeOptions: sizeRangeWithMass(5) },
      { label: 'Corp', emoji: '1534395728116580502', color: '#C77DBB', sizeOptions: sizeRangeWithMass(10) },
      { label: 'Nex', emoji: '1534395688060719104', color: '#241B36', sizeOptions: sizeRangeWithMass(5) },
      { label: 'Zilyana', emoji: '1534395640388386836', color: '#C9A227', sizeOptions: sizeRange(5) },
      { label: 'Graardor', emoji: '1534395722609201304', color: '#B5651D', sizeOptions: sizeRange(5) },
      { label: 'Kril', emoji: '1534395702271021236', color: '#4B1113', sizeOptions: sizeRange(5) },
      { label: 'Kree', emoji: '1534395703843880990', color: '#7FA8C9', sizeOptions: sizeRange(5) },
      { label: 'Callisto', emoji: '1534395737389924544', color: '#4A2E1A', sizeOptions: sizeRangeWithMass(5) },
      { label: 'Venenatis', emoji: '1534395655630360596', color: '#4A3B7A', sizeOptions: sizeRangeWithMass(5) },
      { label: 'Vet\'ion', emoji: '1534395654502219918', color: '#1F6FB2', sizeOptions: sizeRangeWithMass(5) },
    ],
  },
  raids: {
    label: 'Raids',
    buttonEmoji: '1534226735074250842',
    roles: [
      { label: 'CoX', emoji: '1534395684277715005', color: '#17A398', sizeOptions: sizeRangeWithMass(7) },
      { label: 'CoXCM', emoji: '1535326415073976350', color: '#17A398', sizeOptions: sizeRange(7) },
      { label: 'ToB', emoji: '1534395699213631569', color: '#7A0C0C', sizeOptions: sizeRange(5) },
      { label: 'ToBHM', emoji: '1535325447045255168', color: '#7A0C0C', sizeOptions: sizeRange(5) },
      { label: 'ToA', emoji: '1535325450300301463', color: '#D2A679', sizeOptions: sizeRange(8) },
      { label: 'ToAExpert', emoji: '1535325449003991141', color: '#D2A679', sizeOptions: sizeRange(8) },
    ],
  },
  minigames: {
    label: 'Minigames',
    buttonEmoji: '1534226733413171420',
    roles: [
      { label: 'Tempoross', emoji: '1534395661288738946', color: '#1B6CA8', sizeOptions: sizeRangeWithMass(10) },
      { label: 'Zalcano', emoji: '1534395666598461551', color: '#5A6B57', sizeOptions: sizeRangeWithMass(10) },
      { label: 'Wintertodt', emoji: '1534395680695779460', color: '#9FD3E8', sizeOptions: sizeRangeWithMass(10) },
      { label: 'GOTR', emoji: '1534395880935788576', color: '#6A3FA0', sizeOptions: sizeRangeWithMass(10) },
      { label: 'Soul Wars', emoji: '1534395893443203232', color: '#6A5ACD', sizeOptions: sizeRangeWithMass(10) },
      { label: 'Castle Wars', emoji: '1534395875965665341', color: '#7A7267', sizeOptions: sizeRangeWithMass(10) },
      { label: 'Barb Assault', emoji: '1534395870638772345', color: '#A0522D', sizeOptions: sizeFixed(5) },
    ],
  },
};

// Derives each role's `value` and each category's `activityNoun` now, so the rest of the codebase can just read them.
// Roles are sorted alphabetically by label here too, so every consumer that iterates
// category.roles (role-menu buttons, the /lfg-post activity picker, the LFG start page list,
// the exported catalog, ...) lists activities in alphabetical order without having to sort itself.
for (const category of Object.values(CATEGORIES)) {
  category.activityNoun = category.label.toLowerCase();
  category.roles.sort((a, b) => a.label.localeCompare(b.label));
  for (const role of category.roles) {
    role.value = slugify(role.label);
  }
}

function buildDiscordLfgCatalog() {
  return Object.entries(CATEGORIES).map(([key, category], categoryIndex) => ({
    key,
    displayName: category.label,
    description: `${category.label} groups`,
    enabled: true,
    displayOrder: (categoryIndex + 1) * 10,
    activities: category.roles.map((role, roleIndex) => {
      const sizeSummary = summarizeSizeOptions(role.sizeOptions);
      return {
        key: role.value,
        displayName: role.label,
        discordRoleName: role.label,
        description: null,
        enabled: true,
        displayOrder: (roleIndex + 1) * 10,
        maximumPlayers: sizeSummary.maximumPlayers,
        supportsMass: sizeSummary.supportsMass,
        emoji: role.emoji ?? null,
        colorHex: role.color ?? null,
      };
    }),
  }));
}

// customId scheme used for all buttons here:
//   "roles:category:<categoryKey>"          — top-level category button (Bosses, Raids, etc.)
//   "roles:toggle:<categoryKey>:<roleValue>" — a specific boss/raid toggle
//   "roles:clearall"                         — removes every LFG- role the member has
// eventHandler.js routes any button whose customId starts with "roles:" here.

// Joins display labels into "A", "A or B", or "A, B, or C" — used to list categories in prose.
function joinWithOr(items) {
  if (items.length <= 2) return items.join(' or ');
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

// Shared submenu prompt text, parameterized by each category's activityNoun (e.g. "bosses", "raids").
function categoryPrompt(activityNoun) {
  return `Pick the ${activityNoun} you want to be pingable for. Selected ones turn red and stay red until you click them again.`;
}

function buildMenuEmbed() {
  const categoryLabels = Object.values(CATEGORIES).map((cat) => `**${emojiLabel(cat.buttonEmoji, cat.label)}**`);

  return new EmbedBuilder()
    .setTitle('LFG Roles')
    .setDescription(
      `Click ${joinWithOr(categoryLabels)} to pick specific activities you want to be pingable for. ` +
      'Selected ones turn red.\n\n' +
      'Once you have a role, anyone can `@mention` it to notify everyone ' +
      'signed up when that activity is happening.\n\n' +
      'Click **Clear All LFG Roles** to remove every LFG role you have in one go.\n\n' +
      '_This message will delete itself in 60 seconds — your roles stay either way._'
    )
    .setColor(0xc2a24c)
    .setFooter({ text: 'OSRS Activity Notifications' });
}

function buildCategoryButtonsRow() {
  const buttons = Object.entries(CATEGORIES).map(([key, cat]) => {
    const btn = new ButtonBuilder()
      .setCustomId(`roles:category:${key}`)
      .setLabel(cat.label)
      .setStyle(cat.buttonStyle ?? ButtonStyle.Primary);
    if (isValidEmoji(cat.buttonEmoji)) btn.setEmoji(cat.buttonEmoji);
    return btn;
  });
  return new ActionRowBuilder().addComponents(buttons);
}

function buildClearAllRow() {
  const clearAll = new ButtonBuilder()
    .setCustomId('roles:clearall')
    .setLabel('Clear All LFG Roles')
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(clearAll);
}

function buildCategoryButtonRows(categoryKey, member) {
  const category = CATEGORIES[categoryKey];
  // One pass over the member's small role list, not the whole guild's role cache per category role
  // (the old approach — up to 15x per render).
  const memberRoleNames = new Set(member.roles.cache.filter((r) => r.name.startsWith(ROLE_PREFIX)).map((r) => r.name));

  const buttons = category.roles.map((r) => {
    const has = memberRoleNames.has(lfgRoleName(r.label));
    const btn = new ButtonBuilder()
      .setCustomId(`roles:toggle:${categoryKey}:${r.value}`)
      .setLabel(r.label)
      .setStyle(has ? ButtonStyle.Danger : ButtonStyle.Secondary);
    if (isValidEmoji(r.emoji)) btn.setEmoji(r.emoji);
    return btn;
  });

  return chunkIntoRows(buttons, 5).map((chunk) => new ActionRowBuilder().addComponents(chunk));
}

async function sendCategoryMenu(interaction, categoryKey, isUpdate) {
  const category = CATEGORIES[categoryKey];
  const rows = buildCategoryButtonRows(categoryKey, interaction.member);
  const payload = { content: categoryPrompt(category.activityNoun), components: rows, flags: MessageFlags.Ephemeral };

  if (isUpdate) {
    await interaction.update(payload);
  } else {
    await interaction.reply(payload);
  }

  // Auto-delete this submenu after 60 seconds. Roles already picked stay assigned.
  scheduleReplyCleanup(interaction, MENU_MESSAGE_LIFETIME_MS, 'role submenu message');
}

async function handleRoleToggle(interaction, categoryKey, value) {
  const category = CATEGORIES[categoryKey];
  if (!category) return;

  const roleConfig = category.roles.find((r) => r.value === value);
  if (!roleConfig) return;

  const guild = interaction.guild;
  const member = interaction.member;
  const role = await ensureRoleExists(guild, roleConfig.label);

  if (!role) {
    return notifyAdminLogAndReply(
      interaction,
      '⚠️ LFG Role Creation Failed',
      `Couldn't find or create **${lfgRoleName(roleConfig.label)}** for <@${interaction.user.id}> via /lfg-roles. Check the bot's **Manage Roles** permission.`,
      `⚠️ I couldn't find or create the role **${lfgRoleName(roleConfig.label)}**. Make sure I have the **Manage Roles** permission.`
    );
  }

  try {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role);
    } else {
      await member.roles.add(role);
    }
  } catch (err) {
    console.error('Role toggle error:', err);
    return notifyAdminLogAndReply(
      interaction,
      '⚠️ LFG Role Assignment Failed',
      `Couldn't add/remove **${lfgRoleName(roleConfig.label)}** for <@${interaction.user.id}> via /lfg-roles: ${err.message}. Make sure the bot's role sits above it.`,
      '⚠️ I couldn\'t update your roles. Make sure my role sits above these roles.'
    );
  }

  // Re-render the same ephemeral menu with the button now toggled red/grey
  return sendCategoryMenu(interaction, categoryKey, true);
}

async function handleClearAllRoles(interaction) {
  const member = interaction.member;
  const lfgRoles = member.roles.cache.filter((r) => r.name.startsWith(ROLE_PREFIX));

  if (lfgRoles.size === 0) {
    return replyEphemeral(interaction, 'You don\'t have any LFG roles to clear.');
  }

  try {
    await member.roles.remove(lfgRoles);
  } catch (err) {
    console.error('[LFG] Clear all roles error:', err);
    return notifyAdminLogAndReply(
      interaction,
      '⚠️ LFG Role Clear Failed',
      `Couldn't clear LFG roles for <@${interaction.user.id}>: ${err.message}. Make sure the bot's role sits above them.`,
      '⚠️ I couldn\'t clear your roles. Make sure my role sits above these roles.'
    );
  }

  return replyEphemeral(interaction, `✅ Cleared ${lfgRoles.size} LFG role(s).`);
}

// Entry point called from eventHandler.js for any button customId starting with "roles:"
async function handleRoleMenuButtonInteraction(interaction) {
  const parts = interaction.customId.split(':'); // ["roles", "category"|"toggle"|"clearall", ...]
  const kind = parts[1];

  if (kind === 'category') {
    const categoryKey = parts[2];
    if (!CATEGORIES[categoryKey]) return;
    return sendCategoryMenu(interaction, categoryKey, false);
  }

  if (kind === 'toggle') {
    const [, , categoryKey, value] = parts;
    return handleRoleToggle(interaction, categoryKey, value);
  }

  if (kind === 'clearall') {
    return handleClearAllRoles(interaction);
  }
}

// Looks up the prefixed role for a base name (e.g. "Yama" -> "LFG-Yama").
function findRole(guild, name) {
  return guild.roles.cache.find((r) => r.name === lfgRoleName(name));
}

// Role icons (the little emoji shown next to a role's name) require the ROLE_ICONS guild feature,
// which is only granted at Boost Level 2+. Checking the feature flag directly (rather than
// guild.premiumTier >= 2) covers servers that have it via other means (e.g. partnered).
function guildSupportsRoleIcons(guild) {
  return guild.features.includes('ROLE_ICONS');
}

// Builds the {icon, unicodeEmoji} fields for a role create/edit call. Custom emoji (snowflake IDs)
// go through `icon` as a CDN image URL — discord.js's `icon` option only accepts a Buffer, data URI,
// http(s) URL, or local file path, so the bare snowflake ID must be turned into a URL first (passing
// it directly makes discord.js treat it as a relative file path and fail with ENOENT).
// Plain unicode emoji go through `unicodeEmoji`. Omitted entirely if the guild can't support icons,
// so the call succeeds with no icon rather than erroring on an unsupported field.
function roleIconOptions(guild, emoji) {
  if (!guildSupportsRoleIcons(guild) || !isValidEmoji(emoji)) return {};
  if (!isSnowflakeEmoji(emoji)) return { unicodeEmoji: emoji };
  const ext = guild.emojis.cache.get(emoji)?.animated ? 'gif' : 'png';
  return { icon: `https://cdn.discordapp.com/emojis/${emoji}.${ext}?size=64` };
}

// Shared "find by exact name, create if missing" role factory used by LFG and clan ranks. `name`
// is the exact Discord role name — callers apply their own prefixing (e.g. lfgRoleName) first.
async function ensureNamedRole(guild, { name, color, emoji, mentionable = true, reason, logPrefix }) {
  const existing = guild.roles.cache.find((r) => r.name === name);
  if (existing) return existing;

  const tag = logPrefix ? `[${logPrefix}] ` : '';
  try {
    const role = await guild.roles.create({
      name,
      mentionable,
      ...(isValidColor(color) ? { colors: { primaryColor: color } } : {}),
      ...roleIconOptions(guild, emoji),
      reason,
    });
    console.log(`${tag}Created missing role: "${role.name}"`);
    return role;
  } catch (err) {
    console.error(`${tag}Could not auto-create role "${name}":`, err.message);
    return null;
  }
}

// Diffs an existing role's color/icon against the desired config and edits it if needed.
// Returns 'updated', 'skipped' (already matches), or 'failed' (edit call errored).
async function syncNamedRoleAppearance(guild, role, { color, emoji }, reason, logPrefix) {
  const edits = {};
  if (isValidColor(color) && role.hexColor.toLowerCase() !== color.toLowerCase()) {
    edits.colors = { primaryColor: color };
  }
  if (guildSupportsRoleIcons(guild) && isValidEmoji(emoji)) {
    Object.assign(edits, roleIconOptions(guild, emoji));
  }

  if (Object.keys(edits).length === 0) return 'skipped';

  try {
    await role.edit({ ...edits, reason });
    return 'updated';
  } catch (err) {
    const tag = logPrefix ? `[${logPrefix}] ` : '';
    console.error(`${tag}Could not sync appearance for role "${role.name}":`, err.message);
    return 'failed';
  }
}

// Finds the role, creating it first if it's missing.
async function ensureRoleExists(guild, name) {
  const roleConfig = findRoleConfig(name);
  return ensureNamedRole(guild, {
    name: lfgRoleName(name),
    color: roleConfig?.color,
    emoji: roleConfig?.emoji,
    mentionable: true,
    reason: 'Auto-created for the LFG system (roleMenu.js CATEGORIES)',
    logPrefix: 'LFG',
  });
}

// Looks up a role's CATEGORIES entry by its base label (e.g. "Yama"), across all categories.
function findRoleConfig(name) {
  for (const category of Object.values(CATEGORIES)) {
    const match = category.roles.find((r) => r.label === name);
    if (match) return match;
  }
  return null;
}

// Backfills color + icon onto every already-created LFG- role so later CATEGORIES edits reach
// them too. Safe to call repeatedly — an already-matching role is skipped.
async function syncRoleAppearance(guild) {
  const results = { updated: [], skipped: [], failed: [] };

  for (const category of Object.values(CATEGORIES)) {
    for (const roleConfig of category.roles) {
      const role = findRole(guild, roleConfig.label);
      if (!role) {
        results.skipped.push(roleConfig.label);
        continue;
      }

      const outcome = await syncNamedRoleAppearance(guild, role, roleConfig, 'LFG role appearance sync (roleMenu.js CATEGORIES)', 'LFG');
      results[outcome].push(roleConfig.label);
    }
  }

  return results;
}

// A real Discord snowflake ID is a string of digits (typically 17-20 long).
function isSnowflakeEmoji(emoji) {
  return typeof emoji === 'string' && /^\d{15,25}$/.test(emoji);
}

// Accepts either a custom emoji's snowflake ID or a plain unicode emoji character.
// Placeholders like "PUT_EMOJI_ID_HERE" are plain ASCII text (not digits, not a real emoji glyph),
// so they fall through and get rejected here instead of silently failing when sent to Discord.
function isValidEmoji(emoji) {
  if (typeof emoji !== 'string' || emoji.length === 0) return false;
  return isSnowflakeEmoji(emoji) || /[^\x00-\x7F]/.test(emoji);
}

// A real color is a 6-digit hex string like "#006400" — rejects placeholders, empty strings, and anything left unset.
function isValidColor(color) {
  return typeof color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(color);
}

// Renders a role's emoji as inline markup usable in message/embed text (e.g. a title).
// Custom emoji need Discord's <:_:ID> markup to resolve by ID; unicode emoji render as-is.
// Returns null if there's no valid emoji, so callers can omit it instead of rendering broken markup.
function emojiMarkup(emoji) {
  if (!isValidEmoji(emoji)) return null;
  return isSnowflakeEmoji(emoji) ? `<:_:${emoji}>` : emoji;
}

// "<emoji> Label", or just "Label" if there's no valid emoji to show.
function emojiLabel(emoji, label) {
  const markup = emojiMarkup(emoji);
  return markup ? `${markup} ${label}` : label;
}

function chunkIntoRows(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

module.exports = {
  CATEGORIES,
  buildDiscordLfgCatalog,
  MENU_MESSAGE_LIFETIME_MS,
  buildMenuEmbed,
  buildCategoryButtonsRow,
  buildClearAllRow,
  handleRoleMenuButtonInteraction,
  ensureRoleExists,
  syncRoleAppearance,
  ensureNamedRole,
  syncNamedRoleAppearance,
  lfgRoleName,
  notifyAdminLog,
  scheduleReplyCleanup,
  isAlreadyGoneError,
  replyEphemeral,
  followUpEphemeral,
  emojiMarkup,
  emojiLabel,
  isValidEmoji,
  isValidColor,
};
