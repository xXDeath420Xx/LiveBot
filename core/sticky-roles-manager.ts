import { GuildMember, Role } from 'discord.js';
import { RowDataPacket } from 'mysql2';
import db from '../utils/db';
import logger from '../utils/logger';

interface GuildConfig extends RowDataPacket {
    sticky_roles_enabled: boolean;
}

interface StickyRoleData extends RowDataPacket {
    roles: string;
}

async function saveUserRoles(member: GuildMember): Promise<void> {
    const guildId = member.guild.id;
    try {
        const [[config]] = await db.execute<GuildConfig[]>(
            'SELECT sticky_roles_enabled FROM guilds WHERE guild_id = ?',
            [guildId]
        );
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
        const errorMessage = _error instanceof Error ? _error.stack : String(_error);
        logger.error(`Error saving roles for ${member.user.tag}.`, { guildId, category: 'sticky-roles', error: errorMessage });
    }
}

async function restoreUserRoles(member: GuildMember): Promise<void> {
    const guildId = member.guild.id;
    try {
        const [[config]] = await db.execute<GuildConfig[]>(
            'SELECT sticky_roles_enabled FROM guilds WHERE guild_id = ?',
            [guildId]
        );
        if (!config || !config.sticky_roles_enabled) return;

        const [[sticky]] = await db.execute<StickyRoleData[]>(
            'SELECT roles FROM sticky_roles WHERE guild_id = ? AND user_id = ?',
            [guildId, member.id]
        );
        if (!sticky || !sticky.roles) return;

        const roleIdsToRestore: string[] = JSON.parse(sticky.roles);
        if (roleIdsToRestore.length === 0) return;

        const rolesToAdd: Role[] = [];
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
        const errorMessage = _error instanceof Error ? _error.stack : String(_error);
        logger.error(`Error restoring roles for ${member.user.tag}.`, { guildId, category: 'sticky-roles', error: errorMessage });
    }
}

export { saveUserRoles, restoreUserRoles };
