/**
 * Public holiday countdown page.
 *
 * Three faces, same data:
 *   GET /countdown/:slug         → HTML with OpenGraph tags so Discord/Slack
 *                                  auto-unfurl the share into a rich card (in the
 *                                  shared site frame: services/site-frame.js)
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
import { sendFramed } from '../../services/site-frame.js';
import { stylesheetTag } from '../../services/framed-assets.js';

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

/**
 * The countdown page's site-frame locals (views/site-frame.ejs). Pure: scripts/theme-audit renders it.
 * The holiday colour is carried as --hc on the page and only used as an accent
 * (css/cf-public-pages.css mixes it toward the theme's text colour so it reads in every theme).
 */
export function countdownPage(info, { host, slug }) {
    const imgUrl = `https://${host}/countdown/${encodeURIComponent(slug)}.png`;
    const title = info.isToday
        ? `Today is ${info.label}`
        : `${info.daysRemaining} day${info.daysRemaining === 1 ? '' : 's'} until ${info.label}`;
    // Discord bakes OG fields into a message's embed at post time and never refreshes them, so
    // using the dynamic "60 days until X" there means stale text forever. We hand Discord an
    // evergreen title/description and keep the live number inside the og:image (which Discord's
    // proxy does re-fetch over time, with the short Cache-Control on the PNG route below).
    const evergreenTitle = info.isToday
        ? `Today is ${info.label}`
        : `${info.label} countdown · CertiFried`;
    const evergreenDesc = `Live countdown to ${info.label}: how many days are left.`;
    const pal = paletteFor(info.slug);
    const hc = /^#[0-9a-f]{6}$/i.test(pal.accent) ? pal.accent : '';
    const date = formatHolidayDate(info.nextDate);
    const s = encodeURIComponent(slug);

    const headHtml = `${stylesheetTag('/css/cf-public-pages.css')}
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(evergreenTitle)}">
<meta name="twitter:description" content="${escapeHtml(evergreenDesc)}">
<meta name="twitter:image" content="${escapeHtml(imgUrl)}">`;

    const bodyHtml = `
<main id="main-content" tabindex="-1" class="cfs-main cfs-main--narrow cd-page"${hc ? ` style="--hc:${hc}"` : ''}>
  <div class="cd-hero">
    <p class="cd-kicker">${info.isToday ? 'Today' : (info.daysRemaining === 1 ? '1 day until' : `${escapeHtml(String(info.daysRemaining))} days until`)}</p>
    <p class="cd-number">${info.isToday ? 'Today' : escapeHtml(String(info.daysRemaining))}</p>
    <h1 class="cd-label">${escapeHtml(info.label)}</h1>
    <p class="cd-date">${escapeHtml(date)}</p>
    <p class="cd-links">
      <a href="/countdown/${s}.json">JSON</a>
      <a href="/countdown/${s}.png">Share image</a>
      <a href="/countdown.json">All countdowns as JSON</a>
    </p>
  </div>
  <section class="cfs-section cd-others" id="others-section" aria-labelledby="cd-others-h" hidden>
    <h2 id="cd-others-h">Other countdowns</h2>
    <ul id="others"><!-- filled in by the script below --></ul>
  </section>
</main>`;

    const scriptsHtml = `<script>
  // Progressive enhancement: fill the "other countdowns" list with safe DOM methods
  // (createElement + textContent). No innerHTML, even for our own JSON.
  fetch('/countdown.json').then(function(r){return r.json();}).then(function(d){
    var ul = document.getElementById('others');
    if (!ul || !Array.isArray(d.countdowns)) return;
    var currentSlug = ${JSON.stringify(slug).replace(/</g, '\u003c')};
    for (var i = 0; i < d.countdowns.length; i++) {
      var c = d.countdowns[i];
      if (c.slug === currentSlug) continue;
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '/countdown/' + encodeURIComponent(c.slug);
      var sp = document.createElement('span');
      sp.className = 'd';
      sp.textContent = (c.isToday ? 'Today' : (c.daysRemaining + 'd'));
      a.appendChild(sp);
      a.appendChild(document.createTextNode(c.label));
      li.appendChild(a);
      ul.appendChild(li);
    }
    if (ul.children.length) document.getElementById('others-section').hidden = false;
  }).catch(function(){ /* non-essential */ });
</script>`;

    return {
        title: `${title} · CertiFried`,
        description: evergreenDesc,
        path: `/countdown/${s}`,
        ogTitle: evergreenTitle,
        ogImage: imgUrl,
        ogType: 'website',
        headHtml, bodyHtml, scriptsHtml,
    };
}

/** The 404 page for a slug that is not in the catalogue. */
export function unknownHolidayPage(slug) {
    return {
        title: 'Unknown holiday · CertiFried',
        description: 'That holiday is not in the CertiFried countdown catalogue.',
        noindex: true,
        headHtml: stylesheetTag('/css/cf-public-pages.css'),
        bodyHtml: `
<main id="main-content" tabindex="-1" class="cfs-main cfs-main--narrow">
  <div class="cfs-empty cfs-panel">
    <h2>Unknown holiday</h2>
    <p><code class="pp-code">${escapeHtml(slug)}</code> is not in our countdown catalogue. <a href="/countdown.json">See the list of holidays</a>.</p>
  </div>
</main>`,
        scriptsHtml: '',
    };
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
            return await sendFramed(req, res, unknownHolidayPage(slug), 404);
        }
        const info = await computeCountdown(slug);
        if (!info) return res.status(500).send('countdown unavailable');
        const host = req.headers.host || 'certifriedmultitool.com';
        // private: the site header can carry the signed-in user's name and avatar.
        res.set('Cache-Control', 'private, max-age=600');
        await sendFramed(req, res, countdownPage(info, { host, slug }));
    } catch (e) {
        logger.error(`${LOG} slug HTML failed`, { slug, err: e.message });
        res.status(500).send('internal error');
    }
});

export default router;
