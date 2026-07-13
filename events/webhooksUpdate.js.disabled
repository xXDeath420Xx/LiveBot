import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logWebhookUpdate } from '../core/log-manager.js';

export default {
  name: Events.WebhooksUpdate,
  async execute(channel) {
    try {
      await logWebhookUpdate(channel);
    } catch (error) {
      logger.error('[WebhooksUpdate] Error logging webhook update', {
        error: error.message,
        stack: error.stack,
        guildId: channel.guild?.id,
        channelId: channel.id
      });
    }
  }
};
