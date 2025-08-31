const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

passport.serializeUser((user, done) => { 
    done(null, user); 
});

passport.deserializeUser((obj, done) => { 
    done(null, obj); 
});

passport.use(new DiscordStrategy({
    clientID: process.env.DASHBOARD_CLIENT_ID,
    clientSecret: process.env.DASHBOARD_CLIENT_SECRET,
    callbackURL: process.env.DASHBOARD_CALLBACK_URL,
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    process.nextTick(() => { 
        return done(null, profile); 
    });
}));
