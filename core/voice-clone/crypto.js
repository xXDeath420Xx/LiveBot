/*
 * Encryption at rest for the own-voice feature (design 3.4).
 *
 * Every voice has its own 32-byte data key. Samples, the trained model and the voiceprints are encrypted with it
 * (AES-256-GCM, the voice id as additional data so a file cannot be swapped onto another voice). The data key is
 * stored wrapped by VOICE_KEK (.env, 32 bytes as 64 hex characters or base64), separate from utils/token-encryption.js.
 * Deleting a voice overwrites the wrapped key, so a copy of a file that outlives the delete (a backup) cannot be read.
 *
 *   kekAvailable() → bool
 *   newDataKey() → Buffer(32)
 *   wrapKey(dataKey, voiceId) / unwrapKey(wrapped, voiceId)
 *   seal(buffer, dataKey, voiceId) → Buffer  ("CFV1" | iv 12 | tag 16 | ciphertext)
 *   open(buffer, dataKey, voiceId) → Buffer  (throws on a wrong key, voice or a modified file)
 *   sealJson / openJson
 * Never logs or returns key material.
 */
import crypto from 'node:crypto';

const MAGIC = Buffer.from('CFV1');

function kek(env = process.env) {
    const raw = String(env.VOICE_KEK || '').trim();
    if (!raw) return null;
    let key = null;
    if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
    else {
        try { key = Buffer.from(raw, 'base64'); } catch { key = null; }
    }
    return key && key.length === 32 ? key : null;
}

export function kekAvailable(env = process.env) { return !!kek(env); }

export function newDataKey() { return crypto.randomBytes(32); }

function aead(key, plain, aad) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(String(aad), 'utf8'));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

function unaead(key, sealed, aad) {
    const b = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
    if (b.length < 32 || !b.subarray(0, 4).equals(MAGIC)) throw new Error('not a sealed voice file');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(4, 16));
    d.setAAD(Buffer.from(String(aad), 'utf8'));
    d.setAuthTag(b.subarray(16, 32));
    return Buffer.concat([d.update(b.subarray(32)), d.final()]);
}

export function wrapKey(dataKey, voiceId, env = process.env) {
    const k = kek(env);
    if (!k) throw new Error('VOICE_KEK is not set');
    return `v1:${aead(k, dataKey, `key:${voiceId}`).toString('base64')}`;
}

export function unwrapKey(wrapped, voiceId, env = process.env) {
    const k = kek(env);
    if (!k) throw new Error('VOICE_KEK is not set');
    const s = String(wrapped || '');
    if (!s.startsWith('v1:')) throw new Error('no data key (the voice was deleted)');
    return unaead(k, Buffer.from(s.slice(3), 'base64'), `key:${voiceId}`);
}

export function seal(buf, dataKey, voiceId) { return aead(dataKey, buf, `file:${voiceId}`); }
export function open(buf, dataKey, voiceId) { return unaead(dataKey, buf, `file:${voiceId}`); }
export function sealJson(obj, dataKey, voiceId) { return seal(Buffer.from(JSON.stringify(obj), 'utf8'), dataKey, voiceId).toString('base64'); }
export function openJson(b64, dataKey, voiceId) { return JSON.parse(open(Buffer.from(String(b64), 'base64'), dataKey, voiceId).toString('utf8')); }

/** A one-way, salted hash of an IP address for the consent record. */
export function ipHash(ip, env = process.env) {
    const salt = String(env.VOICE_KEK || 'no-kek');
    return crypto.createHmac('sha256', `ip:${salt}`).update(String(ip || '')).digest('hex');
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export default { kekAvailable, newDataKey, wrapKey, unwrapKey, seal, open, sealJson, openJson, ipHash, sha256 };
