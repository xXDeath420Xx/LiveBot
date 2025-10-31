const express = require('express');
const session = require('express-session');
const passport = require('passport');
require('./passport-setup');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pool: db } = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const initCycleTLS = require('cycletls');
const Papa = require('papaparse');
const multer = require('multer');
const { PermissionsBitField } = require('discord.js');
const { getBrowser, closeBrowser } = require('../utils/browserManager');

const addStreamerLogic = async () => ({ error: "This dashboard feature is currently under development." });
const importCsvLogic = async () => ({ error: "This dashboard feature is currently under development." });

const upload = multer({ dest: 'uploads/' });
const app = express();
const port = process.env.DASHBOARD_PORT || 3000;
let client;

function start(botClient) {
    client = botClient;
    if (!process.env.TEMP_UPLOAD_CHANNEL_ID) { console.warn('[Dashboard Init] TEMP_UPLOAD_CHANNEL_ID is not set.'); }
    app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 1000 * 60 * 60 * 24 }}));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    const checkAuth = (req, res, next) => { if (req.isAuthenticated()) return next(); res.redirect('/login'); };
    const checkGuildAdmin = (req, res, next) => {
        try {
            const guild = req.user.guilds.find(g => g.id === req.params.guildId);
            if (guild && new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(req.params.guildId)) {
                req.guildObject = client.guilds.cache.get(req.params.guildId);
                return next();
            }
            res.status(403).render('error', { user: req.user, error: 'You do not have permissions for this server or the bot is not in it.'});
        } catch (e) { console.error('[checkGuildAdmin Middleware Error]', e); res.status(500).render('error', { user: req.user, error: 'An unexpected error occurred while checking permissions.'}); }
    };
    const noCache = (req, res, next) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        next();
    };
    app.use(express.static(path.join(__dirname, 'public')));
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    app.get('/', (req, res) => res.render('landing-modern', { user: req.user, client_id: process.env.DISCORD_CLIENT_ID, serverCount: client.guilds.cache.size || 0 }));
    app.get('/commands', (req, res) => {
        const commands = [];
        const categoriesSet = new Set();

        // Gather commands from client if available
        if (client && client.commands) {
            client.commands.forEach(cmd => {
                const category = cmd.category || 'General';
                categoriesSet.add(category);
                commands.push({
                    name: cmd.data ? cmd.data.name : cmd.name,
                    description: cmd.data ? cmd.data.description : cmd.description,
                    category: category,
                    usage: cmd.usage || '',
                    examples: cmd.examples || []
                });
            });
        }

        const categories = Array.from(categoriesSet).sort();
        res.render('commands-modern', {
            user: req.user,
            client_id: process.env.DISCORD_CLIENT_ID,
            commands: commands,
            categories: categories
        });
    });
    app.get('/status', async (req, res) => {
        try {
            // Get unique live streamers with Discord IDs
            const [liveAnnouncementsData] = await db.execute(`
                SELECT DISTINCT
                    la.platform,
                    la.username,
                    la.discord_user_id,
                    s.profile_image_url,
                    s.discord_user_id as streamer_discord_id
                FROM live_announcements la
                LEFT JOIN streamers s ON s.username = la.username AND s.platform = la.platform
                LIMIT 200
            `);

            // Fetch stream data from APIs for each streamer
            const twitchApi = require('../utils/twitch-api');
            const kickApi = require('../utils/kick-api');
            const youtubeApi = require('../utils/youtube-api');
            const tiktokApi = require('../utils/tiktok-api');
            const trovoApi = require('../utils/trovo-api');

            const streamPromises = liveAnnouncementsData.map(async (announcement) => {
                try {
                    let streamData = null;
                    const platform = announcement.platform.toLowerCase();
                    const username = announcement.username;
                    const discordUserId = announcement.discord_user_id || announcement.streamer_discord_id;
                    let streamUrl = '';

                    if (platform === 'twitch') {
                        streamData = await twitchApi.getStreamDetails(username);
                        if (streamData) {
                            streamUrl = `https://twitch.tv/${streamData.user_login || username}`;
                            return {
                                platform: 'twitch',
                                username: streamData.user_name || username,
                                display_name: streamData.user_name || username,
                                title: streamData.title || 'Untitled Stream',
                                game_name: streamData.game_name || null,
                                viewer_count: streamData.viewer_count || 0,
                                thumbnail_url: streamData.thumbnail_url ? streamData.thumbnail_url.replace('{width}', '440').replace('{height}', '248') : null,
                                stream_started_at: streamData.started_at,
                                profile_image_url: announcement.profile_image_url,
                                stream_url: streamUrl,
                                discord_user_id: discordUserId
                            };
                        }
                    } else if (platform === 'kick') {
                        streamData = await kickApi.getStreamDetails(username);
                        if (streamData) {
                            streamUrl = `https://kick.com/${username}`;
                            return {
                                platform: 'kick',
                                username: username,
                                display_name: username,
                                title: streamData.title || 'Untitled Stream',
                                game_name: streamData.game_name || null,
                                viewer_count: streamData.viewer_count || 0,
                                thumbnail_url: streamData.thumbnail_url || null,
                                stream_started_at: streamData.stream_started_at || new Date().toISOString(),
                                profile_image_url: streamData.profile_image_url || announcement.profile_image_url,
                                stream_url: streamUrl,
                                discord_user_id: discordUserId
                            };
                        }
                    } else if (platform === 'youtube') {
                        streamData = await youtubeApi.getStreamDetails(username);
                        if (streamData) {
                            streamUrl = `https://youtube.com/@${username}/live`;
                            return {
                                platform: 'youtube',
                                username: streamData.channelTitle || username,
                                display_name: streamData.channelTitle || username,
                                title: streamData.title || 'Untitled Stream',
                                game_name: streamData.categoryId || null,
                                viewer_count: streamData.viewerCount || 0,
                                thumbnail_url: streamData.thumbnails?.high?.url || streamData.thumbnails?.medium?.url || null,
                                stream_started_at: streamData.publishedAt,
                                profile_image_url: announcement.profile_image_url,
                                stream_url: streamUrl,
                                discord_user_id: discordUserId
                            };
                        }
                    } else if (platform === 'tiktok') {
                        streamData = await tiktokApi.isStreamerLive(username);
                        if (streamData && streamData.isLive) {
                            streamUrl = `https://tiktok.com/@${username}/live`;
                            return {
                                platform: 'tiktok',
                                username: username,
                                display_name: streamData.displayName || username,
                                title: streamData.title || 'Live on TikTok',
                                game_name: null,
                                viewer_count: streamData.viewerCount || 0,
                                thumbnail_url: streamData.coverUrl || null,
                                stream_started_at: streamData.startTime || new Date().toISOString(),
                                profile_image_url: streamData.avatarUrl || announcement.profile_image_url,
                                stream_url: streamUrl,
                                discord_user_id: discordUserId
                            };
                        }
                    } else if (platform === 'trovo') {
                        streamData = await trovoApi.isStreamerLive(username);
                        if (streamData && streamData.is_live) {
                            streamUrl = `https://trovo.live/${username}`;
                            return {
                                platform: 'trovo',
                                username: username,
                                display_name: streamData.username || username,
                                title: streamData.live_title || 'Untitled Stream',
                                game_name: streamData.category_name || null,
                                viewer_count: streamData.current_viewers || 0,
                                thumbnail_url: streamData.thumbnail || null,
                                stream_started_at: streamData.started_at || new Date().toISOString(),
                                profile_image_url: streamData.profile_pic || announcement.profile_image_url,
                                stream_url: streamUrl,
                                discord_user_id: discordUserId
                            };
                        }
                    }

                    return null;
                } catch (err) {
                    console.error(`[Status] Error fetching stream data for ${announcement.platform}/${announcement.username}:`, err.message);
                    return null;
                }
            });

            const streamResults = await Promise.all(streamPromises);
            const validStreams = streamResults.filter(s => s !== null);

            // Group streamers by Discord ID first, then by username (case-insensitive)
            const streamerGroups = new Map();

            validStreams.forEach(stream => {
                // Create a unique key: prefer Discord ID, fallback to username
                const groupKey = stream.discord_user_id || `username_${stream.username.toLowerCase()}`;

                if (!streamerGroups.has(groupKey)) {
                    // Create new group with all stream data indexed by platform
                    streamerGroups.set(groupKey, {
                        username: stream.username,
                        display_name: stream.display_name,
                        platforms: [stream.platform],
                        platformData: {
                            [stream.platform]: stream
                        },
                        title: stream.title,
                        stream_title: stream.title,
                        game_name: stream.game_name,
                        category: stream.game_name,
                        viewer_count: stream.viewer_count,
                        current_viewers: stream.viewer_count,
                        thumbnail_url: stream.thumbnail_url || stream.profile_image_url || 'https://cdn.discordapp.com/embed/avatars/0.png',
                        stream_started_at: stream.stream_started_at,
                        profile_image_url: stream.profile_image_url,
                        platform: stream.platform,
                        stream_url: stream.stream_url,
                        discord_user_id: stream.discord_user_id
                    });
                } else {
                    const group = streamerGroups.get(groupKey);

                    // Add platform if not already there
                    if (!group.platforms.includes(stream.platform)) {
                        group.platforms.push(stream.platform);
                    }

                    // Store platform-specific data
                    group.platformData[stream.platform] = stream;

                    // Sum viewer counts across all platforms
                    group.viewer_count += stream.viewer_count;
                    group.current_viewers = group.viewer_count;

                    // Use earliest stream start time across all platforms
                    if (new Date(stream.stream_started_at) < new Date(group.stream_started_at)) {
                        group.stream_started_at = stream.stream_started_at;
                    }

                    // Use data from platform with most viewers for primary display
                    const currentMaxViewers = Math.max(...Object.values(group.platformData).map(d => d.viewer_count));
                    const maxViewerStream = Object.values(group.platformData).find(d => d.viewer_count === currentMaxViewers);

                    if (maxViewerStream) {
                        group.title = maxViewerStream.title;
                        group.stream_title = maxViewerStream.title;
                        group.game_name = maxViewerStream.game_name;
                        group.category = maxViewerStream.game_name;
                        group.thumbnail_url = maxViewerStream.thumbnail_url || group.thumbnail_url;
                        group.platform = maxViewerStream.platform; // Primary platform with most viewers
                        group.stream_url = maxViewerStream.stream_url;
                    }
                }
            });

            // Convert to array, add allPlatforms property, and sort alphabetically
            const liveStreamers = Array.from(streamerGroups.values())
                .map(group => ({
                    ...group,
                    allPlatforms: group.platforms
                }))
                .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));

            const [streamerCountResult] = await db.execute('SELECT COUNT(DISTINCT username) as count FROM streamers');
            const totalStreamers = streamerCountResult[0]?.count || 0;

            const [announcementsResult] = await db.execute('SELECT COUNT(*) as count FROM announcements');
            const totalAnnouncements = announcementsResult[0]?.count || 0;

            const generalStats = {
                totalGuilds: client.guilds.cache.size || 0,
                totalStreamers: totalStreamers,
                totalAnnouncements: totalAnnouncements
            };

            res.render('status-modern', {
                user: req.user,
                liveStreamers: liveStreamers,
                generalStats: generalStats
            });
        } catch (error) {
            console.error('[Status Page Error]', error);
            res.render('status-modern', { user: req.user, liveStreamers: [], generalStats: {} });
        }
    });
    app.get('/super-admin', checkAuth, (req, res) => {
        // Check if user is super admin
        if (!req.user || !req.user.isSuperAdmin) {
            return res.status(403).render('error', { user: req.user, error: 'Access denied. Super admin privileges required.' });
        }
        res.render('super-admin-modern', { user: req.user });
    });
    app.get('/donate', (req, res) => res.render('donate-modern', { user: req.user }));
    app.get('/docs', (req, res) => res.render('docs', { user: req.user }));
    app.get('/terms', (req, res) => res.render('terms', { user: req.user }));
    app.get('/privacy', (req, res) => res.render('privacy', { user: req.user }));
    // Redirect /servers to /dashboard for consolidation
    app.get('/servers', checkAuth, (req, res) => res.redirect('/dashboard'));
    app.get('/manage', checkAuth, (req, res) => res.redirect('/dashboard'));
    app.get('/login', passport.authenticate('discord'));
    app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));
    app.get('/logout', (req, res) => { req.logout(() => { res.redirect(process.env.DASHBOARD_URL || 'https://bot.certifriedannouncer.online'); }); });
    app.get('/dashboard', checkAuth, async (req, res) => {
        try {
            const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(g.id));

            // Calculate totals across all managed servers
            let totalMembers = 0;
            let totalLiveStreams = 0;

            // Get guild IDs for database query
            const guildIds = manageableGuilds.map(g => g.id);

            if (guildIds.length > 0) {
                // Get member counts and streamer counts from actual Discord guilds
                for (const guildData of manageableGuilds) {
                    const botGuild = client.guilds.cache.get(guildData.id);
                    if (botGuild) {
                        totalMembers += botGuild.memberCount || 0;
                        guildData.memberCount = botGuild.memberCount || 0;
                    }

                    // Get streamer count for this guild
                    const [streamerCount] = await db.execute(
                        'SELECT COUNT(DISTINCT streamer_id) as count FROM subscriptions WHERE guild_id = ?',
                        [guildData.id]
                    );
                    guildData.streamerCount = streamerCount[0]?.count || 0;
                }

                // Get total live streams across all guilds
                const [liveStreams] = await db.execute(
                    `SELECT COUNT(DISTINCT a.id) as count
                     FROM live_announcements a
                     WHERE a.guild_id IN (${guildIds.map(() => '?').join(',')})`,
                    guildIds
                );
                totalLiveStreams = liveStreams[0]?.count || 0;
            }

            res.render('servers-modern', {
                manageableGuilds,
                user: req.user,
                totalMembers,
                totalLiveStreams
            });
        } catch (error) {
            console.error('[/dashboard Error]', error);
            res.render('servers-modern', {
                manageableGuilds: [],
                user: req.user,
                totalMembers: 0,
                totalLiveStreams: 0
            });
        }
    });

    app.get('/profile', checkAuth, async (req, res) => {
        try {
            const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(g.id));

            let totalMembers = 0;
            let totalStreamers = 0;

            const guildIds = manageableGuilds.map(g => g.id);

            if (guildIds.length > 0) {
                // Get member counts
                for (const guildData of manageableGuilds) {
                    const botGuild = client.guilds.cache.get(guildData.id);
                    if (botGuild) {
                        totalMembers += botGuild.memberCount || 0;
                    }
                }

                // Get total streamers
                const [streamerCount] = await db.execute(
                    `SELECT COUNT(DISTINCT streamer_id) as count
                     FROM subscriptions
                     WHERE guild_id IN (${guildIds.map(() => '?').join(',')})`,
                    guildIds
                );
                totalStreamers = streamerCount[0]?.count || 0;
            }

            res.render('profile-modern', {
                user: req.user,
                guilds: manageableGuilds,
                totalGuilds: manageableGuilds.length,
                totalMembers,
                totalStreamers
            });
        } catch (error) {
            console.error('[/profile Error]', error);
            res.render('profile-modern', {
                user: req.user,
                guilds: [],
                totalGuilds: 0,
                totalMembers: 0,
                totalStreamers: 0
            });
        }
    });

    app.get('/settings', checkAuth, (req, res) => {
        res.render('settings-modern', {
            user: req.user
        });
    });

    // API: Get user preferences
    app.get('/api/user/preferences', checkAuth, async (req, res) => {
        try {
            const [preferences] = await db.execute(
                'SELECT * FROM user_preferences WHERE discord_user_id = ?',
                [req.user.id]
            );

            if (preferences.length === 0) {
                // Return default preferences
                return res.json({
                    success: true,
                    preferences: {
                        theme: 'dark',
                        compact_mode: false,
                        browser_notifications: false,
                        stream_alerts: true,
                        update_notifications: true,
                        show_online_status: true,
                        analytics_enabled: true
                    }
                });
            }

            res.json({
                success: true,
                preferences: {
                    theme: preferences[0].theme || 'dark',
                    compact_mode: preferences[0].compact_mode || false,
                    browser_notifications: preferences[0].browser_notifications || false,
                    stream_alerts: preferences[0].stream_alerts || true,
                    update_notifications: preferences[0].update_notifications || true,
                    show_online_status: preferences[0].show_online_status || true,
                    analytics_enabled: preferences[0].analytics_enabled || true
                }
            });
        } catch (error) {
            console.error('[Get Preferences Error]', error);
            res.status(500).json({ success: false, error: 'Failed to load preferences' });
        }
    });

    // API: Save user preferences
    app.post('/api/user/preferences', checkAuth, async (req, res) => {
        try {
            const {
                theme,
                compact_mode,
                browser_notifications,
                stream_alerts,
                update_notifications,
                show_online_status,
                analytics_enabled,
                keep_announcement_after_stream
            } = req.body;

            // Insert or update preferences
            await db.execute(`
                INSERT INTO user_preferences
                (discord_user_id, theme, compact_mode, browser_notifications, stream_alerts,
                 update_notifications, show_online_status, analytics_enabled, keep_announcement_after_stream)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                theme = VALUES(theme),
                compact_mode = VALUES(compact_mode),
                browser_notifications = VALUES(browser_notifications),
                stream_alerts = VALUES(stream_alerts),
                update_notifications = VALUES(update_notifications),
                show_online_status = VALUES(show_online_status),
                analytics_enabled = VALUES(analytics_enabled),
                keep_announcement_after_stream = VALUES(keep_announcement_after_stream),
                updated_at = CURRENT_TIMESTAMP
            `, [
                req.user.id,
                theme || 'dark',
                compact_mode || false,
                browser_notifications || false,
                stream_alerts !== false, // default true
                update_notifications !== false, // default true
                show_online_status !== false, // default true
                analytics_enabled !== false, // default true
                keep_announcement_after_stream !== undefined ? keep_announcement_after_stream : null // null = use server default
            ]);

            res.json({ success: true, message: 'Preferences saved successfully' });
        } catch (error) {
            console.error('[Save Preferences Error]', error);
            res.status(500).json({ success: false, error: 'Failed to save preferences' });
        }
    });

    app.get('/manage/:guildId', checkAuth, checkGuildAdmin, noCache, async (req, res) => {
        try {
            const botGuild = req.guildObject;
            const guildId = botGuild.id;
            const [[subscriptions], [guildSettingsResult], [channelSettingsResult], allRoles, allChannels, [teamSubscriptions]] = await Promise.all([
                // *** UPDATED QUERY to fetch kick_username ***
                db.execute(`SELECT sub.*, s.platform, s.username, s.discord_user_id, s.kick_username, s.streamer_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? ORDER BY s.username`, [guildId]),
                db.execute('SELECT * FROM guilds WHERE guild_id = ?', [guildId]),
                db.execute('SELECT * FROM channel_settings WHERE guild_id = ?', [guildId]),
                botGuild.roles.fetch(),
                botGuild.channels.fetch(),
                db.execute('SELECT * FROM twitch_teams WHERE guild_id = ?', [guildId])
            ]);
            const channelsData = {};
            const allChannelsMap = new Map(allChannels.map(ch => [ch.id, ch.name]));
            for (const sub of subscriptions) {
                const channelId = sub.announcement_channel_id || 'default';
                if (!channelsData[channelId]) {
                    channelsData[channelId] = { name: channelId === 'default' ? 'Server Default' : allChannelsMap.get(channelId) || 'Unknown Channel', streamers: [], teams: [] };
                }
                channelsData[channelId].streamers.push(sub);
            }
            for (const teamSub of teamSubscriptions) {
                const channelId = teamSub.announcement_channel_id;
                 if (!channelsData[channelId]) {
                    channelsData[channelId] = { name: allChannelsMap.get(channelId) || 'Unknown Channel', streamers: [], teams: [] };
                }
                channelsData[channelId].teams.push(teamSub);
            }
            for(const channelId in channelsData){
                const streamerMap = new Map();
                for(const streamer of channelsData[channelId].streamers){
                     if (!streamerMap.has(streamer.streamer_id)) {
                        streamerMap.set(streamer.streamer_id, { ...streamer, subscriptions: [] });
                    }
                    streamerMap.get(streamer.streamer_id).subscriptions.push(streamer);
                }
                channelsData[channelId].streamers = Array.from(streamerMap.values());
            }
            // Consolidated streamers for various pages - group by discord_user_id (if present) or username
            const consolidatedStreamerMap = new Map();
            for (const sub of subscriptions) {
                // Use discord_user_id as the consolidation key if it exists, otherwise use normalized username
                const consolidationKey = sub.discord_user_id || `username_${sub.username.toLowerCase()}`;

                if (!consolidatedStreamerMap.has(consolidationKey)) {
                    consolidatedStreamerMap.set(consolidationKey, {
                        id: consolidationKey, // Use consolidation key as ID for frontend
                        name: sub.username,
                        discord_user_id: sub.discord_user_id,
                        kick_username: sub.kick_username,
                        profile_image_url: sub.profile_image_url,
                        is_blacklisted: sub.is_blacklisted || false,
                        platforms: [],
                        subscriptions: [],
                        streamer_ids: [] // Track all streamer_ids for this consolidated entry
                    });
                }
                const streamer = consolidatedStreamerMap.get(consolidationKey);

                // Track unique streamer IDs
                if (!streamer.streamer_ids.includes(sub.streamer_id)) {
                    streamer.streamer_ids.push(sub.streamer_id);
                }

                // Add platform if not already present
                if (!streamer.platforms.includes(sub.platform)) {
                    streamer.platforms.push(sub.platform);
                }

                // Add subscription
                streamer.subscriptions.push(sub);
            }
            const consolidatedStreamers = Array.from(consolidatedStreamerMap.values());

            res.render('manage-modern', {
                guild: botGuild,
                channelsData: channelsData,
                consolidatedStreamers: consolidatedStreamers,
                totalSubscriptions: subscriptions.length,
                user: req.user,
                settings: guildSettingsResult[0] || {},
                channelSettings: channelSettingsResult,
                channelSettingsMap: new Map(channelSettingsResult.map(cs => [cs.channel_id, cs])),
                roles: allRoles.filter(r => !r.managed && r.name !== '@everyone'),
                channels: allChannels.filter(c => c.isTextBased()),
                voiceChannels: allChannels.filter(c => c.isVoiceBased()),
                categories: allChannels.filter(c => c.type === 4),
                teamSubscriptions: teamSubscriptions,
                // Events
                events: [],
                // Community Features
                welcomeSettings: {},
                reactionRolePanels: [],
                starboardConfig: {},
                roleRewards: [],
                giveaways: [],
                polls: [],
                suggestions: [],
                suggestionConfig: {},
                suggestionStats: {},
                suggestionTags: [],
                // Music
                musicQueues: [],
                musicConfig: {},
                nowPlaying: {},
                availableDJVoices: [],
                // Birthday & Weather
                birthdayUsers: [],
                birthdayStats: {},
                weatherStats: {},
                weatherConfig: {},
                // Economy & Games
                economyConfig: {},
                shopItems: [],
                economyStats: {},
                topUsers: [],
                triviaQuestions: [],
                hangmanWords: [],
                countingChannels: [],
                gameStats: {},
                gamblingConfig: {},
                gamblingHistory: [],
                gamblingStats: {},
                topGamblers: [],
                activeTrades: [],
                tradeHistory: [],
                tradeStats: {},
                rpgStats: {},
                rpgCharacters: [],
                // Moderation & Security
                moderationConfig: {},
                recentInfractions: [],
                escalationRules: [],
                automodRules: [],
                heatConfig: {},
                joinGateConfig: {},
                antiRaidConfig: {},
                antiNukeConfig: {},
                quarantineConfig: {},
                quarantinedUsers: [],
                // Utilities & Features
                statroleConfigs: [],
                logConfig: {},
                actionLogs: [],
                auditLogs: [],
                analyticsData: {},
                serverStats: [],
                // Social Feeds
                redditFeeds: [],
                youtubeFeeds: [],
                twitterFeeds: [],
                // Twitch
                twitchScheduleSyncs: [],
                // Utilities
                autoPublisherConfig: {},
                autorolesConfig: {},
                tempChannelConfig: {},
                // Custom Commands & Forms
                customCommands: [],
                commandSettings: [],
                forms: [],
                ticketConfig: {},
                ticketFormsList: [],
                // Backups & Permissions
                backups: [],
                permissionOverrides: [],
                // Misc
                reminders: [],
                tags: [],
                page: req.query.page || 'overview'
            });
        } catch (error) {
            console.error('[Dashboard GET Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error loading management page.' });
        }
    });
    app.get('/api/global-live-status', async(req, res) => {
        try {
            const [liveAnnouncements] = await db.execute(`SELECT s.username, s.profile_image_url, a.platform, a.stream_game, a.stream_thumbnail_url, sub.override_avatar_url FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id LEFT JOIN subscriptions sub ON a.streamer_id = sub.streamer_id AND a.guild_id = sub.guild_id AND a.channel_id <=> sub.announcement_channel_id`);
            const groupedByName = {};
            for (const stream of liveAnnouncements) {
                const key = stream.username.toLowerCase();
                if (!groupedByName[key]) {
                    groupedByName[key] = { username: stream.username, potential_avatars: new Set(), live_platforms: [] };
                }
                if(stream.override_avatar_url) groupedByName[key].potential_avatars.add(stream.override_avatar_url);
                if(stream.profile_image_url) groupedByName[key].potential_avatars.add(stream.profile_image_url);
                if(stream.stream_thumbnail_url) groupedByName[key].potential_avatars.add(stream.stream_thumbnail_url);
                if (!groupedByName[key].live_platforms.some(p => p.platform === stream.platform)) {
                    groupedByName[key].live_platforms.push({ platform: stream.platform, game: stream.stream_game || 'N/A' });
                }
            }
            const uniqueStreamers = Object.values(groupedByName).map(streamer => {
                const bestAvatar = [...streamer.potential_avatars].find(url => url && !url.includes('restricted') && !url.includes('twitch-default-404')) || [...streamer.potential_avatars][0] || '/images/default-icon.png';
                return { username: streamer.username, avatar_url: bestAvatar, live_platforms: streamer.live_platforms };
            });
            const finalStreamers = uniqueStreamers.sort(() => 0.5 - Math.random()).slice(0, 5);
            res.json(finalStreamers);
        } catch (e) {
            console.error('[Global Live Status API Error]', e);
            res.status(500).json([]);
        }
    });
    app.get('/api/guilds/:guildId/livestatus', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const [liveAnnouncements] = await db.execute(`SELECT s.platform, s.username, s.profile_image_url, MAX(a.stream_game) as stream_game, MAX(a.stream_thumbnail_url) as stream_thumbnail_url, MAX(sub.override_avatar_url) as override_avatar_url FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id LEFT JOIN subscriptions sub ON a.streamer_id = sub.streamer_id AND a.guild_id = sub.guild_id AND a.channel_id <=> sub.announcement_channel_id WHERE a.guild_id = ? GROUP BY s.streamer_id, s.platform, s.username, s.profile_image_url ORDER BY s.platform, s.username`, [req.params.guildId]);
            const enrichedStreamers = liveAnnouncements.map(streamer => ({ ...streamer, avatar_url: streamer.override_avatar_url || streamer.profile_image_url || streamer.stream_thumbnail_url || '/images/default-icon.png' }));
            res.json(enrichedStreamers);
        } catch (e) {
            console.error('[Live Status API Error]', e);
            res.status(500).json([]);
        }
    });

    app.get('/api/status/server-stats', async (req, res) => {
        try {
            const cpus = os.cpus();
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;

            // Calculate CPU usage (simplified)
            let totalIdle = 0, totalTick = 0;
            cpus.forEach(cpu => {
                for (let type in cpu.times) {
                    totalTick += cpu.times[type];
                }
                totalIdle += cpu.times.idle;
            });
            const cpuUsage = 100 - Math.round(100 * totalIdle / totalTick);

            // Get network I/O stats
            const networkInterfaces = os.networkInterfaces();
            let networkStats = { rx: 0, tx: 0 };
            try {
                const { execSync } = require('child_process');
                const netstat = execSync('cat /proc/net/dev 2>/dev/null || echo ""').toString();
                const lines = netstat.split('\n');
                for (const line of lines) {
                    if (line.includes(':')) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 10) {
                            networkStats.rx += parseInt(parts[1]) || 0;
                            networkStats.tx += parseInt(parts[9]) || 0;
                        }
                    }
                }
                // Convert to GB
                networkStats.rx = (networkStats.rx / 1024 / 1024 / 1024).toFixed(2) + ' GB';
                networkStats.tx = (networkStats.tx / 1024 / 1024 / 1024).toFixed(2) + ' GB';
            } catch (err) {
                networkStats = { rx: 'N/A', tx: 'N/A' };
            }

            // Get disk usage
            let diskUsage = { used: 'N/A', total: 'N/A', percent: 0 };
            try {
                const { execSync } = require('child_process');
                const df = execSync('df -BG / | tail -1').toString();
                const parts = df.trim().split(/\s+/);
                if (parts.length >= 5) {
                    diskUsage.total = parts[1];
                    diskUsage.used = parts[2];
                    diskUsage.percent = parseInt(parts[4]);
                }
            } catch (err) {
                console.error('[Disk Usage Error]', err);
            }

            // Database stats
            let dbStats = { status: 'unknown', tables: 0, size: '0 MB', connections: 0 };
            try {
                const [dbStatus] = await db.execute('SELECT 1 as connected');
                if (dbStatus && dbStatus[0]?.connected === 1) {
                    dbStats.status = 'online';

                    // Get table count
                    const [tables] = await db.execute('SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE()');
                    dbStats.tables = tables[0]?.count || 0;

                    // Get database size
                    const [size] = await db.execute('SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) as size_mb FROM information_schema.tables WHERE table_schema = DATABASE()');
                    dbStats.size = `${size[0]?.size_mb || 0} MB`;

                    // Get connection count
                    const [conns] = await db.execute('SELECT COUNT(*) as count FROM information_schema.processlist');
                    dbStats.connections = conns[0]?.count || 0;
                }
            } catch (dbErr) {
                console.error('[DB Stats Error]', dbErr);
                dbStats.status = 'offline';
            }

            // Cache stats - Get real cache statistics
            let cacheStats = {
                status: 'online',
                hitRate: '0%',
                entries: 0,
                responseTime: '< 1ms'
            };

            try {
                // Check if intelligent cache manager exists
                const intelligentCacheManager = require('../utils/intelligent-cache-manager');
                if (intelligentCacheManager && intelligentCacheManager.getCacheStats) {
                    const stats = intelligentCacheManager.getCacheStats();
                    cacheStats.entries = stats.totalEntries || 0;
                    cacheStats.hitRate = stats.hitRate ? `${stats.hitRate.toFixed(1)}%` : '0%';
                }
            } catch (err) {
                // Cache manager not available, use defaults
            }

            // API Integration stats - Check actual API health
            let apiStats = {
                healthy: 0,
                degraded: 0,
                unavailable: 0,
                details: {}
            };

            const apiModules = {
                'Twitch': '../utils/twitch-api',
                'YouTube': '../utils/youtube-api',
                'Kick': '../utils/kick-api',
                'TikTok': '../utils/tiktok-api',
                'Trovo': '../utils/trovo-api',
                'Facebook': '../utils/facebook-api',
                'Instagram': '../utils/instagram-api'
            };

            for (const [name, path] of Object.entries(apiModules)) {
                try {
                    const apiModule = require(path);
                    if (apiModule && apiModule.isStreamerLive) {
                        apiStats.healthy++;
                        apiStats.details[name] = 'healthy';
                    } else {
                        apiStats.degraded++;
                        apiStats.details[name] = 'degraded';
                    }
                } catch (err) {
                    apiStats.unavailable++;
                    apiStats.details[name] = 'unavailable';
                }
            }

            // Get PM2 processes (only CertiFriedAnnouncer/LiveBot processes)
            let pm2Processes = [];
            try {
                const { execSync } = require('child_process');
                const pm2List = execSync('pm2 jlist').toString();
                const allProcesses = JSON.parse(pm2List);
                pm2Processes = allProcesses.filter(p =>
                    p.name.includes('LiveBot') ||
                    p.name.includes('Stream-Check') ||
                    p.name.includes('Social-Feed') ||
                    p.name.includes('Analytics') ||
                    p.name.includes('Ticket') ||
                    p.name.includes('Reminder')
                ).map(p => ({
                    name: p.name,
                    status: p.pm2_env.status,
                    uptime: p.pm2_env.pm_uptime,
                    restarts: p.pm2_env.restart_time,
                    memory: p.monit.memory,
                    cpu: p.monit.cpu,
                    pid: p.pid,
                    pm_id: p.pm_id
                }));
            } catch (err) {
                console.error('[PM2 Process Error]', err);
            }

            // Get live streams statistics
            let liveStreamStats = {
                totalAnnouncements: 0,
                activeStreamers: 0,
                platforms: {}
            };

            try {
                // Get total active announcements
                const [announcements] = await db.execute('SELECT COUNT(DISTINCT id) as count FROM live_announcements');
                liveStreamStats.totalAnnouncements = announcements[0]?.count || 0;

                // Get unique active streamers
                const [streamers] = await db.execute('SELECT COUNT(DISTINCT streamer_id) as count FROM live_announcements');
                liveStreamStats.activeStreamers = streamers[0]?.count || 0;

                // Get per-platform breakdown
                const [platforms] = await db.execute('SELECT platform, COUNT(*) as count FROM live_announcements GROUP BY platform');
                platforms.forEach(p => {
                    liveStreamStats.platforms[p.platform] = p.count;
                });
            } catch (err) {
                console.error('[Live Stream Stats Error]', err);
            }

            res.json({
                success: true,
                system: {
                    cpu: {
                        usage: cpuUsage,
                        cores: cpus.length
                    },
                    memory: {
                        total: totalMem,
                        used: usedMem,
                        free: freeMem,
                        usagePercent: (usedMem / totalMem) * 100
                    },
                    network: networkStats,
                    disk: diskUsage,
                    uptime: os.uptime(),
                    platform: os.platform()
                },
                bot: {
                    guilds: client ? client.guilds.cache.size : 0,
                    users: client ? client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0) : 0
                },
                database: dbStats,
                cache: cacheStats,
                api: apiStats,
                processes: pm2Processes,
                liveStreams: liveStreamStats
            });
        } catch (error) {
            console.error('[Status API Error]', error);
            res.status(500).json({ success: false, error: 'Failed to fetch server stats' });
        }
    });

    app.get('/api/status/logs', async (req, res) => {
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            const fs = require('fs').promises;
            const path = require('path');

            // Only read logs from LiveBot processes (exclude CF, Canna, Habtips, HT)
            const allowedProcesses = [
                'LiveBot-Main',
                'LiveBot-Announcer',
                'LiveBot-System',
                'LiveBot-Reminder-Worker',
                'LiveBot-Ticket-Worker',
                'LiveBot-Social-Worker',
                'Stream-Check-Scheduler',
                'Social-Feed-Scheduler',
                'Ticket-Scheduler',
                'Analytics-Scheduler'
            ];

            const logs = [];
            const logDir = '/root/.pm2/logs';

            // Read log files for each allowed process
            for (const processName of allowedProcesses) {
                try {
                    // Read both error and output logs
                    const errorLogPattern = `${processName}-error.log`;
                    const outLogPattern = `${processName}-out.log`;

                    // Read error logs
                    try {
                        const errorLogPath = path.join(logDir, errorLogPattern);
                        const errorContent = await fs.readFile(errorLogPath, 'utf8');
                        const errorLines = errorContent.split('\n').filter(line => line.trim()).slice(-50); // Last 50 lines

                        errorLines.forEach(line => {
                            logs.push({
                                process: processName,
                                type: 'error',
                                message: line,
                                timestamp: new Date().toISOString()
                            });
                        });
                    } catch (err) {
                        // Log file might not exist or be empty
                    }

                    // Read output logs
                    try {
                        const outLogPath = path.join(logDir, outLogPattern);
                        const outContent = await fs.readFile(outLogPath, 'utf8');
                        const outLines = outContent.split('\n').filter(line => line.trim()).slice(-50); // Last 50 lines

                        outLines.forEach(line => {
                            // Determine log level from line content
                            let type = 'info';
                            if (line.toLowerCase().includes('error')) type = 'error';
                            else if (line.toLowerCase().includes('warn')) type = 'warn';
                            else if (line.toLowerCase().includes('debug')) type = 'debug';

                            logs.push({
                                process: processName,
                                type: type,
                                message: line,
                                timestamp: new Date().toISOString()
                            });
                        });
                    } catch (err) {
                        // Log file might not exist or be empty
                    }
                } catch (processError) {
                    console.error(`[Logs API] Error reading logs for ${processName}:`, processError.message);
                }
            }

            // Sort logs by timestamp (most recent first) and limit to 200 total
            logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            const recentLogs = logs.slice(0, 200);

            res.json({ success: true, logs: recentLogs, processNames: allowedProcesses });
        } catch (error) {
            console.error('[Logs API Error]', error);
            res.status(500).json({ success: false, logs: [], error: error.message });
        }
    });

    // Super Admin Stats API
    app.get('/api/admin/stats', checkAuth, async (req, res) => {
        try {
            // Check if user is super admin
            if (!req.user || !req.user.isSuperAdmin) {
                return res.status(403).json({ success: false, error: 'Access denied' });
            }

            // Get total guilds and users from Discord client
            const totalGuilds = client ? client.guilds.cache.size : 0;
            const totalUsers = client ? client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0) : 0;

            // Get bot uptime in seconds
            const uptime = client ? Math.floor(client.uptime / 1000) : 0;

            // Get memory usage in MB
            const memoryUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

            // Get database statistics
            const [streamersCount] = await db.execute('SELECT COUNT(DISTINCT streamer_id) as count FROM streamers');
            const [subscriptionsCount] = await db.execute('SELECT COUNT(*) as count FROM subscriptions');
            const [announcementsCount] = await db.execute('SELECT COUNT(*) as count FROM live_announcements');
            const [liveStreamersCount] = await db.execute('SELECT COUNT(DISTINCT username) as count FROM live_announcements');

            res.json({
                success: true,
                stats: {
                    totalGuilds: totalGuilds,
                    totalUsers: totalUsers,
                    totalStreamers: streamersCount[0]?.count || 0,
                    totalSubscriptions: subscriptionsCount[0]?.count || 0,
                    totalAnnouncements: announcementsCount[0]?.count || 0,
                    liveStreamers: liveStreamersCount[0]?.count || 0,
                    uptime: uptime,
                    memoryUsage: memoryUsage
                }
            });
        } catch (error) {
            console.error('[Admin Stats API Error]', error);
            res.status(500).json({ success: false, error: 'Failed to fetch admin stats' });
        }
    });

    // Audit Users API with SSE for real-time progress
    app.get('/api/admin/audit-users', checkAuth, async (req, res) => {
        try {
            // Check if user is super admin
            if (!req.user || !req.user.isSuperAdmin) {
                return res.status(403).json({ success: false, error: 'Access denied' });
            }

            // Set up SSE headers
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            const sendProgress = (data) => {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            let totalGuilds = 0;
            let totalMembers = 0;
            let exactMatches = 0;
            let fuzzyMatches = 0;
            let newLinks = 0;
            let existingLinks = 0;

            try {
                // Get all streamers from database for matching
                const [streamers] = await db.execute('SELECT streamer_id, username, platform FROM streamers');
                const streamerMap = new Map();
                streamers.forEach(s => {
                    const key = `${s.username.toLowerCase()}_${s.platform}`;
                    streamerMap.set(key, s.streamer_id);
                    // Also add without platform for broader matching
                    if (!streamerMap.has(s.username.toLowerCase())) {
                        streamerMap.set(s.username.toLowerCase(), s.streamer_id);
                    }
                });

                sendProgress({ type: 'info', message: 'Starting audit...', totalGuilds: 0 });

                const guilds = Array.from(client.guilds.cache.values());
                totalGuilds = guilds.length;

                sendProgress({ type: 'info', message: `Found ${totalGuilds} guilds to scan`, totalGuilds });

                // Process guilds
                for (let i = 0; i < guilds.length; i++) {
                    const guild = guilds[i];

                    try {
                        sendProgress({
                            type: 'progress',
                            message: `Scanning guild ${i + 1}/${totalGuilds}: ${guild.name}`,
                            currentGuild: i + 1,
                            totalGuilds,
                            guildName: guild.name
                        });

                        // Fetch all members (this might take time for large guilds)
                        await guild.members.fetch();
                        const members = Array.from(guild.members.cache.values());
                        totalMembers += members.length;

                        sendProgress({
                            type: 'progress',
                            message: `Processing ${members.length} members in ${guild.name}`,
                            currentGuild: i + 1,
                            totalGuilds,
                            totalMembers
                        });

                        // Check each member
                        for (const member of members) {
                            if (member.user.bot) continue;

                            const username = member.user.username.toLowerCase();
                            const displayName = (member.displayName || member.user.displayName || '').toLowerCase();

                            // Try exact match first
                            let streamerId = streamerMap.get(username);
                            let matchType = 'exact';

                            // Try display name if no exact match
                            if (!streamerId && displayName && displayName !== username) {
                                streamerId = streamerMap.get(displayName);
                                matchType = 'fuzzy';
                            }

                            if (streamerId) {
                                // Check if link already exists
                                const [existing] = await db.execute(
                                    'SELECT discord_user_id FROM streamers WHERE streamer_id = ? AND discord_user_id = ?',
                                    [streamerId, member.user.id]
                                );

                                if (existing.length === 0) {
                                    // Create new link
                                    await db.execute(
                                        'UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ? AND discord_user_id IS NULL',
                                        [member.user.id, streamerId]
                                    );
                                    newLinks++;

                                    if (matchType === 'exact') {
                                        exactMatches++;
                                    } else {
                                        fuzzyMatches++;
                                    }

                                    sendProgress({
                                        type: 'match',
                                        message: `Found ${matchType} match: ${member.user.username} → Streamer ID ${streamerId}`,
                                        exactMatches,
                                        fuzzyMatches,
                                        newLinks
                                    });
                                } else {
                                    existingLinks++;
                                    if (matchType === 'exact') {
                                        exactMatches++;
                                    } else {
                                        fuzzyMatches++;
                                    }
                                }
                            }
                        }

                        sendProgress({
                            type: 'progress',
                            message: `Completed guild ${i + 1}/${totalGuilds}: ${guild.name}`,
                            currentGuild: i + 1,
                            totalGuilds,
                            totalMembers,
                            exactMatches,
                            fuzzyMatches,
                            newLinks,
                            existingLinks
                        });

                    } catch (guildError) {
                        console.error(`[Audit] Error processing guild ${guild.name}:`, guildError);
                        sendProgress({
                            type: 'error',
                            message: `Error processing guild ${guild.name}: ${guildError.message}`
                        });
                    }
                }

                // Send completion
                sendProgress({
                    type: 'complete',
                    message: 'Audit completed!',
                    results: {
                        totalGuilds,
                        totalMembers,
                        exactMatches,
                        fuzzyMatches,
                        newLinks,
                        existingLinks
                    }
                });

                res.end();

            } catch (error) {
                console.error('[Audit] Error during audit:', error);
                sendProgress({ type: 'error', message: `Error: ${error.message}` });
                res.end();
            }

        } catch (error) {
            console.error('[Audit API Error]', error);
            res.status(500).json({ success: false, error: 'Failed to run audit' });
        }
    });

    app.post('/manage/:guildId/settings', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { channelId, roleId } = req.body;
            await db.execute('INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = ?, live_role_id = ?', [req.params.guildId, channelId || null, roleId || null, channelId || null, roleId || null]);
            res.redirect(`/manage/${req.params.guildId}?success=settings`);
        } catch (e) { console.error('[Dashboard Settings Save Error]', e); res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent('Failed to save settings.')}`); }
    });
    app.post('/manage/:guildId/channel-appearance/save', checkAuth, checkGuildAdmin, upload.single('avatar'), async (req, res) => {
        const { channelId, nickname, avatar_url_text } = req.body;
        const avatarFile = req.file;
        const guildId = req.params.guildId;
        if (!channelId) { return res.redirect(`/manage/${guildId}?error=${encodeURIComponent('You must select a channel to customize.')}`); }
        try {
            const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
            if ((avatarFile || avatar_url_text) && !tempUploadChannelId) { throw new Error("Avatar upload features are not configured."); }
            const guild = client.guilds.cache.get(guildId);
            if (!guild) throw new Error("Bot is not in this guild.");
            const channel = await guild.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) throw new Error("Invalid or inaccessible channel selected.");
            let finalAvatarUrl = undefined;
            if (avatarFile) {
                try {
                    const tempChannel = await client.channels.fetch(tempUploadChannelId);
                    if (!tempChannel || !tempChannel.isTextBased()) { throw new Error("Temporary upload channel is not a text channel."); }
                    const tempMessage = await tempChannel.send({ files: [{ attachment: avatarFile.path, name: avatarFile.originalname }] });
                    finalAvatarUrl = tempMessage.attachments.first().url;
                } catch (uploadError) { console.error('[Dashboard Channel Customize] Error uploading avatar:', uploadError); throw new Error("Failed to upload custom avatar."); }
            } else if (avatar_url_text !== undefined) {
                 if (avatar_url_text.toLowerCase() === 'reset' || avatar_url_text === '') { finalAvatarUrl = null; } 
                 else if (!/^https?:\/\//.test(avatar_url_text)) { return res.redirect(`/manage/${guildId}?error=${encodeURIComponent('Invalid avatar URL.')}`); }
                 else { finalAvatarUrl = avatar_url_text; }
            }
            const updates = {};
            if (nickname !== undefined) { updates.override_nickname = nickname || null; }
            if (finalAvatarUrl !== undefined) { updates.override_avatar_url = finalAvatarUrl; }
            if (Object.keys(updates).length > 0) {
                const updateKeys = Object.keys(updates);
                const updateClauses = updateKeys.map(key => `${db.escapeId(key)} = ?`).join(', ');
                const updateValues = updateKeys.map(key => updates[key]);
                await db.execute(`INSERT INTO channel_settings (channel_id, guild_id, ${updateKeys.map(key => db.escapeId(key)).join(', ')}) VALUES (?, ?, ${updateKeys.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${updateClauses}`, [channelId, guildId, ...updateValues, ...updateValues]);
            }
            res.redirect(`/manage/${req.params.guildId}?success=customization`);
        } catch (e) {
            console.error("[Dashboard Channel Customize Error]", e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Customization failed: ${e.message}`)}`); 
        } finally {
            if (avatarFile?.path) fs.unlink(avatarFile.path, (err) => { if (err) console.error("Error deleting temp avatar file:", err); });
        }
    });
    app.post('/manage/:guildId/channel-appearance/delete', checkAuth, checkGuildAdmin, async(req, res) => {
        const { channelId } = req.body;
        try {
            if (!channelId) {
                throw new Error('Channel ID is required for deletion.');
            }
            const [result] = await db.execute('DELETE FROM channel_settings WHERE channel_id = ? AND guild_id = ?', [channelId, req.params.guildId]);
            
            if (result.affectedRows > 0) {
                res.redirect(`/manage/${req.params.guildId}?success=customization_reset`);
            } else {
                throw new Error('Could not find the customization to delete. It may have already been removed.');
            }
        } catch (e) {
            console.error('[Dashboard Channel Appearance Delete Error]', e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Failed to reset channel customization: ${e.message}`)}`);
        }
    });
    app.post('/manage/:guildId/add', checkAuth, checkGuildAdmin, upload.single('avatar'), async (req, res) => {
        const { platform, username, discord_user_id, announcement_channel_id, override_nickname, custom_message } = req.body;
        let channelIds = Array.isArray(announcement_channel_id) ? announcement_channel_id : (announcement_channel_id ? [announcement_channel_id] : []);
        if (channelIds.length === 0) channelIds.push(null);
        const avatarFile = req.file;
        let finalAvatarUrl = null;
        let cycleTLS = null;
        let browser = null;
        try {
            const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
            if (avatarFile && !tempUploadChannelId) { throw new Error("Avatar upload features are not configured."); }
            if (avatarFile) {
                try {
                    const tempChannel = await client.channels.fetch(tempUploadChannelId);
                    if (!tempChannel || !tempChannel.isTextBased()) { throw new Error("Temporary upload channel is not a text channel."); }
                    const tempMessage = await tempChannel.send({ files: [{ attachment: avatarFile.path, name: avatarFile.originalname }] });
                    finalAvatarUrl = tempMessage.attachments.first().url;
                } catch (uploadError) { console.error('[Dashboard Add Streamer] Error uploading avatar:', uploadError); throw new Error("Failed to upload custom avatar."); }
            }
            let streamerInfo, profileImageUrl = null;
            if (platform === 'kick') cycleTLS = await initCycleTLS({ timeout: 60000 });
            if (['tiktok', 'youtube', 'trovo'].includes(platform)) browser = await getBrowser();
            if (platform === 'twitch') { const u = await apiChecks.getTwitchUser(username); if (u) { streamerInfo = { puid: u.id, dbUsername: u.login }; profileImageUrl = u.profile_image_url; } }
            else if (platform === 'kick' && cycleTLS) { const u = await apiChecks.getKickUser(cycleTLS, username); if (u) { streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username }; profileImageUrl = u.user.profile_pic; } }
            else if (platform === 'youtube' && browser) { const c = await apiChecks.getYouTubeChannelId(username); if (c) streamerInfo = { puid: c, dbUsername: username }; }
            else { streamerInfo = { puid: username, dbUsername: username }; }
            if (!streamerInfo || !streamerInfo.puid) throw new Error(`User not found on ${platform}.`);
            await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), discord_user_id = VALUES(discord_user_id), profile_image_url = VALUES(profile_image_url)`, [platform, streamerInfo.puid, streamerInfo.dbUsername, discord_user_id || null, profileImageUrl]);
            const [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, streamerInfo.puid]);
            for (const channelId of [...new Set(channelIds)]) {
                 await db.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, override_nickname, override_avatar_url, custom_message) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id=VALUES(announcement_channel_id), override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url), custom_message=VALUES(custom_message)`, [req.params.guildId, streamer.streamer_id, channelId || null, override_nickname || null, finalAvatarUrl, custom_message || null]);
            }
            res.redirect(`/manage/${req.params.guildId}?success=add`);
        } catch (e) {
            console.error("[Dashboard Add Error]", e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Failed to add streamer: ${e.message}`)}`); 
        } finally {
            if (cycleTLS) try { cycleTLS.exit(); } catch (e) {}
            if (browser) await closeBrowser();
            if (avatarFile?.path) fs.unlink(avatarFile.path, (err) => { if (err) console.error("Error deleting temp avatar file:", err); });
        }
    });
    
    // *** THIS ROUTE IS UPDATED to handle kick_username ***
    app.post('/manage/:guildId/edit-subscription', checkAuth, checkGuildAdmin, upload.single('avatar'), async (req, res) => {
        const { subscription_id, discord_user_id, kick_username, announcement_channel_id, override_nickname, custom_message, reset_avatar, override_avatar_url_text } = req.body;
        const avatarFile = req.file;
        try {
            const [[sub]] = await db.execute('SELECT streamer_id FROM subscriptions WHERE subscription_id = ? AND guild_id = ?', [subscription_id, req.params.guildId]);
            if (!sub) throw new Error("Invalid subscription or permission denied.");

            // Update the separate 'streamers' table with both discord ID and the new kick username
            await db.execute('UPDATE streamers SET discord_user_id = ?, kick_username = ? WHERE streamer_id = ?', [discord_user_id || null, kick_username || null, sub.streamer_id]);

            const updates = {};
            let finalAvatarUrl = undefined;
            if (avatarFile) {
                const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                if (!tempUploadChannelId) throw new Error("Avatar upload feature is not configured.");
                const tempChannel = await client.channels.fetch(tempUploadChannelId);
                if (!tempChannel?.isTextBased()) throw new Error("Temporary upload channel is not valid.");
                const tempMessage = await tempChannel.send({ files: [{ attachment: avatarFile.path, name: avatarFile.originalname }] });
                finalAvatarUrl = tempMessage.attachments.first().url;
            } else if (reset_avatar === 'true') {
                finalAvatarUrl = null;
            } else if (override_avatar_url_text !== undefined) {
                const urlText = override_avatar_url_text.trim();
                if (urlText.toLowerCase() === 'reset' || urlText === '') {
                    finalAvatarUrl = null;
                } else if (!/^https?:\/\//.test(urlText)) {
                    return res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent('Invalid avatar URL.')}`);
                } else {
                    finalAvatarUrl = urlText;
                }
            }
            updates.announcement_channel_id = announcement_channel_id || null;
            updates.override_nickname = override_nickname || null;
            updates.custom_message = custom_message || null;
            if (finalAvatarUrl !== undefined) {
                updates.override_avatar_url = finalAvatarUrl;
            }
            const updateFields = Object.keys(updates);
            if (updateFields.length > 0) {
                const setClauses = updateFields.map(key => `${db.escapeId(key)} = ?`).join(', ');
                const values = updateFields.map(key => updates[key]);
                values.push(subscription_id);
                await db.execute(`UPDATE subscriptions SET ${setClauses} WHERE subscription_id = ?`, values);
            }
            res.redirect(`/manage/${req.params.guildId}?success=edit`);
        } catch (e) {
            console.error('Edit Subscription Error:', e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Failed to save settings: ${e.message}`)}`);
        } finally {
            if (avatarFile?.path) fs.unlink(avatarFile.path, (err) => { if (err) console.error("Error deleting temp avatar file:", err); });
        }
    });

    app.post('/manage/:guildId/remove-subscription', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { subscription_id } = req.body;
            if (!subscription_id) { throw new Error('Missing subscription ID.'); }
            await db.execute('DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?', [subscription_id, req.params.guildId]);
            res.redirect(`/manage/${req.params.guildId}?success=remove`);
        } catch (e) {
            console.error('[Dashboard Remove Sub Error]', e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent('Failed to remove subscription.')}`);
        }
    });
    app.post('/manage/:guildId/massadd', checkAuth, checkGuildAdmin, async (req, res) => {
        const { platform, usernames } = req.body;
        let cycleTLS = null, browser = null; 
        try {
            const usernamesArray = [...new Set(usernames.split(/\n|,+/).map(name => name.trim()).filter(Boolean))];
            if (usernamesArray.length === 0) throw new Error("No valid usernames provided.");
            cycleTLS = (platform === 'kick') ? await initCycleTLS({ timeout: 60000 }) : null;
            browser = (['tiktok', 'youtube', 'trovo'].includes(platform)) ? await getBrowser() : null;
            const result = await addStreamerLogic({ client, guildId: req.params.guildId, platform, usernames: usernamesArray, discordUserId: req.user.id, cycleTLS: cycleTLS, browser: browser });
            if (result.error) { throw new Error(result.error); }
            res.redirect(`/manage/${req.params.guildId}?success=massaction&report=${encodeURIComponent(result.summary || 'Mass add completed.')}`);
        } catch(e) { 
            console.error("[Dashboard Mass Add Error]", e); 
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Mass add failed: ${e.message}`)}`); 
        } finally {
            if (cycleTLS) try { cycleTLS.exit() } catch (e) {}
            if (browser) await closeBrowser();
        }
    });
    app.post('/manage/:guildId/addteam', checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamName, channelId } = req.body;
        const guildId = req.params.guildId;
        if (!teamName || !channelId) { return res.redirect(`/manage/${guildId}?error=${encodeURIComponent('Team name and channel are required.')}`); }
        
        let cycleTLS = null;
        let twitchAddedCount = 0;
        let kickAddedCount = 0;

        try {
            const teamMembers = await apiChecks.getTwitchTeamMembers(teamName);
            if (!teamMembers) throw new Error(`Could not find a Twitch Team named '${teamName}'.`);
            if (teamMembers.length === 0) throw new Error(`Twitch Team '${teamName}' has no members.`);
            
            cycleTLS = await initCycleTLS({ timeout: 60000 });

            for (const member of teamMembers) {
                await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), profile_image_url=VALUES(profile_image_url)`, ['twitch', member.user_id, member.user_login, member.profile_image_url || null]);
                const [[twitchStreamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', ['twitch', member.user_id]);
                const [twitchSubResult] = await db.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE streamer_id=VALUES(streamer_id)`, [guildId, twitchStreamer.streamer_id, channelId]);
                if(twitchSubResult.affectedRows === 1) twitchAddedCount++;
                
                try {
                    const kickUser = await apiChecks.getKickUser(cycleTLS, member.user_login);
                    if (kickUser) {
                        await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), profile_image_url=VALUES(profile_image_url)`, ['kick', kickUser.id.toString(), kickUser.user.username, kickUser.user.profile_pic || null]);
                        const [[kickStreamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', ['kick', kickUser.id.toString()]);
                        const [kickSubResult] = await db.execute(`INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)`, [guildId, kickStreamer.streamer_id, channelId]);
                        if(kickSubResult.affectedRows === 1) kickAddedCount++;
                    }
                } catch (kickError) {
                    console.error(`[AddTeam] Error processing Kick cross-reference for '${member.user_login}':`, kickError);
                }
            }
            const report = `${twitchAddedCount} Twitch member(s) and ${kickAddedCount} matching Kick member(s) were processed for team '${teamName}'.`;
            res.redirect(`/manage/${guildId}?success=addteam&report=${encodeURIComponent(report)}`);
        } catch (e) {
            console.error("Dashboard Add Team Error:", e);
            res.redirect(`/manage/${guildId}?error=${encodeURIComponent(`Failed to add team: ${e.message}`)}`);
        } finally {
            if(cycleTLS) try { cycleTLS.exit(); } catch(e) {}
        }
    });
    app.post('/manage/:guildId/subscribe-team', checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamName, channelId, live_role_id } = req.body;
        const guildId = req.params.guildId;
        try {
            if (!teamName || !channelId) throw new Error('Team name and channel ID are required.');
            
            await db.execute(
                `INSERT INTO twitch_teams (guild_id, announcement_channel_id, team_name, live_role_id) 
                 VALUES (?, ?, ?, ?) 
                 ON DUPLICATE KEY UPDATE team_name = VALUES(team_name), live_role_id = VALUES(live_role_id)`, 
                [guildId, channelId, teamName.toLowerCase(), live_role_id || null]
            );

            res.redirect(`/manage/${guildId}?success=teamsubscribed`);
        } catch (e) {
            console.error('[Dashboard Subscribe Team Error]', e);
            res.redirect(`/manage/${guildId}?error=${encodeURIComponent(`Failed to subscribe to team: ${e.message}`)}`);
        }
    });
    app.post('/manage/:guildId/unsubscribe-team', checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamSubscriptionId } = req.body;
        const guildId = req.params.guildId;
        try {
            if (!teamSubscriptionId) throw new Error('Subscription ID is missing.');
            await db.execute('DELETE FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamSubscriptionId, guildId]);
            res.redirect(`/manage/${guildId}?success=teamunsubscribed`);
        } catch (e) {
            console.error('[Dashboard Unsubscribe Team Error]', e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Failed to unsubscribe from team: ${e.message}`)}`);
        }
    });
    app.post('/manage/:guildId/removeteam', checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamSubscriptionId } = req.body; 
        const guildId = req.params.guildId;
        try {
            if (!teamSubscriptionId) throw new Error('Subscription ID is missing.');
            const [[teamSub]] = await db.execute('SELECT * FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamSubscriptionId, guildId]);
            if (!teamSub) throw new Error('Team subscription not found or you do not have permission to remove it.');
            await db.execute('DELETE FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamSubscriptionId, guildId]);
    
            const teamMembers = await apiChecks.getTwitchTeamMembers(teamSub.team_name);
            if (teamMembers && teamMembers.length > 0) {
                const memberUserIds = teamMembers.map(m => m.user_id);
                const placeholders = memberUserIds.map(() => '?').join(',');
                const [streamers] = await db.execute(`SELECT streamer_id FROM streamers WHERE platform = 'twitch' AND platform_user_id IN (${placeholders})`, [...memberUserIds]);
    
                if (streamers.length > 0) {
                    const streamerIdsToRemove = streamers.map(s => s.streamer_id);
                    const subPlaceholders = streamerIdsToRemove.map(() => '?').join(',');
                    
                    const [announcementsToPurge] = await db.execute(
                        `SELECT message_id, channel_id FROM announcements WHERE guild_id = ? AND channel_id = ? AND streamer_id IN (${subPlaceholders})`,
                        [guildId, teamSub.announcement_channel_id, ...streamerIdsToRemove]
                    );
    
                    if (announcementsToPurge.length > 0) {
                        const purgePromises = announcementsToPurge.map(ann => 
                            client.channels.fetch(ann.channel_id)
                                .then(channel => channel?.messages.delete(ann.message_id))
                                .catch(() => {})
                        );
                        await Promise.allSettled(purgePromises);
                    }
                    
                    await db.execute(`DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (${subPlaceholders})`, [guildId, teamSub.announcement_channel_id, ...streamerIdsToRemove]);
                }
            }
            res.redirect(`/manage/${guildId}?success=removeteam`);
        } catch (e) {
            console.error('Dashboard Remove Team Error:', e);
            res.redirect(`/manage/${guildId}?error=${encodeURIComponent(`Failed to remove team members: ${e.message}`)}`);
        }
    });
    app.post('/manage/:guildId/clear', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            await db.execute('DELETE FROM subscriptions WHERE guild_id = ?', [req.params.guildId]);
            res.redirect(`/manage/${req.params.guildId}?success=clear`);
        } catch (e) {
            console.error('[Dashboard Clear Subscriptions Error]', e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent('Failed to clear subscriptions.')}`);
        }
    });
    app.get('/manage/:guildId/export', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const [subscriptions] = await db.execute(`SELECT s.platform, s.username, s.discord_user_id, sub.custom_message, sub.override_nickname, sub.override_avatar_url, sub.announcement_channel_id FROM streamers s JOIN subscriptions sub ON s.streamer_id = s.streamer_id WHERE sub.guild_id = ?`, [req.params.guildId]);
            if (subscriptions.length === 0) { return res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent('No streamers to export.')}`); }
            const csv = Papa.unparse(subscriptions, { header: true });
            res.header('Content-Type', 'text/csv');
            res.attachment(`streamers_export_${req.params.guildId}.csv`);
            res.send(csv);
        } catch (e) { console.error("[Dashboard Export Error]", e); res.status(500).send("Error generating CSV file."); }
    });
    app.post('/manage/:guildId/import', checkAuth, checkGuildAdmin, upload.single('csvfile'), async (req, res) => {
        let tempFilePath = null;
        let browser = null; 
        try {
            if (!req.file) throw new Error("No CSV file was uploaded.");
            tempFilePath = path.resolve(req.file.path);
            const csvFileContent = await fs.promises.readFile(tempFilePath, 'utf8');
            const { data, errors } = Papa.parse(csvFileContent, { header: true, skipEmptyLines: true });
            if (errors.length > 0) { throw new Error(`CSV parsing errors: ${errors.map(e => e.message).join(', ')}`); }
            browser = await getBrowser();
            const result = await importCsvLogic({ client, guildId: req.params.guildId, csvData: data, userId: req.user.id, browser: browser });
            if (result.error) { throw new Error(result.error); }
            res.redirect(`/manage/${req.params.guildId}?success=import&report=${encodeURIComponent(result.summary || 'CSV import completed.')}`);
        } catch (e) {
            console.error("Dashboard import failed:", e);
            res.redirect(`/manage/${req.params.guildId}?error=${encodeURIComponent(`Import failed. Please try again or contact support.`)}`);
        } finally {
            if (browser) await closeBrowser(); 
            if (tempFilePath && fs.existsSync(tempFilePath)) { fs.unlink(tempFilePath, (err) => { if (err) console.error("Error deleting temp CSV file:", err); }); }
        }
    });
    app.post('/manage/:guildId/import-team', checkAuth, checkGuildAdmin, upload.single('csvfile'), async (req, res) => {
        const { channelId: targetChannelId } = req.body;
        const guildId = req.params.guildId;
        const file = req.file;
        if (!file) return res.redirect(`/manage/${guildId}?error=${encodeURIComponent('No CSV file was uploaded.')}`);
        if (!targetChannelId) return res.redirect(`/manage/${guildId}?error=${encodeURIComponent('You must select a channel to sync.')}`);
        const added = [], updated = [], failed = [], removed = [];
        let cycleTLS = null, browser = null;
        try {
            const fileContent = fs.readFileSync(file.path, 'utf8');
            const { data: rows } = Papa.parse(fileContent, { header: true, skipEmptyLines: true });
            if (!rows.length) throw new Error('CSV file is empty or invalid.');
            const [existingSubsInChannel] = await db.execute('SELECT s.streamer_id, s.username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ?', [guildId, targetChannelId]);
            const dbStreamerMap = new Map(existingSubsInChannel.map(sub => [sub.streamer_id, sub.username]));
            const csvStreamerIds = new Set();
            if (rows.some(r => r.platform === 'kick')) cycleTLS = await initCycleTLS();
            if (rows.some(r => ['tiktok', 'youtube', 'trovo'].includes(r.platform))) browser = await getBrowser();
            for (const row of rows) {
                const { platform, username, discord_user_id, custom_message, override_nickname, override_avatar_url } = row;
                if (!platform || !username) { failed.push(`(Skipped: missing platform/username)`); continue; }
                const correctedDiscordId = /^[0-9]+$/.test(discord_user_id) ? discord_user_id : null;
                try {
                    let streamerInfo = null;
                    const [[existingStreamer]] = await db.execute('SELECT streamer_id, platform_user_id FROM streamers WHERE platform = ? AND LOWER(username) = LOWER(?)', [platform, username]);
                    if (existingStreamer) {
                        streamerInfo = { id: existingStreamer.streamer_id, puid: existingStreamer.platform_user_id, dbUsername: username };
                    } else {
                        let apiResult;
                        if (platform === 'twitch') { apiResult = await apiChecks.getTwitchUser(username); if(apiResult) streamerInfo = { puid: apiResult.id, dbUsername: apiResult.login }; } 
                        else if (platform === 'kick' && cycleTLS) { apiResult = await apiChecks.getKickUser(cycleTLS, username); if(apiResult) streamerInfo = { puid: apiResult.id.toString(), dbUsername: apiResult.user.username }; }
                        else if (platform === 'youtube') { apiResult = await apiChecks.getYouTubeChannelId(username); if(apiResult) streamerInfo = { puid: apiResult, dbUsername: username }; }
                        else if (['tiktok', 'trovo'].includes(platform)) { streamerInfo = { puid: username, dbUsername: username }; }
                        if (!streamerInfo) { failed.push(`${username} (API Not Found)`); continue; }
                    }
                    const [result] = await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), discord_user_id=VALUES(discord_user_id)`, [platform, streamerInfo.puid, streamerInfo.dbUsername, correctedDiscordId]);
                    const streamerId = result.insertId || streamerInfo.id;
                    csvStreamerIds.add(streamerId);
                    const [subResult] = await db.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, custom_message, override_nickname, override_avatar_url) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE custom_message=VALUES(custom_message), override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url)`, [guildId, streamerId, targetChannelId, custom_message || null, override_nickname || null, override_avatar_url || null]);
                    subResult.affectedRows > 1 ? updated.push(username) : added.push(username);
                } catch (err) { console.error(`Team CSV Row Error for ${username}:`, err); failed.push(`${username} (Error)`); }
            }
            const idsToRemove = [];
            for (const [streamerId, streamerUsername] of dbStreamerMap.entries()) {
                if (!csvStreamerIds.has(streamerId)) { idsToRemove.push(streamerId); removed.push(streamerUsername); }
            }
            if (idsToRemove.length > 0) {
                const placeholders = idsToRemove.map(() => '?').join(',');
                await db.execute(`DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (${placeholders})`, [guildId, targetChannelId, ...idsToRemove]);
            }
            const summary = `Added: ${added.length}, Updated: ${updated.length}, Removed: ${removed.length}, Failed: ${failed.length}.`;
            res.redirect(`/manage/${guildId}?success=teamsync&report=${encodeURIComponent(summary)}`);
        } catch (e) {
            console.error("Dashboard team import failed:", e);
            res.redirect(`/manage/${guildId}?error=${encodeURIComponent(`Team sync failed: ${e.message}`)}`);
        } finally {
            if (cycleTLS) try { cycleTLS.exit(); } catch(e){} 
            if (browser) await closeBrowser();
            if (file?.path) fs.unlink(file.path, (err) => { if (err) console.error("Error deleting temp CSV file:", err); });
        }
    });
    
    app.use((req, res) => {
        res.status(404).render('error', { user: req.user, error: 'Page Not Found' });
    });

    app.listen(port, () => console.log(`[Dashboard] Web dashboard listening on port ${port}`));
}

module.exports = { start };