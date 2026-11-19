/**
 * Wave 391 — public profile facts and removal tracking for accounts seen in chat, plus the date an
 * account was first found on the known-bot list. Lets the integrity report say how hollow listed
 * accounts are and how many Twitch has since suspended or deleted.
 */
export async function up(pool) {
    await pool.query(`
        ALTER TABLE twitch_account_cache
            ADD COLUMN IF NOT EXISTS profile_default TINYINT(1) NULL,
            ADD COLUMN IF NOT EXISTS has_bio TINYINT(1) NULL,
            ADD COLUMN IF NOT EXISTS broadcaster_type VARCHAR(16) NULL,
            ADD COLUMN IF NOT EXISTS gone_at DATETIME NULL,
            ADD COLUMN IF NOT EXISTS has_vod TINYINT(1) NULL,
            ADD COLUMN IF NOT EXISTS last_vod_at DATETIME NULL,
            ADD COLUMN IF NOT EXISTS vod_checked_at DATETIME NULL`);
    await pool.query(`ALTER TABLE twitch_known_bot_checks ADD COLUMN IF NOT EXISTS first_listed_at DATETIME NULL`);
    await pool.query(`UPDATE twitch_known_bot_checks SET first_listed_at = checked_at WHERE listed = 1 AND first_listed_at IS NULL`);
}

export async function down(pool) {
    await pool.query(`
        ALTER TABLE twitch_account_cache
            DROP COLUMN IF EXISTS profile_default, DROP COLUMN IF EXISTS has_bio, DROP COLUMN IF EXISTS broadcaster_type,
            DROP COLUMN IF EXISTS gone_at, DROP COLUMN IF EXISTS has_vod, DROP COLUMN IF EXISTS last_vod_at,
            DROP COLUMN IF EXISTS vod_checked_at`);
    await pool.query(`ALTER TABLE twitch_known_bot_checks DROP COLUMN IF EXISTS first_listed_at`);
}
