/*
 * Stream bot viewers: the live side (H-747; design §11).
 *
 *   createViewerService({ db, store, vstore, helix?, streamInfo?, io?, ingest?, logger?, now?, rng?, ignoreLogins? })
 *     onEvent(profileId, pub)        every event the live feed publishes: chat lines, follows, subs, gifts, Bits, raids, tips
 *     tick()                         the watch-time sample (every 5 minutes): for each live linked channel, who is there
 *     start() / stop()               the sample timer (startStreamBot starts it; scripts and tests do not)
 *     settingsFor(profileId) / saveSettings(profileId, value)
 *     changePoints(profileId, viewerId, amount, opts)   with the rank-up check
 *     commands.run(profile, command, { ev, input })     !points, !top, !give, !gamble, !addpoints, !removepoints
 *     templateValues({ ev, profileId, template })       {user.points} {user.watchtime} {user.messages} {user.rank} {points.name}
 *     conditionData({ ev, profileId })                  what the viewer conditions compare
 *     status(profileId)                                 the last sample, for the settings page
 *
 * Watch time. Twitch's only documented "who is here" list is the chatters list (GET /helix/chat/chatters, scope
 * moderator:read:chatters, the Stream bot grant): everyone connected to chat, lurkers included. It is read every 5 minutes
 * while the channel is live and each person on it is credited 5 minutes. Kick's public API has no list of chatters or
 * viewers (checked 2026-11-19: docs.kick.com chat, livestreams, channels), so on Kick, and on Twitch while the grant lacks
 * the scope, only active chatters count: people who chatted in the last 10 minutes. No private API or GQL is used.
 * Live state comes from stream-info.js (the app token, cached 60 s). The broadcaster, the CertiFried bot account and the
 * logins on the settings' "Not counted" list never count.
 * YouTube (H-741) counts like Kick: the YouTube API has no list of who is watching, so people who chatted in the last 10
 * minutes. Super Chats, Super Stickers and Jewels are tallied as tips (per currency); memberships count as subs.
 * YouTube viewers never earn points (YouTube API Services Developer Policies III.F.3.c, no rewards for engaging with
 * YouTube; youtube/policy.js): their watch time, messages, subscriptions and memberships are counted, the points are not,
 * and the points commands answer in YouTube chat that points are Twitch and Kick only.
 *
 * Points are a tally kept for fun: earned for watch time while live, bonuses for follows, subs, gifts, Bits and raids.
 * Nothing can be bought with money, and CertiFried never handles a payment.
 */
import { withDefaults, watchAward, rankFor, rankCrossed, currencyCommand, formatWatch, formatPoints, SAMPLE_MINUTES } from './settings.js';
import { TIP_SOURCES } from '../events.js';
import { noRewards, YT_POINTS_REPLY } from '../youtube/policy.js';

export const ACTIVE_MINUTES = 10;
const MAX_CHATTER_PAGES = 25;
const RANKUPS_PER_SAMPLE = 25;
const SETTINGS_CACHE_MS = 30_000;
export const CHATTERS_SCOPE = 'moderator:read:chatters';
/** Platforms with viewer records (YouTube added with H-741). */
export const VIEWER_PLATFORMS = Object.freeze(['twitch', 'kick', 'youtube']);
const isViewerPlatform = (p) => VIEWER_PLATFORMS.includes(p);

const firstArg = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);
const isMod = (ev) => (ev?.user?.roles || []).some((r) => r === 'moderator' || r === 'broadcaster');

/** "100", "all", "50%" → a whole number of points (null when it is not one). */
export function parseAmount(text, balance) {
    const t = String(text ?? '').trim().toLowerCase().replace(/,/g, '');
    if (!t) return null;
    if (t === 'all') return Math.max(0, Math.floor(Number(balance) || 0));
    const pct = t.match(/^(\d{1,3})%$/);
    if (pct) { const p = Number(pct[1]); return p > 0 && p <= 100 ? Math.floor((Number(balance) || 0) * p / 100) : null; }
    if (!/^\d{1,12}$/.test(t)) return null;
    return Number(t);
}

export function createViewerService({
    db, store, vstore, helix = null, streamInfo = null, io = null, ingest = null, logger = null,
    now = () => Date.now(), rng = Math.random, ignoreLogins = [], sampleMs = SAMPLE_MINUTES * 60_000,
} = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotViewers] ${msg}`, meta); } catch { /* ignore */ } };
    const settingsCache = new Map();   // profileId -> { at, value }
    const active = new Map();          // 'profileId:platform' -> Map(userId -> { at, id, login, name, roles })
    const lastSample = new Map();      // profileId -> status
    const botLogins = new Set(ignoreLogins.filter(Boolean).map((s) => String(s).toLowerCase()));
    let timer = null;
    let first = null;
    let running = false;

    async function settingsFor(profileId) {
        const hit = settingsCache.get(Number(profileId));
        if (hit && now() - hit.at < SETTINGS_CACHE_MS) return hit.value;
        const p = await store.getProfile(profileId);
        const value = withDefaults(p?.settings?.viewers);
        settingsCache.set(Number(profileId), { at: now(), value });
        return value;
    }
    async function saveSettings(profileId, value) {
        await store.setSettingsKey(profileId, 'viewers', value);
        settingsCache.delete(Number(profileId));
    }
    const ignored = (s, login) => { const l = String(login || '').toLowerCase(); return !!l && (botLogins.has(l) || s.ignore.includes(l)); };

    function noteActive(profileId, platform, u) {
        const k = `${profileId}:${platform}`;
        let m = active.get(k);
        if (!m) { m = new Map(); active.set(k, m); }
        m.set(String(u.id), { at: now(), id: String(u.id), login: u.login || null, name: u.name || null, roles: u.roles || [] });
        if (m.size > 20_000) for (const [id, v] of m) if (now() - v.at > ACTIVE_MINUTES * 60_000) m.delete(id);
    }
    function activeUsers(profileId, platform) {
        const m = active.get(`${profileId}:${platform}`);
        if (!m) return [];
        const out = [];
        for (const [id, v] of m) { if (now() - v.at > ACTIVE_MINUTES * 60_000) m.delete(id); else out.push(v); }
        return out;
    }

    async function channelFor(profileId, platform) {
        try { return (await io?.channelsFor(profileId))?.find((c) => c.platform === platform) || null; } catch { return null; }
    }

    /** Raise "Viewer reached a new rank" as an event of the viewer's platform (stored, shown, runs automations). */
    async function rankUp(profileId, s, row, rank, previous) {
        await vstore.setRank(profileId, row.id, rank);
        await vstore.addHistory(profileId, row.id, { kind: 'rank', note: `Reached ${rank}${previous ? ` (was ${previous})` : ''}`, actor: 'stream bot' });
        if (!ingest?.internal) return;
        const ch = await channelFor(profileId, row.platform);
        await ingest.internal(profileId, {
            platform: row.platform, type: 'viewer.rank_up', channelId: ch ? String(ch.platform_user_id) : null, internal: true,
            user: { id: row.platformUserId, login: row.login, name: row.name, roles: row.roles || [] },
            amount: null, currency: null, message: rank, metadata: { rank, previous: previous || null, basis: s.ranks.basis },
            raw: null, occurredAt: new Date(now()), dedupeKey: null,
        });
    }

    /** After a points change: a rank-up when ranks follow points and a threshold was crossed. */
    async function checkPointsRank(profileId, s, viewerId, before, after) {
        if (s.ranks.basis !== 'points' || !s.ranks.list.length) return;
        const crossed = rankCrossed(s, before, after);
        const row = await vstore.get(profileId, viewerId);
        if (!row) return;
        if (crossed && crossed !== row.rankName) await rankUp(profileId, s, row, crossed, row.rankName);
        else {
            const cur = rankFor(s, { points: after })?.name || null;
            if (cur !== row.rankName) await vstore.setRank(profileId, row.id, cur);
        }
    }

    async function changePoints(profileId, viewerId, amount, opts = {}) {
        const r = await vstore.changePoints(profileId, viewerId, amount, opts);
        if (r.ok && r.change) {
            try { await checkPointsRank(profileId, await settingsFor(profileId), r.targetId, r.before, r.balance); } catch (err) { log('warn', 'rank check failed', { error: err?.message }); }
        }
        return r;
    }

    async function bonus(profileId, s, row, n, note) {
        if (!row || !(n > 0) || noRewards(row.platform)) return;
        await changePoints(profileId, row.id, n, { kind: 'bonus', note, actor: 'stream bot' });
    }

    // ── events ──
    async function onEvent(profileId, pub) {
        if (!pub || pub.test) return;
        if (!(await vstore.available())) return;
        const s = await settingsFor(profileId);
        if (!s.tracking) return;
        const when = pub.occurredAt ? new Date(pub.occurredAt) : new Date(now());
        const p = pub.platform;
        if (isViewerPlatform(p)) {
            const u = pub.user;
            if (!u?.id || ignored(s, u.login)) return;
            const isChannel = pub.channelId != null && String(u.id) === String(pub.channelId);
            const m = pub.metadata || {};
            const amt = Number(pub.amount) || 0;
            switch (pub.type) {
                case 'chat':
                    if (isChannel || ingest?.isEcho?.({ ...pub, user: u })) return;
                    noteActive(profileId, p, u);
                    await vstore.seen(profileId, p, [u], { when, messages: 1 });
                    return;
                case 'follow': {
                    const row = await vstore.addStats(profileId, p, u, { follows: 1 }, { when, followedAt: when });
                    if (noRewards(p)) return;   // a YouTube subscriber is counted, never rewarded (III.F.3.c)
                    return bonus(profileId, s, row, s.earn.follow, 'Follow bonus');
                }
                case 'sub':
                case 'resub': {
                    const months = pub.type === 'resub' ? (m.months ?? amt) : (m.months ?? null);
                    const row = await vstore.addStats(profileId, p, { ...u, roles: [...new Set([...(u.roles || []), 'subscriber'])] }, { subs: 1 }, { when, subMonths: months });
                    if (pub.type === 'sub' && m.isGift) return;   // the gifter's bonus covers a gifted sub
                    return bonus(profileId, s, row, s.earn.sub, pub.type === 'resub' ? 'Resub bonus' : 'Sub bonus');
                }
                case 'gift_sub': {
                    const count = Math.max(1, Math.round(Number(m.count ?? amt) || 1));
                    const row = await vstore.addStats(profileId, p, u, { gifts: 1, giftedSubs: count }, { when });
                    if (noRewards(p)) return;   // gifted YouTube memberships: counted, never rewarded
                    return bonus(profileId, s, row, s.earn.giftPerSub * count, `Gift bonus (${count} sub${count === 1 ? '' : 's'})`);
                }
                case 'cheer':
                case 'bits.used': {
                    // A cheer arrives as both channel.cheer and channel.bits.use: count Bits once (the cheer), power-ups from bits.used.
                    if (pub.type === 'bits.used' && m.kind === 'cheer') return;
                    if (amt <= 0) return;
                    const row = await vstore.addStats(profileId, p, u, { cheers: pub.type === 'cheer' ? 1 : 0, bits: amt }, { when });
                    return bonus(profileId, s, row, Math.floor(amt / 100) * s.earn.bitsPer100, `Bits bonus (${formatPoints(amt)} Bits)`);
                }
                case 'raid': {
                    const row = await vstore.addStats(profileId, p, u, { raids: 1, raidViewers: amt }, { when });
                    return bonus(profileId, s, row, s.earn.raid, `Raid bonus (${formatPoints(amt)} viewers)`);
                }
                case 'membership': {
                    // YouTube memberships (new, milestone, gifted to them): counted as subs, like Twitch and Kick subs.
                    if (p !== 'youtube') return;
                    await vstore.addStats(profileId, p, { ...u, roles: [...new Set([...(u.roles || []), 'subscriber'])] }, { subs: 1 }, { when, subMonths: m.months ?? null });
                    // No membership bonus: YouTube memberships are counted on the record and never rewarded (III.F.3.c).
                    return;
                }
                case 'tip': {
                    // YouTube Super Chats, Super Stickers and Jewels: tallied per currency; CertiFried never handles money.
                    if (p !== 'youtube' || !(amt > 0) || !pub.currency) return;
                    const row = (await vstore.seen(profileId, p, [u], { when }))[0]?.row || null;
                    if (row) await vstore.addTip(profileId, row.id, pub.currency, amt);
                    return;
                }
                default:
                    return;
            }
        }
        // Tips come from tip services with a name only: counted for a viewer whose login is exactly that name.
        if (TIP_SOURCES.includes(p) && pub.type === 'tip' && pub.user?.name && !/^anonymous$/i.test(pub.user.name)) {
            const row = await vstore.byLogin(profileId, pub.user.name);
            if (row) await vstore.addTip(profileId, row.id, pub.currency, pub.amount);
        }
    }

    // ── the watch-time sample ──
    /** Everyone in a live Twitch chat, through the Stream bot grant. { ok, users } or { ok: false, reason }. */
    async function twitchChatters(profileId, ch) {
        if (!helix) return { ok: false, reason: 'unavailable' };
        let grant = null;
        try { grant = await store.getTwitchGrant(profileId); } catch { grant = null; }
        if (!grant || grant.status !== 'active') return { ok: false, reason: 'no_grant' };
        if (String(grant.twitch_user_id) !== String(ch.platform_user_id)) return { ok: false, reason: 'other_account' };
        if (!grant.scopes.includes(CHATTERS_SCOPE)) return { ok: false, reason: 'scope' };
        const users = [];
        let after = null;
        for (let page = 0; page < MAX_CHATTER_PAGES; page++) {
            const { data } = await helix.call(profileId, 'GET', '/chat/chatters', {
                query: (me) => ({ broadcaster_id: me.userId, moderator_id: me.userId, first: 1000, after }), need: [CHATTERS_SCOPE],
            });
            for (const c of data?.data || []) if (c?.user_id) users.push({ id: String(c.user_id), login: c.user_login || null, name: c.user_name || c.user_login || null });
            after = data?.pagination?.cursor || null;
            if (!after) break;
        }
        return { ok: true, users };
    }

    async function credit(profileId, s, ch, users, minutes) {
        const res = await vstore.seen(profileId, ch.platform, users, { when: new Date(now()), minutes });
        if (!res.length) return { credited: 0, points: 0, rankUps: 0 };
        const pidOf = (row) => row.personId || row.id;
        const totals = await vstore.personTotals(profileId, res.map((o) => pidOf(o.row)));
        const awards = new Map();
        const added = new Map();
        for (const o of res) {
            const pid = pidOf(o.row);
            added.set(pid, (added.get(pid) || 0) + minutes);
            // YouTube: the minutes are counted, no points (III.F.3.c).
            const n = noRewards(ch.platform) || noRewards(o.row.platform) ? 0 : watchAward(s, o.beforeMinutes, minutes, o.row.roles.includes('subscriber'));
            if (n) awards.set(pid, (awards.get(pid) || 0) + n);
        }
        await vstore.addPointsBulk(profileId, awards);
        let rankUps = 0;
        if (s.ranks.list.length) {
            const byPid = new Map(res.map((o) => [pidOf(o.row), o.row]));
            for (const [pid, t] of totals) {
                const after = s.ranks.basis === 'points' ? t.points + (awards.get(pid) || 0) : t.watch;
                const before = s.ranks.basis === 'points' ? t.points : t.watch - (added.get(pid) || 0);
                const crossed = rankCrossed(s, before, after);
                const current = rankFor(s, { watchMinutes: t.watch, points: after })?.name || null;
                const row = byPid.get(pid);
                if (crossed && crossed !== t.rankName && rankUps < RANKUPS_PER_SAMPLE) {
                    rankUps++;
                    const primary = row && row.id === pid ? row : await vstore.get(profileId, pid);
                    if (primary) await rankUp(profileId, s, primary, crossed, t.rankName);
                } else if (current !== t.rankName) await vstore.setRank(profileId, pid, current);
            }
        }
        return { credited: res.length, points: [...awards.values()].reduce((a, b) => a + b, 0), rankUps };
    }

    async function profilesWithChannels() {
        const rows = (await db.query(`SELECT c.profile_id, c.platform, c.platform_user_id, c.login FROM \`${store.table('channels')}\` c
                                      JOIN \`${store.table('profiles')}\` p ON p.id = c.profile_id WHERE p.enabled = 1 AND c.platform IN ('twitch', 'kick', 'youtube') ORDER BY c.profile_id, c.id`))[0];
        const map = new Map();
        for (const r of rows) {
            const id = Number(r.profile_id);
            if (!map.has(id)) map.set(id, []);
            map.get(id).push({ platform: r.platform, platform_user_id: String(r.platform_user_id), login: r.login });
        }
        return map;
    }

    async function sampleProfile(profileId, channels) {
        const s = await settingsFor(profileId);
        const st = { at: new Date(now()).toISOString(), tracking: s.tracking, channels: [] };
        if (!s.tracking) { lastSample.set(profileId, st); return st; }
        for (const ch of channels) {
            const row = { platform: ch.platform, login: ch.login, live: false, source: null, reason: null, counted: 0, points: 0 };
            st.channels.push(row);
            let info = null;
            try { info = streamInfo ? await streamInfo.get({ profileId, platform: ch.platform, channelId: ch.platform_user_id }) : null; } catch { info = null; }
            if (!info?.live) continue;
            row.live = true;
            let users;
            if (ch.platform === 'twitch') {
                let r;
                try { r = await twitchChatters(profileId, ch); } catch (err) { r = { ok: false, reason: 'twitch_error' }; log('warn', 'chatters list failed', { profileId, error: err?.code || 'error' }); }
                if (r.ok) { users = r.users; row.source = 'chatters'; } else { users = activeUsers(profileId, 'twitch'); row.source = 'active'; row.reason = r.reason; }
            } else {
                users = activeUsers(profileId, ch.platform);   // Kick and YouTube: who chatted in the last 10 minutes
                row.source = 'active';
            }
            users = users.filter((u) => u?.id && String(u.id) !== String(ch.platform_user_id) && !ignored(s, u.login));
            const c = await credit(profileId, s, ch, users, SAMPLE_MINUTES);
            row.counted = c.credited;
            row.points = c.points;
        }
        lastSample.set(profileId, st);
        return st;
    }

    async function tick() {
        if (running) return { skipped: true };
        running = true;
        const out = { profiles: 0, credited: 0 };
        try {
            if (!(await vstore.available())) return { skipped: true, reason: 'not_migrated' };
            const map = await profilesWithChannels();
            for (const [profileId, channels] of map) {
                try {
                    const st = await sampleProfile(profileId, channels);
                    out.profiles++;
                    out.credited += st.channels.reduce((a, c) => a + c.counted, 0);
                } catch (err) {
                    log('warn', 'sample failed', { profileId, error: err?.message });
                }
            }
            if (out.credited) log('info', 'watch time sampled', out);
            return out;
        } finally {
            running = false;
        }
    }

    // ── commands ──
    async function ensureViewer(profileId, ev) {
        const u = ev?.user;
        if (!u?.id || !isViewerPlatform(ev.platform)) return null;
        return (await vstore.byAccount(profileId, ev.platform, u.id)) || (await vstore.seen(profileId, ev.platform, [u], { when: new Date(now()) }))[0]?.row || null;
    }
    async function findTarget(profileId, ev, name) {
        return vstore.byLogin(profileId, name, isViewerPlatform(ev?.platform) ? ev.platform : null);
    }
    const nameOf = (row) => row?.name || row?.login || 'someone';

    async function run(profile, command, { ev, input = '' } = {}) {
        const profileId = profile.id;
        if (!(await vstore.available())) return { reply: null, detail: 'viewer stats start after the next CertiFried update' };
        const s = await settingsFor(profileId);
        const cur = s.currency;
        const args = firstArg(input);
        // Points are Twitch and Kick only: YouTube chat is told so, and nothing is read or changed (III.F.3.c).
        if (noRewards(ev?.platform)) return { reply: YT_POINTS_REPLY, detail: 'points are Twitch and Kick only' };
        const me = await ensureViewer(profileId, ev);
        const who = ev?.user?.name || ev?.user?.login || 'You';
        switch (command) {
            case 'points': {
                const target = args[0] ? await findTarget(profileId, ev, args[0]) : me;
                if (!target) return { reply: args[0] ? `I have not seen ${args[0].replace(/^@/, '')} here yet.` : null, detail: 'no viewer' };
                const person = await vstore.person(profileId, target.id);
                const rank = rankFor(s, { watchMinutes: person.totals.watchMinutes, points: person.points })?.name;
                const place = await vstore.placeOf(profileId, person.points, [...botLogins, ...s.ignore]);
                return { reply: `${nameOf(person.primary)} has ${formatPoints(person.points)} ${cur} (#${place})${rank ? `, rank ${rank}` : ''}, and has watched ${formatWatch(person.totals.watchMinutes)}.` };
            }
            case 'top': {
                const k = String(args[0] || '').toLowerCase();
                const by = ['watch', 'watchtime', 'time', 'hours'].includes(k) ? 'watch' : ['messages', 'chat', 'msgs'].includes(k) ? 'messages' : 'points';
                const list = await vstore.top(profileId, { by, limit: 5, exclude: [...botLogins, ...s.ignore] });
                if (!list.length) return { reply: `Nobody has any ${by === 'watch' ? 'watch time' : by === 'messages' ? 'messages' : cur} yet.` };
                const val = (r) => (by === 'watch' ? formatWatch(r.value) : formatPoints(r.value));
                return { reply: `Top ${by === 'watch' ? 'watch time' : by === 'messages' ? 'chatters' : cur}: ${list.map((r) => `${r.place}. ${r.name} (${val(r)})`).join(', ')}` };
            }
            case 'give': {
                if (!s.give.enabled) return { reply: `Giving ${cur} is turned off.` };
                if (!me) return { reply: null, detail: 'no viewer for this event' };
                const target = args[0] ? await findTarget(profileId, ev, args[0]) : null;
                if (!target) return { reply: args[0] ? `I have not seen ${args[0].replace(/^@/, '')} here yet.` : `Use it like this: !give @name 100` };
                const mine = (await vstore.person(profileId, me.id)).points;
                const n = parseAmount(args[1], mine);
                if (!n || n < s.give.min) return { reply: `Give at least ${formatPoints(s.give.min)} ${cur}, like this: !give @name 100` };
                const r = await vstore.transfer(profileId, me.id, target.id, n, { note: `${who} gave ${formatPoints(n)} to ${nameOf(target)}`, actor: `chat:${ev?.user?.login || who}` });
                if (!r.ok) return { reply: r.error === 'same' ? 'You cannot give to yourself.' : r.error === 'not_enough' ? `${who}, you have ${formatPoints(r.balance)} ${cur}.` : 'That did not work.' };
                const s2 = await settingsFor(profileId);
                await checkPointsRank(profileId, s2, r.from, r.fromBalance + n, r.fromBalance).catch(() => {});
                await checkPointsRank(profileId, s2, r.to, r.toBalance - n, r.toBalance).catch(() => {});
                return { reply: `${who} gave ${formatPoints(n)} ${cur} to ${nameOf(target)}.` };
            }
            case 'gamble': {
                if (!s.gamble.enabled) return { reply: `Gambling is turned off on this channel.` };
                if (!me) return { reply: null, detail: 'no viewer for this event' };
                const mine = (await vstore.person(profileId, me.id)).points;
                let bet = parseAmount(args[0], mine);
                if (bet != null && String(args[0]).toLowerCase() === 'all') bet = Math.min(bet, s.gamble.max);
                if (!bet || bet < s.gamble.min || bet > s.gamble.max) return { reply: `Bet ${formatPoints(s.gamble.min)} to ${formatPoints(s.gamble.max)} ${cur}, like this: !gamble 100` };
                if (bet > mine) return { reply: `${who}, you have ${formatPoints(mine)} ${cur}.` };
                const win = rng() * 100 < s.gamble.winChance;
                const r = await changePoints(profileId, me.id, win ? bet : -bet, { strict: true, kind: 'gamble', note: `${win ? 'Won' : 'Lost'} ${formatPoints(bet)} gambling`, actor: `chat:${ev?.user?.login || who}` });
                if (!r.ok) return { reply: `${who}, you have ${formatPoints(r.balance ?? mine)} ${cur}.` };
                return { reply: win ? `${who} won ${formatPoints(bet)} ${cur} and now has ${formatPoints(r.balance)}.` : `${who} lost ${formatPoints(bet)} ${cur} and now has ${formatPoints(r.balance)}.` };
            }
            case 'addpoints':
            case 'removepoints': {
                if (!isMod(ev)) return { reply: null, detail: 'moderators only' };
                const target = args[0] ? await findTarget(profileId, ev, args[0]) : null;
                if (!target) return { reply: args[0] ? `I have not seen ${args[0].replace(/^@/, '')} here yet.` : `Use it like this: !${command} @name 100` };
                const n = parseAmount(args[1], 0);
                if (!n) return { reply: `Use it like this: !${command} @name 100` };
                const add = command === 'addpoints';
                const r = await changePoints(profileId, target.id, add ? n : -n, { kind: 'edit', note: `${add ? 'Added' : 'Removed'} by ${who} in chat`, actor: `chat:${ev?.user?.login || who}` });
                if (!r.ok) return { reply: 'That did not work.' };
                return { reply: `${nameOf(target)} now has ${formatPoints(r.balance)} ${cur}.` };
            }
            default:
                return { reply: null, detail: `unknown command ${command}` };
        }
    }

    // ── template values and conditions ──
    const VAR_RE = /\{(user\.(points|watchtime|messages|rank)|points\.name)\}/i;
    async function templateValues({ ev, profileId, template = '' } = {}) {
        if (!VAR_RE.test(String(template))) return {};
        const out = { 'user.points': '0', 'user.watchtime': '0m', 'user.messages': '0', 'user.rank': '', 'points.name': 'points' };
        if (!profileId || !(await vstore.available())) return out;
        const s = await settingsFor(profileId);
        out['points.name'] = s.currency;
        if (!ev?.user?.id || !isViewerPlatform(ev.platform)) return out;
        const row = await vstore.byAccount(profileId, ev.platform, ev.user.id);
        if (!row) return out;
        const person = await vstore.person(profileId, row.id);
        out['user.points'] = formatPoints(noRewards(ev.platform) ? 0 : person.points);   // no points on YouTube
        out['user.watchtime'] = formatWatch(person.totals.watchMinutes);
        out['user.messages'] = formatPoints(person.totals.messages);
        out['user.rank'] = rankFor(s, { watchMinutes: person.totals.watchMinutes, points: person.points })?.name || '';
        return out;
    }
    async function conditionData({ ev, profileId } = {}) {
        const zero = { found: false, points: 0, watchMinutes: 0, messages: 0 };
        if (!profileId || !ev?.user?.id || !isViewerPlatform(ev.platform) || !(await vstore.available())) return zero;
        const row = await vstore.byAccount(profileId, ev.platform, ev.user.id);
        if (!row) return zero;
        const person = await vstore.person(profileId, row.id);
        return { found: true, points: noRewards(ev.platform) ? 0 : person.points, watchMinutes: person.totals.watchMinutes, messages: person.totals.messages };
    }

    return {
        onEvent, tick, sampleProfile, settingsFor, saveSettings, changePoints, templateValues, conditionData, ensureViewer, findTarget,
        status: (profileId) => lastSample.get(Number(profileId)) || null,
        currencyCommand: async (profileId) => currencyCommand(await settingsFor(profileId)),
        commands: { run },
        start() {
            if (timer) return;
            first = setTimeout(() => { tick().catch((err) => log('warn', 'sample failed', { error: err?.message })); }, 60_000);
            timer = setInterval(() => { tick().catch((err) => log('warn', 'sample failed', { error: err?.message })); }, sampleMs);
            first.unref?.();
            timer.unref?.();
        },
        stop() { clearInterval(timer); clearTimeout(first); timer = null; first = null; },
        _active: active,
    };
}

export default { createViewerService, parseAmount, ACTIVE_MINUTES, CHATTERS_SCOPE };
