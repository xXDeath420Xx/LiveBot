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
// Never flag these, even if a community list contains them. Shared with the
// Discord manager rather than mirrored — the mirrored copy drifted, so a domain
// cleared on Discord was still being deleted on Kick.
import { SAFE_DOMAINS, isSafeDomain } from '../../../core/safe-domains.js';

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
            if (d && !isSafeDomain(d)) set.add(d);
        }
        // Kick-specific manual additions (managers add via dashboard / chat).
        const [sites] = await pool.execute('SELECT uri FROM kbd_malicious_sites');
        for (const r of sites) {
            // kbd_malicious_sites stores URIs OR bare domains; extract the host.
            let host = String(r.uri).toLowerCase().trim();
            try { host = new URL(host.includes('://') ? host : `http://${host}`).hostname; } catch { /* keep raw */ }
            const d = normalize(host);
            if (d && !isSafeDomain(d)) set.add(d);
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

// A bare host name in chat ("free-nitro.xyz", "www.bad.co/claim"): labels of letters, digits and hyphens, at least
// one dot, ending in an alphabetic TLD. Only used for list lookups (H-697).
const BARE_HOST_RE = /(?:^|[\s(<"'\[])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?=$|[\s/)>"'\],.!?:;])/gi;

/**
 * Extract unique {domain,url} from message content. http(s) URLs as before (mirrors the Discord manager), plus
 * bare host names with `bare: true` (H-697). Callers must only match bare hosts against the known list.
 */
export function extractDomains(content) {
    const text = content || '';
    const seen = new Set();
    const out = [];
    for (const rawUrl of text.match(/https?:\/\/[^\s<>]+/gi) || []) {
        try {
            const domain = normalize(new URL(rawUrl).hostname);
            if (!seen.has(domain)) { seen.add(domain); out.push({ domain, url: rawUrl }); }
        } catch { /* malformed URL — skip */ }
    }
    const withoutUrls = text.replace(/https?:\/\/[^\s<>]+/gi, ' ');
    for (const m of withoutUrls.matchAll(BARE_HOST_RE)) {
        const domain = normalize(m[1].toLowerCase());
        if (!seen.has(domain)) { seen.add(domain); out.push({ domain, url: m[1], bare: true }); }
    }
    return out;
}

/**
 * Return the first flagged domain found in the message, or null.
 * Matches the exact domain and any parent domain (sub.bad.com → bad.com).
 * Cheap-exits when the message has no URL.
 */
export function findPhishingDomain(content) {
    // Cheap exit: no dot, no URL or host name to check.
    if (!loaded || !content || content.indexOf('.') === -1) return null;
    for (const { domain } of extractDomains(content)) {
        if (isSafeDomain(domain)) continue;
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
    if (isSafeDomain(host)) return { blocked: false, matched: null, safe: true };
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
