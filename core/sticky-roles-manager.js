
const db = require('../utils/db');
const logger = require('../utils/logger');

async function saveUserRoles(member) {
    try {
        const [[config]] = await db.execute('SELECT sticky_roles_enabled FROM guilds WHERE guild_id = ?', [member.guild.id]);
        if (!config || !config.sticky_roles_enabled) return;

        // Get all roles except @everyone and managed roles (like bot roles)
        const rolesToSave = member.roles.cache
            .filter(role => !role.managed && role.id !== member.guild.id)
            .map(role => role.id);

        if (rolesToSave.length > 0) {
            await db.execute(
                'INSERT INTO sticky_roles (guild_id, user_id, roles) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE roles = VALUES(roles)',
                [member.guild.id, member.id, JSON.stringify(rolesToSave)]
            );
            logger.info(`[StickyRoles] Saved ${rolesToSave.length} roles for user ${member.user.tag} in guild ${member.guild.id}.`);
        }
    } catch (error) {
        logger.error(`[StickyRoles] Error saving roles for ${member.user.tag}:`, error);
    }
}

async function restoreUserRoles(member) {
    try {
        const [[config]] = await db.execute('SELECT sticky_roles_enabled FROM guilds WHERE guild_id = ?', [member.guild.id]);
        if (!config || !config.sticky_roles_enabled) return;

        const [[sticky]] = await db.execute('SELECT roles FROM sticky_roles WHERE guild_id = ? AND user_id = ?', [member.guild.id, member.id]);
        if (!sticky || !sticky.roles) return;

        const roleIdsToRestore = JSON.parse(sticky.roles);
        if (roleIdsToRestore.length === 0) return;

        const rolesToAdd = [];
        for (const roleId of roleIdsToRestore) {
            const role = await member.guild.roles.fetch(roleId).catch(() => null);
            // Check if the role still exists and is assignable
            if (role && role.editable) {
                rolesToAdd.push(role);
            }
        }
        
        if (rolesToAdd.length > 0) {
            await member.roles.add(rolesToAdd, 'Sticky Roles: Restoring roles on rejoin.');
            logger.info(`[StickyRoles] Restored ${rolesToAdd.length} roles for user ${member.user.tag} in guild ${member.guild.id}.`);
        }

    } catch (error) {
        logger.error(`[StickyRoles] Error restoring roles for ${member.user.tag}:`, error);
    }
}


module.exports = { saveUserRoles, restoreUserRoles };
