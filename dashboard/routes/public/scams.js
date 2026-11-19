/**
 * Public scam-database lookup page.
 *
 * Lets anyone paste a domain and see whether it's in CertiFried's phishing list, plus the
 * overall list size as a trust signal. Same transport pattern as /api/public/checkurl, but
 * presents an HTML page by default (checkurl is API-first).
 *
 * All data served here is already public (list size, per-domain yes/no). No per-guild
 * context, no account state, no logs — safe to serve CORS-open with no auth.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../../utils/logger.js';
import { checkUrl } from '../../../core/message-threats.js';

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

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="index,follow" />
<title>CertiFried · Scam domain lookup</title>
<meta name="description" content="Check whether a domain is in CertiFried's phishing / scam database. 413K+ domains tracked. Free, no account needed." />
<style>
  :root { color-scheme: light dark; --bg:#0b0d10; --fg:#e8ecef; --muted:#8a929b; --card:#15181c; --line:#242830; --ok:#2fbe6a; --warn:#e2b23a; --err:#e35858; --accent:#5865f2; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --fg:#15181c; --muted:#5c6670; --card:#ffffff; --line:#e5e8ec; } }
  html,body { background:var(--bg); color:var(--fg); font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; margin:0; }
  main { max-width:720px; margin:0 auto; padding:48px 20px 80px; }
  header { margin-bottom:24px; }
  h1 { font-size:22px; font-weight:600; margin:0; letter-spacing:-0.01em; }
  .lede { color:var(--muted); font-size:14px; margin:6px 0 0; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:20px; margin-bottom:16px; }
  form { display:flex; gap:8px; }
  input[type="text"] { flex:1; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:10px 14px; font-size:15px; font-family:inherit; }
  input[type="text"]:focus { outline:none; border-color:var(--accent); }
  button { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:10px 18px; font-size:15px; font-weight:500; cursor:pointer; font-family:inherit; }
  button:hover { opacity:0.92; }
  button:disabled { opacity:0.5; cursor:not-allowed; }
  .verdict { display:none; margin-top:16px; padding:14px 16px; border-radius:8px; font-size:14px; line-height:1.5; }
  .verdict.flagged { background:rgba(227,88,88,0.12); border:1px solid var(--err); }
  .verdict.safe    { background:rgba(47,190,106,0.12); border:1px solid var(--ok); }
  .verdict.unknown { background:rgba(226,178,58,0.12); border:1px solid var(--warn); }
  .verdict strong { display:block; margin-bottom:4px; font-weight:600; font-size:15px; }
  .meta { color:var(--muted); font-size:13px; }
  .stats { display:grid; grid-template-columns: 1fr 1fr; gap:1px; background:var(--line); border:1px solid var(--line); border-radius:10px; overflow:hidden; margin-bottom:16px; }
  .stats > div { background:var(--card); padding:16px 18px; }
  .stats .tiny { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:6px; }
  .stats .big { font-size:28px; font-weight:600; letter-spacing:-0.01em; font-variant-numeric: tabular-nums; }
  .foot { color:var(--muted); font-size:13px; margin-top:8px; }
  .foot a { color:inherit; }
  footer { color:var(--muted); font-size:12px; margin-top:24px; text-align:center; }
  @media (max-width:520px) { .stats { grid-template-columns:1fr; } form { flex-direction:column; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>Scam domain lookup</h1>
    <p class="lede">Check whether a domain is flagged by CertiFried's phishing database. 413 K+ domains tracked, refreshed every 4 hours. No account needed.</p>
  </header>

  <div class="stats">
    <div><div class="tiny">Domains tracked</div><div class="big" id="n-list">—</div></div>
    <div><div class="tiny">Discord servers protected</div><div class="big" id="n-guilds">—</div></div>
  </div>

  <div class="card">
    <form id="f" autocomplete="off">
      <input type="text" id="q" placeholder="example.com" inputmode="url" autofocus />
      <button type="submit" id="btn">Check</button>
    </form>
    <div class="verdict" id="v" role="status" aria-live="polite"></div>
    <p class="foot">Also available as a JSON API: <a href="/api/public/scams/lookup?domain=example.com">/api/public/scams/lookup?domain=…</a></p>
  </div>

  <footer>
    <a href="/">certifriedmultitool.com</a> · <a href="/status">status</a> · <a href="/api/public/">public API</a>
  </footer>
</main>
<script>
(function () {
  var fmt = function (n) { try { return new Intl.NumberFormat('en-US').format(n); } catch { return String(n); } };
  var vEl = document.getElementById('v');
  var btn = document.getElementById('btn');

  function showVerdict(cls, title, detail) {
    vEl.className = 'verdict ' + cls;
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
        showVerdict('flagged', '⚠  Flagged', (d.host || domain) + ' is in our phishing / scam list' + (d.listed_as ? ' (' + d.listed_as + ')' : '') + '. Avoid.');
      } else if (d.safe) {
        showVerdict('safe', '✓  Known safe', (d.host || domain) + ' is on our allow-list of known-good domains.');
      } else {
        showVerdict('unknown', 'Not currently flagged', 'We have no record of ' + (d.host || domain) + ' as either phishing or verified safe. Absence from the list is not proof of safety — exercise normal caution.');
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

  // Load the by-the-numbers tiles from the status aggregator (same data, one call).
  fetch('/api/status/public/overview').then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.metrics) {
      document.getElementById('n-list').textContent = fmt(d.metrics.scam_domains_blocked);
      document.getElementById('n-guilds').textContent = fmt(d.metrics.live_guilds);
    }
  }).catch(function () { /* non-critical */ });
})();
</script>
</body>
</html>`;

router.get('/page', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(PAGE);
});

export default router;
