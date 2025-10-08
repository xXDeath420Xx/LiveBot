const db = require('../utils/db');
const logger = require('../utils/logger');

async function handleNewMember(member) {
    const guildId = member.guild.id;
    try {
        // Check if verification gate is active
        const [[joinGate]] = await db.execute('SELECT verification_enabled FROM join_gate_config WHERE guild_id = ?', [guildId]);
        if (joinGate && joinGate.verification_enabled) {
            // If verification is on, do not assign autoroles on join.
            // This logic will be moved to the verification button handler.
            return; 
        }

        await assignRoles(member, 'new');
    } catch (error) {
        logger.error(`Error in autorole for new member ${member.user.tag}.`, { guildId, category: 'autorole', error: error.stack });
    }
}

async function assignRolesAfterVerification(member) {
    const guildId = member.guild.id;
    try {
        await assignRoles(member, 'verified');
    } catch (error) {
        logger.error(`Error in autorole for verified member ${member.user.tag}.`, { guildId, category: 'autorole', error: error.stack });
    }
}

async function assignRoles(member, context) {
    const guildId = member.guild.id;
    const [[config]] = await db.execute('SELECT is_enabled, roles_to_assign FROM autoroles_config WHERE guild_id = ?', [guildId]);

    if (config && config.is_enabled && config.roles_to_assign) {
        const roleIds = JSON.parse(config.roles_to_assign);
        if (!Array.isArray(roleIds) || roleIds.length === 0) {
            return;
        }

        for (const roleId of roleIds) {
            const role = await member.guild.roles.fetch(roleId).catch(() => null);
            if (role && role.editable) {
                await member.roles.add(role);
                logger.info(`Assigned role ${role.name} to ${context} member ${member.user.tag}.`, { guildId, category: 'autorole' });
            } else {
                logger.warn(`Could not assign role ${roleId} to ${context} member. Role not found or I lack permissions.`, { guildId, category: 'autorole' });
            }
        }
    }
}

module.exports = { handleNewMember, assignRolesAfterVerification };