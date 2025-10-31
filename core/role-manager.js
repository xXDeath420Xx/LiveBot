"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processRole = processRole;
exports.handleReactionAdd = handleReactionAdd;
exports.handleReactionRemove = handleReactionRemove;
exports.cleanupInvalidRole = cleanupInvalidRole;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
async function processRole(member, roleIds, action, guildId) {
    if (!member || !member.guild) {
        logger_1.default.warn(`Invalid or partial member object passed to processRole for guild ${guildId}. Aborting role action.`, { guildId, category: 'role-manager' });
        return;
    }
    if (!roleIds || roleIds.length === 0)
        return;
    try {
        const rolesToProcess = [];
        for (const roleId of roleIds) {
            const role = await member.guild.roles.fetch(roleId).catch(() => null);
            if (!role) {
                logger_1.default.warn(`Role ${roleId} not found in guild ${guildId}. It may have been deleted. Triggering cleanup.`, { guildId, category: 'role-manager' });
                cleanupInvalidRole(guildId, roleId);
                continue;
            }
            // --- ENHANCED BOT ROLE FETCHING AND DEBUG LOGGING ---
            const clientMember = await member.guild.members.fetch(member.guild.client.user.id).catch(() => null); // Explicitly fetch bot's member
            if (!clientMember) {
                logger_1.default.warn(`Could not find bot's member object in guild ${guildId}. Cannot process roles.`, { guildId, category: 'role-manager' });
                continue;
            }
            const clientRole = clientMember.roles.highest;
            logger_1.default.info(`[RoleManager Debug] Checking role: ${role.name} (${role.id}) in guild ${guildId}`, {
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
            }
            else {
                logger_1.default.warn(`Role ${role.name} (${role.id}) is not editable in guild ${guildId}. It's either managed or higher than the bot's highest role.`, { guildId, category: 'role-manager' });
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
                logger_1.default.info(`Successfully added roles [${roleNames}] to ${member.user.tag}.`, { guildId, category: 'role-manager' });
            }
        }
        else if (action === 'remove') {
            const rolesToRemove = rolesToProcess.filter(role => member.roles.cache.has(role.id));
            if (rolesToRemove.length > 0) {
                await member.roles.remove(rolesToRemove, 'LiveBot Role Management: User is no longer live');
                logger_1.default.info(`Successfully removed roles [${roleNames}] from ${member.user.tag}.`, { guildId, category: 'role-manager' });
            }
        }
    }
    catch (error) {
        if (error.code === 10007) { // Unknown Member
            logger_1.default.warn(`Failed to process roles for user ${member.id} as they are no longer in the guild.`, { guildId, category: 'role-manager' });
        }
        else if (error.code === 50013) { // Missing Permissions
            logger_1.default.error(`Missing Permissions to process roles for ${member.user.tag} in guild ${guildId}.`, { guildId, category: 'role-manager', error: 'Check bot role hierarchy and permissions.' });
        }
        else {
            const errorMessage = error instanceof Error ? error.stack : String(error);
            logger_1.default.error(`An unexpected error occurred while processing roles for ${member.user.tag}.`, { guildId, category: 'role-manager', error: errorMessage });
        }
    }
}
async function cleanupInvalidRole(guildId, roleId) {
    if (!guildId || !roleId)
        return;
    logger_1.default.warn(`[RoleCleanup] Purging invalid role ${roleId} from all configurations for guild ${guildId}.`, { guildId, category: 'role-manager' });
    try {
        await db_1.default.execute(`UPDATE guilds SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?`, [guildId, roleId]);
        await db_1.default.execute(`UPDATE twitch_teams SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?`, [guildId, roleId]);
        await db_1.default.execute(`UPDATE subscriptions SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?`, [guildId, roleId]);
        logger_1.default.info(`[RoleCleanup] Successfully purged invalid role ${roleId} for guild ${guildId}.`, { guildId, category: 'role-manager' });
    }
    catch (error) {
        const errorMessage = _error instanceof Error ? _error.stack : String(_error);
        logger_1.default.error(`[RoleCleanup] Failed to purge invalid role ${roleId} for guild ${guildId}:`, { guildId, category: 'role-manager', error: errorMessage });
    }
}
async function handleReactionAdd(reaction, user) {
    if (reaction.message.partial)
        await reaction.message.fetch();
    if (user.bot)
        return;
    const message = reaction.message;
    const guildId = message.guild?.id;
    if (!guildId || !message.guild)
        return;
    try {
        const [[panel]] = await db_1.default.execute('SELECT * FROM reaction_role_panels WHERE message_id = ?', [message.id]);
        if (!panel)
            return;
        const emojiIdentifier = reaction.emoji.id || reaction.emoji.name;
        const [[mapping]] = await db_1.default.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?', [panel.id, emojiIdentifier]);
        if (!mapping)
            return;
        const member = await message.guild.members.fetch(user.id);
        const role = await message.guild.roles.fetch(mapping.role_id).catch(() => null);
        if (!role || !role.permissions || !role.editable) {
            logger_1.default.warn(`Role not found, not editable, or has null permissions for mapping in panel ${panel.id}`, { guildId, category: 'reaction-roles' });
            return;
        }
        if (panel.panel_mode === 'unique') {
            const [allMappings] = await db_1.default.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);
            const rolesOnPanel = allMappings.map(m => m.role_id);
            const rolesToRemove = member.roles.cache.filter(r => rolesOnPanel.includes(r.id) && r.id !== role.id);
            if (rolesToRemove.size > 0) {
                await member.roles.remove(rolesToRemove, 'Reaction Role: Unique mode');
            }
        }
        if (!member.roles.cache.has(role.id)) {
            await member.roles.add(role, 'Reaction Role: Role added');
            logger_1.default.info(`Added role ${role.name} to ${user.tag}`, { guildId, category: 'reaction-roles' });
        }
    }
    catch (error) {
        const errorMessage = _error instanceof Error ? _error.stack : String(_error);
        logger_1.default.error(`Failed to process reaction add for user ${user.tag}`, { guildId, category: 'reaction-roles', error: errorMessage });
    }
}
async function handleReactionRemove(reaction, user) {
    if (reaction.message.partial)
        await reaction.message.fetch();
    if (user.bot)
        return;
    const message = reaction.message;
    const guildId = message.guild?.id;
    if (!guildId || !message.guild)
        return;
    try {
        const [[panel]] = await db_1.default.execute('SELECT * FROM reaction_role_panels WHERE message_id = ?', [message.id]);
        if (!panel || panel.panel_mode === 'unique')
            return;
        const emojiIdentifier = reaction.emoji.id || reaction.emoji.name;
        const [[mapping]] = await db_1.default.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?', [panel.id, emojiIdentifier]);
        if (!mapping)
            return;
        const member = await message.guild.members.fetch(user.id);
        const role = await message.guild.roles.fetch(mapping.role_id).catch(() => null);
        if (!role || !role.permissions || !role.editable) {
            return;
        }
        if (member.roles.cache.has(role.id)) {
            await member.roles.remove(role, 'Reaction Role: Role removed');
            logger_1.default.info(`Removed role ${role.name} from ${user.tag}`, { guildId, category: 'reaction-roles' });
        }
    }
    catch (error) {
        if (error.code === 10007)
            return;
        const errorMessage = error instanceof Error ? error.stack : String(error);
        logger_1.default.error(`Failed to process reaction remove for user ${user.tag}`, { guildId, category: 'reaction-roles', error: errorMessage });
    }
}
