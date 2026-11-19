/**
 * "Reconnecting to Discord" instead of "The bot is not in this server" while bots start up.
 *
 * The dashboard runs in the bot process and reads live bot caches (req.guildObject), so after a
 * restart it serves pages before every bot is back: the default bot logs in first, then the
 * dashboard starts, then ~40 custom bots log in one by one. A server run by a custom bot has no
 * client with it in cache during that window, which the access checks reported as the bot not
 * being in the server (or, in middleware/auth.js, a redirect to the bot invite).
 *
 * pendingReason() tells that window apart from a real "not in this server":
 *   - no bot manager yet, or it is still loading bots (or within a short grace after)  -> 'starting'
 *   - the guild's mapped bot exists but its client is not ready (gateway reconnect),
 *     or the default bot is not ready for a guild no custom bot claims                 -> 'reconnecting'
 *   - otherwise (every bot ready, none has the guild)                                   -> null: real error
 * The page/JSON answer is a 503 with Retry-After; the page re-checks every 5 s and shows the
 * real error itself after ~2 minutes of retries, so a server the bot genuinely left never
 * loops forever. Pure apart from sendReconnecting(); tested in tests/bot-readiness.test.js.
 */

export const RETRY_SECONDS = 5;
export const MAX_RETRIES = 24;          // 24 x 5 s = 2 minutes, then the page shows the real error

/**
 * @param {string} guildId
 * @param {{ botManager?: object, fallbackClient?: object, now?: number }} ctx
 * @returns {'starting'|'reconnecting'|null}
 */
export function pendingReason(guildId, { botManager = global.botManager, fallbackClient = null, now = Date.now() } = {}) {
    if (!botManager) {
        // Before index.js publishes the manager only the default client exists.
        return fallbackClient && fallbackClient.isReady?.() ? null : 'starting';
    }
    if (typeof botManager.isStarting === 'function' && botManager.isStarting(now)) return 'starting';

    const mappedId = botManager.guildBotMapping?.get?.(guildId);
    if (mappedId) {
        const mapped = botManager.clients?.get?.(mappedId);
        // A mapped bot that is gone entirely was removed or failed to log in: that is real.
        if (mapped && !mapped.isReady?.()) return 'reconnecting';
        return null;
    }
    const def = botManager.getDefaultClient?.();
    if (def && !def.isReady?.()) return 'reconnecting';
    return null;
}

const wantsJson = (req) =>
    Boolean(req.xhr) ||
    Boolean(req.is?.('application/json')) ||
    req.accepts?.(['html', 'json']) === 'json' ||
    String(req.originalUrl || '').startsWith('/api/');

/**
 * Answer a request whose guild is not available yet. `realError` is what the page shows if
 * the bot is still missing after MAX_RETRIES checks.
 */
export function sendReconnecting(req, res, reason, realError) {
    res.set('Retry-After', String(RETRY_SECONDS));
    res.set('Cache-Control', 'no-store');
    if (wantsJson(req)) {
        return res.status(503).json({
            error: 'Reconnecting to Discord. Try again in a few seconds.',
            reconnecting: true,
            reason,
            retryAfter: RETRY_SECONDS,
        });
    }
    return res.status(503).render('reconnecting', {
        user: req.user,
        reason,
        realError: realError || 'The bot is not in this server.',
        retrySeconds: RETRY_SECONDS,
        maxRetries: MAX_RETRIES,
    });
}
