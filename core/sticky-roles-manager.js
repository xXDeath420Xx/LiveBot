"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveUserRoles = saveUserRoles;
exports.restoreUserRoles = restoreUserRoles;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
async function saveUserRoles(member) {
    const guildId = member.guild.id;
    try {
        const [[config]] = await db_1.default.execute('SELECT sticky_roles_enabled FROM guilds WHERE guild_id = ?', [guildId]);
        if (!config || !config.sticky_roles_enabled)
            return;
        const rolesToSave = member.roles.cache
            .filter(role => !role.managed && role.id !== guildId)
            .map(role => role.id);
        if (rolesToSave.length > 0) {
            await db_1.default.execute('INSERT INTO sticky_roles (guild_id, user_id, roles) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE roles = VALUES(roles)', [guildId, member.id, JSON.stringify(rolesToSave)]);
            logger_1.default.info(`Saved ${rolesToSave.length} roles for user ${member.user.tag}.`, { guildId, category: 'sticky-roles' });
        }
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.stack : String(error);
        logger_1.default.error(`Error saving roles for ${member.user.tag}.`, { guildId, category: 'sticky-roles', error: errorMessage });
    }
}
async function restoreUserRoles(member) {
    const guildId = member.guild.id;
    try {
        const [[config]] = await db_1.default.execute('SELECT sticky_roles_enabled FROM guilds WHERE guild_id = ?', [guildId]);
        if (!config || !config.sticky_roles_enabled)
            return;
        const [[sticky]] = await db_1.default.execute('SELECT roles FROM sticky_roles WHERE guild_id = ? AND user_id = ?', [guildId, member.id]);
        if (!sticky || !sticky.roles)
            return;
        const roleIdsToRestore = JSON.parse(sticky.roles);
        if (roleIdsToRestore.length === 0)
            return;
        const rolesToAdd = [];
        for (const roleId of roleIdsToRestore) {
            const role = await member.guild.roles.fetch(roleId).catch(() => null);
            if (role && role.editable) {
                rolesToAdd.push(role);
            }
        }
        if (rolesToAdd.length > 0) {
            await member.roles.add(rolesToAdd, 'Sticky Roles: Restoring roles on rejoin.');
            logger_1.default.info(`Restored ${rolesToAdd.length} roles for user ${member.user.tag}.`, { guildId, category: 'sticky-roles' });
        }
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.stack : String(error);
        logger_1.default.error(`Error restoring roles for ${member.user.tag}.`, { guildId, category: 'sticky-roles', error: errorMessage });
    }
}
