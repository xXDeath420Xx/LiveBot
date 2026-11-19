/*
 * Pure helpers for the Steam Workshop watcher (core/steam-watcher-manager.js, watcher_type
 * 'app_workshop'). No database, no network — unit-tested in tests/steam-workshop.test.js.
 */
import crypto from 'crypto';

/** A real update, not the publish itself: Steam stamps time_updated = time_created on upload. */
export const UPDATE_GRACE_SECONDS = 300;
/** At most this many embeds per check (Discord allows 10 per message). */
export const MAX_EMBEDS_PER_CHECK = 10;
/** Updates are capped separately so a busy workshop's update churn cannot crowd out new items. */
export const MAX_UPDATES_PER_CHECK = 5;

export function workshopHash(kind, item) {
    const key = kind === 'new'
        ? `ws_new_${item.publishedfileid}`
        : `ws_upd_${item.publishedfileid}_${item.time_updated}`;
    return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Decide what to announce from the newest-published and most-recently-updated lists.
 *
 * @param {object} p
 * @param {Array} p.newest    items sorted by publication date (Steam query_type 1)
 * @param {Array} p.updated   items sorted by last update (Steam query_type 21)
 * @param {number} p.sinceSec only items published/updated at or after this moment count — the
 *                            watcher's creation time, so adding a watcher never dumps the backlog
 * @param {Set<string>} p.seen content hashes already notified for this watcher
 * @returns {{ fresh: Array<{item, hash}>, updates: Array<{item, hash}>, skipped: Array<{item, hash, kind}> }}
 *   fresh/updates are announced; `skipped` did not fit in one message — the caller records them as
 *   seen and links the workshop page instead, so a burst is summarised once rather than drip-fed.
 *   New items take priority; updates fill the remaining slots, at most MAX_UPDATES_PER_CHECK.
 */
export function selectWorkshopNotifications({ newest = [], updated = [], sinceSec = 0, seen = new Set() }) {
    const byId = new Map();
    const fresh = [];
    for (const item of newest) {
        if (!item?.publishedfileid || byId.has(item.publishedfileid)) continue;
        byId.set(item.publishedfileid, true);
        if (Number(item.time_created) < sinceSec) continue;
        const hash = workshopHash('new', item);
        if (!seen.has(hash)) fresh.push({ item, hash });
    }

    const freshIds = new Set(fresh.map(f => f.item.publishedfileid));
    const updates = [];
    const updSeen = new Set();
    for (const item of updated) {
        if (!item?.publishedfileid || updSeen.has(item.publishedfileid)) continue;
        updSeen.add(item.publishedfileid);
        if (freshIds.has(item.publishedfileid)) continue;                 // announced as new this round
        const created = Number(item.time_created) || 0;
        const changed = Number(item.time_updated) || 0;
        if (changed < sinceSec) continue;
        if (changed - created < UPDATE_GRACE_SECONDS) continue;           // the upload itself, not an update
        const hash = workshopHash('upd', item);
        if (!seen.has(hash)) updates.push({ item, hash });
    }

    // Oldest first so the channel reads chronologically.
    fresh.sort((a, b) => Number(a.item.time_created) - Number(b.item.time_created));
    updates.sort((a, b) => Number(a.item.time_updated) - Number(b.item.time_updated));

    // Keep the newest of each; everything older that does not fit is summarised.
    const keptFresh = fresh.slice(-MAX_EMBEDS_PER_CHECK);
    const updateRoom = Math.min(MAX_UPDATES_PER_CHECK, MAX_EMBEDS_PER_CHECK - keptFresh.length);
    const keptUpdates = updateRoom > 0 ? updates.slice(-updateRoom) : [];
    const skipped = [
        ...fresh.slice(0, fresh.length - keptFresh.length).map(f => ({ ...f, kind: 'new' })),
        ...updates.slice(0, updates.length - keptUpdates.length).map(u => ({ ...u, kind: 'update' })),
    ];
    return { fresh: keptFresh, updates: keptUpdates, skipped };
}

/** Steam descriptions are BBCode; reduce to plain text for an embed. */
export function cleanWorkshopText(text, max = 300) {
    let s = String(text || '')
        .replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/gi, '$2')
        .replace(/\[img\][^[]*\[\/img\]/gi, '')
        .replace(/\[\*\]/g, '• ')
        .replace(/\[[^\]]{1,40}\]/g, '')
        .replace(/<[^>]{1,40}>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
    return s;
}

export function formatFileSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return null;
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function workshopItemUrl(id) {
    return `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`;
}

export function workshopBrowseUrl(appId, sort = 'mostrecent') {
    return `https://steamcommunity.com/workshop/browse/?appid=${encodeURIComponent(appId)}&browsesort=${sort}`;
}
