/**
 * Music play log: one row per track the bot tried to play (music_play_log, migration 256).
 *
 *   where / who  server, voice channel, requester (or autoplay / DJ mode)
 *   what         title, artist, URL, length, explicit
 *   request      where it came from — a Spotify link, a YouTube link, a text search (SoundCloud /
 *                other) — and from which playlist
 *   playback     how it actually played: Spotify direct (shared or linked account), or YouTube through
 *                a home resolver's audio relay (server2 / workstation) or straight from server1's IP;
 *                whether it was prefetched; for a Spotify track bridged to YouTube, which recording
 *                the matcher picked (YouTube Music or search)
 *   outcome      completed | skipped (by whom, why) | failed (why) | stopped (ended early: /stop,
 *                leave) | interrupted (the bot restarted mid-song) — plus seconds actually listened,
 *                pauses excluded
 *
 * Fed by discord-player's events (attachPlayLog, from index.js) and by notes from the extractor and
 * the Spotify hook. Best-effort throughout: logging never gets in the way of playback.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import logger from '../utils/logger.js';
import { resolverGroups } from '../utils/music-resolver-config.js';

/**
 * Who triggered the code that is running — the interaction or message being handled. discord-player
 * emits playerSkip synchronously inside queue.node.skip(), so the skip listener sees the skipper here
 * without any of the seven skip call sites (buttons, commands, panel, AI assistant) passing it along.
 */
export const actorContext = new AsyncLocalStorage();
export function withActor(eventName, args, fn) {
    const user = eventName === 'interactionCreate' ? args[0]?.user : eventName === 'messageCreate' ? args[0]?.author : null;
    return user ? actorContext.run({ userId: user.id, name: user.globalName || user.username || null }, fn) : fn();
}

const requestKinds = new WeakMap();   // Track -> 'youtube' | 'search' | 'soundcloud' | 'spotify' | 'other'
const requestedAt = new WeakMap();    // Track -> epoch ms it was queued
const playbackNotes = new WeakMap();  // Track -> { path, prefetched, account, matchedVia, matchedTitle }

/** What kind of request a /play query was. */
export function classifyQuery(query) {
    const q = String(query || '').trim();
    if (!/^https?:\/\//i.test(q)) return 'search';
    if (/youtube\.com|youtu\.be/i.test(q)) return 'youtube';
    if (/soundcloud\.com/i.test(q)) return 'soundcloud';
    if (/spotify\.com/i.test(q)) return 'spotify';
    return 'other';
}

export function noteRequestKind(track, query) {
    if (track && typeof track === 'object') requestKinds.set(track, classifyQuery(query));
}
export function noteRequested(track, at = Date.now()) {
    if (track && typeof track === 'object' && !requestedAt.has(track)) requestedAt.set(track, at);
}
export function notePlayback(track, info) {
    if (track && typeof track === 'object') playbackNotes.set(track, { ...(playbackNotes.get(track) || {}), ...info });
}

/** Where the request came from: Spotify, a YouTube link, a text search, SoundCloud, other. */
export function requestSourceOf(track) {
    const url = String(track?.url || '');
    if (track?.source === 'spotify' || /open\.spotify\.com|^spotify:/.test(url) || track?.metadata?.spotifyUri) return 'spotify';
    const kind = requestKinds.get(track);
    if (kind) return kind;
    if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
    if (/soundcloud\.com/.test(url)) return 'soundcloud';
    return 'other';
}

/** How a playable URL reaches the bot: a home resolver's relay (named by its tunnel), or googlevideo directly. */
export function pathOfUrl(url) {
    try {
        const u = new URL(url);
        if (u.pathname.startsWith('/audio/')) {
            const base = `${u.protocol}//${u.host}`;
            const group = resolverGroups().find(g => g.bases.includes(base));
            return `relay:${group?.name || u.host}`;
        }
        if (u.hostname.endsWith('googlevideo.com')) return 'server1-direct';
        return 'direct';
    } catch { return null; }
}

/** For a track that ended without a skip or an error: did it play out, or was it stopped early? */
export function endOutcome(listenedSec, durationSec) {
    if (!durationSec) return 'completed';
    return listenedSec >= durationSec * 0.9 || durationSec - listenedSec <= 20 ? 'completed' : 'stopped';
}

const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

/** The descriptive columns of a play, known when it starts (or fails to). */
export function describePlay(queue, track) {
    const req = track.requestedBy;
    const automatic = !req || req.bot;
    const note = playbackNotes.get(track) || {};
    const explicit = track.metadata?.explicit;
    return {
        guild_id: queue.guild.id,
        guild_name: clip(queue.guild.name, 100),
        voice_channel_id: queue.channel?.id || null,
        requester_id: automatic ? null : req.id,
        requester_name: automatic ? null : clip(req.globalName || req.username, 100),
        added_by: automatic ? (queue.metadata?.djMode ? 'dj' : 'autoplay') : 'user',
        request_source: requestSourceOf(track),
        playlist: clip(track.playlist?.title, 255),
        title: clip(track.title || 'Unknown', 500),
        author: clip(track.author, 255),
        url: clip(track.url, 1000),
        duration_sec: track.durationMS ? Math.round(track.durationMS / 1000) : null,
        explicit: typeof explicit === 'boolean' ? (explicit ? 1 : 0) : null,
        playback: clip(note.path, 48),
        prefetched: note.prefetched ? 1 : 0,
        spotify_account: clip(note.account, 16),
        matched_via: clip(note.matchedVia, 16),
        matched_title: clip(note.matchedTitle, 500),
        requested_at: requestedAt.has(track) ? new Date(requestedAt.get(track)) : null,
    };
}

// ── the real database writer (tests pass their own `write`) ─────────────────
let pool = null, tableMissing = false, lastErrorAt = 0;
async function dbWrite(sql, params) {
    if (tableMissing) return null;
    try {
        pool ||= (await import('../utils/db.js')).default;
        const [result] = await pool.execute(sql, params);
        return result;
    } catch (e) {
        if (e.code === 'ER_NO_SUCH_TABLE') { tableMissing = true; logger.warn('[PlayLog] music_play_log is missing (migration 256) — plays are not being logged'); }
        else if (Date.now() - lastErrorAt > 30 * 60 * 1000) { lastErrorAt = Date.now(); logger.warn(`[PlayLog] write failed: ${e.message}`); }
        return null;
    }
}

// Every player the log is attached to, with its per-track state, so livePlays() can report what is
// playing right now (the super-admin "Music activity" live view).
const attached = new Set(); // { player, plays }

/**
 * What is playing right now on every attached player. The position comes from the player itself
 * (it accounts for seeks and pauses); playId ties the entry to its music_play_log row.
 */
export function livePlays(nowMs = Date.now()) {
    const out = [];
    for (const { player, plays } of attached) {
        const nodes = player?.nodes?.cache;
        if (!nodes?.values) continue;
        for (const queue of nodes.values()) {
            const track = queue?.currentTrack;
            if (!track) continue;
            const rec = plays.get(track);
            const node = queue.node;
            let positionMs = null;
            try { positionMs = Number(node?.playbackTime); } catch { positionMs = null; }
            if (!Number.isFinite(positionMs) || positionMs < 0) {
                try { positionMs = node?.getTimestamp?.()?.current?.value ?? null; } catch { positionMs = null; }
            }
            if ((positionMs == null || !Number.isFinite(positionMs)) && rec?.startedAt) {
                positionMs = nowMs - rec.startedAt - rec.pausedMs - (rec.pausedAt ? nowMs - rec.pausedAt : 0);
            }
            let paused = false;
            try { paused = !!node?.isPaused?.(); } catch { paused = !!rec?.pausedAt; }
            const fields = describePlay(queue, track);
            out.push({
                playId: rec?.id ?? null,
                guild_id: fields.guild_id, guild_name: fields.guild_name,
                voice_channel_name: clip(queue.channel?.name, 100),
                requester_name: fields.requester_name, added_by: fields.added_by,
                title: fields.title, author: fields.author, url: fields.url,
                thumbnail: clip(track.thumbnail, 1000),
                playback: fields.playback, request_source: fields.request_source,
                durationMs: Number(track.durationMS) || 0,
                positionMs: Math.max(0, Math.round(positionMs || 0)),
                paused,
                startedAt: rec?.startedAt ?? null,
                upNext: queue.tracks?.size ?? 0,
            });
        }
    }
    return out;
}

/**
 * Subscribe to the player's events. `write(sql, params)` stores rows (default: the bot's MySQL pool);
 * `now()` is the clock; `settleMs` is how long a plain "ended" waits for a skip or error about the
 * same track (on a manual skip discord-player ends the dispatcher BEFORE emitting playerSkip, so the
 * two can arrive in either order). Returns the handlers, for tests.
 */
export function attachPlayLog(player, { write = dbWrite, now = Date.now, settleMs = 1500 } = {}) {
    const plays = new WeakMap(); // Track -> { row: Promise<id>, id, startedAt, pausedMs, pausedAt, endedAt, endTimer, done }
    const current = new Map();   // guild id -> the track it last started (a deleted queue may no longer say)
    const processStart = new Date(now());
    attached.add({ player, plays });

    // Rows still "playing" from before this process started can never finish: the bot restarted mid-song.
    write(`UPDATE music_play_log SET outcome = 'interrupted', ended_at = COALESCE(ended_at, ?) WHERE outcome = 'playing' AND logged_at < ?`,
        [processStart, processStart]);

    const insert = (fields, extra) => {
        const row = { ...fields, ...extra };
        const cols = Object.keys(row);
        return Promise.resolve(write(`INSERT INTO music_play_log (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c])))
            .then(r => r?.insertId ?? null);
    };

    function start(queue, track) {
        if (!track) return;
        const prev = plays.get(track);
        if (prev && !prev.done) return; // the same start reported twice
        const startedAt = now();
        const rec = {
            startedAt, pausedMs: 0, pausedAt: null, done: false, id: null,
            row: insert(describePlay(queue, track), { started_at: new Date(startedAt), outcome: 'playing' }),
        };
        rec.row.then(id => { rec.id = id; }, () => {});
        plays.set(track, rec);
        if (queue?.guild?.id) current.set(queue.guild.id, track);
    }

    /**
     * The queue is gone: /stop, a leave, or the bot pulled out of voice. discord-player deletes a queue in
     * transition mode, so its track never gets a playerFinish, and only a pulled-out bot also emits
     * disconnect. Either event closes the guild's last-started play (a play that already ended stays as it is).
     */
    function endQueue(queue) {
        const guildId = queue?.guild?.id;
        const track = queue?.currentTrack || (guildId ? current.get(guildId) : null);
        if (guildId) current.delete(guildId);
        return finish(queue, track, 'ended');
    }

    /** outcome: 'ended' (finish / disconnect — completed or stopped, decided by time listened), 'skipped', 'failed'. */
    function finish(queue, track, outcome, details = {}) {
        if (!track) return null;
        const rec = plays.get(track);
        if (!rec) {
            // Never started: only a failure is worth a row (it couldn't be streamed at all).
            if (outcome !== 'failed') return null;
            plays.set(track, { done: true });
            return insert(describePlay(queue, track), { outcome: 'failed', ended_at: new Date(now()), error: clip(details.error, 500) });
        }
        if (rec.done) return null; // already settled: an error after an error, a finish after a skip
        if (outcome === 'ended') {
            if (rec.endTimer) return null;
            rec.endedAt = now();
            rec.endTimer = setTimeout(() => settle(track, rec, 'ended', {}).catch(() => {}), settleMs);
            rec.endTimer.unref?.();
            return null;
        }
        if (rec.endTimer) { clearTimeout(rec.endTimer); rec.endTimer = null; } // the skip / error explains that end
        return settle(track, rec, outcome, details);
    }

    async function settle(track, rec, outcome, { reason = null, by = null, error = null }) {
        if (rec.done) return;
        rec.done = true;
        const t = rec.endedAt ?? now();
        if (rec.pausedAt) { rec.pausedMs += t - rec.pausedAt; rec.pausedAt = null; }
        const listened = Math.max(0, Math.round((t - rec.startedAt - rec.pausedMs) / 1000));
        const final = outcome === 'ended' ? endOutcome(listened, track.durationMS ? track.durationMS / 1000 : null) : outcome;
        const id = await rec.row;
        if (!id) return;
        await write(`UPDATE music_play_log SET outcome = ?, ended_at = ?, listened_sec = ?, skip_reason = ?, skipped_by = ?, skipped_by_name = ?, error = ? WHERE id = ?`,
            [final, new Date(t), listened, clip(reason, 32), by?.userId || null, clip(by?.name, 100), clip(error, 500), id]);
    }

    const handlers = {
        audioTrackAdd: (queue, track) => noteRequested(track, now()),
        audioTracksAdd: (queue, tracks) => (tracks || []).forEach(t => noteRequested(t, now())),
        playerStart: (queue, track) => start(queue, track),
        playerPause: (queue) => { const r = plays.get(queue.currentTrack); if (r && !r.done && !r.pausedAt) r.pausedAt = now(); },
        playerResume: (queue) => {
            const r = plays.get(queue.currentTrack);
            if (r?.pausedAt) { r.pausedMs += now() - r.pausedAt; r.pausedAt = null; }
        },
        playerSkip: (queue, track, reason, description) => (reason === 'ERR_NO_STREAM'
            ? finish(queue, track, 'failed', { error: String(description || 'no stream').split('\n')[0] })
            : finish(queue, track, 'skipped', { reason, by: actorContext.getStore() || null })),
        playerError: (queue, error, track) => finish(queue, track || queue.currentTrack, 'failed', { error: error?.message }),
        playerFinish: (queue, track) => finish(queue, track, 'ended'),
        disconnect: (queue) => endQueue(queue),
        queueDelete: (queue) => endQueue(queue),
    };
    for (const [event, fn] of Object.entries(handlers)) {
        player.events.on(event, (...args) => {
            try { const p = fn(...args); if (p?.catch) p.catch(e => logger.debug(`[PlayLog] ${event}: ${e.message}`)); }
            catch (e) { logger.debug(`[PlayLog] ${event}: ${e.message}`); }
        });
    }
    return handlers;
}
