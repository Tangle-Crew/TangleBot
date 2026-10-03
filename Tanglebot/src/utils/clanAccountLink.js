const axios = require('axios');
const { normalizeBaseUrl } = require('./baseUrl');
const { logClanError, ClanCommandError } = require('./clanErrors');

function getConfig(env = process.env) {
  return {
    supabaseUrl: normalizeBaseUrl(env.SUPABASE_URL),
    serviceRoleKey: (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
    websiteUrl: normalizeBaseUrl(env.CLAN_WEBSITE_URL) || 'https://tanglecrew.group',
  };
}

async function createAccountLinkChallenge({ discordUserId, rsn, linkKind }, env = process.env) {
  const config = getConfig(env);
  if (!config.supabaseUrl || !config.serviceRoleKey) {
    throw new Error('Clan account linking is not configured on this bot.');
  }

  const data = await callServiceRpc('create_clan_link_challenge', {
    requested_discord_user_id: discordUserId,
    requested_rsn: rsn,
    requested_link_kind: linkKind,
  }, env);

  const challenge = Array.isArray(data) ? data[0] : data;
  if (!challenge?.challenge_token) {
    throw new Error('The roster service did not return a verification challenge.');
  }

  const memberPath = `/member?rosterLink=${encodeURIComponent(challenge.challenge_token)}`;
  const confirmationUrl = `${config.websiteUrl}/login?next=${encodeURIComponent(memberPath)}`;

  return {
    confirmationUrl,
    expiresAt: challenge.expires_at,
    resolvedRsn: challenge.resolved_rsn,
    linkKind: challenge.link_kind,
  };
}

async function callServiceRpc(name, body = {}, env = process.env) {
  const config = getConfig(env);
  if (!config.supabaseUrl || !config.serviceRoleKey) {
    throw new Error('The clan roster service is not configured on this bot.');
  }

  try {
    const response = await axios.post(`${config.supabaseUrl}/rest/v1/rpc/${name}`, body, {
      timeout: 10_000,
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    logClanError(`RPC ${name}`, error, env);
    // Only known member-actionable database validations are safe to display.
    // P0001 also includes service-role/auth checks, which must stay private.
    const message = error?.response?.data?.message;
    const actionable = new Set([
      'A valid Discord user ID is required.',
      'A RuneScape name is required.',
      'That RSN is not present in the clan roster.',
      'That RSN is not an active clan account.',
      'That account is already linked to another Discord member. Contact an administrator.',
      'Link a primary account with /link before adding an alt.',
    ]);
    const safeMessage = error?.response?.status === 400 && error?.response?.data?.code === 'P0001'
      && actionable.has(message) ? message : 'The clan service is unavailable. Please contact an administrator.';
    throw new ClanCommandError(safeMessage, true);
  }
}

module.exports = { callServiceRpc, createAccountLinkChallenge, getConfig };
