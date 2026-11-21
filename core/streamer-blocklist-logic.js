/*
 * Per-server "never announce these streamers" list: the matching rules, no database.
 * Storage and the cache are in core/streamer-blocklist.js; the table is guild_streamer_blocklist
 * (migration 479).
 *
 * An entry names one account on one platform. It matches a streamer when:
 *   - both sides have a platform user id and they are equal (a rename does not get around it), or
 *   - the entry has no user id and the login matches, case-insensitively.
 * An entry with a user id never matches on login alone, so a new account that takes a blocked
 * person's old name is not caught by mistake.
 *
 * streamer_discord_id on an entry (filled in when the streamer's Discord account is known) is used only
 * by features that start from a Discord member rather than a stream account: the media showcase.
 */

export const BLOCK_PLATFORMS = ['twitch', 'kick', 'youtube', 'tiktok', 'trovo', 'facebook', 'rumble'];
const LOGIN_RE = /^[a-z0-9_.-]{1,64}$/;

export function normLogin(s) {
    return String(s ?? '').trim().replace(/^@/, '').toLowerCase();
}

/**
 * Turn what an admin typed (a login, @login or a channel URL) into a login for that platform.
 * Returns '' when nothing usable is left.
 */
export function parseStreamerInput(raw, platform = 'twitch') {
    let s = String(raw ?? '').trim();
    if (!s) return '';
    const hosts = {
        twitch: /^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\//i,
        kick: /^(?:https?:\/\/)?(?:www\.)?kick\.com\//i,
        youtube: /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(?:@|c\/|channel\/|user\/)?/i,
        tiktok: /^(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@?/i,
        trovo: /^(?:https?:\/\/)?(?:www\.)?trovo\.live\/(?:s\/)?/i,
        rumble: /^(?:https?:\/\/)?(?:www\.)?rumble\.com\/(?:c\/|user\/)?/i,
        facebook: /^(?:https?:\/\/)?(?:www\.|m\.)?facebook\.com\//i,
    };
    if (hosts[platform]) s = s.replace(hosts[platform], '');
    s = normLogin(s.split(/[/?#\s]/)[0]);
    return LOGIN_RE.test(s) ? s : '';
}

/**
 * @param {Array<{platform:string, platform_user_id?:string|null, username:string}>} entries  one server's entries
 * @param {{platform:string, platformUserId?:string|null, username?:string|null}} who
 * @returns {object|null} the matching entry
 */
export function findBlock(entries, who) {
    if (!Array.isArray(entries) || !entries.length || !who) return null;
    const platform = String(who.platform || '').toLowerCase();
    const id = who.platformUserId != null && who.platformUserId !== '' ? String(who.platformUserId) : null;
    const login = normLogin(who.username);
    for (const e of entries) {
        if (String(e.platform).toLowerCase() !== platform) continue;
        const eid = e.platform_user_id != null && e.platform_user_id !== '' ? String(e.platform_user_id) : null;
        if (eid) {
            if (id && eid === id) return e;
            // Our side has no id (an old streamers row): fall back to the login the entry was made with.
            if (!id && login && normLogin(e.username) === login) return e;
            continue;
        }
        if (login && normLogin(e.username) === login) return e;
    }
    return null;
}

/** Entries of one server whose Discord account is this member. */
export function findBlockByDiscordId(entries, discordUserId) {
    if (!discordUserId || !Array.isArray(entries)) return null;
    return entries.find(e => e.streamer_discord_id && String(e.streamer_discord_id) === String(discordUserId)) || null;
}

/**
 * Drop the subscriptions a server has blocked. Rows are the stream manager's subscription rows
 * (guild_id, platform, username, platform_user_id). Returns { kept, dropped }.
 * @param {Map<string, object[]>} byGuild guild id -> entries
 */
export function splitBlockedSubscriptions(subscriptions, byGuild) {
    const kept = [];
    const dropped = [];
    for (const sub of subscriptions || []) {
        const entries = byGuild?.get(String(sub.guild_id));
        const hit = entries && findBlock(entries, {
            platform: sub.platform, platformUserId: sub.platform_user_id, username: sub.username,
        });
        (hit ? dropped : kept).push(sub);
    }
    return { kept, dropped };
}
