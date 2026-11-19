/**
 * Discord Linked Role OAuth broker.
 *
 *   GET /auth/discord/linked-role/start    → redirect to Discord's OAuth consent (role_connections.write + identify)
 *   GET /auth/discord/linked-role/callback → exchange code, store encrypted tokens, push initial metadata
 *
 * On success the user sees a short confirmation page. From then on the daily
 * refresh job (jobs/linked-roles-pusher.js, follow-up) pushes updated metadata
 * when their Twitch subscriber/VIP/mod state changes.
 */
import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import pool from '../../utils/db.js';
import encryption from '../../utils/encryption.js';
import logger from '../../utils/logger.js';
import { pushMetadata, deriveMetadata } from '../../core/discord-linked-roles.js';

const router = express.Router();
const DISCORD_API = 'https://discord.com/api/v10';
// Same Discord app as the dashboard login, so the same credential names (dashboard/server.js passport setup).
const CLIENT_ID = process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DASHBOARD_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET;
const BASE_URL = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
const REDIRECT_URI = `${BASE_URL}/auth/discord/linked-role/callback`;
const SCOPES = 'identify role_connections.write';

/** GET /auth/discord/linked-role/start — redirect to Discord's OAuth consent screen. */
router.get('/auth/discord/linked-role/start', (req, res) => {
    if (!CLIENT_ID || !CLIENT_SECRET || !BASE_URL) {
        return res.status(503).send('Linked Roles not configured (missing DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DASHBOARD_URL).');
    }
    const state = crypto.randomBytes(16).toString('hex');
    req.session = req.session || {};
    req.session.linkedRoleState = state;
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES,
        state,
        prompt: 'consent',
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

/** GET /auth/discord/linked-role/callback — exchange code, store tokens, push metadata. */
router.get('/auth/discord/linked-role/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state.');
    if (!req.session?.linkedRoleState || req.session.linkedRoleState !== state) {
        return res.status(400).send('State mismatch — please retry.');
    }
    delete req.session.linkedRoleState;

    try {
        // 1. Exchange code for tokens.
        const tokenRes = await axios.post(
            `${DISCORD_API}/oauth2/token`,
            new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: String(code),
                redirect_uri: REDIRECT_URI,
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000, validateStatus: () => true });
        if (tokenRes.status >= 300) {
            logger.warn(`[linked-role] token exchange failed: ${tokenRes.status} ${JSON.stringify(tokenRes.data).slice(0, 200)}`);
            return res.status(502).send('Failed to complete Discord OAuth. Try again.');
        }
        const { access_token, refresh_token, expires_in, scope } = tokenRes.data;

        // 2. Who is this user?
        const meRes = await axios.get(`${DISCORD_API}/users/@me`, {
            headers: { Authorization: `Bearer ${access_token}` }, timeout: 10000, validateStatus: () => true });
        if (meRes.status >= 300) return res.status(502).send('Could not read your Discord user.');
        const userId = String(meRes.data.id);

        // 3. Encrypt + persist tokens.
        const accessEnc = JSON.stringify(encryption.encrypt(access_token));
        const refreshEnc = JSON.stringify(encryption.encrypt(refresh_token || ''));
        const expiresAt = new Date(Date.now() + (Number(expires_in) || 0) * 1000);
        await pool.execute(
            `INSERT INTO user_linked_role_tokens
               (discord_user_id, access_token_enc, refresh_token_enc, scopes, expires_at)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               access_token_enc  = VALUES(access_token_enc),
               refresh_token_enc = VALUES(refresh_token_enc),
               scopes            = VALUES(scopes),
               expires_at        = VALUES(expires_at)`,
            [userId, accessEnc, refreshEnc, scope || SCOPES, expiresAt]);

        // 4. Derive + push initial metadata.
        const metadata = await deriveMetadata(userId);
        if (metadata) {
            await pushMetadata(access_token, metadata);
            await pool.execute('UPDATE user_linked_role_tokens SET last_pushed_at = NOW() WHERE discord_user_id = ?', [userId]);
        }

        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!doctype html><html><head><meta charset="utf-8"><title>CertiFried · Linked</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem;background:#1e2124;color:#dcddde;}
h1{color:#fff;}p{line-height:1.5;}a{color:#5865f2;}</style></head><body>
<h1>Linked ✓</h1>
<p>Your CertiFried connection is live on Discord. Servers that use CertiFried's Twitch Linked Roles will see your Subscriber / Partner / VIP / Mod status to gate access.</p>
<p>${metadata ? `Pushed <strong>${Object.keys(metadata).length}</strong> metadata fields.` : 'No Twitch identity found yet — verify your Twitch on the dashboard, then your metadata updates automatically.'}</p>
<p><a href="${BASE_URL}">Return to CertiFried</a></p>
</body></html>`);
    } catch (err) {
        logger.warn(`[linked-role] callback error: ${err.message}`);
        res.status(500).send('Unexpected error. Try again or contact support.');
    }
});

export default router;
