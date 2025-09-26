const passport = require("passport");
const {Strategy} = require("passport-discord");
const db = require("../utils/db");
require("dotenv-flow").config();

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

passport.use(new Strategy({
  clientID: process.env.DASHBOARD_CLIENT_ID,
  clientSecret: process.env.DASHBOARD_CLIENT_SECRET,
  callbackURL: process.env.DASHBOARD_CALLBACK_URL,
  scope: ["identify", "guilds"]
}, async (accessToken, refreshToken, profile, done) => {
  try {
    // Check if the user is linked to any streamer accounts
    const [streamerCheck] = await db.execute("SELECT 1 FROM streamers WHERE discord_user_id = ? LIMIT 1", [profile.id]);
    profile.isStreamer = streamerCheck.length > 0;
    return done(null, profile);
  } catch (error) {
    console.error("[Passport Auth Error]", error);
    return done(error, null);
  }
}));