/*
 * Stream bot overlays: every database read and write (tables from migrations/459_stream_bot_overlays.js).
 *
 *   createOverlayStore({ db, prefix = 'stream_bot_', encryption })
 *     list(profileId) / get(profileId, id) / count(profileId)
 *     create(profileId, { type, name, config }) → { overlay, key }     the key is returned once here and kept encrypted
 *     update(profileId, id, { name, config })   setState(profileId, id, state)   remove(profileId, id)
 *     keyOf(profileId, id) → key | null          decrypted for the Overlays tab and CertiFried Studio (overlays.list)
 *     rotateKey(profileId, id) → key             the old key stops at once (its hash is gone)
 *     byKeyHash(hash) → overlay (with profileId) | null   only for an enabled profile
 *     touch(id)                                  last_seen_at, when a page connects
 *     media: listMedia(profileId) / getMedia(profileId, fileId) / addMedia(profileId, row) / removeMedia(profileId, fileId)
 *     exportProfile(profileId) / deleteProfile(profileId)   /privacy (no key columns in the export)
 *
 * Every query carries profile_id, so a route can only reach the signed-in user's overlays. Rows come back without
 * key_hash or key_enc.
 */
import crypto from 'node:crypto';
import { newOverlayKey, keyHash, keyHint, isOverlayKeyShape } from './http.js';
import { isOverlayType, withDefaults, LIMITS } from './config.js';

const parse = (v, d) => {
    if (v == null) return d;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return d; }
};

export function createOverlayStore({ db, prefix = 'stream_bot_', encryption = null } = {}) {
    if (!db) throw new Error('createOverlayStore needs a db pool');
    if (!/^[a-z0-9_]{1,30}$/.test(prefix)) throw new Error('bad table prefix');
    const T = (n) => `\`${prefix}${n}\``;
    const q = async (sql, params = []) => (await db.query(sql, params))[0];
    const enc = (s) => (encryption ? JSON.stringify(encryption.encrypt(String(s))) : null);
    const dec = (s) => { if (!s || !encryption) return null; try { return encryption.decrypt(JSON.parse(s)); } catch { return null; } };

    const row = (r) => (!r ? null : {
        id: Number(r.id), profileId: Number(r.profile_id), type: r.type, name: r.name, keyHint: r.key_hint || null,
        config: withDefaults(r.type, parse(r.config, {})), state: parse(r.state, {}) || {},
        createdAt: r.created_at, updatedAt: r.updated_at, lastSeenAt: r.last_seen_at,
    });
    const mediaRow = (r) => (!r ? null : {
        id: r.file_id, name: r.name, kind: r.kind, ext: r.ext, mime: r.mime, size: Number(r.size), sha256: r.sha256, createdAt: r.created_at,
    });
    const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);

    const store = {
        prefix,
        async list(profileId) {
            return (await q(`SELECT * FROM ${T('overlays')} WHERE profile_id = ? ORDER BY id`, [profileId])).map(row);
        },
        async count(profileId) {
            return Number((await q(`SELECT COUNT(*) AS n FROM ${T('overlays')} WHERE profile_id = ?`, [profileId]))[0].n);
        },
        async get(profileId, id) {
            return row((await q(`SELECT * FROM ${T('overlays')} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0]);
        },
        async create(profileId, { type, name, config = null }) {
            if (!isOverlayType(type)) throw new Error('bad overlay type');
            const key = newOverlayKey();
            const r = await q(`INSERT INTO ${T('overlays')} (profile_id, type, name, key_hash, key_enc, key_hint, config, state) VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
                [profileId, type, cleanName(name) || 'Overlay', keyHash(key), enc(key), keyHint(key), JSON.stringify(withDefaults(type, config || {}))]);
            return { overlay: await store.get(profileId, r.insertId), key };
        },
        async update(profileId, id, { name, config } = {}) {
            const sets = [], params = [];
            if (name !== undefined) { sets.push('name = ?'); params.push(cleanName(name) || 'Overlay'); }
            if (config !== undefined) { sets.push('config = ?'); params.push(JSON.stringify(config)); }
            if (!sets.length) return false;
            const r = await q(`UPDATE ${T('overlays')} SET ${sets.join(', ')} WHERE profile_id = ? AND id = ?`, [...params, profileId, id]);
            return r.affectedRows > 0;
        },
        async setState(profileId, id, state) {
            const r = await q(`UPDATE ${T('overlays')} SET state = ? WHERE profile_id = ? AND id = ?`, [JSON.stringify(state || {}).slice(0, 60_000), profileId, id]);
            return r.affectedRows > 0;
        },
        async remove(profileId, id) {
            return (await q(`DELETE FROM ${T('overlays')} WHERE profile_id = ? AND id = ?`, [profileId, id])).affectedRows > 0;
        },
        async keyOf(profileId, id) {
            const r = (await q(`SELECT key_enc, key_hash FROM ${T('overlays')} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0];
            if (!r) return null;
            const k = dec(r.key_enc);
            return isOverlayKeyShape(k) && keyHash(k) === r.key_hash ? k : null;
        },
        async rotateKey(profileId, id) {
            const key = newOverlayKey();
            const r = await q(`UPDATE ${T('overlays')} SET key_hash = ?, key_enc = ?, key_hint = ? WHERE profile_id = ? AND id = ?`, [keyHash(key), enc(key), keyHint(key), profileId, id]);
            return r.affectedRows ? key : null;
        },
        async byKeyHash(hash) {
            if (!/^[0-9a-f]{64}$/.test(String(hash))) return null;
            return row((await q(`SELECT o.* FROM ${T('overlays')} o JOIN ${T('profiles')} p ON p.id = o.profile_id WHERE o.key_hash = ? AND p.enabled = 1 LIMIT 1`, [hash]))[0]);
        },
        async touch(id) {
            await q(`UPDATE ${T('overlays')} SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
        },

        // ── media index ──
        async listMedia(profileId) {
            return (await q(`SELECT * FROM ${T('overlay_media')} WHERE profile_id = ? ORDER BY name`, [profileId])).map(mediaRow);
        },
        async getMedia(profileId, fileId) {
            if (!/^[0-9a-f]{16}$/.test(String(fileId))) return null;
            return mediaRow((await q(`SELECT * FROM ${T('overlay_media')} WHERE profile_id = ? AND file_id = ?`, [profileId, fileId]))[0]);
        },
        async addMedia(profileId, m) {
            await q(`INSERT INTO ${T('overlay_media')} (profile_id, file_id, name, kind, ext, mime, size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [profileId, m.id, m.name, m.kind, m.ext, m.mime, m.size, m.sha256]);
        },
        async removeMedia(profileId, fileId) {
            return (await q(`DELETE FROM ${T('overlay_media')} WHERE profile_id = ? AND file_id = ?`, [profileId, fileId])).affectedRows > 0;
        },

        // ── privacy ──
        async exportProfile(profileId) {
            const overlays = (await q(`SELECT id, type, name, config, state, created_at, updated_at, last_seen_at FROM ${T('overlays')} WHERE profile_id = ? ORDER BY id`, [profileId]))
                .map((r) => ({ id: Number(r.id), type: r.type, name: r.name, config: parse(r.config, {}), state: parse(r.state, {}), created_at: r.created_at, updated_at: r.updated_at, last_seen_at: r.last_seen_at }));
            const media = (await q(`SELECT name, kind, mime, size, created_at FROM ${T('overlay_media')} WHERE profile_id = ? ORDER BY name`, [profileId]));
            return { overlays, overlay_media: media };
        },
        async deleteProfile(profileId) {
            const counts = {};
            for (const t of ['overlay_media', 'overlays']) {
                const r = await q(`DELETE FROM ${T(t)} WHERE profile_id = ?`, [profileId]);
                if (r.affectedRows) counts[`${prefix}${t}`] = r.affectedRows;
            }
            return counts;
        },
    };
    return store;
}

/** A random 16-hex file id (media files). */
export const newFileId = () => crypto.randomBytes(8).toString('hex');

export default { createOverlayStore, newFileId };
