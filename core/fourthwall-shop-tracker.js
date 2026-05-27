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
import { sanitizeUserText, truncate, formatCurrency, EMBED_DEFAULT_COLOR } from './fourthwall-helpers.js';

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
        const shop = await fourthwallScraper.getShop(handle);
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
        `SELECT slug, name, image_url, price_minor_units, currency, last_status
         FROM fourthwall_tracked_products WHERE shop_handle = ?`,
        [shopHandle]);
    const map = new Map();
    for (const r of rows) {
        map.set(r.slug, {
            slug: r.slug,
            name: r.name,
            image: r.image_url,
            price: r.price_minor_units != null
                ? { amount: r.price_minor_units, currency: r.currency || 'USD' }
                : null,
            status: r.last_status
        });
    }
    return map;
}

async function writeCurrentSnapshot(shopHandle, currentProducts, removedSlugs) {
    if (currentProducts.length) {
        // Bulk upsert: one row per current product, status=active.
        const placeholders = currentProducts.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
        const params = [];
        for (const p of currentProducts) {
            params.push(
                shopHandle,
                p.slug.slice(0, 200),
                p.name ? p.name.slice(0, 255) : null,
                p.image || null,
                p.price?.amount ?? null,
                p.price?.currency || null,
                'active'
            );
        }
        await pool.execute(
            `INSERT INTO fourthwall_tracked_products
                (shop_handle, slug, name, image_url, price_minor_units, currency, last_status)
             VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE
                name = VALUES(name),
                image_url = VALUES(image_url),
                price_minor_units = VALUES(price_minor_units),
                currency = VALUES(currency),
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
export function computeProductDiff(previous, current, isFirstScrape) {
    // Default implementation: just announce new products, silent on first scrape.
    // Replace with your own logic — see the request in chat.
    const events = [];
    if (isFirstScrape) return events;

    for (const p of current) {
        const prev = previous.get(p.slug);
        if (!prev) {
            events.push({ type: 'new_product', product: p });
        }
    }
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
                .setTitle(`📉 Price drop: ${sanitizeUserText(p.name || p.slug)}`)
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
        default:
            return base.setTitle(sanitizeUserText(p.name || p.slug));
    }
}

const EVENT_FLAG_MAP = {
    new_product: 'notify_new_products',
    price_drop: 'notify_price_drops',
    price_increase: 'notify_price_increases',
    sold_out: 'notify_sold_out',
    restocked: 'notify_restocked'
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

async function processShop(handle, addEvents) {
    const previous = await loadPreviousSnapshot(handle);
    const isFirstScrape = previous.size === 0;

    const shop = await fourthwallScraper.getShop(handle);
    const current = shop.products || [];

    const currentSlugs = new Set(current.map(p => p.slug));
    const removedSlugs = [];
    for (const [slug, prev] of previous) {
        if (prev.status !== 'removed' && !currentSlugs.has(slug)) removedSlugs.push(slug);
    }

    const events = computeProductDiff(previous, current, isFirstScrape);

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
