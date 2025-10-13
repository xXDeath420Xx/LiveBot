const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const logger = require('../utils/logger');

// Store the entire user object in the session
passport.serializeUser((user, done) => {
    done(null, user);
});

// Retrieve the entire user object from the session
passport.deserializeUser((obj, done) => {
    done(null, obj);
});

passport.use(new DiscordStrategy({
    clientID: process.env.DASHBOARD_CLIENT_ID,
    clientSecret: process.env.DASHBOARD_CLIENT_SECRET,
    callbackURL: process.env.DASHBOARD_CALLBACK_URL,
    scope: ['identify', 'guilds']
}, async (accessToken, refreshToken, profile, done) => {
    try {
        // Correctly check against BOT_OWNER_ID from the .env file
        profile.isSuperAdmin = (profile.id === process.env.BOT_OWNER_ID);
        logger.info(`User ${profile.username}#${profile.discriminator} (ID: ${profile.id}) logged in. Super Admin status: ${profile.isSuperAdmin}`);
        
        return done(null, profile);
    } catch (err) {
        logger.error('Error in Discord strategy:', { category: 'auth', error: err.stack });
        return done(err, null);
    }
}));

module.exports = passport;