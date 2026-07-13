import axios from 'axios';
import net from 'net';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import logger from '../logger.js';
import { enforceSizeLimit, cleanupExpiredEntries } from '../cacheUtils.js';

puppeteer.use(StealthPlugin());

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

// ─── Cache ───────────────────────────────────────────────────────
const cache = new Map();
const MAX_CACHE_SIZE = 500;
const CACHE_TTL = {
    profile: 2 * 60 * 1000,       // 2 minutes (matches scheduler interval)
    wishlist: 2 * 60 * 1000,
    collections: 5 * 60 * 1000,   // 5 minutes
    gifts: 5 * 60 * 1000,         // 5 minutes
    leaderboard: 5 * 60 * 1000,
};

// Per-username request cooldown (2s between requests to same page)
const requestCooldowns = new Map();
const REQUEST_COOLDOWN_MS = 2000;


// Periodic cache cleanup
setInterval(() => {
    cleanupExpiredEntries(cache, Math.max(...Object.values(CACHE_TTL)), 'timestamp', 'throne-cache');
}, 60 * 1000);

function getCacheKey(username, type) {
    return `throne:${username.toLowerCase()}:${type}`;
}

function getCached(username, type) {
    const key = getCacheKey(username, type);
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > (CACHE_TTL[type] || CACHE_TTL.profile)) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(username, type, data) {
    const key = getCacheKey(username, type);
    cache.set(key, { data, timestamp: Date.now() });
    enforceSizeLimit(cache, MAX_CACHE_SIZE, 'throne-cache');
}

// ─── HTTP / Puppeteer Fetching ───────────────────────────────────
import { SocksProxyAgent } from 'socks-proxy-agent';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const torAgent = new SocksProxyAgent('socks5h://127.0.0.1:9050');

// Vercel challenge cookies — Puppeteer solves once, axios reuses
let vercelCookies = null;
let cookiesExpireAt = 0;

function buildAxiosConfig() {
    const config = {
        timeout: 10000,
        maxContentLength: 5 * 1024 * 1024,
        httpAgent: torAgent,
        httpsAgent: torAgent,
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
        },
    };

    if (vercelCookies && Date.now() < cookiesExpireAt) {
        config.headers['Cookie'] = vercelCookies;
    }

    return config;
}

async function waitForCooldown(username) {
    const key = username.toLowerCase();
    const last = requestCooldowns.get(key);
    if (last) {
        const elapsed = Date.now() - last;
        if (elapsed < REQUEST_COOLDOWN_MS) {
            await new Promise(resolve => setTimeout(resolve, REQUEST_COOLDOWN_MS - elapsed));
        }
    }
    requestCooldowns.set(key, Date.now());
}

function extractNextData(html, url) {
    const startMarker = '<script id="__NEXT_DATA__" type="application/json">';
    const startIndex = html.indexOf(startMarker);
    if (startIndex === -1) {
        throw new ThroneParseError(`__NEXT_DATA__ not found on ${url}`);
    }
    const jsonStart = startIndex + startMarker.length;
    const endIndex = html.indexOf('</script>', jsonStart);
    if (endIndex === -1) {
        throw new ThroneParseError(`Closing </script> not found on ${url}`);
    }
    try {
        return JSON.parse(html.substring(jsonStart, endIndex));
    } catch (e) {
        throw new ThroneParseError(`Failed to parse __NEXT_DATA__ JSON on ${url}: ${e.message}`);
    }
}

// ─── Puppeteer Browser Pool ���─────────────────────────────────────
let browserInstance = null;
let browserLaunchPromise = null;
let lastBrowserUse = 0;
const BROWSER_IDLE_TIMEOUT = 5 * 60 * 1000;

async function getBrowser() {
    if (browserInstance?.connected) {
        lastBrowserUse = Date.now();
        return browserInstance;
    }

    if (browserLaunchPromise) return browserLaunchPromise;

    browserLaunchPromise = (async () => {
        try {
            logger.info(`${LOG_TAG} Launching headless browser`);
            browserInstance = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--disable-extensions',
                    '--proxy-server=socks5://127.0.0.1:9050',
                ],
                executablePath: '/usr/bin/google-chrome',
            });
            lastBrowserUse = Date.now();

            browserInstance.on('disconnected', () => {
                browserInstance = null;
                logger.info(`${LOG_TAG} Browser disconnected`);
            });

            return browserInstance;
        } finally {
            browserLaunchPromise = null;
        }
    })();

    return browserLaunchPromise;
}

// Close idle browser
setInterval(() => {
    if (browserInstance?.connected && Date.now() - lastBrowserUse > BROWSER_IDLE_TIMEOUT) {
        logger.info(`${LOG_TAG} Closing idle browser`);
        browserInstance.close().catch(() => {});
        browserInstance = null;
    }
}, 60 * 1000);

async function fetchWithPuppeteer(url) {
    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
        await page.setViewport({ width: 1280, height: 720 });

        // Navigate with networkidle2 — this waits for the challenge JS to resolve
        // via Tor, which routes through residential exit nodes
        // Tor adds ~20-30s latency, so we use a generous timeout
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        } catch (navError) {
            // Timeout during navigation — Throne or Tor may be slow
            throw new ThroneUnavailableError('Throne request timed out. Try again in a moment.');
        }

        // Check final state
        const pageTitle = await page.title().catch(() => '');
        if (pageTitle.includes('404') || pageTitle.includes('Not Found')) {
            throw new ThroneUserNotFoundError(url);
        }
        if (pageTitle.includes('Security Checkpoint') || pageTitle.includes('Just a moment')) {
            // Challenge didn't resolve — try waiting for one more navigation
            try {
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
            } catch {
                throw new ThroneUnavailableError('Throne is temporarily blocking requests. Try again in a few minutes.');
            }
        }

        // Extract and store Vercel challenge cookies for reuse with axios
        try {
            const cookies = await page.cookies();
            if (cookies.length > 0) {
                vercelCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                // Find the longest-lived cookie expiry, default to 1 hour
                const maxExpiry = Math.max(...cookies.filter(c => c.expires > 0).map(c => c.expires * 1000));
                cookiesExpireAt = maxExpiry > Date.now() ? maxExpiry : Date.now() + 60 * 60 * 1000;
                logger.info(`${LOG_TAG} Captured ${cookies.length} Vercel cookies (valid for ${Math.round((cookiesExpireAt - Date.now()) / 60000)}min)`);
            }
        } catch { /* cookie extraction is best-effort */ }

        return await page.content();
    } finally {
        await page.close().catch(() => {});
    }
}

// ─── Tor Circuit Renewal ─────────────────────────────────────────
async function renewTorCircuit() {
    return new Promise((resolve) => {
        const client = net.createConnection({ host: '127.0.0.1', port: 9051 }, () => {
            client.write('AUTHENTICATE ""\r\n');
            client.write('SIGNAL NEWNYM\r\n');
            client.write('QUIT\r\n');
        });

        client.on('data', () => {}); // drain
        client.on('end', () => {
            logger.info(`${LOG_TAG} Tor circuit renewed via control port`);
            // Wait for new circuit to establish
            setTimeout(resolve, 5000);
        });
        client.on('error', (err) => {
            logger.warn(`${LOG_TAG} Could not renew Tor circuit: ${err.message}`);
            resolve();
        });

        // Timeout safety
        setTimeout(() => { client.destroy(); resolve(); }, 8000);
    });
}

// ─── Main Page Fetcher ───────────────────────────────────────────
async function fetchThronePage(username, path = '') {
    const url = `https://throne.com/${username.toLowerCase()}${path}`;
    await waitForCooldown(username);

    // Fast path: axios via Tor with cached Vercel cookies
    if (vercelCookies && Date.now() < cookiesExpireAt) {
        try {
            const response = await axios.get(url, buildAxiosConfig());
            const data = extractNextData(response.data, url);
            if (!data.isFallback) {
                logger.debug(`${LOG_TAG} Fast fetch (axios+cookies) for ${url}`);
                return data;
            }
        } catch (error) {
            if (error.response?.status === 404) throw new ThroneUserNotFoundError(username);
            // Cookies expired or rejected — fall through to Puppeteer
            if (error.response?.status === 429 || error.response?.status === 403) {
                logger.info(`${LOG_TAG} Cookies expired, re-solving challenge...`);
                vercelCookies = null;
                cookiesExpireAt = 0;
            }
        }
    }

    // Medium path: axios via Tor without cookies (might work if Tor exit isn't blocked)
    if (!vercelCookies) {
        try {
            const response = await axios.get(url, buildAxiosConfig());
            const data = extractNextData(response.data, url);
            if (!data.isFallback) return data;
        } catch (error) {
            if (error instanceof ThroneError) throw error;
            if (error.response?.status === 404) throw new ThroneUserNotFoundError(username);
            // 429/403 = need Puppeteer to solve challenge
        }
    }

    // Slow path: Puppeteer via Tor (solves challenge, captures cookies for future fast-path)
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const html = await fetchWithPuppeteer(url);
            const data = extractNextData(html, url);
            if (data.isFallback) {
                throw new ThroneUserNotFoundError(username);
            }
            return data;
        } catch (error) {
            if (error instanceof ThroneUserNotFoundError) throw error;
            if (error instanceof ThroneParseError) throw error;

            if (attempt === 1) {
                // First failure — close browser and request new Tor circuit
                logger.warn(`${LOG_TAG} Attempt ${attempt} failed, renewing Tor circuit...`);
                if (browserInstance?.connected) {
                    await browserInstance.close().catch(() => {});
                    browserInstance = null;
                }
                await renewTorCircuit();
                continue;
            }

            if (error instanceof ThroneError) throw error;
            logger.error(`${LOG_TAG} Puppeteer fetch failed after ${attempt} attempts`, { url, error: error.message });
            throw new ThroneUnavailableError(`Failed to fetch Throne page: ${error.message}`);
        }
    }
}

// ─── Data Extraction Helpers ─────────────────────────────────────

/** Find a value in the fallback object, checking both $sub$ prefixed and unprefixed keys */
function findFallbackKey(fallback, pattern) {
    if (!fallback) return null;
    for (const key of Object.keys(fallback)) {
        if (key.includes(pattern)) return fallback[key];
    }
    return null;
}

function extractUserInfo(pageData) {
    const fallback = pageData?.props?.pageProps?.fallback;
    if (!fallback) throw new ThroneParseError('No fallback data in pageProps');

    const userInfo = findFallbackKey(fallback, 'useCreatorByUsername/');
    if (!userInfo || !userInfo._id) {
        throw new ThroneUserNotFoundError('unknown');
    }
    return userInfo;
}

function centsToDollars(cents) {
    if (cents == null) return 0;
    return Math.round(cents) / 100;
}

function formatPrice(cents, currency = 'USD') {
    const amount = centsToDollars(cents);
    try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
    } catch {
        return `${amount.toFixed(2)} ${currency}`;
    }
}

// ─── Public API ��─────────────────────────────────────────────────

/**
 * Fetch a Throne user's profile information
 */
export async function fetchThroneProfile(username, { force = false } = {}) {
    if (!force) {
        const cached = getCached(username, 'profile');
        if (cached) return cached;
    }

    // Gifters page has user info + leaderboard + gift history
    const pageData = await fetchThronePage(username, '/gifters');
    const userInfo = extractUserInfo(pageData);

    // Count items/collections from wishlist page if available, otherwise use 0
    // (we don't fetch wishlist page here to avoid extra request)

    const profile = {
        id: userInfo._id,
        username: userInfo.username,
        displayName: userInfo.displayName || userInfo.username,
        bio: userInfo.bio || null,
        birthday: userInfo.birthday ? `${userInfo.birthday.month}/${userInfo.birthday.day}` : null,
        pictureUrl: userInfo.pictureUrl || null,
        backgroundPictureUrl: userInfo.backgroundPictureUrl || null,
        mainContentPlatform: userInfo.mainContentPlatform || null,
        socialLinks: (userInfo.socialLinks || []).map(link => ({
            type: link.type,
            name: link.name,
            url: link.url,
        })),
        interests: userInfo.interests || [],
        showLeaderboard: userInfo.showLeaderboard ?? true,
        showPreviousGifts: userInfo.showPreviousGifts ?? true,
        createdAt: userInfo.createdAt ? new Date(userInfo.createdAt) : null,
        profileUrl: `https://throne.com/${username.toLowerCase()}`,
    };

    setCache(username, 'profile', profile);
    return profile;
}

/**
 * Fetch a Throne user's wishlist items
 */
export async function fetchThroneWishlist(username, { force = false } = {}) {
    if (!force) {
        const cached = getCached(username, 'wishlist');
        if (cached) return cached;
    }

    const pageData = await fetchThronePage(username);
    const pp = pageData?.props?.pageProps || {};

    // Items are in ssrWishlistItems (new format) or fallback (old format)
    let rawItems = pp.ssrWishlistItems;
    if (!rawItems || !Array.isArray(rawItems)) {
        const profile = await fetchThroneProfile(username);
        const fallback = pp.fallback || {};
        rawItems = findFallbackKey(fallback, `useWishlistItems/${profile.id}`) || [];
    }

    const items = rawItems.map(item => ({
        id: item.id || item.itemId,
        name: item.name,
        price: centsToDollars(item.price),
        priceRaw: item.price,
        currency: item.currency || 'USD',
        priceFormatted: formatPrice(item.price, item.currency),
        shipping: centsToDollars(item.shipping),
        totalContribution: centsToDollars(item.totalContributionPrice),
        totalContributionFormatted: item.totalContributionPrice ? formatPrice(item.totalContributionPrice, item.currency) : null,
        quantity: item.quantity || 1,
        isDigital: !!item.isDigitalGood,
        isAvailable: item.isAvailable !== false && !item.notInStock,
        notInStock: !!item.notInStock,
        isFeatured: !!item.isFeatured,
        isHidden: !!item.isHidden,
        isCrowdfunded: item.paymentConfiguration?.type === 'crowdfunding',
        fundingPercentage: item.fundingPercentage || 0,
        collectionIds: item.collectionIds || [],
        imageUrl: item.imgLink || null,
        link: item.link || null,
        createdAt: item.createdAt ? new Date(item.createdAt) : null,
    })).filter(item => !item.isHidden); // Don't show hidden items

    setCache(username, 'wishlist', items);
    return items;
}

/**
 * Fetch a Throne user's collections
 */
export async function fetchThroneCollections(username) {
    const cached = getCached(username, 'collections');
    if (cached) return cached;

    const pageData = await fetchThronePage(username);
    const pp = pageData?.props?.pageProps || {};

    // Collections are in ssrWishlistCollections (new format) or fallback (old format)
    let rawCollections = pp.ssrWishlistCollections;
    if (!rawCollections || !Array.isArray(rawCollections)) {
        const profile = await fetchThroneProfile(username);
        const fallback = pp.fallback || {};
        rawCollections = findFallbackKey(fallback, `useWishlistCollections/${profile.id}`) || [];
    }

    // Get items for per-collection stats
    const items = await fetchThroneWishlist(username);

    const collections = rawCollections.map(col => {
        const collectionItems = items.filter(item => item.collectionIds.includes(col.id));
        const totalPrice = collectionItems.reduce((sum, item) => sum + item.priceRaw, 0);
        const currency = collectionItems[0]?.currency || 'USD';

        return {
            id: col.id,
            title: col.title,
            description: col.description || null,
            imageUrl: col.imageSrc || null,
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
 * Fetch a Throne user's gift history
 */
export async function fetchThroneGiftHistory(username) {
    const cached = getCached(username, 'gifts');
    if (cached) return cached;

    const profile = await fetchThroneProfile(username);
    const pageData = await fetchThronePage(username, '/gifters');
    const fallback = pageData?.props?.pageProps?.fallback || {};

    const rawGifts = findFallbackKey(fallback, `usePreviousGifts/${profile.id}`) || [];

    const gifts = rawGifts.map(gift => {
        const customers = gift.customizations?.customers || [];
        const totalUsd = gift.totalUsd || gift.total || {};

        return {
            id: gift.id,
            name: gift.name,
            purchasedAt: gift.purchasedAt ? new Date(gift.purchasedAt) : null,
            status: gift.status || 'unknown',
            isComplete: !!gift.isComplete,
            isDigital: !!gift.isDigitalGood,
            isCrowdfunded: !!gift.isCrowdfunded,
            imageUrl: gift.imageSrc || null,
            totalFormatted: formatPrice(totalUsd.total || totalUsd.price, totalUsd.currency || 'USD'),
            currency: totalUsd.currency || 'USD',
            totalCents: totalUsd.total || totalUsd.price || 0,
            gifters: customers.map(c => ({
                username: c.customerUsername || 'Anonymous',
                imageUrl: c.customerImage || null,
            })),
            contributorCount: customers.length,
        };
    });

    setCache(username, 'gifts', gifts);
    return gifts;
}

/**
 * Fetch a Throne user's gifter leaderboard
 * @param {string} period - 'allTime' | 'lastMonth' | 'lastWeek'
 */
export async function fetchThroneLeaderboard(username, period = 'allTime') {
    const cacheKey = `leaderboard_${period}`;
    const cached = getCached(username, cacheKey);
    if (cached) return cached;

    const profile = await fetchThroneProfile(username);
    const pageData = await fetchThronePage(username, '/gifters');
    const fallback = pageData?.props?.pageProps?.fallback || {};

    const leaderboardData = findFallbackKey(fallback, `leaderboard/${profile.id}`) || {};

    const periodKeyMap = {
        allTime: 'leaderboardAllTime',
        lastMonth: 'leaderboardLastMonth',
        lastWeek: 'leaderboardLastWeek',
    };

    const periodKey = periodKeyMap[period] || 'leaderboardAllTime';
    const rawEntries = leaderboardData[periodKey] || [];

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
 * Fetch the last 20 recent gifters (chronological, not ranked)
 */
export async function fetchRecentGifters(username) {
    const cached = getCached(username, 'recentGifters');
    if (cached) return cached;

    const profile = await fetchThroneProfile(username);
    const pageData = await fetchThronePage(username, '/gifters');
    const fallback = pageData?.props?.pageProps?.fallback || {};

    const leaderboardData = findFallbackKey(fallback, `leaderboard/${profile.id}`) || {};
    const rawGifters = leaderboardData.lastTwentyGifters || [];

    const gifters = rawGifters.map(g => ({
        username: g.gifterUsername || 'Anonymous',
        imageUrl: g.gifterImage || null,
        purchasedAt: g.purchasedAt ? new Date(g.purchasedAt) : null,
    }));

    setCache(username, 'recentGifters', gifters);
    return gifters;
}

// Export helpers for use by throne-manager
export { formatPrice, centsToDollars };
