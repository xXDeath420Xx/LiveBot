const passport = require('passport');
const { Strategy } = require('passport-discord');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((obj, done) => {
    done(null, obj);
});

const discordStrategy = new Strategy({
    clientID: process.env.DASHBOARD_CLIENT_ID,
    clientSecret: process.env.DASHBOARD_CLIENT_SECRET,
    callbackURL: process.env.DASHBOARD_CALLBACK_URL,
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    profile.isSuperAdmin = (profile.id === process.env.BOT_OWNER_ID);
    process.nextTick(() => {
        return done(null, profile);
    });
});

passport.use(discordStrategy);