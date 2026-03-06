import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logRoleUpdate } from '../core/log-manager.js';

export default {
  name: Events.GuildRoleUpdate,
  async execute(oldRole, newRole) {
    try {
      await logRoleUpdate(oldRole, newRole);
    } catch (error) {
      logger.error('[GuildRoleUpdate] Error logging role update', {
        error: error.message,
        stack: error.stack,
        guildId: newRole.guild?.id,
        roleId: newRole.id
      });
    }
  }
};
