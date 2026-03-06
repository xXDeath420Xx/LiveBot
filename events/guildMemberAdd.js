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
