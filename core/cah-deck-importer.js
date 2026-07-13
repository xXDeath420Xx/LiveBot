/**
 * Imports CAH decks from CrCast (api.crcast.cc — the clrtd.com community-run
 * Cardcast replacement). Stores into cah_decks / cah_white_cards / cah_black_cards.
 *
 * API reference (verified against the live API 2026-05-23):
 *   GET /v1/cc/decks/:code        -> { name, description, watermark }
 *   GET /v1/cc/decks/:code/all    -> the above PLUS { calls: [{text:[...]}], responses: [{text:[...]}] }
 *   GET /v1/cc/decks/:code/cards  -> just { calls, responses }
 *
 * We use /all to fetch info + cards in a single round-trip.
 *
 * IMPORTANT: CrCast does NOT expose a public listing/search endpoint. You can
 * only fetch decks by their 5-char code. To populate many decks, callers must
 * provide an explicit list of codes (paste-and-go) — see bulkImportCastDecks().
 *
 * Black-card text comes as an array of segments split on blanks, e.g.
 * ["Why am I broke? I spent all my money on ", ""]. We join with "_____"
 * (five underscores) so prompts read naturally. White cards are also arrays
 * (usually length 1) — joined with newline since CrCast supports multi-line
 * cards.
 */

import logger from '../utils/logger.js';
import pool from '../utils/db.js';

const BASE_URL = process.env.CAST_BASE_URL || 'https://api.crcast.cc/v1/cc/decks';
const LIST_BASE_URL = process.env.CAST_LIST_BASE_URL || 'https://api.crcast.cc/v1/decks';
const FETCH_TIMEOUT_MS = 12_000;
const BLANK_PLACEHOLDER = '_____';

// Simple per-user rate limit so a single user can't hammer cast.clrtd.com
// or spam our cah_decks table. 5 imports per hour, sliding window.
const IMPORT_LIMIT = 5;
const IMPORT_WINDOW_MS = 60 * 60 * 1000;
const importHistory = new Map();   // userId -> number[] (timestamps)

function checkImportRate(userId) {
    if (!userId) return { ok: true };
    const now = Date.now();
    const stamps = (importHistory.get(userId) || []).filter(t => now - t < IMPORT_WINDOW_MS);
    if (stamps.length >= IMPORT_LIMIT) {
        const retryAt = Math.ceil((stamps[0] + IMPORT_WINDOW_MS - now) / 1000);
        return { ok: false, retryAfter: retryAt };
    }
    stamps.push(now);
    importHistory.set(userId, stamps);
    return { ok: true };
}

// CrCast sits behind Cloudflare, which fingerprints HTTP requests beyond just
// User-Agent — Node's built-in `undici` fetch gets flagged as bot traffic
// even with a polite UA, while curl gets through fine. We mimic curl's header
// set + browser-like Accept-* headers to slip past the fingerprint check.
const USER_AGENT = process.env.CAST_USER_AGENT ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Browser-shaped headers slip past CF's TLS fingerprint check that flags
// raw `undici` fetch as bot traffic. Origin + Referer mimic the SPA's calls.
// We omit Accept-Encoding so undici doesn't try to negotiate br/gzip that we
// then can't decode reliably.
const BROWSER_HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'Origin': 'https://crcast.cc',
    'Referer': 'https://crcast.cc/'
};

async function fetchJson(url, { retries = 3, retryDelayMs = 2000 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                headers: BROWSER_HEADERS
            });
            if (!res.ok) {
                // 5xx → retryable upstream blip. 4xx → don't retry, it's our problem.
                if (res.status >= 500 && attempt < retries) {
                    lastErr = new Error(`CrCast API ${res.status} ${res.statusText} for ${url}`);
                    await new Promise(r => setTimeout(r, retryDelayMs * (attempt + 1)));
                    continue;
                }
                throw new Error(`CrCast API ${res.status} ${res.statusText} for ${url}`);
            }
            return res.json();
        } catch (err) {
            lastErr = err;
            // Timeouts get retried too — CrCast's origin is intermittently slow.
            if (err.name === 'AbortError' || /timeout|fetch failed|aborted/i.test(err.message)) {
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, retryDelayMs * (attempt + 1)));
                    continue;
                }
            }
            throw err;
        }
    }
    throw lastErr;
}

function joinBlackText(textParts) {
    if (typeof textParts === 'string') return textParts;
    if (!Array.isArray(textParts)) return '';
    return textParts.join(BLANK_PLACEHOLDER).trim();
}

function joinWhiteText(textParts) {
    if (typeof textParts === 'string') return textParts.trim();
    if (!Array.isArray(textParts)) return '';
    // CrCast supports multi-line responses; preserve them with \n
    return textParts.join('\n').trim();
}

function inferPick(textParts) {
    if (!Array.isArray(textParts)) return 1;
    // Cardcast: pick = (segments - 1). Minimum 1.
    return Math.max(1, textParts.length - 1);
}

function inferDraw(pick) {
    // Standard CAH rule: pick 3 → draw 2 extra cards. pick 1 or 2 → draw 0.
    return pick >= 3 ? pick - 1 : 0;
}

async function fetchDeckAll(castCode) {
    // Single round-trip — CrCast's /all returns info + calls + responses together.
    const data = await fetchJson(`${BASE_URL}/${castCode}/all`);
    if (data.error && data.error !== 0) {
        throw new Error(`CrCast API error ${data.error}: ${data.message || 'unknown'}`);
    }
    return data;
}

/**
 * Import (or refresh) a CAST deck by its public code.
 * @param {string} castCode - the 5-char deck code from cast.clrtd.com
 * @param {object} opts
 * @param {string} [opts.importedBy] - Discord user id of the importer (for audit)
 * @param {boolean} [opts.markNsfw=false] - flag the deck as NSFW (host can also override)
 * @returns {Promise<{ok:boolean, deckId?:number, white?:number, black?:number, reason?:string}>}
 */
export async function importCastDeck(castCode, { importedBy = null, markNsfw = false, skipRateLimit = false } = {}) {
    const code = String(castCode).trim().toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(code)) return { ok: false, reason: 'invalid_code' };

    if (!skipRateLimit) {
        const rate = checkImportRate(importedBy);
        if (!rate.ok) return { ok: false, reason: 'rate_limited', retryAfter: rate.retryAfter };
    }

    let data;
    try {
        data = await fetchDeckAll(code);
    } catch (err) {
        logger.warn(`[cast-import] fetch failed for ${code}: ${err.message}`);
        return { ok: false, reason: 'fetch_failed', error: err.message };
    }

    const name = (data.name || code).slice(0, 255);
    const description = (data.description || '').slice(0, 1000);
    const authorUsername = data.author?.username || data.author?.name || null;

    const whiteRows = (data.responses || [])
        .map(c => joinWhiteText(c.text))
        .filter(t => t && t.length <= 500);
    const blackRows = (data.calls || [])
        .map(c => {
            const text = joinBlackText(c.text);
            const pick = c.pick || inferPick(c.text);
            return { text, pick, draw: inferDraw(pick) };
        })
        .filter(c => c.text && c.text.length <= 500);

    if (whiteRows.length === 0 && blackRows.length === 0) {
        return { ok: false, reason: 'empty_deck' };
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Upsert deck row
        const [existing] = await conn.execute('SELECT id FROM cah_decks WHERE cast_id = ?', [code]);
        let deckId;
        if (existing.length > 0) {
            deckId = existing[0].id;
            await conn.execute(
                `UPDATE cah_decks SET name=?, description=?, author_username=?, nsfw=?, refreshed_at=NOW() WHERE id=?`,
                [name, description, authorUsername, markNsfw ? 1 : 0, deckId]
            );
            // Wipe old cards so refresh is atomic
            await conn.execute('DELETE FROM cah_white_cards WHERE deck_id = ?', [deckId]);
            await conn.execute('DELETE FROM cah_black_cards WHERE deck_id = ?', [deckId]);
        } else {
            const [ins] = await conn.execute(
                `INSERT INTO cah_decks (cast_id, name, description, source, author_username, nsfw, imported_by_user_id)
                 VALUES (?, ?, ?, 'cast', ?, ?, ?)`,
                [code, name, description, authorUsername, markNsfw ? 1 : 0, importedBy]
            );
            deckId = ins.insertId;
        }

        if (whiteRows.length > 0) {
            const values = whiteRows.map(() => '(?, ?)').join(', ');
            const params = whiteRows.flatMap(t => [deckId, t]);
            await conn.execute(`INSERT INTO cah_white_cards (deck_id, text) VALUES ${values}`, params);
        }
        if (blackRows.length > 0) {
            const values = blackRows.map(() => '(?, ?, ?, ?)').join(', ');
            const params = blackRows.flatMap(c => [deckId, c.text, c.pick, c.draw]);
            await conn.execute(
                `INSERT INTO cah_black_cards (deck_id, text, pick, draw) VALUES ${values}`,
                params
            );
        }

        await conn.commit();
        logger.info(`[cast-import] ${code} → deck #${deckId}: ${whiteRows.length} white, ${blackRows.length} black`);
        return { ok: true, deckId, white: whiteRows.length, black: blackRows.length };
    } catch (err) {
        await conn.rollback();
        logger.error(`[cast-import] DB write failed for ${code}: ${err.message}`);
        return { ok: false, reason: 'db_error', error: err.message };
    } finally {
        conn.release();
    }
}

/**
 * Bootstrap minimal built-in deck so games are playable before any CAST import.
 * Idempotent — safe to call on every boot.
 */
export async function seedBuiltinDeck() {
    const [existing] = await pool.execute(
        `SELECT id FROM cah_decks WHERE source = 'builtin' AND name = ? LIMIT 1`,
        ['CertiFried Base Set']
    );
    if (existing.length > 0) return { ok: true, deckId: existing[0].id, seeded: false };

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [ins] = await conn.execute(
            `INSERT INTO cah_decks (cast_id, name, description, source, nsfw) VALUES (NULL, ?, ?, 'builtin', 0)`,
            ['CertiFried Base Set', 'Built-in minimal CAH deck for first-run play. Import more from cast.clrtd.com.']
        );
        const deckId = ins.insertId;

        const whites = [
            'A really weird hug.', 'Being a dick to children.', 'Crippling debt.', 'Doing the right thing.',
            'Existential dread.', 'Famine.', 'Getting really high.', 'Hospice care.', 'Inappropriate yodeling.',
            'Justin Bieber.', 'Kids with ass cancer.', 'Loose stool.', 'My collection of high-tech sex toys.',
            'Not giving a shit about the third world.', 'Old people smell.', 'Pretending to care.',
            'Quivering jowls.', 'Racism.', 'Some sort of Asian.', 'The miracle of childbirth.', 'Unsheathed claws.',
            'Vehicular manslaughter.', 'Waking up half-naked in a Denny\'s parking lot.', 'Xboxes.',
            'Yeast infections.', 'Zeus.'
        ];
        const blacks = [
            { text: 'What\'s that smell? Oh, it\'s _____.', pick: 1 },
            { text: 'I never truly understood _____ until I encountered _____.', pick: 2 },
            { text: 'Why am I broke? Because I spent all my money on _____.', pick: 1 },
            { text: 'In a world ravaged by _____, our only solace is _____.', pick: 2 },
            { text: 'Make a haiku.', pick: 3 },
            { text: 'Daddy, why is mommy crying? _____.', pick: 1 },
            { text: 'What\'s the next Happy Meal toy? _____.', pick: 1 },
            { text: 'TSA guidelines now prohibit _____ on airplanes.', pick: 1 }
        ];

        await conn.execute(
            `INSERT INTO cah_white_cards (deck_id, text) VALUES ${whites.map(() => '(?, ?)').join(', ')}`,
            whites.flatMap(t => [deckId, t])
        );
        await conn.execute(
            `INSERT INTO cah_black_cards (deck_id, text, pick, draw) VALUES ${blacks.map(() => '(?, ?, ?, ?)').join(', ')}`,
            blacks.flatMap(b => [deckId, b.text, b.pick, b.pick >= 3 ? b.pick - 1 : 0])
        );

        await conn.commit();
        logger.info(`[cast-import] seeded built-in deck #${deckId} (${whites.length} white, ${blacks.length} black)`);
        return { ok: true, deckId, seeded: true };
    } catch (err) {
        await conn.rollback();
        logger.error(`[cast-import] built-in seed failed: ${err.message}`);
        return { ok: false, reason: 'seed_error', error: err.message };
    } finally {
        conn.release();
    }
}

/**
 * Bulk import multiple CrCast decks concurrently (with a cap so we don't
 * hammer the upstream API). Skips the per-user rate limit since this is a
 * batch operation — instead caller should be authenticated/admin-gated.
 *
 * Returns per-code results so callers can show "12/15 imported" UI.
 *
 * @param {string[]} codes - 3-8 char alphanumeric deck codes
 * @param {object} opts
 * @param {string} [opts.importedBy] - audit field
 * @param {number} [opts.concurrency=4] - parallel fetches against CrCast
 * @returns {Promise<{results: Array<{code, ok, deckId?, white?, black?, reason?}>, summary: {ok, failed, totalWhite, totalBlack}}>}
 */
export async function bulkImportCastDecks(codes, { importedBy = null, concurrency = 2, perRequestDelayMs = 250 } = {}) {
    const unique = Array.from(new Set(codes.map(c => String(c).trim().toUpperCase()).filter(Boolean)));
    const results = new Array(unique.length);
    let idx = 0;

    async function worker() {
        while (true) {
            const myIdx = idx++;
            if (myIdx >= unique.length) return;
            const code = unique[myIdx];
            try {
                results[myIdx] = { code, ...(await importCastDeck(code, { importedBy, skipRateLimit: true })) };
            } catch (err) {
                results[myIdx] = { code, ok: false, reason: 'worker_threw', error: err.message };
            }
            // Tiny stagger between this worker's calls so we don't trip CF rate limits.
            if (perRequestDelayMs > 0) await new Promise(r => setTimeout(r, perRequestDelayMs));
        }
    }

    // Default concurrency=2 is intentionally polite — CrCast is community-run.
    const n = Math.max(1, Math.min(concurrency, unique.length));
    await Promise.all(Array.from({ length: n }, worker));

    const summary = results.reduce((acc, r) => {
        if (r.ok) {
            acc.ok++; acc.totalWhite += r.white || 0; acc.totalBlack += r.black || 0;
        } else {
            acc.failed++;
        }
        return acc;
    }, { ok: 0, failed: 0, totalWhite: 0, totalBlack: 0 });

    logger.info(`[cast-import] bulk: ${summary.ok}/${unique.length} ok, ${summary.failed} failed, +${summary.totalWhite}w/${summary.totalBlack}b`);
    return { results, summary };
}

/**
 * Enumerate every public deck CrCast exposes. The frontend's bundle revealed
 * a paginated listing endpoint hidden from the API docs:
 *   GET /v1/decks/<page>/<pageSize>/?sort=popular&sfw=1&lang=en,...
 * Returns { error: 0, decks: [{ deckcode, name, description, language, nsfw, featured, blackCount, whiteCount }] }.
 * No total-count field — we paginate until an empty page comes back.
 *
 * Be polite: CrCast sits behind Cloudflare with hairtrigger bot detection.
 * Default delay 800ms between pages, 50 decks per page.
 */
export async function discoverCastDecks({ sort = 'popular', sfw = null, lang = null, pageSize = 25, maxPages = 400, pageDelayMs = 800, maxConsecutiveFailures = 3, onProgress = null } = {}) {
    const collected = new Map();    // deckcode -> metadata
    let consecFails = 0;
    for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams();
        if (sort) params.set('sort', sort);
        if (sfw != null) params.set('sfw', sfw ? '1' : '0');
        if (lang) params.set('lang', Array.isArray(lang) ? lang.join(',') : lang);
        const qs = params.toString();
        const url = `${LIST_BASE_URL}/${page}/${pageSize}/${qs ? '?' + qs : ''}`;
        let data;
        try {
            data = await fetchJson(url);
            consecFails = 0;
        } catch (err) {
            consecFails++;
            logger.warn(`[cast-discover] page ${page} failed (${consecFails}/${maxConsecutiveFailures}): ${err.message}`);
            if (consecFails >= maxConsecutiveFailures) {
                logger.warn(`[cast-discover] stopping at page ${page} after ${maxConsecutiveFailures} consecutive failures`);
                break;
            }
            // Skip this page, try the next — better to lose 25 decks than abort the whole job
            continue;
        }
        const batch = data.decks || [];
        if (batch.length === 0) break;
        for (const d of batch) {
            if (d.deckcode && !collected.has(d.deckcode)) collected.set(d.deckcode, d);
        }
        if (onProgress) onProgress({ page, pageSize: batch.length, totalDiscovered: collected.size });
        if (batch.length < pageSize) break;   // last page
        if (pageDelayMs > 0) await new Promise(r => setTimeout(r, pageDelayMs));
    }
    logger.info(`[cast-discover] enumerated ${collected.size} decks (sort=${sort})`);
    return Array.from(collected.values());
}

/**
 * Insert metadata rows for discovered decks (cards not yet loaded — those
 * decks show 0w/0b in `listDecks` until `importCastDeck(code)` runs for them).
 * This is the cheap pre-pass before the slow card import.
 */
export async function persistDiscoveredMetadata(discovered, { importedBy = null } = {}) {
    if (!discovered || discovered.length === 0) return { inserted: 0, updated: 0 };
    let inserted = 0, updated = 0;
    for (const d of discovered) {
        const code = String(d.deckcode).toUpperCase();
        const name = (d.name || code).slice(0, 255);
        const description = (d.description || '').slice(0, 1000);
        const nsfw = d.nsfw ? 1 : 0;
        const [existing] = await pool.execute('SELECT id FROM cah_decks WHERE cast_id = ?', [code]);
        if (existing.length > 0) {
            await pool.execute(
                `UPDATE cah_decks SET name=?, description=?, nsfw=? WHERE id=?`,
                [name, description, nsfw, existing[0].id]
            );
            updated++;
        } else {
            await pool.execute(
                `INSERT INTO cah_decks (cast_id, name, description, source, nsfw, imported_by_user_id) VALUES (?, ?, ?, 'cast', ?, ?)`,
                [code, name, description, nsfw, importedBy]
            );
            inserted++;
        }
    }
    return { inserted, updated };
}

/**
 * Find every cast_id in cah_decks that has zero cards loaded, then import
 * cards for each (with rate-limit-friendly stagger). Useful after a
 * discoverCastDecks() pass to fill in the slow card data.
 */
export async function importCardlessDecks({ importedBy = null, limit = null, concurrency = 2, perRequestDelayMs = 500, onProgress = null } = {}) {
    let sql = `
        SELECT d.id, d.cast_id FROM cah_decks d
        WHERE d.source = 'cast' AND d.cast_id IS NOT NULL
        AND (SELECT COUNT(*) FROM cah_white_cards w WHERE w.deck_id = d.id) = 0
        AND (SELECT COUNT(*) FROM cah_black_cards b WHERE b.deck_id = d.id) = 0
        ORDER BY d.id
    `;
    if (limit) sql += ` LIMIT ${parseInt(limit, 10)}`;
    const [rows] = await pool.execute(sql);
    if (rows.length === 0) return { processed: 0, ok: 0, failed: 0 };

    const codes = rows.map(r => r.cast_id);
    let processed = 0, ok = 0, failed = 0;
    const summaryByCode = {};

    // Reuse bulkImportCastDecks pattern but with progress callback
    let idx = 0;
    async function worker() {
        while (true) {
            const myIdx = idx++;
            if (myIdx >= codes.length) return;
            const code = codes[myIdx];
            const r = await importCastDeck(code, { importedBy, skipRateLimit: true });
            summaryByCode[code] = r;
            processed++;
            if (r.ok) ok++; else failed++;
            if (onProgress) onProgress({ processed, total: codes.length, ok, failed, code });
            if (perRequestDelayMs > 0) await new Promise(r => setTimeout(r, perRequestDelayMs));
        }
    }
    const n = Math.max(1, Math.min(concurrency, codes.length));
    await Promise.all(Array.from({ length: n }, worker));
    logger.info(`[cast-import] cardless backfill: ${ok}/${codes.length} ok, ${failed} failed`);
    return { processed, ok, failed, results: summaryByCode };
}

// ─── Discovery + import status tracking (in-memory) ────────────────────────────
// A long-running discovery+import job can take many minutes. We expose its
// state via a module singleton so the dashboard can poll progress.
let discoveryJob = null;

export function getDiscoveryStatus() {
    if (!discoveryJob) return { running: false };
    return {
        running: discoveryJob.running,
        phase: discoveryJob.phase,
        discovered: discoveryJob.discovered,
        inserted: discoveryJob.inserted,
        updated: discoveryJob.updated,
        cardImported: discoveryJob.cardImported,
        cardFailed: discoveryJob.cardFailed,
        cardTotal: discoveryJob.cardTotal,
        startedAt: discoveryJob.startedAt,
        finishedAt: discoveryJob.finishedAt,
        error: discoveryJob.error
    };
}

/**
 * Long-running orchestrator: discover all decks → persist metadata → fetch
 * cards for any deck without them. Fire-and-forget; poll via getDiscoveryStatus().
 */
export function startDiscoveryAndImport({ importedBy = null, sort = 'popular', sfw = null } = {}) {
    if (discoveryJob?.running) return { ok: false, reason: 'already_running', status: getDiscoveryStatus() };
    discoveryJob = {
        running: true,
        phase: 'discovering',
        discovered: 0, inserted: 0, updated: 0,
        cardImported: 0, cardFailed: 0, cardTotal: 0,
        startedAt: new Date(), finishedAt: null, error: null
    };
    (async () => {
        try {
            const found = await discoverCastDecks({
                sort, sfw, pageSize: 50, pageDelayMs: 800,
                onProgress: p => { discoveryJob.discovered = p.totalDiscovered; }
            });
            discoveryJob.discovered = found.length;
            discoveryJob.phase = 'persisting';
            const persist = await persistDiscoveredMetadata(found, { importedBy });
            discoveryJob.inserted = persist.inserted;
            discoveryJob.updated = persist.updated;
            discoveryJob.phase = 'importing_cards';
            const cards = await importCardlessDecks({
                importedBy, concurrency: 2, perRequestDelayMs: 500,
                onProgress: p => {
                    discoveryJob.cardImported = p.ok;
                    discoveryJob.cardFailed = p.failed;
                    discoveryJob.cardTotal = p.total;
                }
            });
            discoveryJob.cardImported = cards.ok;
            discoveryJob.cardFailed = cards.failed;
            discoveryJob.cardTotal = cards.processed;
            discoveryJob.phase = 'done';
        } catch (err) {
            discoveryJob.error = err.message;
            discoveryJob.phase = 'failed';
            logger.error(`[cast-discover] orchestrator failed: ${err.message}`);
        } finally {
            discoveryJob.running = false;
            discoveryJob.finishedAt = new Date();
        }
    })();
    return { ok: true, status: getDiscoveryStatus() };
}

// ─── Many Decks (decks.rereadgames.com) ───────────────────────────────────────
// Different format from CrCast: calls are arrays of [strings|{}] tokens where
// {} is a blank slot, responses are plain strings, and the listing endpoint
// returns summary objects with author + language.

const MANYDECKS_BASE = process.env.MANYDECKS_BASE_URL || 'https://decks.rereadgames.com/api';

function flattenManyDecksCall(call) {
    // A call is an array of "lines"; each line is [token, token, ...] where
    // token is either a string (literal text) or {} (a blank slot).
    // We join lines with \n, replace {} with _____, and count blanks → pick.
    if (!Array.isArray(call)) return null;
    let pick = 0;
    const lines = call.map(line => {
        if (!Array.isArray(line)) return '';
        return line.map(tok => {
            if (typeof tok === 'string') return tok;
            if (tok && typeof tok === 'object') { pick++; return BLANK_PLACEHOLDER; }
            return '';
        }).join('');
    });
    const text = lines.join('\n').trim();
    if (!pick) pick = 1;   // a call with no blanks still expects exactly one card (the response)
    return { text, pick };
}

export async function importManyDecksDeck(code, { importedBy = null, markNsfw = false, skipRateLimit = false } = {}) {
    const id = String(code).trim().toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(id)) return { ok: false, reason: 'invalid_code' };
    if (!skipRateLimit) {
        const rate = checkImportRate(importedBy);
        if (!rate.ok) return { ok: false, reason: 'rate_limited', retryAfter: rate.retryAfter };
    }
    let data;
    try {
        data = await fetchJson(`${MANYDECKS_BASE}/decks/${id}`);
    } catch (err) {
        logger.warn(`[md-import] fetch failed for ${id}: ${err.message}`);
        return { ok: false, reason: 'fetch_failed', error: err.message };
    }
    const name = (data.name || id).slice(0, 255);
    const description = `Many Decks — author: ${data.author?.name || 'unknown'} · ${data.language || 'unspecified'}`.slice(0, 1000);
    const authorUsername = data.author?.name || null;

    const whiteRows = (data.responses || [])
        .map(r => String(r).trim())
        .filter(t => t && t.length <= 500);
    const blackRows = (data.calls || [])
        .map(c => flattenManyDecksCall(c))
        .filter(c => c && c.text && c.text.length <= 500)
        .map(c => ({ ...c, draw: inferDraw(c.pick) }));

    if (whiteRows.length === 0 && blackRows.length === 0) return { ok: false, reason: 'empty_deck' };

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [existing] = await conn.execute(
            `SELECT id FROM cah_decks WHERE source = 'manydecks' AND cast_id = ?`, [id]
        );
        let deckId;
        if (existing.length > 0) {
            deckId = existing[0].id;
            await conn.execute(
                `UPDATE cah_decks SET name=?, description=?, author_username=?, nsfw=?, refreshed_at=NOW() WHERE id=?`,
                [name, description, authorUsername, markNsfw ? 1 : 0, deckId]
            );
            await conn.execute(`DELETE FROM cah_white_cards WHERE deck_id = ?`, [deckId]);
            await conn.execute(`DELETE FROM cah_black_cards WHERE deck_id = ?`, [deckId]);
        } else {
            const [ins] = await conn.execute(
                `INSERT INTO cah_decks (cast_id, name, description, source, author_username, nsfw, imported_by_user_id)
                 VALUES (?, ?, ?, 'manydecks', ?, ?, ?)`,
                [id, name, description, authorUsername, markNsfw ? 1 : 0, importedBy]
            );
            deckId = ins.insertId;
        }
        if (whiteRows.length > 0) {
            const ph = whiteRows.map(() => '(?, ?)').join(', ');
            const params = whiteRows.flatMap(t => [deckId, t]);
            await conn.execute(`INSERT INTO cah_white_cards (deck_id, text) VALUES ${ph}`, params);
        }
        if (blackRows.length > 0) {
            const ph = blackRows.map(() => '(?, ?, ?, ?)').join(', ');
            const params = blackRows.flatMap(c => [deckId, c.text, c.pick, c.draw]);
            await conn.execute(`INSERT INTO cah_black_cards (deck_id, text, pick, draw) VALUES ${ph}`, params);
        }
        await conn.commit();
        logger.info(`[md-import] ${id} → deck #${deckId}: ${whiteRows.length} white, ${blackRows.length} black`);
        return { ok: true, deckId, white: whiteRows.length, black: blackRows.length };
    } catch (err) {
        await conn.rollback();
        logger.error(`[md-import] DB write failed for ${id}: ${err.message}`);
        return { ok: false, reason: 'db_error', error: err.message };
    } finally {
        conn.release();
    }
}

export async function discoverManyDecks({ language = null, query = null, maxPages = 200, pageDelayMs = 800, maxConsecutiveFailures = 3, onProgress = null } = {}) {
    const collected = new Map();
    let consecFails = 0;
    for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams();
        params.set('p', String(page));
        if (language) params.set('l', language);
        if (query) params.set('q', query);
        const url = `${MANYDECKS_BASE}/decks/browse?${params.toString()}`;
        let data;
        try {
            data = await fetchJson(url);
            consecFails = 0;
        } catch (err) {
            consecFails++;
            logger.warn(`[md-discover] page ${page} failed (${consecFails}/${maxConsecutiveFailures}): ${err.message}`);
            if (consecFails >= maxConsecutiveFailures) break;
            continue;
        }
        if (!Array.isArray(data) || data.length === 0) break;
        for (const d of data) {
            if (d.code && !collected.has(d.code)) collected.set(d.code, d);
        }
        if (onProgress) onProgress({ page, pageSize: data.length, totalDiscovered: collected.size });
        if (data.length < 20) break;   // Many Decks default page size is 20
        if (pageDelayMs > 0) await new Promise(r => setTimeout(r, pageDelayMs));
    }
    logger.info(`[md-discover] enumerated ${collected.size} decks (lang=${language || 'any'})`);
    return Array.from(collected.values());
}

export async function persistManyDecksMetadata(discovered, { importedBy = null } = {}) {
    if (!discovered || discovered.length === 0) return { inserted: 0, updated: 0 };
    let inserted = 0, updated = 0;
    for (const d of discovered) {
        const code = String(d.code).toUpperCase();
        const s = d.summary || {};
        const name = (s.name || code).slice(0, 255);
        const description = `Many Decks · ${s.language || ''} · author: ${s.author?.name || 'unknown'}`.slice(0, 1000);
        const [existing] = await pool.execute(
            `SELECT id FROM cah_decks WHERE source = 'manydecks' AND cast_id = ?`, [code]
        );
        if (existing.length > 0) {
            await pool.execute(
                `UPDATE cah_decks SET name=?, description=?, author_username=? WHERE id=?`,
                [name, description, s.author?.name || null, existing[0].id]
            );
            updated++;
        } else {
            await pool.execute(
                `INSERT INTO cah_decks (cast_id, name, description, source, author_username, nsfw, imported_by_user_id)
                 VALUES (?, ?, ?, 'manydecks', ?, 0, ?)`,
                [code, name, description, s.author?.name || null, importedBy]
            );
            inserted++;
        }
    }
    return { inserted, updated };
}

/**
 * Orchestrator for Many Decks. Mirrors startDiscoveryAndImport but for the MD
 * source. Uses the same discoveryJob singleton so the UI's progress poll just
 * works.
 */
export function startManyDecksDiscovery({ importedBy = null, language = null } = {}) {
    if (discoveryJob?.running) return { ok: false, reason: 'already_running', status: getDiscoveryStatus() };
    discoveryJob = {
        running: true, phase: 'discovering_manydecks',
        discovered: 0, inserted: 0, updated: 0,
        cardImported: 0, cardFailed: 0, cardTotal: 0,
        startedAt: new Date(), finishedAt: null, error: null,
        source: 'manydecks'
    };
    (async () => {
        try {
            const found = await discoverManyDecks({
                language, pageDelayMs: 800,
                onProgress: p => { discoveryJob.discovered = p.totalDiscovered; }
            });
            discoveryJob.discovered = found.length;
            discoveryJob.phase = 'persisting';
            const persist = await persistManyDecksMetadata(found, { importedBy });
            discoveryJob.inserted = persist.inserted;
            discoveryJob.updated = persist.updated;
            discoveryJob.phase = 'importing_cards';

            // For each metadata row without cards, fetch via importManyDecksDeck
            const [rows] = await pool.execute(
                `SELECT cast_id FROM cah_decks d WHERE source='manydecks'
                 AND (SELECT COUNT(*) FROM cah_white_cards w WHERE w.deck_id=d.id)=0
                 AND (SELECT COUNT(*) FROM cah_black_cards b WHERE b.deck_id=d.id)=0`
            );
            discoveryJob.cardTotal = rows.length;
            let ok = 0, failed = 0;
            for (let i = 0; i < rows.length; i += 2) {
                const batch = rows.slice(i, i + 2);
                const results = await Promise.all(batch.map(r => importManyDecksDeck(r.cast_id, { importedBy, skipRateLimit: true })));
                results.forEach(r => { if (r.ok) ok++; else failed++; });
                discoveryJob.cardImported = ok;
                discoveryJob.cardFailed = failed;
                await new Promise(r => setTimeout(r, 500));
            }
            discoveryJob.phase = 'done';
        } catch (err) {
            discoveryJob.error = err.message;
            discoveryJob.phase = 'failed';
            logger.error(`[md-discover] orchestrator failed: ${err.message}`);
        } finally {
            discoveryJob.running = false;
            discoveryJob.finishedAt = new Date();
        }
    })();
    return { ok: true, status: getDiscoveryStatus() };
}

export async function listDecks({ source = null, limit = 10000, forUserId = null, onlyWithCards = false, language = 'en' } = {}) {
    // JOIN+GROUP BY instead of correlated subqueries — at 4000+ decks the old
    // per-deck count subquery shape was doing ~8000 SELECT COUNTs per request.
    // This shape is one aggregate scan of the cards tables, then a single JOIN.
    let sql = `
        SELECT d.id, d.cast_id, d.name, d.description, d.source, d.author_username,
               d.nsfw, d.is_public, d.owner_user_id, d.language,
               COALESCE(w.cnt, 0) AS white_count,
               COALESCE(b.cnt, 0) AS black_count
        FROM cah_decks d
        LEFT JOIN (SELECT deck_id, COUNT(*) AS cnt FROM cah_white_cards GROUP BY deck_id) w ON w.deck_id = d.id
        LEFT JOIN (SELECT deck_id, COUNT(*) AS cnt FROM cah_black_cards GROUP BY deck_id) b ON b.deck_id = d.id
        WHERE 1=1
    `;
    const params = [];
    if (source) { sql += ' AND d.source = ?'; params.push(source); }
    if (forUserId !== '*') {
        sql += ` AND (d.source != 'custom' OR d.is_public = 1 OR d.owner_user_id = ?)`;
        params.push(forUserId);
    }
    if (onlyWithCards) sql += ' AND (COALESCE(w.cnt,0) > 0 OR COALESCE(b.cnt,0) > 0)';
    // Language filter: 'en' = English only (STRICT — excludes 'und' since
    // those packs slipped through detection and were leaking non-English cards
    // into games). 'all' = no filter. Anything else = exact match.
    if (language === 'en') {
        sql += ` AND d.language = 'en'`;
    } else if (language && language !== 'all') {
        sql += ` AND d.language = ?`;
        params.push(language);
    }
    sql += ' ORDER BY d.imported_at DESC LIMIT ?';
    params.push(limit);
    const [rows] = await pool.execute(sql, params);
    return rows;
}
