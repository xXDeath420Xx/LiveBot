import { Events, AuditLogEvent } from 'discord.js';
import logger from '../utils/logger.js';
import { logRoleDelete } from '../core/log-manager.js';

export default {
  name: Events.GuildRoleDelete,
  async execute(role) {
    try {
      // Check anti-nuke
      const guild = role.guild;
      const auditLogs = await guild.fetchAuditLogs({
        type: AuditLogEvent.RoleDelete,
        limit: 1
      }).catch(() => null);

      if (auditLogs && auditLogs.entries.size > 0) {
        const entry = auditLogs.entries.first();
        if (entry.target.id === role.id && role.client.antiNukeManager) {
          await role.client.antiNukeManager.trackRoleDelete(guild, role, entry.executor);
        }
      }

      await logRoleDelete(role);
    } catch (error) {
      logger.error('[GuildRoleDelete] Error logging role deletion', {
        error: error.message,
        stack: error.stack,
        guildId: role.guild?.id,
        roleId: role.id
      });
    }
  }
};
