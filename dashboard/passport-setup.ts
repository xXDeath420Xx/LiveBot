const passport = require('passport');
const { Strategy: DiscordStrategy } = require('passport-discord');
const { logger } = require('../utils/logger');
const { isSuperAdmin } = require('../utils/super-admin');

// Store the entire user object in the session
passport.serializeUser((user: any, done: (err: any, id?: any) => void) => {
    done(null, user);
});

// Retrieve the entire user object from the session
passport.deserializeUser((obj: any, done: (err: any, user?: any) => void) => {
    done(null, obj);
});

passport.use(new DiscordStrategy({
    clientID: process.env.DASHBOARD_CLIENT_ID as string,
    clientSecret: process.env.DASHBOARD_CLIENT_SECRET as string,
    callbackURL: process.env.DASHBOARD_CALLBACK_URL as string,
    scope: ['identify', 'guilds']
}, async (accessToken: string, refreshToken: string, profile: any, done: any): Promise<void> => {
    try {
        // Check super admin status from database
        profile.isSuperAdmin = await isSuperAdmin(profile.id);

        logger.info(`User ${profile.username}#${profile.discriminator} (ID: ${profile.id}) logged in. Super Admin status: ${profile.isSuperAdmin}`);

        return done(null, profile);
    } catch (err: any) {
        logger.error('Error in Discord strategy:', { category: 'auth', error: err.stack });
        return done(err, undefined);
    }
}));

module.exports = passport;
