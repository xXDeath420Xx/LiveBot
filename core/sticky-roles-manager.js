const db = require('../utils/db');
const logger = require('../utils/logger');

async function saveUserRoles(member) {
    const guildId = member.guild.id;
    try {
        const [[config]] = await db.execute('SELECT sticky_roles_enabled FROM guilds WHERE guild_id = ?', [guildId]);
        if (!config || !config.sticky_roles_enabled) return;

        const rolesToSave = member.roles.cache
            .filter(role => !role.managed && role.id !== guildId)
            .map(role => role.id);

        if (rolesToSave.length > 0) {
            await db.execute(
                'INSERT INTO sticky_roles (guild_id, user_id, roles) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE roles = VALUES(roles)',
                [guildId, member.id, JSON.stringify(rolesToSave)]
            );
            logger.info(`Saved ${rolesToSave.length} roles for user ${member.user.tag}.`, { guildId, category: 'sticky-roles' });
        }
    } catch (error) {
        logger.error(`Error saving roles for ${member.user.tag}.`, { guildId, category: 'sticky-roles', error: error.stack });
    }
}

async function restoreUserRoles(member) {
    const guildId = member.guild.id;
    try {
        const [[config]] = await db.execute('SELECT sticky_roles_enabled FROM guilds WHERE guild_id = ?', [guildId]);
        if (!config || !config.sticky_roles_enabled) return;

        const [[sticky]] = await db.execute('SELECT roles FROM sticky_roles WHERE guild_id = ? AND user_id = ?', [guildId, member.id]);
        if (!sticky || !sticky.roles) return;

        const roleIdsToRestore = JSON.parse(sticky.roles);
        if (roleIdsToRestore.length === 0) return;

        const rolesToAdd = [];
        for (const roleId of roleIdsToRestore) {
            const role = await member.guild.roles.fetch(roleId).catch(() => null);
            if (role && role.editable) {
                rolesToAdd.push(role);
            }
        }
        
        if (rolesToAdd.length > 0) {
            await member.roles.add(rolesToAdd, 'Sticky Roles: Restoring roles on rejoin.');
            logger.info(`Restored ${rolesToAdd.length} roles for user ${member.user.tag}.`, { guildId, category: 'sticky-roles' });
        }

    } catch (error) {
        logger.error(`Error restoring roles for ${member.user.tag}.`, { guildId, category: 'sticky-roles', error: error.stack });
    }
}

module.exports = { saveUserRoles, restoreUserRoles };