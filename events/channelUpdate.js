import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logChannelUpdate } from '../core/log-manager.js';

export default {
  name: Events.ChannelUpdate,
  async execute(oldChannel, newChannel) {
    try {
      await logChannelUpdate(oldChannel, newChannel);
    } catch (error) {
      logger.error('[ChannelUpdate] Error logging channel update', {
        error: error.message,
        stack: error.stack,
        guildId: newChannel.guild?.id,
        channelId: newChannel.id
      });
    }
  }
};
