import cron from 'node-cron';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

let scheduledTask = null;
let isInitialized = false;
let clientRef = null;

const SOURCES = {
    'discord-phishing-links': 'https://raw.githubusercontent.com/nikolaischunk/discord-phishing-links/main/domain-list.json',
    'phishing-database': 'https://raw.githubusercontent.com/mitchellkrogza/Phishing.Database/master/phishing-domains-ACTIVE.txt'
};

const BATCH_SIZE = 500;
const FETCH_TIMEOUT = 30000;

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
            // JSON array of domains
            const domains = JSON.parse(text);
            return Array.isArray(domains) ? domains : [];
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

    let newCount = 0;

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map(() => '(?, ?, NOW())').join(', ');
        const values = batch.flatMap(e => [e.domain.toLowerCase(), e.source]);

        try {
            const [result] = await pool.execute(
                `INSERT INTO phishing_domains (domain, source, last_seen_at)
                 VALUES ${placeholders}
                 ON DUPLICATE KEY UPDATE last_seen_at = NOW(), source = VALUES(source)`,
                values
            );
            // affectedRows: 1 for insert, 2 for update (MySQL quirk)
            const inserted = result.affectedRows - (batch.length * 2 - result.affectedRows);
            if (inserted > 0) newCount += inserted;
        } catch (error) {
            logger.error('[PhishingUpdater] Batch upsert error', {
                error: error.message,
                batchStart: i,
                batchSize: batch.length
            });
        }
    }

    return newCount;
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

    for (const [source, url] of Object.entries(SOURCES)) {
        const domains = await fetchDomainList(url, source);
        for (const domain of domains) {
            const normalized = domain.toLowerCase().trim();
            if (normalized && !seen.has(normalized)) {
                seen.add(normalized);
                allEntries.push({ domain: normalized, source });
            }
        }
        logger.info(`[PhishingUpdater] Fetched ${domains.length} domains from ${source}`);
    }

    if (allEntries.length === 0) {
        logger.warn('[PhishingUpdater] No domains fetched — skipping update');
        return;
    }

    // Upsert all domains
    const newCount = await batchUpsert(allEntries);

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

    // Reload the in-memory Set
    if (clientRef?.phishingDetectionManager) {
        await clientRef.phishingDetectionManager.loadDomains();
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[PhishingUpdater] Synced ${allEntries.length} domains (~${newCount} new) in ${elapsed}s`);
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
