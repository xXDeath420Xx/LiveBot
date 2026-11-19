/*
 * Team-sync exclusions — pure helpers (no DB, no Discord), shared by core/team-sync.js and
 * /admin teamsync exclude|include|excluded.
 *
 * Exclusions live in `blacklisted_users`:
 *   guild_id NULL   → applies to every server's team sync (the table's original, global meaning)
 *   guild_id = X    → only server X's team sync skips that streamer (migration 287)
 *
 * A row matches a roster member by platform user id OR by login, because an admin may exclude
 * someone before the Twitch API has resolved their id (the row then stores the login in both
 * columns) and logins can change while ids cannot.
 */

const LOGIN_RE = /^[a-z0-9_]{3,25}$/;

/** Normalise a Twitch login typed by an admin ("@Name", "twitch.tv/name", " name "). */
export function normaliseLogin(raw) {
    let s = String(raw || '').trim().toLowerCase();
    s = s.replace(/^https?:\/\//, '').replace(/^(www\.)?twitch\.tv\//, '').replace(/^@/, '');
    s = s.split(/[/?#]/)[0];   // a URL's path/query; whitespace inside a name stays invalid
    return LOGIN_RE.test(s) ? s : null;
}

/** Set of `platform:login` and `platform:id` keys from blacklisted_users rows. */
export function buildExclusionSet(rows) {
    const set = new Set();
    for (const r of rows || []) {
        const platform = String(r.platform || 'twitch').toLowerCase();
        if (r.username) set.add(`${platform}:${String(r.username).toLowerCase()}`);
        if (r.platform_user_id) set.add(`${platform}:${String(r.platform_user_id).toLowerCase()}`);
    }
    return set;
}

/** Is a Twitch roster member ({ user_login, user_id }) or a streamers row ({ username, platform_user_id }) excluded? */
export function isExcluded(set, member, platform = 'twitch') {
    const login = String(member.user_login ?? member.username ?? '').toLowerCase();
    const id = String(member.user_id ?? member.platform_user_id ?? '').toLowerCase();
    return (login && set.has(`${platform}:${login}`)) || (id && set.has(`${platform}:${id}`)) || false;
}
