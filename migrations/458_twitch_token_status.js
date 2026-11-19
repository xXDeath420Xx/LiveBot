/**
 * Migration 458 — Twitch token status for the hourly validation (H-751, core/twitch-token-validator.js).
 *
 * Twitch asks apps to validate user tokens hourly. When a token is refused and its refresh token is refused too,
 * the grant is marked so the pages ask the streamer to reconnect. Two tables had no column for that:
 *
 *   twitch_role_sync_config  broadcaster_token_status  the server analytics grant   active | needs_reauth
 *                            tier_b_token_status       the server write grant       active | needs_reauth
 *   twitch_oauth_accounts    token_status              the "Link Twitch" identity   active | needs_reauth
 *
 * (stream_bot_twitch_grants.status, stream_platform_accounts.status and tokes_platform_connections.needs_relink already
 * exist.) Connecting again sets the status back to active. No personal data is added, so no retention or privacy change.
 * Idempotent: ADD COLUMN IF NOT EXISTS.
 */
export async function up(db) {
    await db.query(`ALTER TABLE twitch_role_sync_config
        ADD COLUMN IF NOT EXISTS broadcaster_token_status VARCHAR(20) NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS tier_b_token_status VARCHAR(20) NOT NULL DEFAULT 'active'`);
    await db.query(`ALTER TABLE twitch_oauth_accounts
        ADD COLUMN IF NOT EXISTS token_status VARCHAR(20) NOT NULL DEFAULT 'active'`);
}

export async function down(db) {
    await db.query('ALTER TABLE twitch_role_sync_config DROP COLUMN IF EXISTS broadcaster_token_status, DROP COLUMN IF EXISTS tier_b_token_status');
    await db.query('ALTER TABLE twitch_oauth_accounts DROP COLUMN IF EXISTS token_status');
}
