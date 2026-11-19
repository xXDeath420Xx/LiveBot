/*
 * Stream bot music: every database read and write (tables from migrations/457_stream_bot_music.js, plus the
 * stream rows of music_play_log from migration 256 as extended by 457).
 *
 *   createMusicStore({ db, prefix = 'stream_bot_', playLogTable = 'music_play_log' })
 *
 * Every query carries profile_id. Tests use throwaway tables (musicDdl(prefix)) and a throwaway copy of the play log.
 */
const ACTIVE = ['pending', 'queued', 'playing'];
const COUNTED = ['queued', 'playing', 'played'];   // what stats count: requests that went ahead
export const PLAYLIST_MAX_ITEMS = 2000;
export const PLAYLISTS_MAX = 50;

const clip = (s, n) => (s == null ? null : String(s).slice(0, n));
const bool = (v) => (v == null ? null : v ? 1 : 0);

export function requestRow(r) {
    return r && {
        id: Number(r.id), profileId: Number(r.profile_id), platform: r.platform, viewerId: r.viewer_id, viewerLogin: r.viewer_login,
        viewerName: r.viewer_name, source: r.source, input: r.input, title: r.title, artist: r.artist || '', url: r.url, trackKey: r.track_key,
        durationMs: r.duration_ms == null ? null : Number(r.duration_ms), explicit: r.explicit == null ? null : !!r.explicit,
        thumbnail: r.thumbnail, playlistName: r.playlist_name, status: r.status, reason: r.reason, decidedBy: r.decided_by,
        playLogId: r.play_log_id == null ? null : Number(r.play_log_id), createdAt: r.created_at, decidedAt: r.decided_at,
        startedAt: r.started_at, finishedAt: r.finished_at,
    };
}
const itemRow = (r) => r && {
    id: Number(r.id), playlistId: Number(r.playlist_id), position: Number(r.position), trackKey: r.track_key, title: r.title, artist: r.artist || '',
    url: r.url, source: r.source, durationMs: r.duration_ms == null ? null : Number(r.duration_ms), explicit: r.explicit == null ? null : !!r.explicit,
    thumbnail: r.thumbnail, addedBy: r.added_by, createdAt: r.created_at,
};
const playlistRow = (r) => r && { id: Number(r.id), name: r.name, kind: r.kind, sourceUrl: r.source_url, items: r.items == null ? undefined : Number(r.items), createdAt: r.created_at, updatedAt: r.updated_at };

export function createMusicStore({ db, prefix = 'stream_bot_', playLogTable = 'music_play_log' } = {}) {
    if (!db) throw new Error('createMusicStore needs a db pool');
    if (!/^[a-z0-9_]{1,30}$/.test(prefix) || !/^[a-z0-9_]{1,64}$/.test(playLogTable)) throw new Error('bad table name');
    const T = (n) => `\`${prefix}${n}\``;
    const PL = `\`${playLogTable}\``;
    const q = async (sql, params = []) => (await db.query(sql, params))[0];
    const inList = (list) => list.map(() => '?').join(', ');

    const s = {
        prefix,

        // ── requests ──
        async insertRequest(profileId, r) {
            const res = await q(`INSERT INTO ${T('music_requests')} (profile_id, platform, viewer_id, viewer_login, viewer_name, source, input, title, artist, url, track_key,
                                 duration_ms, explicit, thumbnail, playlist_name, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [profileId, clip(r.platform || 'dashboard', 16), clip(r.viewerId, 64), clip(r.viewerLogin, 100), clip(r.viewerName, 100), clip(r.source || 'other', 16),
                    clip(r.input, 300), clip(r.title || 'Unknown', 300), clip(r.artist, 300), clip(r.url, 600), clip(r.trackKey, 191),
                    r.durationMs == null ? null : Math.max(0, Math.round(r.durationMs)), bool(r.explicit), clip(r.thumbnail, 600), clip(r.playlistName, 150),
                    r.status || 'queued', clip(r.reason, 160)]);
            return Number(res.insertId);
        },
        async getRequest(profileId, id) {
            return requestRow((await q(`SELECT * FROM ${T('music_requests')} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0]);
        },
        /** pending / queued / playing, oldest first. */
        async activeRequests(profileId) {
            return (await q(`SELECT * FROM ${T('music_requests')} WHERE profile_id = ? AND status IN (${inList(ACTIVE)}) ORDER BY id LIMIT 1000`, [profileId, ...ACTIVE])).map(requestRow);
        },
        async requestsWithStatus(profileId, status, limit = 500) {
            return (await q(`SELECT * FROM ${T('music_requests')} WHERE profile_id = ? AND status = ? ORDER BY id LIMIT ${Math.min(1000, Math.max(1, Number(limit) || 500))}`, [profileId, status])).map(requestRow);
        },
        async nextQueued(profileId) {
            return requestRow((await q(`SELECT * FROM ${T('music_requests')} WHERE profile_id = ? AND status = 'queued' ORDER BY id LIMIT 1`, [profileId]))[0]);
        },
        async setRequestStatus(profileId, id, status, { reason, decidedBy, playLogId, started, finished, decided } = {}) {
            const sets = ['status = ?'];
            const params = [status];
            if (reason !== undefined) { sets.push('reason = ?'); params.push(clip(reason, 160)); }
            if (decidedBy !== undefined) { sets.push('decided_by = ?'); params.push(clip(decidedBy, 100)); }
            if (playLogId !== undefined) { sets.push('play_log_id = ?'); params.push(playLogId); }
            if (decided) sets.push('decided_at = NOW()');
            if (started) sets.push('started_at = NOW()');
            if (finished) sets.push('finished_at = NOW()');
            return (await q(`UPDATE ${T('music_requests')} SET ${sets.join(', ')} WHERE profile_id = ? AND id = ?`, [...params, profileId, id])).affectedRows > 0;
        },
        /** Requests left 'playing' by a restart are finished; returns how many. */
        async closePlaying(profileId = null) {
            return (await q(`UPDATE ${T('music_requests')} SET status = 'played', finished_at = COALESCE(finished_at, NOW()) WHERE status = 'playing'${profileId ? ' AND profile_id = ?' : ''}`, profileId ? [profileId] : [])).affectedRows;
        },
        async history(profileId, { before = null, limit = 50, status = '' } = {}) {
            const where = ['profile_id = ?'];
            const params = [profileId];
            if (before) { where.push('id < ?'); params.push(Number(before)); }
            if (status) { where.push('status = ?'); params.push(String(status)); }
            const n = Math.min(200, Math.max(1, Number(limit) || 50));
            return (await q(`SELECT * FROM ${T('music_requests')} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${n}`, params)).map(requestRow);
        },
        /** For the stats: requests that went ahead, newest first (bounded). */
        async countedRequests(profileId, { platform = null, viewerId = null, limit = 5000 } = {}) {
            const where = ['profile_id = ?', `status IN (${inList(COUNTED)})`];
            const params = [profileId, ...COUNTED];
            if (platform && viewerId) { where.push('platform = ? AND viewer_id = ?'); params.push(platform, String(viewerId)); }
            return (await q(`SELECT title, artist, track_key, url FROM ${T('music_requests')} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${Math.min(20000, Number(limit) || 5000)}`, params));
        },

        // ── bans ──
        async listBans(profileId) {
            return (await q(`SELECT * FROM ${T('music_bans')} WHERE profile_id = ? ORDER BY id`, [profileId]))
                .map((r) => ({ id: Number(r.id), kind: r.kind, ref: r.ref, title: r.title, artist: r.artist || '', url: r.url, createdBy: r.created_by, createdAt: r.created_at }));
        },
        async addBan(profileId, { kind, ref, title = null, artist = null, url = null, createdBy = null }) {
            await q(`INSERT INTO ${T('music_bans')} (profile_id, kind, ref, title, artist, url, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE title = COALESCE(VALUES(title), title), artist = COALESCE(VALUES(artist), artist)`,
                [profileId, kind === 'artist' ? 'artist' : 'track', clip(ref, 191), clip(title, 300), clip(artist, 300), clip(url, 600), clip(createdBy, 100)]);
        },
        async removeBan(profileId, id) {
            return (await q(`DELETE FROM ${T('music_bans')} WHERE profile_id = ? AND id = ?`, [profileId, id])).affectedRows > 0;
        },
        /** The ban that applies to a song (its key, or its first artist), or null. */
        async banFor(profileId, trackKey, artistNorm) {
            const r = (await q(`SELECT * FROM ${T('music_bans')} WHERE profile_id = ? AND ((kind = 'track' AND ref = ?) OR (kind = 'artist' AND ref = ?)) LIMIT 1`,
                [profileId, String(trackKey || ''), String(artistNorm || '\u0000')]))[0];
            return r ? { id: Number(r.id), kind: r.kind, ref: r.ref, title: r.title, artist: r.artist } : null;
        },

        // ── likes ──
        async addLike(profileId, { platform, viewerId, viewerName, trackKey, title, artist, url }) {
            const r = await q(`INSERT IGNORE INTO ${T('music_likes')} (profile_id, platform, viewer_id, viewer_name, track_key, title, artist, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [profileId, clip(platform, 16), clip(viewerId, 64), clip(viewerName, 100), clip(trackKey, 191), clip(title, 300), clip(artist, 300), clip(url, 600)]);
            return r.affectedRows > 0;
        },
        async removeLike(profileId, platform, viewerId, trackKey) {
            return (await q(`DELETE FROM ${T('music_likes')} WHERE profile_id = ? AND platform = ? AND viewer_id = ? AND track_key = ?`, [profileId, platform, String(viewerId), trackKey])).affectedRows > 0;
        },
        async viewerLikes(profileId, platform, viewerId) {
            return q(`SELECT track_key, title, artist FROM ${T('music_likes')} WHERE profile_id = ? AND platform = ? AND viewer_id = ? ORDER BY id DESC LIMIT 500`, [profileId, platform, String(viewerId)]);
        },
        async likesFor(profileId, trackKey) {
            return (await q(`SELECT viewer_name FROM ${T('music_likes')} WHERE profile_id = ? AND track_key = ? ORDER BY id LIMIT 200`, [profileId, trackKey])).map((r) => r.viewer_name).filter(Boolean);
        },

        // ── playlists ──
        async listPlaylists(profileId) {
            return (await q(`SELECT p.*, (SELECT COUNT(*) FROM ${T('music_playlist_items')} i WHERE i.playlist_id = p.id) AS items
                              FROM ${T('music_playlists')} p WHERE p.profile_id = ? ORDER BY p.kind = 'liked' DESC, p.name`, [profileId])).map(playlistRow);
        },
        async getPlaylist(profileId, id) {
            return playlistRow((await q(`SELECT * FROM ${T('music_playlists')} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0]);
        },
        async createPlaylist(profileId, { name, kind = 'custom', sourceUrl = null }) {
            const [n] = await q(`SELECT COUNT(*) AS n FROM ${T('music_playlists')} WHERE profile_id = ?`, [profileId]);
            if (Number(n.n) >= PLAYLISTS_MAX) return { ok: false, error: 'limit' };
            try {
                const r = await q(`INSERT INTO ${T('music_playlists')} (profile_id, name, kind, source_url) VALUES (?, ?, ?, ?)`, [profileId, clip(name, 100), kind, clip(sourceUrl, 600)]);
                return { ok: true, id: Number(r.insertId) };
            } catch (err) {
                if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) return { ok: false, error: 'exists' };
                throw err;
            }
        },
        async deletePlaylist(profileId, id) {
            return (await q(`DELETE FROM ${T('music_playlists')} WHERE profile_id = ? AND id = ?`, [profileId, id])).affectedRows > 0;
        },
        /** The streamer's liked list (made on first use). */
        async likedPlaylist(profileId) {
            const r = (await q(`SELECT * FROM ${T('music_playlists')} WHERE profile_id = ? AND kind = 'liked' LIMIT 1`, [profileId]))[0];
            if (r) return playlistRow(r);
            await q(`INSERT IGNORE INTO ${T('music_playlists')} (profile_id, name, kind) VALUES (?, 'Liked songs', 'liked')`, [profileId]);
            return playlistRow((await q(`SELECT * FROM ${T('music_playlists')} WHERE profile_id = ? AND kind = 'liked' LIMIT 1`, [profileId]))[0]);
        },
        async playlistItems(profileId, playlistId, { limit = 500, offset = 0 } = {}) {
            return (await q(`SELECT * FROM ${T('music_playlist_items')} WHERE profile_id = ? AND playlist_id = ? ORDER BY position, id LIMIT ${Math.min(PLAYLIST_MAX_ITEMS, Math.max(1, Number(limit) || 500))} OFFSET ${Math.max(0, Number(offset) || 0)}`,
                [profileId, playlistId])).map(itemRow);
        },
        /** Add songs; existing ones (same key) are left alone. Returns { added, full }. */
        async addPlaylistItems(profileId, playlistId, items, addedBy = null) {
            const [row] = await q(`SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS pos FROM ${T('music_playlist_items')} WHERE playlist_id = ?`, [playlistId]);
            let count = Number(row.n), pos = Number(row.pos), added = 0;
            for (const it of items) {
                if (count >= PLAYLIST_MAX_ITEMS) return { added, full: true };
                const r = await q(`INSERT IGNORE INTO ${T('music_playlist_items')} (playlist_id, profile_id, position, track_key, title, artist, url, source, duration_ms, explicit, thumbnail, added_by)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [playlistId, profileId, pos + 1, clip(it.trackKey, 191), clip(it.title || 'Unknown', 300), clip(it.artist, 300), clip(it.url, 600), clip(it.source || 'other', 16),
                        it.durationMs == null ? null : Math.max(0, Math.round(it.durationMs)), bool(it.explicit), clip(it.thumbnail, 600), clip(addedBy, 100)]);
                if (r.affectedRows) { added++; count++; pos++; }
            }
            await q(`UPDATE ${T('music_playlists')} SET updated_at = NOW() WHERE id = ?`, [playlistId]);
            return { added, full: false };
        },
        async removePlaylistItem(profileId, itemId) {
            return (await q(`DELETE FROM ${T('music_playlist_items')} WHERE profile_id = ? AND id = ?`, [profileId, itemId])).affectedRows > 0;
        },
        async playlistHas(profileId, playlistId, trackKey) {
            return (await q(`SELECT 1 FROM ${T('music_playlist_items')} WHERE profile_id = ? AND playlist_id = ? AND track_key = ? LIMIT 1`, [profileId, playlistId, trackKey])).length > 0;
        },
        /** One random song of a playlist, avoiding the keys just played when it can. */
        async randomItem(profileId, playlistId, avoidKeys = []) {
            const avoid = avoidKeys.filter(Boolean).slice(0, 50);
            const extra = avoid.length ? ` AND track_key NOT IN (${inList(avoid)})` : '';
            let r = (await q(`SELECT * FROM ${T('music_playlist_items')} WHERE profile_id = ? AND playlist_id = ?${extra} ORDER BY RAND() LIMIT 1`, [profileId, playlistId, ...avoid]))[0];
            if (!r && avoid.length) r = (await q(`SELECT * FROM ${T('music_playlist_items')} WHERE profile_id = ? AND playlist_id = ? ORDER BY RAND() LIMIT 1`, [profileId, playlistId]))[0];
            return itemRow(r);
        },
        /** Songs in any of the profile's playlists matching a key, or (by words) a title / artist. */
        async findInPlaylists(profileId, { trackKey = null, words = null } = {}) {
            if (trackKey) return itemRow((await q(`SELECT * FROM ${T('music_playlist_items')} WHERE profile_id = ? AND track_key = ? LIMIT 1`, [profileId, trackKey]))[0]);
            const list = String(words || '').split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
            if (!list.length) return null;
            const like = (w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            const cond = list.map(() => '(title LIKE ? OR artist LIKE ?)').join(' AND ');
            return itemRow((await q(`SELECT * FROM ${T('music_playlist_items')} WHERE profile_id = ? AND ${cond} LIMIT 1`, [profileId, ...list.flatMap((w) => [like(w), like(w)])]))[0]);
        },

        // ── play log (music_play_log, context 'stream') ──
        async insertPlay(row) {
            try {
                const cols = Object.keys(row);
                const r = await q(`INSERT INTO ${PL} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
                return Number(r.insertId);
            } catch { return null; }   // best effort, as for Discord plays: logging never stops the music
        },
        async finishPlay(id, { outcome, listenedSec = null, skipReason = null, error = null }) {
            if (!id) return;
            try {
                await q(`UPDATE ${PL} SET outcome = ?, ended_at = NOW(), listened_sec = ?, skip_reason = ?, error = ? WHERE id = ? AND context = 'stream'`,
                    [outcome, listenedSec, clip(skipReason, 32), clip(error, 500), id]);
            } catch { /* best effort */ }
        },
        /** Plays still 'playing' after a restart. */
        async interruptPlays(before = new Date()) {
            try { return (await q(`UPDATE ${PL} SET outcome = 'interrupted', ended_at = COALESCE(ended_at, NOW()) WHERE context = 'stream' AND outcome = 'playing' AND logged_at < ?`, [before])).affectedRows; } catch { return 0; }
        },
        /** Most played on this profile's stream in the last `days` (completed or listened to past a minute). */
        async topPlayed(profileId, days = 365) {
            try {
                return await q(`SELECT title, author, COUNT(*) AS n FROM ${PL} WHERE context = 'stream' AND stream_profile_id = ? AND logged_at >= NOW() - INTERVAL ? DAY
                                AND (outcome = 'completed' OR listened_sec >= 60) GROUP BY title, author ORDER BY n DESC, MAX(id) DESC LIMIT 200`, [profileId, Math.max(1, Number(days) || 365)]);
            } catch { return []; }
        },
        async recentPlays(profileId, limit = 50) {
            try {
                return await q(`SELECT id, title, author, url, outcome, playback, matched_via, started_at, ended_at, listened_sec, stream_request_id FROM ${PL}
                                WHERE context = 'stream' AND stream_profile_id = ? ORDER BY id DESC LIMIT ${Math.min(200, Math.max(1, Number(limit) || 50))}`, [profileId]);
            } catch { return []; }
        },

        // ── live state (from the event log: the newest online / offline event) ──
        async isLive(profileId) {
            try {
                const r = (await q(`SELECT type FROM ${T('events')} WHERE profile_id = ? AND type IN ('stream.online', 'stream.offline') AND is_test = 0 ORDER BY id DESC LIMIT 1`, [profileId]))[0];
                return r?.type === 'stream.online';
            } catch { return false; }
        },

        // ── privacy ──
        async exportOwner(profileId, rowLimit = 1000) {
            const n = Math.max(1, Number(rowLimit) || 1000);
            const out = {
                music_requests: await q(`SELECT platform, viewer_name, source, input, title, artist, url, status, reason, decided_by, created_at, started_at, finished_at FROM ${T('music_requests')} WHERE profile_id = ? ORDER BY id DESC LIMIT ${n}`, [profileId]),
                music_bans: await q(`SELECT kind, ref, title, artist, url, created_by, created_at FROM ${T('music_bans')} WHERE profile_id = ?`, [profileId]),
                music_likes: await q(`SELECT platform, viewer_name, title, artist, url, created_at FROM ${T('music_likes')} WHERE profile_id = ? ORDER BY id DESC LIMIT ${n}`, [profileId]),
                music_playlists: await q(`SELECT id, name, kind, source_url, created_at FROM ${T('music_playlists')} WHERE profile_id = ?`, [profileId]),
                music_playlist_items: await q(`SELECT playlist_id, title, artist, url, added_by, created_at FROM ${T('music_playlist_items')} WHERE profile_id = ? ORDER BY playlist_id, position LIMIT ${n}`, [profileId]),
            };
            try { out.music_play_log = await q(`SELECT title, author, url, outcome, started_at, ended_at, listened_sec FROM ${PL} WHERE context = 'stream' AND stream_profile_id = ? ORDER BY id DESC LIMIT ${n}`, [profileId]); } catch { /* no play log */ }
            return out;
        },
        async deleteOwnerPlays(profileId) {
            try { return (await q(`DELETE FROM ${PL} WHERE context = 'stream' AND stream_profile_id = ?`, [profileId])).affectedRows; } catch { return 0; }
        },
        async exportViewer(accounts, rowLimit = 1000) {
            const out = { music_requests: [], music_likes: [] };
            const n = Math.max(1, Number(rowLimit) || 1000);
            for (const { platform, id } of accounts || []) {
                if (!platform || !id) continue;
                out.music_requests.push(...await q(`SELECT profile_id, platform, viewer_name, input, title, artist, url, status, created_at FROM ${T('music_requests')} WHERE platform = ? AND viewer_id = ? ORDER BY id DESC LIMIT ${n}`, [platform, String(id)]));
                out.music_likes.push(...await q(`SELECT profile_id, platform, viewer_name, title, artist, url, created_at FROM ${T('music_likes')} WHERE platform = ? AND viewer_id = ? ORDER BY id DESC LIMIT ${n}`, [platform, String(id)]));
            }
            return out;
        },
        /** As a viewer: likes go; requests stay for the streamer's queue history but lose the viewer's identity and words. */
        async deleteViewer(accounts) {
            const counts = {};
            for (const { platform, id } of accounts || []) {
                if (!platform || !id) continue;
                const l = await q(`DELETE FROM ${T('music_likes')} WHERE platform = ? AND viewer_id = ?`, [platform, String(id)]);
                if (l.affectedRows) counts[`${prefix}music_likes`] = (counts[`${prefix}music_likes`] || 0) + l.affectedRows;
                const r = await q(`UPDATE ${T('music_requests')} SET viewer_id = NULL, viewer_login = NULL, viewer_name = NULL, input = NULL WHERE platform = ? AND viewer_id = ?`, [platform, String(id)]);
                if (r.affectedRows) counts[`${prefix}music_requests`] = (counts[`${prefix}music_requests`] || 0) + r.affectedRows;
            }
            return counts;
        },
    };
    return s;
}

export default { createMusicStore, requestRow, PLAYLIST_MAX_ITEMS, PLAYLISTS_MAX };
