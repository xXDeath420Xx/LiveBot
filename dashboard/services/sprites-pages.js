/**
 * The Sprite Tracker's page frame and its static pages, kept apart from dashboard/routes/sprites.js
 * (which starts background syncs and needs the bot's encryption key at import) so the theme audit
 * (scripts/theme-audit/pages.mjs) and tests can render them without a running bot.
 *
 *   shell(title, body, meta)  a page object; routes/sprites.js sends it through the site frame
 *                             (views/site-frame.ejs) with framedOptions(req, page)
 *   chrome(nav)               the tracker's section bar under the site header
 *   renderLogin(), renderAccount(...)  the sign-in and username/password pages
 *
 * Styles: dashboard/public/css/cf-sprites.css (site tokens, every theme).
 */
import { assetHref } from './framed-assets.js';
import { LOGIN_URL, EAS_CONFIGURED } from '../../core/epic-sprites.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Page frame ──────────────────────────────────────────────────────────────
// Every Sprite Tracker page sits in the shared site frame (views/site-frame.ejs via
// dashboard/services/site-frame.js): the site head, header, footer and theme, with the
// tracker's own section bar under the header. shell() returns a page object, not a string;
// the router-level res.send hook below renders it through the frame. String(page) is a
// plain fallback document (never sent in normal operation).
export const FRAMED_PAGE = Symbol('sprites.framedPage');
// The stylesheet link carries ?v=<content hash> (services/framed-assets.js), so Cloudflare, which
// caches /css by URL, serves a changed file at once.
export function spritesCssHref() {
  return assetHref('/css/cf-sprites.css');
}
// "Browse Collectors — CertiFried Sprite Tracker" -> "Browse Collectors · Sprite Tracker · CertiFried"
export function pageTitle(title) {
  const t = String(title || '').replace(/\s+[—-]\s+CertiFried(?: Sprite Tracker)?\s*$/, '').trim();
  return `${t || 'Sprite Tracker'}${t === 'Sprite Tracker' ? '' : ' · Sprite Tracker'} · CertiFried`;
}
const DEFAULT_DESCRIPTION = 'Fortnite Sprite collection tracker: sync your collection from Epic, compare with friends, and see what is coming next.';
export function shell(title, body, meta = null) {
  const page = { title: pageTitle(title), body, meta };
  return {
    [FRAMED_PAGE]: page,
    toString() {
      return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(page.title)}</title><link rel="stylesheet" href="/css/cf-ui.css"><link rel="stylesheet" href="/css/cf-site.css"><link rel="stylesheet" href="${spritesCssHref()}"></head><body class="cfs-body st-page"><div class="st-app">${body}</div></body></html>`;
    },
  };
}
// Frame options for a page object. OG/Twitter tags drive Discord (and Slack, X...) link
// unfurling of share pages; og:image carries the synced_at cache buster (Discord caches ~24h).
export function framedOptions(req, page) {
  const meta = page.meta || null;
  const twitter = meta ? [
    `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${esc(meta.title || page.title)}">`,
    `<meta name="twitter:description" content="${esc(meta.description || DEFAULT_DESCRIPTION)}">`,
    meta.image ? `<meta name="twitter:image" content="${esc(meta.image)}">` : '',
  ].join('') : '';
  return {
    title: page.title,
    description: (meta && meta.description) || DEFAULT_DESCRIPTION,
    path: (req.baseUrl || '') + (req.path === '/' ? '' : req.path) || '/sprites',
    ogTitle: meta && meta.title ? meta.title : null,
    ogImage: meta && meta.image ? meta.image : null,
    ogType: meta && meta.type ? meta.type : null,
    headHtml: `<link rel="stylesheet" href="${spritesCssHref()}">${twitter}`,
    bodyHtml: `<div class="st-app">${page.body}</div>`,
    bodyClass: 'st-page',
    active: '',
  };
}
// Section bar under the site header on every Sprite Tracker page. `match` lists the paths
// that mark a tab as the current one (set client-side from location.pathname, so no route
// has to thread a "current page" argument through to chrome()). `nav` is the page's own
// actions (the user menu, or a call to action), shown at the end of the bar.
const SITE_TABS = [
  { href: '/sprites', label: 'My collection', match: '/sprites /sprites/profile /sprites/account /sprites/discord-connect /sprites/admin' },
  { href: '/sprites/browse', label: 'Compare', match: '/sprites/browse /sprites/compare' },
  { href: '/sprites/cards', label: 'Cards', match: '/sprites/cards /sprites/override /sprites/garden' },
  { href: '/sprites/codes', label: 'Codes', match: '/sprites/codes' },
  { href: '/sprites/countdown', label: 'Next drop', match: '/sprites/countdown' },
  { href: '/sprites/info', label: 'Catalog audit', match: '/sprites/info' },
];
export function chrome(nav = '') {
  const tabs = SITE_TABS.map((t) => `<a href="${t.href}" data-match="${t.match}">${t.label}</a>`).join('');
  return `<nav class="st-subnav" aria-label="Sprite Tracker">
    <div class="st-subnav-inner">
      <a class="st-subnav-name" href="/sprites">Sprite Tracker</a>
      <div class="st-tabs">${tabs}</div>
      ${nav ? `<div class="st-subnav-actions">${nav}</div>` : ''}
    </div>
  </nav>
  <script>(function(){var p=location.pathname.replace(/\\/+$/,'')||'/';document.querySelectorAll('.st-tabs a').forEach(function(a){if((a.getAttribute('data-match')||'').split(' ').indexOf(p)!==-1)a.setAttribute('aria-current','page');});})();</script>`;
}

// Avatar-style colored circle from a display name's first character. The hue is
// derived from a stable hash of the full name so a given user always gets the
// same color across pages.
export function avatarMarkup(displayName) {
  const ch = (displayName || '?')[0].toUpperCase();
  let hash = 0;
  for (let i = 0; i < (displayName || '').length; i++) hash = (hash * 31 + displayName.charCodeAt(i)) & 0xffff;
  const hue = hash % 360;
  return `<span class="avatar" style="background:hsl(${hue},55%,42%)">${esc(ch)}</span>`;
}

// Logged-in user menu — top-nav dropdown for owner views. The Re-sync action
// lives in the grid toolbar (next to Sort) rather than here, since it's an
// "act on the data I'm looking at" action, not an account action.
export function userMenu({ displayName, isAdmin = false, currentPath = '' } = {}) {
  const item = (href, icon, label, opts = {}) => {
    const active = opts.active ? ' current' : '';
    const danger = opts.danger ? ' danger' : '';
    return `<a class="menu-item${active}${danger}" href="${esc(href)}"${opts.active ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  };
  const formItem = (action, icon, label, opts = {}) => {
    const danger = opts.danger ? ' danger' : '';
    return `<form method="post" action="${esc(action)}" class="menu-form"><button class="menu-item${danger}" type="submit">${esc(label)}</button></form>`;
  };
  return `<details class="usermenu">
    <summary>
      ${avatarMarkup(displayName)}
      <span class="usermenu-name">${esc(displayName)}</span>
      <span class="usermenu-caret" aria-hidden="true">▾</span>
    </summary>
    <div class="usermenu-dropdown">
      ${item('/sprites', '', 'My collection', { active: currentPath === '/sprites' })}
      ${item('/sprites/profile', '', 'My profile', { active: currentPath === '/sprites/profile' })}
      ${item('/sprites/account', '', 'Username & password', { active: currentPath === '/sprites/account' })}
      ${isAdmin ? item('/sprites/admin', '', 'Admin', { active: currentPath === '/sprites/admin' }) : ''}
      <div class="menu-divider"></div>
      ${formItem('/sprites/logout', '', 'Log out', { danger: true })}
    </div>
  </details>`;
}

// Bookmarklet source: runs on Epic's /id/api/redirect JSON page. Reads the
// authorizationCode from the response body, builds a hidden form, and submits
// it cross-origin to /sprites/auth — same end-state as the manual paste, but
// no copy needed. Wrapped in try/catch so clicking it from a non-Epic page
// just alerts the user instead of failing silently.
const BOOKMARKLET = `javascript:(function(){try{var t=document.body.innerText.trim();if(!t||t[0]!=='{')throw 0;var c=JSON.parse(t).authorizationCode;if(typeof c!=='string')throw 0;var f=document.createElement('form');f.method='POST';f.action='https://certifriedmultitool.com/sprites/auth';var i=document.createElement('input');i.type='hidden';i.name='code';i.value=c;f.appendChild(i);document.body.appendChild(f);f.submit();}catch(e){alert('CertiFried Sprite Tracker: To use this, sign into Epic first, then click this bookmark on the page that shows the JSON.');}})();`;

export function renderLogin({ error } = {}) {
  // The href attribute is double-quoted, so we only need to escape the few
  // chars that would close it or confuse HTML parsing: & " < >.
  const bookmarkletHref = BOOKMARKLET
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return shell('Sign in — CertiFried Sprite Tracker', chrome() + `<main id="main-content" tabindex="-1" class="st-main">
    <a href="#first-time" class="st-callout">
      <div>
        <b>First time here? Start with Epic Setup</b>
        <span>The sign-in options below only work after you have connected your Epic account once. Epic Setup is further down this page.</span>
      </div>
      <span class="st-callout-go">Go to Epic Setup ↓</span>
    </a>
    <div class="card" style="margin-bottom:18px">
      <h2>Returning user · Sign in</h2>
      <p class="sub">Already connected your Epic account here before? Use one of these to sign back in from any device.</p>
      ${error ? `<p class="warn">${esc(error)}</p>` : ''}
      <form method="post" action="/sprites/login" style="display:grid;gap:10px;max-width:360px">
        <label style="display:grid;gap:4px">
          <span style="font-weight:500">Username</span>
          <input type="text" name="username" required autocomplete="username"
            inputmode="text" minlength="3" maxlength="32" class="st-input">
        </label>
        <label style="display:grid;gap:4px">
          <span style="font-weight:500">Password</span>
          <input type="password" name="password" required autocomplete="current-password" class="st-input">
        </label>
        <button class="btn btn-primary" type="submit">Sign in</button>
      </form>
      ${EAS_CONFIGURED ? `
        <div style="display:flex;align-items:center;gap:10px;margin:18px 0 12px;max-width:360px">
          <div style="flex:1;height:1px;background:var(--cf-border)"></div>
          <span class="sub" style="font-size:12px">or</span>
          <div style="flex:1;height:1px;background:var(--cf-border)"></div>
        </div>
        <a href="/sprites/connect" class="btn btn-secondary" style="max-width:360px;text-align:center">Sign in with Epic</a>
        <p class="sub" style="margin-top:8px;font-size:13px">
          <b>Returning users only.</b> If you've never connected here before, this button will bounce you back with a friendly error. Use <b>Epic Setup</b> below first.
        </p>
      ` : ''}
    </div>
    <div id="first-time" class="card" style="border-color:var(--cf-accent-line)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <span class="st-eyebrow">Start here</span>
        <span class="sub" style="font-size:12px">— first-time setup, ~30 seconds</span>
      </div>
      <h2 style="margin-top:6px">Epic Setup — Connect your Epic account</h2>
      <p class="sub">Auto-sync your full Fortnite Sprite collection — owned, mastered, XP, and unreleased sprites. <b>You only do this once.</b></p>
      <p class="warn">
        <b>This step is required for ALL new accounts.</b> You cannot use the "Sign in" form above (or the Epic sign-in button) until your account has been connected here at least once — those flows only verify <i>who</i> you are; this flow loads <i>what</i> you've collected.
      </p>
      <p class="once">After this one-time setup, you'll never paste anything again — your collection re-syncs automatically and you can sign in from anywhere with the username + password you set on your <a href="/sprites/account">account page</a>.</p>
      <div class="step">
        <span class="num">1</span>
        <div class="stepbody">
          <b>Get your code from Epic</b>
          <p class="sub">Opens Epic in a new tab — sign in if it asks, then you'll see a small block of text appear.</p>
          <a class="btn btn-primary" href="${LOGIN_URL}" target="_blank" rel="noopener">Open Epic login →</a>
        </div>
      </div>
      <div class="step">
        <span class="num">2</span>
        <div class="stepbody">
          <b>Paste it back here</b>
          <p class="sub">Select all of that text and paste it below — we'll pull out the code for you (the whole blob, a <code>?code=…</code> URL, or just the 32-character code all work).</p>
          <form method="post" action="/sprites/auth">
            <textarea name="code" rows="3" autocomplete="off" spellcheck="false" required
              placeholder='Paste the {"authorizationCode":"…"} block here'></textarea>
            <button class="btn btn-primary" type="submit">Connect &amp; sync →</button>
          </form>
        </div>
      </div>
      <details class="alt-flow" style="margin-top:18px;padding:14px;border:1px solid var(--cf-border);border-radius:var(--cf-radius-lg);background:var(--cf-surface-2)">
        <summary style="cursor:pointer;font-weight:500">Skip the copy/paste — drag a bookmarklet to your bookmarks bar (optional, one-time setup)</summary>
        <p class="sub" style="margin-top:10px">A bookmarklet is a tiny shortcut you save to your browser's bookmarks bar — no extension install, no permissions. After you save it, the flow becomes:</p>
        <ol style="margin:8px 0 12px 18px;line-height:1.7">
          <li>Drag the button below to your bookmarks bar (or right-click → "Bookmark this link"). This installs the bookmarklet.</li>
          <li>Click <b>Open Epic login</b> above and sign in. You'll see the JSON page.</li>
          <li>On that JSON page, click the bookmark you just saved — it auto-submits your code. No copying anything.</li>
        </ol>
        <p style="margin:10px 0 6px"><a class="btn btn-secondary" draggable="true" href="${bookmarkletHref}"
            onclick="event.preventDefault();alert('Drag this button up to your bookmarks bar — clicking it here does nothing. On the Epic JSON page, click the bookmark you saved.');return false;"
>CertiFried Auto-Login (drag me)</a></p>
        <p class="sub" style="font-size:12px;color:var(--cf-text-3)">Source visible — it just reads <code>authorizationCode</code> from Epic's JSON page and POSTs it to <code>/sprites/auth</code>. No copy/paste needed once installed.</p>
      </details>
      <p class="warn">We exchange your login server-side, store only an <b>encrypted refresh token</b>
        for re-syncs, and never log token values.</p>
    </div>
    <p style="text-align:center;margin:22px 0 0;font-size:14px">
      Want to see what's already here? <a href="/sprites/browse" class="navlink">Browse + compare public collections →</a>
    </p>
    <p style="text-align:center;margin:8px 0 0;font-size:13px;color:var(--cf-text-3)">
      Curious what's real vs. datamined? <a href="/sprites/info" class="navlink">Live catalog audit &amp; methodology →</a>
    </p>
    </main>`);
}

// /sprites/account — set/change username + password. Independent of share_id
// (the public URL slug), so changing your login here will NOT break any
// /sprites/u/<slug> link already shared. Requires the current password to
// change anything once a password is set.
export function renderAccount({ displayName, currentUsername, hasPassword, passwordSetAt, isAdmin = false, viaEpic = false, error = null, success = null } = {}) {
  const fmtTs = (t) => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
  // Show the "current password" gate only when there IS a stored password AND
  // the user signed in via username/password. Epic-paste login is sufficient
  // ownership proof, so it skips the gate (recovery path for forgotten password).
  const requireCurrent = hasPassword && !viaEpic;
  const nav = userMenu({ displayName, isAdmin, currentPath: '/sprites/account' });
  return shell('Username & password — CertiFried Sprite Tracker', chrome(nav) + `<main id="main-content" tabindex="-1" class="st-main">
    <div class="card">
      <h2>Username & password</h2>
      <p class="sub">Set these so you can sign in from any device or browser without re-pasting an Epic code.
        ${displayName ? `Linked to your Epic display name <b>${esc(displayName)}</b>.` : ''}</p>
      <p class="sub" style="font-size:13px">Your public share URL is independent of this username — changing your login here will not break any link you've already shared.</p>
      ${error ? `<p class="warn">${esc(error)}</p>` : ''}
      ${success ? `<p class="once">${esc(success)}</p>` : ''}
      ${hasPassword && viaEpic ? `<p class="sub" style="font-size:13px;background:color-mix(in srgb, var(--cf-info) 10%, var(--cf-surface));border:1px solid color-mix(in srgb, var(--cf-info) 40%, var(--cf-border));padding:10px;border-radius:var(--cf-radius)">You're signed in via Epic, so you can reset your password here without knowing the old one.</p>` : ''}
      <form method="post" action="/sprites/credentials" style="display:grid;gap:12px;max-width:420px;margin-top:12px">
        <label style="display:grid;gap:4px">
          <span style="font-weight:500">Username</span>
          <input type="text" name="username" required minlength="3" maxlength="32"
            autocomplete="username" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{1,30}[A-Za-z0-9]"
            value="${esc(currentUsername || '')}" class="st-input">
          <span class="sub" style="font-size:12px">3-32 chars, letters/digits/_/- only. Starts and ends with a letter or digit.</span>
        </label>
        ${requireCurrent ? `
          <label style="display:grid;gap:4px">
            <span style="font-weight:600">Current password</span>
            <input type="password" name="current_password" required autocomplete="current-password" class="st-input">
            <span class="sub" style="font-size:12px">Set ${esc(fmtTs(passwordSetAt))}. Required to change anything.</span>
          </label>
        ` : ''}
        <label style="display:grid;gap:4px">
          <span style="font-weight:600">${hasPassword ? 'New password' : 'Password'}</span>
          <input type="password" name="password" required minlength="8" autocomplete="new-password" class="st-input">
          <span class="sub" style="font-size:12px">At least 8 characters. Longer = stronger; we don't enforce complexity rules.</span>
        </label>
        <button class="btn btn-primary" type="submit">${hasPassword ? 'Update credentials' : 'Save credentials'}</button>
      </form>
      <p class="sub" style="margin-top:18px;font-size:13px">
        Forgot your password? Sign out, then on the sign-in page use <b>"Connect your Epic account"</b> — once you're back in via Epic, this page will let you set a new password without needing the old one.
      </p>
    </div>
  </main>`);
}

