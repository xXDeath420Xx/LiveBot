/**
 * Phishing/scam domain matcher for the Kick Defender.
 *
 * Loads the shared phishing_domains table (~391K rows, community-synced every
 * 4h by the Discord side) PLUS the Kick-specific kbd_malicious_sites list into
 * a long-lived in-memory Set — NOT the 60s banlist cache, which is sized for a
 * small list. Refreshed on an interval. URL extraction + subdomain matching
 * mirror core/phishing-detection-manager.js so behavior is consistent.
 */
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

// Never flag these, even if a community list contains them. Mirrors
// core/phishing-detection-manager.js SAFE_DOMAINS (+ kick essentials).
const SAFE_DOMAINS = new Set([
    'discord.com', 'discordapp.com', 'cdn.discordapp.com', 'cdn.discord.com',
    'media.discordapp.net', 'discord.gg', 'discord.media', 'discordstatus.com',
    'twitch.tv', 'kick.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com',
    'steamcommunity.com', 'store.steampowered.com', 'github.com',
    'tenor.com', 'giphy.com', 'imgur.com'
]);

const REFRESH_MS = 4 * 60 * 60 * 1000; // 4h, matching the Discord sync cadence
let domainSet = new Set();
let loaded = false;
let refreshTimer = null;

function normalize(domain) {
    let d = String(domain).toLowerCase().trim();
    if (d.startsWith('www.')) d = d.slice(4);
    return d;
}

export async function loadDomains() {
    try {
        const set = new Set();
        const [phish] = await pool.execute('SELECT domain FROM phishing_domains');
        for (const r of phish) {
            const d = normalize(r.domain);
            if (d && !SAFE_DOMAINS.has(d)) set.add(d);
        }
        // Kick-specific manual additions (managers add via dashboard / chat).
        const [sites] = await pool.execute('SELECT uri FROM kbd_malicious_sites');
        for (const r of sites) {
            // kbd_malicious_sites stores URIs OR bare domains; extract the host.
            let host = String(r.uri).toLowerCase().trim();
            try { host = new URL(host.includes('://') ? host : `http://${host}`).hostname; } catch { /* keep raw */ }
            const d = normalize(host);
            if (d && !SAFE_DOMAINS.has(d)) set.add(d);
        }
        domainSet = set;
        loaded = true;
        logger.info(`[KBD Phishing] Loaded ${domainSet.size} domains into memory`);
    } catch (error) {
        logger.error('[KBD Phishing] Failed to load domains', { error: error.message });
    }
}

/** Start the periodic refresh (idempotent). Call once at bot startup. */
export function startDomainRefresh() {
    if (refreshTimer) return;
    loadDomains();
    refreshTimer = setInterval(loadDomains, REFRESH_MS);
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

/** Extract unique {domain,url} from message content. Mirrors the Discord manager. */
export function extractDomains(content) {
    const urlRegex = /https?:\/\/[^\s<>]+/gi;
    const matches = (content || '').match(urlRegex);
    if (!matches) return [];
    const seen = new Set();
    const out = [];
    for (const rawUrl of matches) {
        try {
            const domain = normalize(new URL(rawUrl).hostname);
            if (!seen.has(domain)) { seen.add(domain); out.push({ domain, url: rawUrl }); }
        } catch { /* malformed URL — skip */ }
    }
    return out;
}

/**
 * Return the first flagged domain found in the message, or null.
 * Matches the exact domain and any parent domain (sub.bad.com → bad.com).
 * Cheap-exits when the message has no URL.
 */
export function findPhishingDomain(content) {
    if (!loaded || !content || content.indexOf('http') === -1) return null;
    for (const { domain } of extractDomains(content)) {
        if (domainSet.has(domain)) return domain;
        // Walk parent domains: a.b.evil.com → b.evil.com → evil.com
        const parts = domain.split('.');
        for (let i = 1; i < parts.length - 1; i++) {
            const parent = parts.slice(i).join('.');
            if (SAFE_DOMAINS.has(parent)) break;
            if (domainSet.has(parent)) return parent;
        }
    }
    return null;
}

/**
 * Dashboard search: is a raw domain/URL blocked? Mirrors findPhishingDomain's
 * exact + parent-domain matching so the console answer matches enforcement.
 * Returns { blocked, matched, safe } — `safe` flags an explicit allowlist hit.
 */
export function isDomainBlocked(input) {
    if (!loaded || !input) return { blocked: false, matched: null, safe: false };
    let host = String(input).toLowerCase().trim();
    try { host = new URL(host.includes('://') ? host : `http://${host}`).hostname; } catch { /* use raw */ }
    host = normalize(host);
    if (SAFE_DOMAINS.has(host)) return { blocked: false, matched: null, safe: true };
    if (domainSet.has(host)) return { blocked: true, matched: host, safe: false };
    const parts = host.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join('.');
        if (SAFE_DOMAINS.has(parent)) return { blocked: false, matched: null, safe: true };
        if (domainSet.has(parent)) return { blocked: true, matched: parent, safe: false };
    }
    return { blocked: false, matched: null, safe: false };
}

// Test/maintenance helpers.
export function _setDomainsForTest(domains) { domainSet = new Set(domains.map(normalize)); loaded = true; }
export function size() { return domainSet.size; }
