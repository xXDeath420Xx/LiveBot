/*
 * Stream bot Viewers pages: the pure view-model helpers behind dashboard/routes/stream-bot-viewers.js and its views
 * (views/stream-bot/viewers.ejs, viewer.ejs, viewers-settings.ejs). No database: the guide screenshots
 * (scripts/site-shots/stream-bot-viewers-demo.mjs) and tests/stream-bot-viewers-page.test.js build demo pages with the
 * same functions the route uses.
 */
import { rankFor, formatWatch, formatPoints, EARN_PERIODS } from '../../core/stream-bot/viewers/settings.js';
import { VIEWER_SORTS } from '../../core/stream-bot/viewers/store.js';

export const PLATFORM_LABEL = Object.freeze({ twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' });
export const SEEN_CHOICES = Object.freeze([[0, 'Any time'], [1, 'Today'], [7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last year']]);
export const SORT_LABEL = Object.freeze({ points: 'Points', watch: 'Watch time', messages: 'Messages', last_seen: 'Last seen', first_seen: 'First seen', name: 'Name' });
export const PER_PAGE = 50;

const iso = (d) => (d ? new Date(d).toISOString() : null);
export const whenText = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** The table's filters from a query string, cleaned. */
export function listQuery(q = {}) {
    const sort = VIEWER_SORTS.includes(q.sort) ? q.sort : 'points';
    const dir = q.dir === 'asc' ? 'asc' : q.dir === 'desc' ? 'desc' : (sort === 'name' ? 'asc' : 'desc');
    const seen = SEEN_CHOICES.some(([d]) => String(d) === String(q.seen)) ? Number(q.seen) : 0;
    return {
        q: String(q.q ?? '').trim().slice(0, 100), platform: ['twitch', 'kick', 'youtube'].includes(q.platform) ? q.platform : '', seen,
        sort, dir, page: Math.max(1, Math.min(100_000, Math.round(Number(q.page) || 1))),
    };
}

/** A URL for the list with some filters changed (page 1 unless given). */
export function listHref(f, change = {}) {
    const v = { ...f, page: 1, ...change };
    const p = new URLSearchParams();
    if (v.q) p.set('q', v.q);
    if (v.platform) p.set('platform', v.platform);
    if (v.seen) p.set('seen', String(v.seen));
    if (v.sort !== 'points') p.set('sort', v.sort);
    if (v.dir !== (v.sort === 'name' ? 'asc' : 'desc')) p.set('dir', v.dir);
    if (v.page > 1) p.set('page', String(v.page));
    const s = p.toString();
    return `/stream/bot/viewers${s ? `?${s}` : ''}`;
}

/** One row of the table. */
export function rowView(r, settings) {
    const rank = rankFor(settings, { watchMinutes: r.watchMinutes, points: r.shownPoints ?? r.points });
    return {
        id: r.id, name: r.name, login: r.login, platform: r.platform, platformLabel: PLATFORM_LABEL[r.platform] || r.platform,
        points: formatPoints(r.shownPoints ?? r.points), watch: formatWatch(r.watchMinutes), messages: formatPoints(r.messages),
        rank: rank?.name || '', linked: !!r.personId, lastSeen: iso(r.lastSeenAt), lastSeenText: whenText(r.lastSeenAt),
    };
}

const HISTORY_KIND = Object.freeze({ bonus: 'Bonus', give: 'Given', gamble: 'Gamble', edit: 'Changed', automation: 'Automation', import: 'Import', rank: 'Rank', link: 'Link', points: 'Points' });

/** The viewer page: the person (both linked accounts), totals, rank, history. */
export function personView(person, settings, history = []) {
    const t = person.totals;
    const rank = rankFor(settings, { watchMinutes: t.watchMinutes, points: person.points });
    const tips = Object.entries(t.tipAmounts || {}).map(([c, n]) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c === 'other' ? '(other currency)' : c}`);
    return {
        id: person.primary.id, name: person.primary.name, currency: settings.currency,
        points: formatPoints(person.points), pointsRaw: person.points, watch: formatWatch(t.watchMinutes), messages: formatPoints(t.messages),
        rank: rank?.name || '', firstSeen: iso(t.firstSeenAt), firstSeenText: whenText(t.firstSeenAt), lastSeen: iso(t.lastSeenAt), lastSeenText: whenText(t.lastSeenAt),
        accounts: person.rows.map((r) => ({
            id: r.id, platform: r.platform, platformLabel: PLATFORM_LABEL[r.platform] || r.platform, name: r.name, login: r.login, platformUserId: r.platformUserId,
            primary: r.id === person.primary.id, watch: formatWatch(r.watchMinutes), messages: formatPoints(r.messages), importedFrom: r.importedFrom,
        })),
        linkable: person.rows.length < 2,
        otherPlatform: person.primary.platform === 'twitch' ? 'kick' : 'twitch',
        support: [
            ['Followed', t.follows ? `Yes${person.rows.find((r) => r.followedAt)?.followedAt ? `, ${whenText(person.rows.find((r) => r.followedAt).followedAt)}` : ''}` : 'No'],
            ['Subs and resubs', formatPoints(t.subs) + (t.subMonths ? ` (${formatPoints(t.subMonths)} months)` : '')],
            ['Gift subs', t.gifts ? `${formatPoints(t.giftedSubs)} subs in ${formatPoints(t.gifts)} gift${t.gifts === 1 ? '' : 's'}` : '0'],
            ['Bits', t.bits ? `${formatPoints(t.bits)}${t.cheers ? ` in ${formatPoints(t.cheers)} cheer${t.cheers === 1 ? '' : 's'}` : ''}` : '0'],
            ['Raids', t.raids ? `${formatPoints(t.raids)} (${formatPoints(t.raidViewers)} viewers)` : '0'],
            ['Tips', t.tips ? `${formatPoints(t.tips)}${tips.length ? ` (${tips.join(', ')})` : ''}` : '0'],
        ],
        history: history.map((h) => ({
            id: h.id, kind: HISTORY_KIND[h.kind] || h.kind, change: h.delta == null ? '' : `${h.delta > 0 ? '+' : ''}${formatPoints(h.delta)}`,
            balance: h.balance == null ? '' : formatPoints(h.balance), note: h.note || '', by: actorLabel(h.actor), at: iso(h.createdAt), atText: h.createdAt ? new Date(h.createdAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '',
        })),
    };
}

export function actorLabel(a) {
    const s = String(a || '');
    if (!s) return '';
    if (s.startsWith('chat:')) return `${s.slice(5)} in chat`;
    if (s.startsWith('dashboard:')) return 'You, on the dashboard';
    if (s === 'stream bot') return 'Stream bot';
    if (s === 'automation') return 'An automation';
    return s;
}

/** The settings form's values (ranks as rows, the not-counted list as text). */
export function settingsView(s) {
    return {
        tracking: s.tracking, currency: s.currency, earn: { ...s.earn }, periods: [...EARN_PERIODS],
        ranks: { basis: s.ranks.basis, list: s.ranks.list.map((r) => ({ name: r.name, min: s.ranks.basis === 'watch' ? Math.round(r.min / 60 * 10) / 10 : r.min })) },
        give: { ...s.give }, gamble: { ...s.gamble }, ignore: s.ignore.join('\n'),
    };
}

/** The last watch-time sample, as lines for the page. */
export function sampleLines(status) {
    if (!status) return [];
    return (status.channels || []).map((c) => {
        const where = `${PLATFORM_LABEL[c.platform] || c.platform}${c.login ? ` (${c.login})` : ''}`;
        if (!c.live) return { where, text: 'Offline: nothing counted', tone: '' };
        const how = c.source === 'chatters' ? 'everyone in chat' : 'people who chatted in the last 10 minutes';
        return { where, text: `Live: ${formatPoints(c.counted)} counted (${how})`, tone: 'is-ok' };
    });
}

/** A CSV cell: quoted, and a leading = + - @ made harmless for spreadsheets. */
export function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
export const CSV_HEADER = Object.freeze(['platform', 'platform_user_id', 'login', 'display_name', 'points', 'watch_minutes', 'messages', 'rank', 'first_seen', 'last_seen',
    'follows', 'subs', 'sub_months', 'gifts', 'gifted_subs', 'cheers', 'bits', 'raids', 'raid_viewers', 'tips', 'tip_amounts', 'linked_to']);
export function csvLine(r, settings) {
    const rank = rankFor(settings, { watchMinutes: r.watchMinutes, points: r.shownPoints ?? r.points })?.name || '';
    return [r.platform, r.platformUserId, r.login, r.name, r.shownPoints ?? r.points, r.watchMinutes, r.messages, rank, iso(r.firstSeenAt), iso(r.lastSeenAt),
        r.follows, r.subs, r.subMonths, r.gifts, r.giftedSubs, r.cheers, r.bits, r.raids, r.raidViewers, r.tips,
        Object.keys(r.tipAmounts || {}).length ? JSON.stringify(r.tipAmounts) : '', r.personId || ''].map(csvCell).join(',');
}

export default { listQuery, listHref, rowView, personView, settingsView, sampleLines, csvCell, csvLine, CSV_HEADER, SORT_LABEL, SEEN_CHOICES, PLATFORM_LABEL, PER_PAGE };
