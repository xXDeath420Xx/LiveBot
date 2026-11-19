/**
 * Queries behind the super-admin "Music activity" page, over music_play_log (migration 256,
 * written by core/music-play-log.js). Every filter is either whitelisted or bound as a parameter.
 *
 * Two kinds of play share the log (column `context`): 'discord' (a server's voice channel, guild_id is the
 * server) and 'stream' (a stream bot's song requests, guild_id is `sb:<profile id>`). Servers are counted from
 * Discord plays only; stream plays are counted and ranked separately (H-757).
 */

const DAY = 24 * 3600 * 1000;
export const RANGES = { '24h': { ms: DAY, bucketSec: 3600 }, '7d': { ms: 7 * DAY, bucketSec: 6 * 3600 },
    '30d': { ms: 30 * DAY, bucketSec: DAY / 1000 }, '90d': { ms: 90 * DAY, bucketSec: 3 * DAY / 1000 } };
export const SOURCES = ['spotify', 'youtube', 'search', 'soundcloud', 'other'];
export const OUTCOMES = ['completed', 'skipped', 'failed', 'stopped', 'interrupted', 'playing'];
export const CONTEXTS = ['discord', 'stream'];
/** A Discord server id, or a stream bot profile's pseudo guild id (sb:<profile id>). */
const GUILD_RE = /^(\d{5,20}|sb:\d{1,17})$/;

/** WHERE clause + params from the query string. Unknown values are ignored, never interpolated. */
export function buildFilter(q, now = Date.now()) {
    const rangeKey = RANGES[q.range] ? q.range : '7d';
    const where = ['logged_at >= ?'];
    const params = [new Date(now - RANGES[rangeKey].ms)];
    if (CONTEXTS.includes(q.context)) { where.push('context = ?'); params.push(q.context); }
    if (typeof q.guild === 'string' && GUILD_RE.test(q.guild)) { where.push('guild_id = ?'); params.push(q.guild); }
    if (SOURCES.includes(q.source)) { where.push('request_source = ?'); params.push(q.source); }
    if (OUTCOMES.includes(q.outcome)) { where.push('outcome = ?'); params.push(q.outcome); }
    const text = typeof q.q === 'string' ? q.q.trim().slice(0, 100) : '';
    if (text) {
        const like = `%${text.replace(/[\\%_]/g, c => `\\${c}`)}%`;
        where.push('(title LIKE ? OR author LIKE ? OR requester_name LIKE ? OR guild_name LIKE ?)');
        params.push(like, like, like, like);
    }
    return { rangeKey, sql: where.join(' AND '), params };
}

const num = (v) => Number(v || 0);

export async function loadActivity(pool, query, now = Date.now()) {
    const f = buildFilter(query, now);
    const W = f.sql, P = f.params;
    const q = async (sql, extra = []) => (await pool.query(sql, [...P, ...extra]))[0];
    const before = /^\d+$/.test(String(query.before || '')) ? Number(query.before) : null;

    const [[t]] = [await q(`SELECT COUNT(*) plays, SUM(outcome = 'completed') completed, SUM(outcome = 'skipped') skipped,
        SUM(outcome = 'failed') failed, SUM(outcome = 'stopped') stopped, SUM(outcome = 'interrupted') interrupted,
        SUM(outcome = 'playing') playing, COALESCE(SUM(listened_sec), 0) listened, COUNT(DISTINCT requester_id) listeners,
        COUNT(DISTINCT CASE WHEN context <> 'stream' THEN guild_id END) servers,
        COUNT(DISTINCT CASE WHEN context = 'stream' THEN guild_id END) streams, SUM(context = 'stream') streamPlays,
        SUM(prefetched) prefetched FROM music_play_log WHERE ${W}`)];

    const bucket = RANGES[f.rangeKey].bucketSec;
    const [bySource, byPlayback, matcher, topSongs, topRequesters, topServers, topStreams, skippers, failures, timeline, recent, guilds] = await Promise.all([
        q(`SELECT request_source k, COUNT(*) n FROM music_play_log WHERE ${W} GROUP BY request_source ORDER BY n DESC`),
        q(`SELECT COALESCE(playback, 'unknown') k, COUNT(*) n FROM music_play_log WHERE ${W} AND outcome <> 'failed' GROUP BY k ORDER BY n DESC`),
        q(`SELECT COALESCE(matched_via, 'none') k, COUNT(*) n FROM music_play_log WHERE ${W} AND request_source = 'spotify' AND playback <> 'spotify' GROUP BY k ORDER BY n DESC`),
        q(`SELECT title, MAX(author) author, MAX(url) url, COUNT(*) plays, SUM(outcome = 'skipped') skips, SUM(outcome = 'failed') fails
             FROM music_play_log WHERE ${W} GROUP BY title, author ORDER BY plays DESC, title LIMIT 10`),
        q(`SELECT requester_id id, MAX(requester_name) name, COUNT(*) plays, SUM(outcome = 'skipped') skips, COALESCE(SUM(listened_sec), 0) listened
             FROM music_play_log WHERE ${W} AND requester_id IS NOT NULL GROUP BY requester_id ORDER BY plays DESC LIMIT 10`),
        q(`SELECT guild_id id, MAX(guild_name) name, COUNT(*) plays, COUNT(DISTINCT requester_id) listeners, COALESCE(SUM(listened_sec), 0) listened
             FROM music_play_log WHERE ${W} AND context <> 'stream' GROUP BY guild_id ORDER BY plays DESC LIMIT 10`),
        q(`SELECT guild_id id, MAX(guild_name) name, COUNT(*) plays, COUNT(DISTINCT requester_id) listeners, COALESCE(SUM(listened_sec), 0) listened
             FROM music_play_log WHERE ${W} AND context = 'stream' GROUP BY guild_id ORDER BY plays DESC LIMIT 10`),
        q(`SELECT skipped_by id, MAX(skipped_by_name) name, COUNT(*) skips FROM music_play_log
             WHERE ${W} AND outcome = 'skipped' AND skipped_by IS NOT NULL GROUP BY skipped_by ORDER BY skips DESC LIMIT 10`),
        q(`SELECT COALESCE(error, 'unknown') error, COUNT(*) n, MAX(logged_at) last FROM music_play_log
             WHERE ${W} AND outcome = 'failed' GROUP BY error ORDER BY n DESC LIMIT 10`),
        q(`SELECT FLOOR(UNIX_TIMESTAMP(logged_at) / ${bucket}) * ${bucket} * 1000 t, outcome, COUNT(*) n
             FROM music_play_log WHERE ${W} GROUP BY t, outcome ORDER BY t`),
        q(`SELECT id, UNIX_TIMESTAMP(logged_at) * 1000 t, context, guild_id, guild_name, requester_id, requester_name, added_by, request_source, playlist,
                  title, author, url, duration_sec, explicit, playback, prefetched, spotify_account, matched_via, matched_title,
                  listened_sec, outcome, skip_reason, skipped_by_name, error
             FROM music_play_log WHERE ${W}${before ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT 50`, before ? [before] : []),
        // The server filter lists every server with plays in the range, whatever else is filtered.
        (async () => (await pool.query(`SELECT guild_id id, MAX(guild_name) name, MAX(context = 'stream') stream, COUNT(*) plays FROM music_play_log
             WHERE logged_at >= ? GROUP BY guild_id ORDER BY plays DESC LIMIT 200`, [P[0]]))[0])(),
    ]);

    const n = (rows) => rows.map(r => ({ ...r, n: num(r.n) }));
    return {
        range: f.rangeKey, from: P[0].getTime(), to: now, bucketMs: bucket * 1000,
        totals: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, num(v)])),
        bySource: n(bySource), byPlayback: n(byPlayback), matcher: n(matcher),
        topSongs: topSongs.map(r => ({ ...r, plays: num(r.plays), skips: num(r.skips), fails: num(r.fails) })),
        topRequesters: topRequesters.map(r => ({ ...r, plays: num(r.plays), skips: num(r.skips), listened: num(r.listened) })),
        topServers: topServers.map(r => ({ ...r, plays: num(r.plays), listeners: num(r.listeners), listened: num(r.listened) })),
        topStreams: topStreams.map(r => ({ ...r, plays: num(r.plays), listeners: num(r.listeners), listened: num(r.listened) })),
        skippers: skippers.map(r => ({ ...r, skips: num(r.skips) })),
        failures: failures.map(r => ({ ...r, n: num(r.n), last: r.last ? new Date(r.last).getTime() : null })),
        timeline: timeline.map(r => ({ t: num(r.t), outcome: r.outcome, n: num(r.n) })),
        recent: recent.map(r => ({ ...r, id: num(r.id), t: num(r.t), prefetched: !!r.prefetched })),
        guilds: guilds.map(g => ({ ...g, stream: !!num(g.stream), plays: num(g.plays) })),
    };
}
