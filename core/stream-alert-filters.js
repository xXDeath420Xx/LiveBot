/*
 * Go-live filters for one stream alert subscription (subscriptions.filter_categories and
 * subscriptions.filter_title_keywords, set per subscription in the edit-streamer dialog).
 *
 *   filter_categories      announce only when the stream's category (game) is one of these
 *   filter_title_keywords  announce only when the title, or one of the stream's tags, contains one
 *
 * Both are comma-separated lists; an empty list does not filter. With both set, both must match.
 * The filters only decide whether a NEW announcement is posted (core/stream-manager.js): a post that
 * already exists keeps being updated and is cleaned up at stream end as usual, and live roles are
 * not affected. A stream that starts outside the filter is announced when it switches to a matching
 * category or title, because every check re-evaluates it.
 *
 * The filter columns are read by a separate query (attachGoLiveFilters) instead of being added to the
 * stream manager's main subscription query, so a database without them still announces as before.
 *
 * streamers.filter_stream_categories / filter_stream_tags are deliberately NOT used: a streamers row
 * is shared by every server that tracks that account, so a filter there would apply to all of them.
 */
import { parseList } from './feed-message.js';
import logger from '../utils/logger.js';

export const STREAM_FILTER_MAX = 500;

/** Lower-case, collapse whitespace and drop punctuation, so "Grand Theft Auto V" == "grand theft auto v". */
function norm(s) {
    return String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Whether a go-live for this subscription should be announced.
 * @param {{filter_categories?:string|null, filter_title_keywords?:string|null}} sub
 * @param {{game_name?:string|null, title?:string|null, tags?:string[]|null}} streamData
 * @returns {{ok:boolean, reason?:string}}
 */
export function goLivePasses(sub, streamData) {
    const cats = parseList(sub?.filter_categories).map(norm).filter(Boolean);
    if (cats.length) {
        const game = norm(streamData?.game_name);
        if (!game || !cats.includes(game)) {
            return { ok: false, reason: `category "${streamData?.game_name || 'none'}" is not in the filter` };
        }
    }
    const words = parseList(sub?.filter_title_keywords);
    if (words.length) {
        const hay = [streamData?.title, ...(Array.isArray(streamData?.tags) ? streamData.tags : [])]
            .filter(Boolean).map(t => String(t).toLowerCase());
        if (!words.some(w => hay.some(h => h.includes(w)))) {
            return { ok: false, reason: 'title has none of the filter keywords' };
        }
    }
    return { ok: true };
}

let warnedMissing = false;

/**
 * Copy filter_categories / filter_title_keywords onto the subscription rows the stream manager loaded.
 * Never throws: on any error (including the columns not existing yet) the rows are left unfiltered.
 */
export async function attachGoLiveFilters(db, subscriptions) {
    if (!Array.isArray(subscriptions) || !subscriptions.length) return;
    let rows;
    try {
        [rows] = await db.query(
            `SELECT subscription_id, filter_categories, filter_title_keywords
               FROM subscriptions
              WHERE (filter_categories IS NOT NULL AND filter_categories <> '')
                 OR (filter_title_keywords IS NOT NULL AND filter_title_keywords <> '')`);
    } catch (error) {
        if (!warnedMissing) {
            warnedMissing = true;
            logger.warn(`[Stream Manager] Go-live filters unavailable (${error.code || error.message}); announcing without them`, { category: 'streams' });
        }
        return;
    }
    if (!rows.length) return;
    const byId = new Map(rows.map(r => [String(r.subscription_id), r]));
    for (const sub of subscriptions) {
        const f = byId.get(String(sub.subscription_id));
        if (f) {
            sub.filter_categories = f.filter_categories;
            sub.filter_title_keywords = f.filter_title_keywords;
        }
    }
}
