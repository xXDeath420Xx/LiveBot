/*
 * Hourly validation of every Twitch user token CertiFried holds (H-751). Twitch asks apps to call
 * GET https://id.twitch.tv/oauth2/validate for each user token at start-up and hourly, so a token revoked on Twitch's
 * side is noticed even when nothing has used it.
 *
 * Tokens covered (inventory 2026-11-19; schedule_users holds Twitch login tokens that nothing reads, see the register):
 *
 *   key                 table                          token columns                              marked when dead
 *   stream_bot_grant    stream_bot_twitch_grants       access_token / refresh_token (encryption)  status = 'needs_reauth'
 *   server_analytics    twitch_role_sync_config        broadcaster_token / _refresh_token         broadcaster_token_status = 'needs_reauth'
 *   server_write        twitch_role_sync_config        tier_b_token / tier_b_refresh_token        tier_b_token_status = 'needs_reauth'
 *   linked_twitch       twitch_oauth_accounts          access_token / refresh_token               token_status = 'needs_reauth'
 *   multicast_twitch    stream_platform_accounts       access_token / refresh_token (twitch)      status = 'needs_reconnect'
 *   channel_bot_twitch  tokes_platform_connections     access_token / refresh_token (token-enc)   needs_relink = 1
 *   chat_bot_env        TWITCH_BOT_OAUTH (.env)        validated only (no refresh, nothing to mark)
 *
 * Spread over the hour: each token has a fixed minute (a hash of source and row id), and the job runs once a minute on
 * that minute's tokens, at most `concurrency` (3) at a time; a minute that is still running when the next starts is not
 * started twice. A token Twitch refuses (401) is refreshed with its refresh token and the new pair stored; when the refresh
 * is refused too (400/401), or there is no refresh token, the grant is marked as above so its page asks for a reconnect,
 * and it is not checked again until it is connected again. Network errors and Twitch 5xx change nothing.
 *
 * Logs carry counts only (one debug line per minute with work, one info summary per hour); never a token or an id.
 *
 *   createTokenSources({ encryption, tokenEncryption, env, tables })   the table adapters (tables: overrides for tests)
 *   createTokenValidator({ db, sources, fetchImpl, now, logger, concurrency, slots, clientId, clientSecret })
 *     .runSlot(minute) → counts    .runAll() → counts    .start()    .stop()
 *   slotOf(key, slots)             the minute a token is checked in
 *   startTwitchTokenValidation()   the live job (index.js)
 *
 * Tested in tests/twitch-token-validator.test.js.
 */

export const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
export const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
export const OUTCOMES = Object.freeze(['valid', 'refreshed', 'reauth', 'invalid', 'error', 'unreadable']);

/** FNV-1a of the key, as a minute of the hour (stable across restarts). */
export function slotOf(key, slots = 60) {
    let h = 0x811c9dc5;
    for (const ch of String(key)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h % slots;
}

const mysqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/**
 * The table adapters. Each: { key, list(db) → [{ id, access, refresh }], save?(db, id, { access, refresh, expiresAt }),
 * mark?(db, id) }. Decryption failures give access/refresh = undefined (counted as unreadable).
 */
export function createTokenSources({ encryption, tokenEncryption = null, env = process.env, tables = {} } = {}) {
    const t = { grants: 'stream_bot_twitch_grants', roleSync: 'twitch_role_sync_config', oauth: 'twitch_oauth_accounts', platform: 'stream_platform_accounts', tokes: 'tokes_platform_connections', ...tables };
    for (const v of Object.values(t)) if (!/^[a-z0-9_]{1,64}$/.test(v)) throw new Error('bad table name');
    const q = async (db, sql, params = []) => (await db.query(sql, params))[0];
    const jdec = (s) => { if (s == null) return null; try { return encryption.decrypt(JSON.parse(s)); } catch { return undefined; } };
    const jenc = (s) => (s == null ? null : JSON.stringify(encryption.encrypt(String(s))));
    const tdec = (s) => { if (s == null) return null; try { return tokenEncryption.decryptToken(s); } catch { return undefined; } };
    const tenc = (s) => (s == null ? null : tokenEncryption.encryptToken(String(s)));

    const sources = [
        {
            key: 'stream_bot_grant',
            async list(db) {
                return (await q(db, `SELECT profile_id AS id, access_token, refresh_token FROM \`${t.grants}\` WHERE status = 'active'`))
                    .map((r) => ({ id: String(r.id), access: jdec(r.access_token), refresh: jdec(r.refresh_token) }));
            },
            async save(db, id, n) {
                await q(db, `UPDATE \`${t.grants}\` SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ? WHERE profile_id = ? AND status = 'active'`,
                    [jenc(n.access), jenc(n.refresh), n.expiresAt, id]);
            },
            async mark(db, id) { await q(db, `UPDATE \`${t.grants}\` SET status = 'needs_reauth' WHERE profile_id = ?`, [id]); },
        },
        {
            key: 'server_analytics',
            async list(db) {
                return (await q(db, `SELECT guild_id AS id, broadcaster_token, broadcaster_refresh_token FROM \`${t.roleSync}\`
                                     WHERE enabled = 1 AND broadcaster_token IS NOT NULL AND broadcaster_token_status = 'active'`))
                    .map((r) => ({ id: String(r.id), access: jdec(r.broadcaster_token), refresh: jdec(r.broadcaster_refresh_token) }));
            },
            async save(db, id, n) {
                await q(db, `UPDATE \`${t.roleSync}\` SET broadcaster_token = ?, broadcaster_refresh_token = COALESCE(?, broadcaster_refresh_token), token_expires_at = ? WHERE guild_id = ?`,
                    [jenc(n.access), jenc(n.refresh), mysqlTime(n.expiresAt), id]);
            },
            async mark(db, id) { await q(db, `UPDATE \`${t.roleSync}\` SET broadcaster_token_status = 'needs_reauth' WHERE guild_id = ?`, [id]); },
        },
        {
            key: 'server_write',
            async list(db) {
                return (await q(db, `SELECT guild_id AS id, tier_b_token, tier_b_refresh_token FROM \`${t.roleSync}\`
                                     WHERE enabled = 1 AND tier_b_token IS NOT NULL AND tier_b_token_status = 'active'`))
                    .map((r) => ({ id: String(r.id), access: jdec(r.tier_b_token), refresh: jdec(r.tier_b_refresh_token) }));
            },
            async save(db, id, n) {
                await q(db, `UPDATE \`${t.roleSync}\` SET tier_b_token = ?, tier_b_refresh_token = COALESCE(?, tier_b_refresh_token), tier_b_token_expires_at = ? WHERE guild_id = ?`,
                    [jenc(n.access), jenc(n.refresh), mysqlTime(n.expiresAt), id]);
            },
            async mark(db, id) { await q(db, `UPDATE \`${t.roleSync}\` SET tier_b_token_status = 'needs_reauth' WHERE guild_id = ?`, [id]); },
        },
        {
            key: 'linked_twitch',
            async list(db) {
                return (await q(db, `SELECT discord_user_id AS id, access_token, refresh_token FROM \`${t.oauth}\` WHERE access_token IS NOT NULL AND token_status = 'active'`))
                    .map((r) => ({ id: String(r.id), access: jdec(r.access_token), refresh: jdec(r.refresh_token) }));
            },
            async save(db, id, n) {
                await q(db, `UPDATE \`${t.oauth}\` SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ? WHERE discord_user_id = ?`,
                    [jenc(n.access), jenc(n.refresh), mysqlTime(n.expiresAt), id]);
            },
            async mark(db, id) { await q(db, `UPDATE \`${t.oauth}\` SET token_status = 'needs_reauth' WHERE discord_user_id = ?`, [id]); },
        },
        {
            key: 'multicast_twitch',
            async list(db) {
                return (await q(db, `SELECT id, access_token, refresh_token FROM \`${t.platform}\` WHERE platform = 'twitch' AND status = 'active' AND access_token IS NOT NULL`))
                    .map((r) => ({ id: String(r.id), access: jdec(r.access_token), refresh: jdec(r.refresh_token) }));
            },
            async save(db, id, n) {
                await q(db, `UPDATE \`${t.platform}\` SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ? WHERE id = ?`,
                    [jenc(n.access), jenc(n.refresh), mysqlTime(n.expiresAt), id]);
            },
            async mark(db, id) { await q(db, `UPDATE \`${t.platform}\` SET status = 'needs_reconnect' WHERE id = ?`, [id]); },
        },
    ];
    if (tokenEncryption) {
        sources.push({
            key: 'channel_bot_twitch',
            async list(db) {
                return (await q(db, `SELECT id, access_token, refresh_token FROM \`${t.tokes}\` WHERE platform = 'twitch' AND needs_relink = 0 AND access_token IS NOT NULL`))
                    .map((r) => ({ id: String(r.id), access: tdec(r.access_token), refresh: tdec(r.refresh_token) }));
            },
            async save(db, id, n) {
                await q(db, `UPDATE \`${t.tokes}\` SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, token_updated_at = NOW() WHERE id = ?`,
                    [tenc(n.access), tenc(n.refresh), mysqlTime(n.expiresAt), id]);
            },
            async mark(db, id) { await q(db, `UPDATE \`${t.tokes}\` SET needs_relink = 1 WHERE id = ?`, [id]); },
        });
    }
    sources.push({
        key: 'chat_bot_env',
        async list() {
            const tok = String(env.TWITCH_BOT_OAUTH || env.TWITCH_OAUTH_TOKEN || '').replace(/^oauth:/i, '');
            return tok ? [{ id: 'env', access: tok, refresh: null }] : [];
        },
    });
    return sources;
}

export function createTokenValidator({
    db, sources, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), logger = null, concurrency = 3, slots = 60,
    clientId = process.env.TWITCH_CLIENT_ID, clientSecret = process.env.TWITCH_CLIENT_SECRET,
} = {}) {
    const log = (level, msg) => { try { logger?.[level]?.(`[TwitchTokenCheck] ${msg}`); } catch { /* ignore */ } };
    const zero = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
    let hour = zero();
    let hourStarted = now();
    let timer = null;
    let busy = false;
    let lastMinute = null;

    async function validate(token) {
        try {
            const res = await fetchImpl(VALIDATE_URL, { headers: { Authorization: `OAuth ${token}` } });
            return res.status;
        } catch { return 0; }
    }
    async function refresh(refreshToken) {
        try {
            const res = await fetchImpl(TOKEN_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId || '', client_secret: clientSecret || '' }).toString(),
            });
            let body = null;
            try { body = await res.json(); } catch { body = null; }
            return { status: res.status, body };
        } catch { return { status: 0, body: null }; }
    }

    /** One token → an outcome. */
    async function checkOne(src, item) {
        if (item.access === undefined || item.refresh === undefined) return 'unreadable';
        const status = item.access ? await validate(item.access) : 401;
        if (status === 200) return 'valid';
        if (status !== 401) return 'error';
        if (!src.mark) return 'invalid';                          // the .env bot token: nothing to refresh or mark
        if (!item.refresh || !src.save) { await src.mark(db, item.id); return 'reauth'; }
        const r = await refresh(item.refresh);
        if (r.status === 200 && r.body?.access_token) {
            await src.save(db, item.id, { access: r.body.access_token, refresh: r.body.refresh_token || null, expiresAt: new Date(now() + (Number(r.body.expires_in) || 3600) * 1000) });
            return 'refreshed';
        }
        if (r.status === 400 || r.status === 401) { await src.mark(db, item.id); return 'reauth'; }
        return 'error';
    }

    /** Every token of every source whose minute is `minute` (or all, when minute is null). */
    async function due(minute) {
        const out = [];
        for (const src of sources) {
            let rows = [];
            try { rows = await src.list(db); } catch (err) {
                // A table not migrated yet, or gone: skip it, say which source (no data).
                log('warn', `could not read ${src.key}: ${err?.code || 'error'}`);
                continue;
            }
            for (const item of rows) if (minute == null || slotOf(`${src.key}:${item.id}`, slots) === minute) out.push({ src, item });
        }
        return out;
    }

    async function run(minute) {
        const counts = zero();
        const list = await due(minute);
        let next = 0;
        const worker = async () => {
            while (next < list.length) {
                const { src, item } = list[next++];
                let outcome;
                try { outcome = await checkOne(src, item); } catch { outcome = 'error'; }
                counts[outcome]++;
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
        const total = OUTCOMES.reduce((n, o) => n + counts[o], 0);
        for (const o of OUTCOMES) hour[o] += counts[o];
        if (total) log('debug', `minute ${minute ?? 'all'}: ${total} checked, ${OUTCOMES.filter((o) => counts[o]).map((o) => `${counts[o]} ${o}`).join(', ')}`);
        return { ...counts, total };
    }

    function summary() {
        const total = OUTCOMES.reduce((n, o) => n + hour[o], 0);
        log(hour.reauth || hour.invalid ? 'warn' : 'info', `last hour: ${total} Twitch tokens checked; ${OUTCOMES.map((o) => `${hour[o]} ${o}`).join(', ')}`);
        hour = zero();
        hourStarted = now();
    }

    async function tick() {
        const minute = new Date(now()).getUTCMinutes();
        if (busy || minute === lastMinute) return null;
        lastMinute = minute;
        if (minute === 0 && now() - hourStarted > 30 * 60_000) summary();
        busy = true;
        try { return await run(minute); } catch { return null; } finally { busy = false; }
    }

    return {
        runSlot: (minute) => run(minute),
        runAll: () => run(null),
        checkOne,
        tick,
        start(intervalMs = 15_000) {
            if (timer) return;
            timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
            timer.unref?.();
        },
        stop() { if (timer) clearInterval(timer); timer = null; },
        _hour: () => ({ ...hour }),
    };
}

let live = null;

/** The live job, started by index.js once. */
export async function startTwitchTokenValidation() {
    if (live) return live;
    const [{ default: pool }, { default: encryption }, tokenEncryption, { default: logger }] = await Promise.all([
        import('../utils/db.js'), import('../utils/encryption.js'), import('../utils/token-encryption.js'), import('../utils/logger.js'),
    ]);
    live = createTokenValidator({ db: pool, sources: createTokenSources({ encryption, tokenEncryption }), logger });
    live.start();
    logger.info('[TwitchTokenCheck] hourly Twitch token validation started (each token once an hour, spread over the minutes)');
    return live;
}

export default { createTokenSources, createTokenValidator, slotOf, startTwitchTokenValidation, VALIDATE_URL, TOKEN_URL, OUTCOMES };
