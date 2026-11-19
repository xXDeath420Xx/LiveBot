/*
 * GIPHY for the birthday card page (dashboard/views/birthday-card.ejs): the GIF and sticker pickers call these routes
 * instead of api.giphy.com, so the GIPHY key stays on the server (it used to be written into the page).
 *
 *   GET /card/:shareToken/giphy/:kind/:mode[?q=…]    kind gifs | stickers, mode trending | search (q required, ≤ 100)
 *
 * The same calls the page made before: GET https://api.giphy.com/v1/<kind>/<mode>?limit=30&rating=pg-13[&q=…].
 * Only for a card that exists, and for a password-protected card only once this session unlocked it (the card page's
 * own rule). Rate-limited per address. The answer carries only what the page uses: { data: [{ title, images:
 * { fixed_width_downsampled, fixed_width_small, fixed_width, original: { url } } }] }, GIPHY https URLs only.
 *
 * Key: GIPHY_API_KEY, read from the .env file when it changes (so rotating the key needs no restart), falling back
 * to process.env. It is never logged or sent to a browser.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export const KINDS = Object.freeze(['gifs', 'stickers']);
export const MODES = Object.freeze(['trending', 'search']);
export const GIPHY_API = 'https://api.giphy.com/v1';
const IMAGE_KEYS = ['fixed_width_downsampled', 'fixed_width_small', 'fixed_width', 'original'];
const GIPHY_URL = /^https:\/\/([a-z0-9-]+\.)*giphy\.com\//i;
const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');

/** The fields the card page reads, nothing else. Items without an original image are dropped (the page skips them). */
export function pickGiphyFields(body) {
    const out = [];
    for (const g of Array.isArray(body?.data) ? body.data : []) {
        const images = {};
        for (const k of IMAGE_KEYS) {
            const url = g?.images?.[k]?.url;
            if (typeof url === 'string' && GIPHY_URL.test(url)) images[k] = { url };
        }
        if (!images.original) continue;
        out.push({ title: typeof g.title === 'string' ? g.title.slice(0, 200) : '', images });
    }
    return { data: out };
}

/** GIPHY_API_KEY from the .env file (re-read when the file changes), else from process.env. */
export function makeKeyReader({ envFile = ENV_FILE, env = process.env } = {}) {
    let mtime = -1;
    let fromFile = null;
    return function giphyKey() {
        try {
            const m = fs.statSync(envFile).mtimeMs;
            if (m !== mtime) { mtime = m; fromFile = dotenv.parse(fs.readFileSync(envFile)).GIPHY_API_KEY || null; }
        } catch { fromFile = null; }
        return fromFile || env.GIPHY_API_KEY || null;
    };
}

/**
 * deps: { pool (mysql2-like, .execute), fetchImpl, getKey, logger, limit: { windowMs, max } }
 */
export function createCardGiphyRouter({ pool: db, fetchImpl = (...a) => fetch(...a), getKey = makeKeyReader(), logger = null, limit = {} } = {}) {
    const router = express.Router();
    const limiter = rateLimit({
        windowMs: limit.windowMs ?? 60 * 1000, max: limit.max ?? 40, standardHeaders: true, legacyHeaders: false,
        keyGenerator: (req) => `cardgiphy:${req.ip}`,
        handler: (req, res) => res.status(429).json({ error: 'Too many searches. Wait a minute and try again.' }),
    });

    router.get('/card/:shareToken/giphy/:kind/:mode', limiter, async (req, res) => {
        const { shareToken, kind, mode } = req.params;
        if (!KINDS.includes(kind) || !MODES.includes(mode)) return res.status(404).json({ error: 'Not found' });
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (mode === 'search' && !q) return res.status(400).json({ error: 'Type something to search for' });
        if (q.length > 100) return res.status(400).json({ error: 'That search is too long' });
        try {
            const [cards] = await db.execute('SELECT id, password_hash FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [String(shareToken).slice(0, 100), String(shareToken).slice(0, 100)]);
            const card = cards[0];
            if (!card) return res.status(404).json({ error: 'Card not found' });
            if (card.password_hash && !req.session?.[`card_unlocked_${card.id}`]) return res.status(403).json({ error: 'Unlock the card first' });
            const key = getKey();
            if (!key) return res.status(503).json({ error: 'GIF search is not set up' });
            const params = new URLSearchParams({ api_key: key, limit: '30', rating: 'pg-13' });
            if (mode === 'search') params.set('q', q);
            let r;
            try {
                r = await fetchImpl(`${GIPHY_API}/${kind}/${mode}?${params}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
            } catch {
                return res.status(502).json({ error: 'GIPHY could not be reached' });
            }
            if (!r.ok) {
                logger?.warn?.(`[CardGiphy] GIPHY answered ${r.status} for ${kind}/${mode}`);
                return res.status(502).json({ error: `GIPHY answered ${r.status}` });
            }
            const body = await r.json().catch(() => null);
            res.set('Cache-Control', 'private, max-age=60');
            return res.json(pickGiphyFields(body));
        } catch (err) {
            logger?.error?.(`[CardGiphy] ${kind}/${mode} failed: ${String(err?.message || err).slice(0, 120)}`);
            return res.status(500).json({ error: 'GIF search failed' });
        }
    });
    return router;
}

/** The live router (mounted in dashboard/server.js). */
export default createCardGiphyRouter({ pool, logger });
