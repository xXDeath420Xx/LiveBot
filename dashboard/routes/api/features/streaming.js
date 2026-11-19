/**
 * Streaming API
 * Handles streamer notifications configuration
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';
import * as rumbleApi from '../../../../utils/platforms/rumble.js';
import * as kickApi from '../../../../utils/platforms/kick.js';
import { getTwitchUser } from '../../../../utils/platforms/twitch-api.js';
import { getStreamEndDefaults } from '../../../../core/stream-end-defaults.js';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/streaming/config
 * Get streaming configuration
 */
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [config] = await pool.execute(
            'SELECT * FROM guilds WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            config: {
                announcement_channel_id: config[0]?.announcement_channel_id || null,
                live_role_id: config[0]?.live_role_id || null,
                stream_ignored_roles: config[0]?.stream_ignored_roles ? JSON.parse(config[0].stream_ignored_roles) : []
            }
        });
    } catch (error) {
        logger.error('[API Streaming Config GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch streaming config' });
    }
});

/**
 * PUT /api/guilds/:guildId/streaming/config
 * Update streaming configuration
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { announcement_channel_id, live_role_id, stream_ignored_roles } = req.body;
        const ignoredRolesJson = stream_ignored_roles
            ? JSON.stringify(Array.isArray(stream_ignored_roles) ? stream_ignored_roles : [stream_ignored_roles])
            : null;

        // Check if this guild previously had no announcement channel
        const [prevConfig] = await pool.execute(
            'SELECT announcement_channel_id FROM guilds WHERE guild_id = ?',
            [guildId]
        );
        const hadChannel = prevConfig.length > 0 && prevConfig[0].announcement_channel_id;

        await pool.execute(`
            INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id, stream_ignored_roles)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                announcement_channel_id = VALUES(announcement_channel_id),
                live_role_id = VALUES(live_role_id),
                stream_ignored_roles = VALUES(stream_ignored_roles)
        `, [guildId, announcement_channel_id || null, live_role_id || null, ignoredRolesJson]);

        // If a channel was just set (wasn't configured before), cross-pollinate existing streamers
        if (announcement_channel_id && !hadChannel) {
            import('../../../../utils/streamer-cross-pollinate.js').then(({ crossPollinateGuild }) => {
                crossPollinateGuild(guildId, announcement_channel_id).catch(err => {
                    logger.error('[CrossPollinate:Guild] Background error:', { error: err.message, guildId, category: 'streams' });
                });
            }).catch(() => {});
        }

        socketService.configSaved(guildId, 'streaming', req.body);

        res.json({ success: true, message: 'Streaming config updated' });
    } catch (error) {
        logger.error('[API Streaming Config PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update streaming config' });
    }
});

/**
 * GET /api/guilds/:guildId/streaming/subscriptions
 * Get all streamer subscriptions
 */
router.get('/subscriptions', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [subscriptions] = await pool.execute(`
            SELECT s.*, st.platform, st.username, st.platform_user_id, st.discord_user_id,
                   (SELECT COUNT(*) FROM live_announcements WHERE streamer_id = s.streamer_id AND guild_id = ?) as is_live
            FROM subscriptions s
            JOIN streamers st ON s.streamer_id = st.streamer_id
            WHERE s.guild_id = ?
            ORDER BY st.username
        `, [guildId, guildId]);

        res.json({ success: true, subscriptions });
    } catch (error) {
        logger.error('[API Streaming Subscriptions GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
});

/**
 * POST /api/guilds/:guildId/streaming/subscriptions
 * Add a streamer subscription
 */
router.post('/subscriptions', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            platform,
            username,
            announcement_channel_id,
            live_role_id,
            custom_message,
            delete_on_end
        } = req.body;

        if (!platform || !username) {
            return res.status(400).json({ error: 'Platform and username are required' });
        }

        // Rumble is case-sensitive in its channel URLs, so store the canonical name
        // rather than a lowercased one — and reject channels that don't exist.
        // Twitch and Kick rows are keyed by the platform's numeric id (a rename keeps working, and
        // Twitch EventSub can only subscribe an id), so resolve it here and reject unknown names.
        // This insert used to omit platform_user_id entirely, which strict mode refuses.
        let storedName = username.toLowerCase();
        let platformUserId = storedName;
        if (platform === 'rumble') {
            const v = await rumbleApi.validateUser(username);
            if (!v) return res.status(400).json({ error: `Rumble channel "${username}" not found` });
            storedName = v.canonicalUsername;
            platformUserId = v.platformUserId;
        } else if (platform === 'twitch') {
            const user = await getTwitchUser(username);
            if (!user) return res.status(400).json({ error: `Twitch user "${username}" not found` });
            storedName = user.login;
            platformUserId = String(user.id);
        } else if (platform === 'kick') {
            // getKickUser wraps the channel: { user: { id, username }, livestream, _raw }
            const kick = await kickApi.getKickUser(username);
            if (!kick?.user?.id) return res.status(400).json({ error: `Kick channel "${username}" not found` });
            storedName = kick.user.username || storedName;
            platformUserId = String(kick.user.id);
        }

        // Find or create streamer: by id first, so a renamed account keeps its row
        let [streamer] = await pool.execute(
            `SELECT streamer_id FROM streamers WHERE platform = ? AND (platform_user_id = ? OR username = ?)
             ORDER BY platform_user_id = ? DESC LIMIT 1`,
            [platform, platformUserId, storedName, platformUserId]
        );

        let streamerId;
        if (streamer.length === 0) {
            const [result] = await pool.execute(
                'INSERT INTO streamers (platform, platform_user_id, username) VALUES (?, ?, ?)',
                [platform, platformUserId, storedName]
            );
            streamerId = result.insertId;
        } else {
            streamerId = streamer[0].streamer_id;
        }

        // Create subscription. With no explicit stream-end choice in the request,
        // inherit the guild default rather than silently forcing keep-on-end.
        const streamEnd = await getStreamEndDefaults(guildId);
        const deleteOnEnd = delete_on_end === undefined ? streamEnd.delete_on_end : (delete_on_end ? 1 : 0);
        const editOnEnd = delete_on_end === undefined ? streamEnd.edit_on_end : 0;

        await pool.execute(`
            INSERT INTO subscriptions
                (guild_id, streamer_id, announcement_channel_id, live_role_id, custom_message, delete_on_end, edit_on_end)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            guildId,
            streamerId,
            announcement_channel_id || null,
            live_role_id || null,
            custom_message || null,
            deleteOnEnd,
            editOnEnd
        ]);

        res.json({ success: true, message: 'Subscription added' });
    } catch (error) {
        logger.error('[API Streaming Subscriptions POST] Error:', error);
        res.status(500).json({ error: 'Failed to add subscription' });
    }
});

/**
 * DELETE /api/guilds/:guildId/streaming/subscriptions/:subscriptionId
 * Remove a subscription
 */
router.delete('/subscriptions/:subscriptionId', async (req, res) => {
    try {
        const { guildId, subscriptionId } = req.params;

        await pool.execute(
            // Soft-delete so the "Recently removed" panel can quick-restore it. Hard-delete happens on request.
            "UPDATE subscriptions SET paused = 1, departed_at = NOW(), departed_reason = 'manual' WHERE subscription_id = ? AND guild_id = ? AND departed_at IS NULL",
            [subscriptionId, guildId]
        );

        res.json({ success: true, message: 'Subscription removed' });
    } catch (error) {
        logger.error('[API Streaming Subscriptions DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to remove subscription' });
    }
});

// ---------------------------------------------------------------------------------------------
// Test alert and live role check (Streamers page and the edit-streamer dialog)
// ---------------------------------------------------------------------------------------------

const ALERT_COLORS = { twitch: '#9146FF', youtube: '#FF0000', kick: '#52E252', tiktok: '#00f2ea' };
const PLATFORM_NAMES = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', tiktok: 'TikTok', rumble: 'Rumble', trovo: 'Trovo' };
const platformUrl = (platform, username) => ({
    twitch: `https://twitch.tv/${username}`,
    kick: `https://kick.com/${username}`,
    youtube: `https://youtube.com/channel/${username}`,
    tiktok: `https://tiktok.com/@${username}`,
    rumble: `https://rumble.com/c/${username}`,
})[platform] || null;
const testCooldown = new Map();   // guildId -> last test time
const isSnowflake = (v) => /^\d{17,20}$/.test(String(v || ''));

function guildFor(req) {
    const { guildId } = req.params;
    const client = global.botManager?.getClientForGuild?.(guildId) || req.botClient || req.app.locals.client;
    return client?.guilds?.cache?.get(guildId) || null;
}

/**
 * POST /api/guilds/:guildId/streaming/test-alert
 * Posts a sample go-live alert, with made-up stream details, so the message and channel can be checked.
 * Body: { subscription_id?, channel_id?, message?, ping_role_id? }. `message` is the text in the
 * editor (unsaved changes included); mentions in a test never ping anyone.
 */
router.post('/test-alert', async (req, res) => {
    try {
        const { guildId } = req.params;
        const guild = guildFor(req);
        if (!guild) return res.status(404).json({ error: 'The bot is not in this server.' });

        const last = testCooldown.get(guildId) || 0;
        if (Date.now() - last < 10000) return res.status(429).json({ error: 'Wait a few seconds before sending another test.' });

        const body = req.body || {};
        let sub = null;
        if (body.subscription_id != null && body.subscription_id !== '') {
            const [rows] = await pool.execute(
                `SELECT sub.subscription_id, sub.announcement_channel_id, sub.custom_message, sub.ping_role_id,
                        s.platform, s.username, s.profile_image_url
                   FROM subscriptions sub JOIN streamers s ON s.streamer_id = sub.streamer_id
                  WHERE sub.subscription_id = ? AND sub.guild_id = ?`,
                [String(body.subscription_id).slice(0, 20), guildId]);
            sub = rows[0] || null;
            if (!sub) return res.status(404).json({ error: 'That subscription is not in this server.' });
        }
        const [gRows] = await pool.execute('SELECT announcement_channel_id FROM guilds WHERE guild_id = ?', [guildId]);

        const channelId = isSnowflake(body.channel_id) ? String(body.channel_id)
            : (sub?.announcement_channel_id || gRows[0]?.announcement_channel_id || null);
        if (!channelId) return res.status(400).json({ error: 'Choose a channel first.' });
        const channel = guild.channels.cache.get(channelId);
        if (!channel || !channel.isTextBased?.()) return res.status(400).json({ error: 'That channel is not in this server.' });
        const perms = channel.permissionsFor(guild.members.me);
        const missing = [['ViewChannel', 'View Channel'], ['SendMessages', 'Send Messages'], ['EmbedLinks', 'Embed Links']]
            .filter(([flag]) => !perms?.has(PermissionFlagsBits[flag])).map(([, label]) => label);
        if (missing.length) return res.status(400).json({ error: `The bot is missing ${missing.join(', ')} in #${channel.name}.` });

        const platform = String(sub?.platform || 'twitch').toLowerCase();
        const platformName = PLATFORM_NAMES[platform] || platform;
        const name = sub?.username || 'SampleStreamer';
        const safeName = name.replace(/([_*~`|\\])/g, '\\$1');
        const url = platformUrl(platform, name) || 'https://twitch.tv/';
        const title = 'Test stream: checking the go-live alert';
        const game = 'Just Chatting';

        const template = typeof body.message === 'string' ? body.message : (sub?.custom_message || '');
        let content = template.slice(0, 2000)
            .replace(/{username}/g, safeName).replace(/{streamer}/g, safeName)
            .replace(/{platform}/g, platformName).replace(/{url}/g, url)
            .replace(/{title}/g, title).replace(/{game}/g, game)
            .replace(/{everyone}/g, '@everyone');
        const ping = body.ping_role_id !== undefined ? String(body.ping_role_id || '') : String(sub?.ping_role_id || '');
        if (ping === 'everyone') content = `@everyone ${content}`;
        else if (isSnowflake(ping) && guild.roles.cache.has(ping)) content = `<@&${ping}> ${content}`;
        content = content.trim().slice(0, 2000);

        const embed = new EmbedBuilder()
            .setColor(ALERT_COLORS[platform] || '#36393f')
            .setAuthor({ name: `${name} is LIVE on ${platformName}!`, url })
            .setTitle(title)
            .setURL(url)
            .addFields({ name: 'Playing', value: game, inline: true }, { name: 'Viewers', value: '123', inline: true })
            .setFooter({ text: 'Test alert sent from the dashboard. Not a real stream.' })
            .setTimestamp();
        if (/^https:\/\//.test(sub?.profile_image_url || '')) embed.setThumbnail(sub.profile_image_url);

        testCooldown.set(guildId, Date.now());
        await channel.send({ content: content || undefined, embeds: [embed], allowedMentions: { parse: [] } });
        res.json({ success: true, channel: channel.name });
    } catch (error) {
        logger.error('[API Streaming test-alert] Error:', error);
        res.status(500).json({ error: 'Could not send the test alert.' });
    }
});

/**
 * GET /api/guilds/:guildId/streaming/live-role-check
 * Checks every live role this server uses: does it still exist, can the bot give it (Manage Roles,
 * role below the bot's highest role, not managed by an integration), and who still holds a live role
 * the bot gave although they are not live right now.
 */
router.get('/live-role-check', async (req, res) => {
    try {
        const { guildId } = req.params;
        const guild = guildFor(req);
        if (!guild) return res.status(404).json({ error: 'The bot is not in this server.' });
        const me = guild.members.me;
        const canManage = !!me?.permissions.has(PermissionFlagsBits.ManageRoles);
        const top = me?.roles.highest || null;

        const uses = new Map();   // roleId -> [where it is used]
        const add = (id, where) => { if (!isSnowflake(id)) return; if (!uses.has(id)) uses.set(id, []); uses.get(id).push(where); };
        const [g] = await pool.execute('SELECT live_role_id FROM guilds WHERE guild_id = ?', [guildId]);
        add(g[0]?.live_role_id, 'Server default');
        const [subs] = await pool.execute(
            `SELECT sub.live_role_id, s.username, s.platform, s.discord_user_id
               FROM subscriptions sub JOIN streamers s ON s.streamer_id = sub.streamer_id
              WHERE sub.guild_id = ? AND sub.live_role_id IS NOT NULL AND sub.live_role_id <> '' AND sub.departed_at IS NULL`,
            [guildId]);
        subs.forEach((s) => add(s.live_role_id, `${s.username} (${PLATFORM_NAMES[s.platform] || s.platform})`));
        const [teams] = await pool.execute(
            "SELECT team_name, live_role_id FROM twitch_teams WHERE guild_id = ? AND live_role_id IS NOT NULL AND live_role_id <> ''", [guildId]);
        teams.forEach((t) => add(t.live_role_id, `Team ${t.team_name}`));

        const roles = [...uses.entries()].map(([id, where]) => {
            const role = guild.roles.cache.get(id);
            let status = 'ok', problem = null;
            if (!role) { status = 'bad'; problem = 'This role was deleted. Choose another one.'; }
            else if (role.managed) { status = 'bad'; problem = 'This role belongs to an integration and cannot be given by bots.'; }
            else if (!canManage) { status = 'bad'; problem = 'The bot does not have the Manage Roles permission.'; }
            else if (top && role.position >= top.position) { status = 'bad'; problem = `This role is above the bot's highest role (${top.name}). Move the bot's role above it in Server Settings, Roles.`; }
            return {
                id, name: role?.name || null, color: role?.hexColor || null, status, problem,
                usedBy: where.slice(0, 6), usedByCount: where.length,
            };
        });

        // Live roles the bot handed out (live_role_grants) to members who are not live right now. The
        // stream check takes these back on its next pass; one that stays here is stuck.
        const [grants] = await pool.execute('SELECT user_id, role_id, granted_at FROM live_role_grants WHERE guild_id = ?', [guildId]);
        const [live] = await pool.execute(
            'SELECT DISTINCT discord_user_id FROM live_announcements WHERE guild_id = ? AND discord_user_id IS NOT NULL', [guildId]);
        const liveSet = new Set(live.map((r) => String(r.discord_user_id)));
        const notLive = grants.filter((r) => !liveSet.has(String(r.user_id))).slice(0, 25).map((r) => ({
            userId: String(r.user_id),
            user: guild.members.cache.get(String(r.user_id))?.user.username || null,
            role: guild.roles.cache.get(String(r.role_id))?.name || null,
            grantedAt: r.granted_at,
        }));
        const unlinked = subs.filter((s) => !s.discord_user_id).length;

        res.json({
            success: true,
            bot: { canManageRoles: canManage, topRole: top?.name || null },
            roles,
            grants: { total: grants.length, live: grants.length - grants.filter((r) => !liveSet.has(String(r.user_id))).length, notLive },
            unlinked,
        });
    } catch (error) {
        logger.error('[API Streaming live-role-check] Error:', error);
        res.status(500).json({ error: 'Could not run the check.' });
    }
});

/**
 * GET /api/guilds/:guildId/streaming/teams
 * Get team subscriptions
 */
router.get('/teams', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [teams] = await pool.execute(
            'SELECT * FROM twitch_teams WHERE guild_id = ? ORDER BY team_name',
            [guildId]
        );

        res.json({ success: true, teams });
    } catch (error) {
        logger.error('[API Streaming Teams GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch teams' });
    }
});

export default router;
