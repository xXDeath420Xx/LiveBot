/**
 * Public holiday countdown page.
 *
 * Three faces, same data:
 *   GET /countdown/:slug         → HTML with OpenGraph tags so Discord/Slack
 *                                  auto-unfurl the share into a rich card
 *   GET /countdown/:slug.png     → 1200×630 PNG (OG image size), canvas-rendered
 *   GET /countdown/:slug.json    → JSON for other integrations
 *
 * No auth, rate-limited at the edge. The ?d=YYYY-MM-DD query param that the
 * share-link helper appends is purely a cache-buster for Discord's embed cache;
 * the server ignores it when computing the countdown (always "now").
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createCanvas } from 'canvas';
import {
    getHoliday,
    computeCountdown,
    listCatalog,
    formatHolidayDate,
    publicCountdownUrl,
} from '../../../core/holiday-manager.js';
import logger from '../../../utils/logger.js';

const LOG = '[PublicCountdown]';
const router = express.Router();

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.headers['cf-connecting-ip'] || req.ip || 'unknown').toString(),
    message: 'rate_limited',
});

// Scope the limiter to /countdown/* only. The router is mounted at '/' in
// server.js, so a plain router.use(limiter) runs on EVERY dashboard request.
router.use('/countdown', limiter);

/** Pick a background colour per holiday for the PNG card. */
function paletteFor(slug) {
    const map = {
        'christmas':       { bg: '#1B3A2A', accent: '#C8102E', ink: '#FFFFFF' },
        'new-year':        { bg: '#1A1A2E', accent: '#FFD700', ink: '#FFFFFF' },
        'new-years-eve':   { bg: '#0F1033', accent: '#FFD700', ink: '#FFFFFF' },
        'halloween':       { bg: '#1A0E14', accent: '#FF7F11', ink: '#FFFFFF' },
        'valentines':      { bg: '#2A0E18', accent: '#FF4F79', ink: '#FFFFFF' },
        'st-patricks':     { bg: '#0F2A1C', accent: '#1F8B4C', ink: '#FFFFFF' },
        'fourtwenty':      { bg: '#0F1F10', accent: '#3BA55D', ink: '#FFFFFF' },
        'independence-us': { bg: '#0F1A2E', accent: '#2C7AC9', ink: '#FFFFFF' },
        'canada-day':      { bg: '#1A0E12', accent: '#C8102E', ink: '#FFFFFF' },
        'juneteenth':      { bg: '#2A1409', accent: '#E4572E', ink: '#FFFFFF' },
        'thanksgiving-us': { bg: '#20160A', accent: '#B36B2E', ink: '#FFFFFF' },
        'thanksgiving-ca': { bg: '#20160A', accent: '#B36B2E', ink: '#FFFFFF' },
        'mothers-day-us':  { bg: '#2A1A22', accent: '#E88AAE', ink: '#FFFFFF' },
        'fathers-day-us':  { bg: '#0F1A24', accent: '#3B6E8F', ink: '#FFFFFF' },
        'labor-day-us':    { bg: '#15172A', accent: '#5865F2', ink: '#FFFFFF' },
        'memorial-day-us': { bg: '#0F1A2E', accent: '#2C7AC9', ink: '#FFFFFF' },
        'mlk-day':         { bg: '#15172A', accent: '#5865F2', ink: '#FFFFFF' },
        'easter':          { bg: '#2A1F24', accent: '#FFC0CB', ink: '#FFFFFF' },
        'lunar-new-year':  { bg: '#1F0A0A', accent: '#E43B3B', ink: '#FFFFFF' },
        'diwali':          { bg: '#1E1407', accent: '#E49B0F', ink: '#FFFFFF' },
        'hanukkah':        { bg: '#0F1A24', accent: '#3B6E8F', ink: '#FFFFFF' },
        'ramadan':         { bg: '#0F1F1A', accent: '#4B8673', ink: '#FFFFFF' },
        'eid-al-fitr':     { bg: '#0F1F1A', accent: '#4B8673', ink: '#FFFFFF' },
    };
    return map[slug] || { bg: '#15172A', accent: '#5865F2', ink: '#FFFFFF' };
}

/**
 * Draw a 1200×630 PNG countdown card. No external fonts — relies on whatever
 * default canvas has (DejaVu on the server), so we stay dep-light.
 */
function renderCardPng(info) {
    const W = 1200, H = 630;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const pal = paletteFor(info.slug);

    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = pal.accent;
    ctx.fillRect(0, 0, W, 8);

    const headline = info.isToday ? 'Today!' : `${info.daysRemaining}`;
    ctx.fillStyle = pal.ink;
    ctx.font = 'bold 260px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(headline, 80, 110);

    if (!info.isToday) {
        ctx.fillStyle = pal.accent;
        ctx.font = 'bold 48px sans-serif';
        ctx.fillText(info.daysRemaining === 1 ? 'day until' : 'days until', 80, 70);
    }

    ctx.fillStyle = pal.ink;
    ctx.font = 'bold 96px sans-serif';
    const labelText = `${info.emoji} ${info.label}`;
    ctx.fillText(labelText, 80, 400);

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '36px sans-serif';
    ctx.fillText(formatHolidayDate(info.nextDate), 80, 510);

    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '26px sans-serif';
    ctx.fillText('certifriedmultitool.com', W - 60, H - 60);

    return canvas.toBuffer('image/png');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function renderHtml(info, { host, slug }) {
    const url = `https://${host}/countdown/${encodeURIComponent(slug)}`;
    const imgUrl = `https://${host}/countdown/${encodeURIComponent(slug)}.png`;
    const title = info.isToday
        ? `Today is ${info.label}!`
        : `${info.daysRemaining} day${info.daysRemaining === 1 ? '' : 's'} until ${info.label}`;
    const desc = `${info.label} falls on ${formatHolidayDate(info.nextDate)}. Live countdown · CertiFried`;
    // Discord bakes OG fields into a message's embed at post time and never refreshes them, so
    // using the dynamic "60 days until X" there means stale text forever. We hand Discord an
    // evergreen title/description and keep the live number inside the og:image (which Discord's
    // proxy does re-fetch over time, with the short Cache-Control on the PNG route below).
    const evergreenTitle = info.isToday
        ? `Today is ${info.label}`
        : `${info.label} countdown · CertiFried`;
    const evergreenDesc = `Live countdown to ${info.label} — see current days remaining.`;
    const pal = paletteFor(info.slug);

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="index,follow" />
<title>${escapeHtml(title)} · CertiFried</title>
<meta name="description" content="${escapeHtml(desc)}" />

<!-- Open Graph (Discord, Facebook, Slack) — evergreen so posted embeds don't go stale. -->
<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeHtml(evergreenTitle)}" />
<meta property="og:description" content="${escapeHtml(evergreenDesc)}" />
<meta property="og:image" content="${imgUrl}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:url" content="${url}" />
<meta property="og:site_name" content="CertiFried" />

<!-- Twitter / X -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(evergreenTitle)}" />
<meta name="twitter:description" content="${escapeHtml(evergreenDesc)}" />
<meta name="twitter:image" content="${imgUrl}" />

<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: ${pal.bg}; color: ${pal.ink}; font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 64px 24px 96px; }
  .accent { color: ${pal.accent}; }
  .kicker { color: ${pal.accent}; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; font-size: 14px; margin: 0 0 12px; }
  h1 { margin: 0 0 8px; font-size: clamp(80px, 18vw, 180px); line-height: 1; font-weight: 800; letter-spacing: -0.02em; }
  .label { margin: 32px 0 8px; font-size: clamp(32px, 6vw, 56px); font-weight: 700; }
  .date { color: rgba(255,255,255,0.75); font-size: clamp(16px, 2.4vw, 22px); margin: 0 0 48px; }
  .meta { color: rgba(255,255,255,0.55); font-size: 14px; display: flex; gap: 24px; flex-wrap: wrap; }
  .meta a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
  .others { margin-top: 72px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 32px; }
  .others h2 { font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.55); margin: 0 0 16px; font-weight: 600; }
  .others ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
  .others li { padding: 0; }
  .others a { color: inherit; text-decoration: none; display: block; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; font-size: 14px; }
  .others a:hover { background: rgba(255,255,255,0.04); }
  .others .d { color: ${pal.accent}; font-weight: 600; margin-right: 8px; }
</style>
</head>
<body>
<main class="wrap">
  ${info.isToday ? '<p class="kicker">Today</p>' : `<p class="kicker">${info.daysRemaining === 1 ? '1 day until' : `${info.daysRemaining} days until`}</p>`}
  <h1>${info.isToday ? '🎉' : escapeHtml(String(info.daysRemaining))}</h1>
  <p class="label">${escapeHtml(info.emoji)} ${escapeHtml(info.label)}</p>
  <p class="date">${escapeHtml(formatHolidayDate(info.nextDate))}</p>
  <p class="meta">
    <a href="/countdown/${encodeURIComponent(slug)}.json">JSON</a>
    <a href="/countdown/${encodeURIComponent(slug)}.png">OG image</a>
    <a href="/">CertiFried</a>
  </p>
  <section class="others">
    <h2>Other countdowns</h2>
    <ul id="others"><!-- hydrated client-side --></ul>
  </section>
</main>
<script>
  // Progressive enhancement: hydrate the "other countdowns" list client-side
  // using safe DOM methods (createElement + textContent). No innerHTML even
  // for our own JSON — stay out of the habit.
  fetch('/countdown.json').then(function(r){return r.json();}).then(function(d){
    var ul = document.getElementById('others');
    if (!ul || !Array.isArray(d.countdowns)) return;
    var currentSlug = ${JSON.stringify(slug)};
    for (var i = 0; i < d.countdowns.length; i++) {
      var c = d.countdowns[i];
      if (c.slug === currentSlug) continue;
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '/countdown/' + encodeURIComponent(c.slug);
      var sp = document.createElement('span');
      sp.className = 'd';
      sp.textContent = (c.isToday ? 'today!' : (c.daysRemaining + 'd'));
      a.appendChild(sp);
      a.appendChild(document.createTextNode(' ' + c.emoji + ' ' + c.label));
      li.appendChild(a);
      ul.appendChild(li);
    }
  }).catch(function(){ /* non-essential */ });
</script>
</body>
</html>`;
}

// Index/JSON — list of every holiday with its days-remaining.
router.get('/countdown.json', async (_req, res) => {
    try {
        const list = [];
        for (const h of listCatalog()) {
            const info = await computeCountdown(h.slug);
            if (info) list.push({
                slug: info.slug, label: info.label, emoji: info.emoji,
                daysRemaining: info.daysRemaining, isToday: info.isToday,
                nextDate: info.nextDate.toISOString().slice(0, 10),
                year: info.year,
            });
        }
        list.sort((a, b) => a.daysRemaining - b.daysRemaining);
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({ ok: true, countdowns: list });
    } catch (e) {
        logger.error(`${LOG} index failed`, { err: e.message });
        res.status(500).json({ ok: false, error: 'internal_error' });
    }
});

router.get('/countdown', (_req, res) => res.redirect(302, '/countdown.json'));

// Per-slug PNG (checked BEFORE the HTML route since Express matches order).
// The image is the one surface that stays live on already-posted Discord messages
// — Discord's media proxy will re-fetch it as its own CDN cache rolls over. Short
// max-age + a date-stamped ETag nudges intermediate caches to revalidate daily.
router.get('/countdown/:slug.png', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase();
    try {
        if (!getHoliday(slug)) return res.status(404).type('text/plain').send('unknown');
        const info = await computeCountdown(slug);
        if (!info) return res.status(500).type('text/plain').send('unavailable');
        const today = new Date().toISOString().slice(0, 10);
        const etag = `W/"${slug}-${today}-${info.daysRemaining}"`;
        if (req.headers['if-none-match'] === etag) {
            res.status(304).end();
            return;
        }
        const buf = renderCardPng(info);
        res.set('Cache-Control', 'public, max-age=600, must-revalidate');
        res.set('ETag', etag);
        res.set('Content-Type', 'image/png');
        res.send(buf);
    } catch (e) {
        logger.error(`${LOG} slug PNG failed`, { slug, err: e.message });
        res.status(500).type('text/plain').send('internal error');
    }
});

// Per-slug JSON
router.get('/countdown/:slug.json', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase();
    try {
        if (!getHoliday(slug)) return res.status(404).json({ ok: false, error: 'unknown_holiday' });
        const info = await computeCountdown(slug);
        if (!info) return res.status(500).json({ ok: false, error: 'unavailable' });
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({
            ok: true,
            slug: info.slug, label: info.label, emoji: info.emoji,
            daysRemaining: info.daysRemaining, isToday: info.isToday,
            nextDate: info.nextDate.toISOString().slice(0, 10),
            year: info.year,
            shareUrl: publicCountdownUrl(slug),
        });
    } catch (e) {
        logger.error(`${LOG} slug JSON failed`, { slug, err: e.message });
        res.status(500).json({ ok: false, error: 'internal_error' });
    }
});

// Per-slug HTML
router.get('/countdown/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase();
    try {
        if (!getHoliday(slug)) {
            return res.status(404).type('html').send(`<!doctype html><title>Unknown holiday</title><body style="font-family:system-ui;background:#15172A;color:#fff;padding:40px"><h1>Unknown holiday</h1><p><code>${escapeHtml(slug)}</code> isn't in our catalog. <a href="/countdown.json" style="color:#5865F2">See the list</a>.</p></body>`);
        }
        const info = await computeCountdown(slug);
        if (!info) return res.status(500).send('countdown unavailable');
        const host = req.headers.host || 'certifriedmultitool.com';
        res.set('Cache-Control', 'public, max-age=600');
        res.type('html').send(renderHtml(info, { host, slug }));
    } catch (e) {
        logger.error(`${LOG} slug HTML failed`, { slug, err: e.message });
        res.status(500).send('internal error');
    }
});

export default router;
