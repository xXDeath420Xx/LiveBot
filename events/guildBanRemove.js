import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logGuildBanRemove } from '../core/log-manager.js';
import { addReset } from '../core/join-history.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
  name: Events.GuildBanRemove,
  async execute(ban) {
    try {
      await logGuildBanRemove(ban);
    } catch (error) {
      logger.error('[GuildBanRemove] Error logging unban', {
        error: error.message,
        stack: error.stack,
        guildId: ban.guild?.id,
        userId: ban.user?.id
      });
    }

    // Staff lifting a ban means "let them back in". Restart the rejoin limit's count from here, or
    // their old joins would remove them again the moment they return. Recorded whether or not the
    // limit is on, so switching it on later does not catch someone already forgiven. Only the bot
    // that owns the server writes it (the default bot defers to a custom bot, as for joins).
    try {
      if (ban.client?.isDefaultBot && await shouldIgnoreGuild(ban.guild.id)) return;
      await addReset(ban.guild.id, ban.user.id, 'unban');
    } catch (error) {
      logger.warn(`[GuildBanRemove] could not reset rejoin count for ${ban.user?.id}: ${error.message}`);
    }
  }
};
