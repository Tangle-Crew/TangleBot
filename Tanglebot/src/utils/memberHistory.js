const { Events } = require('discord.js');
const highScoresDb = require('./highScoresDb');

// Keeps the database's member history (display names, joins and leaves) current. Does nothing
// unless DATABASE_URL is set.

function toRow(member) {
  return { discordId: member.id, displayName: member.displayName, joinedAt: member.joinedAt ?? null };
}

// Compares every server member with the database, e.g. to catch what happened while the bot was
// down. Never throws.
async function syncMemberRoster(client) {
  if (!highScoresDb.usingDatabase() || !process.env.CLAN_ID) return;
  try {
    const guild = await client.guilds.fetch(process.env.CLAN_ID);
    const members = await guild.members.fetch();
    // A partial fetch would wrongly mark everyone missing as having left.
    if (guild.memberCount && members.size < guild.memberCount * 0.9) {
      console.warn(`[MemberHistory] Roster sync skipped: fetched ${members.size} of ${guild.memberCount} members`);
      return;
    }
    const roster = [...members.values()].filter(m => !m.user.bot).map(toRow);
    const { members: count, left } = await highScoresDb.syncRoster(roster);
    console.log(`[MemberHistory] Synced ${count} server member(s); ${left} leave(s) recorded for members who left`);
  } catch (err) {
    console.error('[MemberHistory] Roster sync failed:', err);
  }
}

// Records joins, leaves and display-name changes as they happen.
function registerMemberHistory(client) {
  const run = async (label, fn) => {
    if (!highScoresDb.usingDatabase()) return;
    try {
      await fn();
    } catch (err) {
      console.error(`[MemberHistory] Failed to record ${label}:`, err);
    }
  };

  client.on(Events.GuildMemberAdd, member => {
    if (member.guild.id !== process.env.CLAN_ID || member.user.bot) return;
    return run('a join', () => highScoresDb.recordJoin(toRow(member)));
  });

  client.on(Events.GuildMemberRemove, member => {
    if (member.guild.id !== process.env.CLAN_ID || member.user?.bot) return;
    return run('a leave', () => highScoresDb.recordLeave({ discordId: member.id }));
  });

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (newMember.guild.id !== process.env.CLAN_ID || newMember.user.bot) return;
    // A partial old member has no name to compare; the next roster sync catches that change.
    if (oldMember.partial || oldMember.displayName === newMember.displayName) return;
    return run('a name change', () => highScoresDb.recordNameChange(toRow(newMember)));
  });
}

module.exports = { registerMemberHistory, syncMemberRoster };
