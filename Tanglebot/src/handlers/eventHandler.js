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
} = require('../utils/lfgPost');
const { ensureLfgStartPost } = require('../utils/lfgStartPage');
const { refreshLeaderboardOnStartup: refreshPetLeaderboardOnStartup } = require('../commands/pethighscore');
const { refreshLeaderboardOnStartup: refreshDonationLeaderboardOnStartup } = require('../commands/donationhighscore');
const { syncDiscordCatalog, isConfigured: isLfgBackendConfigured } = require('../utils/lfgBackend');
const { startLfgDeliveryWorker } = require('../utils/lfgDeliveryWorker');
const { handleSyncedGroupButtonInteraction } = require('../utils/lfgSyncedPost');

// customId-prefix routing tables for InteractionCreate, one per interaction kind. errorReply is
// optional — omitted for the honeypot button so a mis-click there stays silent instead of
// tipping off whoever triggered it, matching every route's prior individual behavior.
const BUTTON_ROUTES = [
  { prefix: 'hp:', handler: handleHoneypotButtonInteraction, errorLabel: 'Honeypot button interaction error:' },
  { prefix: 'roles:', handler: handleRoleMenuButtonInteraction, errorLabel: 'Role menu button interaction error:', errorReply: 'Something went wrong updating your roles.' },
  { prefix: 'lfgpostgroup:', handler: handleLfgPostGroupButtonInteraction, errorLabel: '[LFG] Post group button interaction error:', errorReply: 'Something went wrong updating that group.' },
  { prefix: 'lfgsyncgroup:', handler: handleSyncedGroupButtonInteraction, errorLabel: '[LFG] Synced group button interaction error:', errorReply: 'Something went wrong updating that shared LFG group.' },
];
const SELECT_ROUTES = [
  { prefix: 'lfgpost:', handler: handleLfgPostSelectInteraction, errorLabel: '[LFG] Post select interaction error:', errorReply: 'Something went wrong updating your LFG post setup.' },
];
const MODAL_ROUTES = [
  { prefix: 'lfgpost:', handler: handleLfgPostModalSubmit, errorLabel: '[LFG] Post modal submit error:', errorReply: 'Something went wrong creating your LFG post.' },
];

// Finds the route whose prefix matches this interaction's customId (if any) and runs it, logging
// and optionally replying on failure — the shared shape every button/select/modal route above needs.
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
  const submissionConfig = loadSubmissionConfig();
  client.submissionConfig = submissionConfig;
  if (submissionConfig.enabled) {
    console.log('Discord submission intake enabled.');
  }

  const honeypotConfig = loadHoneypotConfig();
  client.honeypotConfig = honeypotConfig;
  if (honeypotConfig.enabled) {
    console.log('Honeypot channel trap enabled.');
  }

  client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    await syncCommands(client);
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

    const adminLogChannelId = process.env.ADMIN_LOG_CHANNEL_ID;
    const ownerRoleId = process.env.OWNER_ROLE_ID;
    if (adminLogChannelId) {
      try {
        const channel = await client.channels.fetch(adminLogChannelId);
        await channel.send(`<@&${ownerRoleId}> Bot is online and ready.`);
      } catch (err) {
        console.error('Failed to send startup message to admin log channel:', err);
      }
    }

    await sendHoneypotStartupMessage(client, honeypotConfig);
    await ensureLfgStartPost(client);
    await refreshPetLeaderboardOnStartup(client);
    await refreshDonationLeaderboardOnStartup(client);

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
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleSubmissionMessage(message, submissionConfig);
    } catch (err) {
      console.error('Submission intake error:', err);
    }

    try {
      await handleHoneypotMessage(message, honeypotConfig, client);
    } catch (err) {
      console.error('Honeypot error:', err);
    }
  });

  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    const channelId = process.env.ANNOUNCEMENT_CHANNEL_ID;
    if (!channelId) return;
    if (newMessage.channelId !== channelId) return;
    if (newMessage.content !== '[Original Message Deleted]') return;
    try {
      await newMessage.delete();
    } catch (err) {
      console.error('Failed to delete stale announcement message:', err);
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
        console.error('Autocomplete error:', err);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(err);
      await replyOrFollowUp(interaction, 'Something went wrong running that command.');
    }
  });

  client.once(Events.ClientDestroy, () => {
    if (stopLfgDeliveryWorker) {
      stopLfgDeliveryWorker();
      stopLfgDeliveryWorker = null;
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
