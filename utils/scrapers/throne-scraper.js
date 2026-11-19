import axios from 'axios';
import logger from '../logger.js';
import { enforceSizeLimit, cleanupExpiredEntries } from '../cacheUtils.js';

const LOG_TAG = '[ThroneScraper]';

// ─── Custom Errors ───────────────────────────────────────────────
class ThroneError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'ThroneError';
        this.code = code;
    }
}

export class ThroneUserNotFoundError extends ThroneError {
    constructor(username) {
        super(`Throne user "${username}" not found`, 'THRONE_USER_NOT_FOUND');
    }
}

export class ThroneUnavailableError extends ThroneError {
    constructor(message = 'Throne is unavailable') {
        super(message, 'THRONE_UNAVAILABLE');
    }
}

export class ThroneParseError extends ThroneError {
    constructor(message = 'Failed to parse Throne data') {
        super(message, 'THRONE_PARSE_ERROR');
    }
}

// ─── Normalisation ───────────────────────────────────────────────

/**
 * Normalise user input (URL, @handle, bare slug) into the Throne username. Returns null
 * when the input is unusable (empty, control characters only, obviously not a Throne URL).
 */
export function normalizeThroneUsername(input) {
    if (!input) return null;
    let s = String(input).trim();
    if (!s) return null;

    // Users sometimes paste the slash-command option as `key:value` into the username field
    // (e.g. `creator:death420`). Strip a recognised option-name prefix so the colon doesn't
    // get silently dropped by the sanitiser below, which previously turned `creator:death420`
    // into `creatordeath420` → tracked a nonexistent Throne user → silent failure.
    const kvMatch = s.match(/^\s*(?:creator|user|username|handle|name)\s*:\s*(.+)$/i);
    if (kvMatch) s = kvMatch[1].trim();

    // throne.com/<user>, throne.me/<user>, with or without protocol
    const urlMatch = s.match(/throne\.(?:com|me)\/([^\/?#\s]+)/i);
    if (urlMatch) s = urlMatch[1];

    s = s.replace(/^@+/, '').trim();
    // allow a–z, 0–9, dot, dash, underscore (Throne's own slug rule)
    s = s.replace(/[^A-Za-z0-9._-]/g, '');
    return s ? s.toLowerCase() : null;
}

// ─── Cache ───────────────────────────────────────────────────────

const CACHE_TTL = {
    profile: 2 * 60 * 1000,
    wishlist: 2 * 60 * 1000,
    collections: 5 * 60 * 1000,
    gifts: 60 * 1000, // 1 min — scheduler is 2 min, cache was effectively doubling our cadence
    leaderboard_allTime: 5 * 60 * 1000,
    leaderboard_lastMonth: 5 * 60 * 1000,
    leaderboard_lastWeek: 5 * 60 * 1000,
    recentGifters: 5 * 60 * 1000,
};

const cache = new Map();
const MAX_CACHE_ENTRIES = 500;
let lastCacheSweep = 0;
const CACHE_SWEEP_INTERVAL = 60 * 1000;

function getCacheKey(username, type) {
    return `${type}:${username}`;
}

function getCached(username, type) {
    maybeSweepCache();
    const key = getCacheKey(username, type);
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > (CACHE_TTL[type] || 60000)) {
        cache.delete(key);
        return null;
    }
    return hit.value;
}

function setCache(username, type, value) {
    cache.set(getCacheKey(username, type), { at: Date.now(), value });
    maybeSweepCache();
}

function maybeSweepCache() {
    if (Date.now() - lastCacheSweep < CACHE_SWEEP_INTERVAL) return;
    lastCacheSweep = Date.now();
    cleanupExpiredEntries(cache, (v, _k) => Date.now() - v.at > 10 * 60 * 1000);
    enforceSizeLimit(cache, MAX_CACHE_ENTRIES);
}

// ─── Cooldown (per-user, keeps us from hammering Firestore on repeat lookups) ──
const COOLDOWN_MS = 500;
const lastRequestAt = new Map();

async function waitForCooldown(username) {
    const last = lastRequestAt.get(username) || 0;
    const wait = COOLDOWN_MS - (Date.now() - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt.set(username, Date.now());
}

// ─── Transport ───────────────────────────────────────────────────

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIRESTORE_PROJECT = 'onlywish-9d17b';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents`;
const THRONE_API_BASE = `https://us-central1-${FIRESTORE_PROJECT}.cloudfunctions.net`;

const AXIOS_DEFAULTS = Object.freeze({
    timeout: 12000,
    maxContentLength: 10 * 1024 * 1024,
    headers: {
        'Origin': 'https://throne.com',
        'Referer': 'https://throne.com/',
        'User-Agent': USER_AGENT,
    },
});

/**
 * Unwrap a single Firestore typed value into a plain JS value.
 */
function fsVal(v) {
    if (v == null) return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return parseInt(v.integerValue, 10);
    if ('doubleValue' in v) return v.doubleValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('nullValue' in v) return null;
    if ('mapValue' in v) return fsFields(v.mapValue.fields || {});
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsVal);
    return null;
}

function fsFields(fields) {
    const out = {};
    for (const k of Object.keys(fields || {})) out[k] = fsVal(fields[k]);
    return out;
}

/**
 * Resolve a Throne username to its Firestore creator document.
 *
 * The `creators` collection is public-queryable via Firestore `runQuery` with a username
 * filter. The returned document carries every field we used to parse out of Vercel's SSR
 * fallback — identity, permission flags, customization, platform, social links, interests,
 * timestamps — and does so from a datacenter IP with no proxy, Tor, or Puppeteer.
 *
 * Fields a creator has NOT set are absent from the doc (not null); callers coalesce.
 */
async function fetchCreatorByUsername(username) {
    const url = `${FIRESTORE_BASE}:runQuery`;
    try {
        const res = await axios.post(url, {
            structuredQuery: {
                from: [{ collectionId: 'creators' }],
                where: {
                    fieldFilter: {
                        field: { fieldPath: 'username' },
                        op: 'EQUAL',
                        value: { stringValue: username },
                    },
                },
                limit: 1,
            },
        }, AXIOS_DEFAULTS);
        const rows = Array.isArray(res.data) ? res.data : [];
        const doc = rows.find(r => r.document)?.document;
        if (!doc) throw new ThroneUserNotFoundError(username);
        const creatorId = doc.name.split('/').pop();
        const fields = fsFields(doc.fields || {});
        return { creatorId, fields };
    } catch (error) {
        if (error instanceof ThroneUserNotFoundError) throw error;
        if (error.response?.status === 403) {
            // Firestore rules changed. Treat as transient — a config change on their end rather
            // than a per-user issue; retry on the next cycle without poisoning the cache.
            throw new ThroneUnavailableError(`Firestore refused creator query (403) — rules may have changed: ${error.message}`);
        }
        throw new ThroneUnavailableError(`Firestore creator query failed for ${username}: ${error.message}`);
    }
}

/**
 * Query a Firestore subcollection under `creators/<creatorId>` via runQuery.
 */
async function fetchCreatorSubcollection(creatorId, collectionId) {
    // creatorId carries a colon (e.g. "twitch:412729734"); Firestore accepts it raw in the path,
    // and resolves the trailing ":runQuery" as the method (verified against the live API).
    const url = `${FIRESTORE_BASE}/creators/${creatorId}:runQuery`;
    try {
        const res = await axios.post(
            url,
            { structuredQuery: { from: [{ collectionId }] } },
            AXIOS_DEFAULTS,
        );
        const rows = Array.isArray(res.data) ? res.data : [];
        return rows
            .filter(r => r.document)
            .map(r => ({ _docId: r.document.name.split('/').pop(), ...fsFields(r.document.fields) }));
    } catch (error) {
        if (error.response?.status === 404) return [];
        throw new ThroneUnavailableError(`Firestore query failed for ${creatorId}/${collectionId}: ${error.message}`);
    }
}

/**
 * Fetch public gift orders for a creator from Throne's Cloud Functions API.
 */
async function fetchPublicOrders(creatorId) {
    const url = `${THRONE_API_BASE}/api-order/v1/order/public/received/wishlist/${encodeURIComponent(creatorId)}`;
    try {
        const res = await axios.get(url, AXIOS_DEFAULTS);
        return Array.isArray(res.data) ? res.data : [];
    } catch (error) {
        if (error.response?.status === 404) return [];
        throw new ThroneUnavailableError(`Throne order API failed for ${creatorId}: ${error.message}`);
    }
}

/**
 * Fetch leaderboard + recent-gifters data for a creator from Throne's Cloud Functions API.
 * Returns `{ leaderboardAllTime, leaderboardLastWeek, leaderboardLastMonth, lastTwentyGifters }`.
 * Replaces the old `fetchGiftersPageOrNull` + fallback-key digging — this is the same payload
 * Throne's own Vercel SSR calls to populate the gifters page.
 */
async function fetchLeaderboardDirect(creatorId) {
    const url = `${THRONE_API_BASE}/api-leaderboard/v1/leaderboard/${encodeURIComponent(creatorId)}`;
    try {
        const res = await axios.get(url, AXIOS_DEFAULTS);
        if (!res.data || typeof res.data !== 'object') return null;
        return res.data;
    } catch (error) {
        if (error.response?.status === 404) return null;
        // A creator who hides their leaderboard still returns 200 with empty arrays; a 403 /
        // 500 is a real failure, not a hidden-leaderboard case.
        throw new ThroneUnavailableError(`Throne leaderboard API failed for ${creatorId}: ${error.message}`);
    }
}

// ─── Formatting helpers ──────────────────────────────────────────

function centsToDollars(cents) {
    const n = Number(cents) || 0;
    return n / 100;
}

function formatPrice(cents, currency = 'USD') {
    const amount = centsToDollars(cents);
    try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
    } catch {
        return `${amount.toFixed(2)} ${currency}`;
    }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Fetch a Throne creator's profile.
 *
 * Shape matches the previous SSR-based implementation plus new permission flags surfaced
 * by Wave 11-track-A: callers (`cacheProfileAndWishlist`, embed builders, notification
 * posters) can read any new flag by name without changing the function's contract on the
 * fields they already consumed.
 */
export async function fetchThroneProfile(username, { force = false } = {}) {
    const handle = normalizeThroneUsername(username);
    if (!handle) throw new ThroneUserNotFoundError(String(username));

    if (!force) {
        const cached = getCached(handle, 'profile');
        if (cached) return cached;
    }

    await waitForCooldown(handle);
    const { creatorId, fields } = await fetchCreatorByUsername(handle);

    // Platform is sometimes absent but is encoded in the creatorId prefix ("twitch:…" etc.).
    const platformFromId = (creatorId.split(':', 1)[0] || '').toLowerCase();
    const mainContentPlatform = fields.mainContentPlatform
        || (platformFromId && platformFromId !== 'u' ? platformFromId.replace(/^./, c => c.toUpperCase()) : null);

    const profile = {
        id: creatorId,
        username: fields.username || handle,
        displayName: fields.displayName || fields.username || handle,
        bio: fields.bio || null,
        // Firestore's public `creators` doc does not carry `birthday` (it is on a private
        // sub-document). We no longer surface birthday from the live fetch; the field is kept
        // for backward compatibility with the old DB column.
        birthday: null,
        pictureUrl: fields.pictureUrl || null,
        backgroundPictureUrl: fields.backgroundPictureUrl || null,
        mainContentPlatform,
        socialLinks: Array.isArray(fields.socialLinks) ? fields.socialLinks.map(link => ({
            type: link?.type || null,
            name: link?.name || null,
            url: link?.url || null,
        })) : [],
        interests: Array.isArray(fields.interests) ? fields.interests : [],
        createdAt: fields.createdAt ? new Date(fields.createdAt) : null,
        updatedAt: fields.updatedAt ? new Date(fields.updatedAt) : null,
        wishlistEnabledAt: fields.wishlistEnabledAt ? new Date(fields.wishlistEnabledAt) : null,
        profileUrl: `https://throne.com/${handle}`,

        // Permission flags — honoured by notification posters and the public dashboard. All
        // default-true to match Throne's own default: "if the creator hasn't opted out, show".
        showLeaderboard: fields.showLeaderboard ?? true,
        showLeaderboardAmounts: fields.showLeaderboardAmounts ?? true,
        showPreviousGifts: fields.showPreviousGifts ?? true,
        showRecentGifters: fields.showRecentGifters ?? true,
        showWishlist: fields.showWishlist ?? true,
        showStorefront: fields.showStorefront ?? false,
        allowGifterName: fields.allowGifterName ?? true,
        allowGiftMessages: fields.allowGiftMessages ?? true,
        allowSuggestionMessages: fields.allowSuggestionMessages ?? true,
        allowSuggestions: fields.allowSuggestions ?? true,
        allowPreviousGiftProductLinks: fields.allowPreviousGiftProductLinks ?? true,
        hideGifterMessages: fields.hideGifterMessages ?? false,
        hideOwnPurchases: fields.hideOwnPurchases ?? false,
        isNSFW: fields.isNSFW ?? false,
        blurNSFWProducts: fields.blurNSFWProducts ?? false,

        // Lifecycle flags.
        isOffWaitlist: fields.isOffWaitlist ?? false,
        needsVerification: fields.needsVerification ?? false,

        // Customization — mapValue; shape is `{ colorScheme: 'candy' | ... }` today but will
        // grow. Stored verbatim so the dashboard can render whatever Throne adds without
        // another schema change.
        creatorPageCustomization: fields.creatorPageCustomization || null,
    };

    setCache(handle, 'profile', profile);
    return profile;
}

/**
 * Fetch a Throne creator's wishlist items from the Firestore subcollection.
 */
export async function fetchThroneWishlist(username, { force = false } = {}) {
    if (!force) {
        const cached = getCached(username, 'wishlist');
        if (cached) return cached;
    }

    const profile = await fetchThroneProfile(username, { force });
    const rawItems = await fetchCreatorSubcollection(profile.id, 'wishlistItems');

    const items = rawItems.map(item => ({
        id: item.id || item._docId,
        name: item.name,
        price: centsToDollars(item.price),
        priceRaw: item.price || 0,
        currency: item.currency || 'USD',
        priceFormatted: formatPrice(item.price, item.currency),
        shipping: centsToDollars(item.shipping),
        totalContribution: centsToDollars(item.totalContributionPrice),
        totalContributionFormatted: item.totalContributionPrice
            ? formatPrice(item.totalContributionPrice, item.currency || 'USD')
            : null,
        quantity: item.quantity || 1,
        isDigital: item.itemType === 'digital' || !!item.isDigitalGood,
        isAvailable: item.isAvailable !== false && !item.notInStock,
        notInStock: !!item.notInStock,
        isFeatured: !!item.isFeatured,
        isCrowdfunded: !!item.isCrowdfunded,
        fundingPercentage: item.totalContributionPrice && item.price
            ? Math.min(100, Math.round(((item.totalContributionPrice || 0) / item.price) * 100))
            : 0,
        imageUrl: item.imgLink || item.image || item.imageSrc || null,
        link: item.link || item.productLink || null,
        collectionIds: Array.isArray(item.collectionIds) ? item.collectionIds : [],
        createdAt: item.createdAt ? new Date(item.createdAt) : null,
    }));

    setCache(username, 'wishlist', items);
    return items;
}

/**
 * Fetch a Throne creator's wishlist collections.
 */
export async function fetchThroneCollections(username) {
    const cached = getCached(username, 'collections');
    if (cached) return cached;

    const profile = await fetchThroneProfile(username);
    const rawCollections = await fetchCreatorSubcollection(profile.id, 'wishlistCollections');
    const items = await fetchThroneWishlist(username);

    const collections = rawCollections.map(col => {
        col.id = col.id || col._docId;
        const collectionItems = items.filter(item => (item.collectionIds || []).includes(col.id));
        const totalPrice = collectionItems.reduce((sum, item) => sum + (item.priceRaw || 0), 0);
        const currency = collectionItems[0]?.currency || 'USD';

        return {
            id: col.id,
            title: col.title || col.name,
            description: col.description || null,
            imageUrl: col.imageSrc || col.imgLink || col.imageLink || null,
            itemCount: collectionItems.length,
            totalPrice: centsToDollars(totalPrice),
            totalPriceFormatted: formatPrice(totalPrice, currency),
            currency,
            createdAt: col.createdAt ? new Date(col.createdAt) : null,
        };
    });

    setCache(username, 'collections', collections);
    return collections;
}

/**
 * Fetch a Throne creator's gift history.
 */
export async function fetchThroneGiftHistory(username) {
    const cached = getCached(username, 'gifts');
    if (cached) return cached;

    const profile = await fetchThroneProfile(username);
    const rawGifts = await fetchPublicOrders(profile.id);

    if (rawGifts.length === 0) {
        logger.info(`${LOG_TAG} No public orders for "${username}" (creator ${profile.id})`);
        setCache(username, 'gifts', []);
        return [];
    }

    // Gift object shape MUST match what core/throne-manager.js consumes end-to-end:
    //   id, name, purchasedAt (Date|null), status ('Crowdfunded'|'Purchased'),
    //   isComplete, isDigital, isCrowdfunded, imageUrl, link, totalFormatted (string|null),
    //   currency, totalCents, gifters[].{username, imageUrl, message, amountCents,
    //   amountFormatted (null when amount is not public)}, contributorCount.
    //
    // The INSERT in checkForNewGiftsAndContributions binds (gift.id, gift.name, gift.status,
    // gift.isCrowdfunded, gift.contributorCount) — if any of these resolves to undefined
    // mysql2 strict-mode rejects the whole statement. The `.filter(g => g.id)` guard at the
    // end drops gifts without an id for the same reason (anonymous crowdfund aggregates
    // occasionally return without one from Throne's Cloud Function). Webhook events share
    // this shape via the dispatcher in dashboard/routes/webhooks/throne.js — do not change
    // field names without updating both.
    const gifts = rawGifts.map(gift => {
        const customers = gift.customizations?.customers || [];
        const contributedCents = customers.reduce(
            (sum, c) => sum + (Number(c.contributionUsd) || 0), 0);
        const hasContributions = contributedCents > 0;
        const listedPrice = Number(gift.price) || 0;
        const totalCents = hasContributions ? Math.round(contributedCents)
            : (listedPrice > 0 ? listedPrice : null);
        const currency = gift.currency || 'USD';
        // Throne's Cloud Function returns the gift timestamp as `purchasedAt` (ms epoch).
        // Legacy fallback to `createdAt` kept for safety in case the payload ever drifts back.
        const ts = Number(gift.purchasedAt ?? gift.createdAt);

        const isCrowdfunded = !!gift.isCrowdfunded;
        return {
            id: gift.itemId || gift.id || gift._id || gift.orderId || null,
            name: gift.name || 'Unknown item',
            purchasedAt: Number.isFinite(ts) && ts > 0 ? new Date(ts) : null,
            status: isCrowdfunded ? 'Crowdfunded' : 'Purchased',
            isComplete: null,
            isDigital: null,
            isCrowdfunded,
            imageUrl: gift.imageSrc || gift.imgLink || gift.image || null,
            link: gift.link || gift.productLink || null,
            totalFormatted: totalCents == null ? null : formatPrice(totalCents, currency),
            currency,
            totalCents,
            gifters: customers.map(c => ({
                username: c.customerUsername || c.gifterUsername || c.name || 'Anonymous',
                imageUrl: c.customerImage || c.gifterImage || null,
                message: c.customerMessage || c.message || null,
                amountCents: Number(c.contributionUsd) || null,
                amountFormatted: Number(c.contributionUsd) > 0
                    ? formatPrice(Number(c.contributionUsd), 'USD') : null,
            })),
            contributorCount: customers.length,
        };
    }).filter(g => {
        // No id → cannot de-duplicate against throne_seen_gifts → would reintroduce the
        // "Bind parameters must not contain undefined" crash downstream. Drop + warn.
        if (g.id) return true;
        logger.warn(`${LOG_TAG} Skipping gift with no id for "${username}": ${g.name}`);
        return false;
    });

    logger.info(`${LOG_TAG} Fetched ${gifts.length} gift(s) for "${username}"`);

    setCache(username, 'gifts', gifts);
    return gifts;
}

/**
 * Fetch a Throne creator's leaderboard for a given period.
 */
export async function fetchThroneLeaderboard(username, period = 'allTime') {
    const cacheKey = `leaderboard_${period}`;
    const cached = getCached(username, cacheKey);
    if (cached) return cached;

    const profile = await fetchThroneProfile(username);
    const data = await fetchLeaderboardDirect(profile.id);
    if (!data) { setCache(username, cacheKey, []); return []; }

    const periodKeyMap = {
        allTime: 'leaderboardAllTime',
        lastMonth: 'leaderboardLastMonth',
        lastWeek: 'leaderboardLastWeek',
    };

    const periodKey = periodKeyMap[period] || 'leaderboardAllTime';
    const rawEntries = Array.isArray(data[periodKey]) ? data[periodKey] : [];

    const entries = rawEntries.map((entry, index) => ({
        rank: index + 1,
        username: entry.gifterUsername || 'Anonymous',
        imageUrl: entry.gifterImage || null,
        giftCount: entry.totalPaymentNumber || 0,
        totalSpentFormatted: formatPrice(entry.totalAmountSpentUSD, 'USD'),
        totalSpentCents: entry.totalAmountSpentUSD || 0,
    }));

    setCache(username, cacheKey, entries);
    return entries;
}

/**
 * Fetch the last 20 recent gifters (chronological, not ranked) for a creator.
 */
export async function fetchRecentGifters(username) {
    const cached = getCached(username, 'recentGifters');
    if (cached) return cached;

    const profile = await fetchThroneProfile(username);
    const data = await fetchLeaderboardDirect(profile.id);
    if (!data) { setCache(username, 'recentGifters', []); return []; }

    const rawGifters = Array.isArray(data.lastTwentyGifters) ? data.lastTwentyGifters : [];
    const gifters = rawGifters.map(g => ({
        username: g.gifterUsername || 'Anonymous',
        imageUrl: g.gifterImage || null,
        giftCount: g.totalPaymentNumber || 0,
        totalSpentCents: g.totalAmountSpentUSD || 0,
        totalSpentFormatted: formatPrice(g.totalAmountSpentUSD, 'USD'),
    }));

    setCache(username, 'recentGifters', gifters);
    return gifters;
}

export { formatPrice, centsToDollars };
