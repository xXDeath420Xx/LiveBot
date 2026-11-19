/*
 * Stream bot: "Sign in with CertiFried" for CertiFried Studio (design §5.9). A browser approval instead of typing a code.
 *
 *   1. Studio asks for a link request (no session): it gets a request id, a polling secret only it knows, and a short
 *      check code it shows to the person.
 *   2. Studio opens https://certifriedmultitool.com/stream/bot/devices/link?request=<id>. The signed-in person sees the
 *      device name and the same check code, and approves or cancels (a form with the CSRF token).
 *   3. Studio polls with id + secret. Once approved, the poll that wins mints the device token (the existing device
 *      store) and returns it once. The id alone never yields anything: a poll with a wrong secret looks exactly like an
 *      unknown request, and five wrong secrets end the request.
 *
 * Requests live in memory for 10 minutes (a restart drops them; Studio then shows "expired" and the person starts again).
 * Only hashes of the secret are kept.
 *
 *   createLinkRequests({ now, ttlMs, maxPending, maxSecretFailures })
 *     create({ name, capabilities, ip })  → { id, secret, check, expiresAt }        throws code 'busy' when full
 *     view(id)                             → { id, name, check, status, expiresAt, ip } | null (unknown or expired)
 *     approve(id, profileId) / cancel(id)  → true when it was pending
 *     poll(id, secret)                     → null (unknown, expired or wrong secret) | { status: 'pending' }
 *                                            | { status: 'cancelled' } (once) | { status: 'approved', profileId, name, capabilities }
 *                                            (the request is then held as 'minting' until finish() or release())
 *     finish(id)                           the token was handed over: the request is gone (single use)
 *     release(id)                          minting failed: back to 'approved' so the next poll can try again
 *     sweep()                              drop expired requests
 *
 * Tested in tests/stream-bot-link.test.js.
 */
import crypto from 'node:crypto';

export const LINK_TTL_MS = 10 * 60 * 1000;
const CHECK_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();
export const isLinkId = (s) => typeof s === 'string' && ID_RE.test(s);
export const isLinkSecret = (s) => typeof s === 'string' && SECRET_RE.test(s);

function checkCode() {
    const b = crypto.randomBytes(4);
    let s = '';
    for (let i = 0; i < 4; i++) s += CHECK_ALPHABET[b[i] % CHECK_ALPHABET.length];
    return s;
}

const CONTROL_CHARS = new RegExp('[\u0000-\u001f\u007f\u2028\u2029]', 'g');

export function cleanDeviceName(v) {
    // Shown on the approval page: printable text only, one line.
    const s = String(v ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    return s || 'CertiFried Studio';
}

export function createLinkRequests({ now = () => Date.now(), ttlMs = LINK_TTL_MS, maxPending = 500, maxSecretFailures = 5 } = {}) {
    const byId = new Map();

    function live(id) {
        if (!isLinkId(id)) return null;
        const r = byId.get(id);
        if (!r) return null;
        if (r.expiresAt <= now()) { byId.delete(id); return null; }
        return r;
    }

    function sweep() {
        const t = now();
        for (const [id, r] of byId) if (r.expiresAt <= t) byId.delete(id);
    }

    return {
        create({ name, capabilities = [], ip = null } = {}) {
            if (byId.size >= maxPending) sweep();
            if (byId.size >= maxPending) { const e = new Error('too many open sign-in requests'); e.code = 'busy'; throw e; }
            const id = crypto.randomBytes(16).toString('base64url');
            const secret = crypto.randomBytes(32).toString('base64url');
            const caps = [...new Set((Array.isArray(capabilities) ? capabilities : []).map((c) => String(c).toLowerCase()).filter((c) => /^[a-z0-9_.-]{1,20}$/.test(c)))].slice(0, 20);
            const r = { id, secretHash: sha(secret), check: checkCode(), name: cleanDeviceName(name), capabilities: caps, ip: ip ? String(ip).slice(0, 64) : null,
                status: 'pending', profileId: null, failures: 0, expiresAt: now() + ttlMs };
            byId.set(id, r);
            return { id, secret, check: r.check, expiresAt: new Date(r.expiresAt) };
        },
        view(id) {
            const r = live(id);
            return r ? { id: r.id, name: r.name, check: r.check, status: r.status, expiresAt: new Date(r.expiresAt), ip: r.ip } : null;
        },
        approve(id, profileId) {
            const r = live(id);
            if (!r || r.status !== 'pending' || !profileId) return false;
            r.status = 'approved';
            r.profileId = profileId;
            return true;
        },
        cancel(id) {
            const r = live(id);
            if (!r || r.status !== 'pending') return false;
            r.status = 'cancelled';
            return true;
        },
        poll(id, secret) {
            const r = live(id);
            if (!r || !isLinkSecret(secret)) return null;
            if (!crypto.timingSafeEqual(sha(secret), r.secretHash)) {
                r.failures++;
                if (r.failures >= maxSecretFailures) byId.delete(id);
                return null;
            }
            if (r.status === 'pending' || r.status === 'minting') return { status: 'pending' };
            if (r.status === 'cancelled') { byId.delete(id); return { status: 'cancelled' }; }
            r.status = 'minting';
            return { status: 'approved', profileId: r.profileId, name: r.name, capabilities: [...r.capabilities] };
        },
        finish(id) { byId.delete(id); },
        release(id) { const r = byId.get(id); if (r && r.status === 'minting') r.status = 'approved'; },
        sweep,
        get size() { return byId.size; },
    };
}

export default { createLinkRequests, cleanDeviceName, isLinkId, isLinkSecret, LINK_TTL_MS };
