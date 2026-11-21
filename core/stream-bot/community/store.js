/*
 * Stream bot community features: every read and write of the migration 475 tables (quotes, store items, store redemptions,
 * media requests). Every query carries profile_id, except the /privacy ones, which find a viewer's rows by platform account.
 *
 *   createCommunityStore({ db, prefix = 'stream_bot_', now })
 *
 * `available()` is false until migration 475 has run, so the live code answers "after the next CertiFried update" instead of
 * failing when CertiFried restarts before the migration.
 * Tested in tests/stream-bot-community.test.js (throwaway tables).
 */

const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
const at = (v) => { const d = v instanceof Date ? v : new Date(v || Date.now()); return Number.isFinite(d.getTime()) && d.getFullYear() > 2000 ? d : new Date(); };
export const MEDIA_ACTIVE = Object.freeze(['pending', 'queued', 'playing']);
export const MEDIA_STATUSES = Object.freeze(['pending', 'queued', 'playing', 'played', 'skipped', 'denied', 'removed', 'failed']);
export const STORE_LIMITS = Object.freeze({ items: 50, name: 60, description: 200 });
export const QUOTE_LIMITS = Object.freeze({ text: 500, perProfile: 5000 });

export function quoteRow(r) {
    if (!r) return null;
    return {
        id: Number(r.id), profileId: Number(r.profile_id), number: Number(r.number), text: r.text, game: r.game || null, saidBy: r.said_by || null,
        addedBy: r.added_by || null, addedByPlatform: r.added_by_platform || null, addedById: r.added_by_id || null, enabled: !!r.enabled,
        importedFrom: r.imported_from || null, sourceId: r.source_id || null, quotedAt: r.quoted_at, createdAt: r.created_at,
    };
}
export function itemRow(r) {
    if (!r) return null;
    return {
        id: Number(r.id), profileId: Number(r.profile_id), name: r.name, description: r.description || '', cost: Number(r.cost) || 0,
        stock: r.stock == null ? null : Number(r.stock), perUserLimit: r.per_user_limit == null ? null : Number(r.per_user_limit),
        limitWindow: r.limit_window === 'ever' ? 'ever' : 'day', cooldownSec: Number(r.cooldown_sec) || 0,
        automationId: r.automation_id == null ? null : Number(r.automation_id), enabled: !!r.enabled, sortOrder: Number(r.sort_order) || 0,
        lastRedeemedAt: r.last_redeemed_at || null,
    };
}
export function redemptionRow(r) {
    if (!r) return null;
    return {
        id: Number(r.id), itemId: r.item_id == null ? null : Number(r.item_id), itemName: r.item_name, platform: r.platform, platformUserId: r.platform_user_id,
        viewerId: r.viewer_id == null ? null : Number(r.viewer_id), viewerName: r.viewer_name, cost: Number(r.cost) || 0, status: r.status, note: r.note || null, createdAt: r.created_at,
    };
}
export function mediaRow(r) {
    if (!r) return null;
    return {
        id: Number(r.id), profileId: Number(r.profile_id), platform: r.platform, viewerId: r.viewer_id, viewerLogin: r.viewer_login, viewerName: r.viewer_name,
        videoId: r.video_id, url: r.url, title: r.title || '', channel: r.channel || '', durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
        thumbnail: r.thumbnail || null, status: r.status, musicRequestId: r.music_request_id == null ? null : Number(r.music_request_id),
        pointsPaid: Number(r.points_paid) || 0, decidedBy: r.decided_by || null, reason: r.reason || null, createdAt: r.created_at, decidedAt: r.decided_at, finishedAt: r.finished_at,
    };
}

export function createCommunityStore({ db, prefix = 'stream_bot_', now = () => Date.now() } = {}) {
    if (!db) throw new Error('createCommunityStore needs a db pool');
    if (!/^[a-z0-9_]{1,30}$/.test(prefix)) throw new Error('bad table prefix');
    const Q = `\`${prefix}quotes\``;
    const I = `\`${prefix}store_items\``;
    const R = `\`${prefix}store_redemptions\``;
    const M = `\`${prefix}media_requests\``;
    const q = async (sql, params = []) => (await db.query(sql, params))[0];
    let ready = null;

    const cs = {
        prefix,
        async available() {
            if (ready && (ready.ok || now() - ready.at < 60_000)) return ready.ok;
            try { for (const t of [Q, I, R, M]) await q(`SELECT 1 FROM ${t} LIMIT 0`); ready = { ok: true, at: now() }; } catch { ready = { ok: false, at: now() }; }
            return ready.ok;
        },

        // ── quotes ──
        /** Adds a quote with the next number (retried once if two adds race for the same number). */
        async addQuote(profileId, { text, game = null, saidBy = null, addedBy = null, addedByPlatform = null, addedById = null, enabled = true, importedFrom = null, sourceId = null, quotedAt = null }) {
            const count = Number((await q(`SELECT COUNT(*) AS n FROM ${Q} WHERE profile_id = ?`, [profileId]))[0].n);
            if (count >= QUOTE_LIMITS.perProfile) return { ok: false, error: 'full' };
            for (let attempt = 0; attempt < 3; attempt++) {
                const next = Number((await q(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM ${Q} WHERE profile_id = ?`, [profileId]))[0].n);
                try {
                    const r = await q(`INSERT INTO ${Q} (profile_id, number, text, game, said_by, added_by, added_by_platform, added_by_id, enabled, imported_from, source_id, quoted_at)
                                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [profileId, next, String(text).slice(0, QUOTE_LIMITS.text), str(game, 100), str(saidBy, 100), str(addedBy, 100), str(addedByPlatform, 8), str(addedById, 64),
                        enabled ? 1 : 0, str(importedFrom, 20), str(sourceId, 64), at(quotedAt || now())]);
                    return { ok: true, id: Number(r.insertId), number: next };
                } catch (err) {
                    if (err?.code !== 'ER_DUP_ENTRY') throw err;
                    if (importedFrom && sourceId && String(err.message).includes('uq_source')) return { ok: false, error: 'exists' };
                }
            }
            return { ok: false, error: 'busy' };
        },
        async quoteByNumber(profileId, number, { includeOff = false } = {}) {
            return quoteRow((await q(`SELECT * FROM ${Q} WHERE profile_id = ? AND number = ?${includeOff ? '' : ' AND enabled = 1'}`, [profileId, number]))[0]);
        },
        async getQuote(profileId, id) { return quoteRow((await q(`SELECT * FROM ${Q} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0]); },
        async randomQuote(profileId, { search = '' } = {}) {
            const params = [profileId];
            let where = 'profile_id = ? AND enabled = 1';
            const s = String(search || '').trim().slice(0, 100);
            if (s) { where += ' AND (text LIKE ? OR said_by LIKE ? OR game LIKE ?)'; const like = `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; params.push(like, like, like); }
            const n = Number((await q(`SELECT COUNT(*) AS n FROM ${Q} WHERE ${where}`, params))[0].n);
            if (!n) return null;
            const off = Math.floor(Math.random() * n);
            return quoteRow((await q(`SELECT * FROM ${Q} WHERE ${where} ORDER BY number LIMIT 1 OFFSET ${off}`, params))[0]);
        },
        async listQuotes(profileId, { search = '', limit = 500 } = {}) {
            const params = [profileId];
            let where = 'profile_id = ?';
            const s = String(search || '').trim().slice(0, 100);
            if (s) { where += ' AND (text LIKE ? OR said_by LIKE ? OR game LIKE ?)'; const like = `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; params.push(like, like, like); }
            return (await q(`SELECT * FROM ${Q} WHERE ${where} ORDER BY number DESC LIMIT ${Math.min(5000, Math.max(1, Number(limit) || 500))}`, params)).map(quoteRow);
        },
        async countQuotes(profileId) {
            const r = (await q(`SELECT COUNT(*) AS n, SUM(enabled = 0) AS off FROM ${Q} WHERE profile_id = ?`, [profileId]))[0];
            return { total: Number(r.n) || 0, off: Number(r.off) || 0 };
        },
        async updateQuote(profileId, id, { text, game, saidBy, enabled }) {
            const sets = []; const params = [];
            if (text !== undefined) { sets.push('text = ?'); params.push(String(text).slice(0, QUOTE_LIMITS.text)); }
            if (game !== undefined) { sets.push('game = ?'); params.push(str(game, 100)); }
            if (saidBy !== undefined) { sets.push('said_by = ?'); params.push(str(saidBy, 100)); }
            if (enabled !== undefined) { sets.push('enabled = ?'); params.push(enabled ? 1 : 0); }
            if (!sets.length) return false;
            return (await q(`UPDATE ${Q} SET ${sets.join(', ')} WHERE profile_id = ? AND id = ?`, [...params, profileId, id])).affectedRows > 0;
        },
        async enableImportedQuotes(profileId) {
            return (await q(`UPDATE ${Q} SET enabled = 1 WHERE profile_id = ? AND enabled = 0 AND imported_from IS NOT NULL`, [profileId])).affectedRows;
        },
        async deleteQuoteByNumber(profileId, number) {
            return (await q(`DELETE FROM ${Q} WHERE profile_id = ? AND number = ?`, [profileId, number])).affectedRows > 0;
        },
        async deleteQuote(profileId, id) {
            return (await q(`DELETE FROM ${Q} WHERE profile_id = ? AND id = ?`, [profileId, id])).affectedRows > 0;
        },
        /**
         * Quotes from Firebot or Streamer.bot: switched off, numbered after the existing ones, never twice (source id).
         * rows: [{ sourceId, text, author, game, createdAt }] → { created, existing, skipped }
         */
        async importQuotes(profileId, source, rows) {
            const out = { created: 0, existing: 0, skipped: 0 };
            const src = String(source || 'import').slice(0, 20);
            for (const r of rows || []) {
                const text = String(r?.text || '').replace(/\s+/g, ' ').trim();
                const sid = str(r?.sourceId, 64);
                if (!text || !sid) { out.skipped++; continue; }
                const have = (await q(`SELECT id FROM ${Q} WHERE profile_id = ? AND imported_from = ? AND source_id = ?`, [profileId, src, sid]))[0];
                if (have) { out.existing++; continue; }
                const r2 = await cs.addQuote(profileId, { text, game: r.game || null, saidBy: r.author || null, addedBy: `Imported from ${src}`, enabled: false, importedFrom: src, sourceId: sid, quotedAt: r.createdAt || null });
                if (r2.ok) out.created++; else if (r2.error === 'exists') out.existing++; else out.skipped++;
            }
            return out;
        },

        // ── store items ──
        async listItems(profileId, { enabledOnly = false } = {}) {
            return (await q(`SELECT * FROM ${I} WHERE profile_id = ?${enabledOnly ? ' AND enabled = 1' : ''} ORDER BY sort_order, cost, name`, [profileId])).map(itemRow);
        },
        async getItem(profileId, id) { return itemRow((await q(`SELECT * FROM ${I} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0]); },
        async itemByName(profileId, name) { return itemRow((await q(`SELECT * FROM ${I} WHERE profile_id = ? AND name = ?`, [profileId, String(name).slice(0, 60)]))[0]); },
        async saveItem(profileId, id, v) {
            const cols = [v.name, v.description || null, v.cost, v.stock, v.perUserLimit, v.limitWindow, v.cooldownSec, v.automationId, v.enabled ? 1 : 0, v.sortOrder || 0];
            try {
                if (id) {
                    const r = await q(`UPDATE ${I} SET name = ?, description = ?, cost = ?, stock = ?, per_user_limit = ?, limit_window = ?, cooldown_sec = ?, automation_id = ?, enabled = ?, sort_order = ?
                                       WHERE profile_id = ? AND id = ?`, [...cols, profileId, id]);
                    return r.affectedRows ? { ok: true, id: Number(id) } : { ok: false, error: 'not_found' };
                }
                const n = Number((await q(`SELECT COUNT(*) AS n FROM ${I} WHERE profile_id = ?`, [profileId]))[0].n);
                if (n >= STORE_LIMITS.items) return { ok: false, error: 'full' };
                const r = await q(`INSERT INTO ${I} (name, description, cost, stock, per_user_limit, limit_window, cooldown_sec, automation_id, enabled, sort_order, profile_id)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...cols, profileId]);
                return { ok: true, id: Number(r.insertId) };
            } catch (err) {
                if (err?.code === 'ER_DUP_ENTRY') return { ok: false, error: 'name_taken' };
                throw err;
            }
        },
        async deleteItem(profileId, id) { return (await q(`DELETE FROM ${I} WHERE profile_id = ? AND id = ?`, [profileId, id])).affectedRows > 0; },
        /** Take one from the stock (conditional, so two redeems cannot both take the last one). Unlimited stock always succeeds. */
        async takeStock(profileId, id) {
            const r = await q(`UPDATE ${I} SET stock = CASE WHEN stock IS NULL THEN NULL ELSE stock - 1 END, last_redeemed_at = ?
                               WHERE profile_id = ? AND id = ? AND enabled = 1 AND (stock IS NULL OR stock > 0)`, [new Date(now()), profileId, id]);
            return r.affectedRows > 0;
        },
        async returnStock(profileId, id) {
            await q(`UPDATE ${I} SET stock = stock + 1 WHERE profile_id = ? AND id = ? AND stock IS NOT NULL`, [profileId, id]);
        },
        async addRedemption(profileId, r) {
            const res = await q(`INSERT INTO ${R} (profile_id, item_id, item_name, platform, platform_user_id, viewer_id, viewer_name, cost, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [profileId, r.itemId ?? null, String(r.itemName).slice(0, 60), String(r.platform).slice(0, 8), str(r.platformUserId, 64), r.viewerId ?? null, str(r.viewerName, 100),
                    Math.max(0, Math.round(Number(r.cost) || 0)), r.status || 'done', str(r.note, 200)]);
            return Number(res.insertId);
        },
        /** Redemptions of one item by one viewer account that were not refunded, since `since` (null: ever). */
        async countRedemptions(profileId, itemId, platform, platformUserId, since = null) {
            const params = [profileId, itemId, platform, String(platformUserId)];
            if (since) params.push(since);
            return Number((await q(`SELECT COUNT(*) AS n FROM ${R} WHERE profile_id = ? AND item_id = ? AND platform = ? AND platform_user_id = ? AND status = 'done'${since ? ' AND created_at >= ?' : ''}`, params))[0].n);
        },
        async listRedemptions(profileId, limit = 50) {
            return (await q(`SELECT * FROM ${R} WHERE profile_id = ? ORDER BY id DESC LIMIT ${Math.min(500, Math.max(1, Number(limit) || 50))}`, [profileId])).map(redemptionRow);
        },
        async getRedemption(profileId, id) { return redemptionRow((await q(`SELECT * FROM ${R} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0]); },
        /** Mark refunded (only once): true when this call changed it. */
        async markRefunded(profileId, id, note = null) {
            return (await q(`UPDATE ${R} SET status = 'refunded', note = COALESCE(?, note) WHERE profile_id = ? AND id = ? AND status = 'done'`, [str(note, 200), profileId, id])).affectedRows > 0;
        },

        // ── media requests ──
        async addMedia(profileId, m) {
            const r = await q(`INSERT INTO ${M} (profile_id, platform, viewer_id, viewer_login, viewer_name, video_id, url, title, channel, duration_ms, thumbnail, status, points_paid)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [profileId, String(m.platform || 'dashboard').slice(0, 10), str(m.viewerId, 64), str(m.viewerLogin, 100), str(m.viewerName, 100), String(m.videoId).slice(0, 16),
                String(m.url).slice(0, 300), str(m.title, 300), str(m.channel, 200), m.durationMs == null ? null : Math.max(0, Math.round(m.durationMs)), str(m.thumbnail, 500),
                MEDIA_STATUSES.includes(m.status) ? m.status : 'pending', Math.max(0, Math.round(Number(m.pointsPaid) || 0))]);
            return Number(r.insertId);
        },
        async getMedia(profileId, id) { return mediaRow((await q(`SELECT * FROM ${M} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0]); },
        async mediaByMusicRequest(profileId, musicRequestId) {
            return mediaRow((await q(`SELECT * FROM ${M} WHERE profile_id = ? AND music_request_id = ? ORDER BY id DESC LIMIT 1`, [profileId, musicRequestId]))[0]);
        },
        async activeMedia(profileId) {
            return (await q(`SELECT * FROM ${M} WHERE profile_id = ? AND status IN ('pending', 'queued', 'playing') ORDER BY id`, [profileId])).map(mediaRow);
        },
        /** Profiles with media handed to the song queue and not finished yet (the status sweep). */
        async profilesWithQueuedMedia() {
            return (await q(`SELECT DISTINCT profile_id FROM ${M} WHERE status IN ('queued', 'playing') AND music_request_id IS NOT NULL`)).map((r) => Number(r.profile_id));
        },
        async setMediaStatus(profileId, id, status, { decidedBy, reason, musicRequestId, finished = false, decided = false } = {}) {
            if (!MEDIA_STATUSES.includes(status)) throw new Error('bad media status');
            const sets = ['status = ?']; const params = [status];
            if (decidedBy !== undefined) { sets.push('decided_by = ?'); params.push(str(decidedBy, 100)); }
            if (reason !== undefined) { sets.push('reason = ?'); params.push(str(reason, 200)); }
            if (musicRequestId !== undefined) { sets.push('music_request_id = ?'); params.push(musicRequestId); }
            if (decided) { sets.push('decided_at = ?'); params.push(new Date(now())); }
            if (finished) { sets.push('finished_at = ?'); params.push(new Date(now())); }
            return (await q(`UPDATE ${M} SET ${sets.join(', ')} WHERE profile_id = ? AND id = ?`, [...params, profileId, id])).affectedRows > 0;
        },
        async mediaHistory(profileId, limit = 50) {
            return (await q(`SELECT * FROM ${M} WHERE profile_id = ? ORDER BY id DESC LIMIT ${Math.min(500, Math.max(1, Number(limit) || 50))}`, [profileId])).map(mediaRow);
        },

        // ── privacy ──
        async exportProfile(profileId, { limit = 5000 } = {}) {
            const n = Math.min(50_000, Math.max(1, Number(limit) || 5000));
            return {
                quotes: (await q(`SELECT * FROM ${Q} WHERE profile_id = ? ORDER BY number LIMIT ${n}`, [profileId])).map(quoteRow),
                store_items: (await q(`SELECT * FROM ${I} WHERE profile_id = ? ORDER BY id`, [profileId])).map(itemRow),
                store_redemptions: (await q(`SELECT * FROM ${R} WHERE profile_id = ? ORDER BY id DESC LIMIT ${n}`, [profileId])).map(redemptionRow),
                media_requests: (await q(`SELECT * FROM ${M} WHERE profile_id = ? ORDER BY id DESC LIMIT ${n}`, [profileId])).map(mediaRow),
            };
        },
        async deleteProfile(profileId) {
            const out = {};
            for (const [k, t] of [['store_redemptions', R], ['media_requests', M], ['quotes', Q], ['store_items', I]]) out[k] = (await q(`DELETE FROM ${t} WHERE profile_id = ?`, [profileId])).affectedRows || 0;
            return out;
        },
        /** A viewer's own rows in every streamer's profile: their redemptions, their media requests, quotes they added. */
        async exportAccounts(accounts, { limit = 1000 } = {}) {
            const out = { store_redemptions: [], media_requests: [], quotes: [] };
            const n = Math.min(10_000, Math.max(1, Number(limit) || 1000));
            for (const { platform, id } of accounts || []) {
                if (!platform || !id) continue;
                out.store_redemptions.push(...(await q(`SELECT * FROM ${R} WHERE platform = ? AND platform_user_id = ? ORDER BY id DESC LIMIT ${n}`, [platform, String(id)])).map(redemptionRow));
                out.media_requests.push(...(await q(`SELECT * FROM ${M} WHERE platform = ? AND viewer_id = ? ORDER BY id DESC LIMIT ${n}`, [platform, String(id)])).map(mediaRow));
                out.quotes.push(...(await q(`SELECT * FROM ${Q} WHERE added_by_platform = ? AND added_by_id = ? ORDER BY id DESC LIMIT ${n}`, [platform, String(id)])).map(quoteRow));
            }
            return out;
        },
        /**
         * Their redemptions and media requests are deleted; quotes they added stay with the streamer (a quote is what someone
         * said on stream) but lose who added them.
         */
        async deleteAccounts(accounts) {
            const out = { store_redemptions: 0, media_requests: 0, quotes: 0 };
            for (const { platform, id } of accounts || []) {
                if (!platform || !id) continue;
                out.store_redemptions += (await q(`DELETE FROM ${R} WHERE platform = ? AND platform_user_id = ?`, [platform, String(id)])).affectedRows || 0;
                out.media_requests += (await q(`DELETE FROM ${M} WHERE platform = ? AND viewer_id = ?`, [platform, String(id)])).affectedRows || 0;
                out.quotes += (await q(`UPDATE ${Q} SET added_by = NULL, added_by_platform = NULL, added_by_id = NULL WHERE added_by_platform = ? AND added_by_id = ?`, [platform, String(id)])).affectedRows || 0;
            }
            return out;
        },
    };
    return cs;
}

export default { createCommunityStore, quoteRow, itemRow, redemptionRow, mediaRow, MEDIA_ACTIVE, MEDIA_STATUSES, STORE_LIMITS, QUOTE_LIMITS };
