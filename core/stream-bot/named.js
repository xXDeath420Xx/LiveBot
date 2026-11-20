/*
 * Stream bot: viewers NAMED in another viewer's stored event (H-783), for /privacy and /privacy/viewer.
 *
 * An event's actor is found by actor_id (store.exportViewer / deleteViewer). Other people can be named inside it too:
 *
 *   role           platform  where (the stored notification `raw`, and `metadata` / `message` where copied there)
 *   reply_parent   twitch    chat: reply.parent_user_id / _login / _name, and reply.parent_message_body (their words)
 *   reply_thread   twitch    chat: reply.thread_user_id / _login / _name
 *   mention        twitch    chat: message.fragments[type=mention].mention.user_id / user_login / user_name
 *   reply_parent   kick      chat: replies_to.sender (user_id, username, channel_slug) and replies_to.content
 *   mention        kick      chat: "@name" in content (Kick sends no structured mentions; matched by login only)
 *   giftee         kick      gift_sub: giftees[] (user_id, username, channel_slug), and metadata.giftees (usernames)
 *   raid_target    twitch    raid: to_broadcaster_user_id / _login / _name
 *   (Twitch gift subs name no recipients; a gifted sub is its own event with the recipient as the actor.)
 *
 * Finding them without scanning `raw`: insertEvent records each named person in `<prefix>event_people` (migration 465:
 * platform + platform_user_id and platform + login are indexed, one row per person per event, deleted with the event).
 * A person with no id (a Kick "@name") is matched by login only; a row with an id is matched by id only, so a login
 * that later belongs to someone else never matches it.
 *
 *   namedPeople(ev)                       → [{ platform, userId, login, role }]                     pure
 *   redactEvent(row, who)                 → { message, metadata, raw, changed }                      pure
 *       the other viewer's event stays; only the fields naming `who` become null / "[removed]"
 *   createNamedIndex({ db, prefix, logger })
 *       .record(eventId, profileId, ev)    insertEvent calls it; never throws
 *       .identify(accounts)                → [{ platform, id, logins[], names[] }] (call before deleting their own events)
 *       .exportFor(who, { rowLimit })      → { events_naming_you: [...], music_named_you: [...] }
 *       .redactFor(who)                    → { '<prefix>events_naming_you': n, '<prefix>music_requests_decided': n, ... }
 *
 * Song requests (migration 457) name a moderator by display name only: music_requests.decided_by, music_bans.created_by,
 * music_playlist_items.added_by. Those are exported and replaced with "[removed]" by name (indexed by migration 465).
 *
 * Tested in tests/stream-bot-privacy-named.test.js.
 */

export const REMOVED = '[removed]';
export const NAMED_ROLES = Object.freeze({
    reply_parent: 'A chat message replied to you (your words in it are included)',
    reply_thread: 'A chat message in a reply thread you started',
    mention: 'A chat message mentioned you',
    giftee: 'You received a gifted sub',
    raid_target: 'A raid into your channel',
});
const MAX_PEOPLE = 60;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOGIN_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const KICK_MENTION_RE = /(?:^|[^\w@])@([A-Za-z0-9_]{2,25})(?![\w])/g;

const lower = (s) => (s == null ? null : String(s).trim().toLowerCase() || null);
const idOf = (v) => (v == null || v === '' ? null : ID_RE.test(String(v)) ? String(v) : null);
const loginOf = (v) => { const l = lower(v); return l && LOGIN_RE.test(l) ? l.slice(0, 100) : null; };
const parseMaybe = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { const o = JSON.parse(String(v)); return o && typeof o === 'object' ? o : null; } catch { return null; }
};
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Who an event names besides its actor. */
export function namedPeople(ev) {
    if (!ev || typeof ev !== 'object') return [];
    const platform = ev.platform;
    const raw = parseMaybe(ev.raw) || {};
    const meta = parseMaybe(ev.metadata) || {};
    const actorId = idOf(ev.user?.id ?? ev.actor_id);
    const out = [];
    const seen = new Set();
    const add = (role, id, login) => {
        const userId = idOf(id);
        const l = loginOf(login);
        if (!userId && !l) return;
        if (userId && actorId && userId === actorId) return;           // naming yourself: already yours as the actor
        const key = `${role}|${userId || ''}|${userId ? '' : l}`;
        if (seen.has(key) || out.length >= MAX_PEOPLE) return;
        seen.add(key);
        out.push({ platform, userId, login: l, role });
    };
    if (platform === 'twitch' && ev.type === 'chat') {
        const r = raw.reply;
        if (r && typeof r === 'object') {
            add('reply_parent', r.parent_user_id, r.parent_user_login);
            if (idOf(r.thread_user_id) !== idOf(r.parent_user_id)) add('reply_thread', r.thread_user_id, r.thread_user_login);
        }
        for (const f of Array.isArray(raw.message?.fragments) ? raw.message.fragments : []) {
            if (f?.type === 'mention' && f.mention) add('mention', f.mention.user_id, f.mention.user_login);
        }
    } else if (platform === 'kick' && ev.type === 'chat') {
        const s = raw.replies_to?.sender;
        if (s && typeof s === 'object') add('reply_parent', s.user_id, s.username || s.channel_slug);
        const text = String(ev.message ?? raw.content ?? '');
        for (const m of text.matchAll(KICK_MENTION_RE)) add('mention', null, m[1]);
    } else if (platform === 'kick' && ev.type === 'gift_sub') {
        const giftees = Array.isArray(raw.giftees) ? raw.giftees : [];
        for (const g of giftees) if (g && typeof g === 'object') add('giftee', g.user_id, g.username || g.channel_slug);
        if (!giftees.length) for (const n of Array.isArray(meta.giftees) ? meta.giftees : []) add('giftee', null, n);
    } else if (platform === 'twitch' && ev.type === 'raid') {
        add('raid_target', raw.to_broadcaster_user_id, raw.to_broadcaster_user_login);
    }
    return out;
}

/** who: { ids: string[], logins: string[], names: string[] } (logins and names compared case-insensitively). */
function matcher(who) {
    const ids = new Set((who.ids || []).map(String));
    const words = new Set([...(who.logins || []), ...(who.names || [])].map(lower).filter(Boolean));
    // Structured fields: by id when the field has one, otherwise by login or name.
    const is = (id, ...names) => {
        if (id != null && id !== '') return ids.has(String(id));
        return names.some((n) => n != null && words.has(lower(n)));
    };
    const mentionRe = words.size ? new RegExp(`@(?:${[...words].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\\w])`, 'gi') : null;
    const scrubText = (t) => (typeof t === 'string' && mentionRe ? t.replace(mentionRe, `@${REMOVED}`) : t);
    return { ids, words, is, scrubText };
}

/** For a raw notification that is not valid JSON (cut at 16 KB): blank the known fields by value. */
function scrubRawString(s, who) {
    let out = String(s);
    for (const id of who.ids) {
        out = out.replace(new RegExp(`("[a-z_]*user_id"\\s*:\\s*)"?${escapeRe(id)}"?(?=\\s*[,}])`, 'g'), '$1null');
    }
    for (const w of who.words) {
        out = out.replace(new RegExp(`("[a-z_]*(?:login|name|username|channel_slug)"\\s*:\\s*)"${escapeRe(w)}"`, 'gi'), `$1"${REMOVED}"`);
    }
    return who.scrubText(out);
}

/**
 * Remove `who` from one stored event of someone else.
 * @param {{ platform, type, message, metadata, raw }} row  metadata and raw as stored (JSON text) or parsed
 */
export function redactEvent(row, who) {
    const m0 = matcher(who);
    // Logins and names read from a field matched by id: their "@name" in the text goes too.
    const seenAs = new Set();
    const note = (...ns) => { for (const n of ns) { const l = lower(n); if (l && l !== lower(REMOVED)) seenAs.add(l); } };
    let changed = false;

    let raw = row.raw;
    const obj = parseMaybe(row.raw);
    let hit = false;
    if (obj) {
        const r = obj.reply;
        if (row.platform === 'twitch' && r && typeof r === 'object') {
            if (m0.is(r.parent_user_id, r.parent_user_login, r.parent_user_name)) {
                note(r.parent_user_login, r.parent_user_name);
                Object.assign(r, { parent_user_id: null, parent_user_login: null, parent_user_name: REMOVED, parent_message_body: REMOVED });
                hit = true;
            }
            if (m0.is(r.thread_user_id, r.thread_user_login, r.thread_user_name)) {
                note(r.thread_user_login, r.thread_user_name);
                Object.assign(r, { thread_user_id: null, thread_user_login: null, thread_user_name: REMOVED });
                hit = true;
            }
        }
        for (const f of Array.isArray(obj.message?.fragments) ? obj.message.fragments : []) {
            if (f?.type === 'mention' && f.mention && m0.is(f.mention.user_id, f.mention.user_login, f.mention.user_name)) {
                note(f.mention.user_login, f.mention.user_name);
                f.mention = { user_id: null, user_login: null, user_name: REMOVED };
                f.text = `@${REMOVED}`;
                hit = true;
            }
        }
        const rs = obj.replies_to?.sender;
        if (row.platform === 'kick' && rs && typeof rs === 'object' && m0.is(rs.user_id, rs.username, rs.channel_slug)) {
            note(rs.username, rs.channel_slug);
            obj.replies_to.sender = { user_id: null, username: REMOVED, channel_slug: null };
            if ('content' in obj.replies_to) obj.replies_to.content = REMOVED;
            hit = true;
        }
        if (Array.isArray(obj.giftees)) {
            obj.giftees = obj.giftees.map((g) => {
                if (g && typeof g === 'object' && m0.is(g.user_id, g.username, g.channel_slug)) {
                    note(g.username, g.channel_slug);
                    hit = true;
                    return { user_id: null, username: REMOVED, channel_slug: null };
                }
                return g;
            });
        }
        if (row.platform === 'twitch' && row.type === 'raid' && m0.is(obj.to_broadcaster_user_id, obj.to_broadcaster_user_login, obj.to_broadcaster_user_name)) {
            Object.assign(obj, { to_broadcaster_user_id: null, to_broadcaster_user_login: null, to_broadcaster_user_name: REMOVED });
            hit = true;
        }
    }
    const m = matcher({ ids: who.ids, logins: [...(who.logins || []), ...seenAs], names: who.names });

    // Text: "@name" in the chat message, in the notification's copy of it, and in Kick's content.
    const message = typeof row.message === 'string' ? m.scrubText(row.message).slice(0, 1000) : row.message;
    if (message !== row.message) changed = true;
    if (obj) {
        if (obj.message && typeof obj.message.text === 'string') {
            const t = m.scrubText(obj.message.text);
            if (t !== obj.message.text) { obj.message.text = t; hit = true; }
        }
        if (typeof obj.content === 'string') {
            const t = m.scrubText(obj.content);
            if (t !== obj.content) { obj.content = t; hit = true; }
        }
        if (hit) { raw = JSON.stringify(obj); changed = true; }
    } else if (typeof row.raw === 'string' && row.raw) {
        const s = scrubRawString(row.raw, m);
        if (s !== row.raw) { raw = s; changed = true; }
    }

    let metadata = parseMaybe(row.metadata);
    if (metadata && Array.isArray(metadata.giftees)) {
        const g = metadata.giftees.map((n) => (m.words.has(lower(n)) ? REMOVED : n));
        if (g.some((n, i) => n !== metadata.giftees[i])) { metadata = { ...metadata, giftees: g }; changed = true; }
    }
    return { message, metadata, raw, changed };
}

export function createNamedIndex({ db, prefix = 'stream_bot_', logger = null } = {}) {
    if (!/^[a-z0-9_]{1,30}$/.test(prefix)) throw new Error('bad table prefix');
    const T = (n) => `\`${prefix}${n}\``;
    const q = async (sql, params = []) => (await db.query(sql, params))[0];
    const missing = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146);
    let offUntil = 0;   // migration 465 not applied: stop trying for a while

    async function record(eventId, profileId, ev) {
        if (!eventId || Date.now() < offUntil) return 0;
        let people;
        try { people = namedPeople(ev); } catch { return 0; }
        if (!people.length) return 0;
        try {
            const rows = people.map((p) => [Number(eventId), Number(profileId), p.platform, p.userId, p.login, p.role]);
            await q(`INSERT INTO ${T('event_people')} (event_id, profile_id, platform, platform_user_id, login, role) VALUES ?`, [rows]);
            return rows.length;
        } catch (err) {
            if (missing(err)) offUntil = Date.now() + 10 * 60_000;
            else { try { logger?.warn?.('[StreamBot] named-people index failed', { eventId, error: err?.message }); } catch { /* ignore */ } }
            return 0;
        }
    }

    /** Every login and display name the accounts are known by (from their own events, the index and song requests). */
    async function identify(accounts) {
        const out = [];
        for (const a of accounts || []) {
            const id = idOf(a?.id);
            if (!a?.platform || !id) continue;
            const logins = new Set([loginOf(a.login)].filter(Boolean));
            const names = new Set([lower(a.name)].filter(Boolean));
            const tryAdd = async (sql, cols) => {
                try { for (const r of await q(sql, [a.platform, id])) for (const [c, set] of cols) { const v = c === 'name' ? lower(r[c]) : loginOf(r[c]); if (v) set.add(v); } } catch { /* table missing */ }
            };
            await tryAdd(`SELECT DISTINCT actor_login AS login, actor_name AS name FROM ${T('events')} WHERE platform = ? AND actor_id = ? LIMIT 50`, [['login', logins], ['name', names]]);
            await tryAdd(`SELECT DISTINCT login FROM ${T('event_people')} WHERE platform = ? AND platform_user_id = ? LIMIT 50`, [['login', logins]]);
            await tryAdd(`SELECT DISTINCT viewer_login AS login, viewer_name AS name FROM ${T('music_requests')} WHERE platform = ? AND viewer_id = ? LIMIT 50`, [['login', logins], ['name', names]]);
            await tryAdd(`SELECT DISTINCT viewer_name AS name FROM ${T('music_likes')} WHERE platform = ? AND viewer_id = ? LIMIT 50`, [['name', names]]);
            out.push({ platform: a.platform, id, logins: [...logins], names: [...names] });
        }
        return out;
    }

    /** event id → roles, for one person: by id, and by login where the index row has no id. */
    async function eventsNaming(p, limit) {
        const roles = new Map();
        const put = (rows) => { for (const r of rows) { const k = Number(r.event_id); if (!roles.has(k)) roles.set(k, new Set()); roles.get(k).add(r.role); } };
        put(await q(`SELECT event_id, role FROM ${T('event_people')} WHERE platform = ? AND platform_user_id = ? ORDER BY event_id DESC LIMIT ${limit}`, [p.platform, p.id]));
        const words = [...new Set([...p.logins, ...p.names])].filter((w) => LOGIN_RE.test(w));
        if (words.length) {
            put(await q(`SELECT event_id, role FROM ${T('event_people')} WHERE platform = ? AND login IN (?) AND platform_user_id IS NULL ORDER BY event_id DESC LIMIT ${limit}`, [p.platform, words]));
        }
        return roles;
    }

    const nameList = (p) => [...new Set([...p.names, ...p.logins])].filter(Boolean).slice(0, 100);

    async function exportFor(who, { rowLimit = 1000 } = {}) {
        const n = Math.max(1, Math.min(10_000, Number(rowLimit) || 1000));
        const events = [];
        const music = [];
        for (const p of who || []) {
            try {
                const roles = await eventsNaming(p, n);
                const ids = [...roles.keys()].sort((a, b) => b - a).slice(0, n);
                if (ids.length) {
                    for (const r of await q(`SELECT id, profile_id, platform, type, channel_id, actor_id, message, occurred_at FROM ${T('events')} WHERE id IN (?) ORDER BY id DESC`, [ids])) {
                        if (r.platform === p.platform && String(r.actor_id ?? '') === p.id) continue;   // their own event: exported as the actor
                        const named = [...roles.get(Number(r.id))];
                        events.push({
                            eventId: Number(r.id), profileId: Number(r.profile_id), platform: r.platform, type: r.type, channelId: r.channel_id,
                            namedAs: named, why: named.map((x) => NAMED_ROLES[x] || x).join('; '),
                            message: r.type === 'chat' ? r.message : null,
                            occurredAt: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
                        });
                    }
                }
            } catch (err) { if (!missing(err)) throw err; }
            const names = nameList(p);
            if (names.length) {
                const pick = async (sql, field) => { try { for (const r of await q(sql, [names])) music.push({ ...r, namedAs: field }); } catch (err) { if (!missing(err)) throw err; } };
                await pick(`SELECT profile_id, platform, title, artist, status, decided_at FROM ${T('music_requests')} WHERE decided_by IN (?) ORDER BY id DESC LIMIT ${n}`, 'decided_by');
                await pick(`SELECT profile_id, kind, title, artist, created_at FROM ${T('music_bans')} WHERE created_by IN (?) ORDER BY id DESC LIMIT ${n}`, 'created_by');
                await pick(`SELECT profile_id, playlist_id, title, artist, created_at FROM ${T('music_playlist_items')} WHERE added_by IN (?) ORDER BY id DESC LIMIT ${n}`, 'added_by');
            }
        }
        return { events_naming_you: events, music_named_you: music };
    }

    async function redactFor(who) {
        const counts = {};
        const bump = (k, v) => { if (v) counts[`${prefix}${k}`] = (counts[`${prefix}${k}`] || 0) + v; };
        for (const p of who || []) {
            const m = { ids: [p.id], logins: p.logins, names: p.names };
            try {
                const roles = await eventsNaming(p, 100_000);
                const ids = [...roles.keys()];
                for (let i = 0; i < ids.length; i += 200) {
                    const batch = ids.slice(i, i + 200);
                    for (const r of await q(`SELECT id, platform, type, actor_id, message, metadata, raw FROM ${T('events')} WHERE id IN (?)`, [batch])) {
                        const x = redactEvent(r, m);
                        if (x.changed) {
                            await q(`UPDATE ${T('events')} SET message = ?, metadata = ?, raw = ? WHERE id = ?`,
                                [x.message ?? null, x.metadata == null ? null : JSON.stringify(x.metadata), x.raw ?? null, r.id]);
                            bump('events_naming_you', 1);
                        }
                    }
                    // The index rows go too: they are what named this person.
                    await q(`DELETE FROM ${T('event_people')} WHERE event_id IN (?) AND platform = ? AND (platform_user_id = ? OR (platform_user_id IS NULL AND login IN (?)))`,
                        [batch, p.platform, p.id, [...new Set([...p.logins, ...p.names, '\u0000'])]]);
                }
            } catch (err) { if (!missing(err)) throw err; }
            const names = nameList(p);
            if (names.length) {
                const set = async (sql, k) => { try { bump(k, (await q(sql, [REMOVED, names])).affectedRows); } catch (err) { if (!missing(err)) throw err; } };
                await set(`UPDATE ${T('music_requests')} SET decided_by = ? WHERE decided_by IN (?)`, 'music_requests_decided');
                await set(`UPDATE ${T('music_bans')} SET created_by = ? WHERE created_by IN (?)`, 'music_bans_created');
                await set(`UPDATE ${T('music_playlist_items')} SET added_by = ? WHERE added_by IN (?)`, 'music_playlist_items_added');
            }
        }
        return counts;
    }

    return { record, identify, exportFor, redactFor };
}

export default { namedPeople, redactEvent, createNamedIndex, NAMED_ROLES, REMOVED };
