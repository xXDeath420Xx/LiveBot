/*
 * Chat-to-voice reader (core/voice-reader-manager.js).
 *
 * Its own listener rather than a line in messageCreate.js: that handler returns early for prefix
 * commands, games, counting and more, and a message consumed by any of those would silently never
 * be read aloud. The reader waits a moment before speaking so automod still gets first say.
 */
import { Events } from 'discord.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { handleReaderMessage } from '../core/voice-reader-manager.js';

export default {
    name: Events.MessageCreate,
    async execute(message) {
        if (!message.guild || message.author.bot) return;
        if (message.client.isDefaultBot && await shouldIgnoreGuild(message.guild.id)) return;
        await handleReaderMessage(message);
    },
};
