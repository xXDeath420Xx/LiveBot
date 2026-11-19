import pool from '../utils/db.js';

/**
 * Separate "when did we last verify affiliate status" from "when did we last touch this row".
 *
 * community_twitch_links is written by two very different kinds of code:
 *   - identity writers (presenceUpdate, the dashboard link flows) that only know
 *     discord_user_id <-> twitch_username, and leave is_affiliate at its DEFAULT 0
 *   - affiliate checkers (community-support-manager, affiliate-recheck-scheduler)
 *     that actually ask Twitch for broadcaster_type
 *
 * Both stamped last_checked = NOW(), so an identity write made an unverified
 * is_affiliate = 0 look freshly verified. checkAffiliateStatus honoured that for 24h
 * and never called the API — and because presence re-stamps the row every time the
 * member goes live, the row never aged out. Regular streamers (i.e. the affiliates)
 * were pinned to non-affiliate indefinitely.
 *
 * affiliate_checked_at is set ONLY by code that has actually read broadcaster_type.
 * NULL means "never verified" and forces a real API check, so identity writes can no
 * longer fake freshness.
 */
export async function up() {
    const [cols] = await pool.execute(`SHOW COLUMNS FROM community_twitch_links LIKE 'affiliate_checked_at'`);
    if (cols.length === 0) {
        await pool.execute(
            `ALTER TABLE community_twitch_links
             ADD COLUMN affiliate_checked_at DATETIME NULL DEFAULT NULL AFTER is_affiliate`
        );
    }

    // Every existing row predates the distinction, so none of them can be trusted as
    // verified — leaving affiliate_checked_at NULL re-checks them all on next use.
    // Rows already marked affiliate were only ever set that way by a real API read,
    // so those keep a verified timestamp and don't need to re-check immediately.
    await pool.execute(
        `UPDATE community_twitch_links
         SET affiliate_checked_at = last_checked
         WHERE is_affiliate = 1 AND affiliate_checked_at IS NULL`
    );

    console.log('[Migration 189] community_twitch_links.affiliate_checked_at added');
}

export async function down() {
    await pool.execute('ALTER TABLE community_twitch_links DROP COLUMN affiliate_checked_at');
    console.log('[Migration 189] community_twitch_links.affiliate_checked_at dropped');
}
