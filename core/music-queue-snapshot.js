/*
 * Music queue snapshots — the pure half of "queue restore across restarts"
 * (core/music-queue-persistence.js is the half that touches discord-player and the database).
 *
 * A snapshot is everything needed to put a guild's music back the way it was after a deploy or a
 * crash: which voice/text channel, the track that was playing and how far in, the upcoming tracks
 * (as data that rebuilds discord-player Tracks WITHOUT re-searching them — a 300-track playlist must
 * not cost 300 lookups against the resolvers at boot), volume, repeat mode and the DJ-mode metadata.
 *
 * Dependency-free on purpose so tests/music-queue-snapshot.test.js runs without node_modules.
 */

export const SNAPSHOT_VERSION = 1;
/** Upcoming tracks kept per guild. A bigger queue keeps its first MAX_SAVED_TRACKS (said in the restore notice). */
export const MAX_SAVED_TRACKS = 500;
/** A snapshot older than this is discarded instead of restored: nobody is waiting for that music any more. */
export const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
/** Resume a little before the saved position so the listener hears where they were. */
export const REWIND_MS = 3000;
/** A track this close to its end is treated as finished: the restore starts the next one. */
export const END_MARGIN_MS = 10000;
/** DJ "recently played" memory kept across a restart. */
const MAX_PLAYED_TRACKS = 100;
/** discord-player's QueueRepeatMode.TRACK */
const REPEAT_TRACK = 1;

const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

/** discord-player escapes markdown in Track.title; undo it so a rebuilt Track is not escaped twice. */
export function unescapeMarkdown(text) {
    return String(text ?? '').replace(/\\([\\*_`~|>#\-[\]().])/g, '$1');
}

/** Only playable over the network: DJ commentary / skip banter are local WAVs deleted after playing. */
export function isRestorableUrl(url) {
    return /^https?:\/\//i.test(String(url || ''));
}

export function isSpotifyTrack(t) {
    return t?.source === 'spotify' || /open\.spotify\.com|^spotify:/i.test(String(t?.url || ''));
}

/** Track metadata, reduced to JSON-safe primitives (bridgeQuery, explicit, spotifyUri, artist …). */
export function plainMetadata(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(meta)) {
        if (n >= 20) break;
        if (typeof v === 'string') { out[k] = v.slice(0, 500); n++; }
        else if (typeof v === 'number' && Number.isFinite(v)) { out[k] = v; n++; }
        else if (typeof v === 'boolean') { out[k] = v; n++; }
    }
    return n ? out : null;
}

/** "3:25" / "1:02:03" → ms (0 when unknown). */
export function durationToMs(duration) {
    const parts = String(duration || '').split(':').map(p => parseInt(p, 10));
    if (!parts.length || parts.some(n => !Number.isFinite(n))) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

/**
 * A Track as plain data, or null when it can't be rebuilt (local commentary file, no URL).
 * `requestSource` is the play log's "where did this request come from" so a restored play is
 * attributed like the original.
 */
export function serializeTrack(track, { requestSource = null } = {}) {
    if (!track || typeof track !== 'object') return null;
    const meta = track.metadata && typeof track.metadata === 'object' ? track.metadata : null;
    if (meta?.isDJCommentary || meta?.isSkipBanter) return null;
    const url = String(track.url || '');
    if (!isRestorableUrl(url)) return null;
    const raw = track.raw && typeof track.raw === 'object' ? track.raw : {};
    const req = track.requestedBy;
    return {
        title: clip(typeof raw.title === 'string' && raw.title ? raw.title : unescapeMarkdown(track.title || 'Unknown'), 500),
        author: clip(track.author || '', 255),
        url: clip(url, 1000),
        thumbnail: typeof track.thumbnail === 'string' ? clip(track.thumbnail, 1000) : null,
        duration: clip(track.duration || '', 16),
        durationMS: Number(track.durationMS) || durationToMs(track.duration),
        source: clip(track.source || raw.source || 'arbitrary', 32),
        queryType: track.queryType ? clip(track.queryType, 32) : null,
        extractor: track.extractor?.identifier ? clip(track.extractor.identifier, 100) : null,
        requestedBy: req?.id ? {
            id: String(req.id),
            username: clip(req.username, 100),
            globalName: clip(req.globalName, 100),
            bot: !!req.bot,
        } : null,
        metadata: plainMetadata(meta),
        unresolved: !!raw.ytdlpUnresolved,
        requestSource: requestSource ? clip(requestSource, 16) : null,
    };
}

/** The queue metadata a restore needs (DJ mode included); everything else is dropped. */
export function pickQueueMetadata(meta) {
    if (!meta || typeof meta !== 'object') return {};
    const out = {};
    const str = (k, n = 2000) => { if (typeof meta[k] === 'string' && meta[k]) out[k] = meta[k].slice(0, n); };
    str('channelId', 20); str('voiceChannelId', 20); str('djInitiatorId', 20);
    str('inputSong', 255); str('inputArtist', 255); str('inputGenre', 255);
    str('prompt'); str('basePrompt'); str('presetName', 100);
    if (meta.djMode) out.djMode = true;
    if (meta.favoritesSeed) out.favoritesSeed = true;
    if (meta.camp) out.camp = true;
    if (meta.source && typeof meta.source === 'object') {
        const { platform, type, displayName } = meta.source;
        out.source = { platform: clip(platform, 32), type: clip(type, 32), displayName: clip(displayName, 64) };
    }
    if (Array.isArray(meta.playedTracks) && meta.playedTracks.length) {
        out.playedTracks = meta.playedTracks.slice(-MAX_PLAYED_TRACKS).map(t =>
            typeof t === 'string' ? clip(t, 300)
                : (t && typeof t.title === 'string' ? { title: clip(t.title, 300), playedAt: Number(t.playedAt) || 0 } : null)
        ).filter(Boolean);
    }
    return out;
}

/**
 * Snapshot a live queue, or null when there is nothing worth restoring (idle camp/voice-tools
 * queue, queue ended). `describe(track)` → { requestSource } lets the caller add play-log facts.
 */
export function buildSnapshot(queue, { describe = () => ({}), maxTracks = MAX_SAVED_TRACKS } = {}) {
    if (!queue?.guild?.id) return null;
    const ser = (t) => { try { return serializeTrack(t, describe(t) || {}); } catch { return null; } };
    const current = queue.currentTrack ? ser(queue.currentTrack) : null;

    const all = typeof queue.tracks?.toArray === 'function' ? queue.tracks.toArray()
        : Array.isArray(queue.tracks?.data) ? queue.tracks.data
        : Array.isArray(queue.tracks) ? queue.tracks : [];
    const upcoming = [];
    for (const t of all) {
        if (upcoming.length >= maxTracks) break;
        const s = ser(t);
        if (s) upcoming.push(s);
    }
    const meta = pickQueueMetadata(queue.metadata);
    // An AI DJ session between batches (generating) has no tracks but is still worth bringing back.
    if (!current && !upcoming.length && !meta.djMode) return null;

    let positionMs = 0;
    try { positionMs = Math.max(0, Math.round(Number(queue.node?.playbackTime) || 0)); } catch { positionMs = 0; }
    let paused = false;
    try { paused = !!queue.node?.isPaused?.(); } catch { paused = false; }
    let playing = false;
    try { playing = !!queue.isPlaying?.(); } catch { playing = false; }
    const volume = Number(queue.node?.volume);

    return {
        v: SNAPSHOT_VERSION,
        guildId: String(queue.guild.id),
        botUserId: queue.guild.client?.user?.id ? String(queue.guild.client.user.id) : null,
        voiceChannelId: String(queue.channel?.id || queue.connection?.joinConfig?.channelId || meta.voiceChannelId || '') || null,
        textChannelId: meta.channelId || null,
        current,
        positionMs: current ? positionMs : 0,
        upcoming,
        totalUpcoming: all.length,
        volume: Number.isFinite(volume) ? Math.max(0, Math.min(200, Math.round(volume))) : null,
        repeatMode: Number.isInteger(queue.repeatMode) ? queue.repeatMode : 0,
        paused,
        playing,
        meta,
    };
}

/** The music_queues row for a snapshot. Position lives in its own column so the JSON rarely changes. */
export function rowFromSnapshot(snap, instanceId) {
    return {
        guild_id: snap.guildId,
        queue: JSON.stringify(snap.upcoming || []),
        now_playing: snap.current ? JSON.stringify(snap.current) : null,
        is_playing: snap.playing ? 1 : 0,
        is_paused: snap.paused ? 1 : 0,
        voice_channel_id: snap.voiceChannelId || null,
        text_channel_id: snap.textChannelId || null,
        bot_user_id: snap.botUserId || null,
        position_ms: Math.max(0, Math.min(2147483647, Math.round(snap.positionMs || 0))),
        volume: snap.volume ?? null,
        repeat_mode: Number.isInteger(snap.repeatMode) ? snap.repeatMode : 0,
        metadata: JSON.stringify({ ...(snap.meta || {}), totalUpcoming: snap.totalUpcoming ?? (snap.upcoming || []).length }),
        instance_id: instanceId ? String(instanceId).slice(0, 40) : null,
    };
}

/** Everything in a row except the fields that change every second of playback. */
export function rowSignature(row) {
    return [row.queue, row.now_playing, row.voice_channel_id, row.text_channel_id, row.bot_user_id,
        row.volume, row.repeat_mode, row.metadata].join('\u0001');
}

function parseJson(text, fallback) {
    if (text == null || text === '') return fallback;
    if (typeof text === 'object') return text;   // mysql2 may already have parsed a JSON column
    try { return JSON.parse(text); } catch { return fallback; }
}

/** A music_queues row back into a snapshot (tolerates rows from the old, unused schema). */
export function snapshotFromRow(row) {
    if (!row?.guild_id) return null;
    const upcoming = parseJson(row.queue, []);
    const current = parseJson(row.now_playing, null);
    const meta = parseJson(row.metadata, {}) || {};
    const totalUpcoming = Number(meta.totalUpcoming) || (Array.isArray(upcoming) ? upcoming.length : 0);
    delete meta.totalUpcoming;
    return {
        v: SNAPSHOT_VERSION,
        guildId: String(row.guild_id),
        botUserId: row.bot_user_id ? String(row.bot_user_id) : null,
        voiceChannelId: row.voice_channel_id ? String(row.voice_channel_id) : (meta.voiceChannelId || null),
        textChannelId: row.text_channel_id ? String(row.text_channel_id) : (meta.channelId || null),
        current: current && typeof current === 'object' && current.url ? current : null,
        positionMs: Math.max(0, Number(row.position_ms) || 0),
        upcoming: Array.isArray(upcoming) ? upcoming.filter(t => t && typeof t === 'object' && isRestorableUrl(t.url)) : [],
        totalUpcoming,
        volume: row.volume == null ? null : Number(row.volume),
        repeatMode: Number(row.repeat_mode) || 0,
        paused: !!Number(row.is_paused),
        playing: !!Number(row.is_playing),
        meta,
    };
}

/**
 * Where to resume the current track: { seekMs, skip }.
 *   - Spotify tracks restart from the beginning: they usually play through go-librespot, a real-time
 *     stream that can only be "seeked" by sitting in silence for the skipped part.
 *   - A track within END_MARGIN_MS of its end counts as finished (skip → start the next one),
 *     unless the queue repeats that track.
 *   - Otherwise resume REWIND_MS before where it was.
 */
export function resumePosition(track, positionMs, { repeatMode = 0, rewindMs = REWIND_MS, endMarginMs = END_MARGIN_MS } = {}) {
    if (!track) return { seekMs: 0, skip: false };
    const pos = Math.max(0, Number(positionMs) || 0);
    const duration = Number(track.durationMS) || durationToMs(track.duration);
    if (duration > 0 && pos >= duration - endMarginMs && repeatMode !== REPEAT_TRACK) return { seekMs: 0, skip: true };
    if (isSpotifyTrack(track)) return { seekMs: 0, skip: false };
    const seek = pos - rewindMs;
    if (seek < 1000) return { seekMs: 0, skip: false };
    return { seekMs: duration > 0 ? Math.min(seek, duration - 1000) : seek, skip: false };
}

/**
 * What to do with a stored snapshot.
 *   { action: 'expired' }  older than maxAgeMs
 *   { action: 'empty' }    nothing playable left
 *   { action: 'restore', current, seekMs, upcoming, skippedCurrent, djRefill }
 *     (djRefill: an AI DJ session with nothing queued — rejoin and let the DJ pick new songs)
 */
export function planRestore(snap, { ageMs, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
    if (!snap) return { action: 'empty' };
    if (Number(ageMs) > maxAgeMs) return { action: 'expired' };
    let current = snap.current && isRestorableUrl(snap.current.url) ? snap.current : null;
    let upcoming = (snap.upcoming || []).filter(t => isRestorableUrl(t?.url));
    let seekMs = 0;
    let skippedCurrent = false;
    if (current) {
        const r = resumePosition(current, snap.positionMs, { repeatMode: snap.repeatMode });
        if (r.skip) { current = null; skippedCurrent = true; }
        else seekMs = r.seekMs;
    }
    if (!current && upcoming.length) {
        // Nothing (left) to resume: the first upcoming track becomes the one to start.
        current = upcoming[0];
        upcoming = upcoming.slice(1);
        seekMs = 0;
    }
    if (!current) {
        if (snap.meta?.djMode) return { action: 'restore', current: null, seekMs: 0, upcoming: [], skippedCurrent, djRefill: true };
        return { action: 'empty' };
    }
    return { action: 'restore', current, seekMs, upcoming, skippedCurrent, djRefill: false };
}

/** 83000 → "1:23", 3723000 → "1:02:03" */
export function formatClock(ms) {
    const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** The note posted in the text channel after a restore. */
export function restoreNotice({ title, author, seekMs, upcomingCount, droppedCount = 0, djMode, paused, spotifyRestart }) {
    const who = author ? ` by ${author}` : '';
    const where = seekMs > 0 ? ` from **${formatClock(seekMs)}**` : spotifyRestart ? ' from the start (Spotify tracks can\'t resume mid-song)' : '';
    let text = `🔁 I was restarted — picking the music back up: **${title}**${who}${where}`;
    if (upcomingCount > 0) text += `, with **${upcomingCount}** track${upcomingCount === 1 ? '' : 's'} still queued`;
    text += '.';
    if (droppedCount > 0) {
        text += ` ${droppedCount} queued track${droppedCount === 1 ? '' : 's'} could not be kept`
            + ` (a very long queue keeps its first ${MAX_SAVED_TRACKS}; DJ voice clips are not kept).`;
    }
    if (djMode) text += ' The AI DJ session carries on.';
    if (paused) text += ' It was paused, so it is paused again — use `/music resume`.';
    return text;
}
