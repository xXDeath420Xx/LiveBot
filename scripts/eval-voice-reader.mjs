/*
 * Voice reader intelligibility check: speak realistic chat through the reader's text rules and
 * Piper, transcribe it with the local whisper-accurate server, and report word error rate.
 *
 *   node scripts/eval-voice-reader.mjs [voice,voice,...] [--verbose]
 *
 * Baseline 2026-09-30 (old pipeline, ryan): 59% WER. New pipeline: ~20%, most of the remainder
 * being Whisper formatting ("GG 2v2 at 9pm") rather than speech errors.
 */
import dotenv from 'dotenv'; dotenv.config();
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { speakableName, speakableBody } from '../utils/speech-text.js';
import { synthesizeFast, stopAllPiperWorkers } from '../utils/piper-worker.js';

const CORPUS = [
  ['Snowdrift', "what does a man do if he's trapped in a room with only a calendar and a bed? he drinks from the spring and eats the dates",
    "snowdrift says what does a man do if he's trapped in a room with only a calendar and a bed he drinks from the spring and eats the dates"],
  ['Violet Clouds', 'HES VENTING', "violet clouds says he's venting"],
  ['𝓥𝓲𝓸𝓵𝓮𝓽 𝓒𝓵𝓸𝓾𝓭𝓼', 'to poor to afford air ducts', 'violet clouds says to poor to afford air ducts'],
  ['xXDeath420Xx', 'lmao idk, brb gonna grab food', "death says laughing my ass off i don't know be right back gonna grab food"],
  ['ʙᴇᴀʀ 🐻', 'u coming on tonight? ya or nah', 'bear says you coming on tonight ya or nah'],
  ['dab_fam_lounge', 'ok\nso\nwho is on', 'dab fam lounge says ok so who is on'],
  ['MetalGurl2K', 'Wait... what? No way! Seriously, dude.', 'metal gurl 2k says wait what no way seriously dude'],
  ['Snowdrift ❄️', "that's hilarious 😂😂😂", "snowdrift says that's hilarious"],
  ['TeddGaming', 'gg, 2v2 at 9pm?', 'tedd gaming says gg 2v2 at 9pm'],
  ['Kabster_', 'My therapist told me to look at the bright side. So I stared at the sun until I went blind. Now I can\'t see anything negative, or anything at all.',
    'kabster says my therapist told me to look at the bright side so i stared at the sun until i went blind now i can\'t see anything negative or anything at all'],
  ['Bear', 'omg thats so funny lol', 'bear says oh my god thats so funny laugh out loud'],
  ['Hole', 'It really is', 'hole says it really is'],
];

const norm = s => s.toLowerCase().normalize('NFKC').replace(/[’]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
function wer(ref, hyp) {
  const r = norm(ref), h = norm(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}
async function transcribe(wav) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', wav, '-ar', '16000', '-ac', '1', '-f', 'wav', '-'], { maxBuffer: 1 << 26 });
  const form = new FormData();
  form.append('file', new Blob([pcm], { type: 'audio/wav' }), 'a.wav');
  form.append('response_format', 'json'); form.append('temperature', '0');
  const res = await fetch('http://127.0.0.1:8179/inference', { method: 'POST', body: form });
  return String((await res.json()).text || '').trim();
}
/** RMS of the last 60ms relative to the loudest 60ms — high means the file ends mid-sound. */
function tailRatio(wav) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', wav, '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const rate = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', wav]).toString());
  const win = Math.round(rate * 0.06);
  const rms = (a, b) => { let t = 0; for (let i = a; i < b; i++) t += s[i] * s[i]; return Math.sqrt(t / Math.max(1, b - a)); };
  let peak = 1; for (let i = 0; i + win < s.length; i += win) peak = Math.max(peak, rms(i, i + win));
  return { tail: rms(s.length - win, s.length) / peak, head: rms(0, win) / peak, secs: s.length / rate };
}

async function evaluate(label, speak, { verbose = true } = {}) {
  let total = 0, clipped = 0;
  const rows = [];
  for (const [name, content, ref] of CORPUS) {
    const t0 = Date.now();
    const { wav, text } = await speak(name, content);
    const ms = Date.now() - t0;
    const hyp = await transcribe(wav);
    const w = wer(ref, hyp);
    const t = tailRatio(wav);
    total += w; if (t.tail > 0.08) clipped++;
    rows.push({ w, ms, text, hyp, tail: t.tail, secs: t.secs });
    fs.unlinkSync(wav);
  }
  console.log(`\n=== ${label}: mean WER ${(total / CORPUS.length * 100).toFixed(1)}%  · ends mid-sound ${clipped}/${CORPUS.length} · synth ${Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length)}ms avg`);
  if (verbose) for (const r of rows) console.log(`${(r.w * 100).toFixed(0).padStart(4)}% tail=${r.tail.toFixed(2)} | said: ${r.text.slice(0, 70)}\n${' '.repeat(16)}heard: ${r.hyp.slice(0, 110)}`);
  return total / CORPUS.length;
}

const voices = (process.argv.find((a, i) => i > 1 && !a.startsWith('--')) || 'ryan').split(',');
const verbose = process.argv.includes('--verbose');
for (const voice of voices) {
  await evaluate(`voice ${voice}`, async (name, content) => {
    const text = `${speakableName(name) || 'Someone'} says: ${speakableBody(content)}`;
    return { text, wav: await synthesizeFast(text, voice) };
  }, { verbose });
}
stopAllPiperWorkers();
process.exit(0);
