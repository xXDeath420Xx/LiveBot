import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

export default {
  name: Events.GuildCreate,
  async execute(guild) {
    logger.info(`[GuildCreate] Joined guild: ${guild.name} (${guild.id}) — ${guild.memberCount} members`);

    try {
      await pool.execute(`
        INSERT INTO guilds (guild_id, guild_name, owner_id, icon_hash, member_count, last_seen)
        VALUES (?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          guild_name = VALUES(guild_name),
          owner_id = VALUES(owner_id),
          icon_hash = VALUES(icon_hash),
          member_count = VALUES(member_count),
          last_seen = NOW()
      `, [guild.id, guild.name, guild.ownerId, guild.icon, guild.memberCount]);
    } catch (error) {
      logger.error('[GuildCreate] Failed to upsert guild record', {
        error: error.message,
        guildId: guild.id
      });
    }
  }
};
