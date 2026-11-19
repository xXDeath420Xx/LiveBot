import pool from '../utils/db.js';

/**
 * Soft-sell tier for the commission filter: per-guild sensitivity, plus the decision log the
 * adaptive scoring reads from.
 *
 * The first two tiers match a quoted solicitation, so deleting on a hit is safe. The soft-sell tier
 * infers intent from several weak signals, so it needs somewhere to put the borderline cases in
 * front of a human — and somewhere to record what the human said, which is what lets a repeat
 * advertiser be caught sooner than a first-time poster.
 */
export async function up() {
    const [cols] = await pool.execute('SHOW COLUMNS FROM commission_spam_config');
    const have = new Set(cols.map(c => c.Field));

    const add = async (name, ddl) => {
        if (have.has(name)) return;
        await pool.execute(`ALTER TABLE commission_spam_config ADD COLUMN ${ddl}`);
    };

    // Off by default. Every existing guild opted into a filter that deletes on a quoted
    // solicitation; silently upgrading them to one that deletes on inference would be a different
    // product than the one they enabled.
    await add('soft_sell_enabled', 'soft_sell_enabled TINYINT(1) NOT NULL DEFAULT 0');
    await add('soft_sell_delete_at', 'soft_sell_delete_at TINYINT UNSIGNED NOT NULL DEFAULT 6');
    await add('soft_sell_review_at', 'soft_sell_review_at TINYINT UNSIGNED NOT NULL DEFAULT 4');
    // Where borderline posts go for a decision. Falls back to log_channel_id when unset.
    await add('review_channel_id', 'review_channel_id VARCHAR(20) NULL DEFAULT NULL');
    await add('soft_sell_deleted_count', 'soft_sell_deleted_count INT NOT NULL DEFAULT 0');
    await add('soft_sell_review_count', 'soft_sell_review_count INT NOT NULL DEFAULT 0');

    // One row per soft-sell verdict. 'pending' until a moderator rules on it; auto-deletions land
    // as 'confirmed' with decided_by NULL so they still count toward a user's history.
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS commission_spam_decisions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            message_id VARCHAR(20) NULL,
            review_message_id VARCHAR(20) NULL,
            content MEDIUMTEXT NULL,
            score TINYINT UNSIGNED NOT NULL DEFAULT 0,
            signals VARCHAR(255) NULL,
            verdict ENUM('pending','confirmed','allowed') NOT NULL DEFAULT 'pending',
            decided_by VARCHAR(20) NULL,
            decided_at DATETIME NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_guild_user (guild_id, user_id, verdict),
            INDEX idx_review_msg (review_message_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('[Migration 190] commission soft-sell columns + decisions table ready');
}

export async function down() {
    await pool.execute('DROP TABLE IF EXISTS commission_spam_decisions');
    for (const col of ['soft_sell_enabled', 'soft_sell_delete_at', 'soft_sell_review_at',
                       'review_channel_id', 'soft_sell_deleted_count', 'soft_sell_review_count']) {
        await pool.execute(`ALTER TABLE commission_spam_config DROP COLUMN ${col}`).catch(() => {});
    }
    console.log('[Migration 190] commission soft-sell schema dropped');
}
