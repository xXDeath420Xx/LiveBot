/*
 * Stream bot: the dashboard sound library (Phase 2). Sounds a streamer uploads on /stream/bot/sounds are kept
 * outside git and synced to CertiFried Studio, which plays them for the `sound.play` action.
 *
 *   createSoundLibrary({ store, dir?, limits? })
 *     .list(profileId)                       [{ id, name, file, size, mime, sha256, uploadedAt }]
 *     .add(profileId, { name, buffer })      → { ok, sound } | { ok: false, error }
 *     .remove(profileId, id)                 → true | false
 *     .filePath(profileId, sound)            absolute path of the stored file
 *     .removeAll(profileId)                  privacy delete: the profile's folder
 *   sniffAudio(buffer)                       { ext, mime } from the magic bytes, or null
 *   SOUND_LIMITS                             5 MB each, 50 per profile, 100 MB per profile
 *
 * Files: <dir>/<profileId>/<16 hex>.<ext>, dir = STREAM_BOT_SOUNDS_DIR or /home/death/certifried-data/stream-bot-sounds.
 * The index lives in the profile's settings JSON under `sounds` (no table of its own); writes for one profile are
 * serialised in this process so two uploads cannot lose each other.
 *
 * Tested in tests/stream-bot-studio.test.js.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const SOUND_LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024, count: 50, totalBytes: 100 * 1024 * 1024, nameMax: 80 });
export const DEFAULT_SOUNDS_DIR = '/home/death/certifried-data/stream-bot-sounds';
const ID = /^[0-9a-f]{16}$/;

const startsWith = (b, bytes, at = 0) => bytes.every((x, i) => b[at + i] === x);
const ascii = (b, s, at = 0) => b.length >= at + s.length && b.toString('latin1', at, at + s.length) === s;

/** What kind of audio a buffer holds, from its first bytes. Only mp3, wav, ogg, m4a and webm are accepted. */
export function sniffAudio(b) {
    if (!Buffer.isBuffer(b) || b.length < 12) return null;
    if (ascii(b, 'RIFF') && ascii(b, 'WAVE', 8)) return { ext: 'wav', mime: 'audio/wav' };
    if (ascii(b, 'OggS')) return { ext: 'ogg', mime: 'audio/ogg' };
    if (ascii(b, 'ID3')) return { ext: 'mp3', mime: 'audio/mpeg' };
    // MPEG audio frame sync: 11 bits set, layer bits not 00.
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0) return { ext: 'mp3', mime: 'audio/mpeg' };
    if (ascii(b, 'ftyp', 4)) {
        const brand = b.toString('latin1', 8, 12);
        if (['M4A ', 'M4B ', 'mp42', 'isom', 'iso2', 'dash', 'mp41'].includes(brand)) return { ext: 'm4a', mime: 'audio/mp4' };
        return null;
    }
    if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { ext: 'webm', mime: 'audio/webm' };
    return null;
}

export function soundsDir() {
    return path.resolve(process.env.STREAM_BOT_SOUNDS_DIR || DEFAULT_SOUNDS_DIR);
}

/** A sound name as shown and matched by the app: no path characters, at most 80 characters. */
export function cleanName(v) {
    return String(v ?? '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SOUND_LIMITS.nameMax);
}

export function createSoundLibrary({ store, dir = null, limits = {} } = {}) {
    const L = { ...SOUND_LIMITS, ...limits };
    const base = () => path.resolve(dir || soundsDir());
    const folder = (profileId) => path.join(base(), String(Number(profileId)));
    const locks = new Map();

    /** Run fn after any earlier write for this profile finished. */
    function serial(profileId, fn) {
        const prev = locks.get(profileId) || Promise.resolve();
        const next = prev.catch(() => {}).then(fn);
        locks.set(profileId, next.finally(() => { if (locks.get(profileId) === next) locks.delete(profileId); }));
        return next;
    }

    async function list(profileId) {
        const v = await store.getSettingsKey(profileId, 'sounds');
        return Array.isArray(v) ? v.filter((s) => s && ID.test(String(s.id))) : [];
    }

    function filePath(profileId, sound) {
        if (!sound || !ID.test(String(sound.id)) || !/^[a-z0-9]{2,4}$/.test(String(sound.ext || ''))) return null;
        return path.join(folder(profileId), `${sound.id}.${sound.ext}`);
    }

    return {
        limits: L,
        list,
        filePath,
        async get(profileId, id) {
            if (!ID.test(String(id))) return null;
            return (await list(profileId)).find((s) => s.id === id) || null;
        },
        add(profileId, { name, buffer }) {
            return serial(profileId, async () => {
                if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, error: 'Choose an audio file.' };
                if (buffer.length > L.fileBytes) return { ok: false, error: `A sound can be at most ${Math.round(L.fileBytes / 1048576)} MB.` };
                const kind = sniffAudio(buffer);
                if (!kind) return { ok: false, error: 'That is not an MP3, WAV, OGG, M4A or WebM audio file.' };
                const clean = cleanName(name);
                if (!clean) return { ok: false, error: 'Give the sound a name.' };
                const current = await list(profileId);
                if (current.length >= L.count) return { ok: false, error: `You have ${L.count} sounds, the most a profile can have. Delete one first.` };
                const total = current.reduce((n, s) => n + (Number(s.size) || 0), 0);
                if (total + buffer.length > L.totalBytes) return { ok: false, error: `Your sounds would pass ${Math.round(L.totalBytes / 1048576)} MB in total. Delete some first.` };
                if (current.some((s) => s.name.toLowerCase() === clean.toLowerCase())) return { ok: false, error: `You already have a sound called ${clean}.` };
                const sound = {
                    id: crypto.randomBytes(8).toString('hex'), name: clean, ext: kind.ext, mime: kind.mime, size: buffer.length,
                    sha256: crypto.createHash('sha256').update(buffer).digest('hex'), uploadedAt: new Date().toISOString(),
                };
                await fs.mkdir(folder(profileId), { recursive: true, mode: 0o750 });
                const target = filePath(profileId, sound);
                await fs.writeFile(`${target}.part`, buffer, { mode: 0o640 });
                await fs.rename(`${target}.part`, target);
                try {
                    await store.setSettingsKey(profileId, 'sounds', [...current, sound]);
                } catch (err) {
                    await fs.unlink(target).catch(() => {});
                    throw err;
                }
                return { ok: true, sound };
            });
        },
        remove(profileId, id) {
            return serial(profileId, async () => {
                const current = await list(profileId);
                const hit = current.find((s) => s.id === id);
                if (!hit) return false;
                await store.setSettingsKey(profileId, 'sounds', current.filter((s) => s.id !== id));
                const p = filePath(profileId, hit);
                if (p) await fs.unlink(p).catch(() => {});
                return true;
            });
        },
        async removeAll(profileId) {
            await fs.rm(folder(profileId), { recursive: true, force: true }).catch(() => {});
        },
    };
}

/** Deletes a profile's sound folder (privacy delete, where no library instance is at hand). */
export async function removeProfileSounds(profileId, dir = null) {
    if (!Number.isInteger(Number(profileId)) || Number(profileId) <= 0) return;
    await fs.rm(path.join(path.resolve(dir || soundsDir()), String(Number(profileId))), { recursive: true, force: true }).catch(() => {});
}

export default { createSoundLibrary, sniffAudio, cleanName, soundsDir, removeProfileSounds, SOUND_LIMITS, DEFAULT_SOUNDS_DIR };
