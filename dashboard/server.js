// Force re-write 2025-10-02
const express = require('express');
const session = require('express-session');
const passport = require('passport');
require('./passport-setup');
const path = require('path');
const fs = require('fs');
const db = require('../utils/db');
const cache = require('../utils/cache'); // Import the cache utility
const apiChecks = require('../utils/api_checks.js');
const multer = require('multer');
const { PermissionsBitField } = require('discord.js');
const Papa = require('papaparse');
const { syncTwitchTeam } = require('../core/team-sync');
const { checkStreams } = require('../core/stream-checker');
const logger = require('../utils/logger');

const upload = multer({ dest: 'uploads/' });
const app = express();
const port = process.env.DASHBOARD_PORT || 3000;
let client;

const getDefaultAvatar = (discriminator) => {
    return `https://cdn.discordapp.com/embed/avatars/${discriminator % 5}.png`;
};

// Helper function for caching the manage page data
async function getManagePageData(guildId, botGuild) {
    const cacheKey = `dashboard:data:${guildId}`;
    const cachedData = await cache.get(cacheKey);

    if (cachedData) {
        logger.info(`[Dashboard] Cache HIT for guild ${guildId}`);
        return JSON.parse(cachedData);
    }

    logger.info(`[Dashboard] Cache MISS for guild ${guildId}. Fetching fresh data.`);
    const [[allSubscriptions], [guildSettingsResult], [channelSettingsResult], allRoles, allChannels, [rawTeamSubscriptions], [allStreamers]] = await Promise.all([
        db.execute(`SELECT sub.*, s.platform, s.username, s.discord_user_id, s.kick_username, s.streamer_id, s.platform_user_id, s.profile_image_url FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? ORDER BY s.username`, [guildId]),
        db.execute('SELECT * FROM guilds WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM channel_settings WHERE guild_id = ?', [guildId]),
        botGuild.roles.fetch(),
        botGuild.channels.fetch(),
        db.execute('SELECT * FROM twitch_teams WHERE guild_id = ?', [guildId]),
        db.execute('SELECT streamer_id, platform, username, kick_username, discord_user_id, platform_user_id, profile_image_url FROM streamers')
    ]);

    const allChannelsMap = new Map(allChannels.map(ch => [ch.id, ch.name]));
    const streamerIdToDataMap = new Map(allStreamers.map(s => [s.streamer_id, s]));
    const consolidatedStreamersMap = new Map();
    const platformPriority = ['kick', 'twitch', 'youtube', 'tiktok', 'trovo'];

    for (const sub of allSubscriptions) {
        const streamer = streamerIdToDataMap.get(sub.streamer_id);
        if (!streamer) continue;
        const primaryKey = streamer.discord_user_id || `s-${streamer.streamer_id}`;
        if (!consolidatedStreamersMap.has(primaryKey)) {
            consolidatedStreamersMap.set(primaryKey, {
                id: primaryKey,
                discordUserId: streamer.discord_user_id,
                platforms: new Map(),
                subscriptions: []
            });
        }
        const consolidatedEntry = consolidatedStreamersMap.get(primaryKey);
        if (!consolidatedEntry.platforms.has(streamer.platform)) {
            consolidatedEntry.platforms.set(streamer.platform, {
                streamer_id: streamer.streamer_id,
                platform: streamer.platform,
                username: streamer.username,
                platform_user_id: streamer.platform_user_id,
                profile_image_url: streamer.profile_image_url,
                kick_username: streamer.kick_username
            });
        }
        consolidatedEntry.subscriptions.push({
            subscription_id: sub.subscription_id,
            announcement_channel_id: sub.announcement_channel_id,
            override_nickname: sub.override_nickname,
            custom_message: sub.custom_message,
            override_avatar_url: sub.override_avatar_url,
            platform: streamer.platform,
            streamer_id: streamer.streamer_id,
            team_subscription_id: sub.team_subscription_id
        });
    }

    const consolidatedStreamers = Array.from(consolidatedStreamersMap.values()).map(entry => {
        entry.platforms = Array.from(entry.platforms.values()).sort((a, b) => platformPriority.indexOf(a.platform) - platformPriority.indexOf(b.platform));
        entry.primaryUsername = entry.platforms[0]?.username || 'Unknown';
        entry.primaryAvatar = entry.platforms.find(p => p.profile_image_url)?.profile_image_url || getDefaultAvatar(0);
        const subscriptionsByChannel = new Map();
        for (const sub of entry.subscriptions) {
            const channelKey = sub.announcement_channel_id || 'default';
            if (!subscriptionsByChannel.has(channelKey)) {
                subscriptionsByChannel.set(channelKey, { channelId: sub.announcement_channel_id, channelName: allChannelsMap.get(sub.announcement_channel_id) || 'Server Default', subs: [] });
            }
            subscriptionsByChannel.get(channelKey).subs.push(sub);
        }
        entry.subscriptionsByChannel = Array.from(subscriptionsByChannel.values());
        return entry;
    });

    const teamSubscriptions = [];
    for (const teamSub of rawTeamSubscriptions) {
        const [rawMembers] = await db.execute(
            `SELECT sub.subscription_id, s.streamer_id, s.platform, s.username, s.kick_username, s.discord_user_id
             FROM subscriptions sub
             JOIN streamers s ON sub.streamer_id = s.streamer_id
             WHERE sub.guild_id = ? AND sub.team_subscription_id = ?`,
            [guildId, teamSub.id]
        );
        const membersMap = new Map();
        for (const rawMember of rawMembers) {
            const key = rawMember.discord_user_id || rawMember.streamer_id.toString();
            if (!membersMap.has(key)) {
                membersMap.set(key, {
                    discord_user_id: rawMember.discord_user_id,
                    twitch_username: null,
                    kick_username: null,
                    subscription_id: rawMember.platform === 'twitch' ? rawMember.subscription_id : null
                });
            }
            const member = membersMap.get(key);
            if (rawMember.platform === 'twitch') {
                member.twitch_username = rawMember.username;
                if (!member.subscription_id) member.subscription_id = rawMember.subscription_id;
            }
            if (rawMember.platform === 'kick') member.kick_username = rawMember.username;
        }
        teamSub.members = Array.from(membersMap.values());
        teamSubscriptions.push(teamSub);
    }

    const dataToCache = {
        consolidatedStreamers,
        totalSubscriptions: allSubscriptions.length,
        settings: guildSettingsResult[0] || {},
        channelSettings: channelSettingsResult,
        roles: allRoles.filter(r => !r.managed && r.name !== '@everyone').map(r => ({ id: r.id, name: r.name })),
        channels: allChannels.filter(c => c.isTextBased()).map(c => ({ id: c.id, name: c.name })),
        teamSubscriptions
    };

    await cache.set(cacheKey, JSON.stringify(dataToCache), 60); // Cache for 60 seconds
    return dataToCache;
}


function start(botClient) {
    client = botClient;
    if (!process.env.SESSION_SECRET) {
        logger.error("[Dashboard] FATAL: SESSION_SECRET is not defined in the environment variables.");
        process.exit(1);
    }
    app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 1000 * 60 * 60 * 24 }}));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use(express.static(path.join(__dirname, 'public')));

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    const checkAuth = (req, res, next) => {
        if (req.isAuthenticated()) return next();
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: true, message: 'Unauthorized' });
        }
        res.redirect('/login');
    };

    const checkGuildAdmin = (req, res, next) => {
        try {
            const isApiRequest = req.path.startsWith('/api/');

            if (!req.user || !req.user.guilds) {
                if (isApiRequest) return res.status(403).json({ error: true, message: 'Authentication error. Please log in again.' });
                return res.status(403).render('error', { user: req.user, error: 'Authentication error. Please try logging in again.'});
            }

            const guild = req.user.guilds.find(g => g.id === req.params.guildId);
            if (guild && new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(req.params.guildId)) {
                req.guildObject = client.guilds.cache.get(req.params.guildId);
                return next();
            }

            if (isApiRequest) return res.status(403).json({ error: true, message: 'You do not have permissions for this server or the bot is not in it.' });
            res.status(403).render('error', { user: req.user, error: 'You do not have permissions for this server or the bot is not in it.'});
        } catch (e) {
            logger.error('[checkGuildAdmin Middleware Error]', e);
            const isApiRequest = req.path.startsWith('/api/');
            if (isApiRequest) {
                return res.status(500).json({ error: true, message: 'An unexpected error occurred while checking permissions.' });
            }
            res.status(500).render('error', { user: req.user, error: 'An unexpected error occurred while checking permissions.'});
        }
    };

    const checkSuperAdmin = (req, res, next) => {
        if (req.isAuthenticated() && req.user && req.user.isSuperAdmin) {
            return next();
        }
        if (req.path.startsWith('/api/')) {
            return res.status(403).json({ error: true, message: 'Forbidden: Super Admin access required.' });
        }
        res.status(403).render('error', { user: req.user, error: 'Forbidden: Super Admin access required.' });
    };

    // --- MAIN ROUTES ---
    app.get('/', (req, res) => res.render('landing', { user: req.user, client_id: process.env.DISCORD_CLIENT_ID }));
    app.get('/help', (req, res) => res.render('commands', { user: req.user }));
    app.get('/login', passport.authenticate('discord'));
    app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));
    app.get('/logout', (req, res) => { req.logout(() => { res.redirect('/'); }); });

    app.get('/dashboard', checkAuth, (req, res) => {
        const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(g.id));
        res.render('dashboard', { manageableGuilds, user: req.user });
    });

    app.get('/status', (req, res) => {
        res.render('status', { user: req.user, isAuthenticated: req.isAuthenticated() });
    });

    app.get('/donate', (req, res) => {
        res.render('donate', { user: req.user });
    });

    app.get('/super-admin', checkAuth, checkSuperAdmin, (req, res) => {
        res.render('super-admin', { user: req.user });
    });

    app.get('/manage/:guildId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const botGuild = req.guildObject;
            const guildId = botGuild.id;

            const pageData = await getManagePageData(guildId, botGuild);

            res.render('manage', {
                guild: botGuild,
                user: req.user,
                ...pageData
            });
        } catch (error) {
            logger.error('[Dashboard GET Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error loading management page.' });
        }
    });

    // Invalidate cache on changes
    const invalidateCache = async (req, res, next) => {
        const guildId = req.params.guildId;
        if (guildId) {
            const cacheKey = `dashboard:data:${guildId}`;
            await cache.redis.del(cacheKey);
            logger.info(`[Dashboard] Invalidated cache for guild ${guildId}`);
        }
        next();
    };

    app.post('/manage/:guildId/settings', checkAuth, checkGuildAdmin, invalidateCache, async (req, res) => {
        const { channelId, roleId } = req.body;
        await db.execute('INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = ?, live_role_id = ?', [req.params.guildId, channelId || null, roleId || null, channelId || null, roleId || null]);
        res.redirect(`/manage/${req.params.guildId}?success=settings`);
    });

    app.post('/manage/:guildId/add', checkAuth, checkGuildAdmin, invalidateCache, async (req, res) => {
        const { platform, username, discord_user_id } = req.body;
        const { guildId } = req.params;
        let streamerInfo = { puid: null, dbUsername: null };
        let pfp = null;

        try {
            if (platform === 'kick') {
                const u = await apiChecks.getKickUser(username);
                if (u) {
                    streamerInfo = { puid: u.id?.toString() || null, dbUsername: u.user?.username || null };
                    pfp = u.user?.profile_pic || null;
                }
            } else if (platform === 'twitch') {
                const u = await apiChecks.getTwitchUser(username);
                if (u) {
                    streamerInfo = { puid: u.id || null, dbUsername: u.login || null };
                    pfp = u.profile_image_url || null;
                }
            } else if (platform === 'youtube') {
                const c = await apiChecks.getYouTubeChannelId(username);
                if (c?.channelId) {
                    streamerInfo = { puid: c.channelId || null, dbUsername: c.channelName || username || null };
                }
            } else if (['tiktok', 'trovo'].includes(platform)) {
                streamerInfo = { puid: username || null, dbUsername: username || null };
            }

            if (!streamerInfo.puid) {
                return res.status(400).render('error', { user: req.user, error: `Could not find streamer "${username}" on ${platform}.` });
            }

            await db.execute(
                'INSERT INTO streamers (platform, platform_user_id, username, profile_image_url, discord_user_id) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), profile_image_url = VALUES(profile_image_url), discord_user_id = VALUES(discord_user_id)',
                [platform, streamerInfo.puid, streamerInfo.dbUsername, pfp, discord_user_id || null]
            );

            const [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, streamerInfo.puid]);

            if (!streamer || !streamer.streamer_id) {
                return res.status(500).render('error', { user: req.user, error: 'Failed to retrieve streamer ID after creation.' });
            }

            const announcementChannelIds = req.body.announcement_channel_id ? (Array.isArray(req.body.announcement_channel_id) ? req.body.announcement_channel_id : [req.body.announcement_channel_id]) : [];
            const channelsToSubscribe = announcementChannelIds.map(id => id === '' ? null : id);
            if (channelsToSubscribe.length === 0) channelsToSubscribe.push(null); // Default subscription

            for (const channelId of channelsToSubscribe) {
                await db.execute(
                    'INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)',
                    [guildId, streamer.streamer_id, channelId]
                );
            }

            res.redirect(`/manage/${req.params.guildId}?success=add`);

        } catch (error) {
            logger.error('[Dashboard Add Streamer Error]:', error);
            res.status(500).render('error', { user: req.user, error: 'An error occurred while adding the streamer.' });
        }
    });

    app.post('/manage/:guildId/subscribe-team', checkAuth, checkGuildAdmin, invalidateCache, async (req, res) => {
        try {
            const { teamName, channelId } = req.body;
            const { guildId } = req.params;
            await db.execute('INSERT IGNORE INTO twitch_teams (guild_id, team_name, announcement_channel_id) VALUES (?, ?, ?)', [guildId, teamName, channelId]);
            res.redirect(`/manage/${guildId}?success=team_added#teams-tab`);
        } catch (error) {
            logger.error('[Dashboard Subscribe Team Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error subscribing to team.' });
        }
    });

    app.post('/manage/:guildId/update-team', checkAuth, checkGuildAdmin, invalidateCache, async (req, res) => {
        try {
            let { teamSubscriptionId, liveRoleId, webhookName, webhookAvatarUrl } = req.body;
            await db.execute('UPDATE twitch_teams SET live_role_id = ?, webhook_name = ?, webhook_avatar_url = ? WHERE id = ? AND guild_id = ?', [
                liveRoleId || null,
                webhookName || null,
                webhookAvatarUrl || null,
                teamSubscriptionId,
                req.params.guildId
            ]);
            res.redirect(`/manage/${req.params.guildId}?success=team_updated#teams-tab`);
        } catch (error) {
            logger.error('[Dashboard Update Team Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error updating team.' });
        }
    });

    app.post('/manage/:guildId/removeteam', checkAuth, checkGuildAdmin, invalidateCache, async (req, res) => {
        try {
            const { teamSubscriptionId } = req.body;
            const { guildId } = req.params;

            const [[teamSub]] = await db.execute('SELECT team_name, announcement_channel_id FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamSubscriptionId, guildId]);

            if (teamSub) {
                const teamMembers = await apiChecks.getTwitchTeamMembers(teamSub.team_name);
                if (teamMembers && teamMembers.length > 0) {
                    const memberLogins = teamMembers.map(m => m.user_login);
                    const [streamerIds] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = \'twitch\' AND username IN (?)', [memberLogins]);
                    if (streamerIds.length > 0) {
                        const idsToRemove = streamerIds.map(s => s.streamer_id);
                        await db.execute('DELETE FROM subscriptions WHERE streamer_id IN (?) AND guild_id = ? AND announcement_channel_id = ?', [idsToRemove, guildId, teamSub.announcement_channel_id]);
                    }
                }
                await db.execute('DELETE FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamSubscriptionId, guildId]);
            }

            res.redirect(`/manage/${guildId}?success=team_removed#teams-tab`);
        } catch (error) {
            logger.error('[Dashboard Remove Team Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error removing team subscription.' });
        }
    });

    app.post('/manage/:guildId/channel-appearance/save', checkAuth, checkGuildAdmin, invalidateCache, upload.single('avatar'), async (req, res) => {
        try {
            const { channelId, nickname, avatar_url_text } = req.body;
            const { guildId } = req.params;

            const [[existing]] = await db.execute('SELECT avatar_url FROM channel_settings WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);

            let finalAvatarUrl = existing ? existing.avatar_url : null;
            if (avatar_url_text && avatar_url_text.toLowerCase() === 'reset') {
                finalAvatarUrl = null;
            } else if (req.file) {
                const newFilename = `${guildId}-${channelId}-${Date.now()}${path.extname(req.file.path)}`;
                const publicPath = path.join(__dirname, 'public', 'uploads', 'avatars');
                const newPath = path.join(publicPath, newFilename);
                if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath, { recursive: true });
                fs.renameSync(req.file.path, newPath);
                finalAvatarUrl = `/uploads/avatars/${newFilename}`;
            } else if (avatar_url_text) {
                finalAvatarUrl = avatar_url_text;
            }

            const finalNickname = (nickname && nickname.toLowerCase() === 'reset') ? null : nickname;

            await db.execute(
                'INSERT INTO channel_settings (guild_id, channel_id, nickname, avatar_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), avatar_url = VALUES(avatar_url)',
                [guildId, channelId, finalNickname, finalAvatarUrl]
            );

            res.redirect(`/manage/${guildId}?success=appearance#appearance-tab`);
        } catch (error) {
            logger.error('[Dashboard Channel Appearance Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error saving appearance settings.' });
        }
    });

    app.post('/manage/:guildId/remove-subscription', checkAuth, checkGuildAdmin, invalidateCache, async (req, res) => {
        try {
            const { subscription_id } = req.body;
            const { guildId } = req.params;
            await db.execute('DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?', [subscription_id, guildId]);
            res.redirect(`/manage/${guildId}?success=remove`);
        } catch (error) {
            logger.error('[Dashboard Remove Subscription Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error removing subscription.' });
        }
    });

    app.post('/manage/:guildId/edit-consolidated-streamer', checkAuth, checkGuildAdmin, invalidateCache, upload.single('avatar'), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { consolidated_streamer_id, discord_user_id, platforms, subscriptions } = req.body;

            const [teams] = await db.execute('SELECT id, announcement_channel_id FROM twitch_teams WHERE guild_id = ?', [guildId]);
            const teamChannelMap = new Map(teams.map(t => [t.announcement_channel_id, t.id]));

            if (discord_user_id !== undefined) {
                let streamerIdsToUpdateDiscord = [];
                if (consolidated_streamer_id.startsWith('s-')) {
                    streamerIdsToUpdateDiscord.push(consolidated_streamer_id.substring(2));
                } else {
                    const [associatedStreamers] = await db.execute('SELECT streamer_id FROM streamers WHERE discord_user_id = ?', [consolidated_streamer_id]);
                    streamerIdsToUpdateDiscord = associatedStreamers.map(s => s.streamer_id);
                }

                if (streamerIdsToUpdateDiscord.length > 0) {
                    await db.execute(
                        `UPDATE streamers SET discord_user_id = ? WHERE streamer_id IN (?)`,
                        [discord_user_id || null, streamerIdsToUpdateDiscord]
                    );
                }
            }

            if (platforms) {
                for (const streamerId in platforms) {
                    const platformData = platforms[streamerId];
                    const kickUsername = platformData.kick_username ? platformData.kick_username.trim() : null;

                    if (platformData.platform === 'twitch' && kickUsername && kickUsername.length > 0) {
                        const [[existingKickStreamer]] = await db.execute('SELECT streamer_id, discord_user_id FROM streamers WHERE platform = \'kick\' AND username = ?', [kickUsername]);
                        let kickStreamerIdToUse = null;

                        if (existingKickStreamer) {
                            kickStreamerIdToUse = existingKickStreamer.streamer_id;
                            if (discord_user_id && !existingKickStreamer.discord_user_id) {
                                await db.execute('UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?', [discord_user_id, existingKickStreamer.streamer_id]);
                            }
                        } else {
                            const kickUser = await apiChecks.getKickUser(kickUsername);
                            if (kickUser && kickUser.id) {
                                const [result] = await db.execute(
                                    'INSERT INTO streamers (platform, platform_user_id, username, profile_image_url, discord_user_id) VALUES (?, ?, ?, ?, ?)',
                                    ['kick', kickUser.id.toString(), kickUser.user?.username, kickUser.user?.profile_pic, discord_user_id || null]
                                );
                                kickStreamerIdToUse = result.insertId;
                            }
                        }

                        if (kickStreamerIdToUse) {
                            const [twitchSubscriptions] = await db.execute('SELECT announcement_channel_id, team_subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?', [guildId, streamerId]);
                            for (const sub of twitchSubscriptions) {
                                await db.execute(
                                    'INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id, team_subscription_id) VALUES (?, ?, ?, ?)',
                                    [guildId, kickStreamerIdToUse, sub.announcement_channel_id, sub.team_subscription_id]
                                );
                            }
                        }
                        await db.execute('UPDATE streamers SET kick_username = ? WHERE streamer_id = ?', [null, streamerId]);
                    }
                }
            }

            if (subscriptions) {
                for (const subscriptionId in subscriptions) {
                    const subData = subscriptions[subscriptionId];
                    let finalAvatarUrl = subData.override_avatar_url_text || null;
                    if (subData.reset_avatar === 'on') {
                        finalAvatarUrl = null;
                    }
                    const newChannelId = subData.announcement_channel_id || null;
                    const teamSubscriptionId = teamChannelMap.get(newChannelId) || null;
                    await db.execute(
                        'UPDATE subscriptions SET announcement_channel_id = ?, override_nickname = ?, custom_message = ?, override_avatar_url = ?, team_subscription_id = ? WHERE subscription_id = ? AND guild_id = ?',
                        [newChannelId, subData.override_nickname || null, subData.custom_message || null, finalAvatarUrl, teamSubscriptionId, subscriptionId, guildId]
                    );
                }
            }

            res.redirect(`/manage/${guildId}?success=edit`);
        } catch (error) {
            logger.error('[Dashboard Edit Consolidated Streamer Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error saving changes for streamer.' });
        }
    });

    // ... (rest of the routes remain the same)
    app.get('/manage/:guildId/export', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId } = req.params;
            const [rows] = await db.execute(`
                SELECT s.platform, s.username, s.discord_user_id, s.kick_username, sub.announcement_channel_id, sub.custom_message
                FROM subscriptions sub
                JOIN streamers s ON sub.streamer_id = s.streamer_id
                WHERE sub.guild_id = ?
            `, [guildId]);

            if (rows.length === 0) {
                return res.status(404).send('No subscriptions to export.');
            }

            const csvHeader = "Platform,Username,DiscordUserID,KickUsername,ChannelID,CustomMessage\n";
            const csvRows = rows.map(row => 
                `${row.platform},${row.username},${row.discord_user_id || ''},${row.kick_username || ''},${row.announcement_channel_id || ''},"${(row.custom_message || '').replace(/"/g, '""')}"`
            ).join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="subscriptions-${guildId}.csv"`);
            res.send(csvHeader + csvRows);
        } catch (error) {
            logger.error('[Dashboard Export Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Could not export subscriptions.' });
        }
    });

    app.get('/manage/:guildId/export-teams', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId } = req.params;
            const { teamId } = req.query;
            const botGuild = req.guildObject;

            let query = 'SELECT tt.id, tt.team_name, tt.announcement_channel_id, tt.live_role_id, tt.webhook_name, tt.webhook_avatar_url FROM twitch_teams tt WHERE tt.guild_id = ?';
            const params = [guildId];

            if (teamId) {
                query += ' AND tt.id = ?';
                params.push(teamId);
            }

            const [teams] = await db.execute(query, params);

            if (teams.length === 0) {
                return res.status(404).send('No teams to export.');
            }

            const allRoles = await botGuild.roles.fetch();
            const rolesMap = new Map(allRoles.map(role => [role.id, role.name]));
            const allChannels = await botGuild.channels.fetch();
            const channelsMap = new Map(allChannels.map(ch => [ch.id, ch.name]));

            const csvHeader = "TeamName,AnnouncementChannel,LiveRole,WebhookName,WebhookAvatarUrl\n";
            const csvRows = teams.map(team => {
                const channelName = team.announcement_channel_id ? channelsMap.get(team.announcement_channel_id) || 'Unknown Channel' : '';
                const roleName = team.live_role_id ? rolesMap.get(team.live_role_id) || 'Unknown Role' : '';
                return `${team.team_name},#${channelName},${roleName},${team.webhook_name || ''},${team.webhook_avatar_url || ''}`;
            }).join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="team-subscriptions-${guildId}.csv"`);
            res.send(csvHeader + csvRows);
        } catch (error) {
            logger.error('[Dashboard Export Teams Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Could not export teams.' });
        }
    });

    app.post('/manage/:guildId/import-teams-csv', checkAuth, checkGuildAdmin, invalidateCache, upload.single('csvfile'), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { defaultChannelId } = req.body;
            const botGuild = req.guildObject;

            if (!req.file) {
                return res.status(400).render('error', { user: req.user, error: 'No CSV file uploaded.' });
            }

            const csvData = fs.readFileSync(req.file.path, 'utf8');
            const parsed = Papa.parse(csvData, { header: true, skipEmptyLines: true });
            const teamsToImport = parsed.data;

            const allChannels = await botGuild.channels.fetch();
            const channelsMap = new Map(allChannels.map(ch => [ch.name.toLowerCase(), ch.id]));
            const allRoles = await botGuild.roles.fetch();
            const rolesMap = new Map(allRoles.map(role => [role.name.toLowerCase(), role.id]));

            for (const teamRow of teamsToImport) {
                const teamName = teamRow.TeamName;
                if (!teamName) continue;

                let announcementChannelId = defaultChannelId || null;
                if (teamRow.AnnouncementChannelName) {
                    const channelName = teamRow.AnnouncementChannelName.replace(/^#/, '').toLowerCase();
                    if (channelsMap.has(channelName)) {
                        announcementChannelId = channelsMap.get(channelName);
                    }
                }

                let liveRoleId = null;
                if (teamRow.LiveRoleName) {
                    const roleName = teamRow.LiveRoleName.toLowerCase();
                    if (rolesMap.has(roleName)) {
                        liveRoleId = rolesMap.get(roleName);
                    }
                }

                await db.execute(
                    'INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id, live_role_id, webhook_name, webhook_avatar_url) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id), live_role_id = VALUES(live_role_id), webhook_name = VALUES(webhook_name), webhook_avatar_url = VALUES(webhook_avatar_url)',
                    [guildId, teamName, announcementChannelId, liveRoleId, teamRow.WebhookName || null, teamRow.WebhookAvatarUrl || null]
                );
            }

            fs.unlinkSync(req.file.path);
            res.redirect(`/manage/${guildId}?success=teams_imported#teams-tab`);
        } catch (error) {
            logger.error('[Dashboard Import Teams CSV Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Failed to import teams from CSV.' });
        }
    });

    app.post('/manage/:guildId/import-team', checkAuth, checkGuildAdmin, invalidateCache, upload.single('csvfile'), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { channelId } = req.body;

            if (!req.file) {
                return res.status(400).render('error', { user: req.user, error: 'No CSV file uploaded.' });
            }

            const csvData = fs.readFileSync(req.file.path, 'utf8');
            const parsed = Papa.parse(csvData, { header: true, skipEmptyLines: true });

            for (const row of parsed.data) {
                const { Platform, Username, DiscordUserID, KickUsername } = row;
                if (!Platform || !Username) continue;

                let [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND username = ?', [Platform, Username]);
                if (!streamer) {
                    const [result] = await db.execute('INSERT INTO streamers (platform, username, discord_user_id, kick_username) VALUES (?, ?, ?, ?)', [Platform, Username, DiscordUserID || null, KickUsername || null]);
                    streamer = { streamer_id: result.insertId };
                } else {
                    await db.execute('UPDATE streamers SET discord_user_id = ?, kick_username = ? WHERE streamer_id = ?', [DiscordUserID || null, KickUsername || null, streamer.streamer_id]);
                }

                await db.execute(
                    'INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)',
                    [guildId, streamer.streamer_id, channelId]
                );
            }

            fs.unlinkSync(req.file.path);
            res.redirect(`/manage/${guildId}?success=import#csv-tab`);
        } catch (error) {
            logger.error('[Dashboard Import Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Failed to sync from CSV.' });
        }
    });

    app.post('/manage/:guildId/resync-team', checkAuth, checkGuildAdmin, invalidateCache, async (req, res) => {
        const { guildId } = req.params;
        const { teamSubscriptionId } = req.body;

        if (!teamSubscriptionId) {
            return res.status(400).render('error', { user: req.user, error: 'Team Subscription ID is required for resync.' });
        }

        logger.info(`[Dashboard] Manual team resync requested for team ID ${teamSubscriptionId} in guild ${guildId}`);

        try {
            const result = await syncTwitchTeam(teamSubscriptionId, db, logger);
            if (result.success) {
                logger.info(`[Dashboard] Team resync successful for team ID ${teamSubscriptionId}. Triggering stream check.`);
                await checkStreams(client);
                res.redirect(`/manage/${guildId}?success=team_resynced#teams-tab`);
            } else {
                res.status(500).render('error', { user: req.user, error: `Team resync failed: ${result.message}` });
            }
        } catch (error) {
            logger.error(`[Dashboard Resync Team Error] for team ID ${teamSubscriptionId} in guild ${guildId}:`, error);
            res.status(500).render('error', { user: req.user, error: 'An unexpected error occurred during team resync.' });
        }
    });

    // --- API ROUTES ---
    async function getFormattedLiveRows(rows) {
        const platformPriority = ['kick', 'twitch', 'youtube', 'tiktok', 'trovo'];
        const streamersMap = new Map();

        for (const row of rows) {
            const key = row.discord_user_id || row.username.toLowerCase();
            if (!streamersMap.has(key)) {
                streamersMap.set(key, []);
            }
            streamersMap.get(key).push(row);
        }

        const discordUserIds = rows.map(r => r.discord_user_id).filter(id => id);
        const allAssociatedAccounts = new Map();
        if (discordUserIds.length > 0) {
            const [accounts] = await db.query(
                'SELECT discord_user_id, username, platform, profile_image_url FROM streamers WHERE discord_user_id IN (?)',
                [[...new Set(discordUserIds)]]
            );
            for (const acc of accounts) {
                if (!allAssociatedAccounts.has(acc.discord_user_id)) {
                    allAssociatedAccounts.set(acc.discord_user_id, []);
                }
                allAssociatedAccounts.get(acc.discord_user_id).push(acc);
            }
            allAssociatedAccounts.forEach(userAccounts => {
                userAccounts.sort((a, b) => platformPriority.indexOf(a.platform) - platformPriority.indexOf(b.platform));
            });
        }

        const formattedResult = [];
        for (const userAnnouncements of streamersMap.values()) {
            userAnnouncements.sort((a, b) => platformPriority.indexOf(a.platform) - platformPriority.indexOf(b.platform));
            const primaryLiveAnnouncement = userAnnouncements[0];
            const discordId = primaryLiveAnnouncement.discord_user_id;
            let primaryIdentity = primaryLiveAnnouncement;
            let bestAvatar = primaryLiveAnnouncement.profile_image_url;
            const userAccounts = allAssociatedAccounts.get(discordId);
            if (userAccounts && userAccounts.length > 0) {
                primaryIdentity = userAccounts[0];
                bestAvatar = userAccounts.find(acc => acc.profile_image_url)?.profile_image_url || bestAvatar;
            }
            const live_platforms = [...new Map(userAnnouncements.map(a => [a.platform, {
                platform: a.platform,
                game: a.stream_game || 'N/A',
                url: a.stream_url || '#'
            }])).values()];
            formattedResult.push({
                username: primaryIdentity.username,
                avatar_url: bestAvatar || getDefaultAvatar(0),
                live_platforms: live_platforms,
            });
        }
        return formattedResult;
    }

    app.get('/api/global-live-status', async (req, res) => {
        try {
            const [liveRows] = await db.execute(`
                SELECT s.streamer_id, s.username, s.discord_user_id, s.profile_image_url, a.platform, a.stream_game, a.stream_url
                FROM announcements a
                JOIN streamers s ON a.streamer_id = s.streamer_id
            `);
            const formatted = await getFormattedLiveRows(liveRows);
            res.json(formatted);
        } catch (error) {
            logger.error('[API global-live-status Error]', error);
            res.status(500).json({ error: true, message: 'Internal server error.' });
        }
    });

    app.get('/api/guilds/:guildId/livestatus', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const [liveRows] = await db.execute(`
                SELECT s.streamer_id, s.username, s.discord_user_id, s.profile_image_url, a.platform, a.stream_game, a.stream_url
                FROM announcements a
                JOIN streamers s ON a.streamer_id = s.streamer_id
                WHERE a.guild_id = ?
            `, [guildId]);
            const formatted = await getFormattedLiveRows(liveRows);
            res.json(formatted);
        } catch (error) {
            logger.error(`[API guild-livestatus Error for ${req.params.guildId}]`, error);
            res.status(500).json({ error: true, message: 'Internal server error.' });
        }
    });

    app.get('/api/status-data', async (req, res) => {
        try {
            const [liveRows] = await db.execute(`
                SELECT s.streamer_id, s.username, s.discord_user_id, s.profile_image_url, a.platform, a.stream_game, a.stream_url
                FROM announcements a
                JOIN streamers s ON a.streamer_id = s.streamer_id
            `);
            const liveStreamers = await getFormattedLiveRows(liveRows);
            const [[{count: totalStreamers}]] = await db.execute('SELECT COUNT(DISTINCT streamer_id) as count FROM streamers');
            const [[{count: totalGuilds}]] = await db.execute('SELECT COUNT(DISTINCT guild_id) as count FROM guilds');
            const [[{count: totalAnnouncements}]] = await db.execute('SELECT COUNT(*) as count FROM announcements');
            const platformDistribution = liveStreamers.flatMap(s => s.live_platforms.map(p => p.platform)).reduce((acc, platform) => {
                acc[platform] = (acc[platform] || 0) + 1;
                return acc;
            }, {});

            let dbStatus = 'offline';
            try {
                await db.execute('SELECT 1');
                dbStatus = 'ok';
            } catch (e) { /* offline */ }

            let twitchApiStatus = 'error';
            try {
                if (await apiChecks.getTwitchUser('twitch')) {
                    twitchApiStatus = 'ok';
                }
            } catch (e) { /* error */ }

            res.json({
                liveCount: liveStreamers.length,
                totalStreamers,
                totalGuilds,
                totalAnnouncements,
                liveStreamers,
                platformDistribution: Object.entries(platformDistribution).map(([platform, count]) => ({ platform, count })),
                app: { status: client && client.isReady() ? 'online' : 'offline', uptime: client && client.uptime ? `${Math.floor(client.uptime / 3600000)}h ${Math.floor((client.uptime % 3600000) / 60000)}m` : 'N/A' },
                db: { status: dbStatus },
                api: { twitch: twitchApiStatus }
            });
        } catch (error) {
            logger.error('[API status-data Error]', error);
            res.status(500).json({ error: true, message: 'Internal server error.' });
        }
    });

    app.get('/api/authenticated-logs', checkAuth, checkSuperAdmin, async (req, res) => {
        const logFilePath = path.join(__dirname, '..', 'logs', 'combined.log');
        try {
            if (fs.existsSync(logFilePath)) {
                const logs = await fs.promises.readFile(logFilePath, 'utf8');
                res.json({ success: true, logs });
            } else {
                res.json({ success: true, logs: 'Log file not found.' });
            }
        } catch (error) {
            logger.error('[API authenticated-logs Error]', error);
            res.status(500).json({ success: false, error: 'Failed to read log file.', message: error.message });
        }
    });

    app.post('/api/admin/reinit-server', checkAuth, checkSuperAdmin, (req, res) => {
        logger.info('[Super Admin] Server re-initialization requested.');
        res.json({ success: true, message: 'Server re-initialization initiated.' });
        setTimeout(() => process.exit(0), 1000);
    });

    app.post('/api/admin/reinit-bot', checkAuth, checkSuperAdmin, (req, res) => {
        logger.info('[Super Admin] Bot re-initialization requested.');
        res.json({ success: true, message: 'Bot re-initialization initiated.' });
        process.send({ type: 'restart-bot' });
    });

    app.post('/api/admin/reset-database', checkAuth, checkSuperAdmin, async (req, res) => {
        logger.info('[Super Admin] Full database reset requested.');
        try {
            const tablesToTruncate = ['announcements', 'subscriptions', 'streamers', 'guilds', 'channel_settings', 'twitch_teams', 'blacklisted_users'];
            for (const table of tablesToTruncate) {
                await db.execute(`TRUNCATE TABLE ${table}`);
            }
            logger.info('[Super Admin] All bot-related database tables truncated.');
            res.json({ success: true, message: 'Database reset successfully.' });
            setTimeout(() => process.exit(0), 1000);
        } catch (error) {
            logger.error('[Super Admin] Database reset failed:', error);
            res.status(500).json({ success: false, message: 'Failed to reset database.', error: error.message });
        }
    });

    app.get('/api/admin/blacklisted-users', checkAuth, checkSuperAdmin, async (req, res) => {
        try {
            const [users] = await db.execute('SELECT id, platform, platform_user_id, username, discord_user_id FROM blacklisted_users');
            res.json(users);
        } catch (error) {
            logger.error('[Super Admin] Failed to fetch blacklisted users:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch blacklisted users.' });
        }
    });

    app.post('/api/admin/blacklist-user', checkAuth, checkSuperAdmin, async (req, res) => {
        const { blacklistType, identifier, platform } = req.body;
        try {
            let finalPlatform, finalPlatformUserId, finalUsername, finalDiscordUserId = null;
            if (blacklistType === 'discord') {
                if (!identifier) return res.status(400).json({ success: false, message: 'Discord User ID is required.' });
                finalPlatform = 'discord';
                finalPlatformUserId = finalDiscordUserId = finalUsername = identifier;
            } else if (blacklistType === 'platform') {
                if (!platform || !identifier) return res.status(400).json({ success: false, message: 'Platform and Username are required.' });
                finalPlatform = platform;
                finalUsername = identifier;
                let streamerInfo = null;
                if (platform === 'twitch') streamerInfo = await apiChecks.getTwitchUser(identifier);
                else if (platform === 'kick') streamerInfo = await apiChecks.getKickUser(identifier);
                else if (platform === 'youtube') streamerInfo = await apiChecks.getYouTubeChannelId(identifier);
                if (!streamerInfo) return res.status(404).json({ success: false, message: `Could not find streamer "${identifier}" on ${platform}.` });
                finalPlatformUserId = streamerInfo.id || streamerInfo.channelId;
                finalUsername = streamerInfo.login || streamerInfo.user?.username || streamerInfo.channelName || identifier;
                const [linked] = await db.execute('SELECT discord_user_id FROM streamers WHERE platform = ? AND platform_user_id = ? AND discord_user_id IS NOT NULL', [finalPlatform, finalPlatformUserId]);
                if (linked.length > 0) finalDiscordUserId = linked[0].discord_user_id;
            } else {
                return res.status(400).json({ success: false, message: 'Invalid blacklist type.' });
            }

            const [existing] = await db.execute('SELECT id FROM blacklisted_users WHERE platform = ? AND platform_user_id = ?', [finalPlatform, finalPlatformUserId]);
            if (existing.length > 0) return res.status(409).json({ success: false, message: 'User is already blacklisted.' });

            await db.execute(
                'INSERT INTO blacklisted_users (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?)',
                [finalPlatform, finalPlatformUserId, finalUsername, finalDiscordUserId]
            );
            logger.info(`[Super Admin] Blacklisted user: ${finalUsername} (${finalPlatform})`);
            res.json({ success: true, message: `User ${finalUsername} on ${finalPlatform} has been blacklisted.` });
        } catch (error) {
            logger.error('[Super Admin] Failed to blacklist user:', error);
            res.status(500).json({ success: false, message: 'Failed to blacklist user.' });
        }
    });

    app.post('/api/admin/unblacklist-user', checkAuth, checkSuperAdmin, async (req, res) => {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, message: 'Blacklist entry ID is required.' });
        try {
            const [result] = await db.execute('DELETE FROM blacklisted_users WHERE id = ?', [id]);
            if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Blacklist entry not found.' });
            logger.info(`[Super Admin] Unblacklisted user with ID: ${id}`);
            res.json({ success: true, message: 'User removed from blacklist.' });
        } catch (error) {
            logger.error('[Super Admin] Failed to unblacklist user:', error);
            res.status(500).json({ success: false, message: 'Failed to remove user from blacklist.' });
        }
    });

    app.use((req, res) => {
        res.status(404).render('error', { user: req.user, error: 'Page Not Found' });
    });

    app.listen(port, () => logger.info(`[Dashboard] Web dashboard listening on port ${port}`));
}

module.exports = { start };
