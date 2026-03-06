/**
 * Migration 042: Add Twitch user IDs to community support tables
 *
 * Stores the stable numeric Twitch user ID alongside usernames so that
 * identity tracking survives username changes.
 *
 * Also fixes known stale username: exotik_hatchet23 → strangehatchet23
 *
 * Tables modified:
 * - community_twitch_links: adds twitch_user_id VARCHAR(20)
 * - community_support_entries: adds target_twitch_id VARCHAR(20)
 *
 * Backfills IDs from the streamers table where possible.
 */
export async function up(pool) {
    // --- Fix stale username ---
    await pool.execute(
        `UPDATE community_twitch_links SET twitch_username = 'strangehatchet23' WHERE twitch_username = 'exotik_hatchet23'`
    );
    await pool.execute(
        `UPDATE community_support_entries SET target_username = 'strangehatchet23' WHERE target_username = 'exotik_hatchet23'`
    );

    // --- community_twitch_links: add twitch_user_id ---
    const [ctlCols] = await pool.execute('SHOW COLUMNS FROM community_twitch_links');
    const ctlNames = ctlCols.map(c => c.Field);

    if (!ctlNames.includes('twitch_user_id')) {
        await pool.execute(
            'ALTER TABLE community_twitch_links ADD COLUMN twitch_user_id VARCHAR(20) DEFAULT NULL AFTER twitch_username'
        );
        await pool.execute(
            'ALTER TABLE community_twitch_links ADD INDEX idx_twitch_user_id (twitch_user_id)'
        ).catch(() => {}); // index may already exist
    }

    // --- community_support_entries: add target_twitch_id ---
    const [cseCols] = await pool.execute('SHOW COLUMNS FROM community_support_entries');
    const cseNames = cseCols.map(c => c.Field);

    if (!cseNames.includes('target_twitch_id')) {
        await pool.execute(
            'ALTER TABLE community_support_entries ADD COLUMN target_twitch_id VARCHAR(20) DEFAULT NULL AFTER target_username'
        );
        await pool.execute(
            'ALTER TABLE community_support_entries ADD INDEX idx_target_twitch_id (target_twitch_id)'
        ).catch(() => {}); // index may already exist
    }

    // --- Backfill from streamers table ---
    await pool.execute(
        `UPDATE community_twitch_links ctl
         JOIN streamers s ON s.platform = 'twitch' AND LOWER(s.username) = LOWER(ctl.twitch_username)
         SET ctl.twitch_user_id = s.platform_user_id
         WHERE ctl.twitch_user_id IS NULL`
    );

    await pool.execute(
        `UPDATE community_support_entries cse
         JOIN streamers s ON s.platform = 'twitch' AND LOWER(s.username) = LOWER(cse.target_username)
         SET cse.target_twitch_id = s.platform_user_id
         WHERE cse.target_twitch_id IS NULL`
    );
}

export async function down(pool) {
    const [ctlCols] = await pool.execute('SHOW COLUMNS FROM community_twitch_links');
    if (ctlCols.map(c => c.Field).includes('twitch_user_id')) {
        await pool.execute('ALTER TABLE community_twitch_links DROP INDEX idx_twitch_user_id').catch(() => {});
        await pool.execute('ALTER TABLE community_twitch_links DROP COLUMN twitch_user_id');
    }

    const [cseCols] = await pool.execute('SHOW COLUMNS FROM community_support_entries');
    if (cseCols.map(c => c.Field).includes('target_twitch_id')) {
        await pool.execute('ALTER TABLE community_support_entries DROP INDEX idx_target_twitch_id').catch(() => {});
        await pool.execute('ALTER TABLE community_support_entries DROP COLUMN target_twitch_id');
    }

    // Note: username fix (exotik_hatchet23 → strangehatchet23) is not reverted
    // because strangehatchet23 is the correct current username
}
