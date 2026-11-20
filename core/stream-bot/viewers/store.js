/*
 * Stream bot viewers: every read and write of stream_bot_viewers and stream_bot_viewer_history (migration 464).
 *
 *   createViewerStore({ db, prefix = 'stream_bot_' })
 *
 * One row per viewer per profile and platform. A person's Twitch and Kick rows can be linked by the streamer
 * (person_id on the second row points at the first, the primary); the primary holds the points, watch time and
 * messages stay on each row and are added up where a person is shown. Every query carries profile_id, except the
 * /privacy ones, which find a viewer's rows in every profile by platform account.
 *
 * `available()` is false until migration 464 has run, so the live code does nothing instead of failing when CertiFried
 * restarts before the migration.
 * Tested in tests/stream-bot-viewers.test.js (throwaway tables).
 */

const NUM_MAX = 999_999_999_999;
const CHUNK = 400;
const SORTS = Object.freeze({
    points: 'shown_points', watch: 'v.watch_minutes', messages: 'v.messages', last_seen: 'v.last_seen_at', first_seen: 'v.first_seen_at',
    name: 'COALESCE(v.display_name, v.login, v.platform_user_id)',
});
export const VIEWER_SORTS = Object.freeze(Object.keys(SORTS));
const STAT_COLUMNS = Object.freeze({ follows: 'follows', subs: 'subs', gifts: 'gifts', giftedSubs: 'gifted_subs', cheers: 'cheers', bits: 'bits', raids: 'raids', raidViewers: 'raid_viewers', tips: 'tips' });

const parseJson = (v, d) => { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };
const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
const at = (v) => (v instanceof Date ? v : new Date(v || Date.now()));
const rolesText = (r) => (Array.isArray(r) ? (r.filter((x) => /^[a-z]{1,20}$/.test(x)).join(',').slice(0, 80) || '') : null);

export function viewerRow(r) {
    if (!r) return null;
    return {
        id: Number(r.id), profileId: Number(r.profile_id), platform: r.platform, platformUserId: r.platform_user_id,
        login: r.login, name: r.display_name || r.login || r.platform_user_id, displayName: r.display_name || null,
        roles: String(r.roles || '').split(',').filter(Boolean), personId: r.person_id == null ? null : Number(r.person_id),
        firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
        watchMinutes: Number(r.watch_minutes) || 0, messages: Number(r.messages) || 0,
        points: Number(r.points) || 0, shownPoints: r.shown_points == null ? Number(r.points) || 0 : Number(r.shown_points),
        follows: Number(r.follows) || 0, followedAt: r.followed_at || null, subs: Number(r.subs) || 0, subMonths: Number(r.sub_months) || 0,
        gifts: Number(r.gifts) || 0, giftedSubs: Number(r.gifted_subs) || 0, cheers: Number(r.cheers) || 0, bits: Number(r.bits) || 0,
        raids: Number(r.raids) || 0, raidViewers: Number(r.raid_viewers) || 0, tips: Number(r.tips) || 0, tipAmounts: parseJson(r.tip_amounts, {}) || {},
        rankName: r.rank_name || null, importedFrom: r.imported_from || null,
        importedMinutes: Number(r.imported_minutes) || 0, importedMessages: Number(r.imported_messages) || 0, importedPoints: Number(r.imported_points) || 0,
    };
}

export function createViewerStore({ db, prefix = 'stream_bot_', now = () => Date.now() } = {}) {
    if (!db) throw new Error('createViewerStore needs a db pool');
    if (!/^[a-z0-9_]{1,30}$/.test(prefix)) throw new Error('bad table prefix');
    const V = `\`${prefix}viewers\``;
    const H = `\`${prefix}viewer_history\``;
    const q = async (sql, params = []) => (await db.query(sql, params))[0];
    let ready = null;   // { ok, at }

    async function inTransaction(fn) {
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const out = await fn(async (sql, params = []) => (await conn.query(sql, params))[0]);
            await conn.commit();
            return out;
        } catch (err) {
            try { await conn.rollback(); } catch { /* gone */ }
            throw err;
        } finally {
            conn.release();
        }
    }

    const vs = {
        prefix,
        /** True once migration 464 has created the tables (checked again every minute while false). */
        async available() {
            if (ready && (ready.ok || now() - ready.at < 60_000)) return ready.ok;
            try { await q(`SELECT 1 FROM ${V} LIMIT 0`); await q(`SELECT 1 FROM ${H} LIMIT 0`); ready = { ok: true, at: now() }; } catch { ready = { ok: false, at: now() }; }
            return ready.ok;
        },

        // ── seen: chat, presence, events ──
        /**
         * Viewers seen together (a presence sample or one chat line). Creates missing rows, keeps names current, adds the
         * minutes and messages, moves last_seen_at. Returns [{ row (after), beforeMinutes, created }].
         */
        async seen(profileId, platform, users, { when = now(), minutes = 0, messages = 0 } = {}) {
            const out = [];
            const list = [];
            const ids = new Set();
            for (const u of users || []) {
                const id = str(u?.id, 64);
                if (!id || ids.has(id)) continue;
                ids.add(id);
                list.push({ id, login: str(u.login && String(u.login).toLowerCase(), 100), name: str(u.name, 100), roles: u.roles ? rolesText(u.roles) : null });
            }
            const t = at(when);
            for (let i = 0; i < list.length; i += CHUNK) {
                const chunk = list.slice(i, i + CHUNK);
                const marks = chunk.map(() => '?').join(', ');
                const before = new Map((await q(`SELECT platform_user_id, watch_minutes FROM ${V} WHERE profile_id = ? AND platform = ? AND platform_user_id IN (${marks})`,
                    [profileId, platform, ...chunk.map((u) => u.id)])).map((r) => [r.platform_user_id, Number(r.watch_minutes) || 0]));
                const values = [];
                const params = [];
                for (const u of chunk) {
                    values.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
                    params.push(profileId, platform, u.id, u.login, u.name, u.roles, t, t, Math.max(0, Math.round(minutes)), Math.max(0, Math.round(messages)));
                }
                await q(`INSERT INTO ${V} (profile_id, platform, platform_user_id, login, display_name, roles, first_seen_at, last_seen_at, watch_minutes, messages)
                         VALUES ${values.join(', ')}
                         ON DUPLICATE KEY UPDATE login = COALESCE(VALUES(login), login), display_name = COALESCE(VALUES(display_name), display_name),
                           roles = COALESCE(VALUES(roles), roles), last_seen_at = GREATEST(last_seen_at, VALUES(last_seen_at)),
                           watch_minutes = LEAST(watch_minutes + VALUES(watch_minutes), 4000000000), messages = LEAST(messages + VALUES(messages), 4000000000)`, params);
                const after = await q(`SELECT * FROM ${V} WHERE profile_id = ? AND platform = ? AND platform_user_id IN (${marks})`, [profileId, platform, ...chunk.map((u) => u.id)]);
                for (const r of after) {
                    const row = viewerRow(r);
                    out.push({ row, beforeMinutes: before.get(r.platform_user_id) ?? 0, created: !before.has(r.platform_user_id) });
                }
            }
            // A linked person was seen: keep the primary row alive too (retention counts from last_seen_at).
            const primaries = [...new Set(out.map((o) => o.row.personId).filter(Boolean))];
            if (primaries.length) await q(`UPDATE ${V} SET last_seen_at = GREATEST(last_seen_at, ?) WHERE profile_id = ? AND id IN (${primaries.map(() => '?').join(', ')})`, [t, profileId, ...primaries]);
            return out;
        },

        /** Add to the follow / sub / gift / Bits / raid / tip tallies of one viewer (created when new). Returns the row. */
        async addStats(profileId, platform, user, inc = {}, { when = now(), subMonths = null, followedAt = null } = {}) {
            const [s] = await vs.seen(profileId, platform, [user], { when });
            if (!s) return null;
            const sets = [];
            const params = [];
            for (const [k, col] of Object.entries(STAT_COLUMNS)) {
                const n = Math.round(Number(inc[k]) || 0);
                if (n > 0) { sets.push(`${col} = LEAST(${col} + ?, ${k === 'bits' ? NUM_MAX : 4000000000})`); params.push(n); }
            }
            if (subMonths != null && Number.isFinite(Number(subMonths))) { sets.push('sub_months = GREATEST(sub_months, ?)'); params.push(Math.min(10000, Math.max(0, Math.round(Number(subMonths))))); }
            if (followedAt) { sets.push('followed_at = COALESCE(followed_at, ?)'); params.push(at(followedAt)); }
            if (sets.length) await q(`UPDATE ${V} SET ${sets.join(', ')} WHERE id = ? AND profile_id = ?`, [...params, s.row.id, profileId]);
            return vs.get(profileId, s.row.id);
        },
        /** A tip matched to a viewer by name: count it and add the amount under its currency. */
        async addTip(profileId, viewerId, currency, amount) {
            const r = (await q(`SELECT tip_amounts FROM ${V} WHERE profile_id = ? AND id = ?`, [profileId, viewerId]))[0];
            if (!r) return false;
            const totals = parseJson(r.tip_amounts, {}) || {};
            const c = /^[A-Z]{3}$/.test(String(currency || '')) ? currency : 'other';
            const n = Number(amount);
            if (Number.isFinite(n) && n > 0) totals[c] = Math.round(((Number(totals[c]) || 0) + n) * 100) / 100;
            const text = JSON.stringify(totals);
            await q(`UPDATE ${V} SET tips = tips + 1, tip_amounts = ? WHERE profile_id = ? AND id = ?`, [text.length <= 400 ? text : r.tip_amounts, profileId, viewerId]);
            return true;
        },

        // ── points ──
        /**
         * Change one person's points (the primary row of a linked person). mode 'add' (delta may be negative) or 'set'.
         * strict: refuse a change that would go below 0 ({ ok: false, error: 'not_enough' }); otherwise stop at 0.
         */
        async changePoints(profileId, viewerId, amount, { mode = 'add', strict = false, kind = 'points', note = null, actor = null, history = true } = {}) {
            return inTransaction(async (tq) => {
                const row = (await tq(`SELECT id, person_id FROM ${V} WHERE profile_id = ? AND id = ?`, [profileId, viewerId]))[0];
                if (!row) return { ok: false, error: 'no_viewer' };
                const target = Number(row.person_id || row.id);
                const cur = Number((await tq(`SELECT points FROM ${V} WHERE id = ? FOR UPDATE`, [target]))[0]?.points) || 0;
                let next = mode === 'set' ? Math.round(Number(amount)) : cur + Math.round(Number(amount));
                if (!Number.isFinite(next)) return { ok: false, error: 'bad_amount' };
                if (next < 0) { if (strict) return { ok: false, error: 'not_enough', balance: cur }; next = 0; }
                next = Math.min(NUM_MAX, next);
                if (next !== cur) await tq(`UPDATE ${V} SET points = ? WHERE id = ?`, [next, target]);
                if (history && next !== cur) {
                    await tq(`INSERT INTO ${H} (profile_id, viewer_id, kind, delta, balance, note, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [profileId, target, kind, next - cur, next, str(note, 200), str(actor, 100)]);
                }
                return { ok: true, targetId: target, before: cur, balance: next, change: next - cur };
            });
        },
        /** Move points between two people (strict: the giver must have them). */
        async transfer(profileId, fromId, toId, amount, { note = null, actor = null } = {}) {
            const n = Math.round(Number(amount));
            if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'bad_amount' };
            return inTransaction(async (tq) => {
                const rows = await tq(`SELECT id, person_id FROM ${V} WHERE profile_id = ? AND id IN (?, ?)`, [profileId, fromId, toId]);
                const find = (id) => rows.find((r) => Number(r.id) === Number(id));
                if (!find(fromId) || !find(toId)) return { ok: false, error: 'no_viewer' };
                const a = Number(find(fromId).person_id || fromId);
                const b = Number(find(toId).person_id || toId);
                if (a === b) return { ok: false, error: 'same' };
                const locked = await tq(`SELECT id, points FROM ${V} WHERE id IN (?, ?) ORDER BY id FOR UPDATE`, [a, b]);
                const pa = Number(locked.find((r) => Number(r.id) === a)?.points) || 0;
                const pb = Number(locked.find((r) => Number(r.id) === b)?.points) || 0;
                if (pa < n) return { ok: false, error: 'not_enough', balance: pa };
                const nb = Math.min(NUM_MAX, pb + n);
                await tq(`UPDATE ${V} SET points = ? WHERE id = ?`, [pa - n, a]);
                await tq(`UPDATE ${V} SET points = ? WHERE id = ?`, [nb, b]);
                await tq(`INSERT INTO ${H} (profile_id, viewer_id, kind, delta, balance, note, actor) VALUES (?, ?, 'give', ?, ?, ?, ?), (?, ?, 'give', ?, ?, ?, ?)`,
                    [profileId, a, -n, pa - n, str(note, 200), str(actor, 100), profileId, b, nb - pb, nb, str(note, 200), str(actor, 100)]);
                return { ok: true, from: a, to: b, fromBalance: pa - n, toBalance: nb };
            });
        },
        /** Watch-time earnings for many people at once (no history rows: they would be one per viewer every few minutes). */
        async addPointsBulk(profileId, awards) {
            const list = [...awards.entries()].filter(([, n]) => n > 0);
            for (let i = 0; i < list.length; i += CHUNK) {
                const chunk = list.slice(i, i + CHUNK);
                await q(`UPDATE ${V} SET points = LEAST(points + CASE id ${chunk.map(() => 'WHEN ? THEN ?').join(' ')} ELSE 0 END, ${NUM_MAX})
                         WHERE profile_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
                [...chunk.flatMap(([id, n]) => [id, n]), profileId, ...chunk.map(([id]) => id)]);
            }
            return list.length;
        },
        async setRank(profileId, id, name) {
            await q(`UPDATE ${V} SET rank_name = ? WHERE profile_id = ? AND id = ?`, [str(name, 60), profileId, id]);
        },
        async addHistory(profileId, viewerId, { kind, delta = null, balance = null, note = null, actor = null }) {
            await q(`INSERT INTO ${H} (profile_id, viewer_id, kind, delta, balance, note, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [profileId, viewerId, String(kind).slice(0, 16), delta, balance, str(note, 200), str(actor, 100)]);
        },

        // ── reads ──
        async get(profileId, id) {
            return viewerRow((await q(`SELECT * FROM ${V} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0]);
        },
        async byAccount(profileId, platform, platformUserId) {
            return viewerRow((await q(`SELECT * FROM ${V} WHERE profile_id = ? AND platform = ? AND platform_user_id = ?`, [profileId, platform, String(platformUserId)]))[0]);
        },
        /** By login (lower case, a leading @ ignored), on one platform or any; the most recently seen first. */
        async byLogin(profileId, login, platform = null) {
            const l = String(login || '').trim().replace(/^@/, '').toLowerCase().slice(0, 100);
            if (!l) return null;
            const r = await q(`SELECT * FROM ${V} WHERE profile_id = ? AND login = ?${platform ? ' AND platform = ?' : ''} ORDER BY last_seen_at DESC LIMIT 1`,
                platform ? [profileId, l, platform] : [profileId, l]);
            return viewerRow(r[0]);
        },
        /** The person a row belongs to: the primary row and its linked rows, with totals added up. */
        async person(profileId, id) {
            const row = await vs.get(profileId, id);
            if (!row) return null;
            const primaryId = row.personId || row.id;
            const rows = (await q(`SELECT * FROM ${V} WHERE profile_id = ? AND (id = ? OR person_id = ?) ORDER BY person_id IS NOT NULL, id`, [profileId, primaryId, primaryId])).map(viewerRow);
            const primary = rows.find((r) => r.id === primaryId) || row;
            const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
            const tipAmounts = {};
            for (const r of rows) for (const [c, n] of Object.entries(r.tipAmounts || {})) tipAmounts[c] = Math.round(((tipAmounts[c] || 0) + Number(n)) * 100) / 100;
            return {
                primary, rows, points: primary.points,
                totals: {
                    watchMinutes: sum('watchMinutes'), messages: sum('messages'), follows: sum('follows'), subs: sum('subs'), gifts: sum('gifts'),
                    giftedSubs: sum('giftedSubs'), cheers: sum('cheers'), bits: sum('bits'), raids: sum('raids'), raidViewers: sum('raidViewers'), tips: sum('tips'), tipAmounts,
                    subMonths: Math.max(0, ...rows.map((r) => r.subMonths)),
                    firstSeenAt: rows.map((r) => r.firstSeenAt).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] || null,
                    lastSeenAt: rows.map((r) => r.lastSeenAt).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null,
                },
            };
        },
        /**
         * The Viewers table. q: name or login contains; platform; seenDays: seen in the last N days; sort (VIEWER_SORTS), dir.
         * Linked rows show their person's points.
         */
        async list(profileId, { q: text = '', platform = '', seenDays = 0, sort = 'points', dir = 'desc', page = 1, perPage = 50 } = {}) {
            const where = ['v.profile_id = ?'];
            const params = [profileId];
            if (platform === 'twitch' || platform === 'kick' || platform === 'youtube') { where.push('v.platform = ?'); params.push(platform); }
            const t = String(text || '').trim().replace(/^@/, '').slice(0, 100);
            if (t) {
                const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
                where.push('(v.login LIKE ? OR v.display_name LIKE ?)');
                params.push(like, like);
            }
            const days = Math.round(Number(seenDays) || 0);
            if (days > 0) { where.push('v.last_seen_at >= ?'); params.push(new Date(now() - Math.min(days, 3650) * 86_400_000)); }
            const col = SORTS[sort] || SORTS.points;
            const order = dir === 'asc' ? 'ASC' : 'DESC';
            const per = Math.min(200, Math.max(1, Math.round(Number(perPage) || 50)));
            const pg = Math.max(1, Math.round(Number(page) || 1));
            const total = Number((await q(`SELECT COUNT(*) AS n FROM ${V} v WHERE ${where.join(' AND ')}`, params))[0].n);
            const rows = await q(`SELECT v.*, COALESCE(p.points, v.points) AS shown_points FROM ${V} v LEFT JOIN ${V} p ON p.id = v.person_id
                                  WHERE ${where.join(' AND ')} ORDER BY ${col} ${order}, v.id ${order} LIMIT ${per} OFFSET ${(pg - 1) * per}`, params);
            return { total, page: pg, perPage: per, rows: rows.map(viewerRow) };
        },
        /** Leaderboard by person: by 'points' | 'watch' | 'messages'. exclude: logins never listed (the bots). */
        async top(profileId, { by = 'points', limit = 5, exclude = [] } = {}) {
            const n = Math.min(50, Math.max(1, Math.round(Number(limit) || 5)));
            const ex = (exclude || []).map((s) => String(s).toLowerCase()).filter(Boolean).slice(0, 200);
            const exSql = ex.length ? ` AND (v.login IS NULL OR v.login NOT IN (${ex.map(() => '?').join(', ')}))` : '';
            const metric = by === 'watch' ? 'SUM(v.watch_minutes)' : by === 'messages' ? 'SUM(v.messages)' : 'SUM(CASE WHEN v.person_id IS NULL THEN v.points ELSE 0 END)';
            const rows = await q(`SELECT COALESCE(v.person_id, v.id) AS pid, ${metric} AS value FROM ${V} v WHERE v.profile_id = ?${exSql}
                                  GROUP BY pid HAVING value > 0 ORDER BY value DESC, pid ASC LIMIT ${n}`, [profileId, ...ex]);
            if (!rows.length) return [];
            const names = new Map((await q(`SELECT id, platform, login, display_name, platform_user_id FROM ${V} WHERE profile_id = ? AND id IN (${rows.map(() => '?').join(', ')})`,
                [profileId, ...rows.map((r) => r.pid)])).map((r) => [Number(r.id), r]));
            return rows.map((r, i) => {
                const p = names.get(Number(r.pid)) || {};
                return { place: i + 1, id: Number(r.pid), platform: p.platform || null, name: p.display_name || p.login || p.platform_user_id || '?', value: Number(r.value) || 0 };
            });
        },
        /** platform user id → last_seen_at, for the ids that have a record. */
        async lastSeenFor(profileId, platform, ids) {
            const out = new Map();
            const list = [...new Set((ids || []).map(String))];
            for (let i = 0; i < list.length; i += CHUNK) {
                const chunk = list.slice(i, i + CHUNK);
                for (const r of await q(`SELECT platform_user_id, last_seen_at FROM ${V} WHERE profile_id = ? AND platform = ? AND platform_user_id IN (${chunk.map(() => '?').join(', ')})`, [profileId, platform, ...chunk])) out.set(r.platform_user_id, r.last_seen_at);
            }
            return out;
        },
        /** Totals per person id (the primary row's id): watch minutes and messages of all their rows, the primary's points and rank. */
        async personTotals(profileId, personIds) {
            const ids = [...new Set((personIds || []).map(Number).filter((x) => x > 0))];
            const out = new Map();
            for (let i = 0; i < ids.length; i += CHUNK) {
                const chunk = ids.slice(i, i + CHUNK);
                const marks = chunk.map(() => '?').join(', ');
                const rows = await q(`SELECT COALESCE(person_id, id) AS pid, SUM(watch_minutes) AS watch, SUM(messages) AS msgs,
                                             MAX(CASE WHEN person_id IS NULL THEN points END) AS points, MAX(CASE WHEN person_id IS NULL THEN rank_name END) AS rank_name
                                      FROM ${V} WHERE profile_id = ? AND (id IN (${marks}) OR person_id IN (${marks})) GROUP BY pid`, [profileId, ...chunk, ...chunk]);
                for (const r of rows) out.set(Number(r.pid), { watch: Number(r.watch) || 0, messages: Number(r.msgs) || 0, points: Number(r.points) || 0, rankName: r.rank_name || null });
            }
            return out;
        },
        /** A person's place by points (1 = most). */
        async placeOf(profileId, points, exclude = []) {
            const ex = (exclude || []).map((s) => String(s).toLowerCase()).filter(Boolean).slice(0, 200);
            const exSql = ex.length ? ` AND (login IS NULL OR login NOT IN (${ex.map(() => '?').join(', ')}))` : '';
            return 1 + Number((await q(`SELECT COUNT(*) AS n FROM ${V} WHERE profile_id = ? AND person_id IS NULL AND points > ?${exSql}`, [profileId, Number(points) || 0, ...ex]))[0].n);
        },
        async history(profileId, viewerIds, limit = 100) {
            const ids = (viewerIds || []).map(Number).filter((x) => x > 0);
            if (!ids.length) return [];
            const n = Math.min(500, Math.max(1, Number(limit) || 100));
            return (await q(`SELECT id, viewer_id, kind, delta, balance, note, actor, created_at FROM ${H} WHERE profile_id = ? AND viewer_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT ${n}`,
                [profileId, ...ids])).map((r) => ({ id: Number(r.id), viewerId: Number(r.viewer_id), kind: r.kind, delta: r.delta == null ? null : Number(r.delta),
                balance: r.balance == null ? null : Number(r.balance), note: r.note, actor: r.actor, createdAt: r.created_at }));
        },
        async count(profileId) {
            return Number((await q(`SELECT COUNT(*) AS n FROM ${V} WHERE profile_id = ?`, [profileId]))[0].n);
        },
        /** Every row of a profile in id order, a page at a time (CSV export). */
        async page(profileId, afterId = 0, limit = 2000) {
            const n = Math.min(5000, Math.max(1, Number(limit) || 2000));
            return (await q(`SELECT v.*, COALESCE(p.points, v.points) AS shown_points FROM ${V} v LEFT JOIN ${V} p ON p.id = v.person_id
                             WHERE v.profile_id = ? AND v.id > ? ORDER BY v.id LIMIT ${n}`, [profileId, Number(afterId) || 0])).map(viewerRow);
        },

        // ── linking (by hand only) ──
        /** Link b to a (a keeps the points; b's points move to a). Different platforms, neither linked yet. */
        async link(profileId, aId, bId, { actor = null } = {}) {
            if (Number(aId) === Number(bId)) return { ok: false, error: 'same' };
            return inTransaction(async (tq) => {
                const rows = await tq(`SELECT id, platform, person_id, points FROM ${V} WHERE profile_id = ? AND id IN (?, ?) ORDER BY id FOR UPDATE`, [profileId, aId, bId]);
                const a = rows.find((r) => Number(r.id) === Number(aId));
                const b = rows.find((r) => Number(r.id) === Number(bId));
                if (!a || !b) return { ok: false, error: 'no_viewer' };
                if (a.platform === b.platform) return { ok: false, error: 'same_platform' };
                const kids = Number((await tq(`SELECT COUNT(*) AS n FROM ${V} WHERE person_id IN (?, ?)`, [aId, bId]))[0].n);
                if (a.person_id || b.person_id || kids) return { ok: false, error: 'already_linked' };
                const moved = Number(b.points) || 0;
                const balance = Math.min(NUM_MAX, (Number(a.points) || 0) + moved);
                await tq(`UPDATE ${V} SET points = ? WHERE id = ?`, [balance, a.id]);
                await tq(`UPDATE ${V} SET points = 0, person_id = ? WHERE id = ?`, [a.id, b.id]);
                await tq(`INSERT INTO ${H} (profile_id, viewer_id, kind, delta, balance, note, actor) VALUES (?, ?, 'link', ?, ?, ?, ?), (?, ?, 'link', ?, 0, ?, ?)`,
                    [profileId, a.id, moved, balance, `Linked with their ${({ kick: 'Kick', youtube: 'YouTube' })[b.platform] || 'Twitch'} account`, str(actor, 100),
                        profileId, b.id, -moved, `Linked to their ${({ kick: 'Kick', youtube: 'YouTube' })[a.platform] || 'Twitch'} account; points moved there`, str(actor, 100)]);
                return { ok: true, primaryId: Number(a.id), moved };
            });
        },
        /** Undo a link (from either row). The points stay with the primary row. */
        async unlink(profileId, id, { actor = null } = {}) {
            const row = await vs.get(profileId, id);
            if (!row) return { ok: false, error: 'no_viewer' };
            const primaryId = row.personId || row.id;
            const r = await q(`UPDATE ${V} SET person_id = NULL WHERE profile_id = ? AND person_id = ?`, [profileId, primaryId]);
            if (!r.affectedRows) return { ok: false, error: 'not_linked' };
            await vs.addHistory(profileId, primaryId, { kind: 'link', note: 'Accounts unlinked; the points stayed here', actor });
            return { ok: true, primaryId };
        },
        async remove(profileId, id) {
            return (await q(`DELETE FROM ${V} WHERE profile_id = ? AND id = ?`, [profileId, id])).affectedRows > 0;
        },

        // ── import ──
        /**
         * Rows from another bot (Firebot, Streamer.bot). Idempotent: what an import added is kept in imported_*, so running
         * it again replaces that share instead of adding it twice; watch time and messages counted here since are kept.
         * Names fill in only where none is known. Seen dates widen (first earlier, last later). Fields left undefined are
         * not touched (Streamer.bot has names and last-seen dates only).
         *   rows: [{ id, login, name, firstSeen, lastSeen, minutes?, messages?, points? }]
         * → { created, updated, unchanged }
         */
        async importRows(profileId, platform, rows, source) {
            const out = { created: 0, updated: 0, unchanged: 0 };
            const src = String(source || 'import').slice(0, 20);
            const clean = [];
            const seenIds = new Set();
            for (const r of rows || []) {
                const id = str(r?.id, 64);
                if (!id || seenIds.has(id)) continue;
                seenIds.add(id);
                const n = (v) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? undefined : Math.max(0, Math.round(Number(v))));
                // Whole seconds, as TIMESTAMP keeps them (it rounds), so a second import compares equal and changes nothing.
                const d = (v) => { const x = v ? new Date(v) : null; return x && Number.isFinite(x.getTime()) && x.getFullYear() > 2000 ? new Date(Math.round(x.getTime() / 1000) * 1000) : null; };
                const last = d(r.lastSeen) || d(r.firstSeen);
                clean.push({ id, login: str(r.login && String(r.login).toLowerCase(), 100), name: str(r.name, 100), first: d(r.firstSeen) || last, last,
                    minutes: n(r.minutes), messages: n(r.messages), points: n(r.points) });
            }
            for (let i = 0; i < clean.length; i += CHUNK) {
                const chunk = clean.slice(i, i + CHUNK);
                const existing = new Map((await q(`SELECT * FROM ${V} WHERE profile_id = ? AND platform = ? AND platform_user_id IN (${chunk.map(() => '?').join(', ')})`,
                    [profileId, platform, ...chunk.map((r) => r.id)])).map((r) => [r.platform_user_id, viewerRow(r)]));
                for (const r of chunk) {
                    const e = existing.get(r.id);
                    const fromList = (cur) => [...new Set([...String(cur || '').split(',').filter(Boolean), src])].join(',').slice(0, 40);
                    if (!e) {
                        const when = r.last || new Date(now());
                        await q(`INSERT INTO ${V} (profile_id, platform, platform_user_id, login, display_name, first_seen_at, last_seen_at, watch_minutes, messages, points,
                                 imported_from, imported_minutes, imported_messages, imported_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                 ON DUPLICATE KEY UPDATE id = id`,
                        [profileId, platform, r.id, r.login, r.name, r.first || when, when, r.minutes || 0, r.messages || 0, r.points || 0,
                            src, r.minutes || 0, r.messages || 0, r.points || 0]);
                        out.created++;
                        continue;
                    }
                    const sets = [];
                    const params = [];
                    if (r.minutes !== undefined && r.minutes !== e.importedMinutes) {
                        sets.push('watch_minutes = LEAST(GREATEST(CAST(watch_minutes AS SIGNED) - CAST(imported_minutes AS SIGNED) + ?, 0), 4000000000)', 'imported_minutes = ?');
                        params.push(r.minutes, r.minutes);
                    }
                    if (r.messages !== undefined && r.messages !== e.importedMessages) {
                        sets.push('messages = LEAST(GREATEST(CAST(messages AS SIGNED) - CAST(imported_messages AS SIGNED) + ?, 0), 4000000000)', 'imported_messages = ?');
                        params.push(r.messages, r.messages);
                    }
                    if (r.points !== undefined && r.points !== e.importedPoints) {
                        sets.push('points = GREATEST(points - imported_points + ?, 0)', 'imported_points = ?');
                        params.push(r.points, r.points);
                    }
                    if (r.first && (!e.firstSeenAt || r.first < new Date(e.firstSeenAt))) { sets.push('first_seen_at = ?'); params.push(r.first); }
                    if (r.last && (!e.lastSeenAt || r.last > new Date(e.lastSeenAt))) { sets.push('last_seen_at = ?'); params.push(r.last); }
                    if (r.login && !e.login) { sets.push('login = ?'); params.push(r.login); }
                    if (r.name && !e.displayName) { sets.push('display_name = ?'); params.push(r.name); }
                    const from = fromList(e.importedFrom);
                    if (from !== (e.importedFrom || '')) { sets.push('imported_from = ?'); params.push(from); }
                    if (!sets.length) { out.unchanged++; continue; }
                    await q(`UPDATE ${V} SET ${sets.join(', ')} WHERE id = ?`, [...params, e.id]);
                    out.updated++;
                }
            }
            return out;
        },

        // ── privacy ──
        async exportProfile(profileId, { limit = 50_000 } = {}) {
            const n = Math.min(200_000, Math.max(1, Number(limit) || 50_000));
            const viewers = (await q(`SELECT * FROM ${V} WHERE profile_id = ? ORDER BY id LIMIT ${n}`, [profileId])).map(viewerRow);
            const history = await q(`SELECT viewer_id, kind, delta, balance, note, actor, created_at FROM ${H} WHERE profile_id = ? ORDER BY id DESC LIMIT ${n}`, [profileId]);
            return { viewers, history };
        },
        async countProfile(profileId) {
            return {
                viewers: Number((await q(`SELECT COUNT(*) AS n FROM ${V} WHERE profile_id = ?`, [profileId]))[0].n),
                history: Number((await q(`SELECT COUNT(*) AS n FROM ${H} WHERE profile_id = ?`, [profileId]))[0].n),
            };
        },
        async deleteProfile(profileId) {
            const c = await vs.countProfile(profileId);
            await q(`DELETE FROM ${H} WHERE profile_id = ?`, [profileId]);
            await q(`UPDATE ${V} SET person_id = NULL WHERE profile_id = ?`, [profileId]);
            await q(`DELETE FROM ${V} WHERE profile_id = ?`, [profileId]);
            return c;
        },
        /** A viewer's own rows, in every streamer's profile, found by platform account. */
        async exportAccounts(accounts, { limit = 1000 } = {}) {
            const out = { viewers: [], history: [] };
            const n = Math.min(10_000, Math.max(1, Number(limit) || 1000));
            for (const { platform, id } of accounts || []) {
                if (!platform || !id) continue;
                const rows = await q(`SELECT * FROM ${V} WHERE platform = ? AND platform_user_id = ? LIMIT ${n}`, [platform, String(id)]);
                for (const r of rows) {
                    const v = viewerRow(r);
                    out.viewers.push(v);
                    out.history.push(...await q(`SELECT viewer_id, kind, delta, balance, note, created_at FROM ${H} WHERE viewer_id = ? ORDER BY id DESC LIMIT ${n}`, [v.id]));
                }
            }
            return out;
        },
        async deleteAccounts(accounts) {
            const counts = { viewers: 0, history: 0 };
            for (const { platform, id } of accounts || []) {
                if (!platform || !id) continue;
                const rows = await q(`SELECT id FROM ${V} WHERE platform = ? AND platform_user_id = ?`, [platform, String(id)]);
                for (const r of rows) {
                    counts.history += (await q(`DELETE FROM ${H} WHERE viewer_id = ?`, [r.id])).affectedRows || 0;
                    await q(`UPDATE ${V} SET person_id = NULL WHERE person_id = ?`, [r.id]);
                    counts.viewers += (await q(`DELETE FROM ${V} WHERE id = ?`, [r.id])).affectedRows || 0;
                }
            }
            return counts;
        },
    };
    return vs;
}

export default { createViewerStore, viewerRow, VIEWER_SORTS };
