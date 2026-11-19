/*
 * Retire Trovo.
 *
 * Trovo (Tencent) shut its live-streaming service down on 2026-06-30: new-streamer
 * onboarding and subscription purchases closed 2026-04-01, and the live module
 * itself went dark at 00:00 GMT+8 on 2026-06-30. trovo.live no longer serves
 * channel pages, and open-api.trovo.live no longer answers, so every Trovo check
 * the bot made after that date was guaranteed to return "not live" — a per-cycle
 * HTTP failure (core/stream-manager.js) and, in the announcement updater, a
 * 45-second Playwright page load that could never succeed.
 *
 * All Trovo platform code is deleted in the same change as this migration. This
 * migration removes the data that would otherwise be orphaned by that deletion:
 *
 *   1. `streamers` rows on platform='trovo', plus their `subscriptions`. Without
 *      this, stream-manager keeps loading them every cycle and logs the
 *      "unsupported platform" warning forever (it warns once per platform, so
 *      the noise is bounded, but the rows are still fetched and iterated).
 *   2. `live_announcements` on platform='trovo' — none exist today, but a stale
 *      PENDING row would keep `reserveAnnouncementSlot` blocked on a UNIQUE key
 *      nothing can ever release.
 *   3. 'trovo' entries inside `self_promo_config.allowed_platforms`, which is a
 *      JSON array of platform slugs. Leaving it there advertises Trovo on
 *      self-promo panels and makes the handler accept a link that
 *      utils/stream-url-parser.js can no longer parse.
 *
 * Deliberately irreversible: down() is a no-op. The deleted rows point at a
 * platform that does not exist, so "restoring" them would only recreate broken
 * subscriptions. Roll back the code, not the data.
 */

export async function up(db) {
    // Subscriptions first — they FK/point at streamer_id.
    await db.execute(
        `DELETE s FROM subscriptions s
         JOIN streamers st ON st.streamer_id = s.streamer_id
         WHERE st.platform = 'trovo'`,
    );

    await db.execute(`DELETE FROM live_announcements WHERE platform = 'trovo'`);

    await db.execute(`DELETE FROM streamers WHERE platform = 'trovo'`);

    // allowed_platforms is a JSON array of slugs. JSON_REMOVE needs the index of
    // the element, so resolve it per row rather than trying to do it in one UPDATE.
    const [cfgs] = await db.execute(
        `SELECT guild_id, allowed_platforms FROM self_promo_config
         WHERE allowed_platforms LIKE '%trovo%'`,
    );
    for (const cfg of cfgs) {
        let list;
        try {
            list = typeof cfg.allowed_platforms === 'string'
                ? JSON.parse(cfg.allowed_platforms)
                : cfg.allowed_platforms;
        } catch {
            continue; // not JSON we understand — leave it for a human
        }
        if (!Array.isArray(list)) continue;

        const cleaned = list.filter(p => String(p).toLowerCase() !== 'trovo');
        if (cleaned.length === list.length) continue;

        await db.execute(
            `UPDATE self_promo_config SET allowed_platforms = ? WHERE guild_id = ?`,
            [JSON.stringify(cleaned), cfg.guild_id],
        );
    }
}

export async function down() {
    // Intentionally empty — see the header. The platform is gone; the rows are not
    // worth resurrecting.
}
