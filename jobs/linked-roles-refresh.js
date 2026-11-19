/**
 * Daily job — refresh Discord Linked Role metadata for every user who connected.
 *
 * Walks user_linked_role_tokens, derives current metadata from their Twitch
 * state (deriveMetadata reads twitch_oauth_accounts + twitch_role_sync_members),
 * and pushes via pushMetadata. Uses the stored access_token first; on 401, tries
 * the refresh_token exchange and retries once.
 *
 * Runs daily at 04:30 UTC — low-traffic hour. The job is additive on top of the
 * on-connect push in dashboard/routes/auth-discord-linked-role.js, which handles
 * fresh connections immediately.
 */
import cron from 'node-cron';
import axios from 'axios';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import encryption from '../utils/encryption.js';
import { deriveMetadata, pushMetadata } from '../core/discord-linked-roles.js';

const LOG = '[LinkedRolesRefresh]';
let task = null;

async function refreshToken(discordUserId, refreshToken) {
    try {
        const res = await axios.post(
            'https://discord.com/api/v10/oauth2/token',
            new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000, validateStatus: () => true });
        if (res.status >= 300) return null;
        const { access_token, refresh_token: newRefresh, expires_in } = res.data;
        const accessEnc = JSON.stringify(encryption.encrypt(access_token));
        const refreshEnc = JSON.stringify(encryption.encrypt(newRefresh || refreshToken));
        const expiresAt = new Date(Date.now() + (Number(expires_in) || 0) * 1000);
        await pool.execute(
            'UPDATE user_linked_role_tokens SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ? WHERE discord_user_id = ?',
            [accessEnc, refreshEnc, expiresAt, discordUserId]);
        return access_token;
    } catch (err) {
        logger.warn(`${LOG} refresh for ${discordUserId}: ${err.message}`);
        return null;
    }
}

async function runCycle() {
    const [rows] = await pool.execute(
        'SELECT discord_user_id, access_token_enc, refresh_token_enc FROM user_linked_role_tokens');
    let ok = 0, failed = 0, noMetadata = 0;
    for (const r of rows) {
        try {
            let token;
            try { token = encryption.decrypt(JSON.parse(r.access_token_enc)); } catch { failed++; continue; }
            const metadata = await deriveMetadata(r.discord_user_id);
            if (!metadata) { noMetadata++; continue; }
            let res = await pushMetadata(token, metadata);
            if (!res) {
                // Try refreshing the token once.
                let refresh;
                try { refresh = encryption.decrypt(JSON.parse(r.refresh_token_enc)); } catch { failed++; continue; }
                const newToken = await refreshToken(r.discord_user_id, refresh);
                if (newToken) res = await pushMetadata(newToken, metadata);
            }
            if (res) {
                ok++;
                await pool.execute('UPDATE user_linked_role_tokens SET last_pushed_at = NOW() WHERE discord_user_id = ?', [r.discord_user_id]);
            } else failed++;
        } catch (err) {
            logger.warn(`${LOG} cycle item ${r.discord_user_id}: ${err.message}`);
            failed++;
        }
    }
    logger.info(`${LOG} daily refresh: ${rows.length} users · ${ok} pushed · ${failed} failed · ${noMetadata} no_metadata`);
    return { total: rows.length, ok, failed, noMetadata };
}

export function startLinkedRolesRefresher() {
    if (task) { logger.warn(`${LOG} already running`); return; }
    task = cron.schedule('30 4 * * *', () => {
        runCycle().catch(err => logger.error(`${LOG} cycle error: ${err.message}`));
    });
    logger.info(`${LOG} scheduled daily at 04:30 UTC`);
}
export function stopLinkedRolesRefresher() {
    if (task) { task.stop(); task = null; }
    logger.info(`${LOG} stopped`);
}
