// dashboard/server.js (DEFINITIVE - With Sorted Live Status API)
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const fs = require('fs');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const initCycleTLS = require('cycletls');
const Papa = require('papaparse');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

const app = express();
const port = process.env.DASHBOARD_PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function start(client) {
    passport.serializeUser((user, done) => done(null, user));
    passport.deserializeUser((obj, done) => done(null, obj));

    passport.use(new DiscordStrategy({
        clientID: process.env.DASHBOARD_CLIENT_ID, clientSecret: process.env.DASHBOARD_CLIENT_SECRET,
        callbackURL: process.env.DASHBOARD_CALLBACK_URL, scope: ['identify', 'guilds']
    }, (accessToken, refreshToken, profile, done) => { return done(null, profile); }));

    app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 60000 * 60 * 24 }}));
    app.use(passport.initialize());
    app.use(passport.session());

    const checkAuth = (req, res, next) => {
        if (req.isAuthenticated()) return next();
        res.redirect('/login');
    };
    
    const checkGuildAdmin = (req, res, next) => {
        const guildId = req.params.guildId;
        const guild = req.user.guilds.find(g => g.id === guildId);
        if (guild && (BigInt(guild.permissions) & 8n) === 8n && client.guilds.cache.has(guildId)) {
            return next();
        }
        res.status(403).send("Permission Denied.");
    };

    app.use(express.static(path.join(__dirname, 'public')));
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    
    app.get('/', (req, res) => res.render('landing', { user: req.user }));
    app.get('/login', passport.authenticate('discord'));
    app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));
    app.get('/logout', (req, res) => { req.logout(() => { res.redirect('/'); }); });
    
    app.get('/dashboard', checkAuth, (req, res) => {
        const manageableGuilds = req.user.guilds.filter(g => (BigInt(g.permissions) & 8n) === 8n && client.guilds.cache.has(g.id));
        res.render('dashboard', { guilds: manageableGuilds, user: req.user, client });
    });
    
    app.get('/manage/:guildId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const botGuild = client.guilds.cache.get(req.params.guildId);
            const [[streamers], [[guildSettings]], allRoles, allChannels] = await Promise.all([
                db.execute(`SELECT s.streamer_id, s.platform, s.username, sub.custom_message, sub.announcement_channel_id FROM streamers s JOIN subscriptions sub ON s.streamer_id = sub.streamer_id WHERE sub.guild_id = ? ORDER BY s.platform, s.username`, [req.params.guildId]),
                db.execute('SELECT * FROM guilds WHERE guild_id = ?', [req.params.guildId]),
                botGuild.roles.fetch(),
                botGuild.channels.fetch()
            ]);
            res.render('manage', { 
                guild: botGuild, streamers, user: req.user, settings: guildSettings || {},
                roles: allRoles.filter(r => !r.managed && r.name !== '@everyone'),
                channels: allChannels.filter(c => c.isTextBased())
            });
        } catch (error) { console.error('[Dashboard GET Error]', error); res.status(500).send("Error."); }
    });

    // --- API & ACTION ROUTES ---

    app.get('/api/guilds/:guildId/livestatus', checkAuth, checkGuildAdmin, async(req, res) => {
        const [liveStreamers] = await db.execute(
            `SELECT s.platform, s.username, a.stream_title 
             FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id 
             WHERE a.guild_id = ? 
             ORDER BY s.platform, s.username`, // This ORDER BY is the change
            [req.params.guildId]
        );
        res.json(liveStreamers);
    });
    
    app.post('/manage/:guildId/settings', checkAuth, checkGuildAdmin, async (req, res) => {
        const { channelId, roleId } = req.body;
        await db.execute('INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = ?, live_role_id = ?', [req.params.guildId, channelId || null, roleId || null, channelId || null, roleId || null]);
        res.redirect(`/manage/${req.params.guildId}?success=true`);
    });

    app.post('/manage/:guildId/updatestreamer', checkAuth, checkGuildAdmin, async (req, res) => {
        const { streamerId, custom_message, announcement_channel_id } = req.body;
        await db.execute('UPDATE subscriptions SET custom_message = ?, announcement_channel_id = ? WHERE guild_id = ? AND streamer_id = ?', [custom_message || null, announcement_channel_id || null, req.params.guildId, streamerId]);
        res.redirect(`/manage/${req.params.guildId}?success=true`);
    });

    app.post('/manage/:guildId/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const { platform, username } = req.body;
        let cycleTLS = null;
        try {
            let streamerInfo;
            if (platform === 'twitch') {
                const u = await apiChecks.getTwitchUser(username);
                if (u) streamerInfo = { puid: u.id, dbUsername: u.login };
            } else if (platform === 'kick') {
                cycleTLS = await initCycleTLS({ timeout: 60000 });
                const u = await apiChecks.getKickUser(cycleTLS, username);
                if (u) streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username };
            } else if (platform === 'youtube') {
                let channelId = username;
                if (!username.startsWith('UC')) channelId = await apiChecks.getYouTubeChannelId(username);
                if (channelId) streamerInfo = { puid: channelId, dbUsername: username };
            } else { streamerInfo = { puid: username, dbUsername: username }; }

            if (!streamerInfo) throw new Error(`User not found on ${platform}`);

            let [[streamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, streamerInfo.puid]);
            if (!streamer) {
                const [result] = await db.execute('INSERT INTO streamers (platform, username, platform_user_id) VALUES (?, ?, ?)', [platform, streamerInfo.dbUsername, streamerInfo.puid]);
                streamer = { streamer_id: result.insertId };
            }
            await db.execute('INSERT IGNORE INTO subscriptions (guild_id, streamer_id) VALUES (?, ?)', [req.params.guildId, streamer.streamer_id]);
        } catch(e) { console.error("[Dashboard Add Error]", e); }
        finally { if (cycleTLS) cycleTLS.exit(); }
        res.redirect(`/manage/${req.params.guildId}`);
    });

    app.post('/manage/:guildId/remove', checkAuth, checkGuildAdmin, async (req, res) => {
        await db.execute('DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id = ?', [req.params.guildId, req.body.streamerId]);
        res.redirect(`/manage/${req.params.guildId}?success=true`);
    });

    app.post('/manage/:guildId/clear', checkAuth, checkGuildAdmin, async (req, res) => {
        await db.execute('DELETE FROM subscriptions WHERE guild_id = ?', [req.params.guildId]);
        res.redirect(`/manage/${req.params.guildId}?success=true`);
    });
    
    app.get('/manage/:guildId/export', checkAuth, checkGuildAdmin, async(req, res) => {
        const [streamers] = await db.execute(`SELECT s.platform, s.username, s.discord_user_id, sub.custom_message FROM streamers s JOIN subscriptions sub ON s.streamer_id = sub.streamer_id WHERE sub.guild_id = ?`, [req.params.guildId]);
        res.header('Content-Type', 'text/csv');
        res.attachment(`streamers_export_${req.params.guildId}.csv`);
        res.send(Papa.unparse(streamers, { header: true }));
    });

    app.post('/manage/:guildId/import', checkAuth, checkGuildAdmin, upload.single('csvfile'), async(req, res) => {
        const fakeInteraction = { 
            guild: { id: req.params.guildId }, 
            options: { getAttachment: () => req.file },
            deferReply: async () => {}, 
            editReply: async (result) => { console.log('Dashboard CSV Import Result:', result.embeds[0].data.fields); }
         };
        try {
            const command = client.commands.get('importcsv');
            if (command) await command.execute(fakeInteraction);
        } catch(e) { console.error("Dashboard import failed:", e); }
        finally { if (req.file?.path) fs.unlinkSync(req.file.path); }
        res.redirect(`/manage/${req.params.guildId}?success=import`);
    });

    app.listen(port, () => console.log(`[Dashboard] Web dashboard listening on port ${port}`));
}

module.exports = { start };