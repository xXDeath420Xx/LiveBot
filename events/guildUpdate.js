import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { logGuildUpdate } from '../core/log-manager.js';

export default {
  name: Events.GuildUpdate,
  async execute(oldGuild, newGuild) {
    try {
      await logGuildUpdate(oldGuild, newGuild);
    } catch (error) {
      logger.error('[GuildUpdate] Error logging guild update', {
        error: error.message,
        stack: error.stack,
        guildId: newGuild.id
      });
    }

    // Persist updated guild info to DB (catches renames in real-time)
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
      `, [newGuild.id, newGuild.name, newGuild.ownerId, newGuild.icon, newGuild.memberCount]);
    } catch (error) {
      logger.error('[GuildUpdate] Failed to upsert guild record', {
        error: error.message,
        guildId: newGuild.id
      });
    }
  }
};
