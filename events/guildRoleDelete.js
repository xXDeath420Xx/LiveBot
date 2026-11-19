import { Events, AuditLogEvent } from 'discord.js';
import logger from '../utils/logger.js';
import { logRoleDelete } from '../core/log-manager.js';
import { waitForEntry } from '../utils/audit-log-correlator.js';
import { onRoleDelete as autoRoleCategoryRoleDelete } from '../core/auto-role-categories.js';

export default {
  name: Events.GuildRoleDelete,
  async execute(role) {
    try {
      const guild = role.guild;

      // Clean up any reaction-role mapping on auto-role-category panels that
      // referenced this role, and strip the stale reaction emoji from the panel
      // message. Scoped to panels registered under auto_role_categories only.
      autoRoleCategoryRoleDelete(role).catch(() => {});
      // Correlator first (populated by guildAuditLogEntryCreate), falling back
      // to a direct fetchAuditLogs if the audit entry didn't arrive in time.
      let entry = await waitForEntry(guild.id, AuditLogEvent.RoleDelete, role.id, 1000);
      if (!entry) {
        const auditLogs = await guild.fetchAuditLogs({
          type: AuditLogEvent.RoleDelete,
          limit: 1
        }).catch(() => null);
        if (auditLogs && auditLogs.entries.size > 0) {
          const first = auditLogs.entries.first();
          if (first.target?.id === role.id) entry = first;
        }
      }

      if (entry && role.client.antiNukeManager) {
        await role.client.antiNukeManager.trackRoleDelete(guild, role, entry.executor);
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
