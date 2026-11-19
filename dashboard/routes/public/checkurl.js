/**
 * Public, unauthenticated URL checker.
 *
 * Lets anyone (users, other bots, scripts, browser extensions) query CertiFried's phishing +
 * safe-domain lists for a given URL or host without a login. Matches the shape of Hashbot's
 * free "brand protection URL check" at ~20 QPS, in our case 30/min per IP.
 *
 * Returns a stable, documented JSON shape — do not change field names once consumers rely on
 * them. CORS is permissive by design (browser extensions and third-party dashboards consume it);
 * credentials are never read or set so there is no cookie / token exposure.
 *
 * Rate limit is per-IP, not per-session, because there is no session. 30/min is above the
 * dashboard tool's 20/min cap deliberately — a public consumer polling a list of URLs needs more
 * headroom than one dashboard user with a form.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../../utils/logger.js';
import { checkUrl } from '../../../core/message-threats.js';

const router = express.Router();

const LOG = '[PublicCheckUrl]';

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'rate_limited', message: 'You can check 30 URLs per minute from this IP. Slow down and try again shortly.' },
    keyGenerator: (req) => (req.headers['cf-connecting-ip'] || req.ip || 'unknown').toString(),
});

// Minimal permissive CORS — read-only, no credentials, no auth header.
router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

function sanitiseInput(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    if (s.length > 500) return s.slice(0, 500);
    return s;
}

function toPublicShape(input, result) {
    // Pick only fields safe to expose. explainUrl returns a `.safe` boolean when the host is on
    // the override allow-list — do not reveal the override provenance (safeOverride), it's an
    // internal signal. The verdict string normalises for consumers who want a single enum.
    const verdict = result.listed
        ? 'flagged'
        : (result.safe ? 'safe' : (result.host ? 'unknown' : 'invalid'));

    return {
        ok: true,
        input,
        host: result.host || null,
        verdict,
        flagged: !!result.listed,
        safe: !!result.safe,
        listed_as: result.listedAs || null,
        domains_checked_against: Number(result.listSize) || 0,
        attribution: 'Checked against CertiFried bot threat intelligence (https://certifriedmultitool.com)',
        checked_at: new Date().toISOString(),
    };
}

async function handle(req, res, rawInput) {
    const input = sanitiseInput(rawInput);
    if (!input) {
        return res.status(400).json({ ok: false, error: 'bad_input', message: 'Provide a URL or host via `url` (POST body) or `?url=` (query string).' });
    }
    try {
        const result = await checkUrl(input, null);   // no guildId → no per-guild allow-list applied
        return res.json(toPublicShape(input, result));
    } catch (err) {
        logger.error(`${LOG} check failed`, { err: err.message, inputLen: input.length });
        return res.status(500).json({ ok: false, error: 'internal_error', message: 'The checker is temporarily unavailable. Try again in a few seconds.' });
    }
}

router.get('/checkurl', limiter, async (req, res) => {
    return handle(req, res, req.query?.url);
});

router.post('/checkurl', limiter, express.json({ limit: '4kb' }), async (req, res) => {
    return handle(req, res, req.body?.url);
});

// Human-readable landing — explains the API to anyone who opens the URL in a browser.
router.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify({
        service: 'CertiFried public threat API',
        endpoints: {
            'GET  /api/public/checkurl?url=<domain-or-url>': 'Check a URL or host against the phishing + safe-domain lists',
            'POST /api/public/checkurl': 'Same, with `{"url": "<domain-or-url>"}` body',
        },
        rate_limit: '30 requests/minute per IP',
        attribution_required: 'If you expose results, please credit certifriedmultitool.com',
        docs: 'https://certifriedmultitool.com/',
    }, null, 2));
});

export default router;
