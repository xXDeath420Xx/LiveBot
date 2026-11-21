'use strict';
/*
 * Voice commands: offline phrase recognition on this PC.
 *
 * Recogniser: Windows' built-in desktop speech recogniser (System.Speech, part of .NET Framework on every Windows 10
 * and 11; no download, no internet, no account), driven by src/voice/speech-helper.ps1 in Windows PowerShell 5.1, which
 * is also on every Windows 10/11 PC. It listens for the phrases in its "commands" grammar (the Voice command triggers set
 * on the dashboard) plus a catch-all grammar (0.2.10) that takes any other speech, so ordinary talk is no longer forced
 * onto the nearest command. Windows.Media.SpeechRecognition was not used: in a desktop app it needs package identity and
 * its free-form recogniser is the online one.
 *
 * Audio: the hidden audio window captures the chosen input device (getUserMedia), converts it to 16 kHz 16-bit mono and
 * hands it to this module, which writes it to the helper's stdin. Nothing is recorded or saved, and no audio leaves the
 * PC; only the matched phrase text is sent to CertiFried (as a voice.phrase event).
 *
 *   createVoice({ helperPath, spawnImpl, tmpDir, logger, getSettings, onPhrase, onLog, onStatus, isEnabled, now })
 *     setPhrases(list)    the commands to listen for: strings, or { text, confidence, cooldownMs, automationId }
 *                         (confidence: this command's own setting instead of the global one, or null; cooldownMs: how long
 *                         after it fired before it can fire again, default 10 s). Restarts the helper when the phrases changed.
 *     start() / stop()    the helper; the caller starts and stops the microphone
 *     refresh()           restart the helper when the catch-all changed (settings.logAllSpeech)
 *     feed(buf)           16 kHz 16-bit mono PCM; ignored unless listening (always-on) or the push-to-talk key is held
 *     setHeld(bool)       push-to-talk key down/up; on release a short silence lets the last phrase finish
 *     status()            { state: off|starting|listening|error, error, lastHeard, phrases, catchAll }
 *
 * Every result goes to onLog({ t, heard, phrase, confidence, threshold, outcome, automationId }), outcome one of:
 *   fired     from the commands grammar, at or above its threshold, not cooling down: onPhrase({ text, confidence }) runs
 *   below     from the commands grammar but under the threshold (the command's own, else settings.threshold)
 *   cooldown  the same command fired less than its cooldown ago
 *   noise     the catch-all won: not a command. `heard` holds the words only while settings.logAllSpeech is on (the
 *             dictation catch-all); otherwise it is null and the words are never kept.
 *   disabled  a phrase of an automation that is turned off (isEnabled(automationId) answers false)
 * Global threshold: 0.2 to 0.95, default 0.7. Studio's engine scores differently from Streamer.bot's, so Streamer.bot's
 * usual 0.2 is far too low here (at 0.2 it fired BRB five times in ten minutes without anyone saying it).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');

const RELEASE_SILENCE = Buffer.alloc(16000 * 2 / 2);   // 0.5 s
const REPEAT_MS = 1500;               // never twice within this, whatever the cooldown
const COOLDOWN_DEFAULT_MS = 10000;
const COOLDOWN_MAX_MS = 3600 * 1000;
const OUTCOMES = Object.freeze(['fired', 'below', 'cooldown', 'noise', 'disabled']);
const ERRORS = {
    no_recognizer: 'Windows has no speech recogniser for any installed language. Add a language with speech support in Windows Settings, Time and language, Speech.',
    no_phrases: 'There are no voice commands yet. Add a Voice command trigger to an automation on the dashboard.',
};

const THRESHOLD_MIN = 0.2;
const THRESHOLD_MAX = 0.95;
const THRESHOLD_DEFAULT = 0.7;
/** A confidence setting as a number from 0.2 to 0.95 (the default when it is not a number). Steps of 0.05 are the slider's. */
function clampThreshold(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return THRESHOLD_DEFAULT;
    return Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, Math.round(n * 100) / 100));
}

function cleanPhrase(p) { return String(p ?? '').replace(/\s+/g, ' ').trim().slice(0, 100); }

/** One command as given to setPhrases: a phrase string, or an object with its own confidence and cooldown. */
function normaliseCommand(c) {
    const o = typeof c === 'string' ? { text: c } : (c && typeof c === 'object' ? c : {});
    const text = cleanPhrase(o.text).toLowerCase();
    if (!text) return null;
    const conf = o.confidence === null || o.confidence === undefined || o.confidence === '' ? null : Number(o.confidence);
    const cd = o.cooldownMs === null || o.cooldownMs === undefined || o.cooldownMs === '' ? NaN : Number(o.cooldownMs);
    const id = Number(o.automationId);
    return {
        text,
        confidence: conf !== null && Number.isFinite(conf) && conf > 0 ? clampThreshold(conf) : null,
        cooldownMs: Number.isFinite(cd) && cd >= 0 ? Math.min(COOLDOWN_MAX_MS, Math.round(cd)) : COOLDOWN_DEFAULT_MS,
        automationId: Number.isInteger(id) && id > 0 ? id : null,
    };
}

function createVoice({ helperPath, spawnImpl = defaultSpawn, tmpDir, logger = null, getSettings = () => ({}), onPhrase = () => {}, onLog = () => {}, onStatus = () => {}, isEnabled = () => true, now = () => Date.now() }) {
    let phrases = [];
    let commands = new Map();   // phrase -> { text, confidence, cooldownMs, automationId }
    let requested = null;       // the catch-all the running helper was asked for
    let catchAll = null;        // the one it loaded (its ready line): garbage | dictation | none
    let proc = null;
    let state = 'off';
    let error = null;
    let lastHeard = null;
    let held = false;
    let blocked = false;      // stdin full: drop audio until it drains rather than buffer without limit
    let wanted = false;
    let restarts = [];
    const lastAccepted = new Map();
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[voice] ${m}`, meta); } catch { /* ignore */ } };

    function set(s, e = null) { state = s; error = e; try { onStatus(status()); } catch { /* ignore */ } }
    function status() { return { state, error, lastHeard, phrases: phrases.length, catchAll }; }
    const wantCatchAll = () => (getSettings().logAllSpeech ? 'dictation' : 'garbage');

    function launch() {
        if (!phrases.length) { set('error', ERRORS.no_phrases); return; }
        const grammar = path.join(tmpDir, 'voice-phrases.json');
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(grammar, JSON.stringify(phrases), 'utf8');
        requested = wantCatchAll();
        catchAll = null;
        set('starting');
        const p = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-GrammarFile', grammar, '-CatchAll', requested],
            { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        proc = p;
        blocked = false;
        let buf = '';
        p.stdout.setEncoding('utf8');
        p.stdout.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (line) handle(line);
            }
        });
        p.stderr.on('data', () => { /* PowerShell noise; errors come as JSON on stdout */ });
        p.stdin.on('error', () => { /* helper gone; exit handler deals with it */ });
        p.stdin.on('drain', () => { blocked = false; });
        p.on('exit', (code) => {
            if (proc !== p) return;
            proc = null;
            if (!wanted) { set('off'); return; }
            if (state === 'error') return;
            const t = now();
            restarts = restarts.filter((x) => t - x < 60000);
            if (restarts.length >= 3) { set('error', 'The voice helper keeps stopping. Turn voice commands off and on again.'); return; }
            restarts.push(t);
            log('warn', 'voice helper stopped; starting it again', { code });
            setTimeout(() => { if (wanted && !proc) launch(); }, 1000).unref?.();
        });
        p.on('error', (e) => { log('warn', 'voice helper could not start', { error: e.message }); set('error', 'Windows PowerShell could not be started for voice commands.'); });
    }

    function handle(line) {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        if (m.type === 'ready') { catchAll = m.catchAll || 'none'; set('listening'); log('info', 'listening', { culture: m.culture, phrases: m.phrases, catchAll }); return; }
        if (m.type === 'error') { set('error', ERRORS[m.message] || 'Voice commands could not start on this PC.'); log('warn', 'voice helper error', { error: m.message }); return; }
        if (m.type !== 'recognized') return;
        const settings = getSettings();
        const confidence = Math.max(0, Math.min(1, Number(m.confidence) || 0));
        const t = now();
        // A helper from before 0.2.10 sends no grammar name: everything it heard came from the commands grammar.
        if (m.grammar && m.grammar !== 'commands') {
            const words = settings.logAllSpeech && m.grammar === 'dictation' ? cleanPhrase(m.text) || null : null;
            lastHeard = { text: words, confidence, accepted: false, outcome: 'noise', t };
            emit({ t, heard: words, phrase: null, confidence, threshold: null, outcome: 'noise', automationId: null });
            try { onStatus(status()); } catch { /* ignore */ }
            return;
        }
        const text = cleanPhrase(m.text);
        const cmd = commands.get(text.toLowerCase()) || normaliseCommand(text);
        const threshold = cmd?.confidence ?? clampThreshold(settings.threshold);
        const key = cmd?.automationId ? `a:${cmd.automationId}` : `p:${text.toLowerCase()}`;
        let outcome = 'fired';
        if (cmd?.automationId && isEnabled(cmd.automationId) === false) outcome = 'disabled';
        else if (confidence < threshold) outcome = 'below';
        else {
            const prev = lastAccepted.get(key);
            if (prev !== undefined && t - prev < Math.max(REPEAT_MS, cmd?.cooldownMs ?? COOLDOWN_DEFAULT_MS)) outcome = 'cooldown';
        }
        const accepted = outcome === 'fired';
        lastHeard = { text, confidence, accepted, outcome, t };
        if (accepted) {
            lastAccepted.set(key, t);
            if (lastAccepted.size > 2000) lastAccepted.clear();
            try { onPhrase({ text, confidence }); } catch { /* ignore */ }
        }
        emit({ t, heard: text, phrase: text, confidence, threshold, outcome, automationId: cmd?.automationId ?? null });
        try { onStatus(status()); } catch { /* ignore */ }
    }

    function emit(entry) { try { onLog(entry); } catch { /* ignore */ } }

    function stopProc() {
        const p = proc;
        proc = null;
        if (!p) return;
        try { p.stdin.end(); } catch { /* ignore */ }
        setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 2000).unref?.();
    }

    return {
        setPhrases(list) {
            const map = new Map();
            for (const c of Array.isArray(list) ? list : []) {
                const n = normaliseCommand(c);
                if (n && !map.has(n.text) && map.size < 500) map.set(n.text, n);
            }
            const next = [...map.keys()];
            const changed = JSON.stringify(next) !== JSON.stringify(phrases);
            phrases = next;
            commands = map;
            if (changed && wanted) { stopProc(); launch(); }
            return changed;
        },
        refresh() {
            if (wanted && proc && requested !== wantCatchAll()) { stopProc(); launch(); return true; }
            return false;
        },
        command: (text) => { const c = commands.get(cleanPhrase(text).toLowerCase()); return c ? { ...c } : null; },
        start() { wanted = true; restarts = []; if (!proc) launch(); },
        stop() { wanted = false; held = false; stopProc(); set('off'); },
        feed(chunk) {
            if (!proc || state !== 'listening' || blocked) return false;
            if (getSettings().mode === 'ptt' && !held) return false;
            try { if (!proc.stdin.write(chunk)) blocked = true; } catch { return false; }
            return true;
        },
        setHeld(v) {
            const was = held;
            held = !!v;
            if (was && !held && proc && state === 'listening') { try { proc.stdin.write(RELEASE_SILENCE); } catch { /* ignore */ } }
        },
        status,
        get phrases() { return [...phrases]; },
        get held() { return held; },
    };
}

module.exports = { createVoice, cleanPhrase, clampThreshold, normaliseCommand, THRESHOLD_MIN, THRESHOLD_MAX, THRESHOLD_DEFAULT, COOLDOWN_DEFAULT_MS, OUTCOMES, ERRORS };
