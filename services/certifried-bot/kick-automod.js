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
import { parsePermit, grantPermit, hasPermit, permitReply } from './link-permits.js';

const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|gg|tv|xyz|live|co|me|link|store|shop)\b)/i;
const SYMBOL_RE = /[^\p{L}\p{N}\s]/gu;

/**
 * Evaluate a message against a channel's automod settings.
 * @returns {{ rule:string, reason:string }|null}  the first violated rule, or null
 */
export function evaluateMessage(text, settings = {}) {
    const msg = String(text || '');
    if (!msg.trim()) return null;

    // Banned words/phrases — checked FIRST (most explicit rule). `words` is an
    // array or comma-separated string of terms; a term containing '*' matches as
    // a wildcard prefix/suffix/infix, otherwise it matches on word boundaries
    // (so "ass" doesn't hit "class"). Case-insensitive.
    if (settings.words) {
        const lower = msg.toLowerCase();
        const terms = (Array.isArray(settings.words) ? settings.words : String(settings.words).split(','))
            .map(t => String(t).trim().toLowerCase()).filter(Boolean);
        for (const term of terms) {
            if (term.includes('*')) {
                // Wildcard: escape regex chars, * → .*
                const pat = term.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
                if (new RegExp(pat, 'i').test(lower)) {
                    return { rule: 'words', reason: 'that word is not allowed here' };
                }
            } else {
                // Whole-word match (unicode-aware boundaries via non-letter lookaround).
                const pat = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (new RegExp(`(^|[^\\p{L}\\p{N}])${pat}([^\\p{L}\\p{N}]|$)`, 'iu').test(lower)) {
                    return { rule: 'words', reason: 'that word is not allowed here' };
                }
            }
        }
    }

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
        if (channelPk == null) return false;
        // !permit @name (moderators and the broadcaster, only while the link filter is on): links allowed for 60 seconds.
        const permitFor = (isMod || isBroadcaster) ? parsePermit(message) : null;
        if (permitFor) {
            const s = await loadAutomod(channelPk);
            if (!s?.links) return false;
            grantPermit(`kick:${channelPk}`, permitFor);
            if (typeof reply === 'function') { try { reply(permitReply(permitFor)); } catch (_) { /* ignore */ } }
            return true;
        }
        if (isMod || isBroadcaster) return false;
        const settings = await loadAutomod(channelPk);
        if (!settings) return false;
        let hit = evaluateMessage(message, settings);
        // A permitted viewer's link passes; the other rules still apply to the same message.
        if (hit?.rule === 'links' && hasPermit(`kick:${channelPk}`, username)) hit = evaluateMessage(message, { ...settings, links: false });
        if (!hit) return await kickAiCheck({ channelPk, messageId, message, username, settings, deleteMessage });

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

/**
 * The shared AI layer (core/ai-moderation.js, local models only) for a message no rule caught, when the channel
 * set automod.ai_mode to 'detect' or 'enforce' (off by default). enforce deletes clear cases; nothing is ever banned.
 * Decisions go to kbd_enforcement_log (platform 'kick', channel = the tokes_channels id).
 */
async function kickAiCheck({ channelPk, messageId, message, username, settings, deleteMessage }) {
    const mode = ['detect', 'enforce'].includes(settings?.ai_mode) ? settings.ai_mode : 'off';
    if (mode === 'off') return false;
    try {
        const { screenChat } = await import('../../core/ai-moderation.js');
        const r = await screenChat({ platform: 'kick', channelId: String(channelPk), userId: String(username || ''), text: message, mode });
        if (!r || r.action === 'none') return false;
        const reason = `AI ${r.label} ${Math.round(r.confidence * 100)}%${r.reason ? `: ${r.reason}` : ''}`.slice(0, 255);
        let ok = false;
        if (r.action === 'delete' && messageId && typeof deleteMessage === 'function') {
            try { await deleteMessage(messageId); ok = true; } catch (_) { ok = false; }
        }
        await realPool.execute(
            'INSERT INTO kbd_enforcement_log (platform, channel_id, target_user_id, target_username, action, reason, success) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ['kick', String(channelPk), null, String(username || 'unknown').slice(0, 255), r.action === 'delete' ? 'delete' : 'detected', reason, r.action === 'delete' ? (ok ? 1 : 0) : 1],
        ).catch(() => {});
        return ok;
    } catch {
        return false;
    }
}
