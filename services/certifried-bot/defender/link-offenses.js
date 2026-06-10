/**
 * Per-user phishing-link offense tracking for the delete+warn → ban-on-repeat
 * escalation. Backed by kbd_link_offenses (migration 115).
 */
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

/**
 * Record an offense and return the new cumulative count for this user.
 * Atomic upsert: first offense inserts count=1, repeats increment.
 */
export async function recordOffense(platform, userId, username, domain) {
    try {
        await pool.execute(
            `INSERT INTO kbd_link_offenses (platform, platform_user_id, username, offense_count, last_domain)
             VALUES (?, ?, ?, 1, ?)
             ON DUPLICATE KEY UPDATE
                offense_count = offense_count + 1,
                username = VALUES(username),
                last_domain = VALUES(last_domain)`,
            [platform, String(userId), username ?? null, domain ?? null]
        );
        const [[row]] = await pool.execute(
            'SELECT offense_count FROM kbd_link_offenses WHERE platform = ? AND platform_user_id = ?',
            [platform, String(userId)]
        );
        return row ? Number(row.offense_count) : 1;
    } catch (error) {
        logger.error('[KBD] Failed to record link offense', { error: error.message });
        // Fail safe toward the lighter action (treat as first offense).
        return 1;
    }
}

export async function getOffenseCount(platform, userId) {
    const [[row]] = await pool.execute(
        'SELECT offense_count FROM kbd_link_offenses WHERE platform = ? AND platform_user_id = ?',
        [platform, String(userId)]
    );
    return row ? Number(row.offense_count) : 0;
}
