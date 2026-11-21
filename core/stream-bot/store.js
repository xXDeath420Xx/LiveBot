/*
 * Stream bot: every database read and write (tables from migrations/454_stream_bot.js).
 *
 *   createStore({ db, prefix = 'stream_bot_', encryption })
 *
 * `db` is a mysql2/promise pool; `prefix` lets tests use throwaway tables built with streamBotDdl(prefix);
 * `encryption` (utils/encryption.js shape: encrypt(s) → object, decrypt(object) → s) protects tip-feed
 * tokens and the Twitch grant tokens. Every profile-owned query carries profile_id, so a route can only
 * reach the signed-in user's rows.
 *
 * The variables part (`variableStore`) has the interface of core/custom-command-store.js (get, set, incr,
 * del) so core/custom-command-vars.js runDbOp() drives it: guildId = profile id, owner = 'server' for
 * {sdb:} or '<platform>:<viewer id>' for {db:}.
 */
import { publicEvent } from './events.js';
import { createNamedIndex } from './named.js';

const NUMBER_MAX = 999_999_999_999_999;
const NUMERIC = /^[+-]?\d{1,15}$/;
const storedNumber = (v) => { const s = String(v ?? '').trim(); return NUMERIC.test(s) ? Number(s) : 0; };
const clamp = (n) => Math.max(-NUMBER_MAX, Math.min(NUMBER_MAX, n));

const parseJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
};
const json = (v) => (v == null ? null : JSON.stringify(v));
const RAW_MAX = 16 * 1024;

function rawText(raw) {
    if (raw == null) return null;
    let s;
    try { s = typeof raw === 'string' ? raw : JSON.stringify(raw); } catch { return null; }
    return s.length > RAW_MAX ? s.slice(0, RAW_MAX) : s;
}

export function createStore({ db, prefix = 'stream_bot_', encryption = null } = {}) {
    if (!db) throw new Error('createStore needs a db pool');
    if (!/^[a-z0-9_]{1,30}$/.test(prefix)) throw new Error('bad table prefix');
    // H-783: other viewers named in an event (reply parent, mention, giftee, raid target), indexed for /privacy.
    const named = createNamedIndex({ db, prefix });
    const T = (n) => `\`${prefix}${n}\``;
    const q = async (sql, params = []) => (await db.query(sql, params))[0];
    const enc = (s) => (s == null || !encryption ? null : JSON.stringify(encryption.encrypt(String(s))));
    const dec = (s) => {
        if (s == null || !encryption) return null;
        try { return encryption.decrypt(JSON.parse(s)); } catch { return null; }
    };

    const profileRow = (r) => r && ({
        id: Number(r.id), ownerDiscordId: r.owner_discord_id, displayName: r.display_name, enabled: !!r.enabled,
        storeChat: !!r.store_chat, webhookAllowHosts: parseJson(r.webhook_allow_hosts, []), settings: parseJson(r.settings, {}),
        createdAt: r.created_at,
    });
    const automationRow = (r) => r && ({
        id: Number(r.id), profile_id: Number(r.profile_id), name: r.name, enabled: !!r.enabled, trigger_type: r.trigger_type,
        trigger_config: parseJson(r.trigger_config, {}), conditions: parseJson(r.conditions, []), actions: parseJson(r.actions, []),
        last_run_at: r.last_run_at, created_at: r.created_at, updated_at: r.updated_at,
    });
    const eventRow = (r) => r && ({
        id: Number(r.id), profileId: Number(r.profile_id), platform: r.platform, type: r.type, channelId: r.channel_id,
        user: r.actor_id || r.actor_login || r.actor_name ? { id: r.actor_id, login: r.actor_login, name: r.actor_name, roles: parseJson(r.metadata, {})?._roles || [] } : null,
        amount: r.amount == null ? null : Number(r.amount), currency: r.currency, message: r.message,
        metadata: (() => { const m = parseJson(r.metadata, {}) || {}; delete m._roles; return m; })(),
        test: !!r.is_test, occurredAt: r.occurred_at, createdAt: r.created_at,
    });
    const runRow = (r) => r && ({
        id: Number(r.id), profileId: Number(r.profile_id), automationId: r.automation_id == null ? null : Number(r.automation_id),
        automationName: r.automation_name, eventId: r.event_id == null ? null : Number(r.event_id), source: r.source,
        parentRunId: r.parent_run_id == null ? null : Number(r.parent_run_id), depth: Number(r.depth), dryRun: !!r.dry_run,
        status: r.status, skipReason: r.skip_reason, input: parseJson(r.input, null), checks: parseJson(r.checks, []),
        steps: parseJson(r.steps, []), error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
    });
    const deviceRow = (r) => r && ({
        id: Number(r.id), profileId: Number(r.profile_id), kind: r.kind, name: r.name, tokenHint: r.token_hint,
        capabilities: parseJson(r.capabilities, []), clientInfo: r.client_info, createdAt: r.created_at,
        lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at,
    });
    const dispatchRow = (r) => r && ({
        id: r.id, profileId: Number(r.profile_id), runId: r.run_id == null ? null : Number(r.run_id), target: r.target,
        capability: r.capability, actionType: r.action_type, params: parseJson(r.params, {}), status: r.status,
        attempts: Number(r.attempts), deviceId: r.device_id == null ? null : Number(r.device_id), error: r.error,
        result: parseJson(r.result, null), createdAt: r.created_at, expiresAt: r.expires_at, sentAt: r.sent_at, ackedAt: r.acked_at,
    });

    const store = {
        prefix,
        table: (n) => `${prefix}${n}`,

        // ── profiles ──
        async getProfileByOwner(ownerId) {
            return profileRow((await q(`SELECT * FROM ${T('profiles')} WHERE owner_discord_id = ?`, [String(ownerId)]))[0]);
        },
        async getProfile(id) {
            return profileRow((await q(`SELECT * FROM ${T('profiles')} WHERE id = ?`, [id]))[0]);
        },
        async ensureProfile(ownerId, displayName = null) {
            await q(`INSERT INTO ${T('profiles')} (owner_discord_id, display_name, webhook_allow_hosts, settings) VALUES (?, ?, '[]', '{}')
                     ON DUPLICATE KEY UPDATE display_name = COALESCE(display_name, VALUES(display_name))`, [String(ownerId), displayName ? String(displayName).slice(0, 100) : null]);
            return store.getProfileByOwner(ownerId);
        },
        async updateSettings(profileId, { storeChat, webhookAllowHosts, enabled } = {}) {
            const sets = [], params = [];
            if (storeChat !== undefined) { sets.push('store_chat = ?'); params.push(storeChat ? 1 : 0); }
            if (enabled !== undefined) { sets.push('enabled = ?'); params.push(enabled ? 1 : 0); }
            if (webhookAllowHosts !== undefined) { sets.push('webhook_allow_hosts = ?'); params.push(json(webhookAllowHosts)); }
            if (!sets.length) return;
            await q(`UPDATE ${T('profiles')} SET ${sets.join(', ')} WHERE id = ?`, [...params, profileId]);
        },
        /** Set one top-level key of the profile's settings JSON (Phase 2: 'studio', 'sounds'); null removes it. */
        async setSettingsKey(profileId, key, value) {
            if (!/^[a-z][a-zA-Z0-9_]{0,40}$/.test(String(key))) throw new Error('bad settings key');
            if (value === null || value === undefined) {
                await q(`UPDATE ${T('profiles')} SET settings = JSON_REMOVE(COALESCE(settings, '{}'), ?) WHERE id = ?`, [`$.${key}`, profileId]);
                return;
            }
            await q(`UPDATE ${T('profiles')} SET settings = JSON_SET(COALESCE(settings, '{}'), ?, JSON_EXTRACT(?, '$')) WHERE id = ?`, [`$.${key}`, json(value), profileId]);
        },
        async getSettingsKey(profileId, key) {
            const p = await store.getProfile(profileId);
            return p?.settings?.[key] ?? null;
        },

        // ── channels ──
        async listChannels(profileId) {
            return q(`SELECT id, platform, platform_user_id, login, display_name, verified_via, linked_at FROM ${T('channels')} WHERE profile_id = ? ORDER BY platform, id`, [profileId]);
        },
        /** Link a channel. Returns { ok } or { ok: false, error: 'taken' } when another profile has it. */
        async linkChannel(profileId, { platform, platformUserId, login = null, displayName = null, verifiedVia }) {
            const [existing] = await q(`SELECT profile_id FROM ${T('channels')} WHERE platform = ? AND platform_user_id = ?`, [platform, String(platformUserId)]);
            if (existing && Number(existing.profile_id) !== Number(profileId)) return { ok: false, error: 'taken' };
            await q(`INSERT INTO ${T('channels')} (profile_id, platform, platform_user_id, login, display_name, verified_via) VALUES (?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE login = VALUES(login), display_name = VALUES(display_name), verified_via = VALUES(verified_via)`,
                [profileId, platform, String(platformUserId), login, displayName, verifiedVia]);
            return { ok: true };
        },
        async unlinkChannel(profileId, id) {
            const r = await q(`DELETE FROM ${T('channels')} WHERE profile_id = ? AND id = ?`, [profileId, id]);
            return r.affectedRows > 0;
        },
        async getChannel(profileId, id) {
            return (await q(`SELECT * FROM ${T('channels')} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0] || null;
        },
        /** Profiles a platform channel belongs to (0 or 1 by the unique key), with what ingestion needs. */
        async profilesForChannel(platform, platformUserId) {
            return (await q(`SELECT p.id, p.store_chat, p.enabled, c.login FROM ${T('channels')} c JOIN ${T('profiles')} p ON p.id = c.profile_id
                              WHERE c.platform = ? AND c.platform_user_id = ? AND p.enabled = 1`, [platform, String(platformUserId)]))
                .map((r) => ({ profileId: Number(r.id), storeChat: !!r.store_chat, login: r.login }));
        },
        async linkedTwitchChannels() {
            return q(`SELECT DISTINCT platform_user_id AS id, login FROM ${T('channels')} WHERE platform = 'twitch'`);
        },

        // ── Twitch grant ──
        async saveTwitchGrant(profileId, { twitchUserId, twitchLogin, accessToken, refreshToken, expiresAt, scopes }) {
            await q(`INSERT INTO ${T('twitch_grants')} (profile_id, twitch_user_id, twitch_login, access_token, refresh_token, expires_at, scopes, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
                     ON DUPLICATE KEY UPDATE twitch_user_id = VALUES(twitch_user_id), twitch_login = VALUES(twitch_login), access_token = VALUES(access_token),
                       refresh_token = VALUES(refresh_token), expires_at = VALUES(expires_at), scopes = VALUES(scopes), status = 'active', granted_at = CURRENT_TIMESTAMP`,
                [profileId, String(twitchUserId), twitchLogin, enc(accessToken), enc(refreshToken), expiresAt, scopes]);
        },
        async getTwitchGrant(profileId) {
            const r = (await q(`SELECT profile_id, twitch_user_id, twitch_login, expires_at, scopes, status, granted_at FROM ${T('twitch_grants')} WHERE profile_id = ?`, [profileId]))[0];
            return r ? { ...r, scopes: String(r.scopes || '').split(/\s+/).filter(Boolean) } : null;
        },
        /** The decrypted access token (only for revoking it at Twitch; never sent to a browser). */
        async getTwitchGrantToken(profileId) {
            const r = (await q(`SELECT access_token FROM ${T('twitch_grants')} WHERE profile_id = ?`, [profileId]))[0];
            return r ? dec(r.access_token) : null;
        },
        /** The grant with its tokens decrypted, for core/stream-bot/twitch-auth.js only (never sent to a browser or logged). */
        async getTwitchGrantSecrets(profileId) {
            const r = (await q(`SELECT twitch_user_id, twitch_login, access_token, refresh_token, expires_at, scopes, status FROM ${T('twitch_grants')} WHERE profile_id = ?`, [profileId]))[0];
            if (!r) return null;
            return {
                twitchUserId: r.twitch_user_id, twitchLogin: r.twitch_login, accessToken: dec(r.access_token), refreshToken: dec(r.refresh_token),
                refreshEnc: r.refresh_token ?? null, expiresAt: r.expires_at, scopes: String(r.scopes || '').split(/\s+/).filter(Boolean), status: r.status,
            };
        },
        /**
         * Store a refreshed token pair (Twitch rotates the refresh token too). Written only while the grant is active and
         * still holds `previous` (the encrypted refresh token the refresh started from); false when it was removed or
         * replaced meanwhile.
         */
        async rotateTwitchGrant(profileId, { accessToken, refreshToken, expiresAt, scopes, previous = null }) {
            const r = await q(`UPDATE ${T('twitch_grants')} SET access_token = ?, refresh_token = ?, expires_at = ?, scopes = COALESCE(?, scopes)
                               WHERE profile_id = ? AND status = 'active' AND refresh_token <=> ?`,
                [enc(accessToken), enc(refreshToken), expiresAt, scopes || null, profileId, previous]);
            return r.affectedRows > 0;
        },
        /** 'active' or 'needs_reauth' (Twitch refused the refresh token: only a new consent helps). */
        async setTwitchGrantStatus(profileId, status) {
            await q(`UPDATE ${T('twitch_grants')} SET status = ? WHERE profile_id = ?`, [String(status).slice(0, 20), profileId]);
        },
        async deleteTwitchGrant(profileId) {
            await q(`DELETE FROM ${T('twitch_grants')} WHERE profile_id = ?`, [profileId]);
        },
        /** Scopes from Stream bot grants for a Twitch user (any profile), for EventSub eligibility. */
        async grantScopesForTwitchUser(twitchUserId) {
            const rows = await q(`SELECT scopes FROM ${T('twitch_grants')} WHERE twitch_user_id = ? AND status = 'active'`, [String(twitchUserId)]);
            return new Set(rows.flatMap((r) => String(r.scopes || '').split(/\s+/).filter(Boolean)));
        },

        // ── tip sources ──
        async listTipSources(profileId) {
            return (await q(`SELECT id, source, ref, enabled, status, last_error, last_event_at, created_at, secret IS NOT NULL AS has_secret FROM ${T('tip_sources')} WHERE profile_id = ? ORDER BY id`, [profileId]))
                .map((r) => ({ ...r, id: Number(r.id), enabled: !!r.enabled, has_secret: !!Number(r.has_secret) }));
        },
        async addTipSource(profileId, { source, ref = '', secret = null }) {
            await q(`INSERT INTO ${T('tip_sources')} (profile_id, source, ref, secret, enabled, status) VALUES (?, ?, ?, ?, 1, 'new')
                     ON DUPLICATE KEY UPDATE secret = COALESCE(VALUES(secret), secret), enabled = 1, status = 'new', last_error = NULL`,
                [profileId, source, String(ref || ''), enc(secret)]);
            return (await q(`SELECT id FROM ${T('tip_sources')} WHERE profile_id = ? AND source = ? AND ref = ?`, [profileId, source, String(ref || '')]))[0]?.id ?? null;
        },
        async setTipSourceEnabled(profileId, id, enabled) {
            return (await q(`UPDATE ${T('tip_sources')} SET enabled = ? WHERE profile_id = ? AND id = ?`, [enabled ? 1 : 0, profileId, id])).affectedRows > 0;
        },
        async deleteTipSource(profileId, id) {
            return (await q(`DELETE FROM ${T('tip_sources')} WHERE profile_id = ? AND id = ?`, [profileId, id])).affectedRows > 0;
        },
        async profilesForTip(source, ref) {
            return (await q(`SELECT s.id AS source_id, p.id, p.store_chat FROM ${T('tip_sources')} s JOIN ${T('profiles')} p ON p.id = s.profile_id
                              WHERE s.source = ? AND s.ref = ? AND s.enabled = 1 AND p.enabled = 1`, [source, String(ref ?? '')]))
                .map((r) => ({ profileId: Number(r.id), sourceId: Number(r.source_id) }));
        },
        /** Enabled StreamElements/Streamlabs sources with their decrypted tokens (tip-feeds only). */
        async socketTipSources() {
            return (await q(`SELECT s.id, s.profile_id, s.source, s.secret FROM ${T('tip_sources')} s JOIN ${T('profiles')} p ON p.id = s.profile_id
                              WHERE s.source IN ('streamelements', 'streamlabs') AND s.enabled = 1 AND p.enabled = 1 AND s.secret IS NOT NULL`))
                .map((r) => ({ id: Number(r.id), profileId: Number(r.profile_id), source: r.source, token: dec(r.secret) }))
                .filter((r) => r.token);
        },
        async setTipSourceStatus(id, status, error = null) {
            await q(`UPDATE ${T('tip_sources')} SET status = ?, last_error = ? WHERE id = ?`, [String(status).slice(0, 40), error ? String(error).slice(0, 255) : null, id]);
        },
        async touchTipSource(id) {
            await q(`UPDATE ${T('tip_sources')} SET last_event_at = NOW(), status = 'ok', last_error = NULL WHERE id = ?`, [id]);
        },
        async bmacOwnersWithSource() {
            return (await q(`SELECT DISTINCT s.ref FROM ${T('tip_sources')} s JOIN ${T('profiles')} p ON p.id = s.profile_id
                              WHERE s.source = 'bmac' AND s.enabled = 1 AND p.enabled = 1`)).map((r) => r.ref);
        },

        // ── heart rate: the optional Pulsoid token (Studio 0.2.14; profile settings key 'heart', the token encrypted) ──
        /** What the Connections page shows: never the token. */
        async heartPulsoidView(profileId) {
            const h = (await store.getSettingsKey(profileId, 'heart'))?.pulsoid || null;
            return h && h.secret ? { configured: true, status: h.status || 'new', lastError: h.lastError || null, addedAt: h.addedAt || null } : { configured: false, status: null, lastError: null, addedAt: null };
        },
        async setHeartPulsoid(profileId, token) {
            await store.setSettingsKey(profileId, 'heart', { pulsoid: { secret: enc(token), addedAt: new Date().toISOString(), status: 'new', lastError: null } });
        },
        async clearHeartPulsoid(profileId) { await store.setSettingsKey(profileId, 'heart', null); },
        async setHeartPulsoidStatus(profileId, status, error = null) {
            const h = (await store.getSettingsKey(profileId, 'heart'))?.pulsoid;
            if (!h || !h.secret) return;
            await store.setSettingsKey(profileId, 'heart', { pulsoid: { ...h, status: String(status).slice(0, 40), lastError: error ? String(error).slice(0, 255) : null } });
        },
        /** Enabled profiles with a Pulsoid token, decrypted (heart/pulsoid.js only). */
        async heartPulsoidSources() {
            const rows = await q(`SELECT id, JSON_UNQUOTE(JSON_EXTRACT(settings, '$.heart.pulsoid.secret')) AS secret FROM ${T('profiles')}
                                  WHERE enabled = 1 AND JSON_EXTRACT(settings, '$.heart.pulsoid.secret') IS NOT NULL`);
            return rows.map((r) => ({ profileId: Number(r.id), token: dec(r.secret) })).filter((r) => r.token);
        },

        // ── events ──
        /** Store an event. Returns the new id, or null when the dedupe key was seen already. */
        async insertEvent(profileId, ev) {
            const meta = { ...(ev.metadata || {}) };
            if (ev.user?.roles?.length) meta._roles = ev.user.roles;
            try {
                const r = await q(`INSERT INTO ${T('events')} (profile_id, platform, type, channel_id, dedupe_key, actor_id, actor_login, actor_name, amount, currency, message, metadata, raw, is_test, occurred_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [profileId, ev.platform, ev.type, ev.channelId ?? null, ev.dedupeKey ?? null, ev.user?.id ?? null, ev.user?.login ?? null, ev.user?.name ?? null,
                        ev.amount ?? null, ev.currency ?? null, ev.message ?? null, json(meta), rawText(ev.raw), ev.test ? 1 : 0, ev.occurredAt instanceof Date ? ev.occurredAt : new Date(ev.occurredAt || Date.now())]);
                await named.record(Number(r.insertId), profileId, ev);   // never throws
                return Number(r.insertId);
            } catch (err) {
                if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) return null;
                throw err;
            }
        },
        async seenDedupe(profileId, key) {
            if (!key) return false;
            return (await q(`SELECT 1 FROM ${T('events')} WHERE profile_id = ? AND dedupe_key = ? LIMIT 1`, [profileId, key])).length > 0;
        },
        async listEvents(profileId, { q: text = '', type = '', platform = '', before = null, limit = 50, includeTest = true } = {}) {
            const where = ['profile_id = ?'];
            const params = [profileId];
            if (type) { where.push('type = ?'); params.push(String(type)); }
            if (platform) { where.push('platform = ?'); params.push(String(platform)); }
            if (before) { where.push('id < ?'); params.push(Number(before)); }
            if (!includeTest) where.push('is_test = 0');
            const t = String(text || '').trim().slice(0, 100);
            if (t) {
                const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
                where.push('(actor_login LIKE ? OR actor_name LIKE ? OR message LIKE ?)');
                params.push(like, like, like);
            }
            const n = Math.min(200, Math.max(1, Number(limit) || 50));
            return (await q(`SELECT * FROM ${T('events')} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${n}`, params)).map(eventRow);
        },
        async getEvent(profileId, id) {
            const r = (await q(`SELECT * FROM ${T('events')} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0];
            return r ? { ...eventRow(r), raw: parseJson(r.raw, r.raw) } : null;
        },
        async eventCountsSince(profileId, since) {
            return q(`SELECT type, COUNT(*) AS n, SUM(amount) AS total FROM ${T('events')} WHERE profile_id = ? AND created_at >= ? AND is_test = 0 GROUP BY type`, [profileId, since]);
        },

        // ── automations ──
        async listAutomations(profileId) {
            return (await q(`SELECT * FROM ${T('automations')} WHERE profile_id = ? ORDER BY name, id`, [profileId])).map(automationRow);
        },
        async countAutomations(profileId) {
            return Number((await q(`SELECT COUNT(*) AS n FROM ${T('automations')} WHERE profile_id = ?`, [profileId]))[0].n);
        },
        async getAutomation(profileId, id) {
            return automationRow((await q(`SELECT * FROM ${T('automations')} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0]);
        },
        async enabledAutomationsFor(profileId, type) {
            return (await q(`SELECT * FROM ${T('automations')} WHERE profile_id = ? AND trigger_type = ? AND enabled = 1 ORDER BY id`, [profileId, type])).map(automationRow);
        },
        async createAutomation(profileId, a) {
            const r = await q(`INSERT INTO ${T('automations')} (profile_id, name, enabled, trigger_type, trigger_config, conditions, actions) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [profileId, a.name, a.enabled === false ? 0 : 1, a.trigger_type, json(a.trigger_config || {}), json(a.conditions || []), json(a.actions || [])]);
            return Number(r.insertId);
        },
        async updateAutomation(profileId, id, a) {
            const r = await q(`UPDATE ${T('automations')} SET name = ?, enabled = ?, trigger_type = ?, trigger_config = ?, conditions = ?, actions = ? WHERE profile_id = ? AND id = ?`,
                [a.name, a.enabled === false ? 0 : 1, a.trigger_type, json(a.trigger_config || {}), json(a.conditions || []), json(a.actions || []), profileId, id]);
            return r.affectedRows > 0;
        },
        async setAutomationEnabled(profileId, id, enabled) {
            return (await q(`UPDATE ${T('automations')} SET enabled = ? WHERE profile_id = ? AND id = ?`, [enabled ? 1 : 0, profileId, id])).affectedRows > 0;
        },
        async deleteAutomation(profileId, id) {
            return (await q(`DELETE FROM ${T('automations')} WHERE profile_id = ? AND id = ?`, [profileId, id])).affectedRows > 0;
        },
        async touchAutomation(id) {
            await q(`UPDATE ${T('automations')} SET last_run_at = NOW(), updated_at = updated_at WHERE id = ?`, [id]);
        },

        // ── runs ──
        async createRun(profileId, r) {
            const res = await q(`INSERT INTO ${T('runs')} (profile_id, automation_id, automation_name, event_id, source, parent_run_id, depth, dry_run, status, skip_reason, input, checks, steps, started_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [profileId, r.automationId ?? null, r.automationName ? String(r.automationName).slice(0, 100) : null, r.eventId ?? null, r.source || 'event',
                    r.parentRunId ?? null, r.depth || 0, r.dryRun ? 1 : 0, r.status || 'running', r.skipReason ? String(r.skipReason).slice(0, 160) : null,
                    json(r.input ?? null), json(r.checks || []), json(r.steps || []), r.startedAt || new Date()]);
            return Number(res.insertId);
        },
        async finishRun(id, { status, steps, checks, error = null, skipReason = null }) {
            await q(`UPDATE ${T('runs')} SET status = ?, steps = ?, checks = COALESCE(?, checks), error = ?, skip_reason = COALESCE(?, skip_reason), finished_at = ? WHERE id = ?`,
                [status, json(steps || []), checks ? json(checks) : null, error ? String(error).slice(0, 500) : null, skipReason ? String(skipReason).slice(0, 160) : null, new Date(), id]);
        },
        async listRuns(profileId, { automationId = null, status = '', before = null, limit = 50 } = {}) {
            const where = ['profile_id = ?'];
            const params = [profileId];
            if (automationId) { where.push('automation_id = ?'); params.push(Number(automationId)); }
            if (status) { where.push('status = ?'); params.push(String(status)); }
            if (before) { where.push('id < ?'); params.push(Number(before)); }
            const n = Math.min(200, Math.max(1, Number(limit) || 50));
            return (await q(`SELECT * FROM ${T('runs')} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${n}`, params)).map(runRow);
        },
        async getRun(profileId, id) {
            return runRow((await q(`SELECT * FROM ${T('runs')} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0]);
        },
        /** Runs still 'running' from before a restart. */
        async failInterruptedRuns(olderThan = new Date()) {
            return (await q(`UPDATE ${T('runs')} SET status = 'failed', error = 'Interrupted by a restart', finished_at = NOW() WHERE status = 'running' AND started_at < ?`, [olderThan])).affectedRows;
        },

        // ── devices and pairing ──
        async createDevice(profileId, { kind, name, tokenHash, tokenHint, capabilities = [] }) {
            const r = await q(`INSERT INTO ${T('devices')} (profile_id, kind, name, token_hash, token_hint, capabilities) VALUES (?, ?, ?, ?, ?, ?)`,
                [profileId, kind, String(name).slice(0, 100), tokenHash, tokenHint, json(capabilities)]);
            return Number(r.insertId);
        },
        async deviceByTokenHash(hash) {
            return deviceRow((await q(`SELECT * FROM ${T('devices')} WHERE token_hash = ? AND revoked_at IS NULL`, [hash]))[0]);
        },
        async listDevices(profileId) {
            return (await q(`SELECT * FROM ${T('devices')} WHERE profile_id = ? ORDER BY revoked_at IS NOT NULL, id DESC`, [profileId])).map(deviceRow);
        },
        async getDevice(profileId, id) {
            return deviceRow((await q(`SELECT * FROM ${T('devices')} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0]);
        },
        /** Replace a device's capability list (the Devices page's per-dock-key switches). False when the device is not this profile's. */
        async setDeviceCapabilities(profileId, id, capabilities) {
            return (await q(`UPDATE ${T('devices')} SET capabilities = ? WHERE profile_id = ? AND id = ?`, [json(capabilities || []), profileId, id])).affectedRows > 0;
        },
        async revokeDevice(profileId, id) {
            return (await q(`UPDATE ${T('devices')} SET revoked_at = NOW() WHERE profile_id = ? AND id = ? AND revoked_at IS NULL`, [profileId, id])).affectedRows > 0;
        },
        async deleteDevice(profileId, id) {
            return (await q(`DELETE FROM ${T('devices')} WHERE profile_id = ? AND id = ?`, [profileId, id])).affectedRows > 0;
        },
        async touchDevice(id, { clientInfo, capabilities } = {}) {
            await q(`UPDATE ${T('devices')} SET last_seen_at = NOW(), client_info = COALESCE(?, client_info), capabilities = COALESCE(?, capabilities) WHERE id = ?`,
                [clientInfo ? String(clientInfo).slice(0, 120) : null, capabilities ? json(capabilities) : null, id]);
        },
        async createPairingCode(profileId, { codeHash, kind = 'studio', name = null, expiresAt }) {
            await q(`DELETE FROM ${T('pairing_codes')} WHERE profile_id = ? AND (used_at IS NOT NULL OR expires_at < NOW())`, [profileId]);
            await q(`INSERT INTO ${T('pairing_codes')} (code_hash, profile_id, kind, name, expires_at) VALUES (?, ?, ?, ?, ?)`,
                [codeHash, profileId, kind, name ? String(name).slice(0, 100) : null, expiresAt]);
        },
        /** Single use: marks the code used and returns it, or null (unknown, used or expired). */
        async consumePairingCode(codeHash, now = new Date()) {
            const r = await q(`UPDATE ${T('pairing_codes')} SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`, [now, codeHash, now]);
            if (!r.affectedRows) return null;
            const row = (await q(`SELECT profile_id, kind, name FROM ${T('pairing_codes')} WHERE code_hash = ?`, [codeHash]))[0];
            return row ? { profileId: Number(row.profile_id), kind: row.kind, name: row.name } : null;
        },

        // ── dispatch queue ──
        async insertDispatch(d) {
            await q(`INSERT INTO ${T('dispatch_queue')} (id, profile_id, run_id, target, capability, action_type, params, status, attempts, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
                [d.id, d.profileId, d.runId ?? null, d.target, d.capability ?? null, d.actionType, json(d.params || {}), d.status || 'queued', d.expiresAt]);
        },
        async updateDispatch(id, f) {
            const map = { status: 'status', attempts: 'attempts', deviceId: 'device_id', error: 'error', result: 'result', sentAt: 'sent_at', ackedAt: 'acked_at' };
            const sets = [], params = [];
            for (const [k, col] of Object.entries(map)) {
                if (f[k] === undefined) continue;
                sets.push(`${col} = ?`);
                params.push(k === 'result' ? json(f[k]) : k === 'error' && f[k] ? String(f[k]).slice(0, 255) : f[k]);
            }
            if (!sets.length) return;
            await q(`UPDATE ${T('dispatch_queue')} SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
        },
        async getDispatch(id) {
            return dispatchRow((await q(`SELECT * FROM ${T('dispatch_queue')} WHERE id = ?`, [id]))[0]);
        },
        async queuedDispatches(profileId, target, now = new Date()) {
            return (await q(`SELECT * FROM ${T('dispatch_queue')} WHERE profile_id = ? AND target = ? AND status = 'queued' AND expires_at > ? ORDER BY created_at, id LIMIT 200`,
                [profileId, target, now])).map(dispatchRow);
        },
        async expireDispatches(now = new Date()) {
            return (await q(`UPDATE ${T('dispatch_queue')} SET status = 'expired' WHERE status IN ('queued', 'sent') AND expires_at <= ?`, [now])).affectedRows;
        },
        async dispatchesForRun(profileId, runId) {
            return (await q(`SELECT * FROM ${T('dispatch_queue')} WHERE profile_id = ? AND run_id = ? ORDER BY created_at`, [profileId, runId])).map(dispatchRow);
        },

        // ── variables ({db:} / {sdb:}) ──
        variableStore: {
            async get(profileId, owner, key) {
                const rows = await q(`SELECT value_text FROM ${T('variables')} WHERE profile_id = ? AND owner = ? AND key_name = ?`, [profileId, owner, key]);
                return rows.length ? rows[0].value_text : null;
            },
            async set(profileId, owner, key, value, maxKeys = 1000) {
                const [row] = await q(`SELECT COUNT(*) AS n, COALESCE(SUM(key_name = ?), 0) AS has FROM ${T('variables')} WHERE profile_id = ? AND owner = ?`, [key, profileId, owner]);
                if (!Number(row.has) && Number(row.n) >= maxKeys) return { full: true };
                await q(`INSERT INTO ${T('variables')} (profile_id, owner, key_name, value_text) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), updated_at = CURRENT_TIMESTAMP`,
                    [profileId, owner, key, String(value)]);
                return { ok: true };
            },
            async incr(profileId, owner, key, by = 1, maxKeys = 1000) {
                const conn = await db.getConnection();
                try {
                    await conn.beginTransaction();
                    const [[cur]] = await conn.query(`SELECT value_text FROM ${T('variables')} WHERE profile_id = ? AND owner = ? AND key_name = ? FOR UPDATE`, [profileId, owner, key]);
                    if (!cur) {
                        const [[cnt]] = await conn.query(`SELECT COUNT(*) AS n FROM ${T('variables')} WHERE profile_id = ? AND owner = ?`, [profileId, owner]);
                        if (Number(cnt.n) >= maxKeys) { await conn.rollback(); return { full: true }; }
                    }
                    const value = clamp(storedNumber(cur?.value_text) + Number(by));
                    await conn.query(`INSERT INTO ${T('variables')} (profile_id, owner, key_name, value_text) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), updated_at = CURRENT_TIMESTAMP`,
                        [profileId, owner, key, String(value)]);
                    await conn.commit();
                    return { value };
                } catch (err) {
                    try { await conn.rollback(); } catch { /* already gone */ }
                    throw err;
                } finally {
                    conn.release();
                }
            },
            async del(profileId, owner, key) {
                const r = await q(`DELETE FROM ${T('variables')} WHERE profile_id = ? AND owner = ? AND key_name = ?`, [profileId, owner, key]);
                return { deleted: r.affectedRows > 0 };
            },
        },
        async listVariables(profileId, { owner = null, limit = 200 } = {}) {
            const n = Math.min(500, Math.max(1, Number(limit) || 200));
            return owner
                ? q(`SELECT owner, key_name, value_text, updated_at FROM ${T('variables')} WHERE profile_id = ? AND owner = ? ORDER BY key_name LIMIT ${n}`, [profileId, owner])
                : q(`SELECT owner, key_name, value_text, updated_at FROM ${T('variables')} WHERE profile_id = ? ORDER BY owner = 'server' DESC, owner, key_name LIMIT ${n}`, [profileId]);
        },

        // ── privacy ──
        /** Everything about a member's own profile, without secrets or hashes. */
        async exportOwner(ownerId, { rowLimit = 1000 } = {}) {
            const p = (await q(`SELECT * FROM ${T('profiles')} WHERE owner_discord_id = ?`, [String(ownerId)]))[0];
            if (!p) return null;
            const id = p.id;
            const n = Math.max(1, Number(rowLimit) || 1000);
            const profile = profileRow(p);
            if (profile.settings?.heart?.pulsoid?.secret) profile.settings.heart.pulsoid = { ...profile.settings.heart.pulsoid, secret: '(saved, not exported)' };   // the Pulsoid token
            return {
                profile,
                channels: await q(`SELECT platform, platform_user_id, login, display_name, verified_via, linked_at FROM ${T('channels')} WHERE profile_id = ?`, [id]),
                twitch_grant: (await q(`SELECT twitch_user_id, twitch_login, scopes, status, granted_at FROM ${T('twitch_grants')} WHERE profile_id = ?`, [id]))[0] || null,
                tip_sources: await q(`SELECT source, ref, enabled, status, last_event_at, created_at FROM ${T('tip_sources')} WHERE profile_id = ?`, [id]),
                automations: (await q(`SELECT * FROM ${T('automations')} WHERE profile_id = ?`, [id])).map(automationRow),
                devices: (await q(`SELECT * FROM ${T('devices')} WHERE profile_id = ?`, [id])).map(deviceRow),
                variables: await q(`SELECT owner, key_name, value_text, updated_at FROM ${T('variables')} WHERE profile_id = ? LIMIT ${n}`, [id]),
                runs: (await q(`SELECT * FROM ${T('runs')} WHERE profile_id = ? ORDER BY id DESC LIMIT ${n}`, [id])).map(runRow),
                events: (await q(`SELECT * FROM ${T('events')} WHERE profile_id = ? ORDER BY id DESC LIMIT ${n}`, [id])).map((r) => publicEvent(eventRow(r), Number(r.id))),
            };
        },
        /** Delete a member's profile (children go by ON DELETE CASCADE). Returns per-table counts. */
        async deleteOwner(ownerId) {
            const p = (await q(`SELECT id FROM ${T('profiles')} WHERE owner_discord_id = ?`, [String(ownerId)]))[0];
            if (!p) return {};
            const counts = {};
            for (const t of ['events', 'runs', 'dispatch_queue', 'variables', 'automations', 'devices', 'pairing_codes', 'tip_sources', 'twitch_grants', 'channels']) {
                const r = await q(`DELETE FROM ${T(t)} WHERE profile_id = ?`, [p.id]);
                if (r.affectedRows) counts[`${prefix}${t}`] = r.affectedRows;
            }
            const r = await q(`DELETE FROM ${T('profiles')} WHERE id = ?`, [p.id]);
            if (r.affectedRows) counts[`${prefix}profiles`] = r.affectedRows;
            return counts;
        },
        /** As a viewer: events about them and their per-viewer variables, in every profile. */
        async deleteViewer(accounts) {
            const counts = {};
            for (const { platform, id } of accounts || []) {
                if (!platform || !id) continue;
                const e = await q(`DELETE FROM ${T('events')} WHERE platform = ? AND actor_id = ?`, [platform, String(id)]);
                if (e.affectedRows) counts[`${prefix}events`] = (counts[`${prefix}events`] || 0) + e.affectedRows;
                const v = await q(`DELETE FROM ${T('variables')} WHERE owner = ?`, [`${platform}:${id}`]);
                if (v.affectedRows) counts[`${prefix}variables`] = (counts[`${prefix}variables`] || 0) + v.affectedRows;
            }
            return counts;
        },
        async exportViewer(accounts, { rowLimit = 1000 } = {}) {
            const out = { events: [], variables: [] };
            const n = Math.max(1, Number(rowLimit) || 1000);
            for (const { platform, id } of accounts || []) {
                if (!platform || !id) continue;
                out.events.push(...(await q(`SELECT * FROM ${T('events')} WHERE platform = ? AND actor_id = ? ORDER BY id DESC LIMIT ${n}`, [platform, String(id)])).map((r) => publicEvent(eventRow(r), Number(r.id))));
                out.variables.push(...await q(`SELECT profile_id, key_name, value_text, updated_at FROM ${T('variables')} WHERE owner = ? LIMIT ${n}`, [`${platform}:${id}`]));
            }
            return out;
        },
    };
    store.named = named;
    return store;
}

export default { createStore };
