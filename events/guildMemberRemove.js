import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { removeChannelVIP } from '../utils/platforms/twitch.js';
import { logMemberLeave } from '../core/log-manager.js';
import { handleGuildMemberRemove } from '../core/greeting-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
  name: Events.GuildMemberRemove,
  async execute(member) {
    // Only the default bot should ignore guilds with custom bots
    if (member.client.isDefaultBot && await shouldIgnoreGuild(member.guild.id)) return;

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
