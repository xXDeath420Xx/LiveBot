import { Events } from 'discord.js';
import logger from '../utils/logger.js';
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
