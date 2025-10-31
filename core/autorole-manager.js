"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleNewMember = handleNewMember;
exports.assignRolesAfterVerification = assignRolesAfterVerification;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
async function handleNewMember(member) {
    const guildId = member.guild.id;
    try {
        // Check if verification gate is active
        const [rows] = await db_1.default.execute('SELECT verification_enabled FROM join_gate_config WHERE guild_id = ?', [guildId]);
        const joinGate = rows[0];
        if (joinGate && joinGate.verification_enabled) {
            // If verification is on, do not assign autoroles on join.
            // This logic will be moved to the verification button handler.
            return;
        }
        await assignRoles(member, 'new');
    }
    catch (error) {
        logger_1.default.error(`Error in autorole for new member ${member.user.tag}.`, { guildId, category: 'autorole', error: error instanceof Error ? error.stack : error });
    }
}
async function assignRolesAfterVerification(member) {
    const guildId = member.guild.id;
    try {
        await assignRoles(member, 'verified');
    }
    catch (error) {
        logger_1.default.error(`Error in autorole for verified member ${member.user.tag}.`, { guildId, category: 'autorole', error: error instanceof Error ? error.stack : error });
    }
}
async function assignRoles(member, context) {
    const guildId = member.guild.id;
    const [rows] = await db_1.default.execute('SELECT is_enabled, roles_to_assign FROM autoroles_config WHERE guild_id = ?', [guildId]);
    const config = rows[0];
    if (config && config.is_enabled && config.roles_to_assign) {
        const roleIds = JSON.parse(config.roles_to_assign);
        if (!Array.isArray(roleIds) || roleIds.length === 0) {
            return;
        }
        for (const roleId of roleIds) {
            const role = await member.guild.roles.fetch(roleId).catch(() => null);
            if (role && role.editable) {
                await member.roles.add(role);
                logger_1.default.info(`Assigned role ${role.name} to ${context} member ${member.user.tag}.`, { guildId, category: 'autorole' });
            }
            else {
                logger_1.default.warn(`Could not assign role ${roleId} to ${context} member. Role not found or I lack permissions.`, { guildId, category: 'autorole' });
            }
        }
    }
}
