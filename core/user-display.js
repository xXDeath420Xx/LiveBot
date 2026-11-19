/**
 * Who a Discord user id is, for the dashboard: avatar, display name and @username.
 *
 * Dashboard tables used to print raw snowflakes (moderation infractions, review queues,
 * leaderboards...). Every page now shows a person the same way: the API returns a `user`
 * object built here next to the id, or the page asks GET /api/guilds/:guildId/users/resolve
 * (dashboard/routes/api/features/user-resolve.js) and draws it with
 * dashboard/public/js/cf-user.js (CFUser.cell). One lookup order everywhere:
 *
 *   1. the guild's member cache   (display name = server nickname, server avatar)
 *   2. the client's user cache    (username, user avatar; inServer false)
 *   3. a stored name the caller already has (a username column on its own table)
 *   4. nothing: the id alone (the page shows it with a copy button)
 *
 * Pure apart from reading the discord.js caches it is handed, so it unit-tests with plain
 * objects (tests/user-display.test.js). It never calls Discord; the resolve route may do one
 * batched members fetch first and then calls this, and for ids still nameless (people who left)
 * asks Discord through core/user-lookup.js (cached, rate-capped) and marks them `left`.
 */

const SNOWFLAKE = /^\d{15,25}$/;
export const MAX_RESOLVE = 100;

/** True for a string that looks like a Discord snowflake. */
export function isSnowflake(id) {
    return SNOWFLAKE.test(String(id ?? ''));
}

function avatarOf(thing) {
    try {
        return thing?.displayAvatarURL?.({ size: 64 }) ?? null;
    } catch {
        return null;
    }
}

/**
 * { id, username, displayName, avatar, inServer } for one id.
 * @param {object} guild         a discord.js Guild (or anything with members.cache / client.users.cache)
 * @param {string} id
 * @param {object} [o]
 * @param {string} [o.storedName] a name the caller stored with the row, used when neither cache knows the id
 */
export function userBits(guild, id, { storedName = null } = {}) {
    const key = String(id ?? '');
    const member = guild?.members?.cache?.get?.(key) ?? null;
    const user = member?.user || guild?.client?.users?.cache?.get?.(key) || null;
    const stored = typeof storedName === 'string' && storedName.trim() ? storedName.trim() : null;
    return {
        id: key,
        username: user?.username ?? stored,
        displayName: member?.displayName ?? user?.username ?? stored,
        avatar: avatarOf(member) ?? avatarOf(user),
        inServer: !!member,
    };
}

/**
 * Bits for many ids at once: de-duplicated, invalid ids dropped, keyed by id.
 * @param {object} guild
 * @param {Iterable<string>} ids
 * @param {object} [storedNames] { [id]: name } fallbacks
 * @returns {Object<string, object>}
 */
export function resolveMany(guild, ids, storedNames = {}) {
    const out = {};
    for (const raw of ids || []) {
        const id = String(raw ?? '').trim();
        if (!isSnowflake(id) || out[id]) continue;
        out[id] = userBits(guild, id, { storedName: storedNames?.[id] ?? null });
    }
    return out;
}

/**
 * The ids of a resolve request (?ids=1,2,3 or repeated ids=): trimmed, valid snowflakes only,
 * de-duplicated, at most MAX_RESOLVE. `tooMany` is true when the request asked for more.
 */
export function parseIdList(value) {
    const parts = (Array.isArray(value) ? value : [value])
        .flatMap((v) => String(v ?? '').split(','))
        .map((s) => s.trim())
        .filter(Boolean);
    const ids = [...new Set(parts.filter(isSnowflake))];
    return { ids: ids.slice(0, MAX_RESOLVE), tooMany: ids.length > MAX_RESOLVE, invalid: parts.filter((p) => !isSnowflake(p)).length };
}

/** A one-line label for logs and confirm() texts: "Name (@user)" / "@user" / the id. */
export function userLabelOf(bits) {
    if (!bits) return '';
    const name = bits.displayName || bits.username;
    if (!name) return bits.id;
    return bits.username && bits.username !== name ? `${name} (@${bits.username})` : name;
}

export default { userBits, resolveMany, parseIdList, isSnowflake, userLabelOf, MAX_RESOLVE };
