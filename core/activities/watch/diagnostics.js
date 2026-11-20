/**
 * Watch Together playback diagnostics (frontend/activities/src/watch-diag.js sends them; POST /activity/api/watch/diag).
 *
 * A viewer's player reports how the device is playing the film once playback starts and again 20 seconds later. Each
 * report becomes one `[WatchDiag]` log line, for finding device-specific playback problems (an Android phone with no
 * sound, say). Kept in permanently: it is two small requests per title per viewer.
 *
 * cleanDiag() keeps only the known fields, with fixed types and lengths, so a page (or anyone holding a session) can
 * only ever write a bounded, known shape into the log. The only person data is the Discord user id the session already
 * has; enumerateDevices is reduced to counts in the page, never names or ids.
 */

const str = (v, max) => (v === null || v === undefined ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max));
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? Math.round(Number(v) * 100) / 100 : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
const int = (v, max = 1e12) => { const n = num(v); return n === null ? null : Math.max(0, Math.min(max, Math.trunc(n))); };

export const DIAG_PHASES = Object.freeze(['start', 'later']);

/** A report as sent by the page -> the fields we log, or null when it is not a report. */
export function cleanDiag(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (!DIAG_PHASES.includes(body.phase)) return null;
    const list = (v, n) => (Array.isArray(v) ? v.slice(-n) : []);
    const outputs = body.outputs && typeof body.outputs === 'object' && !Array.isArray(body.outputs)
        ? (body.outputs.error ? { error: str(body.outputs.error, 40) } : { count: int(body.outputs.count, 64), labelled: int(body.outputs.labelled, 64) })
        : null;
    return {
        phase: body.phase,
        player: ['hls.js', 'native'].includes(body.player) ? body.player : null,
        userAgent: str(body.userAgent, 300),
        muted: bool(body.muted),
        volume: num(body.volume),
        paused: bool(body.paused),
        readyState: int(body.readyState, 4),
        currentTime: num(body.currentTime),
        sourceBuffers: list(body.sourceBuffers, 4).filter((t) => t && typeof t === 'object')
            .map((t) => ({ type: str(t.type, 16), container: str(t.container, 40), codec: str(t.codec, 60) })),
        hlsErrors: list(body.hlsErrors, 20).filter((e) => e && typeof e === 'object')
            .map((e) => ({ type: str(e.type, 40), details: str(e.details, 60), fatal: bool(e.fatal) })),
        audioTracks: int(body.audioTracks, 64),
        webkitAudioDecodedByteCount: int(body.webkitAudioDecodedByteCount),
        mozHasAudio: bool(body.mozHasAudio),
        mediaSession: bool(body.mediaSession),
        aacSupported: bool(body.aacSupported),
        autoplay: str(body.autoplay, 60),
        setSinkId: bool(body.setSinkId),
        speakerSelection: bool(body.speakerSelection),
        outputs,
    };
}

/** The log line: `[WatchDiag] {json}` with who, where and what was playing. */
export function diagLine({ userId, session = null, diag }) {
    const m = session?.media || null;
    return `[WatchDiag] ${JSON.stringify({
        userId: str(userId, 25),
        session: session ? {
            id: str(session.id, 64), guildId: str(session.guildId, 25), channelId: str(session.channelId, 25),
            itemId: str(m?.itemId, 64), title: str(m?.label, 200), remux: m ? !!m.remux : null,
        } : null,
        ...diag,
    })}`;
}
