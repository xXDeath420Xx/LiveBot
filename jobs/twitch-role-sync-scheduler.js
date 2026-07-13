import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { getChannelVIPs, getChannelModerators, refreshBroadcasterToken } from '../utils/platforms/twitch.js';

let schedulerTask = null;
let defaultClient = null;

/**
 * Get a valid access token for a broadcaster, refreshing if expired.
 * Returns the decrypted access token or null if refresh fails.
 */
async function getValidToken(config) {
    let accessToken;
    try {
        accessToken = encryption.decrypt(JSON.parse(config.broadcaster_token));
    } catch {
        logger.error(`[TwitchRoleSync] Failed to decrypt token for guild ${config.guild_id}`);
        return null;
    }

    // Check if expired
    if (config.token_expires_at && new Date(config.token_expires_at) <= new Date()) {
        if (!config.broadcaster_refresh_token) {
            logger.error(`[TwitchRoleSync] Token expired and no refresh token for guild ${config.guild_id}`);
            await pool.execute('UPDATE twitch_role_sync_config SET enabled = 0 WHERE guild_id = ?', [config.guild_id]);
            return null;
        }

        try {
            const refreshToken = encryption.decrypt(JSON.parse(config.broadcaster_refresh_token));
            const newTokens = await refreshBroadcasterToken(refreshToken);

            // Re-encrypt and save
            const encryptedToken = JSON.stringify(encryption.encrypt(newTokens.access_token));
            const encryptedRefresh = newTokens.refresh_token
                ? JSON.stringify(encryption.encrypt(newTokens.refresh_token))
                : config.broadcaster_refresh_token;
            const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000)
                .toISOString().slice(0, 19).replace('T', ' ');

            await pool.execute(`
                UPDATE twitch_role_sync_config SET
                    broadcaster_token = ?, broadcaster_refresh_token = ?, token_expires_at = ?
                WHERE guild_id = ?
            `, [encryptedToken, encryptedRefresh, expiresAt, config.guild_id]);

            accessToken = newTokens.access_token;
            logger.info(`[TwitchRoleSync] Refreshed token for ${config.broadcaster_twitch_username} (guild ${config.guild_id})`);
        } catch (err) {
            logger.error(`[TwitchRoleSync] Token refresh failed for guild ${config.guild_id}:`, { error: err.message });
            await pool.execute('UPDATE twitch_role_sync_config SET enabled = 0 WHERE guild_id = ?', [config.guild_id]);
            return null;
        }
    }

    return accessToken;
}

/**
 * Sync VIP/Mod roles for a single guild.
 */
async function syncGuild(config) {
    const { guild_id, broadcaster_twitch_id, broadcaster_twitch_username, vip_role_id, mod_role_id } = config;

    if (!vip_role_id && !mod_role_id) return; // Nothing to sync

    const accessToken = await getValidToken(config);
    if (!accessToken) return;

    // Get bot client for this guild
    const botClient = global.botManager?.getClientForGuild(guild_id) || defaultClient;
    const guild = botClient?.guilds?.cache?.get(guild_id);
    if (!guild) {
        logger.warn(`[TwitchRoleSync] Guild ${guild_id} not found in any bot cache`);
        return;
    }

    // Fetch VIP and mod lists from Twitch
    let vipList = [];
    let modList = [];

    try {
        if (vip_role_id) vipList = await getChannelVIPs(broadcaster_twitch_id, accessToken);
        if (mod_role_id) modList = await getChannelModerators(broadcaster_twitch_id, accessToken);
    } catch (err) {
        logger.error(`[TwitchRoleSync] API error for ${broadcaster_twitch_username}:`, { error: err.message });
        return;
    }

    const vipTwitchIds = new Set(vipList.map(v => v.user_id));
    const modTwitchIds = new Set(modList.map(m => m.user_id));

    logger.info(`[TwitchRoleSync] ${broadcaster_twitch_username}: ${vipList.length} VIPs, ${modList.length} mods on Twitch`);

    // Get Discord↔Twitch links from multiple sources
    // 1. community_twitch_links (community support tracking)
    // 2. streamers table (streamers with linked Discord accounts in this guild's subscriptions)
    const linkMap = new Map(); // discord_user_id → {twitch_user_id, twitch_username}

    const [communityLinks] = await pool.execute(
        'SELECT discord_user_id, twitch_user_id, twitch_username FROM community_twitch_links WHERE guild_id = ? AND twitch_user_id IS NOT NULL',
        [guild_id]
    );
    for (const l of communityLinks) linkMap.set(l.discord_user_id, l);

    // Also check streamers with discord_user_id linked and subscribed to this guild
    const [streamerLinks] = await pool.execute(
        `SELECT DISTINCT s.discord_user_id, s.platform_user_id AS twitch_user_id, s.username AS twitch_username
         FROM streamers s
         JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
         WHERE sub.guild_id = ? AND s.platform = 'twitch' AND s.discord_user_id IS NOT NULL AND s.platform_user_id IS NOT NULL`,
        [guild_id]
    );
    for (const l of streamerLinks) {
        if (!linkMap.has(l.discord_user_id)) linkMap.set(l.discord_user_id, l);
    }

    // Also check guild members with Discord connected Twitch (from presence detection cache)
    // Fetch all guild members and check if any have Twitch activities we've seen
    const links = Array.from(linkMap.values());

    if (links.length === 0) {
        logger.info(`[TwitchRoleSync] No Discord↔Twitch linked members found for guild ${guild_id}`);
        await pool.execute('UPDATE twitch_role_sync_config SET last_synced = NOW() WHERE guild_id = ?', [guild_id]);
        return;
    }

    logger.info(`[TwitchRoleSync] Found ${links.length} linked members to check`);

    let added = 0, removed = 0;

    for (const link of links) {
        const member = guild.members.cache.get(link.discord_user_id);
        if (!member) continue; // Not in server

        const isVipOnTwitch = vipTwitchIds.has(link.twitch_user_id);
        const isModOnTwitch = modTwitchIds.has(link.twitch_user_id);

        try {
            // VIP role sync
            if (vip_role_id) {
                const hasVipRole = member.roles.cache.has(vip_role_id);
                if (isVipOnTwitch && !hasVipRole) {
                    await member.roles.add(vip_role_id, `Twitch VIP sync — ${broadcaster_twitch_username}`);
                    added++;
                } else if (!isVipOnTwitch && hasVipRole) {
                    await member.roles.remove(vip_role_id, `Lost Twitch VIP — ${broadcaster_twitch_username}`);
                    removed++;
                }
            }

            // Mod role sync
            if (mod_role_id) {
                const hasModRole = member.roles.cache.has(mod_role_id);
                if (isModOnTwitch && !hasModRole) {
                    await member.roles.add(mod_role_id, `Twitch Mod sync — ${broadcaster_twitch_username}`);
                    added++;
                } else if (!isModOnTwitch && hasModRole) {
                    await member.roles.remove(mod_role_id, `Lost Twitch Mod — ${broadcaster_twitch_username}`);
                    removed++;
                }
            }

            // Update sync cache
            await pool.execute(`
                INSERT INTO twitch_role_sync_members (guild_id, discord_user_id, twitch_user_id, twitch_username, is_vip, is_mod, last_synced)
                VALUES (?, ?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE is_vip = VALUES(is_vip), is_mod = VALUES(is_mod), last_synced = NOW()
            `, [guild_id, link.discord_user_id, link.twitch_user_id, link.twitch_username, isVipOnTwitch ? 1 : 0, isModOnTwitch ? 1 : 0]);

        } catch (err) {
            // Role hierarchy or permission issue — skip silently
        }

        // Small delay to avoid Discord rate limits
        if (added + removed > 0) await new Promise(r => setTimeout(r, 200));
    }

    // Update last synced
    await pool.execute('UPDATE twitch_role_sync_config SET last_synced = NOW() WHERE guild_id = ?', [guild_id]);

    if (added > 0 || removed > 0) {
        logger.info(`[TwitchRoleSync] Synced ${broadcaster_twitch_username} for ${guild.name}: +${added} -${removed} role changes`);
    }
}

/**
 * Run sync for all enabled guilds.
 */
async function runSync() {
    try {
        const [configs] = await pool.execute('SELECT * FROM twitch_role_sync_config WHERE enabled = 1');
        if (configs.length === 0) return;

        logger.info(`[TwitchRoleSync] Syncing ${configs.length} guild(s)`);

        for (const config of configs) {
            try {
                await syncGuild(config);
            } catch (err) {
                logger.error(`[TwitchRoleSync] Error syncing guild ${config.guild_id}:`, { error: err.message });
            }
            // Delay between guilds
            await new Promise(r => setTimeout(r, 2000));
        }
    } catch (err) {
        logger.error('[TwitchRoleSync] Scheduler error:', { error: err.message });
    }
}

/**
 * Start the Twitch role sync scheduler.
 */
export function startTwitchRoleSyncScheduler(client) {
    defaultClient = client;

    if (schedulerTask) return;

    schedulerTask = cron.schedule('*/15 * * * *', runSync);
    schedulerTask.start();
    logger.info('[TwitchRoleSyncScheduler] Started (every 15 minutes)');

    // Initial sync after 45 seconds (give bots time to load)
    setTimeout(runSync, 45000);
}

export function stopTwitchRoleSyncScheduler() {
    if (schedulerTask) {
        schedulerTask.stop();
        schedulerTask = null;
    }
}

// Export syncGuild for manual "Sync Now" from dashboard
export { syncGuild, runSync, getValidToken };
