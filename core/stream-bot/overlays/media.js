/*
 * Stream bot overlays: the image and video library (alerts, "Show an image or video on stream").
 *
 *   createMediaLibrary({ ostore, dir?, limits? })
 *     .list(profileId) / .get(profileId, fileId)
 *     .add(profileId, { name, buffer }) → { ok, media } | { ok: false, error }
 *     .remove(profileId, fileId) → true | false
 *     .filePath(profileId, media)      absolute path of the stored file (null for a bad row)
 *   sniffMedia(buffer)                 { kind: image|video, ext, mime } from the first bytes, or null
 *   removeProfileMedia(profileId, dir) privacy delete: the profile's folder
 *   MEDIA_LIMITS                       10 MB each, 30 per profile, 150 MB per profile
 *
 * PNG, JPEG, GIF, WebP (animated too), WebM and MP4, recognised by their first bytes (the extension is not trusted);
 * SVG is refused (it can carry script). Files: <dir>/<profileId>/<16 hex>.<ext>, dir = STREAM_BOT_MEDIA_DIR or
 * /home/death/certifried-data/stream-bot-media (outside git). The index is stream_bot_overlay_media; writes for one
 * profile are serialised in this process.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { newFileId } from './store.js';

export const MEDIA_LIMITS = Object.freeze({ fileBytes: 10 * 1024 * 1024, count: 30, totalBytes: 150 * 1024 * 1024, nameMax: 80 });
export const DEFAULT_MEDIA_DIR = '/home/death/certifried-data/stream-bot-media';
const ID = /^[0-9a-f]{16}$/;

const ascii = (b, s, at = 0) => b.length >= at + s.length && b.toString('latin1', at, at + s.length) === s;

/** What a buffer holds, from its first bytes: PNG, JPEG, GIF, WebP, WebM or MP4 only. */
export function sniffMedia(b) {
    if (!Buffer.isBuffer(b) || b.length < 16) return null;
    if (b[0] === 0x89 && ascii(b, 'PNG', 1)) return { kind: 'image', ext: 'png', mime: 'image/png' };
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', ext: 'jpg', mime: 'image/jpeg' };
    if (ascii(b, 'GIF87a') || ascii(b, 'GIF89a')) return { kind: 'image', ext: 'gif', mime: 'image/gif' };
    if (ascii(b, 'RIFF') && ascii(b, 'WEBP', 8)) return { kind: 'image', ext: 'webp', mime: 'image/webp' };
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'video', ext: 'webm', mime: 'video/webm' };
    if (ascii(b, 'ftyp', 4)) {
        const brand = b.toString('latin1', 8, 12);
        if (['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '].includes(brand)) return { kind: 'video', ext: 'mp4', mime: 'video/mp4' };
    }
    return null;
}

export function mediaDir() { return path.resolve(process.env.STREAM_BOT_MEDIA_DIR || DEFAULT_MEDIA_DIR); }

export function cleanMediaName(v) {
    return String(v ?? '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MEDIA_LIMITS.nameMax);
}

export function createMediaLibrary({ ostore, dir = null, limits = {} } = {}) {
    const L = { ...MEDIA_LIMITS, ...limits };
    const base = () => path.resolve(dir || mediaDir());
    const folder = (profileId) => path.join(base(), String(Number(profileId)));
    const locks = new Map();
    const serial = (profileId, fn) => {
        const prev = locks.get(profileId) || Promise.resolve();
        const next = prev.catch(() => {}).then(fn);
        locks.set(profileId, next.finally(() => { if (locks.get(profileId) === next) locks.delete(profileId); }));
        return next;
    };
    const filePath = (profileId, m) => (m && ID.test(String(m.id)) && /^[a-z0-9]{2,4}$/.test(String(m.ext || '')) ? path.join(folder(profileId), `${m.id}.${m.ext}`) : null);

    return {
        limits: L,
        filePath,
        list: (profileId) => ostore.listMedia(profileId),
        get: (profileId, fileId) => ostore.getMedia(profileId, String(fileId || '')),
        add(profileId, { name, buffer }) {
            return serial(profileId, async () => {
                if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, error: 'Choose an image or video file.' };
                if (buffer.length > L.fileBytes) return { ok: false, error: `A file can be at most ${Math.round(L.fileBytes / 1048576)} MB.` };
                const kind = sniffMedia(buffer);
                if (!kind) return { ok: false, error: 'That is not a PNG, JPEG, GIF, WebP, WebM or MP4 file.' };
                const clean = cleanMediaName(name);
                if (!clean) return { ok: false, error: 'Give the file a name.' };
                const current = await ostore.listMedia(profileId);
                if (current.length >= L.count) return { ok: false, error: `You have ${L.count} files, the most a profile can have. Delete one first.` };
                const total = current.reduce((n, m) => n + (Number(m.size) || 0), 0);
                if (total + buffer.length > L.totalBytes) return { ok: false, error: `Your media would pass ${Math.round(L.totalBytes / 1048576)} MB in total. Delete some first.` };
                if (current.some((m) => m.name.toLowerCase() === clean.toLowerCase())) return { ok: false, error: `You already have a file called ${clean}.` };
                const media = { id: newFileId(), name: clean, kind: kind.kind, ext: kind.ext, mime: kind.mime, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
                await fs.mkdir(folder(profileId), { recursive: true, mode: 0o750 });
                const target = filePath(profileId, media);
                await fs.writeFile(`${target}.part`, buffer, { mode: 0o640 });
                await fs.rename(`${target}.part`, target);
                try {
                    await ostore.addMedia(profileId, media);
                } catch (err) {
                    await fs.unlink(target).catch(() => {});
                    throw err;
                }
                return { ok: true, media: { ...media, createdAt: new Date() } };
            });
        },
        remove(profileId, fileId) {
            return serial(profileId, async () => {
                const m = await ostore.getMedia(profileId, fileId);
                if (!m) return false;
                await ostore.removeMedia(profileId, m.id);
                const p = filePath(profileId, m);
                if (p) await fs.unlink(p).catch(() => {});
                return true;
            });
        },
    };
}

/** Deletes a profile's media folder (privacy delete). */
export async function removeProfileMedia(profileId, dir = null) {
    if (!Number.isInteger(Number(profileId)) || Number(profileId) <= 0) return;
    await fs.rm(path.join(path.resolve(dir || mediaDir()), String(Number(profileId))), { recursive: true, force: true }).catch(() => {});
}

export default { createMediaLibrary, sniffMedia, cleanMediaName, mediaDir, removeProfileMedia, MEDIA_LIMITS, DEFAULT_MEDIA_DIR };
