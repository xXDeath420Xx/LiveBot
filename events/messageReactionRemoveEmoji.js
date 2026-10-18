import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

// Channel-embed audit log removed 2026-10-18 — reaction events were spamming log
// channels. Internal DB row is kept so dashboard forensics still see mod-wipes.
export default {
    name: Events.MessageReactionRemoveEmoji,
    async execute(reaction) {
        try {
            if (!reaction.message.guild) return;

            if (reaction.client.isDefaultBot && await shouldIgnoreGuild(reaction.message.guild.id)) return;

            const emoji = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;

            logger.info(`[Reactions] Emoji ${emoji} removed from message ${reaction.message.id}`, {
                guildId: reaction.message.guild.id,
                channelId: reaction.message.channel.id,
                messageId: reaction.message.id,
                emoji: reaction.emoji.name,
                category: 'reactions'
            });

            await saveAuditLog(reaction.message.guild.id, 'REACTION_REMOVE_EMOJI', null, reaction.message.id, null, reaction.message.channel.id, 'Reaction emoji removed', null, reaction.emoji.name, null, {});
        } catch (error) {
            logger.error('[Reactions] Error logging reaction emoji remove:', { error: error.message });
        }
    }
};
