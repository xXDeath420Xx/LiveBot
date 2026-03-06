import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logRoleCreate } from '../core/log-manager.js';

export default {
  name: Events.GuildRoleCreate,
  async execute(role) {
    try {
      await logRoleCreate(role);
    } catch (error) {
      logger.error('[GuildRoleCreate] Error logging role creation', {
        error: error.message,
        stack: error.stack,
        guildId: role.guild?.id,
        roleId: role.id
      });
    }
  }
};
