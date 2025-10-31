import { GuildMember } from 'discord.js';
import db from '../utils/db';
import logger from '../utils/logger';
import { RowDataPacket } from 'mysql2/promise';

interface JoinGateConfig extends RowDataPacket {
    guild_id: string;
    verification_enabled: boolean;
}

interface AutorolesConfig extends RowDataPacket {
    guild_id: string;
    is_enabled: boolean;
    roles_to_assign: string;
}

export async function handleNewMember(member: GuildMember): Promise<void> {
    const guildId = member.guild.id;
    try {
        // Check if verification gate is active
        const [rows] = await db.execute<JoinGateConfig[]>('SELECT verification_enabled FROM join_gate_config WHERE guild_id = ?', [guildId]);
        const joinGate = rows[0];
        if (joinGate && joinGate.verification_enabled) {
            // If verification is on, do not assign autoroles on join.
            // This logic will be moved to the verification button handler.
            return;
        }

        await assignRoles(member, 'new');
    } catch (error: unknown) {
        logger.error(`Error in autorole for new member ${member.user.tag}.`, { guildId, category: 'autorole', error: error instanceof Error ? error.stack : error });
    }
}

export async function assignRolesAfterVerification(member: GuildMember): Promise<void> {
    const guildId = member.guild.id;
    try {
        await assignRoles(member, 'verified');
    } catch (error: unknown) {
        logger.error(`Error in autorole for verified member ${member.user.tag}.`, { guildId, category: 'autorole', error: error instanceof Error ? error.stack : error });
    }
}

async function assignRoles(member: GuildMember, context: 'new' | 'verified'): Promise<void> {
    const guildId = member.guild.id;
    const [rows] = await db.execute<AutorolesConfig[]>('SELECT is_enabled, roles_to_assign FROM autoroles_config WHERE guild_id = ?', [guildId]);
    const config = rows[0];

    if (config && config.is_enabled && config.roles_to_assign) {
        const roleIds: string[] = JSON.parse(config.roles_to_assign);
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
