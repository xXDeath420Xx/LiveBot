import { Events } from 'discord.js';
import logger from '../utils/logger.js';

// Reaction *audit-channel* embeds (per-user "removed :smile:" spam) were removed
// 2026-10-18 at the owner's request. Starboard and reaction-roles un-registration
// still dispatch here — just no longer posting to log channels.
export default {
  name: Events.MessageReactionRemove,
  async execute(reaction, user) {
    try {
      if (user.bot) return;

      if (reaction.client.starboardManager) {
        await reaction.client.starboardManager.handleReactionRemove(reaction, user);
      }

      if (reaction.client.reactionRoleManager) {
        await reaction.client.reactionRoleManager.handleReactionRemove(reaction, user);
      }
    } catch (error) {
      logger.error('[MessageReactionRemove] Error handling reaction removal', {
        error: error.message,
        stack: error.stack,
        messageId: reaction.message.id,
        userId: user.id
      });
    }
  }
};
