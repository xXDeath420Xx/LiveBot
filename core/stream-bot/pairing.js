/*
 * Stream bot: device tokens and pairing codes (design §2.4). Pure crypto helpers; the store keeps hashes only.
 *
 *   newDeviceToken()   'sbd_' + 32 random bytes (base64url): high entropy, so a plain SHA-256 is the right hash
 *   newPairingCode()   'XXXX-XXXX' from an alphabet without look-alikes (0/O, 1/I/L); 10 minutes, single use
 *   hashSecret(s)      SHA-256 hex of the normalised secret
 *   normaliseCode(s)   what the person typed → canonical code (case, spaces and dashes ignored), or null
 *   tokenHint(t)       last 4 characters, shown on the Devices page
 *
 * Tested in tests/stream-bot-realtime.test.js.
 */
import crypto from 'node:crypto';

export const TOKEN_PREFIX = 'sbd_';
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_RE = /^sbd_[A-Za-z0-9_-]{43}$/;

export function newDeviceToken() {
    return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

export function isTokenShape(t) {
    return typeof t === 'string' && TOKEN_RE.test(t);
}

export function newPairingCode() {
    const bytes = crypto.randomBytes(8);
    let s = '';
    for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function normaliseCode(input) {
    const s = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
    if (s.length !== 8) return null;
    for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
    return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function hashSecret(secret) {
    return crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

export function tokenHint(token) {
    return String(token || '').slice(-4);
}

export default { TOKEN_PREFIX, CODE_ALPHABET, CODE_TTL_MS, newDeviceToken, isTokenShape, newPairingCode, normaliseCode, hashSecret, tokenHint };
