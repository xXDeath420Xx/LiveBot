import passport from 'passport';
import { Strategy as DiscordStrategy } from 'passport-discord';
import logger from '../../utils/logger.js';

/**
 * Configure Passport.js with Discord OAuth2 strategy
 */
export function configurePassport() {
    // Serialize user to session
    passport.serializeUser((user, done) => {
        done(null, user);
    });

    // Deserialize user from session
    passport.deserializeUser((obj, done) => {
        done(null, obj);
    });

    // Discord OAuth2 strategy
    passport.use(new DiscordStrategy({
        clientID: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID,
        clientSecret: process.env.DASHBOARD_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET,
        callbackURL: process.env.DASHBOARD_CALLBACK_URL || process.env.DISCORD_CALLBACK_URL,
        scope: ['identify', 'guilds'],
        prompt: 'none'
    }, (accessToken, refreshToken, profile, done) => {
        profile.accessToken = accessToken;
        logger.info(`User ${profile.username} logged in with ${profile.guilds?.length || 0} guilds`);
        return done(null, profile);
    }));

    return passport;
}

export default passport;
