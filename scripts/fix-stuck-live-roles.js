import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { deleteAnnouncement } from '../utils/announcer.js';

/**
 * Fix stuck live roles by:
 * 1. Finding stale announcements (>6 hours old with offline_check_count = 0)
 * 2. Deleting the announcements
 * 3. Removing live roles from users who shouldn't have them
 */
async function fixStuckLiveRoles() {
    let connection;
    try {
        connection = await pool.getConnection();

        // Find stale announcements (older than 6 hours with no offline checks)
        const [staleAnnouncements] = await connection.query(`
            SELECT * FROM live_announcements
            WHERE created_at < NOW() - INTERVAL 6 HOUR
            AND offline_check_count = 0
        `);

        logger.info(`[Fix Stuck Roles] Found ${staleAnnouncements.length} stale announcements to clean up`);

        if (staleAnnouncements.length === 0) {
            logger.info('[Fix Stuck Roles] No stale announcements found');
            return;
        }

        let deleted = 0;

        for (const announcement of staleAnnouncements) {
            try {
                // Delete from database only
                // The stream manager will handle role removal on its next check
                await connection.query(
                    'DELETE FROM live_announcements WHERE id = ?',
                    [announcement.id]
                );
                deleted++;

                logger.info(`[Fix Stuck Roles] Deleted announcement for ${announcement.username}`, {
                    platform: announcement.platform,
                    guild: announcement.guild_id,
                    ageHours: Math.floor((Date.now() - new Date(announcement.created_at).getTime()) / 1000 / 3600)
                });
            } catch (error) {
                logger.error(`[Fix Stuck Roles] Error deleting announcement ${announcement.id}:`, {
                    error: error.message
                });
            }
        }

        logger.info(`[Fix Stuck Roles] Cleanup complete. Deleted ${deleted} announcements. Roles will be removed on next stream check.`);

    } catch (error) {
        logger.error('[Fix Stuck Roles] Fatal error:', { error: error.message, stack: error.stack });
    } finally {
        if (connection) connection.release();
        process.exit(0);
    }
}

// Run the fix
fixStuckLiveRoles().catch(error => {
    logger.error('[Fix Stuck Roles] Unhandled error:', error);
    process.exit(1);
});
