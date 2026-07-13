import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logMemberJoin } from '../core/log-manager.js';
import { handleGuildMemberAdd } from '../core/greeting-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import pool from '../utils/db.js';

export default {
  name: Events.GuildMemberAdd,
  async execute(member) {
    // Log which bot is handling this event
    const botIdentifier = member.client.isDefaultBot ? 'DEFAULT BOT' : `CUSTOM BOT (${member.client.botId})`;
    logger.info(`[GuildMemberAdd] Event received by ${botIdentifier} for user ${member.user.tag} in guild ${member.guild.id}`);

    // Only the default bot should ignore guilds with custom bots
    if (member.client.isDefaultBot) {
      const shouldIgnore = await shouldIgnoreGuild(member.guild.id);
      logger.info(`[GuildMemberAdd] Default bot checking if should ignore guild ${member.guild.id}: ${shouldIgnore}`);
      if (shouldIgnore) {
        logger.info(`[GuildMemberAdd] Default bot ignoring guild ${member.guild.id} (has custom bot assigned)`);
        return;
      }
    }

    // A supporter who donated before joining (or who left and came back) gets their role.
    // Best-effort: never let this block the join pipeline.
    try {
      const { syncMember } = await import('../core/kofi-manager.js');
      await syncMember(member);
    } catch (err) {
      logger.error(`[Kofi] member sync failed: ${err.message}`);
    }

    // Stale event guard - skip if member joined more than 30s ago (replayed event from restart)
    if (member.joinedAt) {
      const joinAge = Date.now() - member.joinedAt.getTime();
      if (joinAge > 30000) {
        logger.info(`[GuildMemberAdd] Ignoring stale event for ${member.user.tag} in ${member.guild.id} - joined ${Math.round(joinAge / 1000)}s ago`);
        return;
      }
    }

    // Raid Detection - track join for raid detection
    if (member.client.raidDetectionManager) {
      try {
        await member.client.raidDetectionManager.trackJoin(member);
      } catch (error) {
        logger.error('[GuildMemberAdd] Error tracking join for raid detection', {
          error: error.message,
          guildId: member.guild?.id,
          userId: member.id
        });
      }
    }

    // Global Ban check - enforce shared ban list on join
    if (member.client.globalBanManager) {
      try {
        await member.client.globalBanManager.checkMember(member);
      } catch (error) {
        logger.error('[GuildMemberAdd] Error checking global ban', {
          error: error.message,
          guildId: member.guild?.id,
          userId: member.id
        });
      }
    }

    // Backup Restore — auto-reassign roles to returning members
    try {
      const [restoreRows] = await pool.execute(
        'SELECT backup_restore_data, backup_restore_expires FROM guild_settings WHERE guild_id = ? AND backup_restore_data IS NOT NULL',
        [member.guild.id]
      );
      if (restoreRows.length > 0 && restoreRows[0].backup_restore_data) {
        const expires = restoreRows[0].backup_restore_expires;
        if (expires && new Date(expires) > new Date()) {
          const pendingRestores = JSON.parse(restoreRows[0].backup_restore_data);
          const memberRestore = pendingRestores.find(m => m.userId === member.id);
          if (memberRestore && memberRestore.roles.length > 0) {
            const rolesToAdd = memberRestore.roles
              .map(rid => member.guild.roles.cache.get(rid))
              .filter(r => r && !r.managed);
            if (rolesToAdd.length > 0) {
              await member.roles.add(rolesToAdd, 'Backup restore — member rejoin');
              if (memberRestore.nickname) {
                await member.setNickname(memberRestore.nickname, 'Backup restore').catch(() => {});
              }
              logger.info(`[Backup Restore] Auto-restored ${rolesToAdd.length} roles for ${member.user.username} in ${member.guild.name} (rejoin within restore window)`);
            }
          }
        } else if (expires && new Date(expires) <= new Date()) {
          // Expired — clean up
          await pool.execute(
            'UPDATE guild_settings SET backup_restore_data = NULL, backup_restore_expires = NULL WHERE guild_id = ?',
            [member.guild.id]
          );
        }
      }
    } catch (error) {
      logger.error('[GuildMemberAdd] Error checking backup restore', { error: error.message, guildId: member.guild?.id, userId: member.id });
    }

    // Verification gate — if configured for this guild, assign the unverified role so
    // the user only sees the gate channel until they click the rules-accept button.
    try {
      const [verifyRows] = await pool.execute(
        'SELECT unverified_role_id, enabled FROM verify_config WHERE guild_id = ?',
        [member.guild.id]
      );
      if (verifyRows.length && verifyRows[0].enabled && verifyRows[0].unverified_role_id) {
        const unverifiedRole = member.guild.roles.cache.get(verifyRows[0].unverified_role_id);
        if (unverifiedRole && !member.user.bot) {
          await member.roles.add(unverifiedRole, 'Verification: new member awaiting rules acceptance').catch(e => {
            logger.warn('[GuildMemberAdd] Could not add unverified role', { err: e.message, guildId: member.guild.id, userId: member.id });
          });
        }
      }
    } catch (error) {
      logger.error('[GuildMemberAdd] Error applying verification gate', {
        error: error.message, guildId: member.guild?.id, userId: member.id
      });
    }

    try {
      await logMemberJoin(member);
    } catch (error) {
      logger.error('[GuildMemberAdd] Error logging member join', {
        error: error.message,
        stack: error.stack,
        guildId: member.guild?.id,
        userId: member.id
      });
    }

    try {
      logger.info(`[GuildMemberAdd] ${botIdentifier} calling handleGuildMemberAdd for ${member.user.tag}`);
      await handleGuildMemberAdd(member);
    } catch (error) {
      logger.error('[GuildMemberAdd] Error handling welcome message', {
        error: error.message,
        stack: error.stack,
        guildId: member.guild?.id,
        userId: member.id
      });
    }

    // Track server statistics
    if (member.client.serverStatsManager) {
      try {
        await member.client.serverStatsManager.trackMemberJoin(member.guild.id);
      } catch (error) {
        logger.error('[GuildMemberAdd] Error tracking member join stats', {
          error: error.message,
          guildId: member.guild?.id,
          userId: member.id
        });
      }
    }

    // Track achievements
    if (member.client.achievementManager) {
      try {
        // Early adopter achievement - first 10 members to join
        const memberCount = member.guild.memberCount;
        if (memberCount <= 10) {
          await member.client.achievementManager.trackAchievement(
            member.id,
            member.guild.id,
            'early_adopter',
            1,
            { completed: true }
          );
        }

        // Trailblazer achievement - first 100 members
        if (memberCount <= 100) {
          await member.client.achievementManager.trackAchievement(
            member.id,
            member.guild.id,
            'trailblazer',
            1,
            { completed: true }
          );
        }
      } catch (error) {
        logger.error('[GuildMemberAdd] Error tracking achievements', {
          error: error.message,
          guildId: member.guild?.id,
          userId: member.id
        });
      }
    }
  }
};
