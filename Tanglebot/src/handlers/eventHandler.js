const { Events, MessageFlags } = require('discord.js');
const { syncCommands } = require('./commandHandler');
const { handleSubmissionMessage, loadSubmissionConfig } = require('../utils/submissionIntake');
const {
  handleHoneypotButtonInteraction,
  handleHoneypotMessage,
  loadHoneypotConfig,
  sendHoneypotStartupMessage,
} = require('../utils/honeypot');
const { handleRoleMenuButtonInteraction, syncRoleAppearance } = require('../utils/roleMenu');
const {
  handleLfgPostSelectInteraction,
  handleLfgManageSelect,
  handleLfgManageModalSubmit,
  handleLfgPostButtonInteraction,
  handleLfgPostModalSubmit,
  handleLfgPostGroupButtonInteraction,
  handleRetiredSyncedGroupButton,
  restoreLfgGroups,
} = require('../utils/lfgPost');
const { ensureLfgStartPost } = require('../utils/lfgStartPage');
const { refreshLeaderboard: refreshPetLeaderboard } = require('../commands/pethighscore');
const { refreshLeaderboard: refreshDonationLeaderboard } = require('../commands/donationhighscore');
const { handleStaleMembersButton, handleStaleMembersSelect, start: startStaleMembers } = require('../commands/stalemembers');
const { handleSuggestButton, handleSuggestModalSubmit } = require('../utils/lfgSuggestion');
const { logCommand } = require('../utils/commandLog');
const { registerMemberHistory, syncMemberRoster } = require('../utils/memberHistory');
const { startCompEndingReminder } = require('../utils/compEndingReminder');
const { handleWeeklyAnnounceButton, handleWeeklyAnnounceSelect, handleWeeklyAnnounceModal } = require('../commands/weeklyannounce');
const { restoreWeeklyAnnouncements, stopWeeklyAnnouncements } = require('../utils/weeklyAnnounceSchedule');

// customId prefix -> handler, per interaction kind. The honeypot route has no errorReply, so its
// failures stay silent.
const BUTTON_ROUTES = [
  { prefix: 'hp:', handler: handleHoneypotButtonInteraction, errorLabel: '[Honeypot] Button interaction error:' },
  { prefix: 'roles:', handler: handleRoleMenuButtonInteraction, errorLabel: '[LFG] Role menu button interaction error:', errorReply: 'Something went wrong updating your roles.' },
  { prefix: 'lfgpost:', handler: handleLfgPostButtonInteraction, errorLabel: '[LFG] Post button interaction error:', errorReply: 'Something went wrong creating your LFG post.' },
  { prefix: 'lfgsuggest:', handler: handleSuggestButton, errorLabel: '[LFG] Suggestion button error:', errorReply: 'Something went wrong opening the suggestion form.' },
  { prefix: 'lfgpostgroup:', handler: handleLfgPostGroupButtonInteraction, errorLabel: '[LFG] Post group button interaction error:', errorReply: 'Something went wrong updating that group.' },
  { prefix: 'lfgsyncgroup:', handler: handleRetiredSyncedGroupButton, errorLabel: '[LFG] Retired group button interaction error:', errorReply: 'Something went wrong with that LFG group.' },
  { prefix: 'stalemembers:', handler: handleStaleMembersButton, errorLabel: '[StaleMembers] Button interaction error:', errorReply: 'Something went wrong with that stale members list.' },
  { prefix: 'weeklyannounce:', handler: handleWeeklyAnnounceButton, errorLabel: '[WeeklyAnnounce] Button interaction error:', errorReply: 'Something went wrong updating that weekly announcement.' },
];
const SELECT_ROUTES = [
  { prefix: 'lfgmanage:', handler: handleLfgManageSelect, errorLabel: '[LFG] Manage select interaction error:', errorReply: 'Something went wrong updating that group.' },
  { prefix: 'lfgpost:', handler: handleLfgPostSelectInteraction, errorLabel: '[LFG] Post select interaction error:', errorReply: 'Something went wrong updating your LFG post setup.' },
  { prefix: 'stalemembers:', handler: handleStaleMembersSelect, errorLabel: '[StaleMembers] Rank picker interaction error:', errorReply: 'Something went wrong with the rank picker.' },
  { prefix: 'weeklyannounce:', handler: handleWeeklyAnnounceSelect, errorLabel: '[WeeklyAnnounce] Competition picker interaction error:', errorReply: 'Something went wrong updating that weekly announcement.' },
];
const MODAL_ROUTES = [
  { prefix: 'lfgsuggest:', handler: handleSuggestModalSubmit, errorLabel: '[LFG] Suggestion submit error:', errorReply: 'Something went wrong sending your suggestion.' },
  { prefix: 'lfgmanage:', handler: handleLfgManageModalSubmit, errorLabel: '[LFG] Manage modal submit error:', errorReply: 'Something went wrong updating that group.' },
  { prefix: 'lfgpost:', handler: handleLfgPostModalSubmit, errorLabel: '[LFG] Post modal submit error:', errorReply: 'Something went wrong creating your LFG post.' },
  { prefix: 'weeklyannounce:', handler: handleWeeklyAnnounceModal, errorLabel: '[WeeklyAnnounce] Modal submit error:', errorReply: 'Something went wrong saving that announcement.' },
];

// Runs the route matching the customId, logging (and optionally replying) on failure.
async function dispatchByCustomIdPrefix(interaction, routes) {
  const route = routes.find((r) => interaction.customId.startsWith(r.prefix));
  if (!route) return;
  try {
    await route.handler(interaction);
  } catch (err) {
    console.error(route.errorLabel, err);
    if (route.errorReply) await replyOrFollowUp(interaction, route.errorReply);
  }
}

function loadEvents(client) {
  let stopCompEndingReminder = null;
  const submissionConfig = loadSubmissionConfig();
  client.submissionConfig = submissionConfig;

  const honeypotConfig = loadHoneypotConfig();
  client.honeypotConfig = honeypotConfig;
  if (honeypotConfig.enabled) {
    console.log('[Honeypot] Channel trap enabled.');
  }

  client.once(Events.ClientReady, async (c) => {
    console.log(`[Bot] Logged in as ${c.user.tag}`);
    try {
      await syncCommands(client);
    } catch (err) {
      console.error('[Commands] Failed to sync slash commands:', err);
    }
    // Preloads ranks in the background and listens for update all; never throws.
    if (client.commands.has('stalemembers')) startStaleMembers(client);
    // Early, so buttons on existing LFG posts work again as soon as possible.
    try {
      await restoreLfgGroups(client);
    } catch (err) {
      console.error('[LFG] Failed to restore groups:', err);
    }
    stopCompEndingReminder = startCompEndingReminder(client);
    // Before the slower startup steps, so a post due while the bot was down goes out promptly.
    if (client.commands.has('weeklyannounce')) {
      try {
        restoreWeeklyAnnouncements(client);
      } catch (err) {
        console.error('[WeeklyAnnounce] Failed to restore scheduled posts:', err);
      }
    }

    try {
      await sendHoneypotStartupMessage(client, honeypotConfig);
    } catch (err) {
      console.error('[Honeypot] Failed to reset the trap channels on startup:', err);
    }

    try {
      await ensureLfgStartPost(client);
    } catch (err) {
      console.error('[LFG] Failed to ensure LFG start post:', err);
    }

    // Before the leaderboards, so a first sync stores everyone before names are refreshed.
    await syncMemberRoster(client);

    try {
      await refreshPetLeaderboard(client);
    } catch (err) {
      console.error('[PetHighscore] Failed to refresh pet leaderboard on startup:', err);
    }

    try {
      await refreshDonationLeaderboard(client);
    } catch (err) {
      console.error('[DonationHighscore] Failed to refresh donation leaderboard on startup:', err);
    }

    if (process.env.CLAN_ID) {
      try {
        const guild = await client.guilds.fetch(process.env.CLAN_ID);
        const { updated, failed } = await syncRoleAppearance(guild);
        if (updated.length || failed.length) {
          console.log(`[LFG] Role appearance sync: ${updated.length} updated, ${failed.length} failed.`);
        }
      } catch (err) {
        console.error('[LFG] Role appearance sync failed:', err.message);
      }
    }

    // Sent last, once every startup step has finished.
    const adminLogChannelId = process.env.ADMIN_LOG_CHANNEL_ID;
    const ownerRoleId = process.env.OWNER_ROLE_ID;
    if (adminLogChannelId) {
      try {
        const channel = await client.channels.fetch(adminLogChannelId);
        const ping = ownerRoleId ? `<@&${ownerRoleId}> ` : '';
        await channel.send(`${ping}Bot is online and ready.`);
        console.log('[Bot] Sent the online message to the admin log.');
      } catch (err) {
        console.error('[Bot] Failed to send the online message to the admin log:', err);
      }
    }
    console.log('[Bot] Startup finished.');
  });

  registerMemberHistory(client);

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleSubmissionMessage(message, submissionConfig);
    } catch (err) {
      console.error('[Submission] Intake error:', err);
    }

    try {
      await handleHoneypotMessage(message, honeypotConfig, client);
    } catch (err) {
      console.error('[Honeypot] Error handling a message:', err);
    }
  });

  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    const channelId = process.env.ANNOUNCEMENT_CHANNEL_ID;
    if (!channelId) return;
    if (newMessage.channelId !== channelId) return;
    if (newMessage.content !== '[Original Message Deleted]') return;
    try {
      await newMessage.delete();
      console.log(`[Announcements] Deleted crossposted message ${newMessage.id} whose original was deleted.`);
    } catch (err) {
      console.error('[Announcements] Failed to delete stale crossposted message:', err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
      await dispatchByCustomIdPrefix(interaction, BUTTON_ROUTES);
      return;
    }

    if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
      await dispatchByCustomIdPrefix(interaction, SELECT_ROUTES);
      return;
    }

    if (interaction.isModalSubmit()) {
      await dispatchByCustomIdPrefix(interaction, MODAL_ROUTES);
      return;
    }

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) {
      if (interaction.isChatInputCommand()) {
        await logCommand(interaction, { startedAt: Date.now(), error: 'Command is not loaded' });
      }
      return;
    }

    if (interaction.isAutocomplete()) {
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        console.error(`[Interactions] Autocomplete error for /${interaction.commandName}:`, err);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    await runCommand(interaction, command);
  });

  client.once(Events.ClientDestroy, () => {
    if (stopCompEndingReminder) {
      stopCompEndingReminder();
      stopCompEndingReminder = null;
    }
    stopWeeklyAnnouncements();
  });
}

// Runs a slash command and records who ran it, what it was, and whether it threw.
async function runCommand(interaction, command) {
  const startedAt = Date.now();
  let error = null;
  try {
    await command.execute(interaction);
  } catch (err) {
    error = err;
    console.error(`[Interactions] /${interaction.commandName} failed for ${interaction.user.tag}:`, err);
    await replyOrFollowUp(interaction, 'Something went wrong running that command.');
  }
  // Commands that catch their own errors set interaction.commandError so they are still logged as failed.
  await logCommand(interaction, { startedAt, error: error ?? interaction.commandError ?? null });
}

async function replyOrFollowUp(interaction, content) {
  const msg = { content, flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(msg).catch(() => {});
  } else {
    await interaction.reply(msg).catch(() => {});
  }
}

module.exports = { loadEvents, runCommand };
