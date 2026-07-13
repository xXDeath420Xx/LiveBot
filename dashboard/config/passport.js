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
        scope: ['identify', 'guilds', 'guilds.members.read'],
        prompt: 'none'
    }, (accessToken, refreshToken, profile, done) => {
        profile.accessToken = accessToken;
        // Log permission breakdown from initial OAuth
        const gs = profile.guilds || [];
        let ow=0, ad=0, mg=0, mb=0;
        for (const g of gs) { const p = parseInt(g.permissions)||0; if (g.owner) ow++; else if ((p&0x8)===0x8) ad++; else if ((p&0x20)===0x20) mg++; else mb++; }
        logger.info(`User ${profile.username} logged in with ${gs.length} guilds (Owner:${ow} Admin:${ad} ManageGuild:${mg} Member:${mb})`);
        return done(null, profile);
    }));

    return passport;
}

export default passport;
