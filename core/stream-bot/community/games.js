/*
 * Stream bot chat games on loyalty points (W2.9; design §15): slots, duels, heists, the viewer line-up and raffles with
 * tickets. Replaces the StreamElements / Streamlabs / Firebot minigames, viewer queue and point raffles.
 *
 *   createGames({ store, viewersRef, io, logger, now, rng, timers })
 *     run(profile, command, { ev, input }) → { reply, detail }      the chat commands (GAME_COMMANDS)
 *     settingsOf(profileId) / saveSettings(profileId, value)        Community, Chat games (profile settings key `games`)
 *     lineup: state(profileId), setOpen(profile, open), next(profile, n), clear(profile), remove(profile, index)
 *     raffle: status(profileId), open(profile, opts, by), draw(profile, by), cancel(profile, by)
 *     heistStatus(profileId)
 *
 * Points move only through the viewer service's changePoints() (core/stream-bot/viewers), so rank-ups and the history work
 * as for every other change. Bets are checked when made and settled when the game ends: a heist, duel or raffle cut off by
 * a restart charges nobody. Points are a free channel tally; nothing here involves money.
 *
 * The line-up (who plays with the streamer next) is kept in the profile settings under `viewerQueue`, so it survives a
 * restart. Duels, heists and raffles are short and live in memory.
 * Every game is off until the streamer turns it on; the line-up is closed until a moderator opens it.
 */
import { gamesWithDefaults, spin, slotsResult, slotsNet, heistOutcome, drawRaffle, HEIST_LABEL } from './settings.js';
import { formatPoints } from '../viewers/settings.js';
import { replyInEventChat } from '../music/register.js';
import { POINTS_PLATFORMS, noRewards, YT_POINTS_REPLY } from '../youtube/policy.js';

export const GAME_COMMANDS = Object.freeze([
    { key: 'slots', label: 'Slots (!slots 100)' },
    { key: 'duel', label: 'Challenge to a duel (!duel @name 100)' },
    { key: 'accept', label: 'Accept a duel (!accept)' },
    { key: 'decline', label: 'Decline a duel (!decline)' },
    { key: 'heist', label: 'Start or join a heist (!heist 100)' },
    { key: 'join', label: 'Join the line-up (!join)' },
    { key: 'leave', label: 'Leave the line-up (!leave)' },
    { key: 'lineup', label: 'The line-up; moderators: open, close, next, clear (!lineup)' },
    { key: 'ticket', label: 'Buy raffle tickets (!ticket 3)' },
    { key: 'raffle', label: 'The raffle; moderators: open, draw, cancel (!raffle)' },
]);
export const GAME_KEYS = Object.freeze(GAME_COMMANDS.map((c) => c.key));
const VIEWER_PLATFORMS = POINTS_PLATFORMS;            // points games and raffles (YouTube API policy III.F.3.c)
const LINEUP_PLATFORMS = ['twitch', 'kick', 'youtube']; // the line-up costs nothing, so YouTube may join it
const isMod = (ev) => (ev?.user?.roles || []).some((r) => r === 'broadcaster' || r === 'moderator');
const SETTINGS_CACHE_MS = 15_000;

export function createGames({ store, viewersRef, io = null, logger = null, now = () => Date.now(), rng = Math.random, timers = true } = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotGames] ${msg}`, meta); } catch { /* ignore */ } };
    const cache = new Map();
    const duels = new Map();     // `${pid}:${platform}:${targetUserId}` → duel
    const heists = new Map();    // pid → { entries: Map, platforms: Set, endsAt, timer, target }
    const cooldowns = new Map(); // pid → heist cooldown until
    const raffles = new Map();   // pid → { cost, winners, maxTickets, entries: Map, timer, openedAt }

    async function settingsOf(profileId) {
        const hit = cache.get(Number(profileId));
        if (hit && now() - hit.at < SETTINGS_CACHE_MS) return hit.value;
        const value = gamesWithDefaults(await store.getSettingsKey(profileId, 'games').catch(() => null));
        cache.set(Number(profileId), { at: now(), value });
        return value;
    }
    async function saveSettings(profileId, value) {
        await store.setSettingsKey(profileId, 'games', gamesWithDefaults(value));
        cache.delete(Number(profileId));
    }

    // ── points ──
    const svc = () => viewersRef?.current?.service || null;
    const vst = () => viewersRef?.current?.vstore || null;
    async function ready() { const v = vst(); return !!(svc() && v && await v.available()); }
    async function currency(pid) { try { return (await svc().settingsFor(pid)).currency || 'points'; } catch { return 'points'; } }
    async function me(pid, ev) {
        if (!ev?.user?.id || !VIEWER_PLATFORMS.includes(ev.platform)) return null;
        return svc().ensureViewer(pid, ev);
    }
    async function balance(pid, row) { return (await vst().person(pid, row.id))?.points || 0; }
    async function change(pid, row, delta, kind, note, actor, strict = false) {
        if (!delta) return { ok: true, balance: await balance(pid, row) };
        return svc().changePoints(pid, row.id, delta, { strict, kind, note: String(note).slice(0, 200), actor: String(actor || 'stream bot').slice(0, 100) });
    }
    const nameOf = (row, ev) => ev?.user?.name || row?.name || row?.login || 'someone';
    const amountOf = (text, bal) => {
        const t = String(text ?? '').trim().toLowerCase().replace(/,/g, '');
        if (t === 'all') return Math.max(0, Math.floor(bal));
        return /^\d{1,12}$/.test(t) ? Number(t) : null;
    };

    async function say(profileId, platform, text) {
        if (!io) return;
        try { await replyInEventChat(io, profileId, { platform }, text); } catch (err) { log('warn', 'chat failed', { error: err?.message }); }
    }
    async function announce(profileId, platforms, text) {
        for (const p of platforms && platforms.size ? platforms : new Set(['twitch'])) await say(profileId, p, text);
    }

    // ── slots ──
    async function slots(pid, s, ev, args, cur) {
        if (!s.slots.enabled) return { reply: 'Slots are turned off on this channel.' };
        const row = await me(pid, ev);
        if (!row) return { reply: null, detail: 'no viewer for this event' };
        const bal = await balance(pid, row);
        let bet = amountOf(args[0], bal);
        if (bet != null && String(args[0]).toLowerCase() === 'all') bet = Math.min(bet, s.slots.max);
        if (!bet || bet < s.slots.min || bet > s.slots.max) return { reply: `Bet ${formatPoints(s.slots.min)} to ${formatPoints(s.slots.max)} ${cur}, like this: !slots 100` };
        if (bet > bal) return { reply: `${nameOf(row, ev)}, you have ${formatPoints(bal)} ${cur}.` };
        const reels = spin(s.slots.symbols, rng);
        const res = slotsResult(reels, s);
        const net = slotsNet(bet, res.multiplier);
        const r = await change(pid, row, net, 'slots', `Slots: ${reels.join(' ')} (${net >= 0 ? '+' : ''}${net})`, `chat:${ev.user.login || ''}`, net < 0);
        if (!r.ok) return { reply: `${nameOf(row, ev)}, you have ${formatPoints(r.balance ?? bal)} ${cur}.` };
        const line = reels.join(' | ');
        if (net > 0) return { reply: `${nameOf(row, ev)} spun ${line} and won ${formatPoints(net)} ${cur} (now ${formatPoints(r.balance)}).` };
        if (net === 0) return { reply: `${nameOf(row, ev)} spun ${line} and got their ${formatPoints(bet)} ${cur} back.` };
        return { reply: `${nameOf(row, ev)} spun ${line} and lost ${formatPoints(bet)} ${cur} (now ${formatPoints(r.balance)}).` };
    }

    // ── duels ──
    function sweepDuels() { for (const [k, d] of duels) if (d.until <= now()) duels.delete(k); }
    async function duel(pid, s, ev, args, cur) {
        if (!s.duel.enabled) return { reply: 'Duels are turned off on this channel.' };
        sweepDuels();
        const row = await me(pid, ev);
        if (!row) return { reply: null, detail: 'no viewer for this event' };
        const targetName = String(args[0] || '').replace(/^@/, '');
        if (!targetName) return { reply: 'Use it like this: !duel @name 100' };
        const target = await svc().findTarget(pid, ev, targetName);
        if (!target || target.platform !== ev.platform) return { reply: `I have not seen ${targetName.slice(0, 25)} here yet.` };
        if (String(target.platformUserId) === String(ev.user.id) || (target.personId || target.id) === (row.personId || row.id)) return { reply: 'You cannot duel yourself.' };
        const bal = await balance(pid, row);
        const bet = amountOf(args[1], bal);
        if (!bet || bet < s.duel.min || bet > s.duel.max) return { reply: `Bet ${formatPoints(s.duel.min)} to ${formatPoints(s.duel.max)} ${cur}, like this: !duel @name 100` };
        if (bet > bal) return { reply: `${nameOf(row, ev)}, you have ${formatPoints(bal)} ${cur}.` };
        const key = `${pid}:${ev.platform}:${target.platformUserId}`;
        if (duels.has(key)) return { reply: `${target.name} already has a duel waiting.` };
        duels.set(key, { from: row, fromName: nameOf(row, ev), fromUserId: String(ev.user.id), to: target, bet, until: now() + s.duel.expirySec * 1000 });
        return { reply: `${target.name}, ${nameOf(row, ev)} challenges you to a duel for ${formatPoints(bet)} ${cur}. Type !accept within ${s.duel.expirySec} seconds, or !decline.` };
    }
    async function answerDuel(pid, s, ev, accept, cur) {
        sweepDuels();
        if (!ev?.user?.id) return { reply: null, detail: 'no viewer for this event' };
        const key = `${pid}:${ev.platform}:${ev.user.id}`;
        const d = duels.get(key);
        if (!d) return { reply: null, detail: 'no duel waiting' };
        duels.delete(key);
        const who = ev.user.name || d.to.name;
        if (!accept) return { reply: `${who} declined the duel with ${d.fromName}.` };
        if (!s.duel.enabled) return { reply: 'Duels are turned off on this channel.' };
        const [a, b] = [await balance(pid, d.from), await balance(pid, d.to)];
        if (a < d.bet) return { reply: `${d.fromName} no longer has ${formatPoints(d.bet)} ${cur}, so the duel is off.` };
        if (b < d.bet) return { reply: `${who}, you need ${formatPoints(d.bet)} ${cur} to accept.` };
        const fromWins = rng() < 0.5;
        const [winner, loser, wName, lName] = fromWins ? [d.from, d.to, d.fromName, who] : [d.to, d.from, who, d.fromName];
        const took = await change(pid, loser, -d.bet, 'duel', `Lost a duel to ${wName}`, 'duel', true);
        if (!took.ok) return { reply: `${lName} no longer has the ${cur}, so the duel is off.` };
        await change(pid, winner, d.bet, 'duel', `Won a duel against ${lName}`, 'duel');
        return { reply: `${wName} won the duel against ${lName} and takes ${formatPoints(d.bet)} ${cur}.` };
    }

    // ── heists ──
    async function finishHeist(pid) {
        const h = heists.get(pid);
        if (!h) return null;
        heists.delete(pid);
        clearTimeout(h.timer);
        const s = await settingsOf(pid);
        cooldowns.set(pid, now() + s.heist.cooldownMin * 60_000);
        const cur = await currency(pid);
        const list = [...h.entries.values()];
        const out = heistOutcome(list.map((e) => ({ key: e.key, bet: e.bet })), { heist: { target: h.target } }, rng);
        const got = []; const caught = [];
        for (const r of out.results) {
            const e = h.entries.get(r.key);
            const c = await change(pid, e.row, r.net, 'heist', `Heist on the ${out.target}: ${r.escaped ? 'escaped' : 'caught'} (${r.net >= 0 ? '+' : ''}${r.net})`, 'heist').catch(() => null);
            if (!c?.ok) continue;
            (r.escaped ? got : caught).push(`${e.name} (${r.net >= 0 ? '+' : ''}${formatPoints(r.net)})`);
        }
        const text = got.length
            ? `The heist on the ${out.target} is over: ${got.length} of ${list.length} got away. ${got.join(', ')}.${caught.length ? ` Caught: ${caught.join(', ')}.` : ''}`
            : `The heist on the ${out.target} failed: everyone was caught and lost their ${cur}.`;
        await announce(pid, h.platforms, text.slice(0, 480));
        return { text, results: out.results };
    }
    async function heist(pid, s, ev, args, cur) {
        if (!s.heist.enabled) return { reply: 'Heists are turned off on this channel.' };
        const row = await me(pid, ev);
        if (!row) return { reply: null, detail: 'no viewer for this event' };
        const bal = await balance(pid, row);
        let bet = amountOf(args[0], bal);
        if (bet != null && String(args[0]).toLowerCase() === 'all') bet = Math.min(bet, s.heist.max);
        if (!bet || bet < s.heist.min || bet > s.heist.max) return { reply: `Bet ${formatPoints(s.heist.min)} to ${formatPoints(s.heist.max)} ${cur}, like this: !heist 100` };
        if (bet > bal) return { reply: `${nameOf(row, ev)}, you have ${formatPoints(bal)} ${cur}.` };
        const key = String(row.personId || row.id);
        let h = heists.get(pid);
        if (!h) {
            const until = cooldowns.get(pid) || 0;
            if (until > now()) return { reply: `The crew is lying low. The next heist can start in ${Math.ceil((until - now()) / 60_000)} min.` };
            h = { entries: new Map(), platforms: new Set(), endsAt: now() + s.heist.joinSec * 1000, target: s.heist.target, timer: null };
            heists.set(pid, h);
            if (timers) { h.timer = setTimeout(() => { finishHeist(pid).catch((err) => log('warn', 'heist failed', { error: err?.message })); }, s.heist.joinSec * 1000); h.timer.unref?.(); }
            h.entries.set(key, { key, row, name: nameOf(row, ev), bet });
            h.platforms.add(ev.platform);
            return { reply: `${nameOf(row, ev)} is planning a heist on the ${HEIST_LABEL[h.target]}. Join with !heist <amount> in the next ${s.heist.joinSec} seconds.` };
        }
        if (h.entries.has(key)) return { reply: `${nameOf(row, ev)}, you are already in this heist.` };
        h.entries.set(key, { key, row, name: nameOf(row, ev), bet });
        h.platforms.add(ev.platform);
        return { reply: `${nameOf(row, ev)} joined the heist with ${formatPoints(bet)} ${cur} (${h.entries.size} in the crew).` };
    }

    // ── the line-up ──
    async function lineupRaw(pid) {
        const v = await store.getSettingsKey(pid, 'viewerQueue').catch(() => null);
        return { open: !!v?.open, list: Array.isArray(v?.list) ? v.list.slice(0, 500) : [] };
    }
    async function lineupSave(pid, v) { await store.setSettingsKey(pid, 'viewerQueue', { open: !!v.open, list: v.list.slice(0, 500) }); }
    const lineupLabel = (e) => `${e.name}${e.platform !== 'twitch' ? ` (${e.platform === 'kick' ? 'Kick' : 'YouTube'})` : ''}`;
    async function lineupCmd(pid, s, ev, args) {
        const sub = String(args[0] || '').toLowerCase();
        const lu = await lineupRaw(pid);
        if (['open', 'close', 'clear', 'next', 'remove'].includes(sub)) {
            if (!isMod(ev)) return { reply: null, detail: 'moderators only' };
            if (sub === 'open' || sub === 'close') { lu.open = sub === 'open'; await lineupSave(pid, lu); return { reply: sub === 'open' ? 'The line-up is open: type !join to get in.' : 'The line-up is closed.' }; }
            if (sub === 'clear') { await lineupSave(pid, { ...lu, list: [] }); return { reply: 'The line-up is empty now.' }; }
            if (sub === 'next') { const r = await takeNext(pid, Math.min(10, Math.max(1, Number(args[1]) || 1))); return { reply: r.taken.length ? `Up next: ${r.taken.map(lineupLabel).join(', ')}.` : 'Nobody is in the line-up.' }; }
            const who = String(args[1] || '').replace(/^@/, '').toLowerCase();
            const i = lu.list.findIndex((e) => e.login === who);
            if (i < 0) return { reply: `${who || 'They'} ${who ? 'is' : 'are'} not in the line-up.` };
            const [gone] = lu.list.splice(i, 1);
            await lineupSave(pid, lu);
            return { reply: `Took ${gone.name} out of the line-up.` };
        }
        if (!lu.list.length) return { reply: lu.open ? 'The line-up is open and empty: type !join to get in.' : 'The line-up is closed.' };
        const mine = ev?.user?.id ? lu.list.findIndex((e) => e.platform === ev.platform && e.id === String(ev.user.id)) : -1;
        const head = lu.list.slice(0, 5).map((e, i) => `${i + 1}. ${lineupLabel(e)}`).join(', ');
        return { reply: `Line-up (${lu.list.length}): ${head}${lu.list.length > 5 ? ', …' : ''}.${mine >= 0 ? ` You are #${mine + 1}.` : ''}` };
    }
    async function join(pid, s, ev) {
        if (!ev?.user?.id || !LINEUP_PLATFORMS.includes(ev.platform)) return { reply: null, detail: 'no viewer for this event' };
        const lu = await lineupRaw(pid);
        const name = ev.user.name || ev.user.login;
        const i = lu.list.findIndex((e) => e.platform === ev.platform && e.id === String(ev.user.id));
        if (i >= 0) return { reply: `${name}, you are #${i + 1} in the line-up.` };
        if (!lu.open) return { reply: 'The line-up is closed.' };
        if (lu.list.length >= s.lineup.max) return { reply: `The line-up is full (${s.lineup.max}).` };
        // Members do not go first on YouTube: that would reward a YouTube membership (III.F.3.c).
        const sub = !noRewards(ev.platform) && (ev.user.roles || []).includes('subscriber');
        const entry = { platform: ev.platform, id: String(ev.user.id), login: String(ev.user.login || '').toLowerCase(), name, sub, at: new Date(now()).toISOString() };
        let at = lu.list.length;
        if (s.lineup.subsFirst && sub) { at = lu.list.findIndex((e) => !e.sub); if (at < 0) at = lu.list.length; }
        lu.list.splice(at, 0, entry);
        await lineupSave(pid, lu);
        return { reply: `${name} joined the line-up at #${at + 1}.` };
    }
    async function leave(pid, s, ev) {
        if (!ev?.user?.id) return { reply: null, detail: 'no viewer for this event' };
        const lu = await lineupRaw(pid);
        const i = lu.list.findIndex((e) => e.platform === ev.platform && e.id === String(ev.user.id));
        if (i < 0) return { reply: null, detail: 'not in the line-up' };
        lu.list.splice(i, 1);
        await lineupSave(pid, lu);
        return { reply: `${ev.user.name || ev.user.login} left the line-up.` };
    }
    async function takeNext(pid, n = 1) {
        const lu = await lineupRaw(pid);
        const taken = lu.list.splice(0, Math.max(1, n));
        await lineupSave(pid, lu);
        return { taken, left: lu.list.length };
    }

    // ── raffles ──
    async function raffleOpen(profile, { cost, winners, maxTickets, autoDrawSec } = {}, by = 'a moderator') {
        const pid = profile.id;
        if (raffles.has(pid)) return { ok: false, error: 'A raffle is already open.' };
        const s = await settingsOf(pid);
        const r = {
            cost: Number.isFinite(Number(cost)) && cost !== '' && cost != null ? Math.max(0, Math.round(Number(cost))) : s.raffle.ticketCost,
            winners: Number.isFinite(Number(winners)) && winners ? Math.min(20, Math.max(1, Math.round(Number(winners)))) : s.raffle.winners,
            maxTickets: Number.isFinite(Number(maxTickets)) && maxTickets ? Math.min(1000, Math.max(1, Math.round(Number(maxTickets)))) : s.raffle.maxTickets,
            entries: new Map(), platforms: new Set(), timer: null, openedAt: now(), openedBy: String(by).slice(0, 100),
        };
        const auto = autoDrawSec != null && autoDrawSec !== '' ? Math.min(3600, Math.max(0, Math.round(Number(autoDrawSec) || 0))) : s.raffle.autoDrawSec;
        raffles.set(pid, r);
        if (auto && timers) { r.timer = setTimeout(() => { raffleDraw(profile, 'the timer').catch((err) => log('warn', 'raffle draw failed', { error: err?.message })); }, auto * 1000); r.timer.unref?.(); }
        const cur = await currency(pid);
        const text = `A raffle is open: ${r.cost ? `${formatPoints(r.cost)} ${cur} a ticket` : 'tickets are free'}, up to ${r.maxTickets} each, ${r.winners} winner${r.winners === 1 ? '' : 's'}. Type !ticket or !ticket 3.${r.cost ? ' Tickets are paid when the winners are drawn.' : ''}${auto ? ` Drawn in ${auto >= 120 ? `${Math.round(auto / 60)} min` : `${auto} seconds`}.` : ''}`;
        return { ok: true, text };
    }
    async function raffleDraw(profile, by = 'a moderator') {
        const pid = profile.id;
        const r = raffles.get(pid);
        if (!r) return { ok: false, error: 'No raffle is open.' };
        raffles.delete(pid);
        clearTimeout(r.timer);
        const cur = await currency(pid);
        const paid = [];
        for (const e of r.entries.values()) {
            const cost = r.cost * e.tickets;
            if (cost) {
                const c = await change(pid, e.row, -cost, 'raffle', `${e.tickets} raffle ticket${e.tickets === 1 ? '' : 's'}`, `raffle (${by})`, true).catch(() => null);
                if (!c?.ok) continue;
            }
            paid.push(e);
        }
        const won = drawRaffle(paid.map((e) => ({ key: e.key, tickets: e.tickets, name: e.name })), r.winners, rng);
        const text = !r.entries.size ? 'The raffle closed with no entries.'
            : !won.length ? `Nobody in the raffle had enough ${cur} for their tickets, so there is no winner.`
                : `Raffle winner${won.length === 1 ? '' : 's'}: ${won.map((w) => w.name).join(', ')}. ${paid.length} ${paid.length === 1 ? 'person' : 'people'} took part.`;
        await announce(pid, r.platforms, text);
        return { ok: true, text, winners: won.map((w) => w.name), entries: paid.length };
    }
    async function raffleCancel(profile) {
        const r = raffles.get(profile.id);
        if (!r) return { ok: false, error: 'No raffle is open.' };
        raffles.delete(profile.id);
        clearTimeout(r.timer);
        return { ok: true, text: 'The raffle was cancelled. Nobody paid for their tickets.' };
    }
    function raffleStatus(profileId) {
        const r = raffles.get(Number(profileId));
        if (!r) return null;
        return { cost: r.cost, winners: r.winners, maxTickets: r.maxTickets, entries: r.entries.size, tickets: [...r.entries.values()].reduce((a, e) => a + e.tickets, 0),
            names: [...r.entries.values()].slice(0, 100).map((e) => ({ name: e.name, tickets: e.tickets })), openedAt: new Date(r.openedAt).toISOString() };
    }
    async function ticket(pid, profile, ev, args, cur) {
        const r = raffles.get(pid);
        if (!r) return { reply: 'No raffle is open right now.' };
        const row = await me(pid, ev);
        if (!row) return { reply: null, detail: 'no viewer for this event' };
        const want = args[0] ? Number(String(args[0]).replace(/,/g, '')) : 1;
        if (!Number.isInteger(want) || want < 1) return { reply: 'Use it like this: !ticket or !ticket 3' };
        const key = String(row.personId || row.id);
        const e = r.entries.get(key) || { key, row, name: nameOf(row, ev), tickets: 0 };
        const total = Math.min(r.maxTickets, e.tickets + want);
        if (total === e.tickets) return { reply: `${e.name}, you have the most tickets allowed (${r.maxTickets}).` };
        const bal = await balance(pid, row);
        if (r.cost * total > bal) return { reply: `${e.name}, ${total} ticket${total === 1 ? '' : 's'} cost ${formatPoints(r.cost * total)} ${cur} and you have ${formatPoints(bal)}.` };
        e.tickets = total;
        r.entries.set(key, e);
        r.platforms.add(ev.platform);
        return { reply: `${e.name} has ${total} ticket${total === 1 ? '' : 's'}${r.cost ? ` (${formatPoints(r.cost * total)} ${cur}, paid at the draw)` : ''}.` };
    }
    async function raffleCmd(pid, profile, ev, args, cur) {
        const sub = String(args[0] || '').toLowerCase();
        if (['open', 'start', 'draw', 'end', 'cancel'].includes(sub)) {
            if (!isMod(ev)) return { reply: null, detail: 'moderators only' };
            const by = ev?.user?.name || 'a moderator';
            if (sub === 'open' || sub === 'start') { const o = await raffleOpen(profile, { cost: args[1], winners: args[2] }, by); return { reply: o.ok ? o.text : o.error }; }
            if (sub === 'cancel') { const o = await raffleCancel(profile); return { reply: o.ok ? o.text : o.error }; }
            const o = await raffleDraw(profile, by);
            return o.ok ? { reply: null, detail: o.text } : { reply: o.error };   // the draw announces itself
        }
        const st = raffleStatus(pid);
        if (!st) return { reply: 'No raffle is open right now.' };
        return { reply: `The raffle is open: ${st.cost ? `${formatPoints(st.cost)} ${cur} a ticket` : 'free tickets'}, ${st.entries} ${st.entries === 1 ? 'person' : 'people'} with ${st.tickets} ticket${st.tickets === 1 ? '' : 's'}. Type !ticket to enter.` };
    }

    async function run(profile, command, { ev, input = '' } = {}) {
        const pid = profile.id;
        const args = String(input || '').trim().split(/\s+/).filter(Boolean);
        const s = await settingsOf(pid);
        if (['join', 'leave', 'lineup'].includes(command)) {
            if (command === 'join') return join(pid, s, ev);
            if (command === 'leave') return leave(pid, s, ev);
            return lineupCmd(pid, s, ev, args);
        }
        if (noRewards(ev?.platform)) return { reply: YT_POINTS_REPLY, detail: 'points games and raffles are Twitch and Kick only' };
        if (!(await ready())) return { reply: null, detail: 'viewer points start after the next CertiFried update' };
        const cur = await currency(pid);
        switch (command) {
            case 'slots': return slots(pid, s, ev, args, cur);
            case 'duel': return duel(pid, s, ev, args, cur);
            case 'accept': return answerDuel(pid, s, ev, true, cur);
            case 'decline': return answerDuel(pid, s, ev, false, cur);
            case 'heist': return heist(pid, s, ev, args, cur);
            case 'ticket': return ticket(pid, profile, ev, args, cur);
            case 'raffle': return raffleCmd(pid, profile, ev, args, cur);
            default: return { reply: null, detail: `unknown command ${command}` };
        }
    }

    return {
        run, settingsOf, saveSettings, finishHeist,
        heistStatus: (profileId) => { const h = heists.get(Number(profileId)); return h ? { target: HEIST_LABEL[h.target], crew: h.entries.size, endsAt: new Date(h.endsAt).toISOString() } : null; },
        lineup: {
            state: lineupRaw,
            async setOpen(profile, open) { const lu = await lineupRaw(profile.id); lu.open = !!open; await lineupSave(profile.id, lu); return lu; },
            next: (profile, n = 1) => takeNext(profile.id, n),
            async clear(profile) { const lu = await lineupRaw(profile.id); await lineupSave(profile.id, { ...lu, list: [] }); return true; },
            async remove(profile, index) { const lu = await lineupRaw(profile.id); const i = Number(index); if (!(i >= 0 && i < lu.list.length)) return false; lu.list.splice(i, 1); await lineupSave(profile.id, lu); return true; },
        },
        raffle: { status: raffleStatus, open: raffleOpen, draw: raffleDraw, cancel: raffleCancel },
        announce,
        close() { for (const h of heists.values()) clearTimeout(h.timer); for (const r of raffles.values()) clearTimeout(r.timer); heists.clear(); raffles.clear(); duels.clear(); },
        _state: { duels, heists, raffles, cooldowns },
    };
}

export default { createGames, GAME_COMMANDS, GAME_KEYS };
