/**
 * Decides whether a live announcement may be edited right now (H-311).
 *
 * Two jobs edit the same live posts: the stream checker (every 1-3 min, embeds every 5th cycle) and
 * the announcement updater (every 5 min). Announcements in the 'twitch' preview style were edited
 * by both on every pass, whether or not anything had changed. On 2026-11-17 from 22:02 every
 * Discord request for KumaCaste Utility's announcement channel (guild 901599353389596712, channel
 * 1240282619820642324) sat in discord.js's per-route queue for 60-200 s; abandoned edits were not
 * cancelled, each pass queued 3-8 more behind them plus re-posts for messages the checker had
 * already deleted, and the queue never drained until a restart at about 09:00 (374 timeouts).
 *
 * Rules, in order (an edit of an existing message only; new posts are never held back):
 *   1. one edit per message at a time (the edit already running will land);
 *   2. one edit per channel at a time, so a slow channel cannot build a queue;
 *   3. not while Discord has told us this channel (or the bot) is rate limited;
 *   4. not when the rendered announcement is identical to what the message already shows;
 *   5. a change that only moves the viewer count / preview frame at most every minRefreshMs;
 *   6. at most channelMaxEdits edits per channel per channelWindowMs.
 * A held-back edit is simply dropped: the next pass renders the current state anyway.
 */

export const DEFAULTS = Object.freeze({
    minRefreshMs: 4 * 60_000,
    channelWindowMs: 60_000,
    channelMaxEdits: 6,
    staleInFlightMs: 10 * 60_000,
    rateLimitSlackMs: 3_000,
    fingerprintTtlMs: 12 * 60 * 60_000,
});

export function createEditGovernor(options = {}) {
    const opt = { ...DEFAULTS, ...options };
    const now = options.now || Date.now;

    const inFlightByMessage = new Map(); // messageId -> started
    const inFlightByChannel = new Map(); // channelKey -> { messageId, started }
    const applied = new Map();           // messageId -> { major, minor, at }
    const recentEdits = new Map();       // channelKey -> [timestamps]
    const blockedUntil = new Map();      // `${botKey}:${channelId}` or `${botKey}:global` -> ms

    const channelKey = (botKey, channelId) => `${botKey || 'bot'}:${channelId}`;

    function prune(t) {
        if (applied.size > 5000) {
            for (const [id, v] of applied) if (t - v.at > opt.fingerprintTtlMs) applied.delete(id);
        }
        if (blockedUntil.size > 2000) {
            for (const [k, until] of blockedUntil) if (until < t) blockedUntil.delete(k);
        }
    }

    /**
     * @param {object} p
     * @param {string} p.messageId
     * @param {string} p.channelId
     * @param {string} [p.botKey]   which REST client (bot user id / 'wh:<channel>')
     * @param {string} p.major      fingerprint of what matters (title, game, style, text, persona)
     * @param {string} [p.minor]    fingerprint of what drifts (viewers, preview frame, card image)
     * @returns {{ ok: true } | { ok: false, reason: string, waitMs?: number }}
     */
    function check({ messageId, channelId, botKey, major, minor = '' }) {
        const t = now();
        const ck = channelKey(botKey, channelId);

        const mine = inFlightByMessage.get(messageId);
        if (mine && t - mine < opt.staleInFlightMs) return { ok: false, reason: 'message-in-flight', waitMs: t - mine };

        const ch = inFlightByChannel.get(ck);
        if (ch && t - ch.started < opt.staleInFlightMs) return { ok: false, reason: 'channel-busy', waitMs: t - ch.started };

        const blocked = Math.max(blockedUntil.get(`${botKey || 'bot'}:${channelId}`) || 0, blockedUntil.get(`${botKey || 'bot'}:global`) || 0);
        if (blocked - t > opt.rateLimitSlackMs) return { ok: false, reason: 'rate-limited', waitMs: blocked - t };

        const last = applied.get(messageId);
        if (last && last.major === major) {
            if (last.minor === minor) return { ok: false, reason: 'unchanged' };
            if (t - last.at < opt.minRefreshMs) return { ok: false, reason: 'refreshed-recently', waitMs: t - last.at };
        }

        const recent = (recentEdits.get(ck) || []).filter(ts => t - ts < opt.channelWindowMs);
        recentEdits.set(ck, recent);
        if (recent.length >= opt.channelMaxEdits) return { ok: false, reason: 'channel-budget', waitMs: opt.channelWindowMs - (t - recent[0]) };

        return { ok: true };
    }

    function begin({ messageId, channelId, botKey }) {
        const t = now();
        const ck = channelKey(botKey, channelId);
        inFlightByMessage.set(messageId, t);
        inFlightByChannel.set(ck, { messageId, started: t });
        const recent = recentEdits.get(ck) || [];
        recent.push(t);
        recentEdits.set(ck, recent);
    }

    function end({ messageId, channelId, botKey }) {
        inFlightByMessage.delete(messageId);
        const ck = channelKey(botKey, channelId);
        if (inFlightByChannel.get(ck)?.messageId === messageId) inFlightByChannel.delete(ck);
    }

    /** The message now shows this rendering (after an edit or a fresh post). */
    function recordApplied(messageId, { major, minor = '' }) {
        const t = now();
        applied.set(messageId, { major, minor, at: t });
        prune(t);
    }

    function forget(messageId) {
        applied.delete(messageId);
    }

    /** Discord said wait: from discord.js 'rateLimited' or an unexpected 429 (restDebug). */
    function noteRateLimit({ botKey, channelId = null, global = false, retryAfterMs }) {
        const ms = Number(retryAfterMs);
        if (!Number.isFinite(ms) || ms <= 0) return;
        const k = global ? `${botKey || 'bot'}:global` : `${botKey || 'bot'}:${channelId}`;
        const until = now() + ms;
        if ((blockedUntil.get(k) || 0) < until) blockedUntil.set(k, until);
    }

    /** Plain-words state of a channel/message, for timeout log lines. */
    function describe({ messageId, channelId, botKey }) {
        const t = now();
        const parts = [];
        const mine = inFlightByMessage.get(messageId);
        if (mine) parts.push(`an edit of this message has been running ${Math.round((t - mine) / 1000)}s`);
        const ch = inFlightByChannel.get(channelKey(botKey, channelId));
        if (ch && ch.messageId !== messageId) parts.push(`another edit in this channel has been running ${Math.round((t - ch.started) / 1000)}s`);
        const blocked = Math.max(blockedUntil.get(`${botKey || 'bot'}:${channelId}`) || 0, blockedUntil.get(`${botKey || 'bot'}:global`) || 0);
        if (blocked > t) parts.push(`Discord rate limit for ${Math.round((blocked - t) / 1000)}s more`);
        const recent = (recentEdits.get(channelKey(botKey, channelId)) || []).filter(ts => t - ts < opt.channelWindowMs).length;
        parts.push(`${recent} edit(s) in this channel in the last ${Math.round(opt.channelWindowMs / 1000)}s`);
        return parts.join('; ');
    }

    return { check, begin, end, recordApplied, forget, noteRateLimit, describe, _state: { inFlightByMessage, inFlightByChannel, applied, recentEdits, blockedUntil } };
}

/**
 * Parse the "Encountered unexpected 429 rate limit" restDebug text from @discordjs/rest. These
 * 429s (shared / sub-limits) make discord.js sleep with no 'rateLimited' event.
 * @returns {{ global: boolean, route: string, majorParameter: string, retryAfterMs: number, sublimitMs: number, scope: string, method: string } | null}
 */
export function parseUnexpected429(message) {
    if (typeof message !== 'string' || !message.includes('unexpected 429')) return null;
    const field = (name) => {
        const m = message.match(new RegExp(`${name}\\s*:\\s*([^\\n]+)`));
        return m ? m[1].trim() : null;
    };
    const retry = parseInt(field('Retry After') || '', 10);
    const sub = field('Sublimit');
    return {
        global: field('Global') === 'true',
        method: field('Method') || '',
        route: field('Bucket') || '',
        majorParameter: field('Major parameter') || '',
        retryAfterMs: Number.isFinite(retry) ? retry : 0,
        sublimitMs: sub && sub !== 'None' ? parseInt(sub, 10) || 0 : 0,
        scope: field('Scope') || '',
    };
}
