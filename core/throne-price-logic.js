/*
 * Throne wishlist price tracking: the "last known price per item" lookup and what to record.
 *
 * The lookup used to be
 *     ... WHERE throne_username = ? AND (item_id, recorded_at) IN (SELECT item_id, MAX(recorded_at) ... GROUP BY item_id)
 * which MariaDB runs as a scan of every history row the creator has (2.3M for the largest one):
 * 2.6 s once a minute. The infra report's join form (derived MAX table joined back) uses the
 * (throne_username, item_id, recorded_at) index from migration 477 but still scans the GROUP BY,
 * 0.8 s for the same creator. This form walks the creator's known items (throne_seen_items,
 * primary key (throne_username, item_id)) and takes the newest history row of each with one
 * index dive: 4 ms, and the same rows as the old query for every creator (checked 2026-11-21).
 *
 * An item with no history row (new, or swept by the 90-day retention) comes back with a NULL
 * price and is treated as "no previous price", exactly as before.
 *
 * Rows are written only when the price changed (or there is no previous price). The table used to
 * gain one row per item per minute whether or not anything changed, 777k rows for 29 items.
 */

export const LATEST_PRICES_SQL =
    `SELECT si.item_id,
            (SELECT p.price_raw FROM throne_price_history p
              WHERE p.throne_username = si.throne_username AND p.item_id = si.item_id
              ORDER BY p.recorded_at DESC, p.id DESC LIMIT 1) AS price_raw
       FROM throne_seen_items si
      WHERE si.throne_username = ?`;

/** item_id -> last price, skipping items that have no recorded price. */
export function lastPriceMap(rows) {
    const map = new Map();
    for (const r of rows || []) {
        if (r.price_raw === null || r.price_raw === undefined) continue;
        const n = Number(r.price_raw);
        if (Number.isFinite(n)) map.set(String(r.item_id), n);
    }
    return map;
}

/** Items whose current price differs from the last recorded one (items never priced are not changes). */
export function detectPriceChanges(items, lastPrices) {
    const changes = [];
    for (const item of items || []) {
        const lastPrice = lastPrices.get(String(item.id));
        if (lastPrice == null || lastPrice === item.priceRaw) continue;
        const changePct = lastPrice === 0 ? 100 : Math.abs((item.priceRaw - lastPrice) / lastPrice * 100);
        changes.push({
            ...item,
            oldPrice: lastPrice,
            changePct: Math.round(changePct),
            direction: item.priceRaw > lastPrice ? 'up' : 'down',
        });
    }
    return changes;
}

/** Items that need a history row: no previous price, or a different one. */
export function pricesToRecord(items, lastPrices) {
    return (items || []).filter((item) => {
        if (!Number.isFinite(Number(item.priceRaw))) return false;
        const last = lastPrices.get(String(item.id));
        return last == null || last !== item.priceRaw;
    });
}
