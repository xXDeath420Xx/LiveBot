const express = require('express');
const session = require('express-session');
const passport = require('passport');
require('./passport-setup');
const path = require('path');
const fs = require('fs');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks.js');
const multer = require('multer');
const { PermissionsBitField, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Papa = require('papaparse');
const { syncTwitchTeam } = require('../core/team-sync');
const logger = require('../utils/logger');
const { invalidateCommandCache } = require('../core/custom-command-handler');
const { createBackup, restoreBackup, deleteBackup } = require('../core/backup-manager');
const { endGiveaway } = require('../core/giveaway-manager');
const { endPoll } = require('../core/poll-manager');
const RedisStore = require('connect-redis')(session);
const Redis = require('ioredis');

// Setup multer for file uploads
const upload = multer({ dest: 'uploads/' });

async function getManagePageData(guildId, botGuild) {
    try {
        const results = await Promise.all([
            db.execute(`SELECT sub.*, s.platform, s.username, s.discord_user_id, s.streamer_id, s.platform_user_id, cs.channel_id as announcement_channel_override FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id LEFT JOIN channel_settings cs ON sub.announcement_channel_id = cs.channel_id AND sub.guild_id = cs.guild_id WHERE sub.guild_id = ? ORDER BY s.username, sub.announcement_channel_id`, [guildId]).catch(e => { logger.error('Failed to get subscriptions', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM guilds WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get guilds', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM channel_settings WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get channel_settings', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            (botGuild && botGuild.roles ? botGuild.roles.fetch().catch(e => { logger.error('Failed to fetch roles', { guildId, category: 'system', error: e.stack }); return new Map(); }) : Promise.resolve(new Map())),
            (botGuild && botGuild.channels ? botGuild.channels.fetch().catch(e => { logger.error('Failed to fetch channels', { guildId, category: 'system', error: e.stack }); return new Map(); }) : Promise.resolve(new Map())),
            db.execute('SELECT * FROM twitch_teams WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get twitch_teams', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM automod_rules WHERE guild_id = ? ORDER BY id', [guildId]).catch(e => { logger.error('Failed to get automod_rules', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM automod_heat_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get automod_heat_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM antinuke_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get antinuke_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT id, snapshot_name, created_at FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC', [guildId]).catch(e => { logger.error('Failed to get server_backups', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM join_gate_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get join_gate_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM welcome_settings WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get welcome_settings', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM custom_commands WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get custom_commands', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM ticket_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get ticket_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM auto_publisher_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get auto_publisher_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM autoroles_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get autoroles_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM log_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get log_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM reddit_feeds WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get reddit_feeds', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM youtube_feeds WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get youtube_feeds', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM twitter_feeds WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get twitter_feeds', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM moderation_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get moderation_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM infractions WHERE guild_id = ? ORDER BY created_at DESC LIMIT 10', [guildId]).catch(e => { logger.error('Failed to get infractions', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM escalation_rules WHERE guild_id = ? ORDER BY infraction_count ASC', [guildId]).catch(e => { logger.error('Failed to get escalation_rules', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM role_rewards WHERE guild_id = ? ORDER BY level ASC', [guildId]).catch(e => { logger.error('Failed to get role_rewards', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM temp_channel_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get temp_channel_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM server_stats WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get server_stats', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM anti_raid_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get anti_raid_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute(`SELECT id, tag_name, tag_content, creator_id FROM tags WHERE guild_id = ? ORDER BY tag_name ASC`, [guildId]).catch(e => { logger.error('Failed to get tags', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM starboard_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get starboard_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM reaction_role_panels WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get reaction_role_panels', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM action_logs WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 50', [guildId]).catch(e => { logger.error('Failed to get action_logs', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM giveaways WHERE guild_id = ? ORDER BY ends_at DESC', [guildId]).catch(e => { logger.error('Failed to get giveaways', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM polls WHERE guild_id = ? ORDER BY ends_at DESC', [guildId]).catch(e => { logger.error('Failed to get polls', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM music_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get music_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM twitch_schedule_sync_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get twitch_schedule_sync_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM quarantine_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get quarantine_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM record_config WHERE guild_id = ?', [guildId]).catch(e => { logger.error('Failed to get record_config', { guildId, category: 'system', error: e.stack }); return [[]]; }),
            db.execute('SELECT * FROM reminders WHERE guild_id = ? ORDER BY remind_at ASC', [guildId]).catch(e => { logger.error('Failed to get reminders', { guildId, category: 'system', error: e.stack }); return [[]]; })
        ]);

        const [
            [allSubscriptions], [guildSettingsResult], [channelSettingsResult],
            allRolesCollection, allChannelsCollection, [rawTeamSubscriptions],
            [automodRules], [heatConfigResult], [antiNukeConfigResult],
            [backups], [joinGateConfigResult], [welcomeSettingsResult], [customCommands],
            [ticketConfigResult], [autoPublisherConfigResult], [autorolesConfigResult],
            [logConfigResult], [redditFeeds], [youtubeFeeds], [twitterFeeds],
            [moderationConfigResult], [recentInfractions], [escalationRules],
            [roleRewards], [tempChannelConfigResult], [serverStats],
            [antiRaidConfigResult], [tags], [starboardConfigResult],
            [reactionRolePanels], [actionLogs], [giveaways], [polls], [musicConfigResult], [twitchScheduleSyncs], [quarantineConfigResult], [recordConfigResult], [reminders]
        ] = results;

        for (const panel of reactionRolePanels) {
            const [mappings] = await db.execute('SELECT * FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);
            panel.mappings = mappings || [];
        }

        const consolidatedStreamers = {};
        allSubscriptions.forEach(sub => {
            const key = sub.streamer_id;
            if (!consolidatedStreamers[key]) {
                consolidatedStreamers[key] = { id: sub.streamer_id, name: sub.username, discord_user_id: sub.discord_user_id, platforms: [], subscriptions: [] };
            }
            consolidatedStreamers[key].subscriptions.push(sub);
            if (!consolidatedStreamers[key].platforms.some(p => p.platform === sub.platform)) {
                consolidatedStreamers[key].platforms.push({ platform: sub.platform, username: sub.username, profile_image_url: sub.profile_image_url });
            }
        });

        const teamSubscriptions = rawTeamSubscriptions.map(t => {
            const role = allRolesCollection.get(t.live_role_id);
            const channel = allChannelsCollection.get(t.announcement_channel_id);
            return { ...t, live_role_name: role ? role.name : 'Not Set', announcement_channel_name: channel ? channel.name : 'Not Set' };
        });

        const heatConfig = heatConfigResult[0];
        const antiNukeConfig = antiNukeConfigResult[0];
        const musicConfig = musicConfigResult[0];
        const quarantineConfig = quarantineConfigResult[0];
        const recordConfig = recordConfigResult[0];

        const dataToReturn = {
            totalSubscriptions: allSubscriptions.length,
            consolidatedStreamers: Object.values(consolidatedStreamers),
            settings: guildSettingsResult[0] || {},
            channelSettings: channelSettingsResult,
            roles: Array.from(allRolesCollection.values()).filter(r => !r.managed && r.name !== '@everyone').map(r => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name)),
            channels: Array.from(allChannelsCollection.values()).filter(c => c.type === 0 || c.type === 5).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
            categories: Array.from(allChannelsCollection.values()).filter(c => c.type === 4).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
            voiceChannels: Array.from(allChannelsCollection.values()).filter(c => c.type === 2).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
            teamSubscriptions,
            automodRules,
            heatConfig: heatConfig ? { ...heatConfig, heat_values: JSON.parse(heatConfig.heat_values || '{}'), action_thresholds: JSON.parse(heatConfig.action_thresholds || '[]') } : null,
            antiNukeConfig: antiNukeConfig ? { ...antiNukeConfig, action_thresholds: JSON.parse(antiNukeConfig.action_thresholds || '{}')} : null,
            backups,
            joinGateConfig: joinGateConfigResult[0] || null,
            welcomeSettings: welcomeSettingsResult[0] || null,
            customCommands,
            ticketConfig: ticketConfigResult[0] || null,
            autoPublisherConfig: autoPublisherConfigResult[0] || null,
            autorolesConfig: autorolesConfigResult[0] || null,
            logConfig: logConfigResult[0] || null,
            redditFeeds: redditFeeds || [],
            youtubeFeeds: youtubeFeeds || [],
            twitterFeeds: twitterFeeds || [],
            moderationConfig: moderationConfigResult[0] || null,
            recentInfractions: recentInfractions || [],
            escalationRules: escalationRules || [],
            roleRewards: roleRewards || [],
            tempChannelConfig: tempChannelConfigResult[0] || null,
            serverStats: serverStats || [],
            antiRaidConfig: antiRaidConfigResult[0] || null,
            tags: tags || [],
            starboardConfig: starboardConfigResult[0] || null,
            reactionRolePanels: reactionRolePanels || [],
            actionLogs: actionLogs || [],
            giveaways: giveaways || [],
            polls: polls || [],
            musicConfig: musicConfig ? { ...musicConfig, text_channel_ids: JSON.parse(musicConfig.text_channel_ids || '[]'), voice_channel_ids: JSON.parse(musicConfig.voice_channel_ids || '[]') } : null,
            twitchScheduleSyncs: twitchScheduleSyncs || [],
            quarantineConfig: quarantineConfig || null,
            recordConfig: recordConfig ? { ...recordConfig, allowed_role_ids: JSON.parse(recordConfig.allowed_role_ids || '[]') } : null,
            reminders: reminders || []
        };
        return dataToReturn;
    } catch (error) {
        logger.error(`[CRITICAL] Error in getManagePageData for guild ${guildId}:`, { guildId, category: 'system', error: error.stack });
        throw error;
    }
}

// List of tables to truncate for a full database reset
const TABLES_TO_RESET = [
    'subscriptions',
    'streamers',
    'guilds',
    'channel_settings',
    'twitch_teams',
    'automod_rules',
    'automod_heat_config',
    'antinuke_config',
    'server_backups',
    'join_gate_config',
    'welcome_settings',
    'custom_commands',
    'ticket_config',
    'auto_publisher_config',
    'autoroles_config',
    'log_config',
    'reddit_feeds',
    'youtube_feeds',
    'twitter_feeds',
    'moderation_config',
    'infractions',
    'escalation_rules',
    'role_rewards',
    'temp_channel_config',
    'server_stats',
    'anti_raid_config',
    'tags',
    'starboard_config',
    'reaction_role_panels',
    'reaction_role_mappings',
    'action_logs',
    'giveaways',
    'polls',
    'music_config',
    'twitch_schedule_sync_config',
    'quarantine_config',
    'record_config',
    'reminders',
    'announcements',
    'stream_sessions',
    'global_stats',
    'user_preferences'
];

async function resetDatabase() {
    logger.warn('[ADMIN] Initiating full database reset. All bot data will be cleared.');
    try {
        await db.execute('SET FOREIGN_KEY_CHECKS = 0'); // Disable foreign key checks
        for (const table of TABLES_TO_RESET) {
            await db.execute(`TRUNCATE TABLE ${table}`);
            logger.info(`[ADMIN] Truncated table: ${table}`);
        }
        await db.execute('SET FOREIGN_KEY_CHECKS = 1'); // Re-enable foreign key checks
        logger.info('[ADMIN] Database reset complete.');
        return { success: true, message: 'Database reset successfully.' };
    } catch (error) {
        logger.error('[ADMIN] Error during database reset:', { category: 'system', error: error.stack });
        return { success: false, error: 'Failed to reset database.' };
    }
}

function start(botClient) {
    let client = botClient;
    const app = express();
    const port = process.env.DASHBOARD_PORT || 3001;

    app.use(express.static(path.join(__dirname, 'public')));

    const redisClient = new Redis({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      password: process.env.REDIS_PASSWORD
    });

    redisClient.on('error', (err) => {
        logger.error('[Cache] Redis connection error:', { category: 'system', error: err.stack });
    });

    redisClient.on('connect', () => {
        logger.info('[Cache] Connected to Redis.', { category: 'system' });
    });

    const redisStore = new RedisStore({
        client: redisClient,
        prefix: "livebot:session:",
    });

    app.use(
        session({
            store: redisStore,
            secret: process.env.SESSION_SECRET || 'keyboard cat',
            resave: false,
            saveUninitialized: false, // Set to false as we save manually on login
            cookie: {
                secure: false, // Set to true if using HTTPS
                httpOnly: true,
                maxAge: 1000 * 60 * 60 * 24 // 24 hours
            }
        })
    );

    app.use(passport.initialize());
    app.use(passport.session());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    const checkAuth = (req, res, next) => req.isAuthenticated() ? next() : res.redirect('/login');
    
    const checkGuildAdmin = async (req, res, next) => {
        if (!req.user || !req.user.guilds) return res.redirect('/login');
        const guild = req.user.guilds.find(g => g.id === req.params.guildId);
        if (guild && new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(req.params.guildId)) {
            req.guildObject = await client.guilds.fetch(req.params.guildId);
            return next();
        }
        res.status(403).render('error', { user: req.user, error: 'You do not have permissions for this server or the bot is not in it.'});
    };

    const checkSuperAdmin = (req, res, next) => {
        // Add extensive logging to debug this exact issue
        logger.info(`[checkSuperAdmin] Checking user: ${req.user ? req.user.username : 'No user'}. IsSuperAdmin flag: ${req.user ? req.user.isSuperAdmin : 'N/A'}`);
        if (req.isAuthenticated() && req.user && req.user.isSuperAdmin) {
            return next();
        }
        res.status(403).render('error', { user: req.user, error: 'You do not have super admin privileges.' });
    };

    app.get('/', (req, res) => {
        res.render('landing', { 
            user: req.user || null,
            client_id: process.env.DASHBOARD_CLIENT_ID
        });
    });

    app.get('/login', passport.authenticate('discord', { scope: ['identify', 'guilds'] }));

    app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
        res.redirect('/dashboard'); // Redirect to dashboard after successful login
    });

    app.get('/logout', (req, res, next) => {
        req.logout(function(err) {
            if (err) { return next(err); }
            res.redirect('/');
        });
    });

    app.get('/dashboard', checkAuth, (req, res) => {
        const manageableGuilds = req.user.guilds.filter(g => 
            new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && 
            client.guilds.cache.has(g.id)
        );
        res.render('dashboard', { user: req.user, manageableGuilds });
    });

    app.get('/streamer-dashboard', checkAuth, (req, res) => {
        res.render('streamer-dashboard', { user: req.user });
    });

    app.get('/servers', checkAuth, (req, res) => {
        const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(g.id));
        res.render('servers', { user: req.user, guilds: manageableGuilds });
    });

    app.get('/manage/:guildId/:page?', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const page = req.params.page || 'streamers';
            const data = await getManagePageData(req.params.guildId, req.guildObject);

            const validPages = [
                'streamers', 'teams', 'appearance', 'welcome', 'utilities', 'moderation',
                'automod', 'security', 'logging', 'feeds', 'custom-commands', 'leveling',
                'backups', 'giveaways', 'polls', 'music', 'twitch-schedules', 'record',
                'tickets', 'starboard', 'reaction-roles'
            ];

            if (!validPages.includes(page)) {
                return res.status(404).render('error', { user: req.user, error: 'Page Not Found' });
            }

            res.render('manage', {
                user: req.user,
                guild: req.guildObject,
                ...data,
                page: page,
                userPreferences: {}
            });
        } catch (error) {
            logger.error(`[CRITICAL] Error in /manage/:guildId/:page route:`, { guildId: req.params.guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Critical error loading server data.' });
        }
    });

    app.get('/super-admin', checkAuth, checkSuperAdmin, (req, res) => {
        res.render('super-admin', { user: req.user });
    });

    app.get('/api/guild-channel-list/:guildId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const channels = await req.guildObject.channels.fetch();
            const textChannels = channels.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
            res.json(textChannels.map(c => ({ id: c.id, name: c.name })));
        } catch (error) {
            logger.error(`Error fetching channel list for guild ${req.params.guildId}:`, { guildId: req.params.guildId, category: 'http', error: error.stack });
            res.status(500).json({ error: 'Failed to fetch channel list.' });
        }
    });

    app.post('/manage/:guildId/add-streamer', checkAuth, checkGuildAdmin, async (req, res) => {
        const { platform, username, discord_user_id, announcement_channel_id } = req.body;
        const { guildId } = req.params;

        try {
            let platformUserId, platformUsername, profileImageUrl;

            switch (platform) {
                case 'twitch':
                    const twitchUser = await apiChecks.getTwitchUser(username);
                    if (!twitchUser) return res.status(400).render('error', { user: req.user, error: `Twitch user "${username}" not found.` });
                    platformUserId = twitchUser.id; platformUsername = twitchUser.display_name; profileImageUrl = twitchUser.profile_image_url;
                    break;
                case 'youtube':
                    const youtubeChannel = await apiChecks.getYouTubeChannelId(username);
                    if (!youtubeChannel) return res.status(400).render('error', { user: req.user, error: `YouTube channel "${username}" not found.` });
                    platformUserId = youtubeChannel.channelId; platformUsername = youtubeChannel.channelName || username; profileImageUrl = null;
                    break;
                case 'kick':
                    const kickUser = await apiChecks.getKickUser(username);
                    if (!kickUser || !kickUser.user) return res.status(400).render('error', { user: req.user, error: `Kick user "${username}" not found.` });
                    platformUserId = kickUser.user.id.toString(); platformUsername = kickUser.user.username; profileImageUrl = kickUser.user.profile_pic;
                    break;
                default: return res.status(400).render('error', { user: req.user, error: 'Invalid platform selected.' });
            }

            let [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, platformUserId]);
            let streamerId = streamer ? streamer.streamer_id : (await db.execute('INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?)', [platform, platformUserId, platformUsername, discord_user_id || null, profileImageUrl]))[0].insertId;

            const channelIds = Array.isArray(announcement_channel_id) ? announcement_channel_id : [announcement_channel_id];
            for (const channelId of channelIds) {
                try {
                    await db.execute('INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)', [guildId, streamerId, channelId || null]);
                } catch (error) {
                    if (error.code !== 'ER_DUP_ENTRY') throw error;
                    logger.warn(`Attempted to add a duplicate subscription for streamer ${streamerId} on channel ${channelId}. Skipping.`, { guildId, category: 'database' });
                }
            }
            res.redirect(`/manage/${guildId}/streamers`);
        } catch (error) {
            logger.error(`Error adding streamer.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to add streamer.' });
        }
    });

    app.post('/manage/:guildId/delete-streamer', checkAuth, checkGuildAdmin, async (req, res) => {
        const { streamerId } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id = ?', [guildId, streamerId]);
            res.redirect(`/manage/${guildId}/streamers`);
        } catch (error) {
            logger.error(`Error deleting streamer ${streamerId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to delete streamer.' });
        }
    });

    app.post('/manage/:guildId/add-team', checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamName, announcementChannelId, liveRoleId } = req.body;
        const { guildId } = req.params;
        try {
            if (!teamName) return res.status(400).render('error', { user: req.user, error: 'Team name is required.' });
            const [[existingTeam]] = await db.execute('SELECT id FROM twitch_teams WHERE guild_id = ? AND team_name = ?', [guildId, teamName]);
            if (existingTeam) return res.status(400).render('error', { user: req.user, error: `A team with the name "${teamName}" already exists.` });

            const [result] = await db.execute('INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id, live_role_id) VALUES (?, ?, ?, ?)', [guildId, teamName.toLowerCase(), announcementChannelId || null, liveRoleId || null]);
            const teamId = result.insertId;
            if (teamId) syncTwitchTeam(teamId, db).catch(error => logger.error(`Background team sync failed for team ${teamId}.`, { guildId, category: 'team-sync', error: error.stack }));
            res.redirect(`/manage/${guildId}/teams`);
        } catch (error) {
            logger.error(`Error adding Twitch team.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to add Twitch team.' });
        }
    });

    app.post('/manage/:guildId/update-team', checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamSubscriptionId, channelId, liveRoleId, webhookName, webhookAvatarUrl } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute(`UPDATE twitch_teams SET announcement_channel_id = ?, live_role_id = ?, webhook_name = ?, webhook_avatar_url = ? WHERE id = ? AND guild_id = ?`, [channelId || null, liveRoleId || null, webhookName || null, webhookAvatarUrl || null, teamSubscriptionId, guildId]);
            res.redirect(`/manage/${guildId}/teams`);
        } catch (error) {
            logger.error(`Error updating team ${teamSubscriptionId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update team settings.' });
        }
    });

    app.post('/manage/:guildId/delete-team', checkAuth, checkGuildAdmin, async (req, res) => {
        const { teamId } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('UPDATE subscriptions SET team_subscription_id = NULL WHERE team_subscription_id = ? AND guild_id = ?', [teamId, guildId]);
            await db.execute('DELETE FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamId, guildId]);
            res.redirect(`/manage/${guildId}/teams`);
        } catch (error) {
            logger.error(`Error deleting team ${teamId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to delete team.' });
        }
    });

    app.post('/manage/:guildId/update-starboard', checkAuth, checkGuildAdmin, async (req, res) => {
        const { channel_id, star_threshold } = req.body;
        const { guildId } = req.params;
        try {
            if (!channel_id) {
                await db.execute('DELETE FROM starboard_config WHERE guild_id = ?', [guildId]);
            } else {
                await db.execute('INSERT INTO starboard_config (guild_id, channel_id, star_threshold) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), star_threshold = VALUES(star_threshold)', [guildId, channel_id, star_threshold || 3]);
            }
            res.redirect(`/manage/${guildId}/starboard`);
        } catch (error) {
            logger.error('Error updating starboard.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update starboard settings.' });
        }
    });

    app.post('/manage/:guildId/update-tickets', checkAuth, checkGuildAdmin, async (req, res) => {
        const { panel_channel_id, ticket_category_id, support_role_id } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute(`INSERT INTO ticket_config (guild_id, panel_channel_id, ticket_category_id, support_role_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE panel_channel_id = VALUES(panel_channel_id), ticket_category_id = VALUES(ticket_category_id), support_role_id = VALUES(support_role_id)`, [guildId, panel_channel_id || null, ticket_category_id || null, support_role_id || null]);
            res.redirect(`/manage/${guildId}/tickets`);
        } catch (error) {
            logger.error('Error updating ticket settings.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update ticket settings.' });
        }
    });

    app.post('/manage/:guildId/create-ticket-panel', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        try {
            const [[config]] = await db.execute('SELECT panel_channel_id FROM ticket_config WHERE guild_id = ?', [guildId]);
            if (!config || !config.panel_channel_id) return res.status(400).render('error', { user: req.user, error: 'Ticket panel channel is not configured.' });
            const channel = await client.channels.fetch(config.panel_channel_id).catch(() => null);
            if (!channel) return res.status(400).render('error', { user: req.user, error: 'Ticket panel channel not found.' });

            const embed = new EmbedBuilder().setTitle('Create a Support Ticket').setDescription('Click the button below to create a private ticket and get support from the staff team.').setColor('#5865F2');
            const button = new ButtonBuilder().setCustomId('create_ticket').setLabel('Create Ticket').setStyle(ButtonStyle.Primary);
            const row = new ActionRowBuilder().addComponents(button);

            await channel.send({ embeds: [embed], components: [row] });
            res.redirect(`/manage/${guildId}/tickets`);
        } catch (error) {
            logger.error(`Error creating ticket panel.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to create ticket panel.' });
        }
    });

    app.post('/manage/:guildId/update-antiraid', checkAuth, checkGuildAdmin, async (req, res) => {
        const { join_limit, time_period_seconds, action, is_enabled } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('INSERT INTO anti_raid_config (guild_id, join_limit, time_period_seconds, action, is_enabled) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE join_limit = VALUES(join_limit), time_period_seconds = VALUES(time_period_seconds), action = VALUES(action), is_enabled = VALUES(is_enabled)', [guildId, join_limit, time_period_seconds, action, is_enabled === 'on' ? 1 : 0]);
            res.redirect(`/manage/${guildId}/security`);
        } catch (error) {
            logger.error('Error updating anti-raid settings.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update anti-raid settings.' });
        }
    });

    app.post('/manage/:guildId/update-security', checkAuth, checkGuildAdmin, async (req, res) => {
        const { is_enabled, action, action_duration_minutes, min_account_age_days, block_default_avatar, verification_enabled, verification_role_id, verification_method } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute(`INSERT INTO join_gate_config (guild_id, is_enabled, action, action_duration_minutes, min_account_age_days, block_default_avatar, verification_enabled, verification_role_id, verification_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), action = VALUES(action), action_duration_minutes = VALUES(action_duration_minutes), min_account_age_days = VALUES(min_account_age_days), block_default_avatar = VALUES(block_default_avatar), verification_enabled = VALUES(verification_enabled), verification_role_id = VALUES(verification_role_id), verification_method = VALUES(verification_method)`, [guildId, is_enabled === 'on' ? 1 : 0, action, action_duration_minutes || null, min_account_age_days || null, block_default_avatar === 'on' ? 1 : 0, verification_enabled === 'on' ? 1 : 0, verification_role_id || null, verification_method || 'none']);
            res.redirect(`/manage/${guildId}/security`);
        } catch (error) {
            logger.error('Error updating security settings.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update security settings.' });
        }
    });

    app.post('/manage/:guildId/update-welcome', checkAuth, checkGuildAdmin, async (req, res) => {
        const { channel_id, message, card_enabled, card_background_url, card_title_text, card_subtitle_text, card_title_color, card_username_color, card_subtitle_color, goodbye_enabled, goodbye_channel_id, goodbye_message } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute(`INSERT INTO welcome_settings (guild_id, channel_id, message, card_enabled, card_background_url, card_title_text, card_subtitle_text, card_title_color, card_username_color, card_subtitle_color, goodbye_enabled, goodbye_channel_id, goodbye_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id), message=VALUES(message), card_enabled=VALUES(card_enabled), card_background_url=VALUES(card_background_url), card_title_text=VALUES(card_title_text), card_subtitle_text=VALUES(card_subtitle_text), card_title_color=VALUES(card_title_color), card_username_color=VALUES(card_username_color), card_subtitle_color=VALUES(card_subtitle_color), goodbye_enabled=VALUES(goodbye_enabled), goodbye_channel_id=VALUES(goodbye_channel_id), goodbye_message=VALUES(goodbye_message)`, [guildId, channel_id || null, message || null, card_enabled === 'on' ? 1 : 0, card_background_url || null, card_title_text || null, card_subtitle_text || null, card_title_color || null, card_username_color || null, card_subtitle_color || null, goodbye_enabled === 'on' ? 1 : 0, goodbye_channel_id || null, goodbye_message || null]);
            res.redirect(`/manage/${guildId}/welcome`);
        } catch (error) {
            logger.error(`Error updating welcome settings.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update welcome settings.' });
        }
    });

    app.post('/manage/:guildId/update-autopublisher', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        try {
            const { is_enabled } = req.body;
            await db.execute('INSERT INTO auto_publisher_config (guild_id, is_enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)', [guildId, is_enabled === 'on' ? 1 : 0]);
            res.redirect(`/manage/${guildId}/utilities`);
        } catch (error) {
            logger.error(`Error updating autopublisher.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update autopublisher settings.' });
        }
    });

    app.post('/manage/:guildId/update-afk-status', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        try {
            const { afk_enabled } = req.body;
            await db.execute(`UPDATE guilds SET afk_enabled = ? WHERE guild_id = ?`, [afk_enabled === 'on' ? 1 : 0, guildId]);
            res.redirect(`/manage/${guildId}/utilities`);
        } catch (error) {
            logger.error(`Error updating afk status.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update AFK status.' });
        }
    });

    app.post('/manage/:guildId/update-autoroles', checkAuth, checkGuildAdmin, async (req, res) => {
        const { is_enabled, roles_to_assign } = req.body;
        const { guildId } = req.params;
        try {
            const roles = roles_to_assign ? (Array.isArray(roles_to_assign) ? roles_to_assign : [roles_to_assign]) : [];
            await db.execute('INSERT INTO autoroles_config (guild_id, is_enabled, roles_to_assign) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), roles_to_assign = VALUES(roles_to_assign)', [guildId, is_enabled === 'on' ? 1 : 0, JSON.stringify(roles)]);
            res.redirect(`/manage/${guildId}/utilities`);
        } catch (error) {
            logger.error(`Error updating autoroles.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update autoroles settings.' });
        }
    });

    app.post('/manage/:guildId/update-stickyroles', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        try {
            const { sticky_roles_enabled } = req.body;
            await db.execute(`UPDATE guilds SET sticky_roles_enabled = ? WHERE guild_id = ?`, [sticky_roles_enabled === 'on' ? 1 : 0, guildId]);
            res.redirect(`/manage/${guildId}/utilities`);
        } catch (error) {
            logger.error(`Error updating stickyroles.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update sticky roles settings.' });
        }
    });

    app.post('/manage/:guildId/update-logging', checkAuth, checkGuildAdmin, async (req, res) => {
        const { log_channel_id, enabled_logs, log_categories } = req.body;
        const { guildId } = req.params;
        try {
            const enabledLogs = enabled_logs ? (Array.isArray(enabled_logs) ? enabled_logs : [enabled_logs]) : [];
            // Safely parse log_categories
            let parsedLogCategories = {};
            if (log_categories && typeof log_categories === 'string') {
                try {
                    parsedLogCategories = JSON.parse(log_categories);
                } catch (e) {
                    logger.error('Failed to parse log_categories JSON string:', { guildId, category: 'http', error: e.stack });
                    // Keep parsedLogCategories as an empty object
                }
            }

            await db.execute('INSERT INTO log_config (guild_id, log_channel_id, enabled_logs, log_categories) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), enabled_logs = VALUES(enabled_logs), log_categories = VALUES(log_categories)', [guildId, log_channel_id || null, JSON.stringify(enabledLogs), JSON.stringify(parsedLogCategories)]);
            res.redirect(`/manage/${guildId}/logging`);
        } catch (error) {
            logger.error(`Error updating logging.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update logging settings.' });
        }
    });

    app.post('/manage/:guildId/add-reddit-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const { subreddit, channel_id } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('INSERT INTO reddit_feeds (guild_id, subreddit, channel_id) VALUES (?, ?, ?)', [guildId, subreddit.toLowerCase(), channel_id]);
        } catch (e) {
            if (e.code !== 'ER_DUP_ENTRY') {
                logger.error('Error adding reddit feed.', { guildId, category: 'http', error: e.stack });
                return res.status(500).render('error', { user: req.user, error: 'Failed to add Reddit feed.' });
            }
        }
        res.redirect(`/manage/${guildId}/feeds`);
    });

    app.post('/manage/:guildId/remove-reddit-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const { feedId } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('DELETE FROM reddit_feeds WHERE id = ? AND guild_id = ?', [feedId, guildId]);
            res.redirect(`/manage/${guildId}/feeds`);
        } catch (error) {
            logger.error('Error removing reddit feed.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to remove Reddit feed.' });
        }
    });

    app.post('/manage/:guildId/add-youtube-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const { youtube_channel_id, discord_channel_id } = req.body;
        const { guildId } = req.params;
        if (youtube_channel_id.startsWith('UC')) {
            try {
                await db.execute('INSERT INTO youtube_feeds (guild_id, youtube_channel_id, discord_channel_id) VALUES (?, ?, ?)', [guildId, youtube_channel_id, discord_channel_id]);
            } catch (e) {
                if (e.code !== 'ER_DUP_ENTRY') {
                    logger.error('Error adding youtube feed.', { guildId, category: 'http', error: e.stack });
                    return res.status(500).render('error', { user: req.user, error: 'Failed to add YouTube feed.' });
                }
            }
        }
        res.redirect(`/manage/${guildId}/feeds`);
    });

    app.post('/manage/:guildId/remove-youtube-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const { feedId } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('DELETE FROM youtube_feeds WHERE id = ? AND guild_id = ?', [feedId, guildId]);
            res.redirect(`/manage/${guildId}/feeds`);
        } catch (error) {
            logger.error('Error removing youtube feed.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to remove YouTube feed.' });
        }
    });

    app.post('/manage/:guildId/add-twitter-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const { twitter_username, channel_id } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('INSERT INTO twitter_feeds (guild_id, twitter_username, channel_id) VALUES (?, ?, ?)', [guildId, twitter_username.toLowerCase(), channel_id]);
        } catch (e) {
            if (e.code !== 'ER_DUP_ENTRY') {
                logger.error('Error adding twitter feed.', { guildId, category: 'http', error: e.stack });
                return res.status(500).render('error', { user: req.user, error: 'Failed to add Twitter feed.' });
            }
        }
        res.redirect(`/manage/${guildId}/feeds`);
    });

    app.post('/manage/:guildId/remove-twitter-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const { feedId } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('DELETE FROM twitter_feeds WHERE id = ? AND guild_id = ?', [feedId, guildId]);
            res.redirect(`/manage/${guildId}/feeds`);
        } catch (error) {
            logger.error('Error removing twitter feed.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to remove Twitter feed.' });
        }
    });

    app.post('/manage/:guildId/update-moderation', checkAuth, checkGuildAdmin, async (req, res) => {
        const { mod_log_channel_id, muted_role_id } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE mod_log_channel_id = VALUES(mod_log_channel_id), muted_role_id = VALUES(muted_role_id)', [guildId, mod_log_channel_id || null, muted_role_id || null]);
            res.redirect(`/manage/${guildId}/moderation`);
        } catch (error) {
            logger.error(`Error updating moderation settings.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update moderation settings.' });
        }
    });

    app.post('/manage/:guildId/add-escalation-rule', checkAuth, checkGuildAdmin, async (req, res) => {
        const { infraction_count, time_period_hours, action, action_duration_minutes } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action, action_duration_minutes) VALUES (?, ?, ?, ?, ?)', [guildId, infraction_count, time_period_hours, action, action === 'mute' ? action_duration_minutes : null]);
            res.redirect(`/manage/${guildId}/moderation`);
        } catch (error) {
            logger.error('Error adding escalation rule.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to add escalation rule.' });
        }
    });

    app.post('/manage/:guildId/remove-escalation-rule', checkAuth, checkGuildAdmin, async (req, res) => {
        const { ruleId } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('DELETE FROM escalation_rules WHERE id = ? AND guild_id = ?', [ruleId, guildId]);
            res.redirect(`/manage/${guildId}/moderation`);
        } catch (error) {
            logger.error('Error removing escalation rule.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to remove escalation rule.' });
        }
    });

    app.post('/manage/:guildId/update-automod-heat', checkAuth, checkGuildAdmin, async (req, res) => {
        const { heat_threshold, heat_decay_rate, action, action_duration_minutes, is_enabled } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute(`INSERT INTO automod_heat_config (guild_id, heat_threshold, heat_decay_rate, action, action_duration_minutes, is_enabled) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE heat_threshold = VALUES(heat_threshold), heat_decay_rate = VALUES(heat_decay_rate), action = VALUES(action), action_duration_minutes = VALUES(action_duration_minutes), is_enabled = VALUES(is_enabled)`, [guildId, heat_threshold, heat_decay_rate, action, action === 'mute' ? action_duration_minutes : null, is_enabled === 'on' ? 1 : 0]);
            res.redirect(`/manage/${guildId}/automod`);
        } catch (error) {
            logger.error('Error updating automod heat.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update automod heat settings.' });
        }
    });

    app.post('/manage/:guildId/update-antinuke', checkAuth, checkGuildAdmin, async (req, res) => {
        const { is_enabled, action, channel_threshold, role_threshold, ban_kick_threshold } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute(`INSERT INTO antinuke_config (guild_id, is_enabled, action, channel_threshold, role_threshold, ban_kick_threshold) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), action = VALUES(action), channel_threshold = VALUES(channel_threshold), role_threshold = VALUES(role_threshold), ban_kick_threshold = VALUES(ban_kick_threshold)`, [guildId, is_enabled === 'on' ? 1 : 0, action, channel_threshold, role_threshold, ban_kick_threshold]);
            res.redirect(`/manage/${guildId}/security`);
        } catch (error) {
            logger.error('Error updating antinuke settings.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update antinuke settings.' });
        }
    });

    app.post('/manage/:guildId/create-backup', checkAuth, checkGuildAdmin, async (req, res) => {
        const { snapshot_name } = req.body;
        const { guildId } = req.params;
        try {
            await createBackup(guildId, snapshot_name, client);
            res.redirect(`/manage/${guildId}/backups`);
        } catch (error) {
            logger.error(`Error creating backup.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to create backup.' });
        }
    });

    app.post('/manage/:guildId/restore-backup', checkAuth, checkGuildAdmin, async (req, res) => {
        const { backupId } = req.body;
        const { guildId } = req.params;
        try {
            await restoreBackup(backupId, client);
            res.redirect(`/manage/${guildId}/backups`);
        } catch (error) {
            logger.error(`Error restoring backup ${backupId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to restore backup.' });
        }
    });

    app.post('/manage/:guildId/delete-backup', checkAuth, checkGuildAdmin, async (req, res) => {
        const { backupId } = req.body;
        const { guildId } = req.params;
        try {
            await deleteBackup(backupId);
            res.redirect(`/manage/${guildId}/backups`);
        } catch (error) {
            logger.error(`Error deleting backup ${backupId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to delete backup.' });
        }
    });

    app.post('/manage/:guildId/create-giveaway', checkAuth, checkGuildAdmin, async (req, res) => {
        const { prize, winner_count, duration_minutes, channel_id } = req.body;
        const { guildId } = req.params;
        const ends_at = new Date(Date.now() + parseInt(duration_minutes) * 60 * 1000);

        try {
            const guild = client.guilds.cache.get(guildId);
            const channel = guild.channels.cache.get(channel_id);

            if (!channel) return res.status(400).render('error', { user: req.user, error: 'Invalid channel selected.' });

            const giveawayEmbed = new EmbedBuilder().setTitle(prize).setDescription(`React with 🎉 to enter!\nWinner(s): ${winner_count}\nEnds: <t:${Math.floor(ends_at.getTime() / 1000)}:R>`).setFooter({ text: 'Giveaway' }).setTimestamp(ends_at);
            const message = await channel.send({ embeds: [giveawayEmbed] });
            await message.react('🎉');

            await db.execute('INSERT INTO giveaways (guild_id, channel_id, message_id, prize, winner_count, ends_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)', [guildId, channel_id, message.id, prize, winner_count, ends_at, 1]);
            res.redirect(`/manage/${guildId}/giveaways`);
        } catch (error) {
            logger.error(`Error creating giveaway.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to create giveaway.' });
        }
    });

    app.post('/manage/:guildId/end-giveaway', checkAuth, checkGuildAdmin, async (req, res) => {
        const { giveawayId } = req.body;
        const { guildId } = req.params;
        try {
            const [[giveaway]] = await db.execute('SELECT * FROM giveaways WHERE id = ? AND guild_id = ?', [giveawayId, guildId]);
            if (giveaway) await endGiveaway(giveaway, false);
            res.redirect(`/manage/${guildId}/giveaways`);
        } catch (error) {
            logger.error(`Error ending giveaway ${giveawayId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to end giveaway.' });
        }
    });

    app.post('/manage/:guildId/reroll-giveaway', checkAuth, checkGuildAdmin, async (req, res) => {
        const { giveawayId } = req.body;
        const { guildId } = req.params;
        try {
            const [[giveaway]] = await db.execute('SELECT * FROM giveaways WHERE id = ? AND guild_id = ?', [giveawayId, guildId]);
            if (giveaway) await endGiveaway(giveaway, true);
            res.redirect(`/manage/${guildId}/giveaways`);
        } catch (error) {
            logger.error(`Error rerolling giveaway ${giveawayId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to reroll giveaway.' });
        }
    });

    app.post('/manage/:guildId/delete-giveaway', checkAuth, checkGuildAdmin, async (req, res) => {
        const { giveawayId } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('DELETE FROM giveaways WHERE id = ? AND guild_id = ?', [giveawayId, guildId]);
            res.redirect(`/manage/${guildId}/giveaways`);
        } catch (error) {
            logger.error(`Error deleting giveaway ${giveawayId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to delete giveaway.' });
        }
    });

    app.post('/manage/:guildId/create-poll', checkAuth, checkGuildAdmin, async (req, res) => {
        const { question, options, duration_minutes, channel_id } = req.body;
        const { guildId } = req.params;
        const ends_at = new Date(Date.now() + parseInt(duration_minutes) * 60 * 1000);
        const pollOptions = options.split(',').map(opt => opt.trim());

        if (pollOptions.length < 2 || pollOptions.length > 10) return res.status(400).render('error', { user: req.user, error: 'A poll must have between 2 and 10 options.' });

        try {
            const guild = client.guilds.cache.get(guildId);
            const channel = guild.channels.cache.get(channel_id);

            if (!channel) return res.status(400).render('error', { user: req.user, error: 'Invalid channel selected.' });

            const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            const optionsText = pollOptions.map((option, index) => `${numberEmojis[index]} ${option}`).join('\n');

            const pollEmbed = new EmbedBuilder().setTitle(question).setDescription(`${optionsText}\n\nEnds: <t:${Math.floor(ends_at.getTime() / 1000)}:R>`).setFooter({ text: 'Poll' }).setTimestamp(ends_at);
            const message = await channel.send({ embeds: [pollEmbed] });
            for (let i = 0; i < pollOptions.length; i++) await message.react(numberEmojis[i]);

            await db.execute('INSERT INTO polls (guild_id, channel_id, message_id, question, options, ends_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)', [guildId, channel_id, message.id, question, JSON.stringify(pollOptions), ends_at, 1]);
            res.redirect(`/manage/${guildId}/polls`);
        } catch (error) {
            logger.error(`Error creating poll.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to create poll.' });
        }
    });

    app.post('/manage/:guildId/end-poll', checkAuth, checkGuildAdmin, async (req, res) => {
        const { pollId } = req.body;
        const { guildId } = req.params;
        try {
            const [[poll]] = await db.execute('SELECT * FROM polls WHERE id = ? AND guild_id = ?', [pollId, guildId]);
            if (poll) await endPoll(poll);
            res.redirect(`/manage/${guildId}/polls`);
        } catch (error) {
            logger.error(`Error ending poll ${pollId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to end poll.' });
        }
    });

    app.post('/manage/:guildId/delete-poll', checkAuth, checkGuildAdmin, async (req, res) => {
        const { pollId } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('DELETE FROM polls WHERE id = ? AND guild_id = ?', [pollId, guildId]);
            res.redirect(`/manage/${guildId}/polls`);
        } catch (error) {
            logger.error(`Error deleting poll ${pollId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to delete poll.' });
        }
    });

    app.post('/manage/:guildId/update-music-settings', checkAuth, checkGuildAdmin, async (req, res) => {
        const { is_enabled, text_channel_ids, voice_channel_ids, dj_role_id, default_volume } = req.body;
        const { guildId } = req.params;
        try {
            const textChannels = text_channel_ids ? (Array.isArray(text_channel_ids) ? text_channel_ids : [text_channel_ids]) : [];
            const voiceChannels = voice_channel_ids ? (Array.isArray(voice_channel_ids) ? voice_channel_ids : [voice_channel_ids]) : [];

            await db.execute(`INSERT INTO music_config (guild_id, is_enabled, text_channel_ids, voice_channel_ids, dj_role_id, default_volume) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), text_channel_ids = VALUES(text_channel_ids), voice_channel_ids = VALUES(voice_channel_ids), dj_role_id = VALUES(dj_role_id), default_volume = VALUES(default_volume)`, [guildId, is_enabled === 'on' ? 1 : 0, JSON.stringify(textChannels), JSON.stringify(voiceChannels), dj_role_id || null, default_volume]);
            res.redirect(`/manage/${guildId}/music`);
        } catch (error) {
            logger.error(`Error updating music settings.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update music settings.' });
        }
    });

    app.post('/manage/:guildId/send-announcement', checkAuth, checkGuildAdmin, async (req, res) => {
        const { channel_id, message, title, color, mention_role_id } = req.body;
        const { guildId } = req.params;
        try {
            const guild = client.guilds.cache.get(guildId);
            const targetChannel = guild.channels.cache.get(channel_id);

            if (!targetChannel) return res.status(400).render('error', { user: req.user, error: 'Invalid channel selected.' });

            const announcementContent = { content: mention_role_id ? `<@&${mention_role_id}>` : undefined };

            if (title) {
                const embed = new EmbedBuilder().setTitle(title).setDescription(message).setColor(color || '#5865F2').setTimestamp();
                announcementContent.embeds = [embed];
            } else {
                announcementContent.content = `${announcementContent.content || ''} ${message}`.trim();
            }

            await targetChannel.send(announcementContent);
            res.redirect(`/manage/${guildId}/utilities`);
        } catch (error) {
            logger.error(`Error sending announcement.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to send announcement. Check bot permissions.' });
        }
    });

    app.post('/manage/:guildId/create-reminder', checkAuth, checkGuildAdmin, async (req, res) => {
        const { message, when, channel_id } = req.body;
        const { guildId } = req.params;
        const userId = req.user.id;

        const remindAt = parseTime(when);
        if (!remindAt) return res.status(400).render('error', { user: req.user, error: 'Invalid time format. Please use formats like 30m, 2h, 1d.' });

        try {
            await db.execute('INSERT INTO reminders (guild_id, user_id, channel_id, is_dm, message, remind_at) VALUES (?, ?, ?, ?, ?, ?)', [guildId, userId, channel_id, 0, message, remindAt]);
            res.redirect(`/manage/${guildId}/utilities`);
        } catch (error) {
            logger.error(`Error creating reminder.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to create reminder.' });
        }
    });

    app.post('/manage/:guildId/delete-reminder', checkAuth, checkGuildAdmin, async (req, res) => {
        const { reminderId } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('DELETE FROM reminders WHERE id = ? AND guild_id = ?', [reminderId, guildId]);
            res.redirect(`/manage/${guildId}/utilities`);
        } catch (error) {
            logger.error(`Error deleting reminder ${reminderId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to delete reminder.' });
        }
    });

    app.post('/manage/:guildId/update-leveling', checkAuth, checkGuildAdmin, async (req, res) => {
        const { leveling_enabled, leveling_xp_rate, leveling_xp_cooldown, leveling_ignored_channels, leveling_ignored_roles } = req.body;
        const { guildId } = req.params;
        try {
            const ignoredChannels = leveling_ignored_channels ? (Array.isArray(leveling_ignored_channels) ? leveling_ignored_channels : [leveling_ignored_channels]) : [];
            const ignoredRoles = leveling_ignored_roles ? (Array.isArray(leveling_ignored_roles) ? leveling_ignored_roles : [leveling_ignored_roles]) : [];

            await db.execute(`UPDATE guilds SET leveling_enabled = ?, leveling_xp_rate = ?, leveling_xp_cooldown = ?, leveling_ignored_channels = ?, leveling_ignored_roles = ? WHERE guild_id = ?`, [leveling_enabled === 'on' ? 1 : 0, leveling_xp_rate, leveling_xp_cooldown, JSON.stringify(ignoredChannels), JSON.stringify(ignoredRoles), guildId]);
            res.redirect(`/manage/${guildId}/leveling`);
        } catch (error) {
            logger.error(`Error updating leveling settings.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update leveling settings.' });
        }
    });

    app.post('/manage/:guildId/add-role-reward', checkAuth, checkGuildAdmin, async (req, res) => {
        const { level, role_id } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('INSERT INTO role_rewards (guild_id, level, role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)', [guildId, level, role_id]);
            res.redirect(`/manage/${guildId}/leveling`);
        } catch (error) {
            logger.error('Error adding role reward.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to add role reward.' });
        }
    });

    app.post('/manage/:guildId/remove-role-reward', checkAuth, checkGuildAdmin, async (req, res) => {
        const { rewardId } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('DELETE FROM role_rewards WHERE id = ? AND guild_id = ?', [rewardId, guildId]);
            res.redirect(`/manage/${guildId}/leveling`);
        } catch (error) {
            logger.error('Error removing role reward.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to remove role reward.' });
        }
    });

    app.post('/manage/:guildId/add-custom-command', checkAuth, checkGuildAdmin, async (req, res) => {
        const { command_name, response } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('INSERT INTO custom_commands (guild_id, command_name, response, action_type, action_content) VALUES (?, ?, ?, ?, ?)', [guildId, command_name.toLowerCase(), response || null, 'text', null]);
            invalidateCommandCache(guildId, command_name);
            res.redirect(`/manage/${guildId}/custom-commands`);
        } catch (error) {
            logger.error(`Error adding custom command.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to add custom command.' });
        }
    });

    app.post('/manage/:guildId/remove-custom-command', checkAuth, checkGuildAdmin, async (req, res) => {
        const { command_name } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('DELETE FROM custom_commands WHERE id = ? AND guild_id = ?', [command_name, guildId]);
            invalidateCommandCache(guildId);
            res.redirect(`/manage/${guildId}/custom-commands`);
        } catch (error) {
            logger.error('Error removing custom command.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to remove custom command.' });
        }
    });

    app.post('/manage/:guildId/add-automod-rule', checkAuth, checkGuildAdmin, async (req, res) => {
        const { filter_type, action, action_duration_minutes } = req.body;
        const { guildId } = req.params;
        try {
            let config = {};
            if (filter_type === 'bannedWords') config.banned_words = req.body.config_banned_words.split(',').map(w => w.trim()).filter(Boolean);
            else if (filter_type === 'massMention') config.limit = parseInt(req.body.config_massMention_limit) || 5;
            else if (filter_type === 'allCaps') config.limit = parseInt(req.body.config_allCaps_limit) || 70;
            else if (filter_type === 'antiSpam') { config.message_limit = parseInt(req.body.config_antiSpam_message_limit) || 5; config.time_period = parseInt(req.body.config_antiSpam_time_period) || 10; }

            await db.execute('INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes) VALUES (?, ?, ?, ?, ?)', [guildId, filter_type, JSON.stringify(config), action, action === 'mute' ? action_duration_minutes : null]);
            res.redirect(`/manage/${guildId}/automod`);
        } catch (error) {
            logger.error('Error adding automod rule.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to add automod rule.' });
        }
    });

    app.post('/manage/:guildId/delete-automod-rule', checkAuth, checkGuildAdmin, async (req, res) => {
        const { ruleId } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('DELETE FROM automod_rules WHERE id = ? AND guild_id = ?', [ruleId, guildId]);
            res.redirect(`/manage/${guildId}/automod`);
        } catch (error) {
            logger.error('Error deleting automod rule.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to delete automod rule.' });
        }
    });

    app.post('/manage/:guildId/update-tempchannels', checkAuth, checkGuildAdmin, async (req, res) => {
        const { creator_channel_id, category_id, naming_template } = req.body;
        const { guildId } = req.params;
        try {
            if (!creator_channel_id || !category_id) {
                await db.execute('DELETE FROM temp_channel_config WHERE guild_id = ?', [guildId]);
            } else {
                await db.execute(`INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE creator_channel_id = VALUES(creator_channel_id), category_id = VALUES(category_id), naming_template = VALUES(naming_template)`, [guildId, creator_channel_id, category_id, naming_template || '{username}\'s Channel']);
            }
            res.redirect(`/manage/${guildId}/utilities`);
        } catch (error) {
            logger.error(`Error updating temp channels.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update temporary channel settings.' });
        }
    });

    app.get('/help', (req, res) => {
        try {
            const commands = client.application.commands.cache.map(cmd => ({ name: cmd.name, description: cmd.description, options: cmd.options || [] }));
            res.render('commands', { user: req.user, commands });
        } catch (error) {
            logger.error('Failed to fetch commands for /help page:', { category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Could not load commands.' });
        }
    });
    app.get('/donate', (req, res) => res.render('donate', { user: req.user }));
    app.get('/status', (req, res) => res.render('status', { user: req.user, isAuthenticated: req.isAuthenticated() }));

    app.get('/commands', (req, res) => {
        const commands = [];
        const commandPath = path.join(__dirname, '../commands');
        const commandFiles = fs.readdirSync(commandPath).filter(file => file.endsWith('.js'));
    
        for (const file of commandFiles) {
            try {
                const command = require(path.join(commandPath, file));
                if (command.data) {
                    const commandData = command.data.toJSON();
                    if (!commandData.category) {
                        if (['ban', 'kick', 'mute', 'warn'].includes(commandData.name)) commandData.category = 'Moderation';
                        else if (['play', 'stop', 'queue'].includes(commandData.name)) commandData.category = 'Music';
                        else commandData.category = 'Utility';
                    }
                    commands.push(commandData);
                }
            } catch (error) {
                logger.error(`Error loading command file ${file}:`, { category: 'system', error: error.stack });
            }
        }
    
        res.render('commands', { user: req.user ? req.user : null, commands: commands });
    });

    app.get('/api/status-data', async (req, res) => {
        try {
            const [[liveCountResult]] = await db.execute('SELECT COUNT(*) as count FROM announcements');
            const [[totalStreamersResult]] = await db.execute('SELECT COUNT(DISTINCT streamer_id) FROM streamers');
            const [platformDistributionResult] = await db.execute('SELECT platform, COUNT(*) as count FROM streamers GROUP BY platform');
            const [liveStreamersRows] = await db.execute(`SELECT s.username, s.profile_image_url as avatar_url, a.platform, a.stream_url as url FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id ORDER BY s.username`);

            const liveStreamersMap = new Map();
            for (const row of liveStreamersRows) {
                if (!liveStreamersMap.has(row.username)) liveStreamersMap.set(row.username, { username: row.username, avatar_url: row.avatar_url, live_platforms: [] });
                liveStreamersMap.get(row.username).live_platforms.push({ platform: row.platform, url: row.url });
            }
            const liveStreamers = Array.from(liveStreamersMap.values());

            let announcementCount = 0;
            try {
                const [[announcementCountResult]] = await db.execute('SELECT total_announcements FROM global_stats WHERE id = 1');
                if (announcementCountResult) announcementCount = announcementCountResult.total_announcements;
            } catch (e) {
                logger.warn('Could not retrieve total_announcements from global_stats. Defaulting to 0.', { category: 'database' });
            }

            const data = { liveCount: liveCountResult.count, totalStreamers: totalStreamersResult['COUNT(DISTINCT streamer_id)'], totalGuilds: client.guilds.cache.size, totalAnnouncements: announcementCount, liveStreamers, platformDistribution: platformDistributionResult };

            if (req.isAuthenticated() && req.user.isSuperAdmin) {
                data.app = { status: 'online', uptime: `${Math.floor(process.uptime() / 86400)}d ${Math.floor(process.uptime() % 86400 / 3600)}h ${Math.floor(process.uptime() % 3600 / 60)}m` };
                try {
                    await db.execute('SELECT 1');
                    data.db = { status: 'ok' };
                } catch (e) {
                    data.db = { status: 'error' };
                }
            }

            res.json(data);
        } catch (error) {
            logger.error('Error fetching status data:', { category: 'http', error: error.stack });
            res.status(500).json({ error: 'Failed to fetch status data' });
        }
    });

    app.post('/manage/:guildId/delete-tag', checkAuth, checkGuildAdmin, async (req, res) => {
        const { tagId } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('DELETE FROM tags WHERE id = ? AND guild_id = ?', [tagId, guildId]);
            res.redirect(`/manage/${guildId}/tags`);
        } catch (error) {
            logger.error('Error deleting tag.', { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to delete tag.' });
        }
    });

    app.get('/api/authenticated-logs', checkAuth, (req, res) => {
        if (!req.user.isSuperAdmin) return res.status(403).json({ error: 'Forbidden' });

        const logPath = path.join(__dirname, '..', 'logs', 'app.log');
        fs.readFile(logPath, 'utf8', (err, data) => {
            if (err) {
                logger.error('Failed to read log file:', { category: 'system', error: err.stack });
                return res.status(500).json({ error: 'Could not read logs.' });
            }
            const logs = data.split('\n').slice(-200).join('\n');
            res.json({ logs });
        });
    });

    app.post('/api/admin/reinit-bot', checkAuth, (req, res) => {
        if (!req.user.isSuperAdmin) return res.status(403).json({ error: 'Forbidden' });

        logger.warn(`[ADMIN] Bot re-initialization requested by ${req.user.username}`, { category: 'system' });
        res.json({ success: true, message: 'Re-initialization command sent. The bot will restart shortly.' });

        setTimeout(() => process.exit(0), 1000);
    });

    app.post('/api/admin/reset-database', checkAuth, checkSuperAdmin, async (req, res) => {
        logger.warn(`[ADMIN] Database reset requested by ${req.user.username}`);
        const result = await resetDatabase();
        if (result.success) {
            res.json({ success: true, message: 'Database reset initiated. The bot may restart.' });
            // Optionally, trigger a bot restart after database reset
            setTimeout(() => process.exit(0), 2000); 
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    });

    app.use((req, res) => res.status(404).render('error', { user: req.user, error: 'Page Not Found' }));

    app.listen(port, () => {
        logger.info(`[Dashboard] Web dashboard listening on port ${port}`, { category: 'system' });
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            logger.error(`[Dashboard] Port ${port} is already in use. Please stop the other process or change the dashboard port.`, { category: 'system' });
        }
    });

    app.post('/manage/:guildId/create-rr-panel', checkAuth, checkGuildAdmin, async (req, res) => {
        const { panel_name, channel_id, message_content } = req.body;
        const { guildId } = req.params;

        try {
            const channel = await client.channels.fetch(channel_id);
            if (!channel) return res.status(400).render('error', { user: req.user, error: 'Invalid channel selected.' });

            const panelMessage = await channel.send(message_content);

            await db.execute('INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name) VALUES (?, ?, ?, ?)', [guildId, channel_id, panelMessage.id, panel_name]);
            res.redirect(`/manage/${guildId}/reaction-roles`);
        } catch (error) {
            logger.error(`Error creating reaction role panel.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to create reaction role panel.' });
        }
    });

    app.post('/manage/:guildId/add-rr-mapping', checkAuth, checkGuildAdmin, async (req, res) => {
        const { panelId, emoji_id, role_id } = req.body;
        const { guildId } = req.params;

        if (!role_id) return res.status(400).render('error', { user: req.user, error: 'You must select a role to assign.' });

        try {
            const [[panel]] = await db.execute('SELECT channel_id, message_id FROM reaction_role_panels WHERE id = ? AND guild_id = ?', [panelId, guildId]);
            if (!panel) return res.status(400).render('error', { user: req.user, error: 'Reaction role panel not found.' });

            const channel = await client.channels.fetch(panel.channel_id);
            const message = await channel.messages.fetch(panel.message_id);
            await message.react(emoji_id);

            await db.execute('INSERT INTO reaction_role_mappings (panel_id, emoji_id, role_id) VALUES (?, ?, ?)', [panelId, emoji_id, role_id]);
            res.redirect(`/manage/${guildId}/reaction-roles`);
        } catch (error) {
            logger.error(`Error adding reaction role mapping.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to add reaction role mapping.' });
        }
    });

    app.post('/manage/:guildId/remove-rr-mapping', checkAuth, checkGuildAdmin, async (req, res) => {
        const { mappingId } = req.body;
        const { guildId } = req.params;

        try {
            await db.execute('DELETE FROM reaction_role_mappings WHERE id = ? AND panel_id IN (SELECT id FROM reaction_role_panels WHERE guild_id = ?)', [mappingId, guildId]);
            res.redirect(`/manage/${guildId}/reaction-roles`);
        } catch (error) {
            logger.error(`Error removing reaction role mapping ${mappingId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to remove reaction role mapping.' });
        }
    });

    app.post('/manage/:guildId/delete-rr-panel', checkAuth, checkGuildAdmin, async (req, res) => {
        const { panelId } = req.body;
        const { guildId } = req.params;

        try {
            await db.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [panelId]);
            await db.execute('DELETE FROM reaction_role_panels WHERE id = ? AND guild_id = ?', [panelId, guildId]);
            res.redirect(`/manage/${guildId}/reaction-roles`);
        } catch (error) {
            logger.error(`Error deleting reaction role panel ${panelId}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to delete reaction role panel.' });
        }
    });

    app.post('/manage/:guildId/edit-consolidated-streamer', checkAuth, checkGuildAdmin, async (req, res) => {
        const { consolidated_streamer_id, discord_user_id, subscriptions } = req.body;
        const { guildId } = req.params;
        try {
            await db.execute('UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?', [discord_user_id || null, consolidated_streamer_id]);

            if (subscriptions) {
                for (const subId in subscriptions) {
                    const sub = subscriptions[subId];
                    const { announcement_channel_id, override_nickname, custom_message, override_avatar_url_text, reset_avatar, privacy_level, youtube_vod_notifications, tiktok_vod_notifications, keep_summary, game_filter, title_filter } = sub;

                    let avatarUrlToSave = override_avatar_url_text;
                    if (reset_avatar === 'on') avatarUrlToSave = null;

                    await db.execute(`UPDATE subscriptions SET announcement_channel_id = ?, override_nickname = ?, custom_message = ?, override_avatar_url = ?, privacy_level = ?, youtube_vod_notifications = ?, tiktok_vod_notifications = ?, delete_on_end = ?, game_filter = ?, title_filter = ? WHERE subscription_id = ?`, [announcement_channel_id || null, override_nickname || null, custom_message || null, avatarUrlToSave || null, privacy_level || null, youtube_vod_notifications === 'on' ? 1 : 0, tiktok_vod_notifications === 'on' ? 1 : 0, keep_summary !== 'on' ? 1 : 0, game_filter || null, title_filter || null, subId]);
                }
            }

            res.redirect(`/manage/${guildId}/streamers`);
        } catch (error) {
            logger.error(`Error editing consolidated streamer ${consolidated_streamer_id}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update streamer settings.' });
        }
    });

    app.post('/manage/:guildId/update-bot-appearance', checkAuth, checkGuildAdmin, upload.single('bot_avatar_file'), async (req, res) => {
        const { bot_nickname, bot_avatar_url_text, reset_bot_avatar, embed_color } = req.body;
        const { guildId } = req.params;

        try {
            let finalBotNickname = bot_nickname;
            if (bot_nickname && bot_nickname.toLowerCase() === 'reset') finalBotNickname = null;

            let finalAvatarUrl = bot_avatar_url_text;
            if (reset_bot_avatar === 'on') {
                finalAvatarUrl = null;
            }
            else if (req.file) {
                const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                if (!tempUploadChannelId) throw new Error("Temporary upload channel ID is not configured.");
                const tempChannel = await client.channels.fetch(tempUploadChannelId);
                if (!tempChannel) throw new Error("Temporary upload channel not found.");

                const tempMessage = await tempChannel.send({ files: [{ attachment: req.file.path, name: req.file.originalname }] });
                finalAvatarUrl = tempMessage.attachments.first().url;
                fs.unlinkSync(req.file.path);
            }

            await db.execute(`UPDATE guilds SET bot_nickname = ?, webhook_avatar_url = ?, embed_color = ? WHERE guild_id = ?`, [finalBotNickname, finalAvatarUrl, embed_color || '#5865F2', guildId]);

            if (finalBotNickname !== undefined) {
                try {
                    const botMember = await client.guilds.cache.get(guildId).members.fetch(client.user.id);
                    await botMember.setNickname(finalBotNickname);
                } catch (e) {
                    logger.warn(`Failed to update bot nickname in Discord for guild ${guildId}: ${e.message}`, { guildId, category: 'discord' });
                }
            }

            res.redirect(`/manage/${guildId}/appearance`);
        } catch (error) {
            logger.error(`Error updating bot appearance.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update bot appearance.' });
        }
    });

    app.post('/manage/:guildId/add-twitch-schedule-sync', checkAuth, checkGuildAdmin, async (req, res) => {
        const { streamer_id, discord_channel_id, mention_role_id, custom_message, is_enabled } = req.body;
        const { guildId } = req.params;

        try {
            await db.execute(`INSERT INTO twitch_schedule_sync_config (guild_id, streamer_id, discord_channel_id, mention_role_id, custom_message, is_enabled) VALUES (?, ?, ?, ?, ?, ?)`, [guildId, streamer_id, discord_channel_id, mention_role_id || null, custom_message || null, is_enabled === 'on' ? 1 : 0]);
            res.redirect(`/manage/${guildId}/twitch-schedules`);
        } catch (error) {
            logger.error(`Error adding Twitch schedule sync.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to add Twitch schedule sync.' });
        }
    });

    app.post('/manage/:guildId/toggle-twitch-schedule-sync', checkAuth, checkGuildAdmin, async (req, res) => {
        const { sync_id } = req.body;
        const { guildId } = req.params;

        try {
            const [[currentConfig]] = await db.execute('SELECT is_enabled FROM twitch_schedule_sync_config WHERE id = ? AND guild_id = ?', [sync_id, guildId]);
            if (currentConfig) {
                const newStatus = currentConfig.is_enabled === 1 ? 0 : 1;
                await db.execute('UPDATE twitch_schedule_sync_config SET is_enabled = ? WHERE id = ? AND guild_id = ?', [newStatus, sync_id, guildId]);
            }
            res.redirect(`/manage/${guildId}/twitch-schedules`);
        } catch (error) {
            logger.error(`Error toggling Twitch schedule sync ${sync_id}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to toggle Twitch schedule sync.' });
        }
    });

    app.post('/manage/:guildId/remove-twitch-schedule-sync', checkAuth, checkGuildAdmin, async (req, res) => {
        const { sync_id } = req.body;
        const { guildId } = req.params;

        try {
            await db.execute('DELETE FROM twitch_schedule_sync_config WHERE id = ? AND guild_id = ?', [sync_id, guildId]);
            res.redirect(`/manage/${guildId}/twitch-schedules`);
        } catch (error) {
            logger.error(`Error removing Twitch schedule sync ${sync_id}.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to remove Twitch schedule sync.' });
        }
    });

    app.post('/manage/:guildId/update-quarantine', checkAuth, checkGuildAdmin, async (req, res) => {
        const { is_enabled, quarantine_role_id } = req.body;
        const { guildId } = req.params;

        try {
            await db.execute(`INSERT INTO quarantine_config (guild_id, is_enabled, quarantine_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), quarantine_role_id = VALUES(quarantine_role_id)`, [guildId, is_enabled === 'on' ? 1 : 0, quarantine_role_id || null]);
            res.redirect(`/manage/${guildId}/security`);
        } catch (error) {
            logger.error(`Error updating quarantine settings.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update quarantine settings.' });
        }
    });

    app.post('/manage/:guildId/update-record-settings', checkAuth, checkGuildAdmin, async (req, res) => {
        const { is_enabled, allowed_role_ids, output_channel_id } = req.body;
        const { guildId } = req.params;

        const rolesToAllow = allowed_role_ids ? (Array.isArray(allowed_role_ids) ? allowed_role_ids : [allowed_role_ids]) : [];

        try {
            await db.execute(`INSERT INTO record_config (guild_id, is_enabled, allowed_role_ids, output_channel_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), allowed_role_ids = VALUES(allowed_role_ids), output_channel_id = VALUES(output_channel_id)`, [guildId, is_enabled === 'on' ? 1 : 0, JSON.stringify(rolesToAllow), output_channel_id || null]);
            res.redirect(`/manage/${guildId}/record`);
        } catch (error) {
            logger.error(`Error updating record settings.`, { guildId, category: 'http', error: error.stack });
            res.status(500).render('error', { user: req.user, error: 'Failed to update record settings.' });
        }
    });

    app.get('/api/guild/:guildId/search', checkAuth, checkGuildAdmin, async (req, res) => {
        const { q: query, categories: categoriesParam } = req.query;
        const guildId = req.params.guildId;
        const categories = categoriesParam ? categoriesParam.split(',') : [];
        const searchResults = [];

        if (!query || categories.length === 0) return res.json([]);

        const searchQuery = `%${query}%`;

        try {
            if (categories.includes('settings')) {
                const [guildSettings] = await db.execute('SELECT * FROM guilds WHERE guild_id = ? AND (bot_nickname LIKE ? OR welcome_message LIKE ? OR goodbye_message LIKE ?)', [guildId, searchQuery, searchQuery, searchQuery]);
                if (guildSettings.length > 0) {
                    guildSettings.forEach(setting => {
                        if (setting.bot_nickname && setting.bot_nickname.toLowerCase().includes(query.toLowerCase())) searchResults.push({ type: 'Bot Nickname', description: `Bot Nickname: ${setting.bot_nickname}`, link: `/manage/${guildId}/appearance` });
                        if (setting.welcome_message && setting.welcome_message.toLowerCase().includes(query.toLowerCase())) searchResults.push({ type: 'Welcome Message', description: `Welcome Message: ${setting.welcome_message}`, link: `/manage/${guildId}/welcome` });
                        if (setting.goodbye_message && setting.goodbye_message.toLowerCase().includes(query.toLowerCase())) searchResults.push({ type: 'Goodbye Message', description: `Goodbye Message: ${setting.goodbye_message}`, link: `/manage/${guildId}/welcome` });
                    });
                }

                const [automodRules] = await db.execute('SELECT * FROM automod_rules WHERE guild_id = ? AND (filter_type LIKE ? OR config LIKE ?)', [guildId, searchQuery, searchQuery]);
                automodRules.forEach(rule => searchResults.push({ type: 'AutoMod Rule', description: `AutoMod Rule: ${rule.filter_type} - ${rule.config}`, link: `/manage/${guildId}/automod` }));

                const [customCommands] = await db.execute('SELECT * FROM custom_commands WHERE guild_id = ? AND (command_name LIKE ? OR response LIKE ?)', [guildId, searchQuery, searchQuery]);
                customCommands.forEach(cmd => searchResults.push({ type: 'Custom Command', description: `Custom Command: /${cmd.command_name} - ${cmd.response}`, link: `/manage/${guildId}/custom-commands` }));

                const [tags] = await db.execute('SELECT * FROM tags WHERE guild_id = ? AND (tag_name LIKE ? OR tag_content LIKE ?)', [guildId, searchQuery, searchQuery]);
                tags.forEach(tag => searchResults.push({ type: 'Tag', description: `Tag: ${tag.tag_name} - ${tag.tag_content}`, link: `/manage/${guildId}/tags` }));

                const [twitchTeams] = await db.execute('SELECT * FROM twitch_teams WHERE guild_id = ? AND team_name LIKE ?', [guildId, searchQuery]);
                twitchTeams.forEach(team => searchResults.push({ type: 'Twitch Team', description: `Twitch Team: ${team.team_name}`, link: `/manage/${guildId}/teams` }));

                const [subscriptions] = await db.execute('SELECT sub.*, s.username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND (sub.custom_message LIKE ? OR sub.game_filter LIKE ? OR sub.title_filter LIKE ? OR s.username LIKE ?)', [guildId, searchQuery, searchQuery, searchQuery, searchQuery]);
                subscriptions.forEach(sub => searchResults.push({ type: 'Streamer Subscription', description: `Streamer: ${sub.username} - Custom Message: ${sub.custom_message || 'N/A'}`, link: `/manage/${guildId}/streamers` }));
            }

            if (categories.includes('users')) {
                const [infractions] = await db.execute('SELECT * FROM infractions WHERE guild_id = ? AND (user_id LIKE ? OR moderator_id LIKE ? OR reason LIKE ?)', [guildId, searchQuery, searchQuery, searchQuery]);
                for (const infraction of infractions) {
                    let description = `Infraction: ${infraction.reason} by ${infraction.moderator_id} on ${infraction.user_id}`;
                    try {
                        const user = await client.users.fetch(infraction.user_id).catch(() => null);
                        const moderator = await client.users.fetch(infraction.moderator_id).catch(() => null);
                        if (user) description = description.replace(infraction.user_id, user.tag);
                        if (moderator) description = description.replace(infraction.moderator_id, moderator.tag);
                    } catch (e) { logger.warn('Failed to fetch user for infraction search', { guildId, category: 'discord', error: e.message }); }
                    searchResults.push({ type: 'Infraction', description: description, link: `/manage/${req.params.guildId}/moderation` });
                }

                const [actionLogs] = await db.execute('SELECT * FROM action_logs WHERE guild_id = ? AND (user_id LIKE ? OR target_id LIKE ? OR details LIKE ?)', [guildId, searchQuery, searchQuery, searchQuery]);
                for (const log of actionLogs) {
                    let description = `Log: ${log.event_type} by ${log.user_id} on ${log.target_id} - ${log.details}`;
                    try {
                        const user = await client.users.fetch(log.user_id).catch(() => null);
                        if (user) description = description.replace(log.user_id, user.tag);
                    } catch (e) { logger.warn('Failed to fetch user for action log search', { guildId, category: 'discord', error: e.message }); }
                    searchResults.push({ type: 'Action Log', description: description, link: `/manage/${req.params.guildId}/logging` });
                }
            }

            if (categories.includes('logs')) {}

            res.json(searchResults);
        } catch (error) {
            logger.error(`Error during dashboard search.`, { guildId, category: 'http', error: error.stack });
            res.status(500).json({ error: 'An error occurred during search.' });
        }
    });
}

module.exports = { start };
