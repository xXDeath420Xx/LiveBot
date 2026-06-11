/**
 * Per-channel keyword auto-responders for the Kick/Tokes bot.
 *
 * matchResponder() is pure (no DB/IO) so it's unit-testable: given the active
 * responders for a channel, a message, and a "last fired" timestamp map, it
 * returns the responder to fire (or null). The DB-backed loader + the
 * handleMessage hook live below it.
 */
import realPool from '../../utils/db.js';

const MATCHERS = {
    contains: (msg, trig) => msg.includes(trig),
    exact:    (msg, trig) => msg === trig,
    starts:   (msg, trig) => msg.startsWith(trig),
    word:     (msg, trig) => msg.split(/\s+/).includes(trig)
};

/**
 * Decide which (if any) responder fires for a message.
 * @param {Array}  responders  active responders: {id, trigger_text, match_type, response, cooldown}
 * @param {string} message     raw chat message
 * @param {Map}    lastFired   id -> last-fire epoch ms (per channel; caller owns it)
 * @param {number} now         current epoch ms
 * @returns the matching responder, or null
 */
export function matchResponder(responders, message, lastFired, now) {
    const msg = String(message || '').toLowerCase();
    if (!msg) return null;
    for (const r of responders) {
        const trig = String(r.trigger_text || '').toLowerCase();
        if (!trig) continue;
        const matcher = MATCHERS[r.match_type] || MATCHERS.contains;
        if (!matcher(msg, trig)) continue;
        const last = lastFired.get(r.id);
        // A responder that has never fired (no entry) always fires. Otherwise it
        // must be past its cooldown window. On cooldown → stop (don't fall through
        // to a different responder for the same trigger).
        if (last != null) {
            const cdMs = Math.max(0, Number(r.cooldown) || 0) * 1000;
            if (now - last < cdMs) return null;
        }
        return r;
    }
    return null;
}

// ── DB-backed runtime ───────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
const cache = new Map();           // channelPk -> { responders, expiresAt }
const lastFiredByChannel = new Map(); // channelPk -> Map(id -> epoch ms)

export function clearAutoResponderCache(channelPk) {
    if (channelPk != null) cache.delete(Number(channelPk));
}

export function makeLoadResponders({ pool }) {
    return async function loadResponders(channelPk) {
        const key = Number(channelPk);
        const cached = cache.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.responders;
        const [rows] = await pool.execute(
            `SELECT id, trigger_text, match_type, response, cooldown
             FROM tokes_auto_responders
             WHERE channel_id = ? AND is_enabled = 1`,
            [key]
        );
        cache.set(key, { responders: rows, expiresAt: Date.now() + CACHE_TTL_MS });
        return rows;
    };
}

const loadResponders = makeLoadResponders({ pool: realPool });

/**
 * handleMessage hook: check a non-command chat message against this channel's
 * auto-responders and reply if one fires. `channelPk` is the tokes_channels PK.
 * Returns true if it replied (so the caller can stop). Best-effort: never throws
 * into the chat pipeline.
 *
 * @param processTemplate optional ({{var}}) renderer; falls back to a tiny
 *        {{username}}/{{channel_name}} substitution if not supplied.
 */
export async function runAutoResponders({ channelPk, channelName, username, message, reply }, processTemplate) {
    try {
        if (channelPk == null || typeof reply !== 'function') return false;
        const responders = await loadResponders(channelPk);
        if (!responders.length) return false;

        let fired = lastFiredByChannel.get(Number(channelPk));
        if (!fired) { fired = new Map(); lastFiredByChannel.set(Number(channelPk), fired); }

        const hit = matchResponder(responders, message, fired, Date.now());
        if (!hit) return false;

        fired.set(hit.id, Date.now());
        let text = hit.response;
        if (typeof processTemplate === 'function') {
            text = processTemplate(hit.response, { username, channel_name: channelName });
        } else {
            text = String(hit.response)
                .replace(/\{\{username\}\}/g, () => username || '')
                .replace(/\{\{channel_name\}\}/g, () => channelName || '');
        }
        reply(text);
        // Fire-and-forget usage bump (don't block chat).
        realPool.execute('UPDATE tokes_auto_responders SET use_count = use_count + 1 WHERE id = ?', [hit.id]).catch(() => {});
        return true;
    } catch {
        return false; // never break chat
    }
}
