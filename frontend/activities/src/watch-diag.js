// Watch Together playback diagnostics: how a device is playing the film, sent to the server (POST api/watch/diag,
// logged as [WatchDiag]) once playback starts and again 20 seconds later, once per title. It is how device-specific
// playback problems get found (a phone with no sound, say), so it stays in. It carries no personal data: the server
// adds the Discord user id the session already has.
//
// snapshot() is pure over the objects it is given (tests pass fakes); createWatchDiag() wires it to the player.

const round = (n, d = 2) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 10 ** d) / 10 ** d : null);
const MAX_ERRORS = 20;

/** Which SourceBuffers hls.js created, from a BUFFER_CREATED event's data: [{ type, container, codec }]. */
export function bufferTracks(data) {
    const tracks = data?.tracks && typeof data.tracks === 'object' ? data.tracks : {};
    return Object.entries(tracks).map(([type, t]) => ({
        type: String(type).slice(0, 16),
        container: t?.container ? String(t.container).slice(0, 40) : null,
        codec: t?.codec || t?.levelCodec ? String(t.codec || t.levelCodec).slice(0, 60) : null,
    }));
}

/** One report. video: the <video>; env: { navigator, MediaSource, document } (the page's own by default). */
export function snapshot(video, { phase, player, tracks = [], errors = [], autoplay = null, outputs = null, env = globalThis } = {}) {
    const nav = env.navigator || {};
    const MS = env.MediaSource || env.ManagedMediaSource || null;
    let aac = null;
    try { aac = typeof MS?.isTypeSupported === 'function' ? !!MS.isTypeSupported('audio/mp4; codecs="mp4a.40.2"') : null; } catch { aac = null; }
    let speakerSelection = null;
    try { speakerSelection = typeof env.document?.featurePolicy?.allowsFeature === 'function' ? !!env.document.featurePolicy.allowsFeature('speaker-selection') : null; } catch { speakerSelection = null; }
    return {
        phase,
        player: player || null,
        userAgent: String(nav.userAgent || '').slice(0, 300),
        muted: !!video.muted,
        volume: round(video.volume),
        paused: !!video.paused,
        readyState: Number(video.readyState) || 0,
        currentTime: round(video.currentTime, 1),
        sourceBuffers: tracks,
        hlsErrors: errors.slice(-MAX_ERRORS),
        audioTracks: video.audioTracks && Number.isFinite(video.audioTracks.length) ? video.audioTracks.length : null,
        webkitAudioDecodedByteCount: typeof video.webkitAudioDecodedByteCount === 'number' ? video.webkitAudioDecodedByteCount : null,
        mozHasAudio: typeof video.mozHasAudio === 'boolean' ? video.mozHasAudio : null,
        mediaSession: !!nav && 'mediaSession' in nav,
        aacSupported: aac,
        autoplay,
        // For an output picker: can this frame choose the speaker? (outputs: { count, labelled } or null)
        setSinkId: typeof video.setSinkId === 'function',
        speakerSelection,
        outputs,
    };
}

/** Counts audio outputs this frame can see (never their names or ids). */
export async function countOutputs(env = globalThis) {
    try {
        const md = env.navigator?.mediaDevices;
        if (typeof md?.enumerateDevices !== 'function') return null;
        const outs = (await md.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
        return { count: outs.length, labelled: outs.filter((d) => d.label).length };
    } catch (e) {
        return { error: String(e?.name || 'Error').slice(0, 40) };
    }
}

/**
 * The player's diagnostics: reset() on each title, attachHls(hls, Hls) when hls.js plays it, noteAutoplay(text) when
 * the browser refuses sound or play, started() on the first 'playing' (sends now and 20 s later), stop() on close.
 */
export function createWatchDiag(video, { send, delayMs = 20_000, env = globalThis } = {}) {
    let tracks = [];
    let errors = [];
    let autoplay = null;
    let player = null;
    let sent = false;
    let later = null;
    let gen = 0;

    async function report(phase, g) {
        if (g !== gen) return;
        const outputs = await countOutputs(env);
        if (g !== gen) return;
        try { send(snapshot(video, { phase, player, tracks, errors, autoplay, outputs, env })); } catch { /* never breaks playback */ }
    }

    return {
        reset() {
            gen++;
            clearTimeout(later);
            later = null;
            tracks = [];
            errors = [];
            autoplay = null;
            player = null;
            sent = false;
        },
        attachHls(hls, Hls) {
            player = 'hls.js';
            hls.on(Hls.Events.BUFFER_CREATED, (_e, d) => { tracks = bufferTracks(d); });
            hls.on(Hls.Events.ERROR, (_e, d) => {
                errors.push({ type: String(d?.type || '').slice(0, 40), details: String(d?.details || '').slice(0, 60), fatal: !!d?.fatal });
                if (errors.length > MAX_ERRORS) errors = errors.slice(-MAX_ERRORS);
            });
        },
        native() { player = 'native'; },
        noteAutoplay(text) { autoplay = String(text).slice(0, 60); },
        started() {
            if (sent) return;
            sent = true;
            const g = gen;
            report('start', g);
            later = setTimeout(() => report('later', g), delayMs);
        },
        stop() { gen++; clearTimeout(later); later = null; },
    };
}
