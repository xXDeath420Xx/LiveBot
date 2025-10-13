const { Events } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');

async function processRole(member, roleIds, action, guildId) {
    if (!member || !member.guild) {
        logger.warn(`Invalid or partial member object passed to processRole for guild ${guildId}. Aborting role action.`, { guildId, category: 'role-manager' });
        return;
    }
    if (!roleIds || roleIds.length === 0) return;

    try {
        const rolesToProcess = [];
        for (const roleId of roleIds) {
            const role = await member.guild.roles.fetch(roleId).catch(() => null);

            if (!role) {
                logger.warn(`Role ${roleId} not found in guild ${guildId}. It may have been deleted. Triggering cleanup.`, { guildId, category: 'role-manager' });
                cleanupInvalidRole(guildId, roleId);
                continue;
            }

            // --- ENHANCED BOT ROLE FETCHING AND DEBUG LOGGING ---
            const clientMember = await member.guild.members.fetch(member.guild.client.user.id).catch(() => null); // Explicitly fetch bot's member
            if (!clientMember) {
                logger.warn(`Could not find bot's member object in guild ${guildId}. Cannot process roles.`, { guildId, category: 'role-manager' });
                continue;
            }
            const clientRole = clientMember.roles.highest;

            logger.info(`[RoleManager Debug] Checking role: ${role.name} (${role.id}) in guild ${guildId}`, {
                guildId,
                category: 'role-manager',
                targetRole: {
                    name: role.name,
                    id: role.id,
                    managed: role.managed,
                    position: role.position
                },
                botRole: {
                    name: clientRole.name,
                    id: clientRole.id,
                    position: clientRole.position
                },
                compareResult: clientRole.comparePositionTo(role),
                botHighestRoleName: clientRole.name, // Added for clarity
                botHighestRolePosition: clientRole.position // Added for clarity
            });
            // --- END ENHANCED DEBUG LOGGING ---

            const isEditable = !role.managed && clientRole.comparePositionTo(role) > 0;

            if (isEditable) {
                rolesToProcess.push(role);
            } else {
                logger.warn(`Role ${role.name} (${role.id}) is not editable in guild ${guildId}. It's either managed or higher than the bot's highest role.`, { guildId, category: 'role-manager' });
            }
        }

        if (rolesToProcess.length === 0) {
            return;
        }

        const roleNames = rolesToProcess.map(r => r.name).join(', ');

        if (action === 'add') {
            const rolesToAdd = rolesToProcess.filter(role => !member.roles.cache.has(role.id));
            if (rolesToAdd.length > 0) {
                await member.roles.add(rolesToAdd, 'LiveBot Role Management: User went live');
                logger.info(`Successfully added roles [${roleNames}] to ${member.user.tag}.`, { guildId, category: 'role-manager' });
            }
        } else if (action === 'remove') {
            const rolesToRemove = rolesToProcess.filter(role => member.roles.cache.has(role.id));
            if (rolesToRemove.length > 0) {
                await member.roles.remove(rolesToRemove, 'LiveBot Role Management: User is no longer live');
                logger.info(`Successfully removed roles [${roleNames}] from ${member.user.tag}.`, { guildId, category: 'role-manager' });
            }
        }

    } catch (error) {
        if (error.code === 10007) { // Unknown Member
            logger.warn(`Failed to process roles for user ${member.id} as they are no longer in the guild.`, { guildId, category: 'role-manager' });
        } else if (error.code === 50013) { // Missing Permissions
            logger.error(`Missing Permissions to process roles for ${member.user.tag} in guild ${guildId}.`, { guildId, category: 'role-manager', error: 'Check bot role hierarchy and permissions.' });
        } else {
            logger.error(`An unexpected error occurred while processing roles for ${member.user.tag}.`, { guildId, category: 'role-manager', error: error.stack });
        }
    }
}

async function cleanupInvalidRole(guildId, roleId) {
    if (!guildId || !roleId) return;
    logger.warn(`[RoleCleanup] Purging invalid role ${roleId} from all configurations for guild ${guildId}.`, { guildId, category: 'role-manager' });
    try {
        await db.execute(`UPDATE guilds SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?`, [guildId, roleId]);
        await db.execute(`UPDATE twitch_teams SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?`, [guildId, roleId]);
        await db.execute(`UPDATE subscriptions SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?`, [guildId, roleId]);
        logger.info(`[RoleCleanup] Successfully purged invalid role ${roleId} for guild ${guildId}.`, { guildId, category: 'role-manager' });
    } catch (error) {
        logger.error(`[RoleCleanup] Failed to purge invalid role ${roleId} for guild ${guildId}:`, { guildId, category: 'role-manager', error: error.stack });
    }
}

async function handleReactionAdd(reaction, user) {
    if (reaction.message.partial) await reaction.message.fetch();
    if (user.bot) return;
    const message = reaction.message;
    const guildId = message.guild.id;

    try {
        const [[panel]] = await db.execute('SELECT * FROM reaction_role_panels WHERE message_id = ?', [message.id]);
        if (!panel) return;

        const emojiIdentifier = reaction.emoji.id || reaction.emoji.name;
        const [[mapping]] = await db.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?', [panel.id, emojiIdentifier]);
        if (!mapping) return;

        const member = await message.guild.members.fetch(user.id);
        const role = await message.guild.roles.fetch(mapping.role_id).catch(() => null);
        if (!role || !role.permissions || !role.editable) {
            logger.warn(`Role not found, not editable, or has null permissions for mapping in panel ${panel.id}`, { guildId, category: 'reaction-roles' });
            return;
        }

        if (panel.panel_mode === 'unique') {
            const [allMappings] = await db.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);
            const rolesOnPanel = allMappings.map(m => m.role_id);
            const rolesToRemove = member.roles.cache.filter(r => rolesOnPanel.includes(r.id) && r.id !== role.id);
            if (rolesToRemove.size > 0) {
                await member.roles.remove(rolesToRemove, 'Reaction Role: Unique mode');
            }
        }
        if (!member.roles.cache.has(role.id)) {
            await member.roles.add(role, 'Reaction Role: Role added');
            logger.info(`Added role ${role.name} to ${user.tag}`, { guildId, category: 'reaction-roles' });
        }

    } catch (error) {
        logger.error(`Failed to process reaction add for user ${user.tag}`, { guildId, category: 'reaction-roles', error: error.stack });
    }
}

async function handleReactionRemove(reaction, user) {
    if (reaction.message.partial) await reaction.message.fetch();
    if (user.bot) return;
    const message = reaction.message;
    const guildId = message.guild.id;

    try {
        const [[panel]] = await db.execute('SELECT * FROM reaction_role_panels WHERE message_id = ?', [message.id]);
        if (!panel || panel.panel_mode === 'unique') return;

        const emojiIdentifier = reaction.emoji.id || reaction.emoji.name;
        const [[mapping]] = await db.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?', [panel.id, emojiIdentifier]);
        if (!mapping) return;

        const member = await message.guild.members.fetch(user.id);
        const role = await message.guild.roles.fetch(mapping.role_id).catch(() => null);
        if (!role || !role.permissions || !role.editable) {
            return;
        }

        if (member.roles.cache.has(role.id)) {
            await member.roles.remove(role, 'Reaction Role: Role removed');
            logger.info(`Removed role ${role.name} from ${user.tag}`, { guildId, category: 'reaction-roles' });
        }

    } catch (error) {
        if (error.code === 10007) return;
        logger.error(`Failed to process reaction remove for user ${user.tag}`, { guildId, category: 'reaction-roles', error: error.stack });
    }
}

module.exports = {
    processRole,
    handleReactionAdd,
    handleReactionRemove,
    cleanupInvalidRole,
};