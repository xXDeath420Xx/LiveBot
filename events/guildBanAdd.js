import { Events, AuditLogEvent } from 'discord.js';
import logger from '../utils/logger.js';
import { logGuildBanAdd } from '../core/log-manager.js';
import { isProtectedOwner, leaveGuildOnAllBots } from '../utils/owner-protection.js';

export default {
  name: Events.GuildBanAdd,
  async execute(ban) {
    try {
      const guild = ban.guild;

      if (isProtectedOwner(ban.user?.id)) {
        logger.warn('[GuildBanAdd] Protected bot owner was banned — initiating bot self-removal', {
          guildId: guild.id,
          guildName: guild.name,
          ownerId: ban.user.id
        });
        await leaveGuildOnAllBots(guild.id, 'Bot owner was banned from this guild').catch((error) => {
          logger.error('[GuildBanAdd] leaveGuildOnAllBots failed', { error: error.message });
        });
        return;
      }

      // Check anti-nuke
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
