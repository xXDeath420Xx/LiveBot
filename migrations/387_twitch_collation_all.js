/**
 * Wave 387 — finish what 382 started: every twitch_* table on utf8mb4_unicode_ci. The
 * stragglers broke cross-table queries with "Illegal mix of collations" (custom rewards ×
 * redemptions was silently empty on the analytics page). All are small and FK-free.
 */
const TABLES = [
    'twitch_analytics_alerts_config', 'twitch_analytics_share_tokens', 'twitch_analytics_user_prefs',
    'twitch_backfill_history', 'twitch_banned_summary', 'twitch_chat_notifications',
    'twitch_chat_settings_changes', 'twitch_clip_feeds', 'twitch_clip_seen', 'twitch_custom_rewards',
    'twitch_eventsub_conduit', 'twitch_follower_age_histogram', 'twitch_games_cache', 'twitch_milestones',
    'twitch_schedule_segments', 'twitch_subscriber_breakdown', 'twitch_unban_events', 'twitch_vods_catalog',
];

export async function up(pool) {
    for (const t of TABLES) {
        await pool.query(`ALTER TABLE ${t} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    }
}

export async function down(pool) {
    for (const t of TABLES) {
        await pool.query(`ALTER TABLE ${t} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    }
}
