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
  handleLfgPostModalSubmit,
  handleLfgPostGroupButtonInteraction,
  restoreLfgGroups,
} = require('../utils/lfgPost');
const { ensureLfgStartPost } = require('../utils/lfgStartPage');
const { refreshLeaderboard: refreshPetLeaderboard } = require('../commands/pethighscore');
const { refreshLeaderboard: refreshDonationLeaderboard } = require('../commands/donationhighscore');
const { syncDiscordCatalog, isConfigured: isLfgBackendConfigured } = require('../utils/lfgBackend');
const { startLfgDeliveryWorker } = require('../utils/lfgDeliveryWorker');
const { startCompEndingReminder } = require('../utils/compEndingReminder');
const { handleSyncedGroupButtonInteraction } = require('../utils/lfgSyncedPost');

// customId prefix -> handler, per interaction kind. The honeypot route has no errorReply, so its
// failures stay silent.
const BUTTON_ROUTES = [
  { prefix: 'hp:', handler: handleHoneypotButtonInteraction, errorLabel: '[Honeypot] Button interaction error:' },
  { prefix: 'roles:', handler: handleRoleMenuButtonInteraction, errorLabel: '[LFG] Role menu button interaction error:', errorReply: 'Something went wrong updating your roles.' },
  { prefix: 'lfgpostgroup:', handler: handleLfgPostGroupButtonInteraction, errorLabel: '[LFG] Post group button interaction error:', errorReply: 'Something went wrong updating that group.' },
  { prefix: 'lfgsyncgroup:', handler: handleSyncedGroupButtonInteraction, errorLabel: '[LFG] Synced group button interaction error:', errorReply: 'Something went wrong updating that shared LFG group.' },
];
const SELECT_ROUTES = [
  { prefix: 'lfgpost:', handler: handleLfgPostSelectInteraction, errorLabel: '[LFG] Post select interaction error:', errorReply: 'Something went wrong updating your LFG post setup.' },
];
const MODAL_ROUTES = [
  { prefix: 'lfgpost:', handler: handleLfgPostModalSubmit, errorLabel: '[LFG] Post modal submit error:', errorReply: 'Something went wrong creating your LFG post.' },
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
  let stopLfgDeliveryWorker = null;
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
    // Early, so buttons on existing LFG posts work again as soon as possible.
    try {
      await restoreLfgGroups(client);
    } catch (err) {
      console.error('[LFG] Failed to restore groups:', err);
    }
    if (isLfgBackendConfigured()) {
      try {
        const result = await syncDiscordCatalog();
        if (!result?.skipped) {
          console.log(`[LFG] Synced Discord catalog to Supabase (${result?.updated ?? 0} rows updated).`);
        }
      } catch (err) {
        console.error('[LFG] Failed to sync Discord catalog to Supabase:', err.message);
      }
    }
    stopLfgDeliveryWorker = startLfgDeliveryWorker();
    stopCompEndingReminder = startCompEndingReminder(client);

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

    if (interaction.isStringSelectMenu()) {
      await dispatchByCustomIdPrefix(interaction, SELECT_ROUTES);
      return;
    }

    if (interaction.isModalSubmit()) {
      await dispatchByCustomIdPrefix(interaction, MODAL_ROUTES);
      return;
    }

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) return;

    if (interaction.isAutocomplete()) {
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        console.error(`[Interactions] Autocomplete error for /${interaction.commandName}:`, err);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`[Interactions] /${interaction.commandName} failed for ${interaction.user.tag}:`, err);
      await replyOrFollowUp(interaction, 'Something went wrong running that command.');
    }
  });

  client.once(Events.ClientDestroy, () => {
    if (stopLfgDeliveryWorker) {
      console.log('[LFG] Stopping delivery worker on client destroy');
      stopLfgDeliveryWorker();
      stopLfgDeliveryWorker = null;
    }
    if (stopCompEndingReminder) {
      stopCompEndingReminder();
      stopCompEndingReminder = null;
    }
  });
}

async function replyOrFollowUp(interaction, content) {
  const msg = { content, flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(msg).catch(() => {});
  } else {
    await interaction.reply(msg).catch(() => {});
  }
}

module.exports = { loadEvents };
