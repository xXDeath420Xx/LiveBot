import { Events, AuditLogEvent } from 'discord.js';
import logger from '../utils/logger.js';
import { logGuildBanAdd } from '../core/log-manager.js';

export default {
  name: Events.GuildBanAdd,
  async execute(ban) {
    try {
      // Check anti-nuke
      const guild = ban.guild;
      const auditLogs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberBanAdd,
        limit: 1
      }).catch(() => null);

      if (auditLogs && auditLogs.entries.size > 0) {
        const entry = auditLogs.entries.first();
        if (entry.target.id === ban.user.id && ban.client.antiNukeManager) {
          await ban.client.antiNukeManager.trackBan(guild, ban.user, entry.executor);
        }
      }

      await logGuildBanAdd(ban);
    } catch (error) {
      logger.error('[GuildBanAdd] Error logging ban', {
        error: error.message,
        stack: error.stack,
        guildId: ban.guild?.id,
        userId: ban.user?.id
      });
    }
  }
};
