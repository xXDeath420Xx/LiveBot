import { Events, AuditLogEvent } from 'discord.js';
import logger from '../utils/logger.js';
import { logGuildBanAdd } from '../core/log-manager.js';
import { isProtectedOwner, leaveGuildOnAllBots } from '../utils/owner-protection.js';
import { markDeparted as markStreamerDeparted } from '../core/streamer-departure.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { waitForEntry } from '../utils/audit-log-correlator.js';
import { recordNetworkBan } from '../core/network-intel.js';
import { announceBan } from '../core/greeting-manager.js';

/**
 * The audit-log entry for THIS ban. Pre-2026 this did its own fetchAuditLogs
 * poll with retry; now it reads the entry out of the correlator (populated by
 * events/guildAuditLogEntryCreate.js) which saves a REST call per ban in the
 * common case. The old poll is still used as a fallback for the rare race
 * where no AuditLogEntryCreate arrives within the wait window.
 */
async function findBanEntry(guild, userId) {
  const correlated = await waitForEntry(guild.id, AuditLogEvent.MemberBanAdd, userId, 1500);
  if (correlated) return correlated;
  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 5 }).catch(() => null);
  if (!logs) return null;
  return logs.entries.find(e => e.target?.id === userId && Date.now() - e.createdTimestamp < 60_000) || null;
}

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

      // Network Intel (core/network-intel.js): bump the cross-guild "banned from" counter. This
      // is the strongest single lurker-filter signal — other owners' bans ARE our vote. Fire-and-forget.
      if (ban.user?.id) recordNetworkBan(ban.user.id).catch(() => {});

      // Erase their traces, if this server has asked for that. Queued behind the grace window and
      // de-duplicated against the guildMemberRemove a ban also raises.
      try {
        const { schedulePurge } = await import('../core/member-purge.js');
        await schedulePurge(guild, ban.user.id, 'ban');
      } catch (error) {
        logger.warn(`[GuildBanAdd] purge scheduling failed for ${ban.user?.id}: ${error.message}`);
      }

      // Stop announcing a banned member as a streamer. guildMemberRemove has usually already
      // paused these as a 'leave'; markDeparted upgrades the recorded reason to 'ban' without
      // restarting the 30-day clock, so the departed list says what actually happened.
      try {
        await markStreamerDeparted(guild.id, ban.user?.id, 'ban');
      } catch (error) {
        logger.warn(`[GuildBanAdd] streamer departure pause failed for ${ban.user?.id}: ${error.message}`);
      }

      // One audit-log read for everything below (anti-nuke, the network, the ban log).
      const entry = await findBanEntry(guild, ban.user.id);

      // AI moderation learning loop (core/ai-moderation.js): a moderator's ban confirms the member's open AI catches
      // and marks their recent uncaught messages as misses. Bans made by this bot are skipped there.
      import('../core/ai-moderation.js').then(m => m.onMemberBanned(guild, ban.user.id, entry?.executor?.id ?? null)).catch(() => {});

      // Check anti-nuke
      if (entry && ban.client.antiNukeManager) {
        await ban.client.antiNukeManager.trackBan(guild, ban.user, entry.executor);
      }

      // Global ban network (core/global-ban-manager.js ingestBan): every ban here — our protections,
      // staff by hand, other bots — is a signal, weighted by who made it. Only the bot that owns this
      // server does it (the default bot defers to a custom bot, as for joins), so it is counted once.
      let classification = null;
      const owns = !(ban.client?.isDefaultBot && await shouldIgnoreGuild(guild.id).catch(() => false));
      if (owns && ban.client.globalBanManager) {
        classification = await ban.client.globalBanManager.ingestBan(guild, ban.user, entry);
      }

      // The Welcome page's ban announcement, posted once, by the bot that runs the server. Never throws.
      if (owns) await announceBan(ban, { entry });

      await logGuildBanAdd(ban, { entry, classification });
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
