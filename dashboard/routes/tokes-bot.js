/**
 * Legacy "Tokes Bot" web panel — retired.
 *
 * The /tokes-bot pages (landing, leaderboards, commands, status, user dashboard, channels,
 * profile, data management, admin panel) and their JSON APIs, plus the owner admin API that
 * lived in tokes-admin-api.js (analytics, moderation, users/bans, health, sessions, trivia,
 * strains, achievements, challenges, webhooks, API keys), were hidden behind the redirect
 * gate in dashboard/server.js and have been removed.
 *
 * What still lives elsewhere and keeps working:
 *   - Kick + Twitch OAuth, the shared tokesUser session and ban enforcement:
 *     dashboard/routes/auth-tokes-bot.js (/tokes-bot/auth/**)
 *   - Kick Defender + Kick channel/command management: dashboard/routes/kick-defender.js,
 *     dashboard/routes/kick-channel.js (/kick, /kick/api/**)
 *   - The Twitch/Kick chat bot: services/certifried-bot/
 *
 * The only route left here is the redirect for pre-rename /twitch-bot URLs.
 */
import express from 'express';

const router = express.Router();

// Old /twitch-bot URLs. OAuth links map onto /tokes-bot/auth/** (auth-tokes-bot.js has the
// same redirect; this copy keeps them working whichever router registers first). Every other
// legacy panel URL pointed at a page that no longer exists, so send it home.
router.get('/twitch-bot*', (req, res) => {
    if (req.path.startsWith('/twitch-bot/auth/')) {
        return res.redirect(301, req.originalUrl.replace('/twitch-bot', '/tokes-bot'));
    }
    res.redirect(301, '/');
});

export default router;
