import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { handleTimeReaction } from '../core/timezone-manager.js';

// Reaction *audit-channel* embeds (per-user "added :smile:" spam) were removed
// 2026-10-18 at the owner's request. We still dispatch starboard, reaction-roles
// and timezone-reaction handling here — just no longer posting to log channels.
export default {
  name: Events.MessageReactionAdd,
  async execute(reaction, user) {
    try {
      if (user.bot) return;

      // 🕰️ on a time we detected — DM the clicker their conversion.
      if (await handleTimeReaction(reaction, user)) return;

      if (reaction.client.starboardManager) {
        await reaction.client.starboardManager.handleReactionAdd(reaction, user);
      }

      if (reaction.client.reactionRoleManager) {
        await reaction.client.reactionRoleManager.handleReactionAdd(reaction, user);
      }
    } catch (error) {
      logger.error('[MessageReactionAdd] Error handling reaction', {
        error: error.message,
        stack: error.stack,
        messageId: reaction.message.id,
        userId: user.id
      });
    }
  }
};
