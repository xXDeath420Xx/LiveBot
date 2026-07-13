// Resolve a platform identity from a user-supplied username.
// Returns { platformUserId, canonicalUsername, profileImageUrl } or null if the
// platform user does not exist / is not reachable via the provider's API.
//
// Goal: never persist a `temp_...` placeholder ID. If we can't resolve a real
// stable ID at add-time, the caller should reject the add with a clean error so
// the user knows they typed the wrong name, rather than letting a phantom row
// rot in the streamers table and produce the HolyDabRip/lepoor class of bug.
import logger from '../logger.js';

export async function resolveStreamerIdentity(platform, usernameRaw) {
    const clean = String(usernameRaw || '').trim().replace(/^@/, '');
    if (!clean) return null;

    try {
        switch (platform) {
            case 'twitch': {
                const { getTwitchUser } = await import('./twitch.js');
                const u = await getTwitchUser(clean);
                if (!u?.id) return null;
                return {
                    platformUserId: String(u.id),
                    canonicalUsername: u.login || clean,
                    profileImageUrl: u.profile_image_url || null,
                };
            }
            case 'kick': {
                const kickApi = await import('./kick.js');
                const u = await kickApi.getKickUser(clean);
                if (!u?.user?.id) return null;
                return {
                    platformUserId: String(u.user.id),
                    canonicalUsername: u.user.username || clean,
                    profileImageUrl: u.user.profile_pic || null,
                };
            }
            case 'tiktok': {
                const { getUserProfile } = await import('./tiktok.js');
                const u = await getUserProfile(clean).catch(() => null);
                if (!u) return null;
                const id = u.id || u.user_id || u.uid || null;
                if (!id) return null;
                return {
                    platformUserId: String(id),
                    canonicalUsername: u.unique_id || u.username || clean,
                    profileImageUrl: u.avatar_url || u.avatarThumb || null,
                };
            }
            case 'youtube':
                // YouTube "username" from dashboard is already expected to be the channel ID
                // (starts with UC…). Channel IDs are the stable identifier on YouTube.
                return {
                    platformUserId: clean,
                    canonicalUsername: clean,
                    profileImageUrl: null,
                };
            case 'trovo':
            case 'facebook':
                // These platforms don't expose a cheap username→id resolver in the current
                // utility set. Treat username as both id and display name. Not ideal for
                // rename tracking, but no worse than previous behavior and still avoids the
                // `temp_…` placeholder pattern.
                return {
                    platformUserId: clean,
                    canonicalUsername: clean,
                    profileImageUrl: null,
                };
            default:
                return null;
        }
    } catch (err) {
        logger.error(`[resolveStreamerIdentity] error for ${platform}:${clean}: ${err.message}`);
        return null;
    }
}

// Upsert a streamer row by real platform_user_id. Handles three cases:
//   (a) row already exists for (platform, platform_user_id) — update username + discord link
//   (b) no match by ID, but a legacy row exists with the same username (possibly temp_-prefixed) — upgrade it
//   (c) no match at all — insert fresh
// Returns the streamer_id.
export async function upsertStreamerByIdentity(pool, platform, identity, discordUserId) {
    const { platformUserId, canonicalUsername, profileImageUrl } = identity;

    const [byId] = await pool.execute(
        'SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?',
        [platform, platformUserId]
    );
    if (byId.length > 0) {
        const id = byId[0].streamer_id;
        await pool.execute(
            `UPDATE streamers SET
                username = ?,
                discord_user_id = COALESCE(?, discord_user_id),
                profile_image_url = COALESCE(?, profile_image_url)
             WHERE streamer_id = ?`,
            [canonicalUsername, discordUserId || null, profileImageUrl || null, id]
        );
        return id;
    }

    // Legacy upgrade path: find by username and patch the platform_user_id.
    const [byName] = await pool.execute(
        'SELECT streamer_id, platform_user_id FROM streamers WHERE platform = ? AND LOWER(username) = LOWER(?)',
        [platform, canonicalUsername]
    );
    if (byName.length > 0) {
        const id = byName[0].streamer_id;
        await pool.execute(
            `UPDATE streamers SET
                platform_user_id = ?,
                username = ?,
                discord_user_id = COALESCE(?, discord_user_id),
                profile_image_url = COALESCE(?, profile_image_url)
             WHERE streamer_id = ?`,
            [platformUserId, canonicalUsername, discordUserId || null, profileImageUrl || null, id]
        );
        if (byName[0].platform_user_id?.startsWith?.('temp_')) {
            logger.info(`[upsertStreamerByIdentity] upgraded temp_ placeholder on streamer ${id} → ${platform}:${platformUserId}`);
        }
        return id;
    }

    const [ins] = await pool.execute(
        'INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?)',
        [platform, platformUserId, canonicalUsername, discordUserId || null, profileImageUrl || null]
    );
    return ins.insertId;
}
