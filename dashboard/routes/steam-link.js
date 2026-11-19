/**
 * Steam library — the two public (non-admin) surfaces:
 *
 *   GET /steam/link?guild=<id>     Discord login → "Sign in through Steam" (OpenID 2.0) →
 *   GET /steam/link/callback       verified SteamID bound to the logged-in Discord user, counted
 *                                  in that one server. The Discord identity comes from the
 *                                  dashboard session, so nobody can link on someone else's behalf.
 *   GET /steam-library/<token>     read-only "who owns what" page for one server, frameable so it
 *                                  can be embedded. Off until an admin creates the token; shows
 *                                  names only if the admin opted in; never shows SteamIDs.
 */
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import logger from '../../utils/logger.js';
import {
    SteamLibraryError, linkAccount, shareWithGuild, syncLibrary, refreshPanels, guildsSharedBy,
    getConfigByToken, topGames, guildStats, ownersForGames, storeUrl,
} from '../../core/steam-library-manager.js';

const router = express.Router();

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const CLAIMED_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/;
const SNOWFLAKE = /^\d{15,25}$/;
const NONCE_TTL_MS = 15 * 60 * 1000;

// The origin the browser is actually on, so the session cookie survives the round trip.
const originOf = req => `${req.protocol}://${req.get('host')}`;

function clientFor(guildId) {
    return global.botManager?.getClientForGuild?.(guildId) || null;
}

function page(res, status, { title, message, ok = false, guildName = null }) {
    res.status(status).render('steam-link-result', { title, message, ok, guildName });
}

router.get('/steam/link', async (req, res) => {
    const guildId = String(req.query.guild || '');
    if (!SNOWFLAKE.test(guildId)) {
        return page(res, 400, { title: 'Bad link', message: 'This link is missing its server. Use the Link Steam button in Discord again.' });
    }
    if (!req.isAuthenticated?.()) {
        return res.redirect(`/auth/discord?returnTo=${encodeURIComponent(`/steam/link?guild=${guildId}`)}`);
    }

    const guild = clientFor(guildId)?.guilds.cache.get(guildId);
    if (!guild) return page(res, 404, { title: 'Server not found', message: "The bot isn't in that server any more." });
    const member = await guild.members.fetch(req.user.id).catch(() => null);
    if (!member) {
        return page(res, 403, {
            title: 'Not a member', guildName: guild.name,
            message: `You're logged in as ${req.user.username}, who isn't in ${guild.name}. Log out and back in with the right Discord account.`,
        });
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    req.session.steamLink = { nonce, guildId, userId: req.user.id, at: Date.now() };
    const origin = originOf(req);
    const params = new URLSearchParams({
        'openid.ns': OPENID_NS,
        'openid.mode': 'checkid_setup',
        'openid.return_to': `${origin}/steam/link/callback?n=${nonce}`,
        'openid.realm': origin,
        'openid.identity': `${OPENID_NS}/identifier_select`,
        'openid.claimed_id': `${OPENID_NS}/identifier_select`,
    });
    req.session.save(() => res.redirect(`${STEAM_OPENID}?${params}`));
});

/** Ask Steam whether this assertion is genuine. Every field comes back signed by Steam. */
async function verifyAssertion(query) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
        if (k.startsWith('openid.') && typeof v === 'string') body.set(k, v);
    }
    body.set('openid.mode', 'check_authentication');
    const res = await axios.post(STEAM_OPENID, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000, responseType: 'text',
    });
    return /(^|\n)is_valid\s*:\s*true(\n|$)/.test(String(res.data));
}

router.get('/steam/link/callback', async (req, res) => {
    const pending = req.session?.steamLink;
    delete req.session.steamLink; // single use, whatever happens next
    const q = req.query;

    if (q['openid.mode'] === 'cancel') {
        return page(res, 200, { title: 'Cancelled', message: 'Nothing was linked. You can close this tab.' });
    }
    if (!pending || pending.nonce !== q.n || Date.now() - pending.at > NONCE_TTL_MS || !req.isAuthenticated?.() || req.user.id !== pending.userId) {
        return page(res, 400, { title: 'Link expired', message: 'This sign-in expired or was started in another browser. Press Link Steam in Discord and try again.' });
    }

    const expectedReturn = `${originOf(req)}/steam/link/callback?n=${pending.nonce}`;
    const claimed = String(q['openid.claimed_id'] || '').match(CLAIMED_RE);
    const signed = String(q['openid.signed'] || '').split(',');
    if (q['openid.mode'] !== 'id_res' || q['openid.op_endpoint'] !== STEAM_OPENID || q['openid.return_to'] !== expectedReturn
        || !claimed || q['openid.identity'] !== q['openid.claimed_id']
        || !['claimed_id', 'identity', 'return_to', 'op_endpoint', 'response_nonce'].every(f => signed.includes(f))) {
        logger.warn('[SteamLink] rejected malformed OpenID response', { user: req.user.id });
        return page(res, 400, { title: "Couldn't verify", message: "Steam's answer didn't check out. Please try again." });
    }

    try {
        if (!(await verifyAssertion(q))) {
            logger.warn('[SteamLink] Steam rejected assertion', { user: req.user.id });
            return page(res, 400, { title: "Couldn't verify", message: 'Steam did not confirm this sign-in. Please try again.' });
        }
    } catch (err) {
        logger.warn(`[SteamLink] verification request failed: ${err.message}`);
        return page(res, 502, { title: 'Steam is not answering', message: 'Steam could not be reached to confirm the sign-in. Try again in a few minutes.' });
    }

    const steamId = claimed[1];
    const { guildId } = pending;
    const guild = clientFor(guildId)?.guilds.cache.get(guildId);
    try {
        const displaced = await linkAccount(req.user.id, steamId, { verified: true });
        await shareWithGuild(guildId, req.user.id);
        const r = await syncLibrary(req.user.id);
        refreshPanels([...new Set([...(await guildsSharedBy(req.user.id)), ...displaced])]);
        logger.info(`[SteamLink] ${req.user.id} verified a Steam account for ${guildId} (${r.status}, ${r.count} games)`);

        const message = {
            ok: `Your ${r.count} games now count in ${guild?.name || 'the server'}. You can close this tab.`,
            private: 'Linked, but your game list is private on Steam, so nothing is counted yet. In Steam: your profile → Edit Profile → Privacy Settings → Game details: Public. Then press Refresh my games in Discord.',
            error: 'Linked. Steam did not hand over your game list just now; it will be picked up automatically within the hour.',
        }[r.status];
        return page(res, 200, { title: r.status === 'private' ? 'Linked, with one more step' : 'Steam linked', message, ok: r.status !== 'private', guildName: guild?.name });
    } catch (err) {
        if (!(err instanceof SteamLibraryError)) logger.error('[SteamLink] link failed', { error: err.message, stack: err.stack });
        return page(res, 500, { title: 'Link failed', message: err instanceof SteamLibraryError ? err.message : 'Something went wrong saving your link. Please try again.' });
    }
});

router.get('/steam-library/:token', async (req, res) => {
    const cfg = await getConfigByToken(req.params.token).catch(() => null);
    if (!cfg) return res.status(404).render('steam-link-result', { title: 'Not found', message: 'This list does not exist or was turned off.', ok: false, guildName: null });

    const guild = clientFor(cfg.guild_id)?.guilds.cache.get(cfg.guild_id);
    const [games, stats] = await Promise.all([
        topGames(cfg.guild_id, { limit: 500, minOwners: 1 }),
        guildStats(cfg.guild_id),
    ]);

    let owners = null;
    if (cfg.public_show_names && guild) {
        const map = await ownersForGames(cfg.guild_id, games.map(g => g.appId));
        const ids = [...new Set([...map.values()].flat())];
        const names = new Map();
        for (let i = 0; i < ids.length; i += 100) {
            const found = await guild.members.fetch({ user: ids.slice(i, i + 100) }).catch(() => null);
            found?.forEach(m => names.set(m.id, m.displayName));
        }
        owners = Object.fromEntries([...map].map(([app, us]) =>
            [app, us.map(u => names.get(u)).filter(Boolean).sort((a, b) => a.localeCompare(b))]));
    }

    // Meant to be dropped into an iframe (a server website, OBS, a Notion page). Only this route
    // relaxes framing; everything else keeps helmet's SAMEORIGIN.
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; frame-ancestors *");
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.render('steam-library-public', {
        guildName: guild?.name || 'This server',
        guildIcon: guild?.iconURL?.({ size: 64 }) || null,
        games: games.map(g => ({ ...g, url: storeUrl(g.appId), ownerNames: owners?.[g.appId] || null })),
        stats,
        showNames: !!owners,
        minDefault: Math.min(cfg.min_owners || 1, 5),
        theme: ['light', 'dark'].includes(req.query.theme) ? req.query.theme : null,
        compact: req.query.compact === '1',
    });
});

export default router;
