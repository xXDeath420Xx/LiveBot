/*
 * Throne: stop a single long item name from truncating a whole wishlist.
 *
 * WHY
 * ---
 * `item_name` was VARCHAR(255). Throne item names are whatever the source store calls the
 * product, and marketplace listings routinely run far past that — karabi420 had one at 291
 * characters ("AMOS Peelerz Lollies — Peelable Gummies with Exotic Fruit Flavours (Banana,
 * Mango, Pineapple, Lychee, Peach), Gluten-Free & Fat-Free Snacks ...").
 *
 * That mattered more than a truncated name, because cacheProfileAndWishlist DELETEs every row
 * for the user and then INSERTs the new ones one at a time. The oversized row threw mid-loop,
 * so the wishlist was left holding only the items inserted before it — 8 of 37 for karabi420 —
 * and the failure was logged as a warning reading "Profile cached ok, wishlist failed — that's
 * fine". New-item notifications then diffed against that truncated baseline.
 *
 * TEXT rather than a bigger VARCHAR: there is no natural ceiling on a store's product title,
 * and item_name carries no index (PRIMARY KEY is (throne_username, item_id)), so widening it
 * costs nothing. The caching code is being made transactional and per-row tolerant separately;
 * this removes the cause rather than only the symptom.
 */

async function columnType(db, table, column) {
  const [rows] = await db.execute(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]);
  return rows.length > 0 ? String(rows[0].COLUMN_TYPE).toLowerCase() : null;
}

export async function up(db) {
  const current = await columnType(db, 'throne_cached_wishlists', 'item_name');
  if (current === null) return;          // table not present on this deployment
  if (current === 'text') return;        // already applied
  await db.execute('ALTER TABLE throne_cached_wishlists MODIFY COLUMN item_name TEXT DEFAULT NULL');
}

export async function down(db) {
  const current = await columnType(db, 'throne_cached_wishlists', 'item_name');
  if (current === null || current !== 'text') return;
  // Lossy by definition — anything past 255 chars is cut. Rows re-populate on the next refresh.
  await db.execute('ALTER TABLE throne_cached_wishlists MODIFY COLUMN item_name VARCHAR(255) DEFAULT NULL');
}
