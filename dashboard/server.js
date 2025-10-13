const express = require('express');
const session = require('express-session');
const passport = require('passport');
require('./passport-setup');
const path = require('path');
const db = require('../utils/db');
const { PermissionsBitField, ChannelType } = require('discord.js');
const logger = require('../utils/logger');
const RedisStore = require('connect-redis')(session);
const Redis = require('ioredis');

function getSanitizedUser(req) {
    if (!req.isAuthenticated() || !req.user) return null;
    const { id, username, discriminator, avatar, isSuperAdmin } = req.user;
    return { id, username, discriminator, avatar, isSuperAdmin };
}

function sanitizeGuild(guild) {
    if (!guild) return null;
    return { id: guild.id, name: guild.name, icon: guild.icon };
}

async function getManagePageData(guildId, botGuild) {
    const data = {};
    const queries = {
        subscriptions: `SELECT sub.*, s.platform, s.username, s.discord_user_id, s.streamer_id, s.platform_user_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? ORDER BY s.username, sub.announcement_channel_id`,
        guildSettings: 'SELECT * FROM guilds WHERE guild_id = ?',
        teamSubscriptions: 'SELECT * FROM twitch_teams WHERE guild_id = ?',
        automodRules: 'SELECT * FROM automod_rules WHERE guild_id = ? ORDER BY id',
        heatConfig: 'SELECT * FROM automod_heat_config WHERE guild_id = ?',
        backups: 'SELECT id, snapshot_name, created_at FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC',
        welcomeSettings: 'SELECT * FROM welcome_settings WHERE guild_id = ?',
        customCommands: 'SELECT * FROM custom_commands WHERE guild_id = ?',
        ticketConfig: 'SELECT * FROM ticket_config WHERE guild_id = ?',
        ticketForms: 'SELECT * FROM ticket_forms WHERE guild_id = ?',
        logConfig: 'SELECT * FROM log_config WHERE guild_id = ?',
        redditFeeds: 'SELECT * FROM reddit_feeds WHERE guild_id = ?',
        youtubeFeeds: 'SELECT * FROM youtube_feeds WHERE guild_id = ?',
        twitterFeeds: 'SELECT * FROM twitter_feeds WHERE guild_id = ?',
        moderationConfig: 'SELECT * FROM moderation_config WHERE guild_id = ?',
        recentInfractions: 'SELECT * FROM infractions WHERE guild_id = ? ORDER BY created_at DESC LIMIT 10',
        escalationRules: 'SELECT * FROM escalation_rules WHERE guild_id = ? ORDER BY infraction_count ASC',
        roleRewards: 'SELECT * FROM role_rewards WHERE guild_id = ? ORDER BY level ASC',
        starboardConfig: 'SELECT * FROM starboard_config WHERE guild_id = ?',
        reactionRolePanels: 'SELECT * FROM reaction_role_panels WHERE guild_id = ?',
        actionLogs: 'SELECT * FROM action_logs WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 50',
        giveaways: 'SELECT * FROM giveaways WHERE guild_id = ? ORDER BY ends_at DESC',
        polls: 'SELECT * FROM polls WHERE guild_id = ? ORDER BY ends_at DESC',
        musicConfig: 'SELECT * FROM music_config WHERE guild_id = ?',
        twitchScheduleSyncs: 'SELECT * FROM twitch_schedule_sync_config WHERE guild_id = ?',
        statroleConfigs: 'SELECT * FROM statrole_configs WHERE guild_id = ?',
        savedEmbeds: 'SELECT * FROM embeds WHERE guild_id = ?',
        joinGateConfig: 'SELECT * FROM join_gate_config WHERE guild_id = ?',
        antiRaidConfig: 'SELECT * FROM anti_raid_config WHERE guild_id = ?',
        antiNukeConfig: 'SELECT * FROM anti_nuke_config WHERE guild_id = ?',
        quarantineConfig: 'SELECT * FROM quarantine_config WHERE guild_id = ?',
        autoPublisherConfig: 'SELECT * FROM auto_publisher_config WHERE guild_id = ?',
        autorolesConfig: 'SELECT * FROM autoroles_config WHERE guild_id = ?',
        tempChannelConfig: 'SELECT * FROM temp_channel_config WHERE guild_id = ?',
        recordConfig: 'SELECT * FROM record_config WHERE guild_id = ?',
        channelSettings: 'SELECT * FROM channel_settings WHERE guild_id = ?' // Fetch channel-specific settings
    };

    for (const key in queries) {
        try {
            const [rows] = await db.execute(queries[key], [guildId]);
            data[key] = rows;
        } catch (e) {
            if (e.code === 'ER_NO_SUCH_TABLE') {
                logger.warn(`[Dashboard] Missing table for query '${key}'. Returning empty set.`, { guildId });
                data[key] = []; // Gracefully handle missing table
            } else {
                logger.error(`[Dashboard] Failed to execute query for '${key}'`, { guildId, error: e.message, stack: e.stack });
                data[key] = []; // Return empty on other errors too
            }
        }
    }

    // Process single-row results
    data.guildSettings = data.guildSettings[0] || {};
    data.heatConfig = data.heatConfig[0] || {};
    data.welcomeSettings = data.welcomeSettings[0] || {};
    data.ticketConfig = data.ticketConfig[0] || {};
    data.logConfig = data.logConfig[0] || {};
    data.moderationConfig = data.moderationConfig[0] || {};
    data.starboardConfig = data.starboardConfig[0] || {};
    data.musicConfig = data.musicConfig[0] || {};
    data.joinGateConfig = data.joinGateConfig[0] || {};
    data.antiRaidConfig = data.antiRaidConfig[0] || {};
    data.antiNukeConfig = data.antiNukeConfig[0] || {};
    data.quarantineConfig = data.quarantineConfig[0] || {};
    data.autoPublisherConfig = data.autoPublisherConfig[0] || {};
    data.autorolesConfig = data.autorolesConfig[0] || {};
    data.tempChannelConfig = data.tempChannelConfig[0] || {};
    data.recordConfig = data.recordConfig[0] || {};

    // Create a map for easy lookup of channel settings
    data.channelSettingsMap = new Map();
    (data.channelSettings || []).forEach(cs => {
        data.channelSettingsMap.set(cs.channel_id, cs);
    });

    // Fetch and process Discord API data separately
    try {
        const roles = await botGuild.roles.fetch();
        data.roles = Array.from(roles.values()).filter(r => !r.managed && r.name !== '@everyone').map(r => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name));
        const channels = await botGuild.channels.fetch();
        data.channels = Array.from(channels.values()).filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
        data.categories = Array.from(channels.values()).filter(c => c.type === ChannelType.GuildCategory).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
        data.voiceChannels = Array.from(channels.values()).filter(c => c.type === ChannelType.GuildVoice).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
        logger.error(`[Dashboard] Failed to fetch roles/channels from Discord API`, { guildId, error: e.message, stack: e.stack });
        data.roles = []; data.channels = []; data.categories = []; data.voiceChannels = [];
    }

    for (const panel of (data.reactionRolePanels || [])) {
        const [mappings] = await db.execute('SELECT * FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);
        panel.mappings = mappings || [];
    }

    const consolidatedStreamers = {};
    (data.subscriptions || []).forEach(sub => {
        const key = sub.streamer_id;
        if (!consolidatedStreamers[key]) {
            consolidatedStreamers[key] = { id: sub.streamer_id, name: sub.username, discord_user_id: sub.discord_user_id, platforms: new Set(), subscriptions: [] };
        }
        consolidatedStreamers[key].subscriptions.push(sub);
        consolidatedStreamers[key].platforms.add(sub.platform);
    });
    data.consolidatedStreamers = Object.values(consolidatedStreamers).map(s => ({ ...s, platforms: Array.from(s.platforms) }));

    // Rename for template consistency
    data.settings = data.guildSettings;
    data.forms = data.ticketForms;

    return data;
}

function start(botClient) {
    const app = express();
    const port = process.env.DASHBOARD_PORT || 3001;

    app.use(express.static(path.join(__dirname, 'public')));

    const redisClient = new Redis({ host: process.env.REDIS_HOST, port: process.env.REDIS_PORT, password: process.env.REDIS_PASSWORD });
    redisClient.on('error', (err) => logger.error('[Cache] Redis connection error:', { error: err.message }));
    redisClient.on('connect', () => logger.info('[Cache] Connected to Redis.'));

    app.use(session({ store: new RedisStore({ client: redisClient, prefix: "livebot:session:" }), secret: process.env.SESSION_SECRET || 'keyboard cat', resave: false, saveUninitialized: false, cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 1000 * 60 * 60 * 24 } }));

    app.use(passport.initialize());
    app.use(passport.session());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    const checkAuth = (req, res, next) => req.isAuthenticated() ? next() : res.redirect('/login');

    const checkGuildAdmin = async (req, res, next) => {
        if (!req.user || !req.user.guilds) return res.redirect('/login');
        const guildMeta = req.user.guilds.find(g => g.id === req.params.guildId);
        if (guildMeta && new PermissionsBitField(BigInt(guildMeta.permissions)).has(PermissionsBitField.Flags.ManageGuild) && botClient.guilds.cache.has(req.params.guildId)) {
            req.guildObject = await botClient.guilds.fetch(req.params.guildId).catch(() => null);
            if (!req.guildObject) return res.status(404).render('error', { user: getSanitizedUser(req), error: 'Bot is not in this guild or it could not be fetched.' });
            return next();
        }
        res.status(403).render('error', { user: getSanitizedUser(req), error: 'You do not have permissions for this server or the bot is not in it.' });
    };

    const checkSuperAdmin = (req, res, next) => {
        if (req.isAuthenticated() && req.user && req.user.isSuperAdmin) return next();
        res.status(403).render('error', { user: getSanitizedUser(req), error: 'You do not have super admin privileges.' });
    };

    // Page Routes
    app.get('/', (req, res) => res.render('landing', { user: getSanitizedUser(req), client_id: process.env.DASHBOARD_CLIENT_ID }));
    app.get('/login', passport.authenticate('discord', { scope: ['identify', 'guilds'] }));
    app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));
    app.get('/logout', (req, res, next) => { req.logout(err => { if (err) { return next(err); } res.redirect('/'); }); });

    app.get('/dashboard', checkAuth, (req, res) => {
        const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && botClient.guilds.cache.has(g.id));
        res.render('dashboard', { user: getSanitizedUser(req), manageableGuilds });
    });

    app.get('/servers', checkAuth, (req, res) => {
        const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && botClient.guilds.cache.has(g.id));
        res.render('servers', { user: getSanitizedUser(req), guilds: manageableGuilds });
    });

    app.get('/commands', (req, res) => {
        // FIX: Ensure botClient.commands is an iterable and filter out any malformed commands
        const commands = Array.isArray(botClient.commands) ? botClient.commands.filter(cmd => cmd && cmd.name) : [];
        res.render('commands', { user: getSanitizedUser(req), commands });
    });
    app.get('/status', (req, res) => res.render('status', { user: getSanitizedUser(req) }));
    app.get('/donate', (req, res) => res.render('donate', { user: getSanitizedUser(req) }));

    app.get('/manage/:guildId/:page?', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const page = req.params.page || 'streamers';
            const data = await getManagePageData(req.params.guildId, req.guildObject);
            res.render('manage', { ...data, user: getSanitizedUser(req), guild: sanitizeGuild(req.guildObject), page });
        } catch (error) {
            logger.error(`[CRITICAL] Error rendering manage page:`, { guildId: req.params.guildId, error: error.message, stack: error.stack });
            res.status(500).render('error', { user: getSanitizedUser(req), error: 'Critical error loading server data.' });
        }
    });

    // Music Configuration Update Route
    app.post('/manage/:guildId/music/config', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { enabled, djRoleId } = req.body;

        const musicEnabled = enabled === 'on' ? 1 : 0;
        const musicDjRoleId = djRoleId || null;

        try {
            await db.execute(
                `INSERT INTO music_config (guild_id, enabled, dj_role_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), dj_role_id = VALUES(dj_role_id)`,
                [guildId, musicEnabled, musicDjRoleId]
            );
            logger.info(`[Dashboard] Music config updated for guild ${guildId}. Enabled: ${musicEnabled}, DJ Role: ${musicDjRoleId}`, { guildId, category: 'music' });
            res.redirect(`/manage/${guildId}/music?success=Music settings updated successfully.`);
        } catch (error) {
            logger.error(`[Dashboard] Failed to update music config for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: 'music' });
            res.redirect(`/manage/${guildId}/music?error=Failed to update music settings.`);
        }
    });

    // DEFINITIVE FIX: Add route for updating channel webhook overrides
    app.post('/manage/:guildId/update-channel-webhooks', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { channel_webhooks } = req.body;

        if (!channel_webhooks || typeof channel_webhooks !== 'object') {
            return res.redirect(`/manage/${guildId}/logging?error=Invalid data submitted.`);
        }

        try {
            const promises = Object.entries(channel_webhooks).map(([channelId, webhookUrl]) => {
                const urlToSave = webhookUrl.trim() || null;
                return db.execute(
                    `INSERT INTO channel_settings (guild_id, channel_id, webhook_url)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE webhook_url = VALUES(webhook_url)`,
                    [guildId, channelId, urlToSave]
                );
            });

            await Promise.all(promises);
            logger.info(`[Dashboard] Channel webhook overrides updated for guild ${guildId}.`, { guildId, category: 'dashboard' });
            res.redirect(`/manage/${guildId}/logging?success=Webhook overrides saved successfully.`);
        } catch (error) {
            logger.error(`[Dashboard] Failed to update webhook overrides for guild ${guildId}:`, { guildId, error: error.message, stack: error.stack, category: 'dashboard' });
            res.redirect(`/manage/${guildId}/logging?error=Failed to save webhook overrides.`);
        }
    });

    app.get('/super-admin', checkAuth, checkSuperAdmin, (req, res) => res.render('super-admin', { user: getSanitizedUser(req) }));

    // All other API routes are assumed to be here...

    // Fallback error handlers
    app.use((req, res) => res.status(404).render('error', { user: getSanitizedUser(req), error: 'Page Not Found' }));
    app.use((err, req, res, next) => {
        logger.error('Unhandled Express Error', { error: err.stack, path: req.path });
        res.status(500).render('error', { user: getSanitizedUser(req), error: 'An internal server error occurred.' });
    });

    app.listen(port, () => logger.info(`[Dashboard] Web dashboard listening on port ${port}`)).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            logger.error(`[Dashboard] Port ${port} is already in use.`);
            process.exit(1);
        }
    });
}

module.exports = { start };
