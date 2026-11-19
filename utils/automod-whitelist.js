/*
 * Automod whitelist — now the users on the server's protection allowlist (core/protection-exempt.js).
 *
 * This used to be its own table (automod_user_whitelist). Migration 323 copied its rows into
 * protection_allowlist and everything here reads and writes that list, so the automod page, the
 * Protection Settings page, `/protection allowlist` and the spammer check all show the same people.
 * The old table is left in place, unused. Same API as before; cached by core/protection-exempt.js.
 */
import logger from './logger.js';
import {
    getState, listAllowlist, addAllow, removeAllow,
} from '../core/protection-exempt.js';

export async function isWhitelisted(guildId, userId) {
    try {
        return (await getState(guildId)).users.has(userId);
    } catch (error) {
        logger.error('[AutomodWhitelist] Failed to load whitelist:', { error: error.message, guildId });
        return false;
    }
}

/** `guild` is a Guild or a guild id. Throws when the allowlist is full. */
export async function addToWhitelist(guild, userId, addedBy = null, reason = null) {
    const out = await addAllow(guild, 'user', userId, addedBy, reason);
    if (!out.ok) throw new Error(out.error);
}

/** Throws (with the reason) when they can't be removed — they hold an allowlisted role. */
export async function removeFromWhitelist(guild, userId, by = null) {
    const out = await removeAllow(guild, 'user', userId, by);
    if (!out.ok) throw new Error(out.error);
    return !!out.removed;
}

/** [{ user_id, added_by, reason, created_at }] — the shape the old table had. */
export async function getWhitelist(guildId) {
    const rows = await listAllowlist(guildId);
    return rows.filter(r => r.kind === 'user')
        .map(r => ({ user_id: r.target_id, added_by: r.added_by, reason: r.note, created_at: r.added_at }));
}

export default { isWhitelisted, addToWhitelist, removeFromWhitelist, getWhitelist };
