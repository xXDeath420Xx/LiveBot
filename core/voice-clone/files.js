/*
 * Where own-voice files live (design 3.4, 5.2), all encrypted with the voice's data key:
 *
 *   <DATA_DIR>/<voice>/samples/<sample id>.wav.enc     22.05 kHz mono 16-bit WAV (training format)
 *   <DATA_DIR>/<voice>/model/<sha256>.onnx.enc         the trained Piper model
 *   <SHM_DIR>/<voice>-<sha8>.onnx (+ .onnx.json)       the decrypted inference copy, mode 0600, removed after 15 min idle,
 *                                                     on delete, suspend and at start-up
 * DATA_DIR is ~/certifried-data/voice (mode 0700). Samples are left out of backups (scripts/backup/remote.sh); the
 * encrypted models are backed up and expire from backups within 7 days of a delete.
 *
 *   createVoiceFiles({ dataDir, shmDir })
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, SHM_DIR } from './constants.js';

const SAFE = /^[a-z0-9_-]{6,40}$/i;

export function createVoiceFiles({ dataDir = DATA_DIR, shmDir = SHM_DIR } = {}) {
    const voiceDir = (voiceId) => {
        if (!SAFE.test(String(voiceId))) throw new Error('bad voice id');
        return path.join(dataDir, String(voiceId));
    };
    const ensure = async (dir) => { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); return dir; };

    async function wipeShm(voiceId = null) {
        let n = 0;
        let list = [];
        try { list = await fs.readdir(shmDir); } catch { return 0; }
        for (const f of list) {
            if (voiceId && !f.startsWith(`${voiceId}-`)) continue;
            await fs.rm(path.join(shmDir, f), { force: true }).then(() => { n++; }, () => {});
        }
        return n;
    }

    return {
        dataDir, shmDir, voiceDir,
        async init() { await ensure(dataDir); await fs.chmod(dataDir, 0o700).catch(() => {}); await ensure(shmDir); await fs.chmod(shmDir, 0o700).catch(() => {}); },
        sampleName: (sampleId) => `${Number(sampleId)}.wav.enc`,
        async writeSample(voiceId, sampleId, sealed) {
            const dir = await ensure(path.join(voiceDir(voiceId), 'samples'));
            const file = path.join(dir, `${Number(sampleId)}.wav.enc`);
            await fs.writeFile(file, sealed, { mode: 0o600 });
            return path.basename(file);
        },
        async readSample(voiceId, fileName) {
            if (!/^\d+\.wav\.enc$/.test(String(fileName))) throw new Error('bad sample file');
            return fs.readFile(path.join(voiceDir(voiceId), 'samples', fileName));
        },
        async removeSample(voiceId, fileName) {
            if (!/^\d+\.wav\.enc$/.test(String(fileName || ''))) return false;
            await fs.rm(path.join(voiceDir(voiceId), 'samples', fileName), { force: true });
            return true;
        },
        async removeAllSamples(voiceId) {
            const dir = path.join(voiceDir(voiceId), 'samples');
            let n = 0;
            try { n = (await fs.readdir(dir)).length; } catch { return 0; }
            await fs.rm(dir, { recursive: true, force: true });
            return n;
        },
        async writeModel(voiceId, sha, sealed) {
            if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('bad model hash');
            const dir = await ensure(path.join(voiceDir(voiceId), 'model'));
            await fs.writeFile(path.join(dir, `${sha}.onnx.enc`), sealed, { mode: 0o600 });
        },
        async readModel(voiceId, sha) {
            if (!/^[0-9a-f]{64}$/.test(String(sha))) throw new Error('bad model hash');
            return fs.readFile(path.join(voiceDir(voiceId), 'model', `${sha}.onnx.enc`));
        },
        async removeOtherModels(voiceId, keepSha) {
            const dir = path.join(voiceDir(voiceId), 'model');
            let list = [];
            try { list = await fs.readdir(dir); } catch { return 0; }
            let n = 0;
            for (const f of list) if (f !== `${keepSha}.onnx.enc`) { await fs.rm(path.join(dir, f), { force: true }); n++; }
            return n;
        },
        /** The inference copy in /dev/shm: write it if missing. Returns the .onnx path. */
        async shmModel(voiceId, sha, onnx, json) {
            await ensure(shmDir);
            const base = path.join(shmDir, `${voiceId}-${String(sha).slice(0, 12)}.onnx`);
            try { await fs.access(base); } catch {
                await fs.writeFile(`${base}.json`, json, { mode: 0o600 });
                await fs.writeFile(base, onnx, { mode: 0o600 });
            }
            return base;
        },
        wipeShm,
        async removeVoiceDir(voiceId) {
            const dir = voiceDir(voiceId);
            let exists = true;
            try { await fs.access(dir); } catch { exists = false; }
            await fs.rm(dir, { recursive: true, force: true });
            return exists;
        },
        async voiceDirExists(voiceId) { try { await fs.access(voiceDir(voiceId)); return true; } catch { return false; } },
    };
}

export default { createVoiceFiles };
