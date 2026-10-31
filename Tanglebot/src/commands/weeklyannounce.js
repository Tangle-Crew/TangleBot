const {
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  escapeMarkdown,
} = require('discord.js');
const { parseDateInput } = require('./weeklycomp');
const {
  MAX_ANNOUNCEMENTS,
  MESSAGE_LIMIT,
  MAX_CHOICES,
  loadGroupCompetitions,
  findNextEnding,
  competitionChoices,
  createDraft,
  getDraft,
  updateDraft,
  deleteDraft,
  joinAnnouncements,
} = require('../utils/weeklyAnnounce');
const { competitionUrl } = require('../utils/wiseOldMan');
const { discordTimestamp, truncate } = require('../utils/db');
const { DEFAULT_EMBED_COLOR } = require('../utils/embedColor');

const TEMPLAR_ROLE_ID = process.env.TEMPLAR_ROLE_ID;
const WOM_GROUP_ID = Number(process.env.WOM_GROUP_ID);
// Posts following the competitions send this long after they end, so WOM's final totals are in.
const SEND_DELAY_MS = 5 * 60 * 1000;
// When set, every post goes here and the command has no channel option.
const CHANNEL_ID = process.env.WEEKLY_ANNOUNCE_CHANNEL_ID?.trim() || null;

// "weeklyannounce:<action>:<draftId>[:<index>]" on the panel's buttons and the text modal.
const ID_PREFIX = 'weeklyannounce';
// The panel's side stripe turns amber once the announcements are over MESSAGE_LIMIT.
const OVER_LIMIT_COLOR = 0xf0a020;
const TITLE_MAX = 80;

// What the bot needs in the target channel to post the winners chart and announcements.
const SEND_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.AttachFiles, 'Attach Files'],
];

function buildCommandData() {
  return new SlashCommandBuilder()
    .setName('weeklyannounce')
    .setDescription('Schedule the weekly winners and announcements post')
    .addSubcommand(sub => {
      sub.setName('setup').setDescription('Build and schedule the post for 5 minutes after the next competition ends');
      // Required options must come first, so the channel goes before start.
      if (!CHANNEL_ID) {
        sub.addChannelOption(o =>
          o.setName('channel')
            .setDescription('Where to post (WEEKLY_ANNOUNCE_CHANNEL_ID is not set in the bot config)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        );
      }
      sub.addStringOption(o =>
        o.setName('start')
          .setDescription('Send time, Eastern Time (default: 5 min after the next competition ends), as in /weeklycomp')
      );
      return sub;
    });
}

function isTemplar(member) {
  return Boolean(member?.roles?.cache?.has(TEMPLAR_ROLE_ID));
}

function plural(count, word) {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

function competitionLink(competition) {
  return `[${escapeMarkdown(competition.title.replace(/[[\]]/g, ''))}](<${competitionUrl(competition.id)}>)`;
}

// The permissions from SEND_PERMISSIONS the bot is missing in channel, by name.
function missingSendPermissions(channel, botUser) {
  const permissions = channel.permissionsFor(botUser);
  return SEND_PERMISSIONS.filter(([flag]) => !permissions?.has(flag)).map(([, name]) => name);
}

// The first non-blank line without its leading header, quote or list marker and inline formatting.
function announcementTitle(text) {
  const firstLine = text.split('\n').find(line => line.trim()) ?? '';
  const plain = firstLine
    .replace(/^\s*(?:-#\s+|#{1,3}\s+|>{1,3}\s*|[-*]\s+|\d+\.\s+)/, '')
    .replace(/[*_~`|\\]/g, '')
    .trim();
  return truncate(plain || 'Untitled', TITLE_MAX);
}

function button(action, draftId, label, style, { index, disabled = false } = {}) {
  const parts = [ID_PREFIX, action, draftId];
  if (index !== undefined) parts.push(index);
  return new ButtonBuilder().setCustomId(parts.join(':')).setLabel(label).setStyle(style).setDisabled(disabled);
}

// "Tue, Nov 3, 7:00 PM ET". Select menu text can't show Discord's local-time stamps.
function formatEastern(date) {
  return `${new Date(date).toLocaleString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })} ET`;
}

// The menu of competitions the winners come from, with the draft's ticked. A typed send time adds
// Automatic (the ones that last ended by then), ticked while no competition is picked, as when
// none had started and was still to end at setup. Null when setup found nothing to offer.
function buildCompetitionSelect(draft) {
  if (!draft.choices?.length) return null;
  const picked = new Set(draft.competitions.map(c => c.id));
  const options = [];
  if (draft.fixedSendAt) {
    options.push({ label: 'Automatic', value: 'auto', description: 'The competitions that last ended by the send time', default: picked.size === 0 });
  }
  for (const choice of draft.choices.slice(0, MAX_CHOICES - options.length)) {
    const ended = new Date(choice.endsAt) <= new Date();
    options.push({
      label: truncate(choice.title, 100),
      value: String(choice.id),
      description: `${ended ? 'Ended' : 'Ends'} ${formatEastern(choice.endsAt)}`,
      default: picked.has(choice.id),
    });
  }
  return new StringSelectMenuBuilder()
    .setCustomId(`${ID_PREFIX}:competitions:${draft.id}`)
    .setPlaceholder('Competitions the winners come from')
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(options);
}

function buildPanel(draft) {
  const { announcements } = draft;
  const length = joinAnnouncements(announcements).length;
  const overLimit = length > MESSAGE_LIMIT;
  const counter = `${length.toLocaleString('en-US')} / ${MESSAGE_LIMIT.toLocaleString('en-US')} characters`;

  const container = new ContainerBuilder()
    .setAccentColor(overLimit ? OVER_LIMIT_COLOR : DEFAULT_EMBED_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      '## 📣 Weekly announcement',
      `**Channel:** <#${draft.channelId}>`,
      `**Sends:** ${discordTimestamp(draft.sendAt, 'F')} (${discordTimestamp(draft.sendAt, 'R')})`,
      overLimit
        ? `**Announcements:** ⚠️ ${counter}, over one message's limit`
        : `**Announcements:** ${counter}`,
    ].join('\n')));

  const source = draft.competitions.length
    ? `From ${draft.competitions.map(competitionLink).join(', ')}`
    : 'From the competitions that have ended by the send time';
  const competitionSelect = buildCompetitionSelect(draft);
  const howToChange = !competitionSelect
    ? 'Added automatically, not editable.'
    : draft.fixedSendAt
      ? 'Pick specific competitions in the menu below.'
      : 'Pick others in the menu below. It sends 5 minutes after the last of them ends.';
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `🏆 **Weekly winners**, top 3 with chart\n-# ${source}. ${howToChange}`
  ));
  if (competitionSelect) container.addActionRowComponents(new ActionRowBuilder().addComponents(competitionSelect));

  if (announcements.length === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      'No announcements yet. Press **Add announcement** to write one.'
    ));
  }

  announcements.forEach((text, index) => {
    container
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `**${index + 1}.** ${announcementTitle(text)}\n-# ${plural(text.length, 'character')} · ${plural(text.split('\n').length, 'line')}`
      ))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        button('edit', draft.id, 'Edit', ButtonStyle.Secondary, { index }),
        button('up', draft.id, 'Up', ButtonStyle.Secondary, { index, disabled: index === 0 }),
        button('down', draft.id, 'Down', ButtonStyle.Secondary, { index, disabled: index === announcements.length - 1 }),
        button('remove', draft.id, 'Remove', ButtonStyle.Danger, { index })
      ));
  });

  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    button('add', draft.id, `Add announcement (${announcements.length}/${MAX_ANNOUNCEMENTS})`, ButtonStyle.Primary, {
      disabled: announcements.length >= MAX_ANNOUNCEMENTS,
    }),
    button('preview', draft.id, 'Preview', ButtonStyle.Success, { disabled: true }),
    button('cancel', draft.id, 'Cancel', ButtonStyle.Danger)
  ));

  return container;
}

// The panel as message options. Mentions in the announcement titles never ping.
function panelMessage(draft) {
  return { components: [buildPanel(draft)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

// Replaces the panel with a closing line.
function closedMessage(content) {
  return { components: [new TextDisplayBuilder().setContent(content)], flags: MessageFlags.IsComponentsV2 };
}

// index is the announcement's position, or 'new' to add one.
function buildTextModal(draftId, index, text) {
  const input = new TextInputBuilder()
    .setCustomId('text')
    .setLabel('Announcement')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MESSAGE_LIMIT)
    .setPlaceholder('Paste it as you want it posted. Formatting, emojis, @here and <@&role> pings are kept.');
  if (text) input.setValue(text);
  return new ModalBuilder()
    .setCustomId(`${ID_PREFIX}:modal:${draftId}:${index}`)
    .setTitle(index === 'new' ? 'Add announcement' : `Edit announcement ${index + 1}`)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function rejectNonTemplar(interaction) {
  console.log(`[WeeklyAnnounce] ${interaction.user.tag} pressed ${interaction.customId} without the Templar role`);
  return interaction.reply({ content: 'You need the Templar role to use this.', flags: MessageFlags.Ephemeral });
}

async function handleWeeklyAnnounceButton(interaction) {
  const [, action, draftId, indexRaw] = interaction.customId.split(':');
  if (!isTemplar(interaction.member)) return rejectNonTemplar(interaction);

  const draft = getDraft(draftId);
  if (!draft) {
    console.log(`[WeeklyAnnounce] ${interaction.user.tag} pressed ${action} on draft ${draftId}, which no longer exists`);
    return interaction.update(closedMessage('This draft no longer exists. Run `/weeklyannounce setup` to start a new one.'));
  }
  console.log(`[WeeklyAnnounce] ${interaction.user.tag} pressed ${action}${indexRaw === undefined ? '' : ` ${indexRaw}`} on draft ${draftId}`);

  const index = Number(indexRaw);
  const count = draft.announcements.length;
  const validIndex = Number.isInteger(index) && index >= 0 && index < count;

  if (action === 'cancel') {
    deleteDraft(draftId);
    return interaction.update(closedMessage('Cancelled. The draft was discarded and nothing was scheduled.'));
  }
  if (action === 'add') {
    if (count >= MAX_ANNOUNCEMENTS) return interaction.update(panelMessage(draft));
    return interaction.showModal(buildTextModal(draftId, 'new'));
  }
  // The panel is redrawn from the saved draft whenever a button points at a row that's gone.
  if (!validIndex) return interaction.update(panelMessage(draft));

  if (action === 'edit') {
    return interaction.showModal(buildTextModal(draftId, index, draft.announcements[index]));
  }
  if (action === 'up' || action === 'down' || action === 'remove') {
    const updated = updateDraft(draftId, d => {
      if (action === 'remove') {
        d.announcements.splice(index, 1);
        return;
      }
      const other = action === 'up' ? index - 1 : index + 1;
      if (other < 0 || other >= d.announcements.length) return;
      [d.announcements[index], d.announcements[other]] = [d.announcements[other], d.announcements[index]];
    });
    return interaction.update(panelMessage(updated ?? draft));
  }
}

// The competitions menu. Picking competitions moves the send time to when the last of them ends,
// unless it was typed. Automatic ticked alongside others means whichever was ticked last.
async function handleWeeklyAnnounceSelect(interaction) {
  const [, action, draftId] = interaction.customId.split(':');
  if (!isTemplar(interaction.member)) return rejectNonTemplar(interaction);
  if (action !== 'competitions') return;

  const draft = getDraft(draftId);
  if (!draft) {
    console.log(`[WeeklyAnnounce] ${interaction.user.tag} picked competitions on draft ${draftId}, which no longer exists`);
    return interaction.update(closedMessage('This draft no longer exists. Run `/weeklyannounce setup` to start a new one.'));
  }

  const values = interaction.values;
  const updated = updateDraft(draftId, d => {
    const ids = values.filter(v => v !== 'auto');
    const auto = values.includes('auto') && (ids.length === 0 || d.competitions.length > 0);
    if (auto) {
      d.competitions = [];
      return;
    }
    const picked = d.choices.filter(c => ids.includes(String(c.id)));
    if (picked.length === 0) return;
    d.competitions = picked.map(c => ({ id: c.id, title: c.title }));
    if (!d.fixedSendAt) d.sendAt = new Date(Math.max(...picked.map(c => new Date(c.endsAt).getTime())) + SEND_DELAY_MS).toISOString();
  });
  const result = updated ?? draft;
  console.log(
    `[WeeklyAnnounce] ${interaction.user.tag} set draft ${draftId}'s competitions to ` +
    `${result.competitions.length ? result.competitions.map(c => `#${c.id}`).join(', ') : 'automatic'}, sending ${result.sendAt}`
  );
  await interaction.update(panelMessage(result));
}

async function handleWeeklyAnnounceModal(interaction) {
  const [, , draftId, indexRaw] = interaction.customId.split(':');
  if (!isTemplar(interaction.member)) return rejectNonTemplar(interaction);

  // Kept exactly as typed or pasted.
  const text = interaction.fields.getTextInputValue('text');
  if (!text.trim()) {
    return interaction.reply({ content: 'That announcement was empty, so nothing was saved.', flags: MessageFlags.Ephemeral });
  }

  let problem = null;
  const draft = updateDraft(draftId, d => {
    if (indexRaw === 'new') {
      if (d.announcements.length >= MAX_ANNOUNCEMENTS) problem = `The draft already has ${MAX_ANNOUNCEMENTS} announcements, so this one wasn't added.`;
      else d.announcements.push(text);
      return;
    }
    const index = Number(indexRaw);
    if (Number.isInteger(index) && index >= 0 && index < d.announcements.length) d.announcements[index] = text;
    else problem = 'That announcement was removed while you were editing it, so the edit wasn\'t saved.';
  });
  if (!draft) {
    return interaction.update(closedMessage('This draft no longer exists. Run `/weeklyannounce setup` to start a new one.'));
  }

  console.log(
    `[WeeklyAnnounce] ${interaction.user.tag} ${indexRaw === 'new' ? 'added an announcement' : `edited announcement ${Number(indexRaw) + 1}`} ` +
    `on draft ${draftId} (${text.length} characters)${problem ? `, not saved: ${problem}` : ''}`
  );
  await interaction.update(panelMessage(draft));
  if (problem) await interaction.followUp({ content: problem, flags: MessageFlags.Ephemeral });
}

module.exports = {
  requiredEnv: ['TEMPLAR_ROLE_ID', 'WOM_GROUP_ID', 'ADMIN_LOG_CHANNEL_ID'],

  data: buildCommandData(),

  handleWeeklyAnnounceButton,
  handleWeeklyAnnounceSelect,
  handleWeeklyAnnounceModal,

  async execute(interaction) {
    console.log(`[WeeklyAnnounce] ${interaction.user.tag} ran /weeklyannounce ${interaction.options.getSubcommand()}`);
    // Logs why the command was turned down, then tells the user privately.
    const reject = (content) => {
      console.log(`[WeeklyAnnounce] Rejected /weeklyannounce from ${interaction.user.tag}: ${content}`);
      return interaction.deferred
        ? interaction.editReply({ content })
        : interaction.reply({ content, flags: MessageFlags.Ephemeral });
    };

    if (!isTemplar(interaction.member)) {
      return reject('You need the Templar role to use this command.');
    }

    const startInput = interaction.options.getString('start');
    let sendAt = null;
    if (startInput) {
      sendAt = parseDateInput(startInput);
      if (!sendAt) {
        const example = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        return reject(`Could not parse the start time. Use \`YYYY-MM-DD\`, \`YYYY/MM/DD\`, or \`MM/DD/YYYY\` (Eastern Time), optionally with an hour — \`HH\` (24-hour) or \`H\` + \`am\`/\`pm\`, e.g. \`${example} 18\` or \`${example} 6pm\`. Leave it blank to send 5 minutes after the next competition ends.`);
      }
      if (sendAt <= new Date()) {
        return reject(`The start time (${discordTimestamp(sendAt, 'F')}) has already passed. Pick a time in the future.`);
      }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channelId = CHANNEL_ID ?? interaction.options.getChannel('channel', true).id;
    let channel;
    try {
      channel = await interaction.client.channels.fetch(channelId);
    } catch (err) {
      console.error(`[WeeklyAnnounce] Could not fetch channel ${channelId}:`, err.message);
    }
    if (!channel?.isTextBased()) {
      return reject(CHANNEL_ID
        ? `\`WEEKLY_ANNOUNCE_CHANNEL_ID\` (${channelId}) isn't a text channel the bot can see. Ask an admin to check it.`
        : `The bot can't see <#${channelId}>. Pick another channel or give the bot access.`);
    }
    const missing = missingSendPermissions(channel, interaction.client.user);
    if (missing.length > 0) {
      return reject(`The bot is missing **${missing.join(', ')}** in ${channel}. Give it those permissions and try again.`);
    }

    // The winners default to the competitions ending next, also with a typed send time (among those
    // started by then). A typed send time works without WOM: the winners are then the ones that last
    // ended by then, with nothing to pick from.
    const fixedSendAt = Boolean(sendAt);
    let all = [];
    try {
      all = await loadGroupCompetitions(WOM_GROUP_ID);
    } catch (err) {
      console.error('[WeeklyAnnounce] Failed to load the group competitions:', err);
      if (!fixedSendAt) {
        return reject(`Couldn't load the group's competitions from Wise Old Man: ${err.message}. Try again, or type a \`start\` time.`);
      }
    }
    let ending = [];
    if (!fixedSendAt) {
      const next = findNextEnding(all);
      sendAt = next.endsAt && new Date(next.endsAt.getTime() + SEND_DELAY_MS);
      ending = next.competitions;
      if (!sendAt) {
        return reject('No competition in the Wise Old Man group ends in the future. Create one with `/weeklycomp`, or type a `start` time.');
      }
    } else {
      ending = findNextEnding(all.filter(c => new Date(c.startsAt) <= sendAt)).competitions;
    }

    const draft = createDraft({
      ownerId: interaction.user.id,
      channelId: channel.id,
      sendAt,
      fixedSendAt,
      competitions: ending.map(c => ({ id: c.id, title: c.title })),
      choices: competitionChoices(all, { fixedSendAt: fixedSendAt ? sendAt : null }),
    });
    console.log(
      `[WeeklyAnnounce] ${interaction.user.tag} started draft ${draft.id} for #${channel.name} at ${sendAt.toISOString()} ` +
      `(${fixedSendAt ? 'typed start' : '5 minutes after they end'}, winners from ${ending.length ? ending.map(c => `#${c.id}`).join(', ') : 'the last ended by then'})`
    );
    await interaction.editReply(panelMessage(draft));
  },
};
