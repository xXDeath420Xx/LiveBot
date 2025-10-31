import { MessageReaction, User, PartialMessageReaction, PartialUser, GuildMember } from 'discord.js';
import { RowDataPacket } from 'mysql2';
import db from '../utils/db';
import logger from '../utils/logger';

interface ReactionRolePanel extends RowDataPacket {
    id: number;
    message_id: string;
    panel_mode: string;
}

interface ReactionRoleMapping extends RowDataPacket {
    role_id: string;
}

async function handleReactionAdd(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
    if (reaction.message.partial) await reaction.message.fetch();
    const message = reaction.message;
    const guildId = message.guild?.id;

    if (!guildId || !message.guild) return;

    try {
        const [[panel]] = await db.execute<ReactionRolePanel[]>(
            'SELECT * FROM reaction_role_panels WHERE message_id = ?',
            [message.id]
        );
        if (!panel) return;

        const emojiIdentifier = reaction.emoji.id || reaction.emoji.name;
        const [[mapping]] = await db.execute<ReactionRoleMapping[]>(
            'SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?',
            [panel.id, emojiIdentifier]
        );
        if (!mapping) return;

        const member = await message.guild.members.fetch(user.id);
        const role = await message.guild.roles.fetch(mapping.role_id).catch(() => null);
        if (!role || !role.editable) {
            logger.warn(`Role not found or not editable for mapping in panel ${panel.id}`, { guildId, category: 'reaction-roles' });
            return;
        }

        if (panel.panel_mode === 'unique') {
            const [allMappings] = await db.execute<ReactionRoleMapping[]>(
                'SELECT role_id FROM reaction_role_mappings WHERE panel_id = ?',
                [panel.id]
            );
            const rolesToRemove = allMappings.map(m => m.role_id).filter(id => id !== role.id);
            await member.roles.remove(rolesToRemove, 'Reaction Role: Unique mode');
        }
        await member.roles.add(role, 'Reaction Role: Role added');
        logger.info(`Added role ${role.name} to ${user.tag}`, { guildId, category: 'reaction-roles' });

    } catch (error) {
        const errorMessage = _error instanceof Error ? _error.stack : String(_error);
        logger.error(`Failed to process reaction add for user ${user.tag}`, { guildId, category: 'reaction-roles', error: errorMessage });
    }
}

async function handleReactionRemove(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
    if (reaction.message.partial) await reaction.message.fetch();
    const message = reaction.message;
    const guildId = message.guild?.id;

    if (!guildId || !message.guild) return;

    try {
        const [[panel]] = await db.execute<ReactionRolePanel[]>(
            'SELECT * FROM reaction_role_panels WHERE message_id = ?',
            [message.id]
        );
        if (!panel || panel.panel_mode === 'unique') return; // Don't remove roles in unique mode

        const emojiIdentifier = reaction.emoji.id || reaction.emoji.name;
        const [[mapping]] = await db.execute<ReactionRoleMapping[]>(
            'SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?',
            [panel.id, emojiIdentifier]
        );
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
        const errorMessage = _error instanceof Error ? _error.stack : String(_error);
        logger.error(`Failed to process reaction remove for user ${user.tag}`, { guildId, category: 'reaction-roles', error: errorMessage });
    }
}

export { handleReactionAdd, handleReactionRemove };
