import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

export default {
  name: Events.GuildDelete,
  async execute(guild) {
    const guildName = guild.name || 'Unknown';
    logger.warn(`[GuildDelete] Removed from guild: ${guildName} (${guild.id})`);

    try {
      // Update last_seen to mark when we lost access — do NOT delete the row
      await pool.execute(`
        INSERT INTO guilds (guild_id, guild_name, last_seen)
        VALUES (?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          last_seen = NOW()
      `, [guild.id, guildName]);
    } catch (error) {
      logger.error('[GuildDelete] Failed to update guild record', {
        error: error.message,
        guildId: guild.id
      });
    }
  }
};
