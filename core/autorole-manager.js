const db = require('../utils/db');
const logger = require('../utils/logger');

async function handleNewMember(member) {
    try {
        // Check if verification gate is active
        const [[joinGate]] = await db.execute('SELECT verification_enabled FROM join_gate_config WHERE guild_id = ?', [member.guild.id]);
        if (joinGate && joinGate.verification_enabled) {
            // If verification is on, do not assign autoroles on join.
            // This logic will be moved to the verification button handler.
            return; 
        }

        const [[config]] = await db.execute('SELECT is_enabled, roles_to_assign FROM autoroles_config WHERE guild_id = ?', [member.guild.id]);

        if (config && config.is_enabled && config.roles_to_assign) {
            const roleIds = JSON.parse(config.roles_to_assign);
            if (!Array.isArray(roleIds) || roleIds.length === 0) {
                return;
            }

            for (const roleId of roleIds) {
                const role = await member.guild.roles.fetch(roleId).catch(() => null);
                if (role && role.editable) {
                    await member.roles.add(role);
                    logger.info(`[Autorole] Assigned role ${role.name} to new member ${member.user.tag} in guild ${member.guild.id}.`);
                } else {
                    logger.warn(`[Autorole] Could not assign role ${roleId} in guild ${member.guild.id}. Role not found or I lack permissions.`);
                }
            }
        }
    } catch (error) {
        logger.error(`[Autorole] Error assigning roles to ${member.user.tag}:`, error);
    }
}

// New function to be called after a user is verified
async function assignRolesAfterVerification(member) {
     try {
        const [[config]] = await db.execute('SELECT is_enabled, roles_to_assign FROM autoroles_config WHERE guild_id = ?', [member.guild.id]);
        if (config && config.is_enabled && config.roles_to_assign) {
            const roleIds = JSON.parse(config.roles_to_assign);
            if (!Array.isArray(roleIds) || roleIds.length === 0) {
                return;
            }

            for (const roleId of roleIds) {
                const role = await member.guild.roles.fetch(roleId).catch(() => null);
                if (role && role.editable) {
                    await member.roles.add(role);
                    logger.info(`[Autorole] Assigned role ${role.name} to verified member ${member.user.tag} in guild ${member.guild.id}.`);
                } else {
                    logger.warn(`[Autorole] Could not assign role ${roleId} to verified member in guild ${member.guild.id}. Role not found or I lack permissions.`);
                }
            }
        }
     } catch (error) {
         logger.error(`[Autorole] Error assigning roles after verification to ${member.user.tag}:`, error);
     }
}

module.exports = { handleNewMember, assignRolesAfterVerification };