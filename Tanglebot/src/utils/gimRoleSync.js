const { PermissionFlagsBits } = require('discord.js');
const { logClanError } = require('./clanErrors');
const isSnowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const runningGuilds = new Set();

async function reconcileGimRoles(guild, plan, { deadline = Date.now() + 12 * 60 * 1000 } = {}) {
  if (!guild || runningGuilds.has(guild.id)) throw new Error('A GIM sync is already running or the server is unavailable.');
  runningGuilds.add(guild.id);
  try {
    // Malformed/incomplete responses must never be interpreted as an empty plan.
    if (!Array.isArray(plan?.roleIds) || !Array.isArray(plan?.assignments)
      || plan.roleIds.some(id => !isSnowflake(id))) throw new Error('Invalid GIM role plan.');
    const roleIds = [...new Set(plan.roleIds)];
    const failures = [];
    const desiredByUser = new Map();
    for (const assignment of plan.assignments) {
      if (!isSnowflake(assignment?.discordUserId)) {
        failures.push('Skipped a roster entry without a valid Discord ID.');
        continue;
      }
      if (assignment.roleId != null && !roleIds.includes(assignment.roleId)) {
        throw new Error('GIM assignment references an unconfigured role.');
      }
      const desired = desiredByUser.get(assignment.discordUserId) ?? new Set();
      if (assignment.roleId) desired.add(assignment.roleId);
      desiredByUser.set(assignment.discordUserId, desired);
    }

    await guild.roles.fetch();
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot is missing Manage Roles permission.');
    const unusableRoleIds = roleIds.filter(id => !guild.roles.cache.get(id)?.editable);
    // Populate all current holders as well as planned users. The cache alone can
    // omit departed/unlinked roster members who still belong to this Discord guild.
    // This is one bulk gateway fetch, not an individual REST request per member.
    const members = await guild.members.fetch({ time: 60000, withPresences: false });
    const userIds = new Set(desiredByUser.keys());
    for (const roleId of roleIds) {
      for (const member of guild.roles.cache.get(roleId)?.members.values() ?? []) userIds.add(member.id);
    }
    // Also use the fetched collection, avoiding reliance on role.members caching.
    for (const member of members.values()) {
      if (roleIds.some(id => member.roles.cache.has(id))) userIds.add(member.id);
    }
    let updated = 0;
    let unchanged = 0;
    let unprocessed = 0;
    let processed = 0;
    for (const userId of userIds) {
      if (Date.now() >= deadline) {
        unprocessed = userIds.size - processed;
        break;
      }
      processed += 1;
      const member = members.get(userId);
      if (!member) {
        failures.push(`Member ${userId}: not found in this Discord server.`);
        continue;
      }
      const desired = desiredByUser.get(userId) ?? new Set();
      const remove = roleIds.filter(id => member.roles.cache.has(id) && !desired.has(id));
      const add = [...desired].filter(id => !member.roles.cache.has(id));
      const blocked = [...new Set([...remove, ...desired])].filter(id => unusableRoleIds.includes(id));
      if (blocked.length || ((add.length || remove.length) && !member.manageable)) {
        failures.push(`Member ${userId}: bot cannot manage the member or required roles.`);
        continue;
      }
      if (!remove.length && !add.length) {
        unchanged += 1;
        continue;
      }
      try {
        // Individual role PUT/DELETE calls preserve unrelated roles. Do not use
        // an array here: Discord.js can replace the full role set from its cache.
        for (const roleId of add) await member.roles.add(roleId, 'Clan roster GIM role synchronization');
        for (const roleId of remove) await member.roles.remove(roleId, 'Clan roster GIM role synchronization');
        updated += 1;
      } catch (error) {
        logClanError(`GIM roles for member ${userId}`, error);
        failures.push(`Member ${userId}: Discord could not apply all role changes. Please retry.`);
      }
    }
    return { updated, unchanged, failures, unusableRoleIds, unprocessed };
  } finally {
    runningGuilds.delete(guild.id);
  }
}
module.exports = { reconcileGimRoles };
