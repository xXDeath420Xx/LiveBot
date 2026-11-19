'use strict';
/*
 * Voice commands: offline phrase recognition on this PC.
 *
 * Recogniser: Windows' built-in desktop speech recogniser (System.Speech, part of .NET Framework on every Windows 10
 * and 11; no download, no internet, no account), driven by src/voice/speech-helper.ps1 in Windows PowerShell 5.1, which
 * is also on every Windows 10/11 PC. It only listens for the phrases in its grammar (the Voice command triggers set on
 * the dashboard), the same approach Streamer.bot uses. Windows.Media.SpeechRecognition was not used: in a desktop app it
 * needs package identity and its free-form recogniser is the online one.
 *
 * Audio: the hidden audio window captures the chosen input device (getUserMedia), converts it to 16 kHz 16-bit mono and
 * hands it to this module, which writes it to the helper's stdin. Nothing is recorded or saved, and no audio leaves the
 * PC; only the matched phrase text is sent to CertiFried (as a voice.phrase event).
 *
 *   createVoice({ helperPath, spawnImpl, tmpDir, logger, getSettings, onPhrase, onStatus, now })
 *     setPhrases(list)    the phrases to listen for (restarts the helper when it changed)
 *     start() / stop()    the helper; the caller starts and stops the microphone
 *     feed(buf)           16 kHz 16-bit mono PCM; ignored unless listening (always-on) or the push-to-talk key is held
 *     setHeld(bool)       push-to-talk key down/up; on release a short silence lets the last phrase finish
 *     status()            { state: off|starting|listening|error, error, lastHeard, phrases }
 *
 * A phrase counts when its confidence is at or above settings.threshold (0.5–0.95, default 0.7) and the same phrase
 * was not accepted in the last 1.5 s.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');

const RELEASE_SILENCE = Buffer.alloc(16000 * 2 / 2);   // 0.5 s
const REPEAT_MS = 1500;
const ERRORS = {
    no_recognizer: 'Windows has no speech recogniser for any installed language. Add a language with speech support in Windows Settings, Time and language, Speech.',
    no_phrases: 'There are no voice commands yet. Add a Voice command trigger to an automation on the dashboard.',
};

function cleanPhrase(p) { return String(p ?? '').replace(/\s+/g, ' ').trim().slice(0, 100); }

function createVoice({ helperPath, spawnImpl = defaultSpawn, tmpDir, logger = null, getSettings = () => ({}), onPhrase = () => {}, onStatus = () => {}, now = () => Date.now() }) {
    let phrases = [];
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
    function status() { return { state, error, lastHeard, phrases: phrases.length }; }

    function launch() {
        if (!phrases.length) { set('error', ERRORS.no_phrases); return; }
        const grammar = path.join(tmpDir, 'voice-phrases.json');
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(grammar, JSON.stringify(phrases), 'utf8');
        set('starting');
        const p = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-GrammarFile', grammar],
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
        if (m.type === 'ready') { set('listening'); log('info', 'listening', { culture: m.culture, phrases: m.phrases }); return; }
        if (m.type === 'error') { set('error', ERRORS[m.message] || 'Voice commands could not start on this PC.'); log('warn', 'voice helper error', { error: m.message }); return; }
        if (m.type !== 'recognized') return;
        const text = cleanPhrase(m.text);
        const confidence = Number(m.confidence) || 0;
        const threshold = Math.max(0.5, Math.min(0.95, Number(getSettings().threshold) || 0.7));
        const t = now();
        let accepted = confidence >= threshold;
        const prev = lastAccepted.get(text.toLowerCase());
        if (accepted && prev !== undefined && t - prev < REPEAT_MS) accepted = false;
        lastHeard = { text, confidence, accepted, t };
        if (accepted) {
            lastAccepted.set(text.toLowerCase(), t);
            try { onPhrase({ text, confidence }); } catch { /* ignore */ }
        }
        try { onStatus(status()); } catch { /* ignore */ }
    }

    function stopProc() {
        const p = proc;
        proc = null;
        if (!p) return;
        try { p.stdin.end(); } catch { /* ignore */ }
        setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 2000).unref?.();
    }

    return {
        setPhrases(list) {
            const next = [...new Set((list || []).map(cleanPhrase).filter(Boolean).map((s) => s.toLowerCase()))].slice(0, 500);
            const changed = JSON.stringify(next) !== JSON.stringify(phrases);
            phrases = next;
            if (changed && wanted) { stopProc(); launch(); }
            return changed;
        },
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

module.exports = { createVoice, cleanPhrase, ERRORS };
