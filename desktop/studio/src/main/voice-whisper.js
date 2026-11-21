'use strict';
/*
 * Voice commands (0.2.12): voice activity detection, then Whisper, then matching against the enabled phrases.
 * Replaces Windows' System.Speech recogniser (voice.js), which has no real voice activity detection and forced clicks and
 * game sounds onto the nearest phrase with high confidence. voice.js stays as the last resort when Whisper cannot run.
 *
 *   createWhisperVoice({ vad, recogniser, getSettings, onPhrase, onLog, onStatus, isEnabled, now, logger, segmenterOptions })
 *     vad          { load(), prob(Float32Array(512)) -> Promise<0..1>, reset() }       (voice-vad.js createSileroVad)
 *     recogniser   { start({ prefer, onProgress }), transcribe(Float32Array, { prompt }), stop(), status() }
 *                                                                                    (whisper-engine.js)
 *   The same calls as voice.js, so main.js can use either:
 *     setPhrases(list), start(), stop(), refresh(), feed(buf 16 kHz 16-bit mono), setHeld(bool), status(), command(text),
 *     phrases, held
 *   plus tap()   push-to-talk by a single press (a Stream Deck Hotkey button sends a press, not a hold): listen until the
 *                next stretch of speech ends, or TAP_MS
 *   and (0.2.13) capture(fn) / endCapture()   training: while a capture is on, every speech segment goes through the same
 *                voice detector and Whisper (same prompt) as live use, but to fn({ kind: 'take', text, samples, asrMs,
 *                vad }) or fn({ kind: 'short', vad }) instead of the matcher: nothing runs, nothing is logged, and the mode
 *                (push to talk, wake phrase) does not gate it
 *
 * Each command can carry (0.2.13) aliases ([{ text, count }]: how Whisper wrote it when the streamer said it) and
 * negatives ([{ text }]: things they said that were not it); voice-match.js scoreCommand uses both, and the most frequent
 * aliases go into Whisper's prompt after the phrases.
 *
 * Modes (settings.mode):
 *   always   every speech segment is checked
 *   wake     a segment counts only if it starts with the wake phrase (settings.wakePhrase, default "hey studio"); the
 *            command can follow in the same breath ("hey studio, pokeycheck") or within WAKE_WINDOW_MS after it
 *   ptt      audio is used only while the key is held (or after a tap); releasing it ends the segment at once
 *
 * Every segment that reaches a decision goes to onLog({ t, heard, phrase, confidence, threshold, outcome, automationId,
 * vad: { speechMs, segmentMs, prob }, engine, asrMs, latencyMs, how, closest, closestAutomationId, via, alias }), outcome one of:
 *   fired      the transcript matched a command at or above its threshold, not cooling down: onPhrase({ text, confidence })
 *   below      the closest command scored under its threshold (but at least NEAR)
 *   cooldown   the matched command ran less than its wait ago
 *   disabled   the matched command's automation is turned off
 *   noise      speech that is no command (or Whisper heard no words)
 *   short      local only: the voice detector dropped it before Whisper: a burst too short to be speech (a click, a key,
 *              a bang), or, with vad.reason 'unclear', sound that was not clearly a voice (music); never sent
 *   nowake     local only: wake mode, speech without the wake phrase
 *   wake       local only: the wake phrase on its own; listening for a command for a few seconds
 * `confidence` is how close the words were to the phrase (0..1), `threshold` the score it had to reach; `closest` and
 * closestAutomationId the command it was closest to (also for "noise"), `via` 'phrase' or 'alias' and `alias` the alias that
 * matched (0.2.13). latencyMs is the
 * time from the end of speech (the last voiced frame) to the decision.
 * The words (`heard`) of speech that matched no command are kept only while settings.logAllSpeech is on.
 */
const { createSegmenter, FRAME } = require('./voice-vad');
const { matchCommands, stripWake, biasPrompt, normalise } = require('./voice-match');

const MAX_ALIASES = 50;
const MAX_NEGATIVES = 100;
/** Aliases ({ text, count }, most frequent first) or negatives ({ text }): normalised, no repeats, capped. Text only. */
function cleanExamples(list, max, withCount) {
    const out = [];
    const seen = new Set();
    for (const x of Array.isArray(list) ? list : []) {
        const t = normalise(typeof x === 'string' ? x : x?.text).slice(0, 100);
        if (!t || seen.has(t) || out.length >= max) continue;
        seen.add(t);
        const n = Number(x?.count);
        out.push(withCount ? { text: t, count: Number.isInteger(n) && n > 0 ? Math.min(1000, n) : 1 } : { text: t });
    }
    return withCount ? out.sort((a, b) => b.count - a.count) : out;
}

const REPEAT_MS = 1500;
const COOLDOWN_DEFAULT_MS = 10000;
const COOLDOWN_MAX_MS = 3600 * 1000;
const MATCH_DEFAULT = 0.8;
const MATCH_MIN = 0.5;
const MATCH_MAX = 0.98;
const NEAR = 0.55;             // a best score under this is not "below" a command, it is just other speech
const WAKE_WINDOW_MS = 6000;
const TAP_MS = 8000;
const MAX_QUEUE = 3;
// Whisper's stock outputs for silence or noise; never a command
const NON_SPEECH = /^(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+|you|thank you|thanks for watching|bye|music|music plays|applause)$/i;

function clampMatch(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return MATCH_DEFAULT;
    return Math.max(MATCH_MIN, Math.min(MATCH_MAX, Math.round(n * 100) / 100));
}

function cleanPhrase(p) { return String(p ?? '').replace(/\s+/g, ' ').trim().slice(0, 100); }

function normaliseCommand(c) {
    const o = typeof c === 'string' ? { text: c } : (c && typeof c === 'object' ? c : {});
    const text = cleanPhrase(o.text);
    if (!text || !normalise(text)) return null;
    const conf = o.confidence === null || o.confidence === undefined || o.confidence === '' ? null : Number(o.confidence);
    const cd = o.cooldownMs === null || o.cooldownMs === undefined || o.cooldownMs === '' ? NaN : Number(o.cooldownMs);
    const id = Number(o.automationId);
    return {
        text,
        key: text.toLowerCase(),
        confidence: conf !== null && Number.isFinite(conf) && conf > 0 ? clampMatch(conf) : null,
        cooldownMs: Number.isFinite(cd) && cd >= 0 ? Math.min(COOLDOWN_MAX_MS, Math.round(cd)) : COOLDOWN_DEFAULT_MS,
        automationId: Number.isInteger(id) && id > 0 ? id : null,
        aliases: cleanExamples(o.aliases, MAX_ALIASES, true),
        negatives: cleanExamples(o.negatives, MAX_NEGATIVES, false),
    };
}

function createWhisperVoice({ vad, recogniser, getSettings = () => ({}), onPhrase = () => {}, onLog = () => {}, onStatus = () => {}, isEnabled = () => true, now = () => Date.now(), logger = null, segmenterOptions = {} }) {
    let commands = new Map();          // key -> command
    let state = 'off';
    let error = null;
    let lastHeard = null;
    let wanted = false;
    let held = false;
    let tapUntil = 0;
    let wakeUntil = 0;
    let carry = new Float32Array(0);
    let feeding = Promise.resolve();
    let queue = 0;
    let startSeq = 0;
    let engineInfo = null;
    let capturing = null;              // training (0.2.13): where each take goes
    const lastAccepted = new Map();
    const seg = createSegmenter(segmenterOptions);
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[voice] ${m}`, meta); } catch { /* ignore */ } };

    function status() {
        const r = recogniser.status ? recogniser.status() : {};
        return { state, error, lastHeard, phrases: commands.size, catchAll: null, engine: engineInfo ? `whisper-${engineInfo.device}` : null,
            device: engineInfo?.device || null, gpuName: engineInfo?.gpuName || null, model: engineInfo?.model || null, progress: r.progress || null, wakeOpen: wakeUntil > now(), gpuFailed: r.gpuFailed || null, training: !!capturing };
    }
    function set(s, e = null) { state = s; error = e; try { onStatus(status()); } catch { /* ignore */ } }
    function emit(entry) { try { onLog(entry); } catch { /* ignore */ } }

    async function launch() {
        const my = ++startSeq;
        if (!commands.size) { set('error', 'There are no voice commands yet. Add a Voice command trigger to an automation on the dashboard.'); return; }
        set('starting');
        try {
            await vad.load();
            const info = await recogniser.start({ prefer: getSettings().engine === 'cpu' ? 'cpu' : 'auto', onProgress: () => { if (my === startSeq) { try { onStatus(status()); } catch { /* ignore */ } } } });
            if (my !== startSeq || !wanted) return;
            engineInfo = info;
            vad.reset();
            seg.reset();
            carry = new Float32Array(0);
            set('listening');
            log('info', 'listening', { device: info.device, model: info.model, phrases: commands.size });
        } catch (e) {
            if (my !== startSeq || e.code === 'cancelled') return;
            log('warn', 'speech engine could not start', { error: e.code || e.message });
            set('error', e.message || 'Voice commands could not start on this PC.');
            try { onEngineFailed(e); } catch { /* ignore */ }
        }
    }
    let onEngineFailed = () => {};

    function listeningNow() {
        if (state !== 'listening') return false;
        if (capturing) return true;
        const mode = getSettings().mode;
        if (mode === 'ptt') return held || tapUntil > now();
        return true;
    }

    async function onFrame(frame, at) {
        const p = await vad.prob(frame);
        const r = seg.push(frame, p, at);
        if (r) handleSegment(r);
    }

    function handleSegment(r) {
        const t = now();
        const vadInfo = { speechMs: r.speechMs, segmentMs: r.segmentMs ?? null, prob: r.prob };
        if (r.type === 'short' || r.type === 'unclear') {
            if (r.type === 'unclear') vadInfo.reason = 'unclear';
            if (capturing) { try { capturing({ kind: 'short', vad: vadInfo }); } catch { /* ignore */ } return; }
            emit({ t, heard: null, phrase: null, confidence: null, threshold: null, outcome: 'short', automationId: null, vad: vadInfo, engine: null, asrMs: null, latencyMs: null });
            return;
        }
        if (tapUntil && getSettings().mode === 'ptt' && !held) tapUntil = 0;   // a tap listens for one stretch of speech
        if (queue >= MAX_QUEUE) { log('info', 'speech dropped: recogniser busy'); return; }
        queue += 1;
        const prompt = promptNow();
        const take = capturing;
        recogniser.transcribe(r.samples, { prompt })
            .then((asr) => {
                if (!take) return decide(asr, r, vadInfo);
                if (take === capturing) take({ kind: 'take', text: cleanPhrase(asr.text).slice(0, 200), samples: r.samples, asrMs: asr.ms ?? null, vad: vadInfo });
                return null;
            })
            .catch((e) => { log('warn', 'transcription failed', { error: e.code || e.message }); })
            .finally(() => { queue -= 1; });
    }

    const wakeText = () => cleanPhrase(getSettings().wakePhrase) || 'hey studio';
    /** Whisper's prompt: the wake phrase (wake mode), the phrases, then the most frequent aliases of all commands (0.2.13). */
    function promptNow() {
        const cmds = [...commands.values()];
        const aliases = cmds.flatMap((c) => c.aliases || []).sort((a, b) => b.count - a.count);
        return biasPrompt([...(getSettings().mode === 'wake' && !capturing ? [wakeText()] : []), ...cmds.map((c) => c.text)], aliases);
    }

    function decide(asr, r, vadInfo) {
        const settings = getSettings();
        const t = now();
        const raw = cleanPhrase(asr.text).slice(0, 200);
        const words = normalise(raw);
        const base = { t, vad: vadInfo, engine: engineInfo ? `whisper-${engineInfo.device}` : 'whisper', asrMs: asr.ms ?? null, latencyMs: Math.max(0, t - r.endAt) };
        const keepWords = (s) => (settings.logAllSpeech ? s || null : null);
        const noSpeech = Number.isFinite(asr.noSpeech) && asr.noSpeech > 0.8 && Number.isFinite(asr.avgLogprob) && asr.avgLogprob < -0.8;
        if (!words || NON_SPEECH.test(raw.replace(/[.!?,]+$/g, '').trim()) || noSpeech) {
            return finish({ ...base, heard: keepWords(raw), phrase: null, confidence: null, threshold: null, outcome: 'noise', automationId: null });
        }
        let text = raw;
        if (settings.mode === 'wake') {
            const w = stripWake(raw, wakeText());
            if (w.found) {
                if (!w.rest) { wakeUntil = t + WAKE_WINDOW_MS; return finish({ ...base, heard: raw, phrase: null, confidence: null, threshold: null, outcome: 'wake', automationId: null }); }
                text = w.rest;
            } else if (wakeUntil > t) {
                wakeUntil = 0;
            } else {
                return finish({ ...base, heard: keepWords(raw), phrase: null, confidence: null, threshold: null, outcome: 'nowake', automationId: null });
            }
        }
        const { best } = matchCommands(text, [...commands.values()]);
        // the closest command, also for speech that is not one (0.2.13: the voice log offers "This was ...")
        const near = best ? { closest: best.cmd.text, closestAutomationId: best.cmd.automationId, via: best.via, alias: best.alias || null } : { closest: null, closestAutomationId: null };
        if (!best || best.score < NEAR) return finish({ ...base, ...near, heard: keepWords(raw), phrase: null, confidence: best ? best.score : null, threshold: null, outcome: 'noise', automationId: null });
        const cmd = best.cmd;
        const threshold = cmd.confidence ?? clampMatch(settings.matchThreshold);
        const key = cmd.automationId ? `a:${cmd.automationId}` : `p:${cmd.key}`;
        let outcome = 'fired';
        if (cmd.automationId && isEnabled(cmd.automationId) === false) outcome = 'disabled';
        else if (best.score < threshold) outcome = 'below';
        else {
            const prev = lastAccepted.get(key);
            if (prev !== undefined && t - prev < Math.max(REPEAT_MS, cmd.cooldownMs ?? COOLDOWN_DEFAULT_MS)) outcome = 'cooldown';
        }
        if (outcome === 'fired') {
            lastAccepted.set(key, t);
            if (lastAccepted.size > 2000) lastAccepted.clear();
            try { onPhrase({ text: cmd.text, confidence: best.score }); } catch { /* ignore */ }
        }
        // words close to a command are shown; words of a miss only with "log all speech"
        const heard = outcome === 'below' ? keepWords(raw) : raw;
        return finish({ ...base, ...near, heard, phrase: cmd.text, confidence: best.score, threshold, outcome, automationId: cmd.automationId, how: best.how, latencyMs: Math.max(0, now() - r.endAt) });
    }

    function finish(entry) {
        lastHeard = { text: entry.heard, confidence: entry.confidence, accepted: entry.outcome === 'fired', outcome: entry.outcome, phrase: entry.phrase, t: entry.t };
        emit(entry);
        try { onStatus(status()); } catch { /* ignore */ }
        return entry;
    }

    function stopAll() {
        startSeq += 1;
        held = false; tapUntil = 0; wakeUntil = 0;
        seg.reset();
        carry = new Float32Array(0);
        try { recogniser.stop(); } catch { /* ignore */ }
        engineInfo = null;
    }

    return {
        setPhrases(list) {
            const map = new Map();
            for (const c of Array.isArray(list) ? list : []) {
                const n = normaliseCommand(c);
                if (n && !map.has(n.key) && map.size < 500) map.set(n.key, n);
            }
            const before = JSON.stringify([...commands.values()]);
            commands = map;
            const changed = before !== JSON.stringify([...map.values()]);
            if (wanted && state === 'error' && map.size) launch();
            if (wanted && !map.size) set('error', 'There are no voice commands yet. Add a Voice command trigger to an automation on the dashboard.');
            return changed;
        },
        refresh() { return false; },
        command(text) { const c = commands.get(cleanPhrase(text).toLowerCase()); return c ? { ...c } : null; },
        start() { if (wanted && (state === 'listening' || state === 'starting')) return; wanted = true; launch(); },
        stop() { wanted = false; stopAll(); set('off'); },
        /** Restart the recogniser (engine setting changed). */
        restart() { if (!wanted) return; stopAll(); launch(); },
        feed(chunk) {
            if (!listeningNow()) {
                // a tap that ran out mid-speech: end that segment, after the frames already queued
                if (seg.active && getSettings().mode === 'ptt') feeding = feeding.then(() => { if (seg.active) { const r = seg.flush(now()); if (r) handleSegment(r); } });
                return false;
            }
            const at = now();
            const n = Math.floor(chunk.length / 2);
            const f = new Float32Array(carry.length + n);
            f.set(carry, 0);
            for (let i = 0; i < n; i++) f[carry.length + i] = chunk.readInt16LE(i * 2) / 32768;
            let off = 0;
            const frames = [];
            while (off + FRAME <= f.length) { frames.push(f.slice(off, off + FRAME)); off += FRAME; }
            carry = f.slice(off);
            feeding = feeding.then(async () => { for (const fr of frames) { if (state !== 'listening') return; await onFrame(fr, at); } }).catch((e) => log('warn', 'voice detector failed', { error: e.message }));
            return true;
        },
        setHeld(v) {
            const was = held;
            held = !!v;
            if (held && !was) tapUntil = 0;
            if (was && !held) {
                // release: whatever was being said ends now; the frames still in the voice detector's queue go first
                feeding = feeding.then(() => { const r = seg.flush(now()); if (r) handleSegment(r); });
            }
        },
        tap() { if (state === 'listening') { tapUntil = now() + TAP_MS; seg.reset(); } },
        /** Training (0.2.13): speech segments go to fn instead of the matcher until endCapture(). True when listening. */
        capture(fn) { capturing = typeof fn === 'function' ? fn : null; seg.reset(); return state === 'listening'; },
        endCapture() { capturing = null; seg.reset(); },
        get capturing() { return !!capturing; },
        /** The prompt Whisper gets now. */
        prompt: () => promptNow(),
        /** The commands as the matcher sees them (with aliases and negatives). */
        commandList: () => [...commands.values()].map((c) => ({ ...c, aliases: c.aliases.slice(), negatives: c.negatives.slice() })),
        status,
        set onEngineFailed(fn) { onEngineFailed = typeof fn === 'function' ? fn : () => {}; },
        get phrases() { return [...commands.values()].map((c) => c.text); },
        get held() { return held || tapUntil > now(); },
        /** for tests: wait until queued frames and transcriptions are done */
        async idle() { await feeding; for (let i = 0; i < 200 && queue > 0; i++) await new Promise((r) => setTimeout(r, 10)); },
    };
}

module.exports = { createWhisperVoice, clampMatch, normaliseCommand, cleanExamples, MAX_ALIASES, MAX_NEGATIVES, MATCH_DEFAULT, MATCH_MIN, MATCH_MAX, NEAR, WAKE_WINDOW_MS, TAP_MS, COOLDOWN_DEFAULT_MS };
