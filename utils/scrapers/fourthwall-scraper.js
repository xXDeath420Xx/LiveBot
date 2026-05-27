/**
 * Public Fourthwall shop scraper — no auth required.
 *
 * Fourthwall storefront pages are rendered server-side (themes.fourthwall.dev),
 * with shop info exposed as `window.shopId` / `window.shopName` script globals
 * and products as `<div class="product-tile">` blocks with `/products/<slug>` hrefs.
 *
 * Used when we want to browse a shop that we don't own (no per-shop ptkn_).
 * For shops the user has connected via /fourthwall setup, the Storefront API
 * is faster and more accurate — fall back to scraping only when no token exists.
 *
 * 5-minute in-memory cache per (handle, kind) to avoid hammering shops.
 */

import axios from 'axios';
import logger from '../logger.js';

const BASE_URL = (handle) => `https://${handle}.fourthwall.com`;
const TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 5 * 60_000;

const cache = new Map(); // key -> { value, expires }

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) { cache.delete(key); return null; }
    return hit.value;
}

function cacheSet(key, value) {
    cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

const client = axios.create({
    timeout: TIMEOUT_MS,
    headers: {
        'User-Agent': 'Mozilla/5.0 (CertiFriedUtility/1.0; +https://github.com/xXDeath420Xx)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9'
    },
    decompress: true,
    validateStatus: s => s === 200 || s === 404,
    maxRedirects: 3
});

function validateHandle(handle) {
    if (typeof handle !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(handle)) {
        throw new Error('Invalid Fourthwall shop handle');
    }
    return handle.toLowerCase();
}

function decodeHtmlEntities(s) {
    if (!s) return s;
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

function extractFirst(re, html, group = 1) {
    const m = re.exec(html);
    return m ? decodeHtmlEntities(m[group].trim()) : null;
}

function extractMeta(name, html) {
    const re = new RegExp(`<meta[^>]+(?:property|name)="${name}"[^>]+content="([^"]+)"`, 'i');
    return extractFirst(re, html);
}

async function fetchHtml(url) {
    const resp = await client.get(url);
    if (resp.status !== 200) {
        const err = new Error(`Fourthwall page returned ${resp.status} for ${url}`);
        err.status = resp.status;
        throw err;
    }
    return resp.data;
}

export async function getShop(rawHandle) {
    const handle = validateHandle(rawHandle);
    const key = `shop:${handle}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    let html;
    try {
        html = await fetchHtml(BASE_URL(handle) + '/');
    } catch (err) {
        if (err.status === 404) throw new Error(`Fourthwall shop "${handle}" not found`);
        throw err;
    }

    const shopName = extractFirst(/window\.shopName\s*=\s*['"]([^'"]+)['"]/, html);
    const shopId = extractFirst(/window\.shopId\s*=\s*['"]([^'"]+)['"]/, html);
    const description = extractMeta('og:description', html) || extractMeta('description', html);
    const ogImage = extractMeta('og:image', html);
    const canonical = extractFirst(/<link\s+rel="canonical"\s+href="([^"]+)"/i, html)
        || BASE_URL(handle) + '/';

    // Featured product handles for quick discovery.
    const productHandles = new Set();
    const productRe = /\/products\/([a-z0-9-]+)/gi;
    let m;
    while ((m = productRe.exec(html)) !== null) {
        productHandles.add(m[1].toLowerCase());
    }

    if (!shopName && !shopId) {
        // Page exists but doesn't look like a Fourthwall shop (e.g., custom domain mismatch).
        logger.warn('[FW Scraper] page missing FW markers', { handle });
    }

    const result = {
        handle,
        name: shopName,
        id: shopId,
        description,
        image: ogImage,
        url: canonical,
        productHandles: Array.from(productHandles).slice(0, 50)
    };
    cacheSet(key, result);
    return result;
}

function parseMoney(text) {
    if (!text) return null;
    const cleaned = text.replace(/[ \s,]+/g, ' ').trim();
    const m = /([£$€¥₹])?\s*([\d.]+)/.exec(cleaned);
    if (!m) return null;
    return { display: cleaned, currencySymbol: m[1] || null, amount: Number(m[2]) };
}

export async function getProduct(rawHandle, rawSlug) {
    const handle = validateHandle(rawHandle);
    const slug = String(rawSlug || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{1,200}$/.test(slug)) throw new Error('Invalid product slug');

    const key = `product:${handle}:${slug}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    let html;
    try {
        html = await fetchHtml(`${BASE_URL(handle)}/products/${slug}/`);
    } catch (err) {
        if (err.status === 404) throw new Error(`Product "${slug}" not found on shop "${handle}"`);
        throw err;
    }

    const name = extractMeta('og:title', html) || extractFirst(/<title>([^<]+)<\/title>/i, html);
    const description = extractMeta('og:description', html) || extractMeta('description', html);
    const image = extractMeta('og:image', html);
    const priceText = extractMeta('product:price:amount', html);
    const currency = extractMeta('product:price:currency', html);
    const url = extractMeta('og:url', html) || `${BASE_URL(handle)}/products/${slug}/`;

    let price = null;
    if (priceText) {
        price = {
            amount: Math.round(Number(priceText) * 100), // minor units to match formatCurrency expectations
            currency: currency || 'USD',
            display: currency ? `${priceText} ${currency}` : priceText
        };
    } else {
        // Fallback: parse the rendered price span on the page.
        const fallback = extractFirst(/<span[^>]+(?:class|data-testid)="[^"]*price[^"]*"[^>]*>([^<]+)<\/span>/i, html);
        const parsed = parseMoney(fallback);
        if (parsed) price = { amount: Math.round(parsed.amount * 100), currency: 'USD', display: parsed.display };
    }

    const result = {
        handle, slug,
        name: name ? name.replace(/\s+\|\s+.*$/, '').trim() : slug,
        description, image, url, price
    };
    cacheSet(key, result);
    return result;
}

export async function getCollection(rawHandle, rawSlug) {
    const handle = validateHandle(rawHandle);
    const slug = String(rawSlug || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{1,200}$/.test(slug)) throw new Error('Invalid collection slug');

    const key = `collection:${handle}:${slug}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    let html;
    try {
        html = await fetchHtml(`${BASE_URL(handle)}/collections/${slug}/`);
    } catch (err) {
        if (err.status === 404) throw new Error(`Collection "${slug}" not found on shop "${handle}"`);
        throw err;
    }

    const name = extractMeta('og:title', html);
    const description = extractMeta('og:description', html);
    const productHandles = new Set();
    const productRe = /\/products\/([a-z0-9-]+)/gi;
    let m;
    while ((m = productRe.exec(html)) !== null) productHandles.add(m[1].toLowerCase());

    const result = {
        handle, slug,
        name: name || slug,
        description,
        productHandles: Array.from(productHandles).slice(0, 50)
    };
    cacheSet(key, result);
    return result;
}

export async function searchProducts(rawHandle, query) {
    const handle = validateHandle(rawHandle);
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { handle, query: '', products: [] };

    // No public search API; pull the shop page + a handful of featured handles,
    // then filter by substring match on the handle text. Good enough for v1 —
    // shop owners with deep catalogs should connect properly and use the Storefront API.
    const shop = await getShop(handle);
    const matches = shop.productHandles.filter(h => h.includes(q.replace(/\s+/g, '-')));

    // Hydrate top matches with full product detail (sequential to be polite).
    const products = [];
    for (const slug of matches.slice(0, 5)) {
        try {
            products.push(await getProduct(handle, slug));
        } catch (err) {
            logger.warn('[FW Scraper] search hydrate failed', { handle, slug, err: err.message });
        }
    }
    return { handle, query: q, products };
}

export default { getShop, getProduct, getCollection, searchProducts };
