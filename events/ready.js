import { Events, ActivityType } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { scanForActiveStreamers } from './presenceUpdate.js';

const DELETE_DELAY_MS = 1200; // ~1.2s between individual deletes to respect rate limits

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cleanupAutoDeleteChannels(client) {
  try {
    const [rows] = await pool.execute(
      'SELECT guild_id, channel_id, after_message_id, delete_before FROM auto_delete_channels'
    );
    if (rows.length === 0) return;

    for (const { guild_id, channel_id, after_message_id, delete_before } of rows) {
      // Only process channels this client can access
      const guild = client.guilds.cache.get(guild_id);
      if (!guild) continue;

      try {
        const channel = await guild.channels.fetch(channel_id).catch(() => null);
        if (!channel || !channel.isTextBased()) continue;

        // --- Clean messages AFTER the threshold (posted during downtime) ---
        const afterMessages = await channel.messages.fetch({ limit: 100, after: after_message_id });
        if (afterMessages.size > 0) {
          const toDeleteAfter = afterMessages.filter(m => BigInt(m.id) > BigInt(after_message_id));
          if (toDeleteAfter.size > 0) {
            const deleted = await channel.bulkDelete(toDeleteAfter, true).catch(() => null);
            const bulkCount = deleted ? deleted.size : 0;

            // Individually delete any that were too old for bulkDelete
            if (bulkCount < toDeleteAfter.size) {
              const remaining = toDeleteAfter.filter(m => !deleted || !deleted.has(m.id));
              for (const [, msg] of remaining) {
                await msg.delete().catch(() => {});
                await sleep(DELETE_DELAY_MS);
              }
            }

            logger.info(`[AutoDelete Startup] Cleaned ${toDeleteAfter.size} message(s) AFTER threshold in channel ${channel_id}`, {
              category: 'autoDelete', guildId: guild_id
            });
          }
        }

        // --- Clean messages BEFORE the threshold (if enabled) ---
        if (delete_before) {
          let totalDeletedBefore = 0;
          let beforeCursor = after_message_id;
          let hasMore = true;

          while (hasMore) {
            // Fetch up to 100 messages before the cursor
            const beforeMessages = await channel.messages.fetch({ limit: 100, before: beforeCursor });
            if (beforeMessages.size === 0) {
              hasMore = false;
              break;
            }

            // Update cursor to oldest message in this batch
            const oldest = beforeMessages.last();
            beforeCursor = oldest.id;

            // Try bulkDelete first for messages <14 days old
            const deleted = await channel.bulkDelete(beforeMessages, true).catch(() => null);
            const bulkCount = deleted ? deleted.size : 0;
            totalDeletedBefore += bulkCount;

            // Individually delete any that were too old for bulkDelete
            if (bulkCount < beforeMessages.size) {
              const remaining = beforeMessages.filter(m => !deleted || !deleted.has(m.id));
              for (const [, msg] of remaining) {
                await msg.delete().catch(() => {});
                totalDeletedBefore++;
                await sleep(DELETE_DELAY_MS);
              }
            }

            // If we got fewer than 100, we've reached the beginning of the channel
            if (beforeMessages.size < 100) {
              hasMore = false;
            }
          }

          if (totalDeletedBefore > 0) {
            logger.info(`[AutoDelete Startup] Cleaned ${totalDeletedBefore} message(s) BEFORE threshold in channel ${channel_id}`, {
              category: 'autoDelete', guildId: guild_id
            });
          }
        }
      } catch (err) {
        logger.error(`[AutoDelete Startup] Error cleaning channel ${channel_id}: ${err.message}`, {
          category: 'autoDelete'
        });
      }
    }
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') {
      logger.error(`[AutoDelete Startup] Failed to load config: ${err.message}`, { category: 'autoDelete' });
    }
  }
}

async function syncGuildNames(client) {
  const guilds = client.guilds.cache;
  if (guilds.size === 0) return;

  // Build a single bulk upsert query for efficiency
  const placeholders = [];
  const values = [];
  for (const [, guild] of guilds) {
    placeholders.push('(?, ?, ?, ?, ?, NOW())');
    values.push(guild.id, guild.name, guild.ownerId, guild.icon, guild.memberCount);
  }

  try {
    await pool.execute(`
      INSERT INTO guilds (guild_id, guild_name, owner_id, icon_hash, member_count, last_seen)
      VALUES ${placeholders.join(', ')}
      ON DUPLICATE KEY UPDATE
        guild_name = VALUES(guild_name),
        owner_id = VALUES(owner_id),
        icon_hash = VALUES(icon_hash),
        member_count = VALUES(member_count),
        last_seen = NOW()
    `, values);

    logger.info(`[GuildSync] Synced ${guilds.size} guild name(s) to database`);
  } catch (error) {
    logger.error('[GuildSync] Failed to sync guild names', {
      error: error.message,
      guildCount: guilds.size
    });
  }
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    logger.info('═══════════════════════════════════════════════');
    logger.info(`  ✓ Bot is online as ${client.user.tag}`);
    logger.info(`  ✓ Serving ${client.guilds.cache.size} guild(s)`);
    logger.info(`  ✓ Total users: ${client.users.cache.size}`);
    logger.info('═══════════════════════════════════════════════');

    // Set bot status
    client.user.setPresence({
      activities: [
        {
          name: 'CertiFried Utility | /help',
          type: ActivityType.Playing
        }
      ],
      status: 'online'
    });

    logger.info('[Ready] Bot is fully operational');

    // Retroactively clean auto-delete channels (catches messages posted during downtime)
    cleanupAutoDeleteChannels(client).catch(err => {
      logger.error(`[AutoDelete Startup] Unhandled error: ${err.message}`, { category: 'autoDelete' });
    });

    // Sync all guild names to DB (catches guilds that joined while offline)
    syncGuildNames(client).catch(err => {
      logger.error(`[GuildSync] Unhandled error: ${err.message}`);
    });

    // Scan for members already streaming (catches transitions missed during restart)
    // Delay slightly to let Discord populate the presence cache
    setTimeout(() => {
      scanForActiveStreamers(client).catch(err => {
        logger.error(`[AutoTrack Startup] Unhandled error: ${err.message}`, { category: 'streams' });
      });
    }, 10000);
  }
};
