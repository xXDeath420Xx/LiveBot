/*
 * A feed's ping role as stored: a role id of the server, the literal 'everyone', or null for no ping.
 * Shared by the Twitch clip feeds (core/twitch-clip-feeds.js); the Social feeds API checks the same rule
 * in its own field validator. Pure: the guild is passed in, so it is unit-tested without Discord.
 */
export const PING_ROLE_ERROR = 'That ping role is not a role in this server';

/** @returns {string|null}  throws Error(PING_ROLE_ERROR) for anything else */
export function normalizePingRole(raw, guild = null) {
    const s = raw == null ? '' : String(raw).trim();
    if (!s) return null;
    if (s === 'everyone') return 'everyone';
    if (!/^\d{17,20}$/.test(s)) throw new Error(PING_ROLE_ERROR);
    // With a live guild, the role must exist in it and not be the @everyone role's own id.
    if (guild && (s === String(guild.id) || (guild.roles?.cache && !guild.roles.cache.has(s)))) throw new Error(PING_ROLE_ERROR);
    return s;
}
