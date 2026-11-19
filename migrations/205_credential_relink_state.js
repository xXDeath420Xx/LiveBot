/*
 * Give dead OAuth credentials a terminal state.
 *
 * Both token refreshers retry forever. `instagram_links` and
 * `tokes_platform_connections` record a `last_error` but nothing ever reads it, so a
 * credential the provider has permanently revoked gets retried on every cycle for as
 * long as the row exists — one dead Instagram link was burning 19 refresh attempts a
 * day, and two dead Kick connections 8 more, none of which could ever succeed. Worse,
 * nobody was told to re-link: the failure only existed in the error log.
 *
 * `needs_relink` is that terminal state. Set it when the provider says the grant is
 * gone for good (Instagram "Session has expired" / OAuth 190, Kick `invalid_grant`),
 * and both refreshers skip the row and leave it for a human to reconnect.
 *
 * `token_type` on instagram_links records whether we actually hold a 60-day long-lived
 * token or fell back to the ~1-hour short-lived one. core/instagram-oauth.js's
 * `toLongLived()` returns null when both exchange paths fail, and completeLink then
 * stored the short-lived token anyway, commenting "the refresh job retries the upgrade
 * later" — which it never did, because refreshExpiringTokens only ever called
 * `ig_refresh_token`, and that grant type is only valid on a long-lived token. The
 * result was a link that reported success and was dead inside the hour, with an
 * unrefreshable token that then failed forever. Recording the type lets the refresher
 * attempt the upgrade it was always supposed to.
 */

const COLUMNS = {
    instagram_links: [
        ['needs_relink', "TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Provider revoked this grant; only a fresh user link can fix it'"],
        ['token_type', "VARCHAR(16) NOT NULL DEFAULT 'long_lived' COMMENT 'long_lived (60d) or short_lived (~1h fallback awaiting upgrade)'"],
    ],
    tokes_platform_connections: [
        ['needs_relink', "TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Provider rejected the refresh token; only a fresh user login can fix it'"],
    ],
};

export async function up(db) {
    for (const [table, columns] of Object.entries(COLUMNS)) {
        const [existing] = await db.execute(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = ?`,
            [table],
        );
        if (existing.length === 0) continue; // table doesn't exist here — nothing to do
        const have = new Set(existing.map(c => (c.column_name || c.COLUMN_NAME).toLowerCase()));

        for (const [name, definition] of columns) {
            if (have.has(name)) continue;
            await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
    }

    // Backfill the state we can already prove from the data itself.

    // A token that expired in the past can no longer be refreshed by any grant type —
    // both providers require a still-valid token to renew.
    await db.execute(
        `UPDATE instagram_links SET needs_relink = 1
         WHERE token_expires_at IS NOT NULL AND token_expires_at < NOW()`,
    );

    // A link whose stored token lives less than a day was the short-lived fallback:
    // a real long-lived token is issued with a 60-day window.
    await db.execute(
        `UPDATE instagram_links SET token_type = 'short_lived'
         WHERE token_expires_at IS NOT NULL
           AND linked_at IS NOT NULL
           AND token_expires_at < DATE_ADD(linked_at, INTERVAL 1 DAY)`,
    );

    await db.execute(
        `UPDATE tokes_platform_connections SET needs_relink = 1
         WHERE platform = 'kick' AND expires_at IS NOT NULL AND expires_at < NOW()`,
    );
}

export async function down(db) {
    for (const [table, columns] of Object.entries(COLUMNS)) {
        for (const [name] of columns) {
            const [cols] = await db.execute(
                `SELECT column_name FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
                [table, name],
            );
            if (cols.length) await db.execute(`ALTER TABLE ${table} DROP COLUMN ${name}`);
        }
    }
}
