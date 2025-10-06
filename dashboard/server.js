const express = require('express');
const session = require('express-session');
const passport = require('passport');
require('./passport-setup');
const path = require('path');
const fs = require('fs');
const db = require('../utils/db');
const cache = require('../utils/cache');
const apiChecks = require('../utils/api_checks.js');
const multer = require('multer');
const { PermissionsBitField, ChannelType } = require('discord.js');
const Papa = require('papaparse');
const { syncTwitchTeam } = require('../core/team-sync');
const logger = require('../utils/logger');
const { invalidateCommandCache } = require('../core/custom-command-handler');

async function getManagePageData(guildId, botGuild) {
    logger.info(`[DIAGNOSTIC] getManagePageData is executing for guild ${guildId}.`);
    const [
        [allSubscriptions], [guildSettingsResult], [channelSettingsResult],
        allRolesCollection, allChannelsCollection, [rawTeamSubscriptions],
        [automodRules], [[heatConfig]], [[antiNukeConfig]],
        [backups], [[joinGateConfig]], [[welcomeSettings]], [customCommands],
        [[ticketConfig]],
        [[autoPublisherConfig]],
        [[autorolesConfig]],
        [[logConfig]],
        [redditFeeds],
        [youtubeFeeds],
        [twitterFeeds],
        [[moderationConfig]],
        [recentInfractions],
        [escalationRules],
        [roleRewards],
        [[tempChannelConfig]],
        [serverStats],
        [[antiRaidConfig]],
        [tags],
        [[starboardConfig]],
        [reactionRolePanels],
        [actionLogs]
    ] = await Promise.all([
        db.execute(`SELECT sub.*, s.platform, s.username, s.discord_user_id, s.streamer_id, s.platform_user_id, s.profile_image_url FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? ORDER BY s.username`, [guildId]),
        db.execute('SELECT * FROM guilds WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM channel_settings WHERE guild_id = ?', [guildId]),
        botGuild.roles.fetch(),
        botGuild.channels.fetch(),
        db.execute('SELECT * FROM twitch_teams WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM automod_rules WHERE guild_id = ? ORDER BY id', [guildId]),
        db.execute('SELECT * FROM automod_heat_config WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM antinuke_config WHERE guild_id = ?', [guildId]),
        db.execute('SELECT id, snapshot_name, created_at FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC', [guildId]),
        db.execute('SELECT * FROM join_gate_config WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM welcome_settings WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM custom_commands WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM ticket_config WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM auto_publisher_config WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM autoroles_config WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM log_config WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM reddit_feeds WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM youtube_feeds WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM twitter_feeds WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM moderation_config WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM infractions WHERE guild_id = ? ORDER BY created_at DESC LIMIT 10', [guildId]),
        db.execute('SELECT * FROM escalation_rules WHERE guild_id = ? ORDER BY infraction_count ASC', [guildId]),
        db.execute('SELECT * FROM role_rewards WHERE guild_id = ? ORDER BY level ASC', [guildId]),
        db.execute('SELECT * FROM temp_channel_config WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM server_stats WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM anti_raid_config WHERE guild_id = ?', [guildId]),
        db.execute(`
            SELECT t.id, t.tag_name, t.tag_content, t.creator_id, u.username as creator_tag
            FROM tags t
            LEFT JOIN (SELECT DISTINCT user_id, username FROM user_levels) u ON t.creator_id = u.user_id
            WHERE t.guild_id = ? ORDER BY t.tag_name ASC
        `, [guildId]),
        db.execute('SELECT * FROM starboard_config WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM reaction_role_panels WHERE guild_id = ?', [guildId]),
        db.execute('SELECT * FROM action_logs WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 50', [guildId])
    ]) .then(async results => { // Added 'async' here
        // Destructure results here
        const [
            allSubscriptions, guildSettingsResult, channelSettingsResult,
            allRolesCollection, allChannelsCollection, rawTeamSubscriptions,
            automodRules, heatConfig, antiNukeConfig,
            backups, joinGateConfig, welcomeSettings, customCommands,
            ticketConfig, autoPublisherConfig, autorolesConfig,
            logConfig, redditFeeds, youtubeFeeds, twitterFeeds,
            moderationConfig, recentInfractions, escalationRules,
            roleRewards, tempChannelConfig, serverStats, antiRaidConfig, tags, starboardConfig, reactionRolePanels, actionLogs
        ] = results;

        // Fetch mappings for each panel
        for (const panel of reactionRolePanels) {
            const [mappings] = await db.execute('SELECT * FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);
            panel.mappings = mappings;
        }

        const consolidatedStreamers = {};
        allSubscriptions.forEach(sub => {
            const key = sub.discord_user_id || sub.username.toLowerCase();
            if (!consolidatedStreamers[key]) {
                consolidatedStreamers[key] = { name: sub.username, discord_user_id: sub.discord_user_id, platforms: [], subscriptions: [] };
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

        const dataToReturn = {
            totalSubscriptions: allSubscriptions.length,
            consolidatedStreamers: Object.values(consolidatedStreamers),
            settings: guildSettingsResult[0] || {},
            channelSettings: channelSettingsResult,
            roles: allRolesCollection.filter(r => !r.managed && r.name !== '@everyone').map(r => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name)),
            channels: allChannelsCollection.filter(c => c.isTextBased()).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
            categories: allChannelsCollection.filter(c => c.type === ChannelType.GuildCategory).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
            voiceChannels: allChannelsCollection.filter(c => c.type === ChannelType.GuildVoice).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
            teamSubscriptions,
            automodRules,
            heatConfig: heatConfig ? { ...heatConfig, heat_values: JSON.parse(heatConfig.heat_values || '{}'), action_thresholds: JSON.parse(heatConfig.action_thresholds || '[]') } : null,
            antiNukeConfig: antiNukeConfig ? { ...antiNukeConfig, action_thresholds: JSON.parse(antiNukeConfig.action_thresholds || '{}')} : null,
            backups,
            joinGateConfig: joinGateConfig[0] || null,
            welcomeSettings: welcomeSettings[0] || null,
            customCommands,
            ticketConfig: ticketConfig[0] || null,
            autoPublisherConfig: autoPublisherConfig[0] || null,
            autorolesConfig: autorolesConfig[0] || null,
            logConfig: logConfig[0] || null,
            redditFeeds: redditFeeds || [],
            youtubeFeeds: youtubeFeeds || [],
            twitterFeeds: twitterFeeds || [],
            moderationConfig: moderationConfig[0] || null,
            recentInfractions: recentInfractions || [],
            escalationRules: escalationRules || [],
            roleRewards: roleRewards || [],
            tempChannelConfig: tempChannelConfig || null,
            serverStats: serverStats || [],
            antiRaidConfig: antiRaidConfig[0] || null,
            tags: tags || [],
            starboardConfig: starboardConfig || null,
            reactionRolePanels: reactionRolePanels || [],
            actionLogs: actionLogs || []
        };
        logger.info(`[DIAGNOSTIC] Returning data.`);
        return dataToReturn;
    });
}

function start(botClient) {
    client = botClient;
    const app = express();
    const port = process.env.DASHBOARD_PORT || 3000;

    app.use(session({ secret: process.env.SESSION_SECRET || 'keyboard cat', resave: false, saveUninitialized: false }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static(path.join(__dirname, 'public')));
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

    app.get('/', (req, res) => {
        if (req.isAuthenticated()) {
            return res.redirect('/servers');
        }
        res.render('index', {
            user: null,
            client_id: process.env.DASHBOARD_CLIENT_ID
        });
    });
    app.get('/login', passport.authenticate('discord', { scope: ['identify', 'guilds'] }));
    app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/servers'));
    app.get('/logout', (req, res, next) => { req.logout(err => { if (err) return next(err); res.redirect('/'); }); });

    app.get('/servers', checkAuth, (req, res) => {
        const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(g.id));
        res.render('servers', { user: req.user, guilds: manageableGuilds });
    });

    // app.get('/premium', (req, res) => {
    //     res.render('premium', { user: req.user });
    // });

    app.get('/manage/:guildId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const data = await getManagePageData(req.params.guildId, req.guildObject);
            res.render('manage', {
                user: req.user,
                guild: req.guildObject,
                ...data
            });
        } catch (error) {
            logger.error(`[CRITICAL] Error in /manage/:guildId route:`, error);
            res.status(500).render('error', { user: req.user, error: 'Critical error loading server data.' });
        }
    });

    app.post('/manage/:guildId/update-starboard', checkAuth, checkGuildAdmin, async (req, res) => {
        const { channel_id, star_threshold } = req.body;
        
        if (!channel_id) {
            await db.execute('DELETE FROM starboard_config WHERE guild_id = ?', [req.params.guildId]);
        } else {
            await db.execute(
                'INSERT INTO starboard_config (guild_id, channel_id, star_threshold) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), star_threshold = VALUES(star_threshold)',
                [req.params.guildId, channel_id, star_threshold || 3]
            );
        }
        res.redirect(`/manage/${req.params.guildId}#starboard-tab`);
    });

    app.post('/manage/:guildId/update-tickets', checkAuth, checkGuildAdmin, async (req, res) => {
        const { panel_channel_id, ticket_category_id, support_role_id } = req.body;
        const guildId = req.params.guildId;

        await db.execute(
            `INSERT INTO ticket_config (guild_id, panel_channel_id, ticket_category_id, support_role_id)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                panel_channel_id = VALUES(panel_channel_id),
                ticket_category_id = VALUES(ticket_category_id),
                support_role_id = VALUES(support_role_id)`,
            [guildId, panel_channel_id || null, ticket_category_id || null, support_role_id || null]
        );

        res.redirect(`/manage/${guildId}#tickets-tab`);
    });

    app.post('/manage/:guildId/update-antiraid', checkAuth, checkGuildAdmin, async (req, res) => {
        const { join_limit, time_period_seconds, action, is_enabled } = req.body;
        await db.execute(
            'INSERT INTO anti_raid_config (guild_id, join_limit, time_period_seconds, action, is_enabled) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE join_limit = VALUES(join_limit), time_period_seconds = VALUES(time_period_seconds), action = VALUES(action), is_enabled = VALUES(is_enabled)',
            [req.params.guildId, join_limit, time_period_seconds, action, is_enabled === 'on' ? 1 : 0]
        );
        res.redirect(`/manage/${req.params.guildId}#security-tab`);
    });

    app.post('/manage/:guildId/update-security', checkAuth, checkGuildAdmin, async (req, res) => {
        const {
            is_enabled, action, action_duration_minutes, min_account_age_days, block_default_avatar,
            verification_enabled, verification_role_id
        } = req.body;
        const guildId = req.params.guildId;

        // Update the join_gate_config with the new verification settings
        await db.execute(
            `INSERT INTO join_gate_config (guild_id, is_enabled, action, action_duration_minutes, min_account_age_days, block_default_avatar, verification_enabled, verification_role_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                is_enabled = VALUES(is_enabled), action = VALUES(action), action_duration_minutes = VALUES(action_duration_minutes),
                min_account_age_days = VALUES(min_account_age_days), block_default_avatar = VALUES(block_default_avatar),
                verification_enabled = VALUES(verification_enabled), verification_role_id = VALUES(verification_role_id)`,
            [guildId, is_enabled === 'on' ? 1 : 0, action, action_duration_minutes || null, min_account_age_days || null, block_default_avatar === 'on' ? 1 : 0, verification_enabled === 'on' ? 1 : 0, verification_role_id || null]
        );

        res.redirect(`/manage/${req.params.guildId}#security-tab`);
    });

    app.post('/manage/:guildId/update-welcome', checkAuth, checkGuildAdmin, async (req, res) => {
        const {
            channel_id, message, card_enabled, card_background_url,
            card_title_text, card_subtitle_text, card_title_color,
            card_username_color, card_subtitle_color,
            goodbye_enabled, goodbye_channel_id, goodbye_message
        } = req.body;

        await db.execute(
            `INSERT INTO welcome_settings (guild_id, channel_id, message, card_enabled, card_background_url, card_title_text, card_subtitle_text, card_title_color, card_username_color, card_subtitle_color, goodbye_enabled, goodbye_channel_id, goodbye_message)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                channel_id=VALUES(channel_id), message=VALUES(message), card_enabled=VALUES(card_enabled),
                card_background_url=VALUES(card_background_url), card_title_text=VALUES(card_title_text),
                card_subtitle_text=VALUES(card_subtitle_text), card_title_color=VALUES(card_title_color),
                card_username_color=VALUES(card_username_color), card_subtitle_color=VALUES(card_subtitle_color),
                goodbye_enabled=VALUES(goodbye_enabled), goodbye_channel_id=VALUES(goodbye_channel_id), goodbye_message=VALUES(goodbye_message)`,
            [
                req.params.guildId, channel_id || null, message, card_enabled === 'on' ? 1 : 0,
                card_background_url, card_title_text, card_subtitle_text, card_title_color,
                card_username_color, card_subtitle_color,
                goodbye_enabled === 'on' ? 1 : 0, goodbye_channel_id || null, goodbye_message
            ]
        );
        res.redirect(`/manage/${req.params.guildId}#welcome-tab`);
    });

    // Add new routes for saving the utility settings
    app.post('/manage/:guildId/update-autopublisher', checkAuth, checkGuildAdmin, async (req, res) => {
        const { is_enabled } = req.body;
        await db.execute(
            'INSERT INTO auto_publisher_config (guild_id, is_enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)',
            [req.params.guildId, is_enabled === 'on' ? 1 : 0]
        );
        res.redirect(`/manage/${req.params.guildId}#utilities-tab`);
    });

    app.post('/manage/:guildId/update-autoroles', checkAuth, checkGuildAdmin, async (req, res) => {
        const { is_enabled, roles_to_assign } = req.body;
        const roles = roles_to_assign ? (Array.isArray(roles_to_assign) ? roles_to_assign : [roles_to_assign]) : [];

        await db.execute(
            'INSERT INTO autoroles_config (guild_id, is_enabled, roles_to_assign) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), roles_to_assign = VALUES(roles_to_assign)',
            [req.params.guildId, is_enabled === 'on' ? 1 : 0, JSON.stringify(roles)]
        );
        res.redirect(`/manage/${req.params.guildId}#utilities-tab`);
    });

    // Add the new route for saving sticky role settings
    app.post('/manage/:guildId/update-stickyroles', checkAuth, checkGuildAdmin, async (req, res) => {
        const { sticky_roles_enabled } = req.body;
        await db.execute(
            `UPDATE guilds SET sticky_roles_enabled = ? WHERE guild_id = ?`,
            [sticky_roles_enabled === 'on' ? 1 : 0, req.params.guildId]
        );
        res.redirect(`/manage/${req.params.guildId}#utilities-tab`);
    });

    app.post('/manage/:guildId/update-logging', checkAuth, checkGuildAdmin, async (req, res) => {
        const { log_channel_id, enabled_logs } = req.body;
        const logs = enabled_logs ? (Array.isArray(enabled_logs) ? enabled_logs : [enabled_logs]) : [];

        await db.execute(
            'INSERT INTO log_config (guild_id, log_channel_id, enabled_logs) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), enabled_logs = VALUES(enabled_logs)',
            [req.params.guildId, log_channel_id || null, JSON.stringify(logs)]
        );
        res.redirect(`/manage/${req.params.guildId}#logging-tab`);
    });

    // Add the new routes for managing Reddit feeds
    app.post('/manage/:guildId/add-reddit-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const { subreddit, channel_id } = req.body;
        try {
            await db.execute('INSERT INTO reddit_feeds (guild_id, subreddit, channel_id) VALUES (?, ?, ?)', [req.params.guildId, subreddit.toLowerCase(), channel_id]);
        } catch (e) {
            // Ignore duplicate entry errors
        }
        res.redirect(`/manage/${req.params.guildId}#feeds-tab`);
    });

    app.post('/manage/:guildId/remove-reddit-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const { feedId } = req.body;
        await db.execute('DELETE FROM reddit_feeds WHERE id = ? AND guild_id = ?', [feedId, req.params.guildId]);
        res.redirect(`/manage/${req.params.guildId}#feeds-tab`);
    });

    // Add the new routes for managing YouTube feeds
    app.post('/manage/:guildId/add-youtube-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const { youtube_channel_id, discord_channel_id } = req.body;
        if (youtube_channel_id.startsWith('UC')) {
            try {
                await db.execute('INSERT INTO youtube_feeds (guild_id, youtube_channel_id, discord_channel_id) VALUES (?, ?, ?)', [req.params.guildId, youtube_channel_id, discord_channel_id]);
            } catch (e) {}
        }
        res.redirect(`/manage/${req.params.guildId}#feeds-tab`);
    });

    app.post('/manage/:guildId/remove-youtube-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const { feedId } = req.body;
        await db.execute('DELETE FROM youtube_feeds WHERE id = ? AND guild_id = ?', [feedId, req.params.guildId]);
        res.redirect(`/manage/${req.params.guildId}#feeds-tab`);
    });

    // Add the new routes for managing Twitter feeds
    app.post('/manage/:guildId/add-twitter-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const { twitter_username, channel_id } = req.body;
        try {
            await db.execute('INSERT INTO twitter_feeds (guild_id, twitter_username, channel_id) VALUES (?, ?, ?)', [req.params.guildId, twitter_username.toLowerCase(), channel_id]);
        } catch (e) {}
        res.redirect(`/manage/${req.params.guildId}#feeds-tab`);
    });

    app.post('/manage/:guildId/remove-twitter-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const { feedId } = req.body;
        await db.execute('DELETE FROM twitter_feeds WHERE id = ? AND guild_id = ?', [feedId, req.params.guildId]);
        res.redirect(`/manage/${req.params.guildId}#feeds-tab`);
    });

    app.post('/manage/:guildId/update-moderation', checkAuth, checkGuildAdmin, async (req, res) => {
        const { mod_log_channel_id, muted_role_id } = req.body;
        await db.execute(
            'INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE mod_log_channel_id = VALUES(mod_log_channel_id), muted_role_id = VALUES(muted_role_id)',
            [req.params.guildId, mod_log_channel_id || null, muted_role_id || null]
        );
        res.redirect(`/manage/${req.params.guildId}#moderation-tab`);
    });

    app.post('/manage/:guildId/add-escalation-rule', checkAuth, checkGuildAdmin, async (req, res) => {
        const { infraction_count, time_period_hours, action, action_duration_minutes } = req.body;
        await db.execute(
            'INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action, action_duration_minutes) VALUES (?, ?, ?, ?, ?)',
            [req.params.guildId, infraction_count, time_period_hours, action, action === 'mute' ? action_duration_minutes : null]
        );
        res.redirect(`/manage/${req.params.guildId}#moderation-tab`);
    });

    app.post('/manage/:guildId/remove-escalation-rule', checkAuth, checkGuildAdmin, async (req, res) => {
        const { ruleId } = req.body;
        await db.execute('DELETE FROM escalation_rules WHERE id = ? AND guild_id = ?', [ruleId, req.params.guildId]);
        res.redirect(`/manage/${req.params.guildId}#moderation-tab`);
    });

    // Add the new routes for leveling and role rewards
    app.post('/manage/:guildId/update-leveling', checkAuth, checkGuildAdmin, async (req, res) => {
        const { leveling_enabled, leveling_xp_rate, leveling_xp_cooldown, leveling_ignored_channels, leveling_ignored_roles } = req.body;
        const ignoredChannels = leveling_ignored_channels ? (Array.isArray(leveling_ignored_channels) ? leveling_ignored_channels : [leveling_ignored_channels]) : [];
        const ignoredRoles = leveling_ignored_roles ? (Array.isArray(leveling_ignored_roles) ? leveling_ignored_roles : [leveling_ignored_roles]) : [];

        await db.execute(
            `UPDATE guilds SET leveling_enabled = ?, leveling_xp_rate = ?, leveling_xp_cooldown = ?, leveling_ignored_channels = ?, leveling_ignored_roles = ? WHERE guild_id = ?`,
            [leveling_enabled === 'on' ? 1 : 0, leveling_xp_rate, leveling_xp_cooldown, JSON.stringify(ignoredChannels), JSON.stringify(ignoredRoles), req.params.guildId]
        );
        res.redirect(`/manage/${req.params.guildId}#leveling-tab`);
    });

    app.post('/manage/:guildId/add-role-reward', checkAuth, checkGuildAdmin, async (req, res) => {
        const { level, role_id } = req.body;
        await db.execute(
            'INSERT INTO role_rewards (guild_id, level, role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)',
            [req.params.guildId, level, role_id]
        );
        res.redirect(`/manage/${req.params.guildId}#leveling-tab`);
    });

    app.post('/manage/:guildId/remove-role-reward', checkAuth, checkGuildAdmin, async (req, res) => {
        const { rewardId } = req.body;
        await db.execute('DELETE FROM role_rewards WHERE id = ? AND guild_id = ?', [rewardId, req.params.guildId]);
        res.redirect(`/manage/${req.params.guildId}#leveling-tab`);
    });

    app.post('/manage/:guildId/add-custom-command', checkAuth, checkGuildAdmin, async (req, res) => {
        const { command_name, response, action_type, action_content } = req.body;
        await db.execute(
            'INSERT INTO custom_commands (guild_id, command_name, response, action_type, action_content) VALUES (?, ?, ?, ?, ?)',
            [req.params.guildId, command_name.toLowerCase(), response, action_type, action_content || null]
        );
        invalidateCommandCache(req.params.guildId, command_name);
        res.redirect(`/manage/${req.params.guildId}#custom-commands-tab`);
    });

    app.post('/manage/:guildId/remove-custom-command', checkAuth, checkGuildAdmin, async (req, res) => {
        const { command_name } = req.body;
        await db.execute('DELETE FROM custom_commands WHERE guild_id = ? AND command_name = ?', [guildId, command_name]);
        invalidateCommandCache(guildId);

        res.redirect(`/manage/${guildId}#custom-commands-tab`);
    });

// Add a new route for adding automod rules
app.post('/manage/:guildId/add-automod-rule', checkAuth, checkGuildAdmin, async (req, res) => {
    const { filter_type, action, action_duration_minutes } = req.body;
    let config = {};

    if (filter_type === 'bannedWords') {
        config.banned_words = req.body.config_banned_words.split(',').map(w => w.trim()).filter(Boolean);
    } else if (filter_type === 'massMention') {
        config.limit = parseInt(req.body.config_massMention_limit) || 5;
    } else if (filter_type === 'allCaps') {
        config.limit = parseInt(req.body.config_allCaps_limit) || 70;
    } 
    else if (filter_type === 'antiSpam') { // Add this block
        config.message_limit = parseInt(req.body.config_antiSpam_message_limit) || 5;
        config.time_period = parseInt(req.body.config_antiSpam_time_period) || 10;
    }

    await db.execute(
        'INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes) VALUES (?, ?, ?, ?, ?)',
        [req.params.guildId, filter_type, JSON.stringify(config), action, action === 'mute' ? action_duration_minutes : null]
    );

    res.redirect(`/manage/${req.params.guildId}#automod-tab`);
});

// Add a new route for deleting automod rules
app.post('/manage/:guildId/delete-automod-rule', checkAuth, checkGuildAdmin, async (req, res) => {
    const { ruleId } = req.body;
    await db.execute('DELETE FROM automod_rules WHERE id = ? AND guild_id = ?', [ruleId, req.params.guildId]);
    res.redirect(`/manage/${req.params.guildId}#automod-tab`);
});

    app.post('/manage/:guildId/update-tempchannels', checkAuth, checkGuildAdmin, async (req, res) => {
        const { creator_channel_id, category_id, naming_template } = req.body;

        if (!creator_channel_id || !category_id) { // If disabled
            await db.execute('DELETE FROM temp_channel_config WHERE guild_id = ?', [req.params.guildId]);
        } else {
            await db.execute(
                'INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE creator_channel_id = VALUES(creator_channel_id), category_id = VALUES(category_id), naming_template = VALUES(naming_template)',
                [req.params.guildId, creator_channel_id, category_id, naming_template]
            );
        }
        res.redirect(`/manage/${req.params.guildId}#utilities-tab`);
    });

    app.get('/help', (req, res) => res.render('commands', { user: req.user }));
    app.get('/donate', (req, res) => res.render('donate', { user: req.user }));
    app.get('/status', (req, res) => res.render('status', { user: req.user, isAuthenticated: req.isAuthenticated() }));

    app.get('/api/status-data', async (req, res) => {
        try {
            const [[liveCountResult]] = await db.execute('SELECT COUNT(*) as count FROM live_streams');
            const [[totalStreamersResult]] = await db.execute('SELECT COUNT(DISTINCT streamer_id) FROM streamers');
            const [platformDistributionResult] = await db.execute('SELECT platform, COUNT(*) as count FROM streamers GROUP BY platform');
            const [liveStreamersRows] = await db.execute(`
                SELECT s.username, s.profile_image_url as avatar_url, ls.platform, ls.stream_url as url
                FROM live_streams ls
                JOIN streamers s ON ls.streamer_id = s.streamer_id
                ORDER BY s.username
            `);

            const liveStreamersMap = new Map();
            for (const row of liveStreamersRows) {
                if (!liveStreamersMap.has(row.username)) {
                    liveStreamersMap.set(row.username, {
                        username: row.username,
                        avatar_url: row.avatar_url,
                        live_platforms: []
                    });
                }
                liveStreamersMap.get(row.username).live_platforms.push({
                    platform: row.platform,
                    url: row.url
                });
            }
            const liveStreamers = Array.from(liveStreamersMap.values());

            let announcementCount = 0;
            try {
                const [[announcementCountResult]] = await db.execute('SELECT total_announcements FROM global_stats WHERE id = 1');
                if (announcementCountResult) {
                    announcementCount = announcementCountResult.total_announcements;
                }
            } catch (e) {
                logger.warn('Could not retrieve total_announcements from global_stats. Defaulting to 0.');
            }

            const data = {
                liveCount: liveCountResult.count,
                totalStreamers: totalStreamersResult['COUNT(DISTINCT streamer_id)'],
                totalGuilds: client.guilds.cache.size,
                totalAnnouncements: announcementCount,
                liveStreamers,
                platformDistribution: platformDistributionResult
            };

            if (req.isAuthenticated() && req.user.isSuperAdmin) {
                data.app = {
                    status: 'online',
                    uptime: `${Math.floor(process.uptime() / 86400)}d ${Math.floor(process.uptime() % 86400 / 3600)}h ${Math.floor(process.uptime() % 3600 / 60)}m`
                };
                try {
                    await db.execute('SELECT 1');
                    data.db = { status: 'ok' };
                } catch (e) {
                    data.db = { status: 'error' };
                }
                data.api = { twitch: await apiChecks.getTwitchApiStatus().catch(() => 'error') };
            }

            res.json(data);
        } catch (error) {
            logger.error('Error fetching status data:', error);
            res.status(500).json({ error: 'Failed to fetch status data' });
        }
    });

    app.post('/manage/:guildId/delete-tag', checkAuth, checkGuildAdmin, async (req, res) => {
        const { tagId } = req.body;
        await db.execute('DELETE FROM tags WHERE id = ? AND guild_id = ?', [tagId, req.params.guildId]);
        res.redirect(`/manage/${req.params.guildId}#tags-tab`);
    });

    app.get('/api/authenticated-logs', checkAuth, (req, res) => {
        if (!req.user.isSuperAdmin) return res.status(403).json({ error: 'Forbidden' });

        const logPath = path.join(__dirname, '..\\', 'logs', 'app.log');
        fs.readFile(logPath, 'utf8', (err, data) => {
            if (err) {
                logger.error('Failed to read log file:', err);
                return res.status(500).json({ error: 'Could not read logs.' });
            }
            const logs = data.split('\\n').slice(-200).join('\\n');
            res.json({ logs });
        });
    });

    app.post('/api/admin/reinit-bot', checkAuth, (req, res) => {
        if (!req.user.isSuperAdmin) return res.status(4e3).json({ error: 'Forbidden' });

        logger.warn(`[ADMIN] Bot re-initialization requested by ${req.user.username}`);
        res.json({ success: true, message: 'Re-initialization command sent. The bot will restart shortly.' });

        setTimeout(() => process.exit(0), 1000);
    });

    app.use((req, res) => res.status(404).render('error', { user: req.user, error: 'Page Not Found' }));

    app.listen(port, () => logger.info(`[Dashboard] Web dashboard listening on port ${port}`));

    // Add these new routes for managing reaction roles from the dashboard

    app.post('/manage/:guildId/create-rr-panel', checkAuth, checkGuildAdmin, async (req, res) => {
        const { panel_name, channel_id, panel_mode, message_content } = req.body;
        const channel = await client.channels.fetch(channel_id);
        const panelMessage = await channel.send(message_content);
        
        const [result] = await db.execute('INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, panel_mode) VALUES (?, ?, ?, ?, ?)', [req.params.guildId, channel_id, panelMessage.id, panel_name, panel_mode]);
        res.redirect(`/manage/${req.params.guildId}#reaction-roles-tab`);
    });

    app.post('/manage/:guildId/add-rr-mapping', checkAuth, checkGuildAdmin, async (req, res) => {
        const { panelId, emoji_id, role_id } = req.body;
        // Extract emoji from string if it's a custom emoji
        const emojiIdentifier = emoji_id.match(/<a?:.+:(\d+)>$/)?.[1] || emoji_id;

        await db.execute('INSERT INTO reaction_role_mappings (panel_id, emoji_id, role_id) VALUES (?, ?, ?)', [panelId, emojiIdentifier, role_id]);
        
        // Also add the reaction to the message
        const [[panel]] = await db.execute('SELECT channel_id, message_id FROM reaction_role_panels WHERE id = ?', [panelId]);
        const channel = await client.channels.fetch(panel.channel_id);
        const message = await channel.messages.fetch(panel.message_id);
        await message.react(emoji_id);

        res.redirect(`/manage/${req.params.guildId}#reaction-roles-tab`);
    });

    app.post('/manage/:guildId/remove-rr-mapping', checkAuth, checkGuildAdmin, async (req, res) => {
        const { mappingId } = req.body;
        await db.execute('DELETE FROM reaction_role_mappings WHERE id = ?', [mappingId]);
        res.redirect(`/manage/${req.params.guildId}#reaction-roles-tab`);
    });
}

module.exports = { start };