"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleReactionAdd = handleReactionAdd;
exports.handleReactionRemove = handleReactionRemove;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
async function handleReactionAdd(reaction, user) {
    if (reaction.message.partial)
        await reaction.message.fetch();
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
        if (!role || !role.editable) {
            logger_1.default.warn(`Role not found or not editable for mapping in panel ${panel.id}`, { guildId, category: 'reaction-roles' });
            return;
        }
        if (panel.panel_mode === 'unique') {
            const [allMappings] = await db_1.default.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);
            const rolesToRemove = allMappings.map(m => m.role_id).filter(id => id !== role.id);
            await member.roles.remove(rolesToRemove, 'Reaction Role: Unique mode');
        }
        await member.roles.add(role, 'Reaction Role: Role added');
        logger_1.default.info(`Added role ${role.name} to ${user.tag}`, { guildId, category: 'reaction-roles' });
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.stack : String(error);
        logger_1.default.error(`Failed to process reaction add for user ${user.tag}`, { guildId, category: 'reaction-roles', error: errorMessage });
    }
}
async function handleReactionRemove(reaction, user) {
    if (reaction.message.partial)
        await reaction.message.fetch();
    const message = reaction.message;
    const guildId = message.guild?.id;
    if (!guildId || !message.guild)
        return;
    try {
        const [[panel]] = await db_1.default.execute('SELECT * FROM reaction_role_panels WHERE message_id = ?', [message.id]);
        if (!panel || panel.panel_mode === 'unique')
            return; // Don't remove roles in unique mode
        const emojiIdentifier = reaction.emoji.id || reaction.emoji.name;
        const [[mapping]] = await db_1.default.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?', [panel.id, emojiIdentifier]);
        if (!mapping)
            return;
        const member = await message.guild.members.fetch(user.id);
        const role = await message.guild.roles.fetch(mapping.role_id).catch(() => null);
        if (!role || !role.editable) {
            logger_1.default.warn(`Role not found or not editable for mapping in panel ${panel.id}`, { guildId, category: 'reaction-roles' });
            return;
        }
        await member.roles.remove(role, 'Reaction Role: Role removed');
        logger_1.default.info(`Removed role ${role.name} from ${user.tag}`, { guildId, category: 'reaction-roles' });
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.stack : String(error);
        logger_1.default.error(`Failed to process reaction remove for user ${user.tag}`, { guildId, category: 'reaction-roles', error: errorMessage });
    }
}
