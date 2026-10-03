const axios = require('axios');

function getConfig(env = process.env) {
  return {
    supabaseUrl: (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
    serviceRoleKey: (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
    websiteUrl: (env.CLAN_WEBSITE_URL ?? 'https://tanglecrew.group').trim().replace(/\/+$/, ''),
  };
}

async function createAccountLinkChallenge({ discordUserId, rsn, linkKind }, env = process.env) {
  const config = getConfig(env);
  if (!config.supabaseUrl || !config.serviceRoleKey) {
    throw new Error('Clan account linking is not configured on this bot.');
  }

  try {
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
  } catch (error) {
    const backendMessage = error?.response?.data?.message
      ?? error?.response?.data?.error
      ?? error?.message;
    throw new Error(backendMessage || 'Unable to start account linking.');
  }
}

async function callServiceRpc(name, body = {}, env = process.env) {
  const config = getConfig(env);
  if (!config.supabaseUrl || !config.serviceRoleKey) {
    throw new Error('The clan roster service is not configured on this bot.');
  }

  const response = await axios.post(`${config.supabaseUrl}/rest/v1/rpc/${name}`, body, {
    timeout: 10_000,
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
  });
  return response.data;
}

module.exports = { callServiceRpc, createAccountLinkChallenge, getConfig };
