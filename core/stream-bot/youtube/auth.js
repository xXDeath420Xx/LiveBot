/*
 * Stream bot, YouTube: the streamer's Google token for a linked YouTube channel (design §13.2).
 *
 * "Link YouTube" on Connections goes through the existing platform sign-in (/stream/connect/youtube?for=bot,
 * dashboard/routes/stream-connect.js), which stores the tokens encrypted in stream_platform_accounts (one row per CertiFried
 * user and platform, the same row multicast uses) and links the channel it proved. This module reads that row, refreshes the
 * access token when it has under 5 minutes left (one refresh per account however many callers wait) and writes the new one
 * back. Google answering invalid_grant (revoked, or a Testing-mode token past its 7 days) marks the row needs_reconnect and
 * later calls fail at once until the streamer links again. Tokens never reach a log line or an error message.
 *
 *   createYouTubeAuth({ db, encryption, clientId, clientSecret, fetchImpl?, now?, logger?, table? })
 *     .token({ ownerId, channelId }, { force, write }) → { accessToken, scopes: string[], accountId }   throws YouTubeAuthError(code)
 *     .status({ ownerId, channelId })                  → { state: 'ok'|'needs_reconnect'|'missing'|'other_channel', scopes }
 *   codes: missing (no sign-in row), other_channel (signed in with a different channel), needs_reconnect, scope (no write scope),
 *          refresh_failed (network or Google 5xx: try later)
 */
import { canRead, canWrite } from './config.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EARLY_MS = 5 * 60_000;

export class YouTubeAuthError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
}

const MESSAGES = Object.freeze({
    missing: 'Link YouTube on the Connections page first.',
    other_channel: 'The YouTube sign-in on file is for a different channel. Link YouTube again on Connections.',
    needs_reconnect: 'YouTube no longer accepts CertiFried\'s sign-in. Link YouTube again on Connections.',
    scope: 'The YouTube sign-in does not allow sending or moderating chat. Link YouTube again on Connections.',
    refresh_failed: 'Could not reach Google to renew the YouTube sign-in. It is tried again shortly.',
});
const fail = (code) => { throw new YouTubeAuthError(code, MESSAGES[code]); };

export function createYouTubeAuth({ db, encryption, clientId, clientSecret, fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now(), logger = null, table = 'stream_platform_accounts' } = {}) {
    const T = `\`${table}\``;
    const inflight = new Map();
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotYouTube] ${msg}`, meta); } catch { /* ignore */ } };
    const enc = (s) => (s == null ? null : JSON.stringify(encryption.encrypt(s)));
    const dec = (s) => { if (s == null) return null; try { return encryption.decrypt(JSON.parse(s)); } catch { return null; } };

    async function row({ ownerId }) {
        const [rows] = await db.query(`SELECT id, platform_user_id, access_token, refresh_token, expires_at, scopes, status FROM ${T} WHERE owner_discord_id = ? AND platform = 'youtube' LIMIT 1`, [String(ownerId)]);
        return rows[0] || null;
    }

    async function refresh(r) {
        const refreshToken = dec(r.refresh_token);
        if (!refreshToken) {
            await db.query(`UPDATE ${T} SET status = 'needs_reconnect' WHERE id = ?`, [r.id]).catch(() => {});
            fail('needs_reconnect');
        }
        let res;
        let body = null;
        try {
            res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
                signal: AbortSignal.timeout(10_000) });
            try { body = await res.json(); } catch { body = null; }
        } catch {
            fail('refresh_failed');
        }
        if (!res.ok || !body?.access_token) {
            if (res.status === 400 || res.status === 401) {
                // invalid_grant: revoked, password change, or a Testing-mode refresh token past 7 days.
                await db.query(`UPDATE ${T} SET status = 'needs_reconnect' WHERE id = ?`, [r.id]).catch(() => {});
                log('warn', 'YouTube sign-in refused by Google; marked needs_reconnect', { accountId: r.id, error: String(body?.error || res.status).slice(0, 40) });
                fail('needs_reconnect');
            }
            fail('refresh_failed');
        }
        const expiresAt = new Date(now() + (Number(body.expires_in) || 3600) * 1000);
        const scopes = body.scope ? String(body.scope) : r.scopes;
        // Only while the row still holds the refresh token this refresh started from (a new sign-in in between wins).
        await db.query(`UPDATE ${T} SET access_token = ?, expires_at = ?, scopes = ?${body.refresh_token ? ', refresh_token = ?' : ''} WHERE id = ? AND refresh_token = ?`,
            [enc(body.access_token), expiresAt, scopes, ...(body.refresh_token ? [enc(body.refresh_token)] : []), r.id, r.refresh_token]);
        return { accessToken: body.access_token, scopes: String(scopes || '').split(/[\s,]+/).filter(Boolean), accountId: Number(r.id) };
    }

    async function token({ ownerId, channelId }, { force = false, write = false } = {}) {
        const r = await row({ ownerId });
        if (!r) fail('missing');
        if (channelId && String(r.platform_user_id) !== String(channelId)) fail('other_channel');
        if (r.status !== 'active') fail('needs_reconnect');
        const scopes = String(r.scopes || '').split(/[\s,]+/).filter(Boolean);
        // An empty scope list is an older multicast row (scope `youtube`, not recorded): treat it as able to read and write.
        if (scopes.length && (write ? !canWrite(scopes) : !canRead(scopes))) fail('scope');
        const exp = r.expires_at ? new Date(r.expires_at).getTime() : 0;
        const access = dec(r.access_token);
        if (!force && access && exp - now() > EARLY_MS) return { accessToken: access, scopes, accountId: Number(r.id) };
        const key = Number(r.id);
        if (!inflight.has(key)) inflight.set(key, refresh(r).finally(() => inflight.delete(key)));
        return inflight.get(key);
    }

    async function status({ ownerId, channelId }) {
        let r = null;
        try { r = await row({ ownerId }); } catch { return { state: 'unknown', scopes: [] }; }
        if (!r) return { state: 'missing', scopes: [] };
        const scopes = String(r.scopes || '').split(/[\s,]+/).filter(Boolean);
        if (channelId && String(r.platform_user_id) !== String(channelId)) return { state: 'other_channel', scopes };
        if (r.status !== 'active') return { state: 'needs_reconnect', scopes };
        return { state: 'ok', scopes, canWrite: !scopes.length || canWrite(scopes) };
    }

    return { token, status };
}

export default { createYouTubeAuth, YouTubeAuthError };
