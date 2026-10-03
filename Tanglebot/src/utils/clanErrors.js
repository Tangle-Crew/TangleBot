// Do not log Axios request objects: they include Authorization/apikey headers.
function logClanError(context, error, env = process.env) {
  let message = String(error?.response?.data?.message ?? error?.response?.data?.error ?? error?.message ?? 'Unknown error');
  for (const [key, value] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value) message = message.split(value).join('[redacted]');
  }
  message = message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  console.error(`[Clan] ${context}`, {
    status: error?.response?.status,
    code: error?.code,
    message: message.slice(0, 1000),
  });
}
module.exports = { logClanError };
