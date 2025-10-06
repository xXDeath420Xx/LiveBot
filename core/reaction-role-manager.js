const db = require('../utils/db');
const logger = require('../utils/logger');

async function handleReactionAdd(reaction, user) {
    if (reaction.message.partial) await reaction.message.fetch();
    const message = reaction.message;

    const [[panel]] = await db.execute('SELECT * FROM reaction_role_panels WHERE message_id = ?', [message.id]);
    if (!panel) return;

    const emojiIdentifier = reaction.emoji.id || reaction.emoji.name;
    const [[mapping]] = await db.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?', [panel.id, emojiIdentifier]);
    if (!mapping) return;

    const member = await message.guild.members.fetch(user.id);
    const role = await message.guild.roles.fetch(mapping.role_id).catch(() => null);
    if (!role || !role.editable) return;

    try {
        if (panel.panel_mode === 'unique') {
            const [allMappings] = await db.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);
            const rolesToRemove = allMappings.map(m => m.role_id).filter(id => id !== role.id);
            await member.roles.remove(rolesToRemove, 'Reaction Role: Unique mode');
        }
        await member.roles.add(role, 'Reaction Role: Role added');
    } catch (error) {
        logger.error(`[ReactionRoles] Failed to add role ${role.name} to ${user.tag}:`, error);
    }
}

async function handleReactionRemove(reaction, user) {
    if (reaction.message.partial) await reaction.message.fetch();
    const message = reaction.message;

    const [[panel]] = await db.execute('SELECT * FROM reaction_role_panels WHERE message_id = ?', [message.id]);
    if (!panel || panel.panel_mode === 'unique') return; // Don't remove roles in unique mode

    const emojiIdentifier = reaction.emoji.id || reaction.emoji.name;
    const [[mapping]] = await db.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?', [panel.id, emojiIdentifier]);
    if (!mapping) return;

    const member = await message.guild.members.fetch(user.id);
    const role = await message.guild.roles.fetch(mapping.role_id).catch(() => null);
    if (!role || !role.editable) return;

    try {
        await member.roles.remove(role, 'Reaction Role: Role removed');
    } catch (error) {
        logger.error(`[ReactionRoles] Failed to remove role ${role.name} from ${user.tag}:`, error);
    }
}

module.exports = { handleReactionAdd, handleReactionRemove };