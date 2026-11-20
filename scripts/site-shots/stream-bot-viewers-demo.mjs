/*
 * Stream bot Viewers pages (views/stream-bot/viewers.ejs, viewer.ejs, viewers-settings.ejs) filled with invented Maple Hollow
 * data, for the guide screenshots (scenes.mjs) and tests/stream-bot-viewers-page.test.js. Every name is made up. The locals are
 * built with the route's own view helpers (dashboard/services/stream-bot-viewers-view.js), so a page that renders here renders
 * the way the route renders it.
 *
 *   viewersDemo({ root }) → { list, viewer, settings, empty, notReady }   each { template, locals }
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function viewersDemo({ root }) {
    const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
    const [V, S] = await Promise.all([imp('dashboard/services/stream-bot-viewers-view.js'), imp('core/stream-bot/viewers/settings.js')]);
    const settings = S.withDefaults({
        currency: 'Leaves', earn: { minutes: 10, points: 10, subMultiplier: 1.5, follow: 50, sub: 250, giftPerSub: 100, bitsPer100: 10, raid: 100 },
        ranks: { basis: 'watch', list: [{ name: 'Seedling', min: 0 }, { name: 'Sapling', min: 600 }, { name: 'Oak', min: 3000 }, { name: 'Old growth', min: 12000 }] },
        gamble: { enabled: false, min: 10, max: 5000, winChance: 45 },
    });
    const D = (y, m, d, h = 12, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min));
    const raw = [
        ['twitch', '100000001', 'maplefan_88', 'MapleFan_88', 18420, 14075, 2310, D(2026, 11, 18, 21, 40), D(2025, 3, 2)],
        ['twitch', '100000002', 'wren_reads', 'Wren_Reads', 12890, 9120, 1480, D(2026, 11, 18, 21, 38), D(2025, 6, 14)],
        ['kick', '5550001', 'pip_kick', 'Pip', 9440, 6200, 3120, D(2026, 11, 17, 22, 5), D(2026, 1, 9)],
        ['twitch', '100000010', 'quiet_lurker', 'Quiet_Lurker', 7310, 7140, 12, D(2026, 11, 18, 21, 40), D(2025, 11, 30)],
        ['twitch', '100000011', 'thistle_and_tea', 'Thistle_and_Tea', 5120, 3480, 690, D(2026, 11, 16, 20, 12), D(2026, 4, 21)],
        ['kick', '5550002', 'hazelnut', 'Hazelnut', 2960, 2050, 410, D(2026, 11, 18, 20, 55), D(2026, 7, 3)],
        ['twitch', '100000012', 'fennel_fox', 'Fennel_Fox', 1880, 1210, 233, D(2026, 11, 12, 19, 2), D(2026, 9, 18)],
        ['twitch', '100000009', 'bramblebyte_live', 'BrambleByte_Live', 650, 45, 3, D(2026, 11, 18, 20, 2), D(2026, 11, 18, 20, 2)],
    ];
    const rows = raw.map(([platform, id, login, name, points, watch, msgs, last, first], i) => ({
        id: 40 + i, platform, platformUserId: id, login, name, points, shownPoints: points, watchMinutes: watch, messages: msgs,
        lastSeenAt: last, firstSeenAt: first, personId: null, tipAmounts: {},
    }));
    const f = V.listQuery({});
    const watch = {
        linked: [{ platform: 'twitch', login: 'maplehollow_tv' }, { platform: 'kick', login: 'maplehollow' }], twitch: true, kick: true, chatters: true, needsReapprove: false,
        sample: V.sampleLines({ channels: [{ platform: 'twitch', login: 'maplehollow_tv', live: true, source: 'chatters', counted: 214 }, { platform: 'kick', login: 'maplehollow', live: true, source: 'active', counted: 17 }] }),
        running: true,
    };
    const listLocals = {
        active: 'viewers', pageTitle: 'Viewers', ready: true, settings, filters: f, rows: rows.map((r) => V.rowView(r, settings)), total: 1223, pages: 25, count: 1223, watch,
        hrefs: { sort: Object.fromEntries(Object.keys(V.SORT_LABEL).map((k) => [k, V.listHref(f, { sort: k })])), prev: null, next: V.listHref(f, { page: 2 }) },
        seenChoices: V.SEEN_CHOICES, sortLabels: V.SORT_LABEL,
    };
    const person = {
        primary: { ...rows[0], personId: null },
        rows: [{ ...rows[0], importedFrom: 'firebot,streamerbot', followedAt: D(2025, 3, 2, 19, 4) }, { id: 61, platform: 'kick', platformUserId: '5550099', login: 'maplefan', name: 'maplefan', watchMinutes: 820, messages: 96, personId: 40, importedFrom: null, followedAt: null }],
        points: 18420,
        totals: { watchMinutes: 14895, messages: 2406, follows: 2, subs: 9, subMonths: 14, gifts: 3, giftedSubs: 15, cheers: 6, bits: 4200, raids: 0, raidViewers: 0, tips: 2, tipAmounts: { USD: 15 },
            firstSeenAt: D(2025, 3, 2), lastSeenAt: D(2026, 11, 18, 21, 40) },
    };
    const history = [
        { id: 905, kind: 'bonus', delta: 300, balance: 18420, note: 'Gift bonus (3 subs)', actor: 'stream bot', createdAt: D(2026, 11, 18, 21, 2) },
        { id: 902, kind: 'gamble', delta: -100, balance: 18120, note: 'Lost 100 gambling', actor: 'chat:maplefan_88', createdAt: D(2026, 11, 18, 20, 44) },
        { id: 897, kind: 'give', delta: -50, balance: 18220, note: 'MapleFan_88 gave 50 to Wren_Reads', actor: 'chat:maplefan_88', createdAt: D(2026, 11, 18, 20, 31) },
        { id: 880, kind: 'rank', delta: null, balance: null, note: 'Reached Old growth (was Oak)', actor: 'stream bot', createdAt: D(2026, 11, 15, 22, 10) },
        { id: 851, kind: 'edit', delta: 500, balance: 18270, note: 'Giveaway prize', actor: 'dashboard:1', createdAt: D(2026, 11, 14, 19, 0) },
        { id: 812, kind: 'link', delta: 120, balance: 17770, note: 'Linked with their Kick account', actor: 'dashboard:1', createdAt: D(2026, 11, 2, 18, 30) },
    ];
    const commands = [
        { name: 'Viewers: !points', command: '!points, !leaves', id: 88, enabled: true },
        { name: 'Viewers: !top', command: '!top', id: 89, enabled: true },
        { name: 'Viewers: !give', command: '!give', id: 90, enabled: true },
        { name: 'Viewers: !gamble', command: '!gamble', id: 91, enabled: false },
        { name: 'Viewers: !addpoints', command: '!addpoints', id: 92, enabled: true },
        { name: 'Viewers: !removepoints', command: '!removepoints', id: 93, enabled: true },
    ];
    return {
        list: { template: 'stream-bot/viewers', locals: listLocals },
        empty: { template: 'stream-bot/viewers', locals: { ...listLocals, rows: [], total: 0, pages: 1, count: 0, hrefs: { ...listLocals.hrefs, next: null }, watch: { ...watch, sample: [], chatters: false, needsReapprove: true } } },
        notReady: { template: 'stream-bot/viewers', locals: { ...listLocals, ready: false } },
        viewer: { template: 'stream-bot/viewer', locals: { active: 'viewers', pageTitle: person.primary.name, viewer: V.personView(person, settings, history) } },
        settings: { template: 'stream-bot/viewers-settings', locals: { active: 'viewers', pageTitle: 'Viewer settings', ready: true, settings, form: V.settingsView(settings), commands, watch } },
    };
}

export default { viewersDemo };
