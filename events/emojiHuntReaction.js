// Emoji hunts: a member adding the hunt emoji to a message the bot hid one on claims it.
// Its own file (rather than a line in messageReactionAdd.js) so it runs regardless of that
// handler's early returns; the loader in index.js registers every file in events/.
// The manager keeps an in-memory index of live spots, so every other reaction costs one Map lookup.
import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { handleReactionAdd } from '../core/emoji-hunt-manager.js';

export default {
    name: Events.MessageReactionAdd,
    async execute(reaction, user) {
        try {
            await handleReactionAdd(reaction, user);
        } catch (error) {
            logger.error('[EmojiHunt] Reaction handler failed', {
                error: error.message,
                messageId: reaction?.message?.id,
                userId: user?.id,
            });
        }
    }
};
