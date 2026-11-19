/**
 * Wave 380 — youtube_feeds.ping_role_id (nullable). The feed handler was
 * hardcoded to @everyone which the KK owner rightly flagged as too noisy.
 * NULL = no ping (just the embed), otherwise ping that role.
 */
export async function up(pool) {
    const [exists] = await pool.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'youtube_feeds' AND COLUMN_NAME = 'ping_role_id'`);
    if (!exists[0].n) {
        await pool.query('ALTER TABLE youtube_feeds ADD COLUMN ping_role_id VARCHAR(20) DEFAULT NULL');
    }
}
export async function down(pool) {
    await pool.query('ALTER TABLE youtube_feeds DROP COLUMN ping_role_id');
}
