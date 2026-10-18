import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

// Channel-embed audit log removed 2026-10-18 — reaction events were spamming log
// channels. Internal DB row is kept so dashboard forensics still see mod-wipes.
export default {
    name: Events.MessageReactionRemoveAll,
    async execute(message, reactions) {
        try {
            if (!message.guild) return;

            if (message.client.isDefaultBot && await shouldIgnoreGuild(message.guild.id)) return;

            logger.info(`[Reactions] All reactions removed from message ${message.id}`, {
                guildId: message.guild.id,
                channelId: message.channel.id,
                messageId: message.id,
                category: 'reactions'
            });

            await saveAuditLog(message.guild.id, 'REACTION_REMOVE_ALL', null, message.id, null, message.channel.id, 'All reactions removed', null, null, null, {});
        } catch (error) {
            logger.error('[Reactions] Error logging reaction remove all:', { error: error.message });
        }
    }
};
