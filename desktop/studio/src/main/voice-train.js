'use strict';
/*
 * Voice commands 0.2.13: "Teach Studio how you say it". One command at a time, the streamer says its phrase a few times
 * (8 unless they pick another number); each take goes through the voice detector and Whisper exactly as in live use
 * (voice-whisper.js capture()), and nothing runs while they do it.
 *
 *   createVoiceTrainer({ voice, getCommand, getNegatives, learn, recordingsDir, keepRecordings, wavBytes, onUpdate, now })
 *     voice          the Whisper voice (capture(fn) / endCapture())
 *     getCommand(k)  the command (voice-whisper normaliseCommand shape, with aliases and negatives) by its key
 *     getNegatives(cmd)  texts that were not this command: the voice log's "not a command" lines and other commands' lines
 *     learn(cmd, { aliases, confidence, takes })  saves to CertiFried (voice.learn); resolves what the server kept
 *     keepRecordings()   the "keep recordings" box (off by default): only then is a take's audio written, as a WAV in
 *                        recordingsDir; otherwise the audio is never written and is gone once Whisper has written it down
 *
 *   start({ key, takes })   begin (or begin again) for one command
 *   stop()                  stop listening; the takes stay for review
 *   resume()                listen for more takes
 *   deleteTake(id)          drop a bad take (and its recording)
 *   save()                  every good take becomes a "heard as" alias, and the command's own threshold is set from them
 *   cancel()                throw the takes away (recordings the person chose to keep stay)
 *   view()                  for the Voice tab: { key, phrase, automationName, want, state, takes, calibration, note }
 *                           state: listening | review | saving | off
 *
 * Calibration is voice-match.js calibrate(): a margin below the lowest good take, floored at 60%, and above how this command
 * scores against ordinary speech when every take still passes; otherwise the overlap is shown so a take can be deleted.
 */
const fs = require('node:fs');
const path = require('node:path');
const { normalise, scorePhrase, calibrate } = require('./voice-match');

const TAKES_DEFAULT = 8;
const TAKES_MIN = 3;
const TAKES_MAX = 20;
// Whisper's stock words for silence or noise; a take that is only this is not a take
const EMPTY = /^(you|thank you|thanks for watching|bye|music|music plays|applause|blank audio)$/;

function clampTakes(n) {
    const v = Math.round(Number(n));
    return Number.isFinite(v) ? Math.max(TAKES_MIN, Math.min(TAKES_MAX, v)) : TAKES_DEFAULT;
}

function createVoiceTrainer({ voice, getCommand, getNegatives = () => [], learn, recordingsDir = null, keepRecordings = () => false, wavBytes = null, onUpdate = () => {}, now = () => Date.now(), logger = null }) {
    let s = null;   // { key, want, state, takes: [], note, seq }
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[voice-train] ${m}`, meta); } catch { /* ignore */ } };

    const goodTakes = () => (s ? s.takes.filter((t) => t.ok) : []);

    function calibration() {
        const cmd = s && getCommand(s.key);
        const good = goodTakes();
        if (!cmd || !good.length) return null;
        const c = calibrate({ cmd, takes: good.map((t) => t.text), negatives: getNegatives(cmd) || [] });
        good.forEach((t, i) => { t.phraseScore = c.perTake[i]?.phraseScore ?? null; t.score = c.perTake[i]?.score ?? null; });
        return { threshold: c.threshold, lowest: c.lowest, negMax: c.negMax, overlaps: c.overlaps, raised: c.raised, enough: good.length >= 2 };
    }

    function view() {
        if (!s) return null;
        const cmd = getCommand(s.key);
        const cal = calibration();
        return {
            key: s.key, phrase: cmd?.text || s.phrase, automationId: cmd?.automationId || null, want: s.want, state: s.state, note: s.note || null,
            good: goodTakes().length,
            takes: s.takes.map((t) => ({ id: t.id, text: t.text, ok: t.ok, reason: t.reason || null, phraseScore: t.phraseScore ?? null, score: t.score ?? null, kept: !!t.file })),
            calibration: cal, keepRecordings: !!keepRecordings(),
        };
    }
    const update = () => { try { onUpdate(view()); } catch { /* ignore */ } };

    function removeFile(t) {
        if (!t?.file) return;
        try { fs.rmSync(t.file, { force: true }); } catch { /* ignore */ }
        t.file = null;
    }

    function saveRecording(samples) {
        if (!keepRecordings() || !recordingsDir || !wavBytes || !samples?.length) return null;
        try {
            const cmd = getCommand(s.key);
            const dir = path.join(recordingsDir, String(cmd?.automationId || 'command').replace(/[^0-9a-z_-]/gi, '_'));
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${s.seq}.wav`);
            fs.writeFileSync(file, wavBytes(samples));
            return file;
        } catch (e) {
            log('warn', 'recording not kept', { error: e.message });
            return null;
        }
    }

    function onTake(x) {
        if (!s || s.state !== 'listening') return;
        if (x.kind === 'short') { s.note = 'That was too short to be speech. Say the whole phrase.'; update(); return; }
        s.seq += 1;
        const norm = normalise(x.text);
        const ok = !!norm && !EMPTY.test(norm);
        const take = { id: `${now()}-${s.seq}`, text: ok ? norm : (norm || null), ok, reason: ok ? null : 'No words heard', phraseScore: ok ? scorePhrase(norm, getCommand(s.key)?.text).score : null, score: null, file: null };
        if (ok) take.file = saveRecording(x.samples);
        s.takes.push(take);
        s.note = null;
        if (goodTakes().length >= s.want) { voice.endCapture(); s.state = 'review'; }
        update();
    }

    function listen() {
        const listening = voice.capture(onTake);
        if (!listening) { voice.endCapture(); throw Object.assign(new Error('Turn on "Listen for voice commands" (with Whisper) first, then try again.'), { code: 'not_listening' }); }
        s.state = 'listening';
    }

    return {
        view,
        start({ key, takes } = {}) {
            const cmd = getCommand(String(key || ''));
            if (!cmd) throw Object.assign(new Error('That command is not in Studio\'s list. Click Refresh and try again.'), { code: 'not_found' });
            if (!cmd.automationId) throw Object.assign(new Error('Click Refresh first, so Studio knows which automation this phrase belongs to.'), { code: 'no_automation' });
            if (s) this.cancel();
            s = { key: cmd.key, phrase: cmd.text, want: clampTakes(takes), state: 'off', takes: [], note: null, seq: 0 };
            listen();
            log('info', 'training started', { automationId: cmd.automationId, want: s.want });
            update();
            return view();
        },
        stop() { if (!s) return null; voice.endCapture(); s.state = goodTakes().length ? 'review' : 'off'; if (s.state === 'off') s = null; update(); return view(); },
        resume() {
            if (!s) throw Object.assign(new Error('Start again from the command list.'), { code: 'no_session' });
            if (goodTakes().length >= s.want) s.want = Math.min(TAKES_MAX, goodTakes().length + 2);
            listen();
            update();
            return view();
        },
        deleteTake(id) {
            if (!s) return null;
            const i = s.takes.findIndex((t) => t.id === id);
            if (i >= 0) { removeFile(s.takes[i]); s.takes.splice(i, 1); }
            update();
            return view();
        },
        async save() {
            if (!s) throw Object.assign(new Error('There is nothing to save.'), { code: 'no_session' });
            const good = goodTakes();
            if (good.length < 2) throw Object.assign(new Error('Record at least two good takes first.'), { code: 'too_few' });
            const cmd = getCommand(s.key);
            if (!cmd) throw Object.assign(new Error('That command is no longer in Studio\'s list.'), { code: 'not_found' });
            const cal = calibration();
            voice.endCapture();
            s.state = 'saving';
            update();
            try {
                // every take, repeats included: the server counts how often each way came up (the most frequent go into Whisper's prompt)
                const aliases = good.map((t) => t.text);
                const r = await learn(cmd, { aliases, confidence: cal?.threshold ?? null, takes: good.length });
                log('info', 'training saved', { automationId: cmd.automationId, takes: good.length, aliases: aliases.length, threshold: cal?.threshold });
                const out = { aliases: new Set(aliases).size, threshold: cal?.threshold ?? null, overlaps: cal?.overlaps?.length || 0, kept: good.filter((t) => t.file).length, server: r || null };
                s = null;
                update();
                return out;
            } catch (e) {
                s.state = 'review';
                update();
                throw e;
            }
        },
        cancel() {
            if (!s) return null;
            voice.endCapture();
            // a cancelled session keeps only recordings the person asked to keep
            if (!keepRecordings()) for (const t of s.takes) removeFile(t);
            s = null;
            update();
            return null;
        },
        get active() { return !!s && s.state === 'listening'; },
    };
}

module.exports = { createVoiceTrainer, clampTakes, TAKES_DEFAULT, TAKES_MIN, TAKES_MAX };
