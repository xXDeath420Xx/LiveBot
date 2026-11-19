import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { removeChannelVIP } from '../utils/platforms/twitch.js';
import { logMemberLeave } from '../core/log-manager.js';
import { handleGuildMemberRemove } from '../core/greeting-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { markLeft as markTempAccessLeft } from '../core/temp-access-manager.js';
import { markDeparted as markStreamerDeparted } from '../core/streamer-departure.js';
import { saveOnLeave as saveStickyRoles } from '../core/sticky-roles-manager.js';
import { waitForEntry } from '../utils/audit-log-correlator.js';
import { AuditLogEvent } from 'discord.js';
import { recordNetworkLeave } from '../core/network-intel.js';

export default {
  name: Events.GuildMemberRemove,
  async execute(member) {
    // Only the default bot should ignore guilds with custom bots
    if (member.client.isDefaultBot && await shouldIgnoreGuild(member.guild.id)) return;

    // Sticky roles — remember their roles so a rejoin can restore them (guilds.sticky_roles_enabled;
    // core/sticky-roles-manager.js). First, before anything slow: the member object is all we have.
    // Never throws.
    await saveStickyRoles(member);

    // Network Intel (core/network-intel.js): decrement the "currently in" counter. A ban also
    // fires guildBanAdd which bumps guilds_banned_from separately — we don't double-classify here.
    recordNetworkLeave(member.id).catch(() => {});

    // Erase their traces, if this server has asked for that.
    //
    // Fires for BOTH a voluntary leave and a kick — Discord does not distinguish here, and the audit
    // log lookup that would is unreliable under load. The reason is resolved as 'kick' when the
    // audit log says so and 'leave' otherwise; a ban raises guildBanAdd separately and the purge
    // scheduler de-duplicates the two.
    // Resolved once and shared by the purge and the streamer-departure pause below, so a single
    // audit-log read serves both and the two cannot disagree about whether this was a kick.
    let reason = 'leave';
    try {
      const { schedulePurge } = await import('../core/member-purge.js');
      // Correlator first (populated by guildAuditLogEntryCreate), then a direct
      // audit-log fetch as fallback for the rare race where the audit entry has
      // not landed yet by the time this fires.
      let kick = await waitForEntry(member.guild.id, AuditLogEvent.MemberKick, member.id, 800);
      if (!kick) {
        const log = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 5 }).catch(() => null);
        kick = log?.entries?.find(e => e.target?.id === member.id && Date.now() - e.createdTimestamp < 10_000);
      }
      if (kick) reason = 'kick';
      await schedulePurge(member.guild, member.id, reason);
    } catch (error) {
      logger.warn(`[GuildMemberRemove] purge scheduling failed for ${member.id}: ${error.message}`);
    }

    // Stop announcing them as a streamer in a server they are no longer in.
    //
    // Reuses the `reason` resolved above, so a kick is recorded as a kick. This only pauses — the
    // subscription and all its settings survive, and guildMemberAdd restores them if they come
    // back. Deletion is thirty days away and belongs to the sweeper, not to this event.
    try {
      await markStreamerDeparted(member.guild.id, member.id, reason);
    } catch (error) {
      logger.warn(`[GuildMemberRemove] streamer departure pause failed for ${member.id}: ${error.message}`);
    }

    // Close any live temporary-access trial. Without this the row stays 'pending'
    // and every sweep re-fetches a member who is not there — and if they rejoin
    // later, they'd inherit the old deadline instead of a fresh one.
    try {
      await markTempAccessLeft(member.guild.id, member.id);
    } catch (error) {
      logger.warn(`[GuildMemberRemove] temp-access close failed for ${member.id}: ${error.message}`);
    }

    try {
      // logMemberLeave internally handles both kicks and normal leaves
      await logMemberLeave(member);
    } catch (error) {
      logger.error('[GuildMemberRemove] Error logging member removal', {
        error: error.message,
        stack: error.stack,
        guildId: member.guild?.id,
        userId: member.id
      });
    }

    try {
      await handleGuildMemberRemove(member);
    } catch (error) {
      logger.error('[GuildMemberRemove] Error handling goodbye message', {
        error: error.message,
        stack: error.stack,
        guildId: member.guild?.id,
        userId: member.id
      });
    }

    // Twitch VIP removal on leave
    try {
      const [syncConfig] = await pool.execute(
        'SELECT * FROM twitch_role_sync_config WHERE guild_id = ? AND enabled = 1 AND remove_vip_on_leave = 1',
        [member.guild.id]
      );
      if (syncConfig.length > 0) {
        const config = syncConfig[0];
        const [links] = await pool.execute(
          'SELECT twitch_user_id FROM community_twitch_links WHERE guild_id = ? AND discord_user_id = ?',
          [member.guild.id, member.id]
        );
        if (links.length > 0 && links[0].twitch_user_id) {
          const [memberSync] = await pool.execute(
            'SELECT is_vip FROM twitch_role_sync_members WHERE guild_id = ? AND discord_user_id = ?',
            [member.guild.id, member.id]
          );
          if (memberSync.length > 0 && memberSync[0].is_vip) {
            const accessToken = encryption.decrypt(JSON.parse(config.broadcaster_token));
            await removeChannelVIP(config.broadcaster_twitch_id, links[0].twitch_user_id, accessToken);
            logger.info(`[TwitchRoleSync] Removed VIP for ${member.user.username} (left ${member.guild.name})`);
            await pool.execute('DELETE FROM twitch_role_sync_members WHERE guild_id = ? AND discord_user_id = ?', [member.guild.id, member.id]);
          }
        }
      }
    } catch (err) {
      logger.error('[TwitchRoleSync] Error removing VIP on leave:', { error: err.message, guildId: member.guild?.id, userId: member.id });
    }

    // Track server statistics
    if (member.client.serverStatsManager) {
      try {
        await member.client.serverStatsManager.trackMemberLeave(member.guild.id);
      } catch (error) {
        logger.error('[GuildMemberRemove] Error tracking member leave stats', {
          error: error.message,
          guildId: member.guild?.id,
          userId: member.id
        });
      }
    }
  }
};
