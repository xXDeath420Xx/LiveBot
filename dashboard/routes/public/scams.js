/**
 * Public scam-database lookup page.
 *
 * Lets anyone paste a domain and see whether it's in CertiFried's phishing list, plus the
 * overall list size as a trust signal. Same transport pattern as /api/public/checkurl, but
 * presents an HTML page by default (checkurl is API-first).
 *
 * All data served here is already public (list size, per-domain yes/no). No per-guild
 * context, no account state, no logs — safe to serve CORS-open with no auth.
 *
 * GET /scams redirects to /api/public/scams/page (dashboard/server.js).
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../../utils/logger.js';
import { checkUrl } from '../../../core/message-threats.js';
import { sendFramed } from '../../services/site-frame.js';
import { stylesheetTag } from '../../services/framed-assets.js';

const router = express.Router();
const LOG = '[PublicScams]';

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.headers['cf-connecting-ip'] || req.ip || 'unknown').toString(),
    message: { ok: false, error: 'rate_limited' },
});

router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

router.get('/lookup', limiter, async (req, res) => {
    const input = String(req.query?.domain ?? req.query?.url ?? '').trim().slice(0, 300);
    if (!input) {
        return res.status(400).json({ ok: false, error: 'bad_input', message: 'Provide ?domain=example.com' });
    }
    try {
        const result = await checkUrl(input, null);
        const verdict = result.listed ? 'flagged' : (result.safe ? 'safe' : 'unknown');
        res.json({
            ok: true,
            input,
            host: result.host || null,
            verdict,
            flagged: !!result.listed,
            safe: !!result.safe,
            listed_as: result.listedAs || null,
            domains_checked_against: Number(result.listSize) || 0,
            attribution: 'CertiFried bot threat intelligence · https://certifriedmultitool.com',
            checked_at: new Date().toISOString(),
        });
    } catch (err) {
        logger.error(`${LOG} lookup failed`, { err: err.message, inputLen: input.length });
        res.status(500).json({ ok: false, error: 'internal_error' });
    }
});

// ─── HTML page ──────────────────────────────────────────────────────────────
// Rendered in the shared site frame (views/site-frame.ejs: site header, footer, theme). The page
// script only touches the ids below (#f, #q, #btn, #v, #n-list, #n-guilds) and builds the verdict
// with textContent, never innerHTML.
const PAGE_BODY = `
<main id="main-content" tabindex="-1" class="cfs-main cfs-main--narrow">
  <div class="cfs-pagehead">
    <h1>Scam domain lookup</h1>
    <p class="cfs-lede">Check whether a domain is in CertiFried's phishing database. The list is refreshed every 4 hours. No account needed.</p>
  </div>

  <div class="cfs-stats pp-stats-2" aria-label="The list in numbers">
    <div class="cfs-stat"><b id="n-list">—</b><span>Domains tracked</span></div>
    <div class="cfs-stat"><b id="n-guilds">—</b><span>Discord servers protected</span></div>
  </div>

  <section class="cfs-panel cfs-panel-pad pp-panel-gap" aria-label="Check a domain">
    <form id="f" class="pp-form" autocomplete="off">
      <label class="visually-hidden" for="q">Domain or link</label>
      <input type="text" id="q" class="form-control" placeholder="example.com" inputmode="url" autofocus>
      <button type="submit" id="btn" class="btn btn-primary">Check</button>
    </form>
    <div class="pp-verdict" id="v" role="status" aria-live="polite"></div>
    <p class="pp-help">Also available as a JSON API: <a href="/api/public/scams/lookup?domain=example.com">/api/public/scams/lookup?domain=…</a>. More endpoints: <a href="/api/public/">public API</a>.</p>
  </section>
</main>`;

const PAGE_SCRIPT = `<script>
(function () {
  var fmt = function (n) { try { return new Intl.NumberFormat('en-US').format(n); } catch (e) { return String(n); } };
  var vEl = document.getElementById('v');
  var btn = document.getElementById('btn');

  function showVerdict(cls, title, detail) {
    vEl.className = 'pp-verdict ' + cls;
    while (vEl.firstChild) vEl.removeChild(vEl.firstChild);
    var strong = document.createElement('strong');
    strong.textContent = title;
    var p = document.createElement('div');
    p.className = 'meta';
    p.textContent = detail;
    vEl.appendChild(strong);
    vEl.appendChild(p);
    vEl.style.display = 'block';
  }

  async function check(domain) {
    btn.disabled = true;
    try {
      var r = await fetch('/api/public/scams/lookup?domain=' + encodeURIComponent(domain));
      var d = await r.json();
      if (!d.ok) {
        showVerdict('unknown', 'Could not check', d.message || d.error || 'Try again.');
      } else if (d.flagged) {
        showVerdict('flagged', 'Flagged', (d.host || domain) + ' is in our phishing and scam list' + (d.listed_as ? ' (' + d.listed_as + ')' : '') + '. Do not open it.');
      } else if (d.safe) {
        showVerdict('safe', 'Known safe', (d.host || domain) + ' is on our list of known-good domains.');
      } else {
        showVerdict('unknown', 'Not currently flagged', 'We have no record of ' + (d.host || domain) + ' as either phishing or verified safe. Not being on the list is not proof that it is safe, so take the usual care.');
      }
    } catch (e) {
      showVerdict('unknown', 'Could not check', 'Network error. Try again shortly.');
    } finally { btn.disabled = false; }
  }

  document.getElementById('f').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = document.getElementById('q').value.trim();
    if (q) check(q);
  });

  // The numbers come from the status aggregator (same data, one call).
  fetch('/api/status/public/overview').then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.metrics) {
      document.getElementById('n-list').textContent = fmt(d.metrics.scam_domains_blocked);
      document.getElementById('n-guilds').textContent = fmt(d.metrics.live_guilds);
    }
  }).catch(function () { /* non-critical */ });
})();
</script>`;

/** The page's site-frame locals (views/site-frame.ejs). Pure: scripts/theme-audit renders it too. */
export function scamsPage() {
    return {
        title: 'Scam domain lookup · CertiFried',
        description: "Check whether a domain is in CertiFried's phishing and scam database. Free, no account needed.",
        path: '/scams',
        headHtml: stylesheetTag('/css/cf-public-pages.css'),
        bodyHtml: PAGE_BODY,
        scriptsHtml: PAGE_SCRIPT,
    };
}

router.get('/page', async (req, res, next) => {
    try {
        // private: the site header can carry the signed-in user's name and avatar.
        res.setHeader('Cache-Control', 'private, max-age=300');
        await sendFramed(req, res, scamsPage());
    } catch (err) { next(err); }
});

export default router;
