const { Events } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');

async function processRole(member, roleIds, action, guildId) {
    if (!member || !roleIds || roleIds.length === 0) return;

    try {
        const rolesToProcess = [];
        for (const roleId of roleIds) {
            const role = await member.guild.roles.fetch(roleId).catch(() => null);
            if (role && role.editable) {
                rolesToProcess.push(role);
            } else {
                logger.warn(`Role ${roleId} not found or not editable in guild ${guildId}.`, { guildId, category: 'role-manager' });
            }
        }

        if (rolesToProcess.length === 0) return;

        if (action === 'add') {
            await member.roles.add(rolesToProcess, 'Bot role management');
            logger.info(`Added roles ${rolesToProcess.map(r => r.name).join(', ')} to ${member.user.tag}.`, { guildId, category: 'role-manager' });
        } else if (action === 'remove') {
            await member.roles.remove(rolesToProcess, 'Bot role management');
            logger.info(`Removed roles ${rolesToProcess.map(r => r.name).join(', ')} from ${member.user.tag}.`, { guildId, category: 'role-manager' });
        }
    } catch (error) {
        logger.error(`Error processing roles for ${member.user.tag}.`, { guildId, category: 'role-manager', error: error.stack });
    }
}

// Existing reaction role handlers (unchanged)
async function handleReactionAdd(reaction, user) {
    if (reaction.message.partial) await reaction.message.fetch();
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
        if (!role || !role.editable) {
            logger.warn(`Role not found or not editable for mapping in panel ${panel.id}`, { guildId, category: 'reaction-roles' });
            return;
        }

        if (panel.panel_mode === 'unique') {
            const [allMappings] = await db.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);
            const rolesToRemove = allMappings.map(m => m.role_id).filter(id => id !== role.id);
            await member.roles.remove(rolesToRemove, 'Reaction Role: Unique mode');
        }
        await member.roles.add(role, 'Reaction Role: Role added');
        logger.info(`Added role ${role.name} to ${user.tag}`, { guildId, category: 'reaction-roles' });

    } catch (error) {
        logger.error(`Failed to process reaction add for user ${user.tag}`, { guildId, category: 'reaction-roles', error: error.stack });
    }
}

async function handleReactionRemove(reaction, user) {
    if (reaction.message.partial) await reaction.message.fetch();
    const message = reaction.message;
    const guildId = message.guild.id;

    try {
        const [[panel]] = await db.execute('SELECT * FROM reaction_role_panels WHERE message_id = ?', [message.id]);
        if (!panel || panel.panel_mode === 'unique') return; // Don't remove roles in unique mode

        const emojiIdentifier = reaction.emoji.id || reaction.emoji.name;
        const [[mapping]] = await db.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?', [panel.id, emojiIdentifier]);
        if (!mapping) return;

        const member = await message.guild.members.fetch(user.id);
        const role = await message.guild.roles.fetch(mapping.role_id).catch(() => null);
        if (!role || !role.editable) {
            logger.warn(`Role not found or not editable for mapping in panel ${panel.id}`, { guildId, category: 'reaction-roles' });
            return;
        }

        await member.roles.remove(role, 'Reaction Role: Role removed');
        logger.info(`Removed role ${role.name} from ${user.tag}`, { guildId, category: 'reaction-roles' });

    } catch (error) {
        logger.error(`Failed to process reaction remove for user ${user.tag}`, { guildId, category: 'reaction-roles', error: error.stack });
    }
}

module.exports = {
    processRole,
    handleReactionAdd,
    handleReactionRemove,
};