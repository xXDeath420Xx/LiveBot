/*
 * Own-voice feature (invite-only), wired to the real database, files, sidecar and Piper. One instance per process.
 *
 *   getVoiceClone() → { service, synth, store, files, workerApi, ready } | null   null until migration 476 has run
 *   startVoiceClone({ logger })    once at start-up (index.js): janitor every 10 minutes, the loopback worker API,
 *                                  /dev/shm copies from before a restart removed
 *   ownerLive()                    the cf_quiet query: a live_announcements row for BOT_OWNER_ID still marked online
 *
 * Modules: constants · consent-text · gate · challenge · scoring · policy · gpu-window (pure) · crypto · files · tar ·
 * audio · store · service · synth · worker-api. Design: docs voice-cloning-design.md and the owner's decisions of
 * 2026-11-20 (constants.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from '../../utils/db.js';
import { createVoiceCloneStore } from './store.js';
import { createVoiceFiles } from './files.js';
import { createSidecar, toWav, transcribe } from './audio.js';
import { createVoiceCloneService } from './service.js';
import { createOwnVoiceSynth } from './synth.js';
import { createWorkerApi } from './worker-api.js';
import { createLegacy } from './legacy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let instance = null;
let starting = null;

export async function ownerLive(db = pool, env = process.env) {
    const owner = String(env.BOT_OWNER_ID || '');
    if (!owner) return true;
    const [rows] = await db.query('SELECT COUNT(*) AS n FROM live_announcements WHERE offline_check_count = 0 AND discord_user_id = ?', [owner]);
    return Number(rows[0]?.n || 0) > 0;
}

function loadPrompts() {
    try { return JSON.parse(fs.readFileSync(path.join(HERE, 'prompts.json'), 'utf8')).sentences.filter((s) => typeof s === 'string' && s.length < 400); } catch { return []; }
}

async function build({ logger = null } = {}) {
    const store = createVoiceCloneStore({ db: pool });
    if (!(await store.available())) return null;
    const files = createVoiceFiles();
    await files.init();
    await files.wipeShm();   // copies left by the last process
    const sidecar = createSidecar();
    const pw = await import('../../utils/piper-worker.js');
    const piper = { speak: (text, modelPath, opts) => pw.synthesizeWithModel(text, modelPath, opts), stop: (modelPath) => pw.stopWorkersFor(modelPath) };
    const service = createVoiceCloneService({
        store, files, sidecar, logger, prompts: loadPrompts(),
        transcribe: (wav) => transcribe(wav),
        decode: (buf, opts) => toWav(buf, opts),
        ownerLive: () => ownerLive(),
    });
    const synth = createOwnVoiceSynth({ service, store, files, sidecar, piper, logger });
    const workerApi = createWorkerApi({ service, store, files, sidecar, piper, ownerLive: () => ownerLive(), logger });
    const legacy = createLegacy({ service, store, files, sidecar, piper, logger, decode: (buf, opts) => toWav(buf, { ...opts, any: true }),
        piperModelsDir: path.join(HERE, '..', '..', 'piper_models') });
    return { service, synth, store, files, workerApi, sidecar, legacy, ready: true };
}

export async function getVoiceClone(opts = {}) {
    if (instance) return instance;
    if (!starting) starting = build(opts).then((x) => { instance = x; starting = null; return x; }, (err) => { starting = null; throw err; });
    return starting;
}

let timers = [];
export async function startVoiceClone({ logger = null } = {}) {
    const vc = await getVoiceClone({ logger }).catch((err) => { logger?.warn?.('[VoiceClone] not started', { error: err?.message }); return null; });
    if (!vc) { logger?.info?.('[VoiceClone] tables not created yet (migration 476): own voice stays off'); return null; }
    vc.workerApi.listen();
    const tick = async () => {
        try {
            const r = await vc.service.runJanitor();
            await vc.workerApi.expireLeases();
            if (r.samplesPurged || r.idleDeleted || r.draftsDeleted) logger?.info?.('[VoiceClone] janitor', r);
        } catch (err) { logger?.warn?.('[VoiceClone] janitor failed', { error: err?.message }); }
    };
    timers.push(setTimeout(tick, 60_000), setInterval(tick, 10 * 60_000));
    for (const t of timers) t.unref?.();
    return vc;
}

export function stopVoiceClone() {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers = [];
    instance?.workerApi?.close();
    instance?.synth?.stop();
}

export default { getVoiceClone, startVoiceClone, stopVoiceClone, ownerLive };
