import pool from '../utils/db.js';
import logger from '../utils/logger.js';

// This script will be imported and run with the bot client
async function autoLinkAllDiscordIds(client) {
    logger.info('[Auto-Link] Starting manual Discord ID auto-linking for all streamers...', { category: 'auto-link' });

    let connection;
    try {
        connection = await pool.getConnection();

        // Get all streamers without Discord IDs
        const [unlinkedStreamers] = await connection.execute(
            `SELECT DISTINCT s.streamer_id, s.username, s.platform, sub.guild_id
             FROM streamers s
             JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
             WHERE s.discord_user_id IS NULL
             ORDER BY sub.guild_id, s.username`
        );

        logger.info(`[Auto-Link] Found ${unlinkedStreamers.length} unlinked streamers across all guilds`, { category: 'auto-link' });

        let totalLinked = 0;
        const guildsProcessed = new Set();

        for (const streamer of unlinkedStreamers) {
            try {
                const guild = client.guilds.cache.get(streamer.guild_id);
                if (!guild) {
                    logger.warn(`[Auto-Link] Guild ${streamer.guild_id} not found or bot not in guild`, { category: 'auto-link' });
                    continue;
                }

                // Fetch all members if we haven't for this guild yet
                if (!guildsProcessed.has(streamer.guild_id)) {
                    logger.info(`[Auto-Link] Fetching members for guild ${streamer.guild_id}...`, { category: 'auto-link' });
                    await guild.members.fetch();
                    guildsProcessed.add(streamer.guild_id);
                }

                // Method 1: Check if Discord username matches streamer username (case-insensitive)
                const matchingMember = guild.members.cache.find(member =>
                    member.user.username.toLowerCase() === streamer.username.toLowerCase()
                );

                if (matchingMember) {
                    const discordId = matchingMember.user.id;

                    // Update the streamer
                    const [result] = await connection.execute(
                        'UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?',
                        [discordId, streamer.streamer_id]
                    );

                    if (result.affectedRows > 0) {
                        totalLinked++;
                        logger.info(`[Auto-Link] ✓ Linked ${streamer.username} (${streamer.platform}) to Discord user ${matchingMember.user.username} (${discordId}) in guild ${streamer.guild_id}`, { category: 'auto-link' });
                    }
                }
            } catch (error) {
                logger.error(`[Auto-Link] Error processing ${streamer.username}:`, { error, category: 'auto-link' });
            }
        }

        logger.info(`[Auto-Link] ✅ Completed! Successfully auto-linked ${totalLinked} streamers to Discord users across ${guildsProcessed.size} guilds.`, { category: 'auto-link' });
        return { success: true, linked: totalLinked, guilds: guildsProcessed.size };

    } catch (error) {
        logger.error('[Auto-Link] CRITICAL ERROR during auto-linking:', { error, category: 'auto-link' });
        return { success: false, error: error.message };
    } finally {
        if (connection) connection.release();
    }
}

export { autoLinkAllDiscordIds };
