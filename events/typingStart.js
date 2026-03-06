import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.TypingStart,
    async execute(typing) {
        try {
            if (!typing.guild) return;
            if (typing.user.bot) return; // Don't log bot typing

            if (typing.client.isDefaultBot && await shouldIgnoreGuild(typing.guild.id)) return;

            // Only log to database, not to channel (would be too spammy)
            logger.debug(`[Typing] ${typing.user.tag} started typing in #${typing.channel.name}`, {
                guildId: typing.guild.id,
                channelId: typing.channel.id,
                userId: typing.user.id,
                category: 'typing'
            });

            // Save to audit log for activity tracking
            await saveAuditLog(
                typing.guild.id,
                'TYPING_START',
                typing.user.id,
                null,
                null,
                typing.channel.id,
                'Started typing',
                null,
                null,
                null,
                { username: typing.user.tag, channel: typing.channel.name }
            );
        } catch (error) {
            logger.error('[Typing] Error logging typing start:', { error: error.message });
        }
    }
};
