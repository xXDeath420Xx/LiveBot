/*
 * Stream bot loyalty store (W2.10; design §15): viewers spend loyalty points on items the streamer sets up (a song of
 * their choice, a hydrate reminder, a sound). Replaces the Streamlabs / StreamElements loyalty stores.
 *
 *   createShop({ cstore, store, viewersRef, engineRef, ingest, now })
 *     validateItem(input, { automationIds }) → { ok, errors, value }
 *     run(profile, command, { ev, input, ctx }) → { reply, detail }      !store (the list) and !redeem <item>
 *     redeem(profile, ev, item, { ctx }) → { ok, reply, redemptionId }
 *     refund(profile, redemptionId, by) → { ok, error }
 *
 * Redeeming, in this order: the item is on and off cooldown; the viewer's limit (per day or ever) is not reached; one is
 * taken from the stock with a conditional UPDATE (two people cannot both take the last one); the points are taken with
 * the viewer service's changePoints({ strict: true }), a locked read in a transaction (so a balance never goes below 0);
 * if that fails, the stock goes back. Then the item's automation runs (even while switched off, so it needs no trigger of
 * its own) and the "Loyalty store: item redeemed" trigger fires.
 *
 * Points are a free channel tally. Nothing in the store is bought with money and CertiFried handles no payment.
 * Twitch and Kick only: YouTube chat is told the store is not offered there (YouTube API policy III.F.3.c, youtube/policy.js).
 */
import { formatPoints } from '../viewers/settings.js';
import { STORE_LIMITS } from './store.js';
import { POINTS_PLATFORMS, noRewards, YT_POINTS_REPLY } from '../youtube/policy.js';

export const STORE_COMMANDS = Object.freeze([
    { key: 'list', label: 'What is in the store (!store)' },
    { key: 'redeem', label: 'Redeem an item (!redeem hydrate)' },
]);
export const LIMIT_WINDOWS = Object.freeze(['day', 'ever']);
export const LIMIT_WINDOW_LABEL = Object.freeze({ day: 'in 24 hours', ever: 'ever' });
const VIEWER_PLATFORMS = POINTS_PLATFORMS;

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const intOrNull = (v, lo, hi) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
};
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function validateItem(input = {}, { automationIds = null } = {}) {
    const errors = [];
    const name = clean(input.name, STORE_LIMITS.name);
    if (!name) errors.push('Enter a name.');
    else if (!norm(name)) errors.push('The name needs at least one letter or number.');
    const costRaw = Number(input.cost);
    if (input.cost === '' || input.cost == null || !Number.isFinite(costRaw) || costRaw < 0) errors.push('Enter the cost: a whole number of points, 0 or more.');
    const automationId = intOrNull(input.automationId, 1, Number.MAX_SAFE_INTEGER);
    if (automationId && automationIds && !automationIds.has(automationId)) errors.push('Pick one of your automations, or none.');
    const value = {
        name, description: clean(input.description, STORE_LIMITS.description), cost: Number.isFinite(costRaw) ? Math.min(1_000_000_000, Math.max(0, Math.round(costRaw))) : 0,
        stock: intOrNull(input.stock, 0, 1_000_000), perUserLimit: intOrNull(input.perUserLimit, 1, 1000),
        limitWindow: LIMIT_WINDOWS.includes(input.limitWindow) ? input.limitWindow : 'day', cooldownSec: intOrNull(input.cooldownSec, 0, 86_400) || 0,
        automationId, enabled: input.enabled === undefined ? true : input.enabled === true || input.enabled === 'true' || input.enabled === 'on' || input.enabled === 1,
        sortOrder: intOrNull(input.sortOrder, -1000, 1000) || 0,
    };
    return { ok: !errors.length, errors, value };
}

/** The item a viewer typed: its number on the !store list, its exact name, or the only name that starts with it. */
export function pickItem(items, text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (/^\d{1,3}$/.test(t)) return items[Number(t) - 1] || null;
    const want = norm(t);
    if (!want) return null;
    const exact = items.find((i) => norm(i.name) === want);
    if (exact) return exact;
    const starts = items.filter((i) => norm(i.name).startsWith(want));
    return starts.length === 1 ? starts[0] : null;
}

export function createShop({ cstore, store, viewersRef, engineRef = null, ingest = null, now = () => Date.now(), logger = null } = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotStore] ${msg}`, meta); } catch { /* ignore */ } };
    const svc = () => viewersRef?.current?.service || null;
    const vst = () => viewersRef?.current?.vstore || null;
    async function currency(pid) { try { return (await svc().settingsFor(pid)).currency || 'points'; } catch { return 'points'; } }

    async function runItemAutomation(profile, item, ev, ctx) {
        if (!item.automationId || !engineRef?.current) return null;
        const a = await store.getAutomation(profile.id, item.automationId).catch(() => null);
        if (!a) return { status: 'failed', detail: 'the item\'s automation no longer exists' };
        // An automation that is on and triggered by "item redeemed" runs from that event instead (no double run).
        if (a.enabled && a.trigger_type === 'store.redeemed') return { status: 'ok', detail: `${a.name} runs from the redeemed trigger` };
        if (ctx?.chain?.includes(a.id)) return { status: 'failed', detail: 'loop stopped: that automation is already running in this chain' };
        const run = await engineRef.current.runAutomation(profile, a, ev, {
            source: 'store', manual: true, eventId: ctx?.eventId ?? null, parentRunId: ctx?.runId ?? null, depth: ctx ? ctx.depth + 1 : 0, chain: ctx?.chain || [],
            vars: { ...(ctx?.vars || {}), 'args.item': item.name, 'args.cost': String(item.cost) },
        });
        return { status: run.status, detail: `ran ${a.name} (run ${run.runId}: ${run.status})` };
    }

    async function redeem(profile, ev, item, { ctx = null } = {}) {
        const pid = profile.id;
        const cur = await currency(pid);
        const who = ev?.user?.name || ev?.user?.login || 'You';
        if (!item.enabled) return { ok: false, reply: `${item.name} is not available right now.` };
        if (item.cooldownSec && item.lastRedeemedAt && new Date(item.lastRedeemedAt).getTime() + item.cooldownSec * 1000 > now()) {
            const left = Math.ceil((new Date(item.lastRedeemedAt).getTime() + item.cooldownSec * 1000 - now()) / 1000);
            return { ok: false, reply: `${item.name} can be redeemed again in ${left >= 120 ? `${Math.ceil(left / 60)} min` : `${left} seconds`}.` };
        }
        const row = await svc().ensureViewer(pid, ev);
        if (!row) return { ok: false, reply: null, detail: 'no viewer for this event' };
        if (item.perUserLimit) {
            const since = item.limitWindow === 'ever' ? null : new Date(now() - 86_400_000);
            const n = await cstore.countRedemptions(pid, item.id, ev.platform, ev.user.id, since);
            if (n >= item.perUserLimit) return { ok: false, reply: `${who}, you have redeemed ${item.name} the most times allowed${item.limitWindow === 'ever' ? '' : ' today'}.` };
        }
        const bal = (await vst().person(pid, row.id))?.points || 0;
        if (bal < item.cost) return { ok: false, reply: `${who}, ${item.name} costs ${formatPoints(item.cost)} ${cur} and you have ${formatPoints(bal)}.` };
        if (!(await cstore.takeStock(pid, item.id))) return { ok: false, reply: `${item.name} is sold out.` };
        if (item.cost) {
            const r = await svc().changePoints(pid, row.id, -item.cost, { strict: true, kind: 'store', note: `Store: ${item.name}`, actor: `chat:${ev.user.login || ''}`.slice(0, 100) });
            if (!r.ok) {
                await cstore.returnStock(pid, item.id);
                return { ok: false, reply: `${who}, ${item.name} costs ${formatPoints(item.cost)} ${cur} and you have ${formatPoints(r.balance ?? bal)}.` };
            }
        }
        const redemptionId = await cstore.addRedemption(pid, { itemId: item.id, itemName: item.name, platform: ev.platform, platformUserId: ev.user.id, viewerId: row.personId || row.id, viewerName: who, cost: item.cost });
        const ran = await runItemAutomation(profile, item, ev, ctx).catch((err) => { log('warn', 'item automation failed', { error: err?.message }); return { status: 'failed', detail: err?.message }; });
        try {
            await ingest?.internal?.(pid, {
                platform: 'bot', type: 'store.redeemed', channelId: ev.channelId || null, user: ev.user ? { ...ev.user } : null, amount: item.cost, currency: 'points',
                message: item.name, metadata: { item: item.name, itemId: item.id, cost: item.cost, redemptionId, viewerPlatform: ev.platform }, raw: null, occurredAt: new Date(now()), dedupeKey: null,
            });
        } catch (err) { log('warn', 'redeemed event failed', { error: err?.message }); }
        return { ok: true, redemptionId, ran, reply: `${who} redeemed ${item.name}${item.cost ? ` for ${formatPoints(item.cost)} ${cur}` : ''}.` };
    }

    async function refund(profile, redemptionId, by = 'the streamer') {
        const pid = profile.id;
        const r = await cstore.getRedemption(pid, redemptionId);
        if (!r) return { ok: false, error: 'That redemption does not exist.' };
        if (r.status !== 'done') return { ok: false, error: 'It was already refunded.' };
        if (!(await cstore.markRefunded(pid, r.id, `Refunded by ${by}`))) return { ok: false, error: 'It was already refunded.' };
        if (r.cost && r.viewerId) {
            const c = await svc()?.changePoints(pid, r.viewerId, r.cost, { kind: 'store', note: `Refund: ${r.itemName}`, actor: String(by).slice(0, 100) }).catch(() => null);
            if (!c?.ok) return { ok: true, note: 'Marked refunded, but the viewer record is gone, so no points went back.' };
        }
        if (r.itemId) await cstore.returnStock(pid, r.itemId);
        return { ok: true };
    }

    async function run(profile, command, { ev, input = '', ctx = null } = {}) {
        const pid = profile.id;
        if (noRewards(ev?.platform)) return { reply: YT_POINTS_REPLY, detail: 'the store is Twitch and Kick only' };
        if (!(await cstore.available())) return { reply: null, detail: 'the store starts after the next CertiFried update' };
        const items = await cstore.listItems(pid, { enabledOnly: true });
        const cur = await currency(pid);
        if (command === 'list') {
            if (!items.length) return { reply: 'The store is empty right now.' };
            const line = items.slice(0, 15).map((i, n) => `${n + 1}. ${i.name} (${formatPoints(i.cost)})`).join(', ');
            return { reply: `Store (${cur}): ${line}. Redeem with !redeem <name or number>.`.slice(0, 480) };
        }
        if (command === 'redeem') {
            if (!ev?.user?.id || !VIEWER_PLATFORMS.includes(ev.platform)) return { reply: null, detail: 'no Twitch or Kick viewer for this event' };
            if (!svc() || !vst() || !(await vst().available())) return { reply: null, detail: 'viewer points start after the next CertiFried update' };
            if (!items.length) return { reply: 'The store is empty right now.' };
            const item = pickItem(items, input);
            if (!item) return { reply: String(input || '').trim() ? `There is no "${String(input).trim().slice(0, 40)}" in the store. Type !store to see what there is.` : 'Use it like this: !redeem <name or number>. Type !store to see what there is.' };
            const r = await redeem(profile, ev, item, { ctx });
            return { reply: r.reply, detail: r.ran ? r.ran.detail : r.detail };
        }
        return { reply: null, detail: `unknown command ${command}` };
    }

    return { run, redeem, refund, validateItem, pickItem };
}

export default { createShop, validateItem, pickItem, STORE_COMMANDS, LIMIT_WINDOWS, LIMIT_WINDOW_LABEL };
