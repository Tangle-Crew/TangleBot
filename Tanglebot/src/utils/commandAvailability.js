// Which commands load: each command's required env vars, and whether PostgreSQL is configured.
function databaseConfigured(env = process.env) {
  return Boolean(env.DATABASE_URL?.trim());
}

function commandDisabledReason(command, env = process.env) {
  if (command.requiredFeature && env[command.requiredFeature]?.trim().toLowerCase() !== 'true') {
    return `${command.requiredFeature} must be true after backend setup`;
  }
  const missing = (command.requiredEnv ?? []).filter(key => !env[key]?.trim());
  if (missing.length) return `missing env var(s): ${missing.join(', ')}`;
  // requiredEnvAny is one list (at least one must be set) or a list of such lists.
  const anyGroups = Array.isArray(command.requiredEnvAny?.[0]) ? command.requiredEnvAny : [command.requiredEnvAny ?? []];
  for (const group of anyGroups) {
    if (group.length && !group.some(key => env[key]?.trim())) return `none of the env var(s) set: ${group.join(', ')}`;
  }
  return null;
}
module.exports = { commandDisabledReason, databaseConfigured };
