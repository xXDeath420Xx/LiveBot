/**
 * Wave 406 — better "has this account streamed" evidence on twitch_account_cache.
 *
 * Twitch's API has no last-live field. What it does give, all official Helix with the app token:
 *   has_vod / last_vod_at          newest PAST BROADCAST (type=archive); kept 7–60 days, can be off
 *   has_highlight / last_highlight_at  newest highlight; kept until deleted
 *   has_clip / last_clip_at        a clip of the channel: the most-viewed one from the last 60 days,
 *                                  else from any time. Kept until deleted; clips can only be cut from
 *                                  a stream. Its date is when the clip was made, not a stream date.
 * And from our own polling of /streams every 10 minutes:
 *   live_seen_at / live_started_at last time WE saw the account live, and when that stream began
 *
 * has_vod used to come from /videos with no type (uploads and highlights too); rows are queued for
 * a recheck so it means past broadcasts only.
 */
export async function up(pool) {
    const [cols] = await pool.query(`SHOW COLUMNS FROM twitch_account_cache`);
    const have = new Set(cols.map(c => c.Field));
    const add = [
        ['has_highlight', 'TINYINT NULL DEFAULT NULL'],
        ['last_highlight_at', 'DATETIME NULL DEFAULT NULL'],
        ['has_clip', 'TINYINT NULL DEFAULT NULL'],
        ['last_clip_at', 'DATETIME NULL DEFAULT NULL'],
        ['live_seen_at', 'DATETIME NULL DEFAULT NULL'],
        ['live_started_at', 'DATETIME NULL DEFAULT NULL'],
    ].filter(([c]) => !have.has(c));
    if (add.length) {
        await pool.query(`ALTER TABLE twitch_account_cache ${add.map(([c, t]) => `ADD COLUMN ${c} ${t}`).join(', ')}`);
        await pool.query(`UPDATE twitch_account_cache SET vod_checked_at = NULL`);
    }
}
