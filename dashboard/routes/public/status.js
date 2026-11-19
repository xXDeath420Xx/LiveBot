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
// Self-contained — no external CSS/JS. Fetches /api/status/public/overview and renders.
// Pro/Linear-Stripe restraint per project style memory: no gradients, no emoji icons, no hype.
// All dynamic DOM updates use textContent / dataset-driven classes — no innerHTML string
// concatenation anywhere.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="index,follow" />
<title>CertiFried · Status</title>
<meta name="description" content="Live operational status for CertiFried: Discord bot, dashboard, and third-party API health." />
<style>
  :root { color-scheme: light dark; --bg:#0b0d10; --fg:#e8ecef; --muted:#8a929b; --card:#15181c; --line:#242830; --ok:#2fbe6a; --warn:#e2b23a; --err:#e35858; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --fg:#15181c; --muted:#5c6670; --card:#ffffff; --line:#e5e8ec; } }
  html,body { background:var(--bg); color:var(--fg); font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; margin:0; }
  main { max-width:860px; margin:0 auto; padding:48px 20px 80px; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:16px; margin-bottom:24px; flex-wrap:wrap; }
  h1 { font-size:22px; font-weight:600; margin:0; letter-spacing:-0.01em; }
  .lede { color:var(--muted); font-size:14px; margin:4px 0 0; }
  .row { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid var(--line); gap:16px; }
  .row:last-child { border-bottom:none; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:16px; overflow:hidden; }
  .card h2 { margin:0; padding:14px 18px; font-size:13px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); border-bottom:1px solid var(--line); }
  .label { font-size:14px; display:flex; align-items:center; }
  .meta { font-size:13px; color:var(--muted); font-variant-numeric: tabular-nums; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:10px; background:var(--muted); flex-shrink:0; }
  .dot.ok { background:var(--ok); } .dot.warn { background:var(--warn); } .dot.err { background:var(--err); }
  .big { font-size:28px; font-weight:600; letter-spacing:-0.01em; font-variant-numeric: tabular-nums; }
  .grid { display:grid; grid-template-columns: repeat(2, 1fr); gap:1px; background:var(--line); }
  .grid > div { background:var(--card); padding:16px 18px; }
  .grid .tiny { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:6px; }
  footer { color:var(--muted); font-size:12px; margin-top:24px; text-align:center; }
  footer a { color:inherit; }
  .pulse { animation:p 1.6s infinite; }
  @keyframes p { 0%,100%{opacity:0.5} 50%{opacity:1} }
  @media (max-width:520px) { .grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>CertiFried status</h1>
      <p class="lede" id="checked">Loading current status…</p>
    </div>
    <div class="meta"><a href="/" style="color:inherit;text-decoration:none;">&larr; certifriedmultitool.com</a></div>
  </header>

  <div class="card">
    <h2>Services</h2>
    <div class="row" id="svc-bot"  data-name="Discord bot"><span class="label"><span class="dot pulse"></span><span class="name">Discord bot</span></span><span class="meta">…</span></div>
    <div class="row" id="svc-dash" data-name="Dashboard"><span class="label"><span class="dot pulse"></span><span class="name">Dashboard</span></span><span class="meta">…</span></div>
  </div>

  <div class="card">
    <h2>Upstream APIs</h2>
    <div class="row" id="ext-discord" data-name="Discord API"><span class="label"><span class="dot pulse"></span><span class="name">Discord API</span></span><span class="meta">…</span></div>
    <div class="row" id="ext-twitch"  data-name="Twitch API"><span class="label"><span class="dot pulse"></span><span class="name">Twitch API</span></span><span class="meta">…</span></div>
    <div class="row" id="ext-kick"    data-name="Kick"><span class="label"><span class="dot pulse"></span><span class="name">Kick</span></span><span class="meta">…</span></div>
  </div>

  <div class="card">
    <h2>By the numbers</h2>
    <div class="grid">
      <div><div class="tiny">Discord servers</div><div class="big" id="n-guilds">—</div></div>
      <div><div class="tiny">Scam domains blocked</div><div class="big" id="n-scams">—</div></div>
      <div><div class="tiny">Branded bots in use</div><div class="big" id="n-brand">—</div></div>
      <div><div class="tiny">Moderation actions</div><div class="big" id="n-mod">—</div></div>
    </div>
  </div>

  <footer>
    Updates every 20 s · JSON at <a href="/api/status/public/overview">/api/status/public/overview</a>
  </footer>
</main>
<script>
(function () {
  function fmt(n) { try { return new Intl.NumberFormat('en-US').format(n); } catch { return String(n); } }
  function fmtMs(n) { return n == null ? '—' : (n + ' ms'); }
  function fmtDur(s) {
    if (!Number.isFinite(s)) return '—';
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm';
  }
  // Safe DOM update — no innerHTML, no string-built HTML. Row structure is already
  // static; we only toggle the dot class and swap textContent values.
  function set(id, dotClass, metaText) {
    var el = document.getElementById(id); if (!el) return;
    var dot = el.querySelector('.label .dot');
    if (dot) dot.className = 'dot ' + dotClass;
    var meta = el.querySelector('.meta');
    if (meta) meta.textContent = metaText;
  }
  function setNumber(id, value) {
    var el = document.getElementById(id); if (!el) return;
    el.textContent = fmt(value);
  }
  async function tick() {
    try {
      var r = await fetch('/api/status/public/overview', { cache: 'no-store' });
      var d = await r.json();
      set('svc-bot',
          d.bot.status === 'online' ? 'ok' : 'err',
          d.bot.status === 'online'
            ? ('Online · ' + fmtMs(d.bot.gateway_ping_ms) + ' · up ' + fmtDur(d.bot.uptime_seconds))
            : 'Offline');
      set('svc-dash', 'ok', 'Online');
      ['discord','twitch','kick'].forEach(function (k) {
        var e = d.external_apis[k];
        set('ext-' + k,
            e.status === 'online' ? 'ok' : 'err',
            e.status === 'online' ? ('Online · ' + fmtMs(e.latency_ms)) : 'Offline');
      });
      if (d.metrics) {
        setNumber('n-guilds', d.metrics.live_guilds);
        setNumber('n-scams',  d.metrics.scam_domains_blocked);
        setNumber('n-brand',  d.metrics.branded_bots);
        setNumber('n-mod',    d.metrics.infractions_logged);
      }
      var checked = document.getElementById('checked');
      if (checked) checked.textContent = 'Checked ' + new Date(d.checked_at).toLocaleTimeString();
    } catch (e) {
      var checked = document.getElementById('checked');
      if (checked) checked.textContent = 'Could not reach status endpoint. Retrying…';
    }
  }
  tick(); setInterval(tick, 20000);
})();
</script>
</body>
</html>`;

router.get('/page', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(PAGE);
});

export default router;
