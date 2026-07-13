import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logThreadCreate } from '../core/log-manager.js';
import { checkAnnounceChannelGate } from '../core/self-promo-handler.js';

export default {
  name: Events.ThreadCreate,
  async execute(thread) {
    try {
      // Bot-created threads always pass — the bot may auto-spawn threads
      // off its own announcement embeds.
      const botUserId = thread.client?.user?.id;
      if (botUserId && thread.ownerId === botUserId) {
        await logThreadCreate(thread);
        return;
      }

      const parent = thread.parent;
      if (thread.guild && thread.ownerId && parent?.id) {
        const gate = await checkAnnounceChannelGate(thread.guild, thread.ownerId, parent.id);
        if (!gate.allowed && gate.deleteUnauthorized) {
          await thread.delete('Self-promo announce gate: unauthorized thread creation').catch(err => {
            logger.warn('[ThreadCreate] Failed to delete unauthorized thread', {
              error: err.message, threadId: thread.id, guildId: thread.guild.id,
            });
          });
          const owner = await thread.guild.members.fetch(thread.ownerId).catch(() => null);
          if (owner) {
            const reasonList = (gate.reasons || []).map(r => `• ${r}`).join('\n');
            owner.send(
              `Your thread in <#${parent.id}> was removed because that channel is gated:\n${reasonList}`
            ).catch(() => { /* user has DMs closed — nothing we can do */ });
          }
          logger.info('[ThreadCreate] Deleted unauthorized thread in gated announce channel', {
            guildId: thread.guild.id, userId: thread.ownerId, channelId: parent.id, threadId: thread.id,
          });
          return; // thread is gone — skip logging
        }
      }

      await logThreadCreate(thread);
    } catch (error) {
      logger.error('[ThreadCreate] Error handling thread creation', {
        error: error.message,
        stack: error.stack,
        guildId: thread.guild?.id,
        threadId: thread.id,
      });
    }
  }
};
