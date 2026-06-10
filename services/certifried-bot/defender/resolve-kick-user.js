/**
 * Resolve a Kick username (slug) to its numeric broadcaster_user_id via the
 * Kick public API. Every Kick user has a channel, so /channels?slug=<name>
 * returns their broadcaster_user_id — which is the `user_id` the moderation
 * endpoints (ban/unban) require.
 *
 * Uses the bot's App Access Token (client-credentials) through kickApiRequest,
 * so it works without any user token. `makeResolveKickUser` injects the api
 * caller for testing; the default binds to the live KickBot.
 */

export function makeResolveKickUser({ apiRequest }) {
    return async function resolveKickUser(username) {
        const slug = String(username || '').trim().toLowerCase().replace(/^@/, '');
        if (!slug) return null;
        const res = await apiRequest(`/channels?slug=${encodeURIComponent(slug)}`);
        const ch = res?.data?.[0];
        if (!ch || ch.broadcaster_user_id == null) return null;
        return { userId: String(ch.broadcaster_user_id), slug: ch.slug || slug };
    };
}

// Default wiring binds to the running KickBot's app-token request helper.
export const resolveKickUser = makeResolveKickUser({
    apiRequest: async (endpoint) => {
        const bot = global.kickBot;
        if (!bot || typeof bot.kickApiRequest !== 'function') {
            throw new Error('Kick bot not ready');
        }
        return bot.kickApiRequest(endpoint);
    }
});
