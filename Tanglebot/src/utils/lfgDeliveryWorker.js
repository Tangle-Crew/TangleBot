const axios = require('axios');

const POLL_INTERVAL_MS = 3000;

function lfgWorkerConfig() {
  return {
    supabaseUrl: (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
    deliverySecret: (process.env.LFG_DELIVERY_SECRET ?? '').trim(),
  };
}

function isConfigured() {
  const config = lfgWorkerConfig();
  return Boolean(config.supabaseUrl && config.deliverySecret);
}

function startLfgDeliveryWorker() {
  if (!isConfigured()) {
    console.log('[LFG] Delivery worker disabled: SUPABASE_URL or LFG_DELIVERY_SECRET is missing.');
    return () => {};
  }

  const config = lfgWorkerConfig();
  let inFlight = false;

  const tick = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const response = await axios.post(
        `${config.supabaseUrl}/functions/v1/process-lfg-discord-delivery`,
        {},
        {
          headers: {
            Authorization: `Bearer ${config.deliverySecret}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      if (response.data?.processed) {
        console.log(
          `[LFG] Delivery worker processed queue item`
          + `${response.data?.groupId ? ` for group ${response.data.groupId}` : ''}`
          + `${response.data?.discordMessageId ? ` (message ${response.data.discordMessageId})` : ''}.`
        );
      }
    } catch (err) {
      const status = err?.response?.status;
      const details =
        err?.response?.data?.details
        || err?.response?.data?.error?.details
        || err?.response?.data?.message
        || err.message;
      console.error(`[LFG] Delivery worker error${status ? ` (${status})` : ''}: ${details}`);
    } finally {
      inFlight = false;
    }
  };

  tick().catch(() => {});
  const timer = setInterval(() => {
    tick().catch(() => {});
  }, POLL_INTERVAL_MS);

  return () => clearInterval(timer);
}

module.exports = {
  startLfgDeliveryWorker,
};
