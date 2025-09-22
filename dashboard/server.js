const express = require('express');
const session = require('express-session');
const passport = require('passport');
require('./passport-setup');
const path = require('path');
const fs = require('fs');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const multer = require('multer');
const { PermissionsBitField } = require('discord.js');

const upload = multer({ dest: 'uploads/' });
const app = express();
const port = process.env.DASHBOARD_PORT || 3000;
let client;

// A helper function to get a default Discord avatar
const getDefaultAvatar = (discriminator) => {
    return `https://cdn.discordapp.com/embed/avatars/${discriminator % 5}.png`;
};

function start(botClient) {
    client = botClient;
    if (!process.env.SESSION_SECRET) {
        console.error("[Dashboard] FATAL: SESSION_SECRET is not defined in the environment variables.");
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
            console.error('[checkGuildAdmin Middleware Error]', e);
            const isApiRequest = req.path.startsWith('/api/');
            if (isApiRequest) {
                return res.status(500).json({ error: true, message: 'An unexpected error occurred while checking permissions.' });
            }
            res.status(500).render('error', { user: req.user, error: 'An unexpected error occurred while checking permissions.'});
        }
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

    app.get('/manage/:guildId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const botGuild = req.guildObject;
            const guildId = botGuild.id;
            const [[subscriptions], [guildSettingsResult], [channelSettingsResult], allRoles, allChannels, [teamSubscriptions]] = await Promise.all([
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
                if (!channelsData[channelId]) { channelsData[channelId] = { name: channelId === 'default' ? 'Server Default' : allChannelsMap.get(channelId) || 'Unknown Channel', streamers: [], teams: [] }; }
                channelsData[channelId].streamers.push(sub);
            }
            for (const teamSub of teamSubscriptions) {
                const channelId = teamSub.announcement_channel_id;
                if (!channelsData[channelId]) { channelsData[channelId] = { name: allChannelsMap.get(channelId) || 'Unknown Channel', streamers: [], teams: [] }; }
                channelsData[channelId].teams.push(teamSub);
            }
            res.render('manage', {
                guild: botGuild, channelsData: channelsData, totalSubscriptions: subscriptions.length, user: req.user,
                settings: guildSettingsResult[0] || {}, channelSettings: channelSettingsResult,
                roles: allRoles.filter(r => !r.managed && r.name !== '@everyone'),
                channels: allChannels.filter(c => c.isTextBased()), teamSubscriptions: teamSubscriptions
            });
        } catch (error) { console.error('[Dashboard GET Error]', error); res.status(500).render('error', { user: req.user, error: 'Error loading management page.' }); }
    });

    app.post('/manage/:guildId/settings', checkAuth, checkGuildAdmin, async (req, res) => {
        const { channelId, roleId } = req.body;
        await db.execute('INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = ?, live_role_id = ?', [req.params.guildId, channelId || null, roleId || null, channelId || null, roleId || null]);
        res.redirect(`/manage/${req.params.guildId}?success=settings`);
    });

    app.post('/manage/:guildId/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const { platform, username } = req.body;
        let streamerInfo = { puid: username, dbUsername: username };
        if (platform === 'twitch') {
            const u = await apiChecks.getTwitchUser(username);
            if(u) streamerInfo = { puid: u.id, dbUsername: u.login };
        }
        await db.execute('INSERT INTO streamers (platform, platform_user_id, username) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username)', [platform, streamerInfo.puid, streamerInfo.dbUsername]);
        const [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, streamerInfo.puid]);
        await db.execute('INSERT IGNORE INTO subscriptions (guild_id, streamer_id) VALUES (?, ?)', [req.params.guildId, streamer.streamer_id]);
        res.redirect(`/manage/${req.params.guildId}?success=add`);
    });

    app.post('/manage/:guildId/removeteam', checkAuth, checkGuildAdmin, async (req, res) => {
        // Your logic here
    });

    app.post('/manage/:guildId/remove-subscription', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { subscription_id } = req.body;
            const { guildId } = req.params;
            await db.execute('DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?', [subscription_id, guildId]);
            res.redirect(`/manage/${guildId}?success=remove`);
        } catch (error) {
            console.error('[Dashboard Remove Subscription Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error removing subscription.' });
        }
    });

    app.post('/manage/:guildId/edit-subscription', checkAuth, checkGuildAdmin, upload.single('avatar'), async (req, res) => {
        try {
            const {
                subscription_id,
                discord_user_id,
                kick_username,
                announcement_channel_id,
                override_nickname,
                custom_message,
                override_avatar_url_text,
                reset_avatar
            } = req.body;
            const guildId = req.params.guildId;

            const [[sub]] = await db.execute('SELECT streamer_id, override_avatar_url FROM subscriptions WHERE subscription_id = ? AND guild_id = ?', [subscription_id, guildId]);
            if (!sub) {
                return res.status(404).render('error', { user: req.user, error: 'Subscription not found.' });
            }
            const streamer_id = sub.streamer_id;

            let finalAvatarUrl = sub.override_avatar_url;
            if (reset_avatar === 'true' || (override_avatar_url_text && override_avatar_url_text.toLowerCase() === 'reset')) {
                finalAvatarUrl = null;
            } else if (req.file) {
                const newFilename = `${streamer_id}-${Date.now()}${path.extname(req.file.originalname)}`;
                const publicPath = path.join(__dirname, 'public', 'uploads', 'avatars');
                const newPath = path.join(publicPath, newFilename);
                if (!fs.existsSync(publicPath)) {
                    fs.mkdirSync(publicPath, { recursive: true });
                }
                fs.renameSync(req.file.path, newPath);
                finalAvatarUrl = `/uploads/avatars/${newFilename}`;
            } else if (override_avatar_url_text) {
                finalAvatarUrl = override_avatar_url_text;
            }

            await db.execute(
                'UPDATE streamers SET discord_user_id = ?, kick_username = ? WHERE streamer_id = ?',
                [discord_user_id || null, kick_username || null, streamer_id]
            );

            await db.execute(
                'UPDATE subscriptions SET announcement_channel_id = ?, override_nickname = ?, custom_message = ?, override_avatar_url = ? WHERE subscription_id = ?',
                [announcement_channel_id || null, override_nickname || null, custom_message || null, finalAvatarUrl, subscription_id]
            );

            res.redirect(`/manage/${guildId}?success=edit`);
        } catch (error) {
            console.error('[Dashboard Edit Subscription Error]', error);
            res.status(500).render('error', { user: req.user, error: 'Error saving changes.' });
        }
    });

    // --- API ROUTES ---

    // Helper function to process and format live streamer data
    async function getFormattedLiveRows(rows) {
        const streamersMap = new Map();

        // Group streamers by a common ID (discord_user_id or username)
        for (const row of rows) {
            const key = row.discord_user_id || row.username.toLowerCase();

            if (!streamersMap.has(key)) {
                streamersMap.set(key, {
                    username: row.username, // Will be overridden by Discord username if available
                    discord_user_id: row.discord_user_id,
                    profile_image_url: row.profile_image_url, // Fallback avatar
                    live_platforms: [],
                });
            }

            const streamer = streamersMap.get(key);

            // Add platform if it's not already listed for this streamer
            if (!streamer.live_platforms.some(p => p.platform === row.platform)) {
                streamer.live_platforms.push({
                    platform: row.platform,
                    game: row.stream_game || 'N/A',
                });
            }
        }

        const uniqueStreamers = Array.from(streamersMap.values());

        // Fetch Discord info and format the final output
        return await Promise.all(uniqueStreamers.map(async (streamerData) => {
            let avatar_url = streamerData.profile_image_url || getDefaultAvatar(0);
            let finalUsername = streamerData.username;

            if (streamerData.discord_user_id) {
                try {
                    const user = await client.users.fetch(streamerData.discord_user_id);
                    avatar_url = user.displayAvatarURL({ dynamic: true, size: 128 });
                    finalUsername = user.username; // Prefer Discord username
                } catch (e) {
                    console.error(`Could not fetch user ${streamerData.discord_user_id}`, e);
                }
            }

            return {
                username: finalUsername,
                avatar_url: avatar_url,
                live_platforms: streamerData.live_platforms,
            };
        }));
    }

    app.get('/api/global-live-status', async (req, res) => {
        try {
            // Select all live streamers from the announcements table
            const [liveRows] = await db.execute(`
                SELECT s.streamer_id, s.username, s.discord_user_id, s.profile_image_url, a.platform, a.stream_game
                FROM announcements a
                         JOIN streamers s ON a.streamer_id = s.streamer_id
            `);
            const formatted = await getFormattedLiveRows(liveRows);
            res.json(formatted);
        } catch (error) {
            console.error('[API global-live-status Error]', error);
            res.status(500).json({ error: true, message: "Internal server error." });
        }
    });

    app.get('/api/guilds/:guildId/livestatus', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            // Select live streamers based on announcements for THIS guild
            const [liveRows] = await db.execute(`
                SELECT s.streamer_id, s.username, s.discord_user_id, s.profile_image_url, a.platform, a.stream_game
                FROM announcements a
                         JOIN streamers s ON a.streamer_id = s.streamer_id
                WHERE a.guild_id = ?
            `, [guildId]);
            const formatted = await getFormattedLiveRows(liveRows);
            res.json(formatted);
        } catch (error) {
            console.error(`[API guild-livestatus Error for ${req.params.guildId}]`, error);
            res.status(500).json({ error: true, message: "Internal server error." });
        }
    });

    app.use((req, res) => {
        res.status(404).render('error', { user: req.user, error: 'Page Not Found' });
    });

    app.listen(port, () => console.log(`[Dashboard] Web dashboard listening on port ${port}`));
}

module.exports = { start };
