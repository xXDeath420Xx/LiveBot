const express = require('express');
const session = require('express-session');
const passport = require('passport');
const path = require('path');
// FIX: Correctly require the 'fs' (File System) module. This resolves the crash loop.
const fs = require('fs');
const sessionFileStore = require('session-file-store')(session);
require('./passport-setup');

const app = express();
const PORT = process.env.PORT || 3000;

let guildDataCache = [];
const cacheFilePath = path.join(__dirname, '../guild_data.json');

function ensureAuth(req, res, next) { if (req.isAuthenticated()) return next(); res.redirect('/login'); }

function updateGuildCache(client) {
    if (!client || !client.guilds) return;
    const guilds = [];
    client.guilds.cache.forEach(guild => {
        try {
            const channels = guild.channels.cache.filter(c => c.type === 0 || c.type === 5).map(c => ({ id: c.id, name: c.name })).sort((a,b) => a.name.localeCompare(b.name));
            const roles = guild.roles.cache.map(r => ({ id: r.id, name: r.name })).sort((a,b) => a.name.localeCompare(b.name));
            guilds.push({ id: guild.id, name: guild.name, icon: guild.icon, channels, roles });
        } catch (e) { console.error(`[Cache] Could not process guild ${guild.name}:`, e.message); }
    });
    fs.writeFileSync(cacheFilePath, JSON.stringify(guilds, null, 2));
    guildDataCache = guilds;
    console.log('[Cache] Guild data cache updated.');
}

function start(client) {
    app.set('trust proxy', 1);
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    
    app.use(require('body-parser').urlencoded({ extended: true }));
    app.use(session({
        store: new sessionFileStore({ path: path.join(__dirname, 'sessions'), ttl: 86400, logFn: function(){} }),
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        proxy: true,
        cookie: { httpOnly: true, secure: true, maxAge: 86400000, sameSite: 'lax' }
    }));
    app.use(passport.initialize());
    app.use(passport.session());
    
    if (fs.existsSync(cacheFilePath)) { try { guildDataCache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8')); } catch (e) {} } else { updateGuildCache(client); }
    setInterval(() => updateGuildCache(client), 3600000);

    app.get('/', (req, res) => res.redirect('/dashboard'));
    app.get('/login', passport.authenticate('discord'));
    app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: 'https://certifriedannouncer.online' }), (req, res) => res.redirect('/dashboard'));
    app.get('/logout', (req, res, next) => { req.logout(err => { if(err) return next(err); res.redirect('https://certifriedannouncer.online'); }); });

    app.get('/dashboard', ensureAuth, async (req, res) => {
        try {
            const botGuildIds = new Set(guildDataCache.map(g => g.id));
            const userAdminGuilds = req.user.guilds.filter(g => (g.permissions & 0x20) === 0x20);
            const mutualGuilds = userAdminGuilds.filter(g => botGuildIds.has(g.id));
            let selectedGuild = null, streamers = [], guildSettings = {};
            const selectedGuildId = req.query.guild_id || mutualGuilds[0]?.id;

            if (selectedGuildId && mutualGuilds.some(g => g.id === selectedGuildId)) {
                const guildFromCache = guildDataCache.find(g => g.id === selectedGuildId);
                const guildMeta = mutualGuilds.find(g => g.id === selectedGuildId);
                if (guildFromCache) {
                    selectedGuild = { id: selectedGuildId, name: guildMeta.name, icon: guildMeta.icon ? `https://cdn.discordapp.com/icons/${guildMeta.id}/${guildMeta.icon}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png', channels: guildFromCache.channels, roles: guildFromCache.roles };
                    const [streamerRows] = await require('../utils/db').execute(`SELECT s.*, sub.custom_message, sub.subscription_id FROM streamers s JOIN subscriptions sub ON s.streamer_id=sub.streamer_id WHERE sub.guild_id = ? ORDER BY s.platform, s.username`, [selectedGuildId]);
                    streamers = streamerRows;
                    const [guildSettingRows] = await require('../utils/db').execute('SELECT * FROM guilds WHERE guild_id = ?', [selectedGuildId]);
                    if (guildSettingRows.length > 0) guildSettings = guildSettingRows[0];
                }
            }
            res.render('dashboard', { user: req.user, guilds: mutualGuilds, selectedGuild, streamers, settings: guildSettings });
        } catch (error) { res.status(500).render('error', { user: req.user, error: 'Dashboard failed to load.' }); }
    });
    
    app.listen(PORT, '0.0.0.0', () => console.log(`[Dashboard] Server listening on port ${PORT}`));
}

module.exports = { start };