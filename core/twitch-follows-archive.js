/*
 * twitch_user_follows (H-762): historical data, no longer collected.
 *
 * On 2026-10-28 the Twitch analytics grant read /channels/followed under user:read:follows for two broadcasters
 * (100 followed channels each). CertiFried no longer requests that scope (owner rule, tests/twitch-scope-rules.test.js)
 * and nothing writes the table any more. The owner chose to keep the rows, under the same rules as other data:
 *   - /privacy export and delete, keyed to the broadcaster it belongs to (follower_id = the broadcaster's Twitch user
 *     id), through the Twitch accounts linked to the member's Discord account (core/privacy-manager.js) or a Twitch
 *     sign-in on /privacy/viewer (dashboard/routes/privacy-viewer.js);
 *   - retention: data_retention_policy row (migration 462) with a sweep guard in jobs/retention-sweeper.js that only
 *     removes a broadcaster's rows once they have no CertiFried Twitch connection left;
 *   - shown read-only to that broadcaster's servers on the Twitch analytics page ("Channels you followed").
 * Never re-collect it.
 *
 *   followsExport(db, twitchIds) → rows[]          followsDelete(db, twitchIds) → count
 *   followsOf(db, twitchId, { limit }) → rows[]      COLLECTED_ON
 */
export const COLLECTED_ON = '2026-10-28';
const ID = /^\d{1,20}$/;
const ids = (list) => [...new Set((list || []).map((x) => String(x ?? '').trim()).filter((x) => ID.test(x)))];

export async function followsExport(db, twitchIds, { table = 'twitch_user_follows' } = {}) {
    const list = ids(twitchIds);
    if (!list.length) return [];
    try {
        const [rows] = await db.query(
            `SELECT follower_id, broadcaster_id, broadcaster_login, broadcaster_name, followed_at, updated_at AS collected_at
               FROM \`${table}\` WHERE follower_id IN (?) ORDER BY follower_id, followed_at DESC`, [list]);
        return rows;
    } catch { return []; /* table missing */ }
}

export async function followsDelete(db, twitchIds, { table = 'twitch_user_follows' } = {}) {
    const list = ids(twitchIds);
    if (!list.length) return 0;
    try {
        const [r] = await db.query(`DELETE FROM \`${table}\` WHERE follower_id IN (?)`, [list]);
        return r.affectedRows || 0;
    } catch { return 0; }
}

/** One broadcaster's followed channels, newest follow first (read-only display). */
export async function followsOf(db, twitchId, { limit = 100, table = 'twitch_user_follows' } = {}) {
    const [id] = ids([twitchId]);
    if (!id) return [];
    const n = Math.min(500, Math.max(1, Number(limit) || 100));
    try {
        const [rows] = await db.query(
            `SELECT broadcaster_id, broadcaster_login, broadcaster_name, followed_at FROM \`${table}\`
              WHERE follower_id = ? ORDER BY followed_at DESC LIMIT ${n}`, [id]);
        return rows;
    } catch { return []; }
}

export default { followsExport, followsDelete, followsOf, COLLECTED_ON };
