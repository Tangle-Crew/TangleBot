const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { truncate } = require('./db');
const { replyEphemeral } = require('./roleMenu');

const SUGGEST_BUTTON_ID = 'lfgsuggest:open';
const SUGGEST_MODAL_ID = 'lfgsuggest:submit';

const CATEGORY_CHOICES = ['Boss', 'Raid', 'Minigame', 'Other'];
const MAX_ITEM_CHARS = 100;

// One suggestion per person per minute.
const COOLDOWN_MS = 60 * 1000;
const lastSuggestionAt = new Map(); // userId -> timestamp; not saved

// Suggestions go to the admin log; the Owner role is pinged too when OWNER_ROLE_ID is set.
function isSuggestionConfigured() {
  return Boolean(process.env.ADMIN_LOG_CHANNEL_ID);
}

// The button for the Start Here post, or no rows if suggestions aren't set up.
function buildSuggestRows() {
  if (!isSuggestionConfigured()) return [];
  const button = new ButtonBuilder()
    .setCustomId(SUGGEST_BUTTON_ID)
    .setLabel('Make a Suggestion')
    .setStyle(ButtonStyle.Primary);
  return [new ActionRowBuilder().addComponents(button)];
}

async function handleSuggestButton(interaction) {
  if (!isSuggestionConfigured()) {
    return replyEphemeral(interaction, '⚠️ Suggestions aren\'t set up yet.');
  }

  const category = new StringSelectMenuBuilder()
    .setCustomId('category')
    .setPlaceholder('Pick a category')
    .addOptions(CATEGORY_CHOICES.map((label) => ({ label, value: label })));
  const item = new TextInputBuilder()
    .setCustomId('item')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(MAX_ITEM_CHARS)
    .setPlaceholder('e.g. the boss, raid or minigame name');

  const modal = new ModalBuilder()
    .setCustomId(SUGGEST_MODAL_ID)
    .setTitle('Suggest an activity')
    .addLabelComponents(
      new LabelBuilder().setLabel('Category').setStringSelectMenuComponent(category),
      new LabelBuilder().setLabel('What should we add?').setTextInputComponent(item)
    );
  await interaction.showModal(modal);
}

async function handleSuggestModalSubmit(interaction) {
  if (interaction.customId !== SUGGEST_MODAL_ID) return;
  if (!isSuggestionConfigured()) {
    return replyEphemeral(interaction, '⚠️ Suggestions aren\'t set up yet.');
  }

  const now = Date.now();
  for (const [userId, at] of lastSuggestionAt) {
    if (now - at >= COOLDOWN_MS) lastSuggestionAt.delete(userId);
  }
  if (lastSuggestionAt.has(interaction.user.id)) {
    return replyEphemeral(interaction, '⏳ Please wait a minute before sending another suggestion.');
  }

  const category = interaction.fields.getStringSelectValues('category')[0];
  const item = interaction.fields.getTextInputValue('item').trim();
  if (!CATEGORY_CHOICES.includes(category) || !item) {
    return replyEphemeral(interaction, '⚠️ Please pick a category and enter a name.');
  }

  // Claimed before the send, so a quick second submission can't also get through.
  lastSuggestionAt.set(interaction.user.id, now);
  const ownerRoleId = process.env.OWNER_ROLE_ID;
  const embed = new EmbedBuilder()
    .setTitle('💡 LFG Suggestion')
    .addFields(
      { name: 'Category', value: category, inline: true },
      { name: 'Suggestion', value: truncate(item, MAX_ITEM_CHARS), inline: true },
      { name: 'From', value: `<@${interaction.user.id}> (${escapeMarkdown(interaction.user.username)})` }
    )
    .setTimestamp();

  try {
    const channel = await interaction.client.channels.fetch(process.env.ADMIN_LOG_CHANNEL_ID);
    // Embeds don't ping, so the role mention goes in the message itself.
    await channel.send({
      content: ownerRoleId ? `<@&${ownerRoleId}>` : undefined,
      embeds: [embed],
      allowedMentions: { roles: ownerRoleId ? [ownerRoleId] : [] },
    });
  } catch (err) {
    lastSuggestionAt.delete(interaction.user.id);
    console.error('[LFG] Could not send suggestion to the admin log:', err.message);
    return replyEphemeral(interaction, '⚠️ Something went wrong sending your suggestion. Please try again later.');
  }

  console.log(`[LFG] Suggestion from ${interaction.user.username}: ${category} - ${item}`);
  await interaction.reply({ content: '✅ Thanks! Your suggestion was sent to the team.', flags: MessageFlags.Ephemeral });
}

module.exports = {
  buildSuggestRows,
  handleSuggestButton,
  handleSuggestModalSubmit,
};
