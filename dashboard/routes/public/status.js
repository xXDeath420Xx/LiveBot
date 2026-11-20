/**
 * Public status page + aggregator.
 *
 * One JSON endpoint returning everything a user, downstream integrator, or outage-aware
 * dashboard wants to see about CertiFried's health, plus an HTML page that renders it.
 *
 * All data served here is already public (uptime %, API health probes, gateway state,
 * domain-blocked counter, live-guild count). Nothing from the super-admin status surface —
 * no logs, no internal errors, no PM2 process trees, no system memory. If you add fields,
 * confirm they're safe to expose to the open internet.
 *
 * Caches at 20 s to keep the DB + HEAD-probe load bounded if the page gets linked anywhere.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import https from 'node:https';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { sendFramed } from '../../services/site-frame.js';
import { stylesheetTag } from '../../services/framed-assets.js';

const router = express.Router();
const LOG = '[PublicStatus]';

// ─── per-IP soft limit (prevents accidental fetch loops) ─────────────────────
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.headers['cf-connecting-ip'] || req.ip || 'unknown').toString(),
    message: { ok: false, error: 'rate_limited' },
});

// ─── helpers ────────────────────────────────────────────────────────────────
async function probe(url, timeoutMs = 2500) {
    return new Promise((resolve) => {
        const started = Date.now();
        const req = https.request(url, { method: 'HEAD', timeout: timeoutMs, headers: { 'User-Agent': 'CertiFried-Status/1.0' } }, (res) => {
            res.destroy();
            resolve({ ok: true, status: res.statusCode, latencyMs: Date.now() - started });
        });
        req.on('error', () => resolve({ ok: false, status: null, latencyMs: null }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: null, latencyMs: timeoutMs }); });
        req.end();
    });
}

// ─── cached overview ────────────────────────────────────────────────────────
let cache = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 20_000;

async function buildOverview(client) {
    const now = Date.now();
    // Gateway state is cheap to read and must reflect the live client — do NOT cache it.
    // Counters + probes ARE cached. We fetch gateway live every call, below.
    let gateway = null;
    try {
        if (client?.ws) {
            gateway = {
                connected: client.ws.status === 0,
                ping_ms: Number.isFinite(client.ws.ping) ? Math.round(client.ws.ping) : null,
                uptime_seconds: Math.round((client.uptime ?? 0) / 1000),
                guild_count_on_shard: client.guilds?.cache?.size ?? null,
            };
        }
    } catch { /* gateway unreachable */ }

    // Serve cached halves if fresh — but re-stitch gateway from the live client each time.
    if (cache && now < cacheExpiry) {
        return { ...cache, bot: gateway ? {
            status: gateway.connected ? "online" : "offline",
            gateway_ping_ms: gateway.ping_ms,
            uptime_seconds: gateway.uptime_seconds,
        } : cache.bot, checked_at: new Date().toISOString() };
    }

    // 2. Counters — single query, cheap.
    let counters = null;
    try {
        const [rows] = await pool.execute(`
            SELECT
                (SELECT COUNT(*) FROM phishing_domains) AS scam_domains_blocked,
                (SELECT COUNT(*) FROM custom_bots) AS branded_bots,
                (SELECT COUNT(*) FROM infractions) AS infractions_logged
        `);
        counters = rows[0] || null;
    } catch (err) { logger.warn(`${LOG} counters query failed`, { err: err.message }); }

    // Server count from Discord (the main bot's and every custom bot's guild caches, deduplicated:
    // dashboard/server.js getServerStats, the number / and /status show), not the guilds table,
    // which only follows Discord through the join and leave events.
    let liveGuilds = null;
    try {
        if (typeof global.getServerStats === 'function' && client) liveGuilds = global.getServerStats(client).guilds;
    } catch (err) { logger.warn(`${LOG} server count failed`, { err: err.message }); }

    // 3. External API health — three parallel HEAD probes with short timeout.
    const [discord, twitch, kick] = await Promise.all([
        probe('https://discord.com/api/v10/gateway'),
        probe('https://id.twitch.tv/oauth2/validate'),
        probe('https://kick.com/'),
    ]);

    const overview = {
        ok: true,
        service: 'CertiFried',
        checked_at: new Date().toISOString(),
        bot: {
            status: gateway?.connected ? 'online' : 'offline',
            gateway_ping_ms: gateway?.ping_ms ?? null,
            uptime_seconds: gateway?.uptime_seconds ?? null,
        },
        dashboard: {
            status: 'online',   // if this responds, the dashboard is up
        },
        external_apis: {
            discord: { status: discord.ok ? 'online' : 'offline', latency_ms: discord.latencyMs },
            twitch:  { status: twitch.ok  ? 'online' : 'offline', latency_ms: twitch.latencyMs },
            kick:    { status: kick.ok    ? 'online' : 'offline', latency_ms: kick.latencyMs },
        },
        metrics: counters ? {
            live_guilds: Number(liveGuilds) || 0,
            scam_domains_blocked: Number(counters.scam_domains_blocked) || 0,
            branded_bots: Number(counters.branded_bots) || 0,
            infractions_logged: Number(counters.infractions_logged) || 0,
        } : null,
    };

    cache = overview;
    cacheExpiry = now + CACHE_TTL_MS;
    return overview;
}

// ─── routes ─────────────────────────────────────────────────────────────────
router.get('/overview', limiter, async (req, res) => {
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=20');
        res.json(await buildOverview(req.app.locals.client));
    } catch (err) {
        logger.error(`${LOG} overview failed`, { err: err.message });
        res.status(500).json({ ok: false, error: 'internal_error' });
    }
});

// ─── HTML page ──────────────────────────────────────────────────────────────
// Rendered in the shared site frame (views/site-frame.ejs). Fetches /api/status/public/overview
// every 20 s. All dynamic DOM updates use textContent and class names — no innerHTML anywhere.
const PAGE_BODY = `
<main id="main-content" tabindex="-1" class="cfs-main cfs-main--narrow pp-status">
  <div class="cfs-pagehead">
    <h1>CertiFried status</h1>
    <p class="cfs-lede">The Discord bot, the dashboard and the services they depend on, checked live.</p>
    <p class="cfs-meta" id="checked">Loading current status…</p>
  </div>

  <section class="cfs-section" aria-labelledby="ps-svc-h">
    <h2 id="ps-svc-h">Services</h2>
    <div class="cfs-rows">
      <div class="cfs-row" id="svc-bot" data-name="Discord bot"><span class="cfs-dot is-pending" aria-hidden="true"></span><span class="cfs-row-main cfs-row-title">Discord bot</span><span class="cfs-row-end meta">Checking…</span></div>
      <div class="cfs-row" id="svc-dash" data-name="Dashboard"><span class="cfs-dot is-pending" aria-hidden="true"></span><span class="cfs-row-main cfs-row-title">Dashboard</span><span class="cfs-row-end meta">Checking…</span></div>
    </div>
  </section>

  <section class="cfs-section" aria-labelledby="ps-ext-h">
    <h2 id="ps-ext-h">Upstream APIs</h2>
    <div class="cfs-rows">
      <div class="cfs-row" id="ext-discord" data-name="Discord API"><span class="cfs-dot is-pending" aria-hidden="true"></span><span class="cfs-row-main cfs-row-title">Discord API</span><span class="cfs-row-end meta">Checking…</span></div>
      <div class="cfs-row" id="ext-twitch" data-name="Twitch API"><span class="cfs-dot is-pending" aria-hidden="true"></span><span class="cfs-row-main cfs-row-title">Twitch API</span><span class="cfs-row-end meta">Checking…</span></div>
      <div class="cfs-row" id="ext-kick" data-name="Kick"><span class="cfs-dot is-pending" aria-hidden="true"></span><span class="cfs-row-main cfs-row-title">Kick</span><span class="cfs-row-end meta">Checking…</span></div>
    </div>
  </section>

  <section class="cfs-section" aria-labelledby="ps-num-h">
    <h2 id="ps-num-h">By the numbers</h2>
    <div class="cfs-stats">
      <div class="cfs-stat"><b id="n-guilds">—</b><span>Discord servers</span></div>
      <div class="cfs-stat"><b id="n-scams">—</b><span>Scam domains blocked</span></div>
      <div class="cfs-stat"><b id="n-brand">—</b><span>Branded bots in use</span></div>
      <div class="cfs-stat"><b id="n-mod">—</b><span>Moderation actions</span></div>
    </div>
  </section>

  <p class="pp-meta">Updates every 20 seconds. JSON at <a href="/api/status/public/overview">/api/status/public/overview</a>. Incidents and live streams: <a href="/status">status page</a>.</p>
</main>`;

const PAGE_SCRIPT = `<script>
(function () {
  function fmt(n) { try { return new Intl.NumberFormat('en-US').format(n); } catch (e) { return String(n); } }
  function fmtMs(n) { return n == null ? '—' : (n + ' ms'); }
  function fmtDur(s) {
    if (!Number.isFinite(s)) return '—';
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm';
  }
  // Safe DOM update: the rows are static markup; only the dot's class and the text change.
  function set(id, ok, metaText) {
    var el = document.getElementById(id); if (!el) return;
    var dot = el.querySelector('.cfs-dot');
    if (dot) dot.className = 'cfs-dot ' + (ok ? 'cfs-dot--ok' : 'cfs-dot--bad');
    var meta = el.querySelector('.meta');
    if (meta) meta.textContent = metaText;
  }
  function setNumber(id, value) {
    var el = document.getElementById(id); if (!el) return;
    el.textContent = fmt(value);
  }
  async function tick() {
    var checked = document.getElementById('checked');
    try {
      var r = await fetch('/api/status/public/overview', { cache: 'no-store' });
      var d = await r.json();
      var up = d.bot.status === 'online';
      set('svc-bot', up, up ? ('Online · ' + fmtMs(d.bot.gateway_ping_ms) + ' · up ' + fmtDur(d.bot.uptime_seconds)) : 'Offline');
      set('svc-dash', true, 'Online');
      ['discord', 'twitch', 'kick'].forEach(function (k) {
        var e = d.external_apis[k];
        set('ext-' + k, e.status === 'online', e.status === 'online' ? ('Online · ' + fmtMs(e.latency_ms)) : 'Offline');
      });
      if (d.metrics) {
        setNumber('n-guilds', d.metrics.live_guilds);
        setNumber('n-scams', d.metrics.scam_domains_blocked);
        setNumber('n-brand', d.metrics.branded_bots);
        setNumber('n-mod', d.metrics.infractions_logged);
      }
      if (checked) checked.textContent = 'Checked ' + new Date(d.checked_at).toLocaleTimeString();
    } catch (e) {
      if (checked) checked.textContent = 'Could not reach the status endpoint. Retrying…';
    }
  }
  tick(); setInterval(tick, 20000);
})();
</script>`;

/** The page's site-frame locals (views/site-frame.ejs). Pure: scripts/theme-audit renders it too. */
export function publicStatusPage() {
    return {
        title: 'Service status · CertiFried',
        description: 'Live operational status for CertiFried: the Discord bot, the dashboard and the health of the Discord, Twitch and Kick APIs.',
        path: '/api/status/public/page',
        headHtml: stylesheetTag('/css/cf-public-pages.css'),
        bodyHtml: PAGE_BODY,
        scriptsHtml: PAGE_SCRIPT,
    };
}

router.get('/page', async (req, res, next) => {
    try {
        // private: the site header can carry the signed-in user's name and avatar.
        res.setHeader('Cache-Control', 'private, max-age=60');
        await sendFramed(req, res, publicStatusPage());
    } catch (err) { next(err); }
});

export default router;
