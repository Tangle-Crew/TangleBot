// Paged posts in the admin log for /quietmembers and /activitybackfill, in the style of
// /stalemembers: a header message, optional list messages with their own pages, and a private link
// for whoever ran the command somewhere else.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { DEFAULT_EMBED_COLOR } = require('./embedColor');
const { truncate } = require('./common');
const { notifyAdminLog } = require('./adminLog');

const PAGE_SIZE = 15;
const NO_PINGS = { parse: [] };

// An error whose message is only for whoever ran the command, with no admin log alert.
class NoticeError extends Error {}

function adminChannelId() {
  return process.env.ADMIN_LOG_CHANNEL_ID;
}

function adminChannel(client) {
  return client.channels.fetch(adminChannelId());
}

function adminLink(guildId, messageId) {
  return `https://discord.com/channels/${guildId}/${adminChannelId()}/${messageId}`;
}

function pageCount(count) {
  return Math.max(1, Math.ceil(count / PAGE_SIZE));
}

// One page of a list. `format(row, index)` gives a row's line.
function pageEmbed({ title, rows, page, format, noun, at }) {
  const start = page * PAGE_SIZE;
  const lines = rows.slice(start, start + PAGE_SIZE).map((row, i) => format(row, start + i));
  // Padded so every page is the same height and the buttons don't move. Discord trims empty lines,
  // so each pad is a zero-width space.
  while (lines.length < PAGE_SIZE) lines.push('​');
  return new EmbedBuilder()
    .setColor(DEFAULT_EMBED_COLOR)
    .setTitle(title)
    .setDescription(truncate(lines.join('\n'), 4096))
    .setFooter({ text: `Page ${page + 1}/${pageCount(rows.length)} · ${rows.length} ${noun}${rows.length === 1 ? '' : 's'}` })
    .setTimestamp(at);
}

// Prev, Next and Export under a list. `key` names the list in the button IDs.
function pageButtons(prefix, { key = null, page, count }) {
  const id = action => [`${prefix}${action}`, key].filter(Boolean).join(':');
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(id('prev')).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(id('next')).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount(count) - 1),
    new ButtonBuilder().setCustomId(id('export')).setLabel('📄 Export').setStyle(ButtonStyle.Success)
  );
}

function turnPage(page, action, count) {
  return action === 'prev' ? Math.max(0, page - 1) : Math.min(pageCount(count) - 1, page + 1);
}

// Posts the header (through `postHeader` when given, e.g. as the command's reply), then each of
// `parts` ([key, payload]). If any part fails, deletes what was posted and throws. Returns
// { header, [key]: messageId }.
async function sendGroup(client, header, parts, postHeader = null) {
  const channel = await adminChannel(client);
  const posted = [];
  try {
    const send = payload => channel.send({ ...payload, allowedMentions: NO_PINGS });
    const first = postHeader ? await postHeader({ ...header, allowedMentions: NO_PINGS }) : await send(header);
    posted.push(first.id);
    const ids = { header: first.id };
    for (const [key, payload] of parts) {
      ids[key] = (await send(payload)).id;
      posted.push(ids[key]);
    }
    return ids;
  } catch (err) {
    await Promise.all(posted.map(id => channel.messages.delete(id).catch(() => {})));
    throw err;
  }
}

// Message IDs grow over time, so a smaller one was posted earlier.
function isOlder(id, than) {
  return BigInt(id) < BigInt(than);
}

// Of several posts ({ header, ...parts }), deletes all but the newest and returns that one. Posts
// are told apart by their header, and keeping the newest by message age means overlapping runs leave
// the later post. Failures are logged and skipped.
async function keepNewest(client, posts, logPrefix) {
  const known = new Map();
  for (const ids of posts) {
    if (ids?.header) known.set(ids.header, { ...known.get(ids.header), ...ids });
  }
  const newest = [...known.keys()].reduce((a, b) => (isOlder(a, b) ? b : a));
  const old = [...known.values()].filter(ids => ids.header !== newest);
  if (old.length) {
    try {
      const channel = await adminChannel(client);
      await Promise.all(old.flatMap(ids => Object.values(ids).map(id => channel.messages.delete(id).catch(err => {
        // 10008 Unknown Message: it was already deleted.
        if (err?.code !== 10008) console.warn(`${logPrefix} Couldn't delete old message ${id}:`, err.message);
      }))));
    } catch (err) {
      console.warn(`${logPrefix} Couldn't load the admin log to delete old posts:`, err.message);
    }
  }
  return known.get(newest);
}

// Runs a command whose result goes to the admin log. `post(postHeader)` posts it and returns the
// header message ID; postHeader is set when the command was run in the admin log, so the post is the
// reply. Run anywhere else, the person gets a private link. Failures are told privately and reported
// to the admin log.
async function runAdminCommand(interaction, { command, logPrefix, post }) {
  const inAdminLog = interaction.channelId === adminChannelId();
  await interaction.deferReply(inAdminLog ? {} : { flags: MessageFlags.Ephemeral });
  try {
    const headerId = await post(inAdminLog ? payload => interaction.editReply(payload) : null);
    if (!inAdminLog) {
      await interaction.editReply(`📋 Posted in <#${adminChannelId()}>: ${adminLink(interaction.guildId, headerId)}`)
        .catch(err => console.warn(`${logPrefix} Couldn't send ${interaction.user.tag} the link:`, err.message));
    }
  } catch (err) {
    const notice = err instanceof NoticeError;
    if (!notice) {
      console.error(`${logPrefix} ${command} failed:`, err);
      interaction.commandError = err;
      await notifyAdminLog(interaction.client, `⚠️ ${command} failed`, truncate(`${interaction.user} used ${command}.\n\n${err.message}`, 4096));
    }
    const content = notice ? err.message : `Something went wrong: ${truncate(err.message, 500)}`;
    if (!inAdminLog) {
      await interaction.editReply(content).catch(() => {});
      return;
    }
    // In the admin log, the public "thinking" message is swapped for a private one.
    await interaction.deleteReply().catch(() => {});
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

module.exports = {
  NO_PINGS,
  NoticeError,
  adminChannel,
  pageCount,
  pageEmbed,
  pageButtons,
  turnPage,
  sendGroup,
  isOlder,
  keepNewest,
  runAdminCommand,
};
