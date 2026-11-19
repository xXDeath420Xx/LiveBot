/*
 * Twitch channel commands in the stream bot area: the Twitch side of the channel bot (CertiFried's chat bot on Twitch,
 * services/certifried-bot/twitch-client.js), which had no dashboard page. Same page body and same API code as the Kick
 * page (views/partials/channel-bot/commands-body.ejs, dashboard/routes/channel-bot-commands.js).
 *
 *   GET  /stream/bot/commands                         your Twitch channels the channel bot serves (one: straight to it)
 *   GET  /stream/bot/commands/:channelId              built-in commands, your commands (imported ones included), auto-responders,
 *                                                     and the channel's "Chat commands" switch (features_enabled.commands)
 *   POST /stream/bot/api/twitch-channel/:channelId/switch   { on } sets features_enabled.commands only
 *   …/stream/bot/api/twitch-channel/:channelId/{commands,custom,responders}   shared routes (channel-bot-commands.js)
 *
 * Ownership: the Twitch channel must be linked to the signed-in user's stream bot profile (linked only from an OAuth
 * sign-in, core/stream-bot/live.js) and have a channel bot row (tokes_channels, platform twitch). The channel id in the
 * URL is the Twitch broadcaster id; no profile id is read from a request. Literal paths come before /:param paths.
 */
import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import { invalidateChannelCache } from '../../services/certifried-bot/command-registry.js';
import { mountChannelCommandRoutes, commandsPageData } from './channel-bot-commands.js';

const router = express.Router();
const LOG = '[StreamBotChannel]';
const API = '/stream/bot/api/twitch-channel';

const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);
function needPage(req, res, next) {
    if (signedIn(req)) return next();
    return res.redirect('/auth/discord?returnTo=' + encodeURIComponent(/^\/stream\/bot\/commands(\/\d{1,20})?$/.test(req.path) ? req.path : '/stream/bot/commands'));
}
function needApi(req, res, next) {
    if (signedIn(req)) return next();
    return res.status(401).json({ error: 'You are signed out. Sign in again and retry.' });
}

/** The user's linked Twitch channels that have a channel bot row: [{ id (tokes row), channelId, name }]. */
export async function twitchChannelBots({ store, db, ownerId }) {
    const profile = await store.getProfileByOwner(ownerId);
    if (!profile) return [];
    const linked = (await store.listChannels(profile.id)).filter((c) => c.platform === 'twitch');
    const out = [];
    for (const c of linked) {
        const [[row]] = await db.execute("SELECT id, channel_id, channel_name FROM tokes_channels WHERE platform = 'twitch' AND channel_id = ?", [String(c.platform_user_id)]);
        if (row) out.push({ id: Number(row.id), channelId: String(row.channel_id), name: row.channel_name || c.login || c.display_name });
    }
    return out;
}

/** The tokes_channels row for :channelId when it is one of the user's, else null. */
export async function resolveTwitchChannel({ store, db, ownerId, channelId }) {
    if (!/^\d{1,20}$/.test(String(channelId || ''))) return null;
    return (await twitchChannelBots({ store, db, ownerId })).find((c) => c.channelId === String(channelId)) || null;
}

const storeOf = async () => (await getStreamBot()).store;
const resolveReq = async (req) => resolveTwitchChannel({ store: await storeOf(), db: pool, ownerId: req.user.id, channelId: req.params.channelId });

router.get('/stream/bot/commands', needPage, async (req, res) => {
    try {
        const bots = await twitchChannelBots({ store: await storeOf(), db: pool, ownerId: req.user.id });
        if (bots.length === 1) return res.redirect(`/stream/bot/commands/${encodeURIComponent(bots[0].channelId)}`);
        res.render('stream-bot/channel-commands', { user: req.user, active: 'commands', pageTitle: 'Commands', channel: null, bots });
    } catch (err) {
        logger.error(`${LOG} list failed`, { error: err?.message });
        res.status(500).render('error-tailwind', { user: req.user, error: 'The commands page could not be loaded. Try again in a minute.' });
    }
});

router.get('/stream/bot/commands/:channelId', needPage, async (req, res) => {
    try {
        const owned = await resolveReq(req);
        if (!owned) return res.status(404).render('error-tailwind', { user: req.user, error: 'That Twitch channel is not linked to your stream bot, or CertiFried\'s chat bot does not serve it.' });
        const data = await commandsPageData(pool, owned.id);
        res.render('stream-bot/channel-commands', { user: req.user, active: 'commands', pageTitle: `Commands for ${data.channel.channel_name}`, ...data, bots: [] });
    } catch (err) {
        logger.error(`${LOG} page failed`, { error: err?.message });
        res.status(500).render('error-tailwind', { user: req.user, error: 'The commands page could not be loaded. Try again in a minute.' });
    }
});

router.post(`${API}/:channelId/switch`, needApi, async (req, res) => {
    try {
        const owned = await resolveReq(req);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const on = req.body?.on === true;
        // JSON_EXTRACT('true', '$') is a JSON boolean (command-handler checks features_enabled.commands === true).
        await pool.execute("UPDATE tokes_channels SET features_enabled = JSON_SET(COALESCE(features_enabled, '{}'), '$.commands', JSON_EXTRACT(?, '$')) WHERE id = ?", [on ? 'true' : 'false', owned.id]);
        invalidateChannelCache(owned.id);
        logger.info(`${LOG} chat commands switch`, { channelRow: owned.id, on });
        res.json({ success: true, on });
    } catch (err) {
        logger.error(`${LOG} switch failed`, { error: err?.message });
        res.status(500).json({ error: 'Failed to change the switch' });
    }
});

mountChannelCommandRoutes(router, {
    base: API, guard: needApi, label: LOG, resolve: resolveReq,
    createdBy: (req) => String(req.user?.global_name || req.user?.username || 'owner').slice(0, 100),
});

export default router;
