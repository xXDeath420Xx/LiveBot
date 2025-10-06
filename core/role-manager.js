const logger = require("../utils/logger");
const db = require("../utils/db");
async function cleanupInvalidRole(guildId, roleId) {
if (!guildId || !roleId) return;
logger.warn(`[Role Cleanup] Purging invalid role ID ${roleId} from all settings for guild ${guildId}.`);
try {
await db.execute("UPDATE guilds SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?", [guildId, roleId]);
await db.execute("UPDATE twitch_teams SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?", [guildId, roleId]);
} catch (dbError) {
logger.error(`[Role Cleanup] DB Error while purging role ${roleId} for guild ${guildId}:`, {error: dbError});
}
}
async function handleRole(member, roleIds, action, guildId, reason = 'Automated Role Assignment') {
if (!member || !roleIds || roleIds.length === 0) {
return;
}
for (const roleId of roleIds) {
if (!roleId) continue;


try {
  if (action === "add" && !member.roles.cache.has(roleId)) {
    await member.roles.add(roleId, reason);
    logger.info(`[Role Manager] Added role ${roleId} to member ${member.id} in guild ${guildId}.`);
  } else if (action === "remove" && member.roles.cache.has(roleId)) {
    await member.roles.remove(roleId, reason);
    logger.info(`[Role Manager] Removed role ${roleId} from member ${member.id} in guild ${guildId}.`);
  }
} catch (e) {
  if (e.code === 10011 || e.message.includes("Unknown Role")) {
    logger.warn(`[Role Manager] Role ${roleId} for guild ${guildId} is unknown/invalid. Initiating cleanup.`);
    await cleanupInvalidRole(guildId, roleId);
  } else if (e.code === 50013) {
    logger.error(`[Role Manager] Missing permissions to ${action} role ${roleId} for member ${member.user.tag} in guild ${guildId}. Check role hierarchy.`);
  } else {
    logger.error(`[Role Manager] Failed to ${action} role ${roleId} for ${member.user.tag} in ${guildId}:`, {error: e});
  }
}
}
}
module.exports = {handleRole, cleanupInvalidRole};