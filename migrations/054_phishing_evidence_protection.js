/**
 * Migration 054: Phishing Evidence Protection
 *
 * Adds exempt_channels and report_channel_id to phishing_config
 * so the phishing system can distinguish evidence posts from scams.
 */
export async function up(pool) {
    await pool.execute(`
        ALTER TABLE phishing_config
        ADD COLUMN exempt_channels TEXT DEFAULT NULL
        COMMENT 'JSON array of channel IDs exempt from phishing detection'
    `);

    await pool.execute(`
        ALTER TABLE phishing_config
        ADD COLUMN report_channel_id VARCHAR(20) DEFAULT NULL
        COMMENT 'Channel to forward suspected evidence posts to'
    `);
}

export async function down(pool) {
    await pool.execute('ALTER TABLE phishing_config DROP COLUMN exempt_channels');
    await pool.execute('ALTER TABLE phishing_config DROP COLUMN report_channel_id');
}
