/*
 * Stream bot, YouTube: what /privacy exports and deletes for a streamer (design §13.7). Called from core/stream-bot/privacy.js.
 *
 *   stream_bot_youtube_live   the channel's live state (broadcast id, chat id, last page token, title, times, last error).
 *                             No viewer data. Exported as the streamer; deleted with the profile (FK cascade, counted first).
 *   stream_bot_youtube_quota  YouTube units spent per day and profile (no viewer data); 30 days, then the retention sweep.
 *   stream_platform_accounts  the YouTube sign-in row (platform 'youtube'): exported without its tokens; deleted on /privacy
 *                             delete (which also removes a YouTube multicast destination that used it, by its FK), and on
 *                             "Unlink" of the YouTube channel when no multicast destination uses it (youtubeAccountDelete
 *                             with onlyUnused). The refresh token is revoked at Google first when encryption is given.
 *
 * YouTube viewers' own data (events, viewer records, {db:} values) lives in the shared stream bot tables under platform
 * 'youtube' and is covered there (store.exportViewer / deleteViewer, viewers/privacy.js) for a YouTube account linked to
 * CertiFried or signed in on /privacy/viewer.
 */

const missing = (err) => err?.code === 'ER_NO_SUCH_TABLE';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export async function youtubeExport(db, profileId, prefix = 'stream_bot_') {
    const out = {};
    if (!db || !profileId) return out;
    try {
        const [rows] = await db.query(`SELECT channel_id, broadcast_id, title, status, transport, started_at, ended_at, last_check_at, last_message_at, error, updated_at
            FROM \`${prefix}youtube_live\` WHERE profile_id = ?`, [profileId]);
        if (rows.length) out.youtube_live = rows;
    } catch (err) { if (!missing(err)) throw err; }
    try {
        const [rows] = await db.query(`SELECT day, units, calls FROM \`${prefix}youtube_quota\` WHERE profile_id = ? ORDER BY day DESC LIMIT 60`, [profileId]);
        if (rows.length) out.youtube_quota = rows;
    } catch (err) { if (!missing(err)) throw err; }
    return out;
}

export async function youtubeDelete(db, profileId, prefix = 'stream_bot_') {
    const out = {};
    if (!db || !profileId) return out;
    for (const t of ['youtube_live', 'youtube_quota']) {
        try {
            const [r] = await db.query(`DELETE FROM \`${prefix}${t}\` WHERE profile_id = ?`, [profileId]);
            if (r?.affectedRows) out[`${prefix}${t}`] = r.affectedRows;
        } catch (err) { if (!missing(err)) throw err; }
    }
    return out;
}

/** The YouTube sign-in on file, without tokens. */
export async function youtubeAccountExport(db, ownerId, { table = 'stream_platform_accounts' } = {}) {
    try {
        const [rows] = await db.query(`SELECT platform_user_id AS channel_id, platform_username AS channel_name, scopes, status, expires_at, created_at
            FROM \`${table}\` WHERE owner_discord_id = ? AND platform = 'youtube'`, [String(ownerId)]);
        return rows;
    } catch (err) {
        if (missing(err)) return [];
        throw err;
    }
}

/**
 * Remove the YouTube sign-in. onlyUnused: leave it when a multicast destination still uses it. revoke: tell Google first
 * (best effort; needs `encryption` to read the stored token and `fetchImpl`).
 * → { stream_platform_accounts: n } (empty when nothing was removed)
 */
export async function youtubeAccountDelete(db, ownerId, { onlyUnused = false, revoke = false, encryption = null, fetchImpl = (...a) => globalThis.fetch(...a), table = 'stream_platform_accounts', destinations = 'stream_destinations' } = {}) {
    let rows;
    try {
        [rows] = await db.query(`SELECT id, access_token, refresh_token FROM \`${table}\` WHERE owner_discord_id = ? AND platform = 'youtube'`, [String(ownerId)]);
    } catch (err) {
        if (missing(err)) return {};
        throw err;
    }
    const row = rows[0];
    if (!row) return {};
    if (onlyUnused) {
        try {
            const [d] = await db.query(`SELECT COUNT(*) AS n FROM \`${destinations}\` WHERE account_id = ?`, [row.id]);
            if (Number(d[0]?.n) > 0) return {};
        } catch (err) { if (!missing(err)) throw err; }
    }
    if (revoke && encryption) {
        let token = null;
        for (const v of [row.refresh_token, row.access_token]) {
            if (token || !v) continue;
            try { token = encryption.decrypt(JSON.parse(v)); } catch { token = null; }
        }
        if (token) {
            try {
                await fetchImpl(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(8000) });
            } catch { /* Google may be unreachable; our copy is deleted either way */ }
        }
    }
    const [r] = await db.query(`DELETE FROM \`${table}\` WHERE id = ?`, [row.id]);
    return r?.affectedRows ? { [table]: r.affectedRows } : {};
}

export default { youtubeExport, youtubeDelete, youtubeAccountExport, youtubeAccountDelete };
