const { MessageFlags } = require('discord.js');
const { hasAnyRole } = require('./common');

// Refuses a command unless the member has one of roleIds (unset IDs are ignored, so none set refuses
// everyone): logs it, flags it for the command log and replies privately. Returns true if refused.
async function refuseWithoutRole(interaction, roleIds, { logPrefix, command, missing, message }) {
  if (hasAnyRole(interaction.member, roleIds)) return false;
  console.log(`${logPrefix} ${interaction.user.tag} was denied ${command} (${missing})`);
  interaction.commandDenied = true; // for the command log
  await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  return true;
}

module.exports = { refuseWithoutRole };
