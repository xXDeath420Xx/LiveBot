/**
 * Wave 378 — guild_live_channel_rules gains `included_user_ids` TEXT. Lets a rule
 * route a specific member's live announcement to a specific channel without
 * inventing a solo role for them (e.g. owner's personal live channel). When set,
 * the rule applies ONLY to those users and skips the role check.
 */
export async function up(pool) {
    const [exists] = await pool.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guild_live_channel_rules' AND COLUMN_NAME = 'included_user_ids'`);
    if (!exists[0].n) {
        await pool.query(`
            ALTER TABLE guild_live_channel_rules
            ADD COLUMN included_user_ids TEXT DEFAULT NULL
        `);
    }
}

export async function down(pool) {
    await pool.query('ALTER TABLE guild_live_channel_rules DROP COLUMN included_user_ids');
}
