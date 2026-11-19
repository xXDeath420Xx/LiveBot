import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { servedByAnotherClient } from '../core/guild-presence-logic.js';
import { notifyOwnerOfRemoval } from '../utils/owner-removal-notifier.js';

export default {
  name: Events.GuildDelete,
  async execute(guild) {
    const guildName = guild.name || 'Unknown';
    logger.warn(`[GuildDelete] Removed from guild: ${guildName} (${guild.id})`);

    // One bot leaving is not the server being left: another of ours may still serve it
    // (e.g. the main bot leaving after a custom-bot takeover). See core/guild-presence.js.
    if (servedByAnotherClient(global.botManager, guild.id, guild.client)) {
      logger.info(`[GuildDelete] ${guildName} (${guild.id}) is still served by another bot; not marking it left`);
      return;
    }

    // Read the prior row BEFORE the upsert so the removal DM has the last-known
    // snapshot (owner, member count, icon, how long we were there). The guild
    // object Discord hands us on GuildDelete is often partial — the cache may
    // already be gone, so these fields back-fill the owner-DM.
    let priorRow = null;
    try {
      const [[row]] = await pool.execute(
        'SELECT guild_name, owner_id, icon_hash, member_count, last_seen FROM guilds WHERE guild_id = ?',
        [guild.id]
      );
      priorRow = row || null;
    } catch { /* snapshot is best-effort — the DM still sends with whatever the live guild has */ }

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

    // DM the bot owner — symmetric to the install DM sent by guildCreate.js.
    // Fire-and-forget so a DM failure never breaks the departure flow.
    void notifyOwnerOfRemoval(guild, {
      guildName: priorRow?.guild_name || guildName,
      memberCount: priorRow?.member_count ?? null,
      ownerId: priorRow?.owner_id || guild.ownerId || null,
      iconHash: priorRow?.icon_hash || null,
      lastSeenAt: priorRow?.last_seen || null,
    });
  }
};
