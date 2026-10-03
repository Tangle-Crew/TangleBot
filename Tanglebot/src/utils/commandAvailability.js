function commandDisabledReason(command, env = process.env) {
  if (command.requiredFeature && env[command.requiredFeature]?.trim().toLowerCase() !== 'true') {
    return `${command.requiredFeature} must be true after backend setup`;
  }
  const missing = (command.requiredEnv ?? []).filter(key => !env[key]?.trim());
  if (missing.length) return `missing env var(s): ${missing.join(', ')}`;
  if (command.requiredEnvAny && !command.requiredEnvAny.some(key => env[key]?.trim())) {
    return `none of the env var(s) set: ${command.requiredEnvAny.join(', ')}`;
  }
  return null;
}
module.exports = { commandDisabledReason };
