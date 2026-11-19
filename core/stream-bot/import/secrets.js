/*
 * Stream bot import: credential stripping and the leak scan (design §6.3).
 *
 * Firebot and Streamer.bot files hold OAuth and refresh tokens, API keys, websocket and OBS passwords and webhook
 * URLs. Nothing the importer keeps may carry one, so every parsed object goes through stripSecrets() (drop fields
 * whose name says credential, replace values that look like one) and the result through scanForSecrets(), which
 * must come back empty before anything is stored or leaves the PC. Only counts are ever reported, never values.
 *
 *   stripSecrets(value)   → { value, stripped: { fields, values } }   deep copy, credentials removed
 *   looksSecret(string)   → boolean                                   token, JWT, Bearer, oauth:, webhook URL, long base64/hex
 *   scanForSecrets(value) → [{ path, why }]                           what would leak (paths only, no values)
 *
 * Tested in tests/stream-bot-import.test.js.
 */

/** Words in a field name that always mean credential (any non-empty value is dropped). */
const STRONG = new Set(['token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'pwd', 'refresh', 'bearer', 'cookie', 'cookies',
    'credential', 'credentials', 'webhook', 'webhookurl', 'bytecode', 'apikey', 'privatekey', 'clientsecret', 'signature', 'jwt', 'oauth',
    'accesstoken', 'refreshtoken', 'authpassword', 'sockettoken', 'authorization']);
/** Words that mean credential only when the value looks like one (a hotkey's `key` is "F1", a counter's key is "deaths"). */
const WEAK = new Set(['key', 'keys', 'pass', 'auth', 'session', 'sig', 'code', 'accountid']);
const WEAK_MIN = 16;

/** Split a field name into lower-case words: accessToken, access_token, access-token → access, token. */
export function fieldWords(name) {
    const n = String(name ?? '');
    const words = n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).map((w) => w.toLowerCase()).filter(Boolean);
    const compact = n.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    return { words, compact };
}

/** 'strong' | 'weak' | null for a field name. */
export function secretFieldKind(name) {
    const { words, compact } = fieldWords(name);
    if (STRONG.has(compact) || words.some((w) => STRONG.has(w))) return 'strong';
    if (WEAK.has(compact) || words.some((w) => WEAK.has(w))) return 'weak';
    return null;
}

/** True when this field with this value must not be kept. */
export function isSecretField(name, value = 'x'.repeat(WEAK_MIN)) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean' || typeof value === 'number') return false;
    if (Array.isArray(value) && !value.length) return false;
    const kind = secretFieldKind(name);
    if (kind === 'strong') return true;
    if (kind === 'weak') {
        if (typeof value !== 'string') return false;
        // A hotkey's key, a counter's key, a reward code: short or plain words. A credential is long and mixed.
        return looksSecret(value) || (value.length >= WEAK_MIN + 4 && /^[A-Za-z0-9+/=-]+$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value));
    }
    return false;
}

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const OAUTH = /\boauth:[a-z0-9]{8,}/i;
const WEBHOOK = /(discord(app)?\.com\/api\/webhooks\/|hooks\.slack\.com\/|outlook\.office\.com\/webhook)/i;
const HEX = /\b[0-9a-f]{32,}\b/i;
// A run of 32+ base64/base64url characters with letters and digits (a GUID's dashes and a URL path's slashes break it).
const B64 = /[A-Za-z0-9+_]{32,}={0,2}/;
const URL_SECRET = /[?&](access_token|token|key|api_key|apikey|secret|password|auth|sig|signature|client_secret|code)=[^&\s]{6,}/i;

/** Value test: true when a string has a credential-shaped part. */
export function looksSecret(s) {
    if (typeof s !== 'string' || s.length < 8) return false;
    if (JWT.test(s) || BEARER.test(s) || OAUTH.test(s) || WEBHOOK.test(s) || URL_SECRET.test(s)) return true;
    if (HEX.test(s)) return true;
    const m = s.match(B64);
    if (m) {
        const t = m[0];
        // Long plain words (a URL path, a sentence without spaces) are not keys: require a digit and mixed case or _ / +.
        if (/\d/.test(t) && /[a-z]/.test(t) && (/[A-Z]/.test(t) || /[_+]/.test(t))) return true;
    }
    return false;
}

/**
 * Deep copy without credentials: fields named like a credential are dropped, and string values that look like
 * one are dropped (an array loses that element).
 */
export function stripSecrets(value, { maxDepth = 40 } = {}) {
    const stripped = { fields: 0, values: 0 };
    const walk = (v, depth) => {
        if (depth > maxDepth) return null;
        if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1)).filter((x) => x !== undefined);
        if (v && typeof v === 'object') {
            const out = {};
            for (const [k, x] of Object.entries(v)) {
                if (isSecretField(k, x)) {
                    stripped.fields++;
                    continue;
                }
                const w = walk(x, depth + 1);
                if (w !== undefined) out[k] = w;
            }
            return out;
        }
        if (typeof v === 'string' && looksSecret(v)) { stripped.values++; return undefined; }
        return v;
    };
    return { value: walk(value, 0), stripped };
}

/** Everything in `value` that would leak: [{ path, why }] (no values). Empty means clean. */
export function scanForSecrets(value, { maxDepth = 60 } = {}) {
    const found = [];
    const walk = (v, path, depth) => {
        if (depth > maxDepth || found.length > 200) return;
        if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
        if (v && typeof v === 'object') {
            for (const [k, x] of Object.entries(v)) {
                if (isSecretField(k, x)) found.push({ path: `${path}.${k}`, why: 'credential field' });
                walk(x, `${path}.${k}`, depth + 1);
            }
            return;
        }
        if (typeof v === 'string' && looksSecret(v)) found.push({ path, why: 'credential-shaped value' });
    };
    walk(value, '$', 0);
    return found;
}

export default { stripSecrets, scanForSecrets, looksSecret, isSecretField, secretFieldKind, fieldWords };
