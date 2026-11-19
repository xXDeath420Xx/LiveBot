import cron from 'node-cron';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { isSafeDomain, SAFE_DOMAINS, overrideSafeDomains } from '../core/safe-domains.js';

let scheduledTask = null;
let isInitialized = false;
let clientRef = null;

const SOURCES = {
    'discord-phishing-links': 'https://raw.githubusercontent.com/nikolaischunk/discord-phishing-links/main/domain-list.json',
    'phishing-database': 'https://raw.githubusercontent.com/mitchellkrogza/Phishing.Database/master/phishing-domains-ACTIVE.txt'
};

// A 'manual' row (a blocked domain report, core/domain-reports.js) stays manual when a feed lists it too,
// so the 30-day stale prune below never removes it.
const BATCH_SIZE = 500;
const FETCH_TIMEOUT = 30000;
// phishing_domains.domain is VARCHAR(255) and is the PRIMARY KEY, so it can't simply be
// widened. The upstream feeds occasionally carry junk lines longer than that (wrapped
// text, pasted URLs), and because the insert is one multi-row statement per batch, a
// single over-length entry made MariaDB reject the whole 500-domain batch — silently
// discarding ~7k legitimate domains per sync. Drop the offenders at ingest instead.
const MAX_DOMAIN_LENGTH = 255;

/**
 * Fetch a list of domains from a URL
 * @param {string} url - URL to fetch
 * @param {string} source - Source identifier
 * @returns {string[]} Array of domain strings
 */
async function fetchDomainList(url, source) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();

        if (source === 'discord-phishing-links') {
            // This feed used to be a bare JSON array and is now an object shaped
            // `{ "domains": [...] }`. The old `Array.isArray(x) ? x : []` quietly took
            // the empty branch, so the sync logged "Fetched 0 domains" and carried on —
            // 21,908 Discord-specific phishing domains, the ones that matter most here,
            // were silently absent from the blocklist. Accept either shape, and treat a
            // shape we don't recognise as an error rather than as "no domains".
            const parsed = JSON.parse(text);
            const domains = Array.isArray(parsed) ? parsed
                : Array.isArray(parsed?.domains) ? parsed.domains
                : null;

            if (!domains) {
                throw new Error(`unrecognised payload shape (keys: ${Object.keys(parsed || {}).join(',') || 'none'})`);
            }
            return domains;
        } else {
            // Plain text, one domain per line
            return text.split('\n').map(d => d.trim()).filter(d => d && !d.startsWith('#'));
        }
    } catch (error) {
        logger.error(`[PhishingUpdater] Failed to fetch ${source}`, { error: error.message });
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Batch upsert domains into phishing_domains table
 * @param {Array<{domain: string, source: string}>} entries - Domains to upsert
 * @returns {number} Number of new domains inserted
 */
async function batchUpsert(entries) {
    if (entries.length === 0) return 0;

    // MariaDB reports affectedRows = 1 for BOTH an insert and an update on
    // INSERT … ON DUPLICATE KEY UPDATE — it never returns the 2-for-update value the
    // MySQL docs describe. The old arithmetic here (affectedRows - (len*2 - affectedRows))
    // therefore evaluated to 0 on every batch, so "~N new" in the summary log was always
    // zero no matter how many domains were genuinely added. Count the table instead.
    // Aliased `total_before`, not `before` — BEFORE is a reserved word in MariaDB and an
    // unquoted alias is a syntax error, not a warning.
    const [[{ total_before: before }]] = await pool.execute(
        'SELECT COUNT(*) AS total_before FROM phishing_domains');

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map(() => '(?, ?, NOW())').join(', ');
        const values = batch.flatMap(e => [e.domain.toLowerCase(), e.source]);

        try {
            await pool.execute(
                `INSERT INTO phishing_domains (domain, source, last_seen_at)
                 VALUES ${placeholders}
                 ON DUPLICATE KEY UPDATE last_seen_at = NOW(), source = IF(source = 'manual', source, VALUES(source))`,
                values
            );
        } catch (error) {
            logger.error('[PhishingUpdater] Batch upsert error', {
                error: error.message,
                batchStart: i,
                batchSize: batch.length
            });
        }
    }

    const [[{ total_after: after }]] = await pool.execute(
        'SELECT COUNT(*) AS total_after FROM phishing_domains');
    return Math.max(0, Number(after) - Number(before));
}

/**
 * Run the full update cycle: fetch lists → upsert → prune → reload
 */
async function updateLists() {
    logger.info('[PhishingUpdater] Starting domain list sync...');
    const startTime = Date.now();

    // Fetch both sources
    const allEntries = [];
    const seen = new Set();
    let safeSkipped = 0;
    let tooLong = 0;

    for (const [source, url] of Object.entries(SOURCES)) {
        const domains = await fetchDomainList(url, source);
        for (const domain of domains) {
            const normalized = domain.toLowerCase().trim();
            if (!normalized || seen.has(normalized)) continue;
            // Dropped at ingest, not just at load: otherwise clearing a false
            // positive out of the table only holds until the next 4-hourly sync
            // puts it straight back.
            if (isSafeDomain(normalized)) { safeSkipped++; continue; }
            if (normalized.length > MAX_DOMAIN_LENGTH) { tooLong++; continue; }
            seen.add(normalized);
            allEntries.push({ domain: normalized, source });
        }
        // A healthy feed never returns nothing. Zero means the fetch failed or the
        // payload changed shape under us — both of which previously logged at info level
        // and looked exactly like a normal cycle.
        if (domains.length === 0) {
            logger.error(`[PhishingUpdater] Source "${source}" returned 0 domains — the feed is down or its format changed`);
        } else {
            logger.info(`[PhishingUpdater] Fetched ${domains.length} domains from ${source}`);
        }
    }

    if (allEntries.length === 0) {
        logger.warn('[PhishingUpdater] No domains fetched — skipping update');
        return;
    }

    // Upsert all domains
    const newCount = await batchUpsert(allEntries);

    // Evict never-flag domains that an earlier sync already wrote. Without this
    // they sit in the table serving deletions for the 30 days it takes the stale
    // prune below to reach them.
    try {
        // The built-in list plus approved disputes (core/domain-reports.js), which the feeds keep re-adding.
        const safeList = [...SAFE_DOMAINS, ...overrideSafeDomains()];
        const [safeResult] = await pool.query(
            'DELETE FROM phishing_domains WHERE domain IN (?)', [safeList]
        );
        if (safeResult.affectedRows > 0) {
            logger.info(`[PhishingUpdater] Removed ${safeResult.affectedRows} never-flag domains from the table`);
        }
    } catch (error) {
        logger.error('[PhishingUpdater] Safe-domain eviction error', { error: error.message });
    }

    // Prune stale domains (not seen in 30 days, excluding manual entries)
    try {
        const [pruneResult] = await pool.execute(
            `DELETE FROM phishing_domains WHERE last_seen_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND source != 'manual'`
        );
        if (pruneResult.affectedRows > 0) {
            logger.info(`[PhishingUpdater] Pruned ${pruneResult.affectedRows} stale domains`);
        }
    } catch (error) {
        logger.error('[PhishingUpdater] Prune error', { error: error.message });
    }

    // Reload the in-memory Set.
    //
    // force is required: loadDomains() now skips a reload when the shared list
    // is under 30 minutes old, which is what stops 41 bots each re-fetching it
    // at startup. This call runs immediately *after* writing new domains, so the
    // freshness check would be exactly wrong here — it would decide the list is
    // current and quietly throw away the domains we just fetched.
    if (clientRef?.phishingDetectionManager) {
        await clientRef.phishingDetectionManager.loadDomains({ force: true });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[PhishingUpdater] Synced ${allEntries.length} domains (${newCount} new) in ${elapsed}s${safeSkipped ? ` — dropped ${safeSkipped} never-flag domains` : ''}${tooLong ? `, ${tooLong} over ${MAX_DOMAIN_LENGTH} chars` : ''}`);
}

/**
 * Start the phishing list updater
 * Runs every 4 hours, initial run 10 seconds after startup
 * @param {Client} client - Discord client instance
 */
export function startPhishingListUpdater(client) {
    if (isInitialized) {
        logger.debug('[PhishingUpdater] Already initialized, skipping');
        return;
    }

    clientRef = client;
    isInitialized = true;
    logger.info('[PhishingUpdater] Initializing phishing list updater...');

    // Schedule every 4 hours
    scheduledTask = cron.schedule('0 */4 * * *', async () => {
        try {
            await updateLists();
        } catch (error) {
            logger.error('[PhishingUpdater] Scheduled update error', {
                error: error.message,
                stack: error.stack
            });
        }
    });

    scheduledTask.start();
    logger.info('[PhishingUpdater] Scheduler started — updating every 4 hours');

    // Initial run after 10 seconds
    setTimeout(async () => {
        try {
            logger.info('[PhishingUpdater] Running initial domain sync...');
            await updateLists();
        } catch (error) {
            logger.error('[PhishingUpdater] Initial sync error', { error: error.message });
        }
    }, 10000);
}

/**
 * Stop the phishing list updater
 */
export function stopPhishingListUpdater() {
    if (scheduledTask) {
        scheduledTask.stop();
        logger.info('[PhishingUpdater] Scheduler stopped');
    }
    clientRef = null;
    isInitialized = false;
}
