const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const db = require('../utils/db'); // Use the same DB connection

const app = express();
const port = process.env.DASHBOARD_PORT || 3000;

function start(client) {
    // --- Passport & Session Setup ---
    passport.serializeUser((user, done) => done(null, user));
    passport.deserializeUser((obj, done) => done(null, obj));

    passport.use(new DiscordStrategy({
        clientID: process.env.DASHBOARD_CLIENT_ID,
        clientSecret: process.env.DASHBOARD_CLIENT_SECRET,
        callbackURL: process.env.DASHBOARD_CALLBACK_URL,
        scope: ['identify', 'guilds']
    }, (accessToken, refreshToken, profile, done) => {
        return done(null, profile);
    }));

    app.use(session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
    }));

    app.use(passport.initialize());
    app.use(passport.session());

    // Middleware to check if user is authenticated
    const checkAuth = (req, res, next) => {
        if (req.isAuthenticated()) return next();
        res.redirect('/login');
    };

    // --- Static & Frontend Routes ---
    app.use(express.static(path.join(__dirname, 'public')));
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    
    app.get('/', (req, res) => {
        res.render('landing', { user: req.user });
    });

    // --- Authentication Routes ---
    app.get('/login', passport.authenticate('discord'));
    app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
        res.redirect('/dashboard');
    });
    app.get('/logout', (req, res) => {
        req.logout(() => res.redirect('/'));
    });
    
    // --- Dashboard Routes ---
    app.get('/dashboard', checkAuth, async (req, res) => {
        // Filter guilds to show only those where the user is an admin and the bot is present
        const manageableGuilds = req.user.guilds.filter(g => {
            const userPerms = BigInt(g.permissions);
            const isAdmin = (userPerms & 8n) === 8n; // Administrator permission
            return isAdmin && client.guilds.cache.has(g.id);
        });

        res.render('dashboard', { guilds: manageableGuilds, user: req.user });
    });
    
    // Example protected API route to get streamers for a specific guild
    app.get('/api/guilds/:guildId/streamers', checkAuth, async (req, res) => {
        try {
            // Verify the user has permissions for this guild
            const guild = req.user.guilds.find(g => g.id === req.params.guildId);
            if (!guild || !((BigInt(guild.permissions) & 8n) === 8n)) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            const [streamers] = await db.execute(
                `SELECT s.platform, s.username FROM streamers s 
                 JOIN subscriptions sub ON s.streamer_id = sub.streamer_id 
                 WHERE sub.guild_id = ?`,
                [req.params.guildId]
            );
            res.json(streamers);
        } catch (error) {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- Start Server ---
    app.listen(port, () => {
        console.log(`[Dashboard] Web dashboard listening on http://localhost:${port}`);
    });
}

module.exports = { start };