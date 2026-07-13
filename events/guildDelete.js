import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

export default {
  name: Events.GuildDelete,
  async execute(guild) {
    const guildName = guild.name || 'Unknown';
    logger.warn(`[GuildDelete] Removed from guild: ${guildName} (${guild.id})`);

    try {
      // Mark loss via left_at; preserve last_seen so we keep the
      // "last observed" timestamp for audit purposes.
      await pool.execute(`
        INSERT INTO guilds (guild_id, guild_name, last_seen, left_at)
        VALUES (?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          left_at = NOW()
      `, [guild.id, guildName]);
    } catch (error) {
      logger.error('[GuildDelete] Failed to update guild record', {
        error: error.message,
        guildId: guild.id
      });
    }
  }
};
