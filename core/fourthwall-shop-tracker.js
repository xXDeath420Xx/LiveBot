/**
 * Fourthwall public shop tracker.
 *
 * Anyone can subscribe a Discord channel to changes in any public Fourthwall
 * shop by handle — no API credentials needed. The scheduler runs every
 * 10 minutes (jobs/fourthwall-shop-tracker-scheduler.js), scrapes each shop
 * with a snapshot's worth of unique handles, diffs against fourthwall_tracked_products,
 * and announces relevant events to each subscribing channel.
 *
 * This module exposes:
 *   - subscribe / unsubscribe / listSubscriptions  (per-guild user commands)
 *   - runCycle                                     (called by the scheduler)
 *
 * The DIFF function — the actual "what counts as a change" decision — lives in
 * computeProductDiff() below. It's the only piece of business logic that
 * meaningfully shapes what your users see. See the TODO marker.
 */

import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import botManager from './bot-manager.js';
import fourthwallScraper from '../utils/scrapers/fourthwall-scraper.js';
import fourthwallApi from '../utils/fourthwall-api.js';
import { sanitizeUserText, truncate, formatCurrency, EMBED_DEFAULT_COLOR } from './fourthwall-helpers.js';
import crypto from 'node:crypto';

const SHOP_HANDLE_RE = /^[a-z0-9-]{1,100}$/i;
const MAX_ANNOUNCE_PER_SHOP_PER_CYCLE = 8; // avoid flooding a channel if a shop drops 50 products at once

function normalizeHandle(input) {
    if (!input) throw new Error('Shop handle required');
    const s = String(input).trim();
    const urlMatch = /^https?:\/\/([a-z0-9-]+)\.fourthwall\.com/i.exec(s);
    const handle = urlMatch ? urlMatch[1] : s;
    if (!SHOP_HANDLE_RE.test(handle)) throw new Error('Invalid shop handle');
    return handle.toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription management
// ─────────────────────────────────────────────────────────────────────────────

export async function subscribe({ guildId, shopHandle, channelId, addedBy, flags = {} }) {
    const handle = normalizeHandle(shopHandle);
    // Touch the shop once to confirm it exists & cache its name.
    let shopName = null;
    try {
        const shop = await fetchShopPreferringApi(handle);
        shopName = shop.name || null;
    } catch (err) {
        throw new Error(`Couldn't reach shop "${handle}": ${err.message}`);
    }

    const f = {
        notify_new_products: flags.new_products !== false ? 1 : 0,
        notify_price_drops: flags.price_drops !== false ? 1 : 0,
        notify_price_increases: flags.price_increases === true ? 1 : 0,
        notify_sold_out: flags.sold_out === true ? 1 : 0,
        notify_restocked: flags.restocked !== false ? 1 : 0
    };

    await pool.execute(
        `INSERT INTO fourthwall_tracked_shops
            (guild_id, shop_handle, shop_name, channel_id,
             notify_new_products, notify_price_drops, notify_price_increases,
             notify_sold_out, notify_restocked, added_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            shop_name = VALUES(shop_name),
            notify_new_products = VALUES(notify_new_products),
            notify_price_drops = VALUES(notify_price_drops),
            notify_price_increases = VALUES(notify_price_increases),
            notify_sold_out = VALUES(notify_sold_out),
            notify_restocked = VALUES(notify_restocked)`,
        [guildId, handle, shopName, channelId,
         f.notify_new_products, f.notify_price_drops, f.notify_price_increases,
         f.notify_sold_out, f.notify_restocked, addedBy]
    );

    return { handle, shopName };
}

export async function unsubscribe({ guildId, shopHandle, channelId }) {
    const handle = normalizeHandle(shopHandle);
    const [result] = channelId
        ? await pool.execute(
            `DELETE FROM fourthwall_tracked_shops WHERE guild_id = ? AND shop_handle = ? AND channel_id = ?`,
            [guildId, handle, channelId])
        : await pool.execute(
            `DELETE FROM fourthwall_tracked_shops WHERE guild_id = ? AND shop_handle = ?`,
            [guildId, handle]);
    return { removed: result.affectedRows };
}

export async function listSubscriptions(guildId) {
    const [rows] = await pool.execute(
        `SELECT id, shop_handle, shop_name, channel_id,
                notify_new_products, notify_price_drops, notify_price_increases,
                notify_sold_out, notify_restocked,
                last_checked_at, last_error, consecutive_failures
         FROM fourthwall_tracked_shops WHERE guild_id = ? ORDER BY shop_handle, channel_id`,
        [guildId]);
    return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadPreviousSnapshot(shopHandle) {
    const [rows] = await pool.execute(
        `SELECT slug, internal_product_id, name, image_url, images_json, price_minor_units, currency,
                variants_json, last_variant_signature, last_status
         FROM fourthwall_tracked_products WHERE shop_handle = ?`,
        [shopHandle]);
    const map = new Map();                        // slug -> prev snapshot
    const byInternalId = new Map();               // internal_product_id -> slug (for rename detection)
    for (const r of rows) {
        let variants = [];
        try { variants = r.variants_json ? JSON.parse(r.variants_json) : []; } catch { variants = []; }
        let images = [];
        try { images = r.images_json ? JSON.parse(r.images_json) : []; } catch { images = []; }
        const prev = {
            slug: r.slug,
            internalId: r.internal_product_id || null,
            name: r.name,
            image: r.image_url,
            images,
            price: r.price_minor_units != null
                ? { amount: r.price_minor_units, currency: r.currency || 'USD' }
                : null,
            variants,
            variantSignature: r.last_variant_signature || null,
            status: r.last_status,
        };
        map.set(r.slug, prev);
        if (prev.internalId) byInternalId.set(prev.internalId, r.slug);
    }
    map.__byInternalId = byInternalId;            // non-enumerable-ish attached map for rename detection
    return map;
}

function variantSignature(variants) {
    // Deterministic hash of (id, availability, price) per variant — cheap "did anything move"
    // check without re-walking the list. Sorted so order doesn't matter.
    if (!Array.isArray(variants) || !variants.length) return null;
    const parts = variants
        .map(v => `${v.id || v.name || '?'}|${v.availability || '?'}|${v.price ?? '?'}`)
        .sort()
        .join('\n');
    return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 32);
}

async function writeCurrentSnapshot(shopHandle, currentProducts, removedSlugs) {
    if (currentProducts.length) {
        // Bulk upsert: now includes internal_product_id + variants_json + images_json +
        // last_variant_signature. All nullable — pre-enrichment rows just write NULL.
        const placeholders = currentProducts.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const params = [];
        for (const p of currentProducts) {
            params.push(
                shopHandle,
                p.slug.slice(0, 200),
                p.internalId || null,
                p.name ? p.name.slice(0, 255) : null,
                p.image || null,
                p.images ? JSON.stringify(p.images).slice(0, 65535) : null,
                p.price?.amount ?? null,
                p.price?.currency || null,
                p.variants ? JSON.stringify(p.variants).slice(0, 65535) : null,
                variantSignature(p.variants),
                'active'
            );
        }
        await pool.execute(
            `INSERT INTO fourthwall_tracked_products
                (shop_handle, slug, internal_product_id, name, image_url, images_json,
                 price_minor_units, currency, variants_json, last_variant_signature, last_status)
             VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE
                internal_product_id = COALESCE(VALUES(internal_product_id), internal_product_id),
                name = VALUES(name),
                image_url = VALUES(image_url),
                images_json = COALESCE(VALUES(images_json), images_json),
                price_minor_units = VALUES(price_minor_units),
                currency = VALUES(currency),
                variants_json = COALESCE(VALUES(variants_json), variants_json),
                last_variant_signature = COALESCE(VALUES(last_variant_signature), last_variant_signature),
                last_status = VALUES(last_status)`,
            params);
    }
    if (removedSlugs.length) {
        const inClause = removedSlugs.map(() => '?').join(',');
        await pool.execute(
            `UPDATE fourthwall_tracked_products
             SET last_status = 'removed'
             WHERE shop_handle = ? AND slug IN (${inClause})`,
            [shopHandle, ...removedSlugs]);
    }
}

// Low-stock cooldown: don't re-fire variant_low_stock for the same variant more often than
// once per LOW_STOCK_COOLDOWN_DAYS. Reads/writes fourthwall_variant_state.
const LOW_STOCK_COOLDOWN_DAYS = 7;

async function filterLowStockByCooldown(shopHandle, lowEvents) {
    if (!lowEvents.length) return lowEvents;
    const [rows] = await pool.execute(
        `SELECT slug, variant_id, last_low_stock_announced_at FROM fourthwall_variant_state
          WHERE shop_handle = ? AND last_low_stock_announced_at IS NOT NULL
            AND last_low_stock_announced_at > DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [shopHandle, LOW_STOCK_COOLDOWN_DAYS]);
    const suppressed = new Set(rows.map(r => `${r.slug}:${r.variant_id}`));
    const kept = [];
    for (const e of lowEvents) {
        const key = `${e.product.slug}:${e.variant?.id || e.variant?.name || '?'}`;
        if (suppressed.has(key)) continue;
        kept.push(e);
        // Record the announcement timestamp — fire-and-forget so a DB blip never blocks the post.
        pool.execute(
            `INSERT INTO fourthwall_variant_state (shop_handle, slug, variant_id, last_low_stock_announced_at)
             VALUES (?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE last_low_stock_announced_at = NOW()`,
            [shopHandle, e.product.slug, String(e.variant?.id || e.variant?.name || '?')]).catch(() => {});
    }
    return kept;
}

// Price history writer — snapshots a product-level price on every change so we can detect
// "sale" (price drop > SALE_PCT below 30-day baseline). Fire-and-forget.
const SALE_PCT = 15;
const SALE_BASELINE_DAYS = 30;

async function recordPriceHistory(shopHandle, slug, priceMinor, currency) {
    if (!Number.isFinite(priceMinor)) return;
    pool.execute(
        `INSERT INTO fourthwall_price_history (shop_handle, slug, price_minor_units, currency) VALUES (?, ?, ?, ?)`,
        [shopHandle, slug, priceMinor, currency || 'USD']).catch(() => {});
}

async function isPriceDropASale(shopHandle, slug, newPriceMinor) {
    try {
        const [rows] = await pool.execute(
            `SELECT MAX(price_minor_units) AS baseline FROM fourthwall_price_history
              WHERE shop_handle = ? AND slug = ? AND recorded_at > DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [shopHandle, slug, SALE_BASELINE_DAYS]);
        const baseline = Number(rows[0]?.baseline);
        if (!Number.isFinite(baseline) || baseline <= 0) return false;
        const dropPct = ((baseline - newPriceMinor) / baseline) * 100;
        return dropPct >= SALE_PCT;
    } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DIFF — USER-WRITTEN BUSINESS LOGIC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compare a previous snapshot of a shop's products against the current scrape
 * and return the list of events to announce.
 *
 * Inputs:
 *   - previous: Map<slug, {slug, name, image, price:{amount, currency}|null, status:'active'|'sold_out'|'removed'}>
 *               (status reflects the LAST observation — 'removed' rows came back if you see them again)
 *   - current:  Array<{slug, name, image, price:{amount, currency, display}|null}>
 *               (every product visible in the shop right now)
 *   - isFirstScrape: boolean
 *               (true if we've never seen this shop before — previous is empty.
 *                Strong recommendation: return [] in that case so we don't flood
 *                the channel with 18 "new product!" announcements on day 1.)
 *
 * Return:
 *   Array of events, where each event is one of:
 *     { type: 'new_product',      product }
 *     { type: 'price_drop',       product, oldPrice, newPrice }
 *     { type: 'price_increase',   product, oldPrice, newPrice }
 *     { type: 'sold_out',         product }   // not currently fired (scraper doesn't read badges yet)
 *     { type: 'restocked',        product }   // fires when something that was 'removed' is back
 *
 * Tracker.runCycle() will filter these against each subscriber's notify_* flags,
 * so you can return everything — the subscriber controls what they see.
 *
 * `product` should always be a current product object (so embeds can show
 * fresh name/price/image even if you're firing a 'price_drop' event).
 *
 * TODO(you): implement this. See learning-mode request below.
 */
// FW_TRACKER_V2 — enhanced diff: variant-aware + priority-sorted + price threshold +
// slug-rename detection via internal_product_id.

const MIN_PRICE_CHANGE_PCT = 1;    // ignore sub-1% wobbles
const MIN_PRICE_CHANGE_ABS = 100;  // and sub-$1.00 absolute

function priceChangeIsSignificant(oldAmt, newAmt) {
    if (oldAmt == null || newAmt == null || oldAmt === newAmt) return false;
    const absDelta = Math.abs(newAmt - oldAmt);
    if (absDelta < MIN_PRICE_CHANGE_ABS) return false;
    return (absDelta / oldAmt) * 100 >= MIN_PRICE_CHANGE_PCT;
}

function normaliseText(x) {
    return String(x ?? '').trim().replace(/\s+/g, ' ');
}

function diffVariants(prevVariants, currentVariants) {
    const keyOf = (v) => v.id || normaliseText(v.name).toLowerCase();
    const prevMap = new Map((prevVariants || []).map(v => [keyOf(v), v]));
    const currentMap = new Map((currentVariants || []).map(v => [keyOf(v), v]));
    const added = [], removed = [], backInStock = [], wentOutOfStock = [], lowStock = [];
    for (const [k, v] of currentMap) {
        const p = prevMap.get(k);
        if (!p) { added.push(v); continue; }
        const prevAvail = String(p.availability || '').toLowerCase();
        const curAvail  = String(v.availability || '').toLowerCase();
        const prevIn = prevAvail.includes('instock') || prevAvail.includes('preorder');
        const curIn  = curAvail.includes('instock')  || curAvail.includes('preorder');
        if (!prevIn && curIn) backInStock.push(v);
        if (prevIn && !curIn) wentOutOfStock.push(v);
        if (curAvail.includes('limitedavailability')) lowStock.push(v);
    }
    for (const [k, v] of prevMap) if (!currentMap.has(k)) removed.push(v);
    return { added, removed, backInStock, wentOutOfStock, lowStock };
}

export function computeProductDiff(previous, current, isFirstScrape) {
    if (isFirstScrape) return [];

    const events = [];
    const currentSlugs = new Set(current.map(p => p.slug));
    const byInternalId = previous.__byInternalId || new Map();
    const consumedPrevSlugs = new Set();   // slugs we matched via internal_product_id (rename)

    for (const p of current) {
        let prev = previous.get(p.slug);

        // Rename detection: no slug match, but internalId matches a previous row with a
        // different slug — treat as a rename, not a new product.
        if (!prev && p.internalId && byInternalId.has(p.internalId)) {
            const oldSlug = byInternalId.get(p.internalId);
            if (oldSlug !== p.slug) {
                const oldPrev = previous.get(oldSlug);
                if (oldPrev) {
                    events.push({ type: 'product_renamed', product: p, oldSlug, oldName: oldPrev.name });
                    consumedPrevSlugs.add(oldSlug);
                    prev = oldPrev;
                }
            }
        }

        if (!prev) { events.push({ type: 'new_product', product: p }); continue; }

        if (prev.status === 'removed') {
            events.push({ type: 'restocked', product: p });
        }

        const oldAmt = prev.price?.amount;
        const newAmt = p.price?.amount;
        if (priceChangeIsSignificant(oldAmt, newAmt)) {
            events.push({
                type: newAmt < oldAmt ? 'price_drop' : 'price_increase',
                product: p, oldPrice: prev.price, newPrice: p.price,
            });
        }

        if (prev.name && p.name && normaliseText(prev.name) !== normaliseText(p.name)) {
            events.push({ type: 'name_changed', product: p, oldName: prev.name, newName: p.name });
        }
        if (prev.image && p.image && prev.image !== p.image) {
            events.push({ type: 'image_changed', product: p, oldImage: prev.image, newImage: p.image });
        }

        if (Array.isArray(p.variants)) {
            const v = diffVariants(prev.variants, p.variants);
            for (const a of v.added)         events.push({ type: 'variant_added',          product: p, variant: a });
            for (const r of v.removed)       events.push({ type: 'variant_removed',        product: p, variant: r });
            for (const b of v.backInStock)   events.push({ type: 'variant_back_in_stock',  product: p, variant: b });
            for (const g of v.wentOutOfStock)events.push({ type: 'variant_sold_out',       product: p, variant: g });
            for (const l of v.lowStock)      events.push({ type: 'variant_low_stock',      product: p, variant: l });
        }
    }

    for (const [slug, prev] of previous) {
        if (consumedPrevSlugs.has(slug)) continue;    // already surfaced as a rename
        if (prev.status === 'active' && !currentSlugs.has(slug) && prev.price?.amount != null) {
            events.push({
                type: 'sold_out',
                product: { slug: prev.slug, name: prev.name, image: prev.image, price: prev.price },
            });
        }
    }

    const PRIORITY = {
        price_drop: 0, back_in_stock: 1, restocked: 1, variant_back_in_stock: 1,
        new_product: 2, product_renamed: 2, variant_added: 3,
        sold_out: 4, variant_sold_out: 4,
        variant_low_stock: 5,
        price_increase: 6,
        name_changed: 7, image_changed: 7,
        variant_removed: 8,
    };
    events.sort((a, b) => (PRIORITY[a.type] ?? 99) - (PRIORITY[b.type] ?? 99));
    return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Embed builders
// ─────────────────────────────────────────────────────────────────────────────

function productUrl(handle, slug) {
    return `https://${handle}.fourthwall.com/products/${slug}/`;
}

function priceText(price) {
    if (!price) return '—';
    if (price.display) return price.display;
    if (price.amount != null) return formatCurrency(price.amount, price.currency || 'USD');
    return '—';
}

export function buildEventEmbed(shopHandle, shopName, event) {
    const p = event.product;
    const url = productUrl(shopHandle, p.slug);
    const base = new EmbedBuilder()
        .setColor(EMBED_DEFAULT_COLOR)
        .setURL(url)
        .setFooter({ text: shopName || shopHandle });
    if (p.image) base.setThumbnail(p.image);

    switch (event.type) {
        case 'new_product':
            return base
                .setTitle(`🆕 New product: ${sanitizeUserText(p.name || p.slug)}`)
                .addFields({ name: 'Price', value: priceText(p.price), inline: true });
        case 'price_drop':
            return base
                .setTitle(`${event.isSale ? '🏷️ SALE' : '📉 Price drop'}: ${sanitizeUserText(p.name || p.slug)}`)
                .setColor(event.isSale ? 0xE74C3C : EMBED_DEFAULT_COLOR)
                .addFields(
                    { name: 'Was', value: `~~${priceText(event.oldPrice)}~~`, inline: true },
                    { name: 'Now', value: `**${priceText(event.newPrice)}**`, inline: true });
        case 'price_increase':
            return base
                .setTitle(`📈 Price up: ${sanitizeUserText(p.name || p.slug)}`)
                .addFields(
                    { name: 'Was', value: priceText(event.oldPrice), inline: true },
                    { name: 'Now', value: priceText(event.newPrice), inline: true });
        case 'sold_out':
            return base.setTitle(`❌ Sold out: ${sanitizeUserText(p.name || p.slug)}`);
        case 'restocked':
            return base
                .setTitle(`🔄 Restocked: ${sanitizeUserText(p.name || p.slug)}`)
                .addFields({ name: 'Price', value: priceText(p.price), inline: true });
        case 'product_renamed':
            return base
                .setTitle(`✏️ Renamed: ${sanitizeUserText(p.name || p.slug)}`)
                .setDescription(`Was previously \`${sanitizeUserText(event.oldName || event.oldSlug || '?')}\`.`);
        case 'name_changed':
            return base
                .setTitle(`✏️ Name changed: ${sanitizeUserText(event.newName || p.name || p.slug)}`)
                .addFields({ name: 'Was', value: sanitizeUserText(event.oldName || '?'), inline: false });
        case 'image_changed':
            return base
                .setTitle(`🖼️ New image: ${sanitizeUserText(p.name || p.slug)}`);
        case 'variant_added':
            return base
                .setTitle(`➕ New variant: ${sanitizeUserText(event.variant?.name || '?')}`)
                .setDescription(sanitizeUserText(p.name || p.slug));
        case 'variant_removed':
            return base
                .setTitle(`➖ Variant removed: ${sanitizeUserText(event.variant?.name || '?')}`)
                .setDescription(sanitizeUserText(p.name || p.slug));
        case 'variant_back_in_stock':
            return base
                .setTitle(`🔁 Back in stock: ${sanitizeUserText(event.variant?.name || '?')}`)
                .setDescription(sanitizeUserText(p.name || p.slug))
                .addFields({ name: 'Price', value: priceText({ amount: event.variant?.price, currency: event.variant?.currency }), inline: true });
        case 'variant_sold_out':
            return base
                .setTitle(`❌ Sold out: ${sanitizeUserText(event.variant?.name || '?')}`)
                .setDescription(sanitizeUserText(p.name || p.slug));
        case 'variant_low_stock':
            return base
                .setTitle(`⚠️ Low stock: ${sanitizeUserText(event.variant?.name || '?')}`)
                .setDescription(sanitizeUserText(p.name || p.slug));
        default:
            return base.setTitle(sanitizeUserText(p.name || p.slug));
    }
}

const EVENT_FLAG_MAP = {
    new_product: 'notify_new_products',
    price_drop: 'notify_price_drops',
    price_increase: 'notify_price_increases',
    sold_out: 'notify_sold_out',
    restocked: 'notify_restocked',
    // v2 additions — all tied to new columns from migration 341.
    product_renamed: 'notify_product_renamed',
    name_changed: 'notify_name_changed',
    image_changed: 'notify_image_changed',
    variant_added: 'notify_variant_added',
    variant_removed: 'notify_variant_added',           // reuse the "variant changes" opt-in
    variant_back_in_stock: 'notify_variant_restocked',
    variant_sold_out: 'notify_variant_sold_out',
    variant_low_stock: 'notify_variant_low_stock',
};

// ─────────────────────────────────────────────────────────────────────────────
// One cycle of the scheduler
// ─────────────────────────────────────────────────────────────────────────────

export async function runCycle() {
    // Get every unique shop with at least one active subscriber.
    const [shopRows] = await pool.execute(
        `SELECT DISTINCT shop_handle FROM fourthwall_tracked_shops`);
    if (shopRows.length === 0) return { shopsScanned: 0, eventsFired: 0 };

    let eventsFired = 0;
    for (const { shop_handle: handle } of shopRows) {
        try {
            await processShop(handle, (n) => { eventsFired += n; });
        } catch (err) {
            logger.error('[FW Tracker] shop failed', { handle, err: err.message });
            await pool.execute(
                `UPDATE fourthwall_tracked_shops
                 SET last_error = ?, consecutive_failures = consecutive_failures + 1, last_checked_at = NOW()
                 WHERE shop_handle = ?`,
                [String(err.message).slice(0, 1000), handle]);
        }
    }
    return { shopsScanned: shopRows.length, eventsFired };
}



// FW_API_PATH_V2 — try the authenticated Storefront API first for shops with a
// storefront_token on fourthwall_connections; fall back to the public scraper on any
// failure. The adapter normalises the API response into the scraper's shape so
// downstream code (computeProductDiff etc.) doesn't need to care which path produced
// the catalog.

async function getConnectedStorefrontToken(shopHandle) {
    try {
        const [rows] = await pool.execute(
            `SELECT storefront_token FROM fourthwall_connections
              WHERE shop_handle = ? AND storefront_token IS NOT NULL AND storefront_token <> ''
              ORDER BY connected_at DESC LIMIT 1`,
            [shopHandle]);
        return rows[0]?.storefront_token || null;
    } catch { return null; }
}

/** Normalise a Storefront-API shop response into the shape fourthwall-scraper.getShop
 *  returns — so computeProductDiff + the enrichment hook see the same object shape no
 *  matter which path fetched it. Defensive: unknown fields become null; unexpected
 *  shapes return null to force the fallback.
 */
function adaptStorefrontShop(handle, apiResponse) {
    if (!apiResponse || typeof apiResponse !== 'object') return null;
    // The Storefront API's /v1/shop may return either { shop, products } or just the shop
    // with an embedded products array. Normalise.
    const shopMeta = apiResponse.shop || apiResponse;
    let products = apiResponse.products || shopMeta.products || [];
    if (!Array.isArray(products)) return null;

    const out = {
        handle,
        name: shopMeta.name || shopMeta.title || null,
        products: products.map(prod => {
            if (!prod || typeof prod !== 'object') return null;
            const slug = String(prod.slug || prod.handle || prod.id || '').toLowerCase();
            if (!slug) return null;
            const firstVariant = Array.isArray(prod.variants) ? prod.variants[0] : null;
            const priceObj = prod.price || firstVariant?.price || null;
            const amountCents = Number.isFinite(priceObj?.value)
                ? Math.round(priceObj.value * 100)
                : (Number.isFinite(priceObj?.amount) ? priceObj.amount : null);
            const currency = priceObj?.currency || priceObj?.currencyCode || 'USD';
            const image = Array.isArray(prod.images) && prod.images[0]
                ? (prod.images[0].url || prod.images[0])
                : (prod.image || null);
            return {
                slug,
                name: prod.name || prod.title || slug,
                image: image || null,
                price: amountCents != null ? { amount: amountCents, currency } : null,
                internalId: prod.id || null,
                images: Array.isArray(prod.images) ? prod.images.map(i => i?.url || i).filter(Boolean) : [],
                variants: Array.isArray(prod.variants) ? prod.variants.map(v => ({
                    id: v.id || null,
                    name: v.name || v.title || v.sku || null,
                    price: Number.isFinite(v.price?.value) ? Math.round(v.price.value * 100)
                        : (Number.isFinite(v.price?.amount) ? v.price.amount : amountCents),
                    currency: v.price?.currency || currency,
                    availability: v.inStock === false ? 'OutOfStock' : (v.inStock === true ? 'InStock' : (v.availability || null)),
                    url: v.url || null,
                })) : [],
            };
        }).filter(Boolean),
    };
    return out;
}

async function fetchShopPreferringApi(handle) {
    const token = await getConnectedStorefrontToken(handle);
    if (token) {
        try {
            const client = fourthwallApi.storefrontClient(token);
            const apiResp = await client.getShop();
            const adapted = adaptStorefrontShop(handle, apiResp);
            if (adapted && Array.isArray(adapted.products) && adapted.products.length) {
                logger.info('[FW Tracker] used storefront API path', { handle, products: adapted.products.length });
                return { ...adapted, _source: 'api' };
            }
            logger.warn('[FW Tracker] storefront API returned empty/invalid shape — falling back to scraper', { handle });
        } catch (err) {
            logger.warn('[FW Tracker] storefront API fetch failed — falling back to scraper', { handle, err: err.message });
        }
    }
    const shop = await fourthwallScraper.getShop(handle);
    return { ...shop, _source: 'scraper' };
}


async function processShop(handle, addEvents) {
    const previous = await loadPreviousSnapshot(handle);
    const isFirstScrape = previous.size === 0;

    const shop = await fetchShopPreferringApi(handle);
    const current = shop.products || [];

    // v2 enrichment: fetch JSON-LD for any slug that is NEW to us or whose tile price moved
    // from last cycle. Stable catalogs cost zero per-product requests; a catalog with 1 price
    // change this cycle costs 1 extra request. Protects per-request cost from scaling with the
    // size of the catalog.
    const enrichSlugs = new Set();
    for (const p of current) {
        const prev = previous.get(p.slug);
        if (!prev) enrichSlugs.add(p.slug);
        else if (prev.price?.amount !== p.price?.amount) enrichSlugs.add(p.slug);
        else if (prev.variants && prev.variants.length === 0) enrichSlugs.add(p.slug);  // backfill once
    }
    for (const p of current) {
        if (!enrichSlugs.has(p.slug)) continue;
        try {
            const d = await fourthwallScraper.getProductDetails(handle, p.slug);
            if (d) {
                p.internalId = d.internalId || null;
                p.images = d.images || [];
                p.variants = d.variants || [];
            }
        } catch (err) {
            logger.warn('[FW Tracker] enrichment failed', { handle, slug: p.slug, err: err.message });
        }
    }
    // Fallback: carry forward previously-stored variants when we skipped enrichment this cycle,
    // so the diff can still compare variant arrays.
    for (const p of current) {
        if (p.variants) continue;
        const prev = previous.get(p.slug);
        if (prev?.variants?.length) p.variants = prev.variants;
    }

    const currentSlugs = new Set(current.map(p => p.slug));
    const removedSlugs = [];
    for (const [slug, prev] of previous) {
        if (prev.status !== 'removed' && !currentSlugs.has(slug)) removedSlugs.push(slug);
    }

    let events = computeProductDiff(previous, current, isFirstScrape);

    // v2: filter low-stock events through the 7-day cooldown so chronically-low variants
    // don't spam every cycle.
    const lowEvents = events.filter(e => e.type === 'variant_low_stock');
    if (lowEvents.length) {
        const kept = await filterLowStockByCooldown(handle, lowEvents);
        const keptSet = new Set(kept);
        events = events.filter(e => e.type !== 'variant_low_stock' || keptSet.has(e));
    }

    // v2: record price_drop + price_increase into fourthwall_price_history and, if the drop
    // beats the 15% / 30-day baseline threshold, upgrade the event type to 'sale'. The embed
    // then renders the dedicated SALE badge.
    for (const e of events) {
        if (e.type === 'price_drop' || e.type === 'price_increase') {
            recordPriceHistory(handle, e.product.slug, e.newPrice?.amount, e.newPrice?.currency);
        }
        if (e.type === 'price_drop' && Number.isFinite(e.newPrice?.amount)) {
            const sale = await isPriceDropASale(handle, e.product.slug, e.newPrice.amount);
            if (sale) e.isSale = true;
        }
    }

    // Persist the snapshot BEFORE announcing — if Discord sends fail, we don't
    // re-announce the same event next cycle.
    await writeCurrentSnapshot(handle, current, removedSlugs);

    if (events.length === 0) {
        await pool.execute(
            `UPDATE fourthwall_tracked_shops
             SET last_checked_at = NOW(), last_error = NULL, consecutive_failures = 0,
                 shop_name = COALESCE(shop_name, ?)
             WHERE shop_handle = ?`,
            [shop.name || null, handle]);
        return;
    }

    // Cap announcements per shop per cycle.
    const capped = events.slice(0, MAX_ANNOUNCE_PER_SHOP_PER_CYCLE);
    const skipped = events.length - capped.length;

    const [subs] = await pool.execute(
        `SELECT * FROM fourthwall_tracked_shops WHERE shop_handle = ?`, [handle]);

    for (const sub of subs) {
        const client = botManager.getClientForGuild(sub.guild_id);
        if (!client) continue;
        const channel = await client.channels.fetch(sub.channel_id).catch(() => null);
        if (!channel) continue;

        for (const event of capped) {
            const flagCol = EVENT_FLAG_MAP[event.type];
            if (!flagCol || !sub[flagCol]) continue;
            const embed = buildEventEmbed(handle, shop.name || sub.shop_name, event);
            await channel.send({ embeds: [embed], allowedMentions: { parse: [] } })
                .catch(err => logger.warn('[FW Tracker] send failed', {
                    handle, channel: sub.channel_id, err: err.message }));
            addEvents(1);
        }
        if (skipped > 0) {
            await channel.send({
                content: `…and ${skipped} more change(s) suppressed this cycle for **${handle}**.`,
                allowedMentions: { parse: [] }
            }).catch(() => {});
        }
    }

    await pool.execute(
        `UPDATE fourthwall_tracked_shops
         SET last_checked_at = NOW(), last_error = NULL, consecutive_failures = 0,
             shop_name = COALESCE(shop_name, ?)
         WHERE shop_handle = ?`,
        [shop.name || null, handle]);
}

export default {
    subscribe, unsubscribe, listSubscriptions,
    runCycle, computeProductDiff, buildEventEmbed
};
