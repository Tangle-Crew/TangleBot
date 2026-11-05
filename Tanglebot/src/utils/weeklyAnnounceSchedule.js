const { AttachmentBuilder, escapeMarkdown } = require('discord.js');
const { getJob, listPendingJobs, updateJob, buildPost } = require('./weeklyAnnounce');
const { notifyAdminLog } = require('./roleMenu');
const { discordTimestamp, truncate } = require('./db');

// setTimeout's longest delay (about 24.8 days); longer waits are re-armed when it fires.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// A send claimed this long ago without finishing was interrupted (a crash or restart) and is resumed.
// Long enough for a send that's still running in another instance during a deploy to finish.
const SENDING_STALE_MS = 15 * 60 * 1000;
// Loading the winners at send time is retried this many times, this far apart, before the
// announcements are sent without them.
const WINNERS_ATTEMPTS = 3;
const WINNERS_RETRY_MS = 2 * 60 * 1000;
// Sends starting later than this after their send time are reported to the admin log as late.
const LATE_ALERT_MS = 2 * 60 * 1000;
// The winners message and announcements ping as written: @everyone/@here, roles and users.
const POST_MENTIONS = { parse: ['everyone', 'roles', 'users'] };
const SENT_COLOR = 0x3ba55d;
const FAILED_COLOR = 0xc0392b;
const LATE_COLOR = 0xe67e22;

const timers = new Map(); // job ID -> timeout

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function messageLink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

// Links to the messages a job has posted so far, or "nothing".
function describeSent(job, guildId) {
  const links = [];
  if (job.sent.winners) links.push(`[winners](${messageLink(guildId, job.channelId, job.sent.winners)})`);
  job.sent.announcements.forEach((id, i) => {
    links.push(`[announcements${job.sent.announcements.length > 1 ? ` ${i + 1}` : ''}](${messageLink(guildId, job.channelId, id)})`);
  });
  return links.length ? links.join(', ') : 'nothing';
}

// Marks the job as sending, so it's sent once even if its timer fires twice or another bot instance
// has it too. True if this call claimed it: it was scheduled, or a send claimed it so long ago that
// it was interrupted.
function claimJob(id) {
  let claimed = false;
  updateJob(id, job => {
    const interrupted = job.status === 'sending' && Date.now() - new Date(job.claimedAt).getTime() >= SENDING_STALE_MS;
    if (job.status !== 'scheduled' && !interrupted) return;
    job.resumed = interrupted;
    job.status = 'sending';
    job.claimedAt = new Date().toISOString();
    claimed = true;
  });
  return claimed;
}

// Builds the post with fresh WOM data, retrying when WOM can't be reached.
async function buildPostWithRetries(job, guild) {
  let post;
  for (let attempt = 1; attempt <= WINNERS_ATTEMPTS; attempt++) {
    post = await buildPost(job, guild, { fresh: true });
    if (!post.winnersError) return post;
    console.warn(`[WeeklyAnnounce] Job ${job.id}: loading the winners failed (attempt ${attempt}/${WINNERS_ATTEMPTS}): ${post.winnersError}`);
    if (attempt < WINNERS_ATTEMPTS) await sleep(WINNERS_RETRY_MS);
  }
  return post;
}

// Posts the job's winners message, then its announcements, skipping any a resumed send already
// posted, and reports the result to the admin log.
async function sendJob(client, id) {
  if (!claimJob(id)) return;
  let job = getJob(id);
  const lateMs = Date.now() - new Date(job.sendAt).getTime();
  console.log(`[WeeklyAnnounce] Sending job ${id}${job.resumed ? ' (resuming an interrupted send)' : ''}${lateMs > LATE_ALERT_MS ? `, ${Math.round(lateMs / 60000)} min late` : ''}`);

  if (job.resumed || lateMs > LATE_ALERT_MS) {
    await notifyAdminLog(
      client,
      '⚠️ Weekly announcement sending late',
      job.resumed
        ? `The send due ${discordTimestamp(job.sendAt, 'F')} in <#${job.channelId}> was interrupted. Sending what's left now.`
        : `The bot wasn't running at the send time (${discordTimestamp(job.sendAt, 'F')}), so the post for <#${job.channelId}> is being sent now, ${Math.round(lateMs / 60000)} minutes late.`,
      [],
      LATE_COLOR
    );
  }

  let channel = null;
  try {
    channel = await client.channels.fetch(job.channelId);
    const post = await buildPostWithRetries(job, channel.guild);
    if (post.announcementParts === null) throw new Error('the announcements no longer fit in 2 messages');

    if (post.winnersText && !job.sent.winners) {
      const message = await channel.send({
        content: post.winnersText,
        files: post.charts.map(c => new AttachmentBuilder(c.attachment, { name: c.name })),
        allowedMentions: POST_MENTIONS,
      });
      job = updateJob(id, j => { j.sent.winners = message.id; });
    }
    for (let i = job.sent.announcements.length; i < post.announcementParts.length; i++) {
      const message = await channel.send({ content: post.announcementParts[i], allowedMentions: POST_MENTIONS });
      job = updateJob(id, j => { j.sent.announcements.push(message.id); });
    }
    job = updateJob(id, j => {
      j.status = 'sent';
      j.sentAt = new Date().toISOString();
    });
    console.log(`[WeeklyAnnounce] Sent job ${id} to #${channel.name}`);

    const problems = [];
    if (post.winnersError) problems.push(`⚠️ The winners couldn't be loaded from Wise Old Man, so no winners message was sent: ${post.winnersError}`);
    else if (!post.winnersText) problems.push('⚠️ No competition had ended by the send time, so no winners message was sent.');
    for (const problem of post.chartProblems) problems.push(`⚠️ No chart for ${problem}`);
    // Worth knowing, but the post went out as intended.
    const notes = [];
    const unmatched = post.winners.filter(w => !w.userId).map(w => escapeMarkdown(w.name));
    if (unmatched.length) notes.push(`-# Shown by RSN without a ping (no server member matched): ${unmatched.join(', ')}`);
    for (const problem of post.emojiProblems) notes.push(`-# No pet emoji for ${problem}`);
    await notifyAdminLog(
      client,
      problems.length ? '⚠️ Weekly announcement sent with problems' : '📣 Weekly announcement sent',
      truncate(`Posted in <#${job.channelId}> (scheduled by <@${job.acceptedBy}>): ${describeSent(job, channel.guild.id)}.${[...problems, ...notes].map(line => `\n${line}`).join('')}`, 4096),
      [],
      problems.length ? LATE_COLOR : SENT_COLOR
    );
  } catch (err) {
    console.error(`[WeeklyAnnounce] Job ${id} failed:`, err);
    job = updateJob(id, j => {
      j.status = 'failed';
      j.error = err.message;
    }) ?? job;
    await notifyAdminLog(
      client,
      '❌ Weekly announcement failed',
      truncate(
        `The post due ${discordTimestamp(job.sendAt, 'F')} in <#${job.channelId}> (scheduled by <@${job.acceptedBy}>) failed: ${err.message}\n` +
        `Already posted: ${describeSent(job, channel?.guild?.id ?? process.env.CLAN_ID)}. Nothing more is sent automatically, so post the rest by hand or schedule it again.`,
        4096
      ),
      [],
      FAILED_COLOR
    );
  }
}

// Sends the job at its send time, or right away if that has passed.
function scheduleJob(client, job) {
  clearTimeout(timers.get(job.id));
  const delay = new Date(job.sendAt).getTime() - Date.now();
  const run = delay > MAX_TIMEOUT_MS
    ? () => { const current = getJob(job.id); if (current) scheduleJob(client, current); }
    : () => { timers.delete(job.id); sendJob(client, job.id).catch(err => console.error(`[WeeklyAnnounce] Job ${job.id} failed:`, err)); };
  timers.set(job.id, setTimeout(run, Math.min(Math.max(delay, 0), MAX_TIMEOUT_MS)));
}

// Called on startup: re-arms every scheduled job, sending late any whose time passed while the bot
// was down, and resumes sends that were interrupted once they've gone stale.
function restoreWeeklyAnnouncements(client) {
  const jobs = listPendingJobs();
  for (const job of jobs) {
    if (job.status === 'sending') {
      const wait = Math.max(SENDING_STALE_MS - (Date.now() - new Date(job.claimedAt).getTime()), 0);
      console.log(`[WeeklyAnnounce] Job ${job.id} was being sent; resuming in ${Math.round(wait / 1000)}s if it hasn't finished`);
      clearTimeout(timers.get(job.id));
      timers.set(job.id, setTimeout(() => {
        timers.delete(job.id);
        sendJob(client, job.id).catch(err => console.error(`[WeeklyAnnounce] Job ${job.id} failed:`, err));
      }, wait));
    } else {
      scheduleJob(client, job);
    }
  }
  console.log(`[WeeklyAnnounce] Restored ${jobs.length} scheduled post(s).`);
}

function stopWeeklyAnnouncements() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

module.exports = { scheduleJob, restoreWeeklyAnnouncements, stopWeeklyAnnouncements };
