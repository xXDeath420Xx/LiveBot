import pool from './db.js';
import logger from './logger.js';

/**
 * Check if a custom bot is assigned to a guild
 * Returns true if main bot should ignore this guild, false otherwise
 * @param {string} guildId - The guild ID to check
 * @returns {Promise<boolean>}
 */
export async function shouldIgnoreGuild(guildId) {
  if (!guildId) return false;

  try {
    const [customBotMapping] = await pool.execute(
      'SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?',
      [guildId]
    );

    return customBotMapping.length > 0;
  } catch (error) {
    logger.error('[Custom Bot Check] Error checking guild mapping:', error);
    // On error, don't ignore (fail open to maintain functionality)
    return false;
  }
}

export default { shouldIgnoreGuild };
