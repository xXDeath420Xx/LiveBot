/**
 * Per-channel content automod for the Kick chat bot. Pure rule evaluation
 * (evaluateMessage) so it's unit-testable; the live hook (runKickAutomod) loads
 * the channel's features_enabled settings, evaluates, and deletes + warns on a
 * violation. Defender (banlist/phishing) is separate and runs first.
 *
 * Settings live in tokes_channels.features_enabled (JSON), under an `automod`
 * key, e.g. { automod: { caps:true, caps_pct:70, links:true, symbols:true,
 * max_len:0, min_len_for_caps:8 } }. Absent/false = rule off (no behavior change).
 */
import realPool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|gg|tv|xyz|live|co|me|link|store|shop)\b)/i;
const SYMBOL_RE = /[^\p{L}\p{N}\s]/gu;

/**
 * Evaluate a message against a channel's automod settings.
 * @returns {{ rule:string, reason:string }|null}  the first violated rule, or null
 */
export function evaluateMessage(text, settings = {}) {
    const msg = String(text || '');
    if (!msg.trim()) return null;

    // Links — block any URL-like token.
    if (settings.links && URL_RE.test(msg)) {
        return { rule: 'links', reason: 'links are not allowed' };
    }

    // Excessive caps — only on messages of a meaningful length.
    if (settings.caps) {
        const minLen = Number.isInteger(settings.min_len_for_caps) ? settings.min_len_for_caps : 8;
        const letters = msg.replace(/[^A-Za-z]/g, '');
        if (letters.length >= minLen) {
            const caps = (msg.match(/[A-Z]/g) || []).length;
            const pct = (caps / letters.length) * 100;
            const limit = Number.isFinite(settings.caps_pct) ? settings.caps_pct : 70;
            if (pct >= limit) return { rule: 'caps', reason: 'too many capital letters' };
        }
    }

    // Symbol spam — high ratio of non-alphanumeric, non-space chars.
    if (settings.symbols) {
        const total = msg.replace(/\s/g, '').length;
        if (total >= 8) {
            const syms = (msg.match(SYMBOL_RE) || []).length;
            if ((syms / total) * 100 >= (Number.isFinite(settings.symbols_pct) ? settings.symbols_pct : 60)) {
                return { rule: 'symbols', reason: 'too many symbols' };
            }
        }
    }

    // Max length — block over a configured character count (0 = off).
    if (settings.max_len && Number(settings.max_len) > 0 && msg.length > Number(settings.max_len)) {
        return { rule: 'max_len', reason: `message too long (max ${settings.max_len})` };
    }

    return null;
}

// ── Live runtime ────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;

// The real-wired instance's cache lives on the factory output so each
// makeLoadAutomod() gets its own (tests stay isolated; prod shares one).
export function makeLoadAutomod({ pool, ttlMs = CACHE_TTL_MS }) {
    const cache = new Map(); // channelPk -> { automod, expiresAt }
    const loadAutomod = async function loadAutomod(channelPk) {
        const key = Number(channelPk);
        const cached = cache.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.automod;
        let automod = null;
        try {
            const [[row]] = await pool.execute(
                'SELECT features_enabled FROM tokes_channels WHERE id = ?', [key]
            );
            const raw = row?.features_enabled;
            const feats = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
            automod = (feats && feats.automod) || null;
        } catch (err) {
            logger.warn('[KickAutomod] Failed to load settings', { channelPk, error: err.message });
        }
        cache.set(key, { automod, expiresAt: Date.now() + ttlMs });
        return automod;
    };
    loadAutomod.clear = (channelPk) => { if (channelPk != null) cache.delete(Number(channelPk)); };
    return loadAutomod;
}

const loadAutomod = makeLoadAutomod({ pool: realPool });

export function clearKickAutomodCache(channelPk) {
    loadAutomod.clear(channelPk);
}

/**
 * handleMessage hook: returns true if the message violated automod and was
 * actioned (deleted + optional warn). Mods/broadcaster are exempt. Best-effort:
 * never throws into the chat pipeline. `deleteMessage` is the bot's delete fn.
 */
export async function runKickAutomod({ channelPk, messageId, message, username, isMod, isBroadcaster, reply, deleteMessage }) {
    try {
        if (channelPk == null || isMod || isBroadcaster) return false;
        const settings = await loadAutomod(channelPk);
        if (!settings) return false;
        const hit = evaluateMessage(message, settings);
        if (!hit) return false;

        if (messageId && typeof deleteMessage === 'function') {
            try { await deleteMessage(messageId); } catch (_) { /* best effort */ }
        }
        if (typeof reply === 'function') {
            try { reply(`@${username} ${hit.reason}.`); } catch (_) { /* ignore */ }
        }
        return true;
    } catch {
        return false;
    }
}
