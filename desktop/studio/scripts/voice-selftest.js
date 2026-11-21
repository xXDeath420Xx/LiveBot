'use strict';
/*
 * Voice self-test (0.2.12), run on a Windows PC from the Studio source folder:
 *
 *   node scripts/voice-selftest.js --data <dir> [--bin src/voice/whisper] [--device auto|cpu] [--out <dir>] [--fast]
 *
 * Builds two WAV files and plays each, at the pace of real time, through the same pipeline Studio uses
 * (voice-vad.js Silero VAD -> whisper-engine.js -> voice-whisper.js matching), as a file input instead of a microphone:
 *   phrases.wav  every command phrase below, spoken by each installed Windows voice (System.Speech, test/voice-synth.ps1),
 *                with clicks, key presses, noise bursts, game-style bangs and Windows sounds between them
 *   noise.wav    only the non-speech sounds, about a minute of them
 * Then prints, as JSON, what was heard and what fired, the latency from end of speech to each decision, and whether
 * the expectations held: every phrase fires its own command once, nothing fires during noise, and no click or noise
 * ever reaches Whisper. Exit code 0 when they all held. Nothing is recorded from a microphone.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createSileroVad } = require('../src/main/voice-vad');
const { createWhisperEngine } = require('../src/main/whisper-engine');
const { createWhisperVoice } = require('../src/main/voice-whisper');
const { readWav, playInto } = require('../src/main/voice-file');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const ROOT = path.join(__dirname, '..');
const BIN = path.resolve(args.bin || path.join(ROOT, 'src', 'voice', 'whisper'));
const DATA = path.resolve(args.data || path.join(os.tmpdir(), 'cfs-voice-selftest'));
const OUT = path.resolve(args.out || path.join(DATA, 'selftest'));
const SR = 16000;

// The owner's phrases (Studio 0.2.11 settings), plus two that the old recogniser confused with them
const COMMANDS = ["Let's Get Into The Game", "Let's Have a Chat", 'Time for a Break', 'Go Live On Stream Right Now', 'took another dab', 'Fuck, I died again',
    'Reset Counters', 'Pokeycheck', 'Run Bitch Run!', 'Kill the Counters', 'Bring back the counters', 'Toggle Discord Audio', 'Join the Discord', 'wipe it all down']
    .map((text, i) => ({ text, automationId: 100 + i, cooldownMs: 10000 }));
const NOT_COMMANDS = ['What a lovely day', 'wipe the table down'];

// ── sounds ──
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const silence = (s) => new Float32Array(Math.round(s * SR));
function click(amp = 0.9) {   // a mouse click: a sharp tick that dies in a few ms
    const n = Math.round(0.012 * SR); const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = amp * (rnd() * 2 - 1) * Math.exp(-i / (0.0015 * SR));
    return a;
}
function typing(seconds) {    // key presses: clicks 60-220 ms apart, some louder (space bar)
    const a = silence(seconds);
    for (let t = 0.05; t < seconds - 0.05; t += 0.06 + rnd() * 0.16) a.set(click(0.3 + rnd() * 0.6), Math.round(t * SR));
    return a;
}
function noise(seconds, amp = 0.3, colour = 'white') {
    const a = silence(seconds); let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < a.length; i++) {
        const w = rnd() * 2 - 1;
        if (colour === 'pink') { b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527; a[i] = amp * (b0 + b1 + b2 + w * 0.1848) / 3; } else a[i] = amp * w;
    }
    return a;
}
function bang(seconds = 0.9, amp = 0.95) {   // an explosion or gunshot: loud low noise with a fast attack and long decay
    const a = silence(seconds); let lp = 0;
    for (let i = 0; i < a.length; i++) { lp += 0.08 * ((rnd() * 2 - 1) - lp); a[i] = amp * 3 * lp * Math.exp(-i / (0.18 * SR)); }
    return a;
}
function beep(freq = 1000, seconds = 0.3, amp = 0.4) { const a = silence(seconds); for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR); return a; }
function sweep(seconds = 1.2, amp = 0.4) { const a = silence(seconds); let ph = 0; for (let i = 0; i < a.length; i++) { const f = 200 + 1800 * (i / a.length); ph += (2 * Math.PI * f) / SR; a[i] = amp * Math.sin(ph) * (0.6 + 0.4 * Math.sin(i / 300)); } return a; }
function media(name) { try { return readWav(path.join(process.env.SystemRoot || 'C:\\Windows', 'Media', name)); } catch { return null; } }
function concat(parts) { const n = parts.reduce((s, p) => s + p.length, 0); const o = new Float32Array(n); let off = 0; for (const p of parts) { o.set(p, off); off += p.length; } return o; }

function writeWav(file, samples) {
    const { wavBytes } = require('../src/main/whisper-engine');
    fs.writeFileSync(file, wavBytes(samples));
}

function noiseItems() {
    const list = [
        ['one mouse click', click()], ['double click', concat([click(), silence(0.09), click()])], ['typing, 2 s', typing(2)],
        ['white noise, 1 s', noise(1, 0.25)], ['pink noise, 1.5 s', noise(1.5, 0.5, 'pink')], ['explosion', bang()], ['three gunshots', concat([bang(0.25), bang(0.25), bang(0.4)])],
        ['1 kHz beep', beep()], ['rising tone (game pickup)', sweep()], ['fast clicking, 1.5 s', concat(Array.from({ length: 12 }, () => concat([click(), silence(0.11)])))],
    ];
    for (const f of ['Windows Ding.wav', 'Windows Notify System Generic.wav', 'Speech On.wav', 'Windows Exclamation.wav', 'Alarm01.wav', 'Ring05.wav', 'Windows Background.wav']) {
        const s = media(f); if (s) list.push([`Windows sound: ${f.replace('.wav', '')}`, s.subarray(0, Math.min(s.length, 4 * SR))]);
    }
    return list;
}

function speak(text, voice, file) {
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice($env:CFS_VOICE);
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);
$s.SetOutputToWaveFile($env:CFS_OUT, $fmt); $s.Speak($env:CFS_TEXT); $s.Dispose()`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, CFS_VOICE: voice, CFS_OUT: file, CFS_TEXT: text }, windowsHide: true });
    return readWav(file);
}

function voices() {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object Enabled | ForEach-Object { $_.VoiceInfo.Name }'], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function runFile(name, samples, timeline, device) {
    const logs = [];
    const fires = [];
    const engine = createWhisperEngine({ binDir: BIN, dataDir: DATA, logger: console });
    const vad = createSileroVad({ modelPath: path.join(ROOT, 'src', 'voice', 'silero_vad.onnx') });
    let t0 = 0;
    let transcribed = 0;
    const counting = { start: engine.start.bind(engine), transcribe: (...a) => { transcribed += 1; return engine.transcribe(...a); }, stop: () => engine.stop(), status: () => engine.status() };
    const settings = { mode: 'always', matchThreshold: 0.8, engine: device === 'cpu' ? 'cpu' : 'auto', logAllSpeech: true };
    const v = createWhisperVoice({ vad, recogniser: counting, getSettings: () => settings, onLog: (e) => logs.push({ ...e, at: (e.t - t0) / 1000 }), onPhrase: (p) => fires.push({ ...p, at: (Date.now() - t0) / 1000 }) });
    v.setPhrases(COMMANDS);
    const tStart = Date.now();
    v.start();
    for (let i = 0; i < 2400 && v.status().state !== 'listening'; i++) {
        if (v.status().state === 'error') throw new Error(v.status().error);
        await new Promise((r) => setTimeout(r, 250));
    }
    const startMs = Date.now() - tStart;
    const st = v.status();
    t0 = Date.now();
    await playInto(samples, (b) => v.feed(b), { realtime: !args.fast });
    v.feed(Buffer.alloc(SR));   // a little trailing silence
    await v.idle();
    await new Promise((r) => setTimeout(r, 1500));
    await v.idle();
    v.stop();
    return { name, device: st.device, model: st.model, gpu: st.gpuName, startMs, transcribed, logs, fires, timeline };
}

function judge(run) {
    const findings = [];
    const items = run.timeline;
    const where = (at) => items.find((it) => at >= it.start - 0.1 && at <= it.end + 2.5 && it.kind === 'phrase') || items.find((it) => at >= it.start - 0.1 && at <= it.end + 1.5) || null;
    const phraseRows = [];
    for (const it of items.filter((x) => x.kind === 'phrase')) {
        const mine = run.logs.filter((l) => l.outcome !== 'short' && where(l.at) === it);
        const fired = run.fires.filter((f) => where(f.at) === it);
        const ok = it.expect ? fired.length === 1 && fired[0].text === it.expect : fired.length === 0;
        if (!ok) findings.push(`${it.label}: expected ${it.expect ? `"${it.expect}" once` : 'nothing'}, got ${fired.map((f) => f.text).join(', ') || 'nothing'}`);
        const l = mine.find((x) => x.outcome === 'fired') || mine[0];
        phraseRows.push({ said: it.label, heard: l?.heard ?? null, matched: l?.phrase ?? null, score: l?.confidence ?? null, outcome: l?.outcome ?? 'nothing', latencyMs: l?.latencyMs ?? null, asrMs: l?.asrMs ?? null, vadSpeechMs: l?.vad?.speechMs ?? null, ok });
    }
    const noiseRows = [];
    for (const it of items.filter((x) => x.kind === 'noise')) {
        const reached = run.logs.filter((l) => l.outcome !== 'short' && l.at >= it.start - 0.05 && l.at <= it.end + 1.2 && !items.some((p) => p.kind === 'phrase' && l.at >= p.start - 0.1 && l.at <= p.end + 2.5));
        const fired = run.fires.filter((f) => f.at >= it.start - 0.05 && f.at <= it.end + 1.2 && !items.some((p) => p.kind === 'phrase' && f.at >= p.start - 0.1 && f.at <= p.end + 2.5));
        const shorts = run.logs.filter((l) => l.outcome === 'short' && l.at >= it.start - 0.05 && l.at <= it.end + 1.2).length;
        if (fired.length) findings.push(`${it.label}: fired ${fired.map((f) => f.text).join(', ')}`);
        if (reached.length) findings.push(`${it.label}: reached Whisper (${reached.map((r) => JSON.stringify(r.heard)).join(', ')})`);
        noiseRows.push({ sound: it.label, firedCommands: fired.length, reachedWhisper: reached.length, vadShortBursts: shorts });
    }
    const lat = run.logs.filter((l) => l.outcome === 'fired').map((l) => l.latencyMs).sort((a, b) => a - b);
    const asr = run.logs.filter((l) => Number.isFinite(l.asrMs)).map((l) => l.asrMs).sort((a, b) => a - b);
    const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);
    return { phraseRows, noiseRows, findings, latency: { fired: lat.length, minMs: lat[0] ?? null, medianMs: pct(lat, 50), p90Ms: pct(lat, 90), maxMs: lat[lat.length - 1] ?? null }, whisperMs: { medianMs: pct(asr, 50), maxMs: asr[asr.length - 1] ?? null } };
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const vs = voices();
    if (!vs.length) throw new Error('no Windows voices');
    const noises = noiseItems();
    // phrases.wav
    const parts = [silence(1)];
    const timeline = [];
    let at = 1;
    const push = (kind, label, s, expect) => { timeline.push({ kind, label, start: at, end: at + s.length / SR, expect }); parts.push(s); at += s.length / SR; };
    const gap = (s) => { parts.push(silence(s)); at += s; };
    let k = 0;
    for (const voice of vs) {
        for (const c of [...COMMANDS.map((x) => x.text), ...NOT_COMMANDS]) {
            const wav = speak(c, voice, path.join(OUT, `say-${k}.wav`));
            const expect = COMMANDS.some((x) => x.text === c) ? c : null;
            push('phrase', `${voice.replace(/^Microsoft | Desktop$/g, '')}: "${c}"`, wav, expect);
            gap(1.2);
            const [nl, ns] = noises[k % noises.length];
            push('noise', nl, ns);
            gap(1.2);
            k += 1;
        }
    }
    const phrases = concat(parts);
    writeWav(path.join(OUT, 'phrases.wav'), phrases);
    // noise.wav: every sound three times, with gaps
    const nparts = [silence(0.5)];
    const ntimeline = [];
    let nat = 0.5;
    for (let r = 0; r < 3; r++) for (const [l, s] of noises) { ntimeline.push({ kind: 'noise', label: l, start: nat, end: nat + s.length / SR }); nparts.push(s, silence(0.8)); nat += s.length / SR + 0.8; }
    const noiseWav = concat(nparts);
    writeWav(path.join(OUT, 'noise.wav'), noiseWav);

    const device = args.device === 'cpu' ? 'cpu' : 'auto';
    const result = { when: new Date().toISOString(), voices: vs, phrasesSeconds: Math.round(phrases.length / SR), noiseSeconds: Math.round(noiseWav.length / SR), runs: [] };
    for (const [name, s, tl] of [['phrases.wav', phrases, timeline], ['noise.wav', noiseWav, ntimeline]]) {
        const run = await runFile(name, s, tl, device);
        const j = judge(run);
        result.runs.push({ file: name, device: run.device, model: run.model, gpu: run.gpu, startMs: run.startMs, segmentsToWhisper: run.transcribed, vadShortBursts: run.logs.filter((l) => l.outcome === 'short').length, fires: run.fires.length, ...j,
            log: run.logs.map((l) => ({ at: Math.round(l.at * 100) / 100, outcome: l.outcome, heard: l.heard, phrase: l.phrase, score: l.confidence, latencyMs: l.latencyMs, asrMs: l.asrMs, vad: l.vad })) });
    }
    result.pass = result.runs.every((r) => r.findings.length === 0);
    const file = path.join(OUT, `result-${device}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    for (const r of result.runs) {
        console.log(`\n== ${r.file} on ${r.device} (${r.model}${r.gpu ? `, ${r.gpu}` : ''}); start ${r.startMs} ms; ${r.segmentsToWhisper} segments to Whisper; ${r.vadShortBursts} short bursts dropped by the VAD; ${r.fires} fired`);
        if (r.phraseRows.length) console.table(r.phraseRows);
        console.table(r.noiseRows);
        console.log('latency end of speech -> fire:', r.latency, 'whisper:', r.whisperMs);
        for (const f of r.findings) console.log('FAIL', f);
    }
    console.log(`\n${result.pass ? 'PASS' : 'FAIL'}; details in ${file}`);
    process.exit(result.pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
