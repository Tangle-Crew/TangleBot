const axios = require('axios');
const { buildDiscordLfgCatalog } = require('./roleMenu');

function normalizeBaseUrl(value) {
  return (value ?? '').trim().replace(/\/+$/, '');
}

function describeErrorPayload(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function lfgConfig() {
  return {
    supabaseUrl: normalizeBaseUrl(process.env.SUPABASE_URL),
    pluginToken: (process.env.LFG_PLUGIN_TOKEN ?? '').trim(),
    deliverySecret: (process.env.LFG_DELIVERY_SECRET ?? '').trim(),
  };
}

function isConfigured() {
  const config = lfgConfig();
  return Boolean(config.supabaseUrl && config.pluginToken);
}

function createHeaders({ playerHint, source = 'DISCORD', discordUserId = null, idempotencyKey = null } = {}) {
  const config = lfgConfig();
  const headers = {
    Authorization: `Bearer ${config.pluginToken}`,
    'Content-Type': 'application/json',
    'X-Lfg-Source': source,
    'X-Plugin-Version': 'tanglebot-bridge',
  };
  if (playerHint) headers['X-TcCrew-Player'] = playerHint;
  if (discordUserId) headers['X-TcCrew-Discord-User'] = discordUserId;
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  return headers;
}

function buildPlayerHint(memberOrUser) {
  const nickname = memberOrUser?.nickname?.trim();
  const displayName = memberOrUser?.displayName?.trim();
  const globalName = memberOrUser?.user?.globalName?.trim();
  const username = memberOrUser?.user?.username?.trim() ?? memberOrUser?.username?.trim();
  return nickname || displayName || globalName || username || '';
}

async function syncDiscordCatalog() {
  const config = lfgConfig();
  if (!config.supabaseUrl || !config.deliverySecret) {
    console.warn('[LFG] Catalog sync skipped: SUPABASE_URL or LFG_DELIVERY_SECRET is missing.');
    return { ok: false, skipped: true, reason: 'missing-config' };
  }

  const categories = buildDiscordLfgCatalog();
  const activityCount = categories.reduce((sum, category) => sum + (category.activities?.length ?? 0), 0);
  console.log(`[LFG] Syncing Discord catalog to Supabase: ${categories.length} categories, ${activityCount} activities.`);

  const response = await axios.post(
    `${config.supabaseUrl}/functions/v1/lfg-sync-discord-catalog`,
    { categories },
    {
      headers: {
        Authorization: `Bearer ${config.deliverySecret}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );

  console.log(`[LFG] Supabase catalog sync response: ok=${Boolean(response.data?.ok)}, updated=${response.data?.updated ?? 'unknown'}.`);

  return response.data;
}

async function createGroup({ member, categoryKey, activityLabel, description, startTimeIso, maximumPlayers, discordChannelId = null, discordMessageId = null }) {
  if (!isConfigured()) return null;

  const playerHint = buildPlayerHint(member);
  const discordUserId = member?.id ?? member?.user?.id ?? null;
  const idempotencyKey = `discord-create:${discordUserId ?? 'unknown'}:${Date.now()}`;
  let response;
  try {
    response = await axios.post(
      `${lfgConfig().supabaseUrl}/functions/v1/lfg-groups`,
      {
        categoryKey,
        activity: activityLabel,
        description: description ?? null,
        startTime: startTimeIso ?? null,
        maximumPlayers: maximumPlayers ?? null,
        discordChannelId,
        discordMessageId,
      },
      {
        headers: createHeaders({ playerHint, source: 'DISCORD', discordUserId, idempotencyKey }),
        timeout: 15000,
      }
    );
  } catch (err) {
    const status = err?.response?.status;
    const details =
      describeErrorPayload(err?.response?.data?.details)
      || describeErrorPayload(err?.response?.data?.error?.details)
      || describeErrorPayload(err?.response?.data?.error?.message)
      || describeErrorPayload(err?.response?.data?.error)
      || describeErrorPayload(err?.response?.data?.message)
      || describeErrorPayload(err?.response?.data)
      || err.message;
    const wrapped = new Error(`LFG create mirror failed${status ? ` (${status})` : ''}: ${details}`);
    wrapped.cause = err;
    throw wrapped;
  }

  return response.data ?? null;
}

async function actOnGroupDetailed({ member, groupId, action }) {
  if (!isConfigured() || !groupId) return null;

  const playerHint = buildPlayerHint(member);
  const discordUserId = member?.id ?? member?.user?.id ?? null;
  const idempotencyKey = `discord-action:${action}:${groupId}:${discordUserId ?? 'unknown'}:${Date.now()}`;
  let response;
  try {
    response = await axios.post(
      `${lfgConfig().supabaseUrl}/functions/v1/lfg-group-action`,
      {
        action,
        groupId,
        idempotencyKey,
      },
      {
        headers: createHeaders({ playerHint, source: 'DISCORD', discordUserId, idempotencyKey }),
        timeout: 15000,
      }
    );
  } catch (err) {
    const status = err?.response?.status;
    const details =
      describeErrorPayload(err?.response?.data?.details)
      || describeErrorPayload(err?.response?.data?.error?.details)
      || describeErrorPayload(err?.response?.data?.error?.message)
      || describeErrorPayload(err?.response?.data?.error)
      || describeErrorPayload(err?.response?.data?.message)
      || describeErrorPayload(err?.response?.data)
      || err.message;
    const wrapped = new Error(`LFG action mirror failed${status ? ` (${status})` : ''}: ${details}`);
    wrapped.cause = err;
    throw wrapped;
  }

  return response.data ?? null;
}

async function actOnGroup(args) {
  const data = await actOnGroupDetailed(args);
  return data?.group ?? null;
}

async function syncGroupMetadata({ groupId, queueCount = 0 }) {
  if (!isConfigured() || !groupId) return null;

  let response;
  try {
    response = await axios.post(
      `${lfgConfig().supabaseUrl}/functions/v1/lfg-group-metadata`,
      {
        groupId,
        queueCount,
      },
      {
        headers: {
          Authorization: `Bearer ${lfgConfig().pluginToken}`,
          'Content-Type': 'application/json',
          'X-Plugin-Version': 'tanglebot-bridge',
          'X-Lfg-Source': 'DISCORD',
        },
        timeout: 15000,
      }
    );
  } catch (err) {
    const status = err?.response?.status;
    const details =
      describeErrorPayload(err?.response?.data?.details)
      || describeErrorPayload(err?.response?.data?.error?.details)
      || describeErrorPayload(err?.response?.data?.error?.message)
      || describeErrorPayload(err?.response?.data?.error)
      || describeErrorPayload(err?.response?.data?.message)
      || describeErrorPayload(err?.response?.data)
      || err.message;
    const wrapped = new Error(`LFG metadata sync failed${status ? ` (${status})` : ''}: ${details}`);
    wrapped.cause = err;
    throw wrapped;
  }

  return response.data ?? null;
}

async function fetchGroups({ member }) {
  if (!isConfigured()) return [];

  const playerHint = buildPlayerHint(member);
  const discordUserId = member?.id ?? member?.user?.id ?? null;
  const response = await axios.get(
    `${lfgConfig().supabaseUrl}/functions/v1/lfg-groups`,
    {
      headers: createHeaders({ playerHint, source: 'DISCORD', discordUserId }),
      timeout: 15000,
    }
  );

  return response.data?.groups ?? [];
}

module.exports = {
  buildPlayerHint,
  isConfigured,
  syncDiscordCatalog,
  createGroup,
  actOnGroup,
  actOnGroupDetailed,
  syncGroupMetadata,
  fetchGroups,
};
