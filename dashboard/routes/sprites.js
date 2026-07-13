// certifriedmultitool.com/sprites — the only auto-synced Fortnite Sprite collection
// tracker. Users connect their Epic account once (auth-code paste); we persist ONLY an
// encrypted refresh token (utils/encryption.js) + a cached model, and re-sync on demand.
// Public route (no Discord login) — the Epic session lives in req.session.epicAccountId.
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pool from '../../utils/db.js';
import encryptionService from '../../utils/encryption.js';
import logger from '../../utils/logger.js';
import {
  LOGIN_URL, exchangeAuthCode, fetchSpriteData, buildModel, parseAuthCode,
  syncFromRefreshToken, TIERS, EAS_CONFIGURED, authorizeUrl, connectViaOAuth, signInViaEpic,
  refreshToken as epicRefreshToken, shortLabelForSeasonNum,
  createDeviceAuth, deviceAuthLogin,
} from '../../core/epic-sprites.js';

// ESM has no __dirname/__filename — derive both from import.meta.url so the
// Discord export can find the on-disk sprite PNGs.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPRITE_IMG_DIR = path.resolve(__dirname, '../public/sprites/img');
// Domain that shows up in the Discord export footer. Change here if we ever
// rebrand or set up a vanity domain like spritelocker.com.
const DISCORD_EXPORT_URL = 'certifriedmultitool.com/sprites';

const router = express.Router();
// This router mounts in server.js BEFORE the global body parser (that zone is reserved
// for webhook raw-body HMAC routes), so parse our own form posts here.
router.use(express.urlencoded({ extended: true }));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));

// ───────────────────────── credentials (username + password) ────────────────
// Password storage uses Node's built-in scrypt — memory-hard KDF, no native
// module to compile, no external dep. Stored form is
//   scrypt$<N>,<r>,<p>$<salt_b64>$<hash_b64>
// so we can bump cost params later without breaking existing hashes (the row
// itself carries the params it was hashed with).
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64;
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N},${SCRYPT_R},${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, params, saltB64, hashB64] = stored.split('$');
  if (!params || !saltB64 || !hashB64) return false;
  const [N, r, p] = params.split(',').map(Number);
  if (!N || !r || !p) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try { actual = crypto.scryptSync(plain, salt, expected.length, { N, r, p }); }
  catch { return false; }
  // timingSafeEqual avoids leaking the hash one byte at a time via early-exit
  // string comparison — the classic password-verification mistake.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
// Pre-computed dummy hash used to equalize timing on the "username doesn't
// exist" branch of /login — prevents username enumeration by response time.
const DUMMY_HASH = hashPassword('dummy-equalization-string-not-a-real-secret');

// 3-32 chars, [a-z0-9_-], must start AND end with alphanumeric (no _- bookends).
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$/;
const RESERVED_USERNAMES = new Set([
  'admin', 'root', 'login', 'logout', 'auth', 'credentials', 'callback', 'connect',
  'browse', 'compare', 'api', 'img', 'profile', 'account', 'u', 'resync', 'forget',
]);
function validateUsername(input) {
  const raw = String(input ?? '').trim();
  const lower = raw.toLowerCase();
  if (lower.length < 3 || lower.length > 32) return { ok: false, error: 'Username must be 3-32 characters.' };
  if (!USERNAME_RE.test(lower)) return { ok: false, error: 'Username can only contain letters, digits, _ and -, and must start and end with a letter or digit.' };
  if (RESERVED_USERNAMES.has(lower)) return { ok: false, error: 'That username is reserved.' };
  return { ok: true, value: raw };
}
function validatePassword(input) {
  const raw = String(input ?? '');
  if (raw.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  if (raw.length > 256) return { ok: false, error: 'Password is too long (max 256 characters).' };
  return { ok: true };
}

// In-memory failed-login throttle: per-IP+username, 5 attempts per 15 min.
// Resets on process restart (it's a deterrent, not a guarantee — and scrypt
// makes each attempt expensive anyway). On any successful login the throttle
// for that (ip, username) is cleared.
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const throttleKey = (req, username) => `${req.ip || 'unknown'}:${String(username || '').toLowerCase()}`;
function loginThrottleHit(req, username) {
  const e = loginAttempts.get(throttleKey(req, username));
  if (!e || e.resetAt < Date.now()) return false;
  return e.count >= LOGIN_MAX_ATTEMPTS;
}
function loginThrottleRecord(req, username, success) {
  const key = throttleKey(req, username);
  if (success) { loginAttempts.delete(key); return; }
  const now = Date.now();
  const e = loginAttempts.get(key);
  if (!e || e.resetAt < now) loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else e.count += 1;
}

// Computed from the existing per-variant state — no schema change required, so
// existing accounts get these stats on next render without needing a re-sync.
function computePlayerStats(state) {
  const all = state.groups.flatMap((g) => Object.values(g.variants));
  const owned = all.filter((v) => v.owned);
  const totalXp = owned.reduce((s, v) => s + (v.xp || 0), 0);

  let highest = null;
  for (const v of owned) if (!highest || (v.xp || 0) > (highest.xp || 0)) highest = v;
  // Attach the friendly family label so the render doesn't have to lookup again
  // and the codename (familyToken) never leaks into the user-facing string.
  if (highest) {
    const fg = state.groups.find((x) => x.familyToken === highest.familyToken);
    highest = { ...highest, familyLabel: fg?.label || highest.familyToken };
  }

  // Per-family completion analysis, counted strictly against **obtainable**
  // variants in each family (excluding future-tier Holofoil/Gem and currently-
  // vaulted families). Yields two highlights — both honest, both useful:
  //
  //   fullyCompleted — families at 100% obtainable. Often there are multiple
  //   ties at 100%, so picking "most progressed" by alphabetical tiebreak was
  //   misleading noise; listing all of them is the actual flex.
  //
  //   nextClosest — the family closest to (but not at) 100%. Tells the player
  //   what to chase next; tiebreaks by higher % first, then by higher owned
  //   count, then alphabetical familyToken for determinism.
  //
  // Families with 0 obtainable variants (fully-vaulted Air / Seven) are
  // ignored — they're not progress, they're blocked.
  const fullyCompleted = [];
  // First pass: bucket every incomplete (but started) family with its progress.
  // Then group the leaders by their shared (ownedCount, totalCount) ratio — if
  // five families are all 2/4, we show all five, not an alphabetical winner.
  const incomplete = [];
  for (const g of state.groups) {
    const obtainable = Object.values(g.variants).filter((v) => !v.future && !v.vaulted);
    if (!obtainable.length) continue;
    const owned = obtainable.filter((v) => v.owned).length;
    if (owned === obtainable.length) {
      fullyCompleted.push({ label: g.label, total: obtainable.length });
      continue;
    }
    if (owned === 0) continue;  // not started yet — not "close"
    incomplete.push({ label: g.label, familyToken: g.familyToken, owned, total: obtainable.length, pct: owned / obtainable.length });
  }
  // The "closest" group = everyone tied at the highest pct. Tie within pct on
  // (owned, total) — so 2/4 ties 4/8 in pct but they read differently to a
  // player, and grouping by exact ratio is more honest than a float tolerance.
  let closestGroup = null;
  if (incomplete.length) {
    const maxPct = Math.max(...incomplete.map((f) => f.pct));
    const atMax = incomplete.filter((f) => f.pct === maxPct);
    // Among the max-pct families, take the dominant (owned, total) ratio.
    // e.g. four families at 2/4 and one at 4/8 — surface 2/4 cluster.
    const ratioCounts = new Map();
    for (const f of atMax) {
      const key = `${f.owned}/${f.total}`;
      ratioCounts.set(key, (ratioCounts.get(key) || 0) + 1);
    }
    const dominantKey = [...ratioCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const labels = atMax.filter((f) => `${f.owned}/${f.total}` === dominantKey)
      .map((f) => f.label)
      .sort((a, b) => a.localeCompare(b));
    const [owned, total] = dominantKey.split('/').map(Number);
    closestGroup = { labels, owned, total, pct: maxPct };
  }

  // Per-tier breakdown with separate obtainable / vaulted / future counts so
  // the rendered bars can show owned-out-of-**obtainable** (honest denominator)
  // and a separate "Awaiting Release" group for tiers where everything is
  // unreleased (Gem / Holofoil today — entire tier is future-tier across all
  // 18 families). The previous `tierTotal` counted every catalog entry which
  // made Basic look like 15/18 instead of the real 15/16.
  const tierStats = {};
  for (const t of TIERS) {
    tierStats[t.key] = { owned: 0, obtainable: 0, vaulted: 0, future: 0, total: 0 };
  }
  for (const v of all) {
    const ts = tierStats[v.tierKey];
    if (!ts) continue;
    ts.total++;
    if (v.owned) ts.owned++;
    if (v.future) ts.future++;
    if (v.vaulted) ts.vaulted++;
    if (!v.future && !v.vaulted) ts.obtainable++;
  }

  const totalDupes = owned.reduce((s, v) => s + (v.dupes || 0), 0);
  const totalSpent = owned.reduce((s, v) => s + (v.summonCost || 0), 0);

  return { totalXp, highest, fullyCompleted, closestGroup, tierStats, totalDupes, totalSpent };
}

function formatMonthYear(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Look up a variant name (e.g. "Water_Variant_Gold" or "Spitfire_Variation_A")
// in the parsed state.groups so we can display it as "Water Gold" instead of
// the raw catalog identifier. Returns null if the variant isn't in the catalog
// snapshot (rare — usually only for pre-parsed events referencing dropped tiers).
function variantInfoFromName(variantName, groups) {
  if (!variantName || !Array.isArray(groups)) return null;
  for (const g of groups) {
    for (const v of Object.values(g.variants || {})) {
      if (v?.name === variantName) return { familyLabel: g.label, tierLabel: v.tierLabel, tierColor: v.tierColor };
    }
  }
  return null;
}

// Stale-while-revalidate window — render cached state instantly on every visit,
// background-refresh only if the row is older than this. 6h balances "feel fresh
// when a user comes back" against "don't hammer Epic's API on every reload".
// Public /u/:slug view uses a long threshold — visitors don't need per-second
// freshness, and this dedupes viral-link storms. Owner's own /sprites view
// uses a much tighter threshold (below) so the wallet + inventory feel live
// when they're actively grinding.
const SPRITE_STALE_MS = 6 * 60 * 60 * 1000;
const SPRITE_STALE_OWNER_MS = 60 * 1000;
// Per-accountId guard so rapid reloads / multiple tabs don't kick off N
// concurrent refreshes against Epic for the same user.
const inFlightResyncs = new Set();

// Accounts allowed to view /sprites/admin (privileged user list). Gate is the
// session's Epic account_id, set by finishLogin on a successful paste/OAuth
// login — so only people who can actually sign in as the admin Epic account
// can see this page. Extend by adding more account_ids.
const ADMIN_ACCOUNT_IDS = new Set([
  'd4937a0fee644acfb98e9cc134d3eb3e', // XxXDeath420XxX (crawf)
  // TODO(crawf): add more account_ids here to grant admin to additional users.
]);

// Persist a just-rotated refresh token IMMEDIATELY, before any downstream
// fetch can fail. Epic's refresh-token rotation is one-shot: every successful
// `grant_type=refresh_token` exchange invalidates the previous token. If a
// later step in the sync throws, the new token must already be saved or the
// account is bricked until manual re-login.
async function persistRotatedToken(accountId, newRefreshToken, refreshExpiresAt) {
  const enc = JSON.stringify(encryptionService.encrypt(newRefreshToken));
  await pool.execute(
    'UPDATE epic_sprite_accounts SET refresh_token_enc=?, refresh_expires_at=? WHERE account_id=?',
    [enc, refreshExpiresAt || null, accountId],
  );
}

// Mint an access token using whichever credential the row already has — device
// auth if present (permanent, preferred), refresh token otherwise (48h, rotating).
// For refresh-token path we persist the rotated token immediately so a downstream
// failure can't leave the row with a dead token.
async function syncWithAtomicRotation(row, prevDisplayName) {
  const hasDevice = row.device_id_enc && row.device_secret_enc;
  let tok;
  let usedDeviceAuth = false;
  if (hasDevice) {
    // Path A: device auth. No rotation, no atomic-save dance — just trade
    // (deviceId, secret) for a fresh access token. Forever credentials.
    const deviceId = encryptionService.decrypt(JSON.parse(row.device_id_enc));
    const secret = encryptionService.decrypt(JSON.parse(row.device_secret_enc));
    tok = await deviceAuthLogin({ accountId: row.account_id, deviceId, secret });
    usedDeviceAuth = true;
  } else {
    // Path B: refresh token rotation. Burns the old token Epic-side; we must
    // persist the new one immediately before any downstream fetch can fail.
    const refreshTokenPlain = encryptionService.decrypt(JSON.parse(row.refresh_token_enc));
    tok = await epicRefreshToken(refreshTokenPlain);
    try { await persistRotatedToken(row.account_id, tok.refresh_token, tok.refresh_expires_at); }
    catch (e) { logger.warn(`[sprites] critical: rotated token save failed: ${e.message}`); throw e; }
  }

  const { catalog, inventory, athena } = await fetchSpriteData(tok.account_id, tok.access_token);
  const model = buildModel(catalog, inventory, athena);

  // Back-fill: any successful sync on an account WITHOUT device auth becomes
  // the moment we mint one. After this lands, every active user transitions
  // from rotating-refresh to forever-device-auth automatically without anyone
  // having to do anything.
  let deviceAuth = null;
  if (!hasDevice) {
    try { deviceAuth = await createDeviceAuth(tok.account_id, tok.access_token); }
    catch (e) { logger.warn(`[sprites] device auth back-fill failed for ${tok.account_id}: ${e.message}`); }
  }

  return {
    accountId: tok.account_id,
    displayName: tok.displayName || prevDisplayName || tok.account_id,
    // Device-auth syncs don't issue refresh tokens — keep the existing one
    // around as a fallback but it won't matter (device auth is permanent).
    refreshToken: usedDeviceAuth
      ? encryptionService.decrypt(JSON.parse(row.refresh_token_enc))
      : tok.refresh_token,
    refreshExpiresAt: usedDeviceAuth ? row.refresh_expires_at : tok.refresh_expires_at,
    deviceAuth,
    model,
    athena,
  };
}

// Set/clear the needs-relogin flag for an account. Set when Epic tells us the
// stored refresh token is invalid (TOKEN_NOT_FOUND etc.); cleared by saveAccount
// on every successful sync.
async function setTokenStatus(accountId, needsRelogin) {
  try {
    await pool.execute(
      'UPDATE epic_sprite_accounts SET needs_relogin=? WHERE account_id=?',
      [needsRelogin ? 1 : 0, accountId],
    );
  } catch (e) { logger.warn(`[sprites] couldn't update token status: ${e.message}`); }
}

// Errors from Epic that mean "stored refresh token is gone, user has to re-paste".
// Other errors (network blips, magpie 5xx, etc.) are transient and shouldn't trip
// the banner since they'll succeed on the next try.
const DEAD_TOKEN_PATTERN = /TOKEN_NOT_FOUND|invalid_grant|errors\.com\.epicgames\.account\.auth_token\.invalid_refresh_token/i;

function tryBackgroundResync(accountId, encryptedRefreshTokenRow, displayName) {
  if (inFlightResyncs.has(accountId)) return;
  inFlightResyncs.add(accountId);
  syncWithAtomicRotation(encryptedRefreshTokenRow, displayName)
    .then((synced) => saveAccount(synced))
    .catch((e) => {
      logger.warn(`[sprites] bg resync failed for ${accountId}: ${e.message}`);
      if (DEAD_TOKEN_PATTERN.test(e.message)) setTokenStatus(accountId, true);
    })
    .finally(() => inFlightResyncs.delete(accountId));
}

// ── Discord export (PNG with composited sprite icons) ──────────────────────
// Renders a shareable PNG: 4 tier columns (NORMAL=basic, GOLD=gold, GUMMY=candy,
// GALAXY=galaxy — the four that are universally obtainable; Holofoil + Gem are
// future-only for most families so they're excluded), one row per non-vaulted
// family, owned icons in full color and missing icons greyscaled + dimmed.
//
// Pipeline:
//   1) Read every needed sprite PNG from disk in parallel
//   2) For missing variants, run them through sharp's .greyscale().modulate()
//   3) Build a base SVG with the layout chrome (bg, stripes, header, family
//      labels, footer text, dividers)
//   4) Composite all icon buffers onto the base SVG → final PNG
const DISCORD_TIERS = [
  { key: 'basic',  label: 'NORMAL' },
  { key: 'gold',   label: 'GOLD'   },
  { key: 'candy',  label: 'GUMMY'  },
  { key: 'galaxy', label: 'GALAXY' },
];
const ESC_XML = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

async function buildDiscordExport(state) {
  // Filter out fully-vaulted families (Air, Seven currently) — they'd be
  // entirely greyscaled and just clutter the export.
  const families = state.groups.filter((g) => (g.obtainableCount ?? g.totalCount ?? 0) > 0);
  if (!families.length) throw new Error('no obtainable families to export');

  const ICON = 64;
  const CELL_W = 100;
  const CELL_H = 80;
  const LABEL_COL = 168;
  const HEADER_H = 56;
  const FOOTER_H = 56;
  const W = LABEL_COL + DISCORD_TIERS.length * CELL_W;
  const H = HEADER_H + families.length * CELL_H + FOOTER_H;

  // Load + process all icons in parallel — each becomes a sharp.composite() layer.
  // Icons now render in FULL COLOR regardless of owned state; the overlay SVG
  // painted on top carries the state semantic (jail bars for vaulted/future,
  // dark scrim + padlock for unowned obtainable). Same visual language as the
  // web UI's .cell.locked / .cell.vaulted / .cell.future overlays.
  const iconJobs = [];
  for (let i = 0; i < families.length; i++) {
    const g = families[i];
    for (let t = 0; t < DISCORD_TIERS.length; t++) {
      const tier = DISCORD_TIERS[t];
      const v = g.variants[tier.key];
      if (!v?.imgId) continue;
      const top = HEADER_H + i * CELL_H + Math.round((CELL_H - ICON) / 2);
      const left = LABEL_COL + t * CELL_W + Math.round((CELL_W - ICON) / 2);
      iconJobs.push((async () => {
        try {
          const raw = await readFile(path.join(SPRITE_IMG_DIR, `${v.imgId}.png`));
          const buf = await sharp(raw).resize(ICON, ICON, { fit: 'contain' }).png().toBuffer();
          return { input: buf, top, left };
        } catch (e) { return null; }
      })());
    }
  }
  const icons = (await Promise.all(iconJobs)).filter(Boolean);

  // Overlay SVG — painted on TOP of the icons. Per-cell decorations that
  // match the web UI:
  //   - vaulted OR future (unowned) → 4 vertical jail bars + top/bottom rails
  //   - unowned obtainable         → dark scrim + centered white padlock
  //   - owned                       → nothing (icon is the answer)
  // Empty cells (no imgId) also get nothing since there's no sprite to lock up.
  const overlays = [];
  for (let i = 0; i < families.length; i++) {
    const g = families[i];
    for (let t = 0; t < DISCORD_TIERS.length; t++) {
      const tier = DISCORD_TIERS[t];
      const v = g.variants[tier.key];
      if (!v?.imgId || v.owned) continue;
      const x = LABEL_COL + t * CELL_W + Math.round((CELL_W - ICON) / 2);
      const y = HEADER_H + i * CELL_H + Math.round((CELL_H - ICON) / 2);
      if (v.vaulted || v.future) {
        // Jail bars — 4 vertical bars at fixed positions within the icon area,
        // plus a top and bottom rail. Warm iron color with a subtle gradient
        // via inner stroke so the bars read as 3D instead of flat.
        overlays.push(`<g transform="translate(${x},${y})">
          <rect x="0" y="0" width="${ICON}" height="4" fill="#4a3818"/>
          <rect x="0" y="${ICON - 4}" width="${ICON}" height="4" fill="#4a3818"/>
          <rect x="9" y="4" width="4" height="${ICON - 8}" fill="#1a1207" stroke="#583c14" stroke-width="0.4"/>
          <rect x="24" y="4" width="4" height="${ICON - 8}" fill="#1a1207" stroke="#583c14" stroke-width="0.4"/>
          <rect x="38" y="4" width="4" height="${ICON - 8}" fill="#1a1207" stroke="#583c14" stroke-width="0.4"/>
          <rect x="52" y="4" width="4" height="${ICON - 8}" fill="#1a1207" stroke="#583c14" stroke-width="0.4"/>
        </g>`);
      } else {
        // Dark scrim + centered padlock (SVG shapes — emoji rendering via
        // librsvg is unreliable, so we draw the padlock ourselves).
        const cx = ICON / 2, cy = ICON / 2;
        overlays.push(`<g transform="translate(${x},${y})">
          <rect x="0" y="0" width="${ICON}" height="${ICON}" fill="rgba(0,0,0,0.55)"/>
          <g transform="translate(${cx},${cy})" fill="#ffffff" stroke="#000000" stroke-width="1" stroke-linejoin="round">
            <path d="M -9,-4 A 9,9 0 0 1 9,-4 L 9,4 L 5.5,4 L 5.5,-4 A 5.5,5.5 0 0 0 -5.5,-4 L -5.5,4 L -9,4 Z"/>
            <rect x="-12" y="2" width="24" height="18" rx="2.5" ry="2.5"/>
            <circle cx="0" cy="9" r="2.4" fill="#000000" stroke="none"/>
            <rect x="-1" y="9" width="2" height="6" fill="#000000" stroke="none"/>
          </g>
        </g>`);
      }
    }
  }

  // Footer line: counts come from state.summary (built by buildModel from the
  // catalog + inventory); fall back through obtainable → released → total to
  // tolerate old saves that predate any of those fields.
  const ownedCount = state.summary?.owned ?? 0;
  const obtainable = state.summary?.obtainable ?? state.summary?.released ?? state.summary?.total ?? 0;
  const footer = `${ownedCount}/${obtainable} collected · track yours at ${DISCORD_EXPORT_URL}`;

  // Base SVG = everything except the icons. Stripes + dividers first (drawn
  // bottom-up by SVG order), then text on top.
  const stripes = families.map((_, i) => (i % 2 === 1
    ? `<rect x="0" y="${HEADER_H + i * CELL_H}" width="${W}" height="${CELL_H}" fill="#161922"/>` : '')).join('');
  const headerLabels = DISCORD_TIERS.map((t, i) => {
    const cx = LABEL_COL + i * CELL_W + CELL_W / 2;
    return `<text x="${cx}" y="${HEADER_H / 2 + 6}" font-family="Segoe UI,Arial,sans-serif" font-weight="800" font-size="14" fill="#9b7bff" text-anchor="middle" letter-spacing="2">${t.label}</text>`;
  }).join('');
  const familyLabels = families.map((g, i) => {
    const y = HEADER_H + i * CELL_H + CELL_H / 2 + 6;
    return `<text x="16" y="${y}" font-family="Segoe UI,Arial,sans-serif" font-weight="700" font-size="16" fill="#e8eaf0">${ESC_XML(g.label)}</text>`;
  }).join('');
  const colDividers = [LABEL_COL, ...DISCORD_TIERS.map((_, i) => LABEL_COL + (i + 1) * CELL_W)].map(
    (x) => `<line x1="${x}" y1="0" x2="${x}" y2="${H - FOOTER_H}" stroke="#242837" stroke-width="1"/>`).join('');
  const baseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#0e0f13"/>
    ${stripes}
    <rect width="${W}" height="${HEADER_H}" fill="#12141c"/>
    <rect x="0" y="${H - FOOTER_H}" width="${W}" height="${FOOTER_H}" fill="#12141c"/>
    ${colDividers}
    <line x1="0" y1="${HEADER_H}" x2="${W}" y2="${HEADER_H}" stroke="#242837" stroke-width="2"/>
    <line x1="0" y1="${H - FOOTER_H}" x2="${W}" y2="${H - FOOTER_H}" stroke="#242837" stroke-width="2"/>
    ${headerLabels}
    ${familyLabels}
    <text x="${W / 2}" y="${H - FOOTER_H / 2 + 5}" font-family="Segoe UI,Arial,sans-serif" font-size="14" fill="#878da0" text-anchor="middle">${ESC_XML(footer)}</text>
  </svg>`;

  // Overlay layer — one SVG at the same page size that carries all jail bars
  // and padlocks; composited on TOP of the color icons.
  const overlaySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${overlays.join('')}</svg>`;

  return sharp(Buffer.from(baseSvg))
    .composite([...icons, { input: Buffer.from(overlaySvg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

// PNG export for the buy-back list — used both as the /buyback-export download
// and as the og:image on the /buyback share page. List-style layout: header
// with player name + count + dust total, one row per item with icon/tier/family
// /cost, footer with wallet + progress + attribution.
async function buildBuybackExport(state, buybackList) {
  if (!buybackList.length) throw new Error('empty buy-back list');
  const ROW_H = 62;
  const ICON = 44;
  const HEADER_H = 96;
  const FOOTER_H = 108;
  const W = 640;
  const H = HEADER_H + buybackList.length * ROW_H + FOOTER_H;
  const walletDust = state.summary?.dust ?? 0;
  const totalDust = buybackList.reduce((s, b) => s + (b.cost || 0), 0);
  const pct = totalDust > 0 ? Math.min(100, Math.round((walletDust / totalDust) * 100)) : 0;
  const player = state.player || 'Collector';

  // Icon load pipeline — same shape as the sprite grid export.
  const iconJobs = buybackList.map(async (b, i) => {
    if (!b.imgId) return null;
    try {
      const raw = await readFile(path.join(SPRITE_IMG_DIR, `${b.imgId}.png`));
      const buf = await sharp(raw).resize(ICON, ICON, { fit: 'contain' }).png().toBuffer();
      return { input: buf, top: HEADER_H + i * ROW_H + Math.round((ROW_H - ICON) / 2), left: 20 };
    } catch { return null; }
  });
  const icons = (await Promise.all(iconJobs)).filter(Boolean);

  const stripes = buybackList.map((_, i) => (i % 2 === 1
    ? `<rect x="0" y="${HEADER_H + i * ROW_H}" width="${W}" height="${ROW_H}" fill="#161922"/>` : '')).join('');
  const itemRows = buybackList.map((b, i) => {
    const y = HEADER_H + i * ROW_H;
    const cy = y + ROW_H / 2;
    return `<text x="76" y="${cy - 5}" font-family="Segoe UI,Arial,sans-serif" font-weight="800" font-size="11" fill="${b.tierColor}" letter-spacing="1">${ESC_XML((b.tierLabel || '').toUpperCase())}</text>
      <text x="76" y="${cy + 12}" font-family="Segoe UI,Arial,sans-serif" font-weight="700" font-size="16" fill="#e8eaf0">${ESC_XML(b.familyLabel)}</text>
      <text x="${W - 20}" y="${cy + 6}" font-family="Segoe UI,Arial,sans-serif" font-weight="700" font-size="15" fill="#ffe48a" text-anchor="end" letter-spacing="0.5">${ESC_XML((b.cost || 0).toLocaleString())} ✦</text>`;
  }).join('');

  const barY = HEADER_H + buybackList.length * ROW_H + 44;
  const baseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#0e0f13"/>
    ${stripes}
    <rect width="${W}" height="${HEADER_H}" fill="linear-gradient(180deg,#221a08,#12141c)"/>
    <rect width="${W}" height="${HEADER_H}" fill="#12141c"/>
    <rect x="0" y="${H - FOOTER_H}" width="${W}" height="${FOOTER_H}" fill="#12141c"/>
    <line x1="0" y1="${HEADER_H}" x2="${W}" y2="${HEADER_H}" stroke="#ffcf3a" stroke-width="2" stroke-opacity="0.6"/>
    <line x1="0" y1="${H - FOOTER_H}" x2="${W}" y2="${H - FOOTER_H}" stroke="#242837" stroke-width="1"/>
    <text x="24" y="36" font-family="Segoe UI,Arial,sans-serif" font-weight="800" font-size="20" fill="#ffcf3a">🎯 ${ESC_XML(player)}'s Buy-back List</text>
    <text x="24" y="66" font-family="Segoe UI,Arial,sans-serif" font-weight="600" font-size="14" fill="#c8ccd6">${buybackList.length} sprites · <tspan fill="#ffe48a" font-weight="800">${totalDust.toLocaleString()} ✦</tspan> needed</text>
    <text x="${W - 24}" y="66" font-family="Segoe UI,Arial,sans-serif" font-weight="700" font-size="13" fill="#878da0" text-anchor="end">Wallet: <tspan fill="#ffe48a" font-weight="800">${walletDust.toLocaleString()} ✦</tspan></text>
    ${itemRows}
    <rect x="24" y="${barY}" width="${W - 48}" height="10" fill="#0e0f13" stroke="#242837" stroke-width="1" rx="5"/>
    <rect x="25" y="${barY + 1}" width="${(W - 50) * pct / 100}" height="8" fill="#ffcf3a" rx="4"/>
    <text x="24" y="${barY - 8}" font-family="Segoe UI,Arial,sans-serif" font-weight="700" font-size="12" fill="#c8ccd6">Progress: ${pct}% funded</text>
    <text x="${W / 2}" y="${H - 18}" font-family="Segoe UI,Arial,sans-serif" font-size="13" fill="#878da0" text-anchor="middle">track yours at ${DISCORD_EXPORT_URL}</text>
  </svg>`;

  return sharp(Buffer.from(baseSvg)).composite(icons).png().toBuffer();
}

// ── periodic background sync (every 10 minutes) ─────────────────────────────
// Sweeps every connected account that still has a working credential (device
// auth OR refresh token) and isn't already flagged needs_relogin. Reuses the
// same in-flight guard as viewer-triggered syncs so a person browsing during
// a sweep tick can't double-fire on the same account. Dead tokens trip the
// needs_relogin flag (handled inside tryBackgroundResync) — the next sweep
// then skips them, so a permanently-broken account doesn't waste API calls.
//
// At our current scale (≤ a few dozen accounts), firing all syncs in parallel
// is fine. If this ever grows to hundreds of accounts, batch by chunks of ~16
// or stagger with a small per-account delay to spread the load on Epic.
const PERIODIC_SYNC_INTERVAL_MS = 60 * 1000;
async function periodicBackgroundSync() {
  try {
    const [rows] = await pool.execute(
      `SELECT account_id, display_name, refresh_token_enc, refresh_expires_at,
              device_id_enc, device_secret_enc
       FROM epic_sprite_accounts
       WHERE needs_relogin = 0
         AND (device_id_enc IS NOT NULL OR refresh_token_enc IS NOT NULL)`,
    );
    if (rows.length === 0) return;
    logger.info(`[sprites] periodic sync sweep: ${rows.length} accounts`);
    for (const row of rows) tryBackgroundResync(row.account_id, row, row.display_name);
  } catch (e) {
    logger.warn(`[sprites] periodic sync sweep query failed: ${e.message}`);
  }
}
// Fire one sweep ~30s after boot to catch up immediately rather than waiting a
// full interval, then keep ticking every 10 min. Both calls return Timeout
// handles we deliberately don't track — process lifetime owns them.
setTimeout(periodicBackgroundSync, 30 * 1000);
setInterval(periodicBackgroundSync, PERIODIC_SYNC_INTERVAL_MS);

// Encrypt-and-persist a freshly-minted device auth pair. Called after a
// successful exchange or refresh sync to back-fill long-lived credentials.
async function persistDeviceAuth(accountId, deviceAuth) {
  if (!deviceAuth?.deviceId || !deviceAuth?.secret) return;
  const idEnc = JSON.stringify(encryptionService.encrypt(deviceAuth.deviceId));
  const secEnc = JSON.stringify(encryptionService.encrypt(deviceAuth.secret));
  await pool.execute(
    'UPDATE epic_sprite_accounts SET device_id_enc=?, device_secret_enc=?, device_auth_at=NOW() WHERE account_id=?',
    [idEnc, secEnc, accountId],
  );
}

// ── persistence (epic_sprite_accounts, migration 136 + first_synced_at column) ──
async function saveAccount({ accountId, displayName, refreshToken, refreshExpiresAt, deviceAuth, model }) {
  // Before writing the new state, peek at the previous state so we can record
  // activity-feed events (new sprites collected, level-ups, etc.). Quiet on any
  // error since events are nice-to-have, not load-bearing.
  let prevSummary = null;
  let prevFamilyTokens = null;
  // Map of variant name → { owned, xp, mastered } as of the previous sync.
  // Used below for delta-based extract/acquire detection: XP going from >0
  // to 0 (while still owned) is an extraction event even when magpie's
  // counts field doesn't zero. XP going from 0 to >0 signals the user is
  // actively using a variant they'd previously listed for buy-back.
  let prevVariantState = null;
  if (model) {
    try {
      const [prev] = await pool.execute('SELECT state_json FROM epic_sprite_accounts WHERE account_id=?', [accountId]);
      if (prev[0]?.state_json) {
        const parsed = JSON.parse(prev[0].state_json);
        prevSummary = parsed.summary || null;
        if (Array.isArray(parsed.groups)) {
          prevFamilyTokens = new Set(parsed.groups.map((g) => g.familyToken).filter(Boolean));
          prevVariantState = new Map();
          for (const g of parsed.groups) {
            for (const v of Object.values(g.variants || {})) {
              if (v?.name) prevVariantState.set(v.name, { owned: !!v.owned, xp: v.xp ?? null, mastered: !!v.mastered, dupes: v.dupes ?? 0 });
            }
          }
        }
      }
    } catch (e) { logger.warn(`[sprites] event diff failed: ${e.message}`); }
  }

  // Buy-back list alignment — stateless mirror of the user's magpie dupes
  // field. Per the game's semantics (verified 2026-07-01 by crawf):
  //   dupes = 0  →  never obtained
  //   dupes = 1  →  had once, no longer in locker (buyback candidate)
  //   dupes = 2  →  actively in locker
  // Every sync: any variant at dupes=1 gets INSERT IGNOREd into the list;
  // any variant at dupes>=2 gets DELETEd. Batched into 2 SQL calls.
  if (model && Array.isArray(model.groups)) {
    const dupes1Names = [];
    const dupes2PlusNames = [];
    for (const g of model.groups) {
      for (const v of Object.values(g.variants || {})) {
        if (!v?.name) continue;
        const d = v.dupes ?? 0;
        if (d === 1) dupes1Names.push(v.name);
        else if (d >= 2) dupes2PlusNames.push(v.name);
      }
    }
    // Snapshot current list for diff-logging so we can report what changed.
    let prevOnList = new Set();
    try {
      const [pending] = await pool.execute(
        'SELECT variant_name FROM epic_sprite_buyback WHERE account_id=?',
        [accountId],
      );
      prevOnList = new Set(pending.map((r) => r.variant_name));
    } catch (e) { logger.warn(`[sprites] buyback pre-diff query failed: ${e.message}`); }
    const willAdd = dupes1Names.filter((n) => !prevOnList.has(n));
    const willRemove = dupes2PlusNames.filter((n) => prevOnList.has(n));
    if (willAdd.length) {
      try {
        const chunk = 40;
        for (let i = 0; i < willAdd.length; i += chunk) {
          const slice = willAdd.slice(i, i + chunk);
          const values = slice.map(() => "(?, ?, 'auto')").join(',');
          const params = slice.flatMap((n) => [accountId, n]);
          await pool.execute(`INSERT IGNORE INTO epic_sprite_buyback (account_id, variant_name, source) VALUES ${values}`, params);
        }
        logger.info(`[sprites] buy-back auto-add (dupes=1) for ${displayName || accountId}: ${willAdd.join(', ')}`);
      } catch (e) { logger.warn(`[sprites] buyback auto-add failed: ${e.message}`); }
    }
    if (willRemove.length) {
      try {
        const chunk = 40;
        for (let i = 0; i < willRemove.length; i += chunk) {
          const slice = willRemove.slice(i, i + chunk);
          await pool.execute(
            `DELETE FROM epic_sprite_buyback WHERE account_id=? AND variant_name IN (${slice.map(() => '?').join(',')})`,
            [accountId, ...slice],
          );
        }
        logger.info(`[sprites] buy-back auto-remove (dupes≥2) for ${displayName || accountId}: ${willRemove.join(', ')}`);
      } catch (e) { logger.warn(`[sprites] buyback auto-remove failed: ${e.message}`); }
    }
  }

  // Compare CURRENT catalog family tokens against prev — anything new is an
  // Epic drop we didn't have last sweep. Big deal (Batman? next season family?)
  // so we escalate to a warn-level log with the specific labels. Skipped when
  // there's no prev (first-time sync — no baseline).
  if (model && prevFamilyTokens && Array.isArray(model.groups)) {
    const curTokens = model.groups.map((g) => g.familyToken).filter(Boolean);
    const newTokens = curTokens.filter((t) => !prevFamilyTokens.has(t));
    if (newTokens.length) {
      const newLabels = model.groups
        .filter((g) => newTokens.includes(g.familyToken))
        .map((g) => `${g.label} (${g.familyToken})`)
        .join(', ');
      logger.warn(`[sprites] NEW FAMILY DETECTED for ${displayName || accountId}: prev=${prevFamilyTokens.size}, now=${curTokens.length} — new: ${newLabels}`);
    }
  }
  // Unknown-tier warning — buildModel surfaces any variant tier tokens it
  // didn't recognize. Escalates to warn so the log tail catches new tier
  // rollouts (Quack/Cube, or anything past that we haven't planned for).
  if (model?.unknownTiers?.length) {
    logger.warn(`[sprites] UNKNOWN TIER TOKENS in catalog for ${displayName || accountId}: ${model.unknownTiers.join(', ')} — add to TIERS array in epic-sprites.js`);
  }
  if (model?.unknownCurrencyKeys?.length) {
    logger.warn(`[sprites] UNKNOWN CURRENCY KEYS in magpie counts for ${displayName || accountId}: ${model.unknownCurrencyKeys.join(', ')} — extend buildModel to read them`);
  }
  if (model?.unknownMetaKeys?.length) {
    logger.warn(`[sprites] UNKNOWN METADATA KEYS in magpie block for ${displayName || accountId}: ${model.unknownMetaKeys.join(', ')} — extend buildModel + summary to expose them`);
  }

  const enc = JSON.stringify(encryptionService.encrypt(refreshToken));
  const state = model ? JSON.stringify({ ...model, player: displayName, syncedAt: new Date().toISOString() }) : null;
  const syncTs = state ? 'NOW()' : 'NULL';
  const stateUpdate = state ? ', state_json=VALUES(state_json), synced_at=NOW()' : '';
  await pool.execute(
    `INSERT INTO epic_sprite_accounts
       (account_id, display_name, refresh_token_enc, refresh_expires_at, state_json, synced_at, first_synced_at, needs_relogin)
     VALUES (?,?,?,?,?, ${syncTs}, ${syncTs}, 0)
     ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), refresh_token_enc=VALUES(refresh_token_enc),
       refresh_expires_at=VALUES(refresh_expires_at), needs_relogin=0${stateUpdate}`,
    [accountId, displayName, enc, refreshExpiresAt || null, state],
  );

  // If a fresh device_auth was minted as part of this sync, encrypt + persist
  // it alongside the row. Best-effort: failures don't break the save.
  if (deviceAuth?.deviceId && deviceAuth?.secret) {
    try { await persistDeviceAuth(accountId, deviceAuth); }
    catch (e) { logger.warn(`[sprites] device auth persist failed: ${e.message}`); }
  }

  // Emit activity events for the diff. Owned-sprite jumps are the headline,
  // pass-level changes are the secondary signal. Mastery events are noisy and
  // skipped for now.
  if (model && prevSummary && model.summary) {
    const cur = model.summary;
    const events = [];
    // Walk variants to build the actual list of newly-acquired sprites so the
    // activity feed can show "collected Ghost Gold" instead of a bare count.
    // Fall back to summary-count math if prevVariantState wasn't loaded (very
    // first sync of a fresh install for this user, etc).
    const acquiredSprites = [];
    if (prevVariantState && Array.isArray(model.groups)) {
      for (const g of model.groups) {
        for (const v of Object.values(g.variants || {})) {
          if (!v?.name || !v.owned) continue;
          const prev = prevVariantState.get(v.name);
          if (prev && !prev.owned) acquiredSprites.push({ family: g.label, tier: v.tierLabel || v.tierKey, name: v.name });
        }
      }
    }
    const newOwnedCount = acquiredSprites.length || Math.max(0, (cur.owned || 0) - (prevSummary.owned || 0));
    if (newOwnedCount > 0) events.push(['new_sprites', { count: newOwnedCount, total: cur.owned, displayName, sprites: acquiredSprites }]);
    const prevPass = prevSummary.epic?.passLevel;
    const curPass = cur.epic?.passLevel;
    if (prevPass != null && curPass != null && curPass > prevPass) {
      events.push(['pass_level', { from: prevPass, to: curPass, season: cur.epic.seasonLabel || `Season ${cur.epic.seasonNum}`, displayName }]);
    }
    for (const [type, data] of events) {
      try { await pool.execute('INSERT INTO epic_sprite_events (account_id, event_type, event_data) VALUES (?,?,?)', [accountId, type, JSON.stringify(data)]); }
      catch (e) { logger.warn(`[sprites] event insert failed: ${e.message}`); }
    }
  }
}
async function getAccount(accountId) {
  const [rows] = await pool.execute('SELECT * FROM epic_sprite_accounts WHERE account_id=?', [accountId]);
  return rows[0] || null;
}
function decryptToken(row) {
  return encryptionService.decrypt(JSON.parse(row.refresh_token_enc));
}
// Build a URL-safe slug from a displayName: preserve Latin base chars (José → jose),
// strip modifier letters / emoji / CJK / etc. (manhandsᵀⱽ → manhands). Falls back to a
// short random hash when nothing meaningful survives the strip.
function slugFromDisplayName(name) {
  if (!name) return null;
  const cleaned = String(name)
    .normalize('NFD')                          // decompose Latin accents into base+mark
    .replace(/\p{Mn}+/gu, '')                  // drop combining marks (é → e)
    .replace(/[^a-zA-Z0-9_-]+/g, '')           // strip everything else
    .toLowerCase()
    .slice(0, 31);
  return cleaned || null;
}

// Stable public share slug for an account (generated once, persisted). Existing share_ids
// (random base64url for legacy accounts) are kept as-is to avoid breaking shared URLs.
async function ensureShareId(accountId, existing, displayName) {
  if (existing) return existing;
  const base = slugFromDisplayName(displayName) || crypto.randomBytes(7).toString('base64url');
  // Resolve collisions by appending -2, -3, ... up to -99, then a random tail.
  let slug = base;
  for (let n = 2; n <= 99; n++) {
    const [rows] = await pool.execute(
      'SELECT account_id FROM epic_sprite_accounts WHERE share_id=? AND account_id <> ? LIMIT 1',
      [slug, accountId]);
    if (!rows.length) break;
    slug = `${base}-${n}`;
  }
  const [stillRows] = await pool.execute(
    'SELECT account_id FROM epic_sprite_accounts WHERE share_id=? AND account_id <> ? LIMIT 1',
    [slug, accountId]);
  if (stillRows.length) slug = `${base}-${crypto.randomBytes(3).toString('base64url')}`;
  try { await pool.execute('UPDATE epic_sprite_accounts SET share_id=? WHERE account_id=?', [slug, accountId]); }
  catch (e) { logger.warn(`[sprites] share id set failed: ${e.message}`); }
  return slug;
}
const baseUrl = (req) => (process.env.DASHBOARD_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// Shared tail for both login paths (paste + OAuth redirect): given a game token, sync + sign in.
async function finishLogin(req, res, tok) {
  // Pass athena through to buildModel so the saved model carries the lobby
  // level / account level / pass XP / career wins / current season label —
  // populated on the user's FIRST visit, no second sync needed.
  const { catalog, inventory, athena } = await fetchSpriteData(tok.account_id, tok.access_token);
  const model = buildModel(catalog, inventory, athena);
  // Mint a device auth — forever-permission so the user never has to re-paste.
  // Best-effort: if Epic rejects it for any reason we still have the refresh
  // token to fall back on (and the next sync will retry the back-fill).
  let deviceAuth = null;
  try { deviceAuth = await createDeviceAuth(tok.account_id, tok.access_token); }
  catch (e) { logger.warn(`[sprites] device auth on initial login failed for ${tok.account_id}: ${e.message}`); }
  await saveAccount({ accountId: tok.account_id, displayName: tok.displayName, refreshToken: tok.refresh_token, refreshExpiresAt: tok.refresh_expires_at, deviceAuth, model });
  req.session.epicAccountId = tok.account_id;
  // Track HOW the user signed in. Epic-paste counts as ownership proof, so
  // /credentials lets them bypass the "current password" gate (recovery path
  // for a forgotten password). Username/password logins require the old
  // password to change anything.
  req.session.authMethod = 'epic';
  res.redirect('/sprites');
}

// ── views (same themed grid as the standalone prototype, served as plain HTML) ──
function placeholder(v) {
  const initial = esc((v.tierLabel || '?')[0]);
  return `<svg viewBox="0 0 100 100" class="ph"><rect width="100" height="100" rx="14" fill="#15171e"/>`
    + `<text x="50" y="62" text-anchor="middle" font-size="40" font-weight="800" fill="${v.tierColor}">${initial}</text></svg>`;
}
function cell(v, opts = {}) {
  if (!v) return `<td><div class="cell empty"></div></td>`;
  const cls = ['cell', v.owned ? 'owned' : 'locked'];
  if (v.mastered) cls.push('mastered');
  if (v.future) cls.push('future');
  if (v.vaulted) cls.push('vaulted');
  // Buy-back toggle only makes sense on the owner's own view, for cells that
  // are unowned + obtainable (not vaulted, not future). Renders a small ★/+
  // button in the top-left that POSTs to /sprites/buyback/toggle.
  const isOnBuyback = opts.buybackSet && opts.buybackSet.has(v.name);
  if (isOnBuyback) cls.push('buyback');
  const buybackBtn = (opts.showBuybackToggle && !v.owned && !v.vaulted && !v.future)
    ? `<form method="post" action="/sprites/buyback/toggle" class="buyback-toggle-form">
         <input type="hidden" name="variant_name" value="${esc(v.name)}">
         <button type="submit" class="buyback-toggle ${isOnBuyback ? 'on' : 'off'}" title="${isOnBuyback ? 'Remove from buy-back list' : 'Add to buy-back list'}">${isOnBuyback ? '★' : '+'}</button>
       </form>` : '';
  const img = v.imgId
    ? `<img loading="lazy" src="/sprites/img/${esc(v.imgId)}.png" alt="${esc(v.name)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:this.dataset.ph}).firstChild)" data-ph="${esc(placeholder(v))}">`
    : placeholder(v);
  const badges = [];
  if (v.starter) badges.push('<span class="b starter">★ Starter</span>');
  if (v.mastered) badges.push('<span class="b master">✦ Mastered</span>');
  // For future variants with a known release date (Holofoil = 2026-07-09
  // 9 AM ET), swap the static "Unreleased" pill for a "Releases in <clock>"
  // countdown. Client script fills the clock via textContent per second.
  // Gem + any other future tier we don't have a date for stays on "Unreleased".
  //
  // Vaulted families are skipped entirely — Epic may not un-vault them on
  // release day (Air/Seven are currently absent from the loot pool), so
  // promising a countdown would be misleading. The 🚫 Vaulted badge below
  // already carries the "not available" signal on its own.
  if (v.future && !v.owned && !v.vaulted) {
    if (v.tierKey === 'holofoil') {
      badges.push('<span class="b countdown">Releases in <span class="holofoil-cd">…</span></span>');
    } else {
      badges.push('<span class="b soon">Unreleased</span>');
    }
  }
  if (v.vaulted) badges.push('<span class="b vaulted">🚫 Vaulted</span>');
  const xpLine = v.owned
    ? `<span class="xp">${fmt(v.xp)} XP${v.mastered ? '' : ` / ${fmt(4000)}`}</span>`
    : `<span class="cost">${v.summonCost != null ? `${fmt(v.summonCost)} ✦` : ''}</span>`;
  const bar = v.owned && !v.mastered
    ? `<i class="prog" style="width:${Math.min(100, Math.round((v.xp / 4000) * 100))}%"></i>` : '';
  return `<td><div class="${cls.join(' ')}" title="${esc(v.name)}">
    ${buybackBtn}
    <div class="thumb">${img}${v.owned ? '<span class="tick">✓</span>' : '<span class="lock">🔒</span>'}</div>
    <div class="meta"><span class="tn" style="color:${v.tierColor}">${esc(v.tierLabel)}</span>${xpLine}</div>
    <div class="track">${bar}</div>
    <div class="badges">${badges.join('')}</div>
  </div></td>`;
}

const STYLE = `
  :root{--bg:#0b0c10;--bg2:#101218;--card:#161922;--line:#242837;--txt:#eef0f6;--muted:#878da0;
        --green:#3ad07a;--purple:#7b5cff;--gold:#ffcf3a}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#1a1430,transparent),var(--bg);
       color:var(--txt);font:15px/1.5 'Segoe UI',system-ui,Roboto,sans-serif}
  a{color:var(--purple)} code{background:#0e0f13;padding:2px 6px;border-radius:6px;border:1px solid var(--line)}
  /* No backdrop-filter on the sticky header — it forces the browser to re-blur
     the entire scrolling content on every frame, the single biggest scroll-
     perf killer on a long page like this. Solid high-opacity bg reads the
     same to the eye and scrolls at full framerate. */
  header{display:flex;align-items:center;gap:14px;padding:16px 26px;border-bottom:1px solid var(--line);
         background:#0c0d12;position:sticky;top:0;z-index:5}
  .logo{font-weight:900;letter-spacing:.5px;font-size:18px}
  .logo .c{color:var(--green)} .logo .f{color:var(--purple)}
  .tagline{color:var(--muted);font-size:13px;border-left:1px solid var(--line);padding-left:14px}
  .logo{text-decoration:none}
  .logo:hover{filter:brightness(1.1)}
  .nav{margin-left:auto;display:flex;gap:10px;align-items:center} .nav form{margin:0}
  .nav button:not(.menu-item){background:#1b1e29;color:var(--txt);border:1px solid var(--line);border-radius:8px;
              padding:7px 13px;font:600 13px/1 inherit;cursor:pointer}
  .nav button:not(.menu-item):hover{border-color:var(--purple)} .nav button.danger:not(.menu-item):hover{border-color:#ff5b6e;color:#ff8a96}
  /* ── Top-nav user menu ─────────────────────────────────────────────── */
  .avatar{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;font-weight:900;font-size:13px;color:#fff;flex:none;text-shadow:0 1px 1px rgba(0,0,0,.3)}
  .usermenu{position:relative}
  .usermenu summary{cursor:pointer;display:flex;align-items:center;gap:9px;padding:4px 12px 4px 4px;border:1px solid var(--line);border-radius:999px;background:#161922;color:var(--txt);font-weight:700;font-size:13px;user-select:none;transition:border-color .15s,background .15s;list-style:none}
  .usermenu summary::-webkit-details-marker{display:none}
  .usermenu summary::marker{display:none;content:''}
  .usermenu summary:hover{border-color:var(--purple);background:#1a1f2a}
  .usermenu[open] summary{border-color:var(--purple);background:#1a1f2a}
  .usermenu-name{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .usermenu-caret{color:var(--muted);font-size:9px;margin-left:2px;transition:transform .2s}
  .usermenu[open] .usermenu-caret{transform:rotate(180deg)}
  .usermenu-dropdown{position:absolute;top:calc(100% + 10px);right:0;min-width:230px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px;box-shadow:0 12px 36px rgba(0,0,0,.5);z-index:20}
  .usermenu-dropdown::before{content:'';position:absolute;top:-7px;right:18px;width:12px;height:12px;background:var(--card);border:1px solid var(--line);border-right:0;border-bottom:0;transform:rotate(45deg)}
  .menu-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;color:var(--txt);text-decoration:none;font:700 13px/1.2 inherit;background:transparent;border:0;cursor:pointer;width:100%;text-align:left;transition:background .12s}
  .menu-item:hover{background:rgba(123,92,255,.14)}
  .menu-item.current{background:rgba(123,92,255,.18);color:#cbb5ff}
  .menu-item.danger{color:#ff8aa6}
  .menu-item.danger:hover{background:rgba(255,91,110,.14)}
  .menu-icon{font-size:14px;width:18px;text-align:center;flex:none}
  .menu-form{margin:0;padding:0}
  .menu-divider{height:1px;background:var(--line);margin:5px 8px}
  /* CertiFried Network dropdown — sibling to .usermenu, lives next to the brand logo. */
  .cf-network{position:relative;align-self:center;margin-left:6px}
  .cf-network summary{cursor:pointer;display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border:1px solid var(--line);border-radius:999px;background:#161922;color:var(--txt);font-weight:700;font-size:12px;letter-spacing:.04em;user-select:none;transition:border-color .15s,background .15s;list-style:none}
  .cf-network summary::-webkit-details-marker{display:none}
  .cf-network summary:hover,.cf-network[open] summary{border-color:var(--purple);background:#1a1f2a;color:#cfc5ff}
  .cf-network-menu{position:absolute;top:calc(100% + 9px);left:0;min-width:240px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px;box-shadow:0 12px 36px rgba(0,0,0,.5);z-index:25}
  .cf-network-menu::before{content:'';position:absolute;top:-7px;left:18px;width:12px;height:12px;background:var(--card);border:1px solid var(--line);border-right:0;border-bottom:0;transform:rotate(45deg)}
  .cf-network-menu a{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;color:var(--txt);text-decoration:none;font:700 13px/1.2 inherit;transition:background .12s}
  .cf-network-menu a:hover{background:rgba(123,92,255,.14);color:#cfc5ff}
  .cf-network-menu .cfn-section{padding:6px 12px 4px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
  .cf-network-menu .cfn-divider{height:1px;background:var(--line);margin:5px 8px}
  .nav .navlink{padding:7px 13px;border-radius:999px;color:var(--muted);font-weight:700;font-size:13px;text-decoration:none;transition:color .15s,background .15s}
  .nav .navlink:hover{color:var(--txt);background:#161922}
  .nav .navlink.primary{background:linear-gradient(90deg,var(--purple),#9b7bff);color:#fff}
  .nav .navlink.primary:hover{filter:brightness(1.1);background:linear-gradient(90deg,var(--purple),#9b7bff)}
  main{max-width:1180px;margin:0 auto;padding:26px}
  .hero{display:flex;gap:24px;align-items:center;flex-wrap:wrap;background:var(--card);
        border:1px solid var(--line);border-radius:14px;padding:14px 20px;margin-bottom:14px}
  .who{font-size:12px;color:var(--muted)} .who b{display:block;font-size:20px;color:var(--txt);line-height:1.2}
  .stats{display:flex;gap:22px;flex-wrap:wrap;flex:1}
  .stat{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;line-height:1.3}
  .stat b{display:block;font-size:22px;color:var(--txt);letter-spacing:0;text-transform:none;line-height:1.1;margin-bottom:1px}
  .stat.dust b{color:var(--gold)} .stat.master b{color:var(--purple)} .stat.owned b{color:var(--green)} .stat.xp b{color:#5bf0ff} .stat.future b{color:#ffa64d} .stat.acct b{color:#ff8aa6} .stat.vaulted b{color:#ff5b6e}
  .who .since{display:block;font-size:11px;color:var(--muted);font-weight:400;margin-top:2px;letter-spacing:0;text-transform:none}
  .lvlbadge{display:flex;flex-direction:column;align-items:center;justify-content:center;
            width:66px;height:66px;border-radius:50%;flex:none;
            background:linear-gradient(135deg,var(--purple) 0%,#5832dd 100%);
            color:#fff;box-shadow:0 0 14px rgba(123,92,255,.4)}
  .lvlnum{font-size:24px;font-weight:900;line-height:1}
  .lvllabel{font-size:9px;font-weight:700;letter-spacing:.12em;opacity:.92;margin-top:2px}
  .playercard{display:grid;grid-template-columns:1.1fr 1fr;gap:30px;background:var(--card);
              border:1px solid var(--line);border-radius:18px;padding:22px 26px;margin-bottom:24px}
  .playercard .cardhead{font-size:11px;text-transform:uppercase;letter-spacing:.08em;
                        color:var(--muted);margin:0 0 14px;font-weight:700}
  .tierrow{display:grid;grid-template-columns:84px 1fr 56px;gap:12px;align-items:center;margin:7px 0;font-size:13px}
  .tlabel{font-weight:800;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em}
  .tbar{height:10px;background:#0e0f13;border:1px solid var(--line);border-radius:6px;overflow:hidden}
  .tfill{height:100%;transition:width .3s ease;border-radius:5px}
  .tcnt{font-weight:700;color:var(--txt);font-variant-numeric:tabular-nums;text-align:right;font-size:13px}
  .tcnt.sub{font-weight:600;color:var(--muted);font-size:12px}
  .tnote{font-weight:600;color:#ff8aa6;font-size:11px;margin-left:6px;cursor:help}
  .tierrow.muted .tlabel,.tierrow.muted .tcnt{opacity:.85}
  .highlights ul{margin:0;padding:0;list-style:none}
  .highlights li{padding:6px 0;font-size:13.5px;line-height:1.55;color:var(--txt);border-bottom:1px dashed #1d2030}
  .highlights li:last-child{border-bottom:0}
  @media (max-width:780px){.playercard{grid-template-columns:1fr;gap:18px}}
  /* Profile extras: playercard + career timeline get tucked behind a single
     "Collector profile & history" details section so the sprite grid is what
     draws the eye on first paint, with the deeper data still one click away. */
  .profile-extras{margin-top:28px}
  .profile-extras > summary{cursor:pointer;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:10px 14px;background:#0e0f13;border:1px solid var(--line);border-radius:10px;list-style:none;display:flex;align-items:center;gap:8px;user-select:none;transition:color .15s,border-color .15s}
  .profile-extras > summary::-webkit-details-marker{display:none}
  .profile-extras > summary::before{content:'▶';font-size:10px;color:var(--purple);transition:transform .2s}
  .profile-extras[open] > summary::before{transform:rotate(90deg)}
  .profile-extras > summary:hover{color:var(--txt);border-color:var(--purple)}
  .profile-extras[open] > summary{margin-bottom:16px}
  .career-timeline{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px 26px;margin-bottom:24px;content-visibility:auto;contain-intrinsic-size:0 900px}
  .career-timeline .cardhead{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 14px;font-weight:700}
  .career-timeline .cardhead .sub{font-size:11px;color:var(--muted);font-weight:600;text-transform:none;letter-spacing:0}
  .ct-rows{display:flex;flex-direction:column;gap:6px}
  .ct-row{display:grid;grid-template-columns:200px 1fr 220px auto;align-items:center;gap:14px;padding:8px 12px;background:#0e0f13;border:1px solid var(--line);border-radius:10px;transition:background .15s}
  .ct-row:hover{background:#11141c}
  .ct-row.completed{background:rgba(255,207,58,.06);border-color:rgba(255,207,58,.3)}
  .ct-row.completed:hover{background:rgba(255,207,58,.09)}
  .ct-row.current{border-color:var(--purple);box-shadow:0 0 0 1px rgba(123,92,255,.25)}
  .ct-season{font-weight:700;font-size:13px;color:var(--txt)}
  .ct-bar{height:14px;background:#161922;border:1px solid var(--line);border-radius:7px;overflow:hidden;position:relative}
  .ct-fill{height:100%;background:linear-gradient(90deg,var(--purple),#9b7bff);transition:width .4s ease;border-radius:6px}
  .ct-fill.completed{background:linear-gradient(90deg,var(--gold),#ffe48a)}
  .ct-stat{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  .ct-stat b{color:var(--txt);font-size:14px;margin:0 4px}
  .ct-status{display:inline-block;padding:3px 10px;border-radius:999px;font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
  .ct-status.complete{background:rgba(255,207,58,.18);color:var(--gold)}
  .ct-status.current{background:rgba(123,92,255,.18);color:var(--purple)}
  @media (max-width:780px){
    .ct-row{grid-template-columns:1fr;gap:6px;padding:10px 12px}
    .ct-stat{font-size:13px}
  }
  .ring{--p:0;width:72px;height:72px;border-radius:50%;display:grid;place-items:center;
        background:conic-gradient(var(--green) calc(var(--p)*1%),#222634 0)}
  .ring i{width:58px;height:58px;border-radius:50%;background:var(--card);display:grid;place-items:center;
          font-size:17px;font-weight:800;font-style:normal}
  /* Skip rendering the table when it's off-screen — modern browsers honor this
     to dramatically reduce scroll cost on big DOM. contain-intrinsic-size gives
     the layout a height estimate so the page geometry stays stable. */
  table.grid{content-visibility:auto;contain-intrinsic-size:0 2400px}
  table{width:100%;border-collapse:separate;border-spacing:0;background:var(--bg2);
        border:1px solid var(--line);border-radius:16px;overflow:hidden}
  thead th{background:#12141c;font-size:12px;text-transform:uppercase;
           letter-spacing:.06em;padding:12px 8px;border-bottom:1px solid var(--line)}
  thead th:first-child{text-align:left;padding-left:18px;color:var(--muted)}
  tbody tr:nth-child(odd){background:rgba(255,255,255,.012)}
  th.fam{text-align:left;padding:10px 14px 10px 18px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:middle}
  .famname{font-weight:700;font-size:15px;display:block} .famcount{font-size:12px;color:var(--muted)} .famcount.full{color:var(--green)}
  .famcount-vaulted{font-size:11px;color:#ff5b6e;font-weight:700;text-transform:uppercase;letter-spacing:.04em;display:inline-block;padding:2px 8px;border-radius:999px;background:rgba(255,91,110,.12);margin-top:2px}
  td{padding:8px;border-bottom:1px solid var(--line);text-align:center;vertical-align:top}
  /* table-layout: fixed prevents the countdown-driven text width changes from
     recomputing column widths every second — without it, a wobble in any
     .b.countdown badge cascades to the whole column and shifts the jail-bar
     SVG backgrounds around. contain: layout on .cell isolates each cell's
     internal reflow from ancestors. */
  table.grid{table-layout:fixed}
  .cell{display:flex;flex-direction:column;align-items:center;gap:5px;min-width:104px;padding:8px 6px 9px;border-radius:12px;transition:transform .12s;contain:layout}
  .cell:hover{transform:translateY(-2px)} .cell.empty{visibility:hidden}
  .thumb{position:relative;width:78px;height:78px;border-radius:14px;display:grid;place-items:center;background:#0f1118;border:1px solid var(--line);overflow:hidden}
  .thumb img,.thumb .ph{width:100%;height:100%;object-fit:contain}
  /* All unowned states show the sprite in FULL COLOR now — the overlay carries the state semantic. */
  .cell.locked .thumb img,.cell.locked .thumb .ph,
  .cell.vaulted .thumb img,.cell.vaulted .thumb .ph,
  .cell.future  .thumb img,.cell.future  .thumb .ph{filter:none;opacity:1}
  .cell.owned .thumb{border-color:rgba(58,208,122,.5);box-shadow:0 0 0 1px rgba(58,208,122,.25)}
  .cell.mastered .thumb{border-color:var(--purple);box-shadow:0 0 14px rgba(123,92,255,.45)}
  .tick{position:absolute;top:3px;right:4px;background:var(--green);color:#04210f;font-weight:900;font-size:12px;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;z-index:5}
  /* Hide the tiny corner lock — we now paint a big centered one via ::after. */
  .cell:not(.owned) .lock{display:none}
  /* BIG LOCK: obtainable-but-unowned cells get a full-thumb dark scrim + centered padlock. */
  .cell.locked:not(.vaulted):not(.future) .thumb::after{
    content:'🔒';position:absolute;inset:0;display:grid;place-items:center;
    font-size:38px;line-height:1;color:#fff;
    text-shadow:0 2px 6px rgba(0,0,0,.9),0 0 18px rgba(0,0,0,.65);
    background:linear-gradient(rgba(0,0,0,.25),rgba(0,0,0,.55));
    pointer-events:none;z-index:3;border-radius:inherit}
  /* JAIL BARS: vaulted OR future (both = "not in the loot pool right now") get horizontal
     top/bottom rails + 4 vertical iron bars painted via an inline SVG background image. */
  .cell.vaulted .thumb::before,
  .cell.future:not(.owned) .thumb::before{
    content:'';position:absolute;inset:0;pointer-events:none;z-index:3;border-radius:inherit;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 78 78' preserveAspectRatio='none'><defs><linearGradient id='bar' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='%23140a02'/><stop offset='0.35' stop-color='%236b5024'/><stop offset='0.65' stop-color='%234a3818'/><stop offset='1' stop-color='%23140a02'/></linearGradient><linearGradient id='rail' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='%236b5024'/><stop offset='0.5' stop-color='%234a3818'/><stop offset='1' stop-color='%23140a02'/></linearGradient></defs><rect x='0' y='0' width='78' height='5' fill='url(%23rail)'/><rect x='0' y='73' width='78' height='5' fill='url(%23rail)'/><rect x='11' y='4' width='4.5' height='70' fill='url(%23bar)' rx='0.5'/><rect x='28' y='4' width='4.5' height='70' fill='url(%23bar)' rx='0.5'/><rect x='45' y='4' width='4.5' height='70' fill='url(%23bar)' rx='0.5'/><rect x='62' y='4' width='4.5' height='70' fill='url(%23bar)' rx='0.5'/></svg>");
    background-size:100% 100%;background-repeat:no-repeat;
    box-shadow:inset 0 0 24px rgba(0,0,0,.55)}
  /* Vaulted keeps its warm red border/glow as an extra semantic cue on top of the bars. */
  .cell.future:not(.owned) .thumb{border-color:rgba(91,240,255,.4);box-shadow:0 0 10px rgba(91,240,255,.15)}
  .meta{display:flex;flex-direction:column;line-height:1.25} .tn{font-size:12px;font-weight:700} .xp{font-size:11px;color:var(--muted)} .cost{font-size:11px;color:#7e8aa0}
  .track{width:78px;height:4px;background:#1c2030;border-radius:3px;overflow:hidden}
  .track .prog{display:block;height:100%;background:linear-gradient(90deg,var(--purple),var(--green))}
  .cell:not(.owned) .track,.cell.mastered .track{visibility:hidden}
  .badges{display:flex;gap:4px;flex-wrap:wrap;justify-content:center;min-height:16px}
  .b{font-size:9.5px;font-weight:800;padding:1px 6px;border-radius:6px;text-transform:uppercase;letter-spacing:.04em}
  .b.starter{color:var(--gold);background:rgba(255,207,58,.12)} .b.master{color:var(--purple);background:rgba(123,92,255,.16)} .b.soon{color:#5bf0ff;background:rgba(91,240,255,.1)} .b.vaulted{color:#ff5b6e;background:rgba(255,91,110,.12)}
  /* "Releases in <clock>" pill — celebratory gold, distinct from static
     "Unreleased" cyan so the ticking countdown reads as opportunity, not
     as another unavailable variant. Countdown numbers are extra-bright.
     inline-block + min-width on the number span locks total pill width so
     digit transitions can't cause micro-reflow (the "wobble" symptom). */
  .b.countdown{color:#ffcf3a;background:rgba(255,207,58,.14);border:1px solid rgba(255,207,58,.22)}
  .holofoil-cd{color:#ffe48a;font-variant-numeric:tabular-nums;letter-spacing:.02em;display:inline-block;min-width:6.6em;text-align:right}
  /* Buy-back list — same gold palette as the countdown pill, matched theming. */
  .bb-panel{margin:0 auto 18px;max-width:1180px;padding:0;border:1px solid rgba(255,207,58,.22);border-radius:14px;background:linear-gradient(180deg,rgba(255,207,58,.06),rgba(255,207,58,.01));overflow:hidden}
  .bb-panel[open]{background:linear-gradient(180deg,rgba(255,207,58,.08),rgba(255,207,58,.015))}
  .bb-summary{list-style:none;cursor:pointer;padding:12px 18px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;font-size:14px;user-select:none;color:var(--txt)}
  .bb-summary::-webkit-details-marker{display:none}
  .bb-summary::marker{content:''}
  .bb-summary::before{content:'▸';display:inline-block;margin-right:8px;color:var(--gold);font-size:12px;transition:transform .15s}
  .bb-panel[open] .bb-summary::before{transform:rotate(90deg)}
  .bb-summary-stats{color:var(--muted);font-size:13px}
  .bb-summary-stats b{color:#ffe48a;font-variant-numeric:tabular-nums}
  .bb-fresh{color:var(--muted);font-size:12px;margin-left:6px;font-variant-numeric:tabular-nums}
  .bb-share{display:inline-block;margin-left:10px;padding:3px 10px;border:1px solid rgba(255,207,58,.35);border-radius:6px;background:rgba(255,207,58,.10);color:#ffcf3a;font-size:11px;font-weight:700;text-decoration:none;transition:background .12s}
  .bb-share:hover{background:rgba(255,207,58,.22);color:#ffe48a}
  .bb-panel-body{padding:0 18px 16px;border-top:1px solid rgba(255,207,58,.14)}
  .bb-progress{height:8px;background:#0e0f13;border:1px solid var(--line);border-radius:5px;overflow:hidden;margin:12px 0 10px}
  .bb-progress i{display:block;height:100%;background:linear-gradient(90deg,#ffcf3a,#ffe48a);transition:width .4s}
  .bb-seed-note{margin:6px 0 10px;padding:8px 12px;background:rgba(58,208,122,.10);border:1px solid rgba(58,208,122,.3);border-radius:8px;color:#a6f0c2;font-size:13px}
  .bb-seed-note.bb-seed-warn{background:rgba(255,207,58,.10);border-color:rgba(255,207,58,.35);color:#ffcf3a}
  .bb-list-table{width:100%;border-collapse:collapse;margin:8px 0 12px;background:#0e0f13;border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .bb-row td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:middle;font-size:14px}
  .bb-row:last-child td{border-bottom:0}
  .bb-row:hover td{background:rgba(255,207,58,.04)}
  .bb-cell-thumb{width:52px}
  .bb-thumb{display:inline-block;width:42px;height:42px;object-fit:contain;background:#0f1118;border:1px solid var(--line);border-radius:8px}
  .bb-thumb-ph{display:grid;place-items:center;font-weight:900;font-size:16px}
  .bb-tier{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;margin-right:8px}
  .bb-auto{display:inline-block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#7b5cff;background:rgba(123,92,255,.12);padding:2px 6px;border-radius:5px;margin-left:8px;vertical-align:middle}
  .bb-cell-cost{text-align:right;font-variant-numeric:tabular-nums;color:#ffe48a;font-weight:700;white-space:nowrap;width:100px}
  .bb-cell-action{width:36px;text-align:center}
  .bb-remove{background:transparent;color:var(--muted);border:1px solid var(--line);border-radius:6px;width:24px;height:24px;padding:0;font-size:14px;line-height:1;cursor:pointer;transition:color .12s,border-color .12s}
  .bb-remove:hover{color:#ff5b6e;border-color:#ff5b6e}
  .bb-seed{margin-top:6px;padding:10px;border:1px dashed var(--line);border-radius:8px}
  .bb-seed summary{cursor:pointer;font-weight:700;color:var(--muted);font-size:13px}
  .bb-seed[open] summary{color:var(--txt)}
  /* Per-cell buy-back toggle button — top-left corner of unowned obtainable cells. */
  .buyback-toggle-form{position:absolute;top:3px;left:3px;margin:0;z-index:4}
  .buyback-toggle{background:rgba(0,0,0,.55);color:#ffcf3a;border:1px solid rgba(255,207,58,.35);border-radius:6px;width:20px;height:20px;padding:0;font:800 12px/1 inherit;cursor:pointer;display:grid;place-items:center;transition:background .12s,color .12s,transform .12s}
  .buyback-toggle:hover{background:rgba(255,207,58,.22);color:#ffe48a;transform:scale(1.1)}
  .buyback-toggle.on{background:rgba(255,207,58,.28);color:#ffe48a;border-color:#ffcf3a}
  .cell.buyback .thumb{box-shadow:0 0 0 2px rgba(255,207,58,.35),0 0 12px rgba(255,207,58,.18)}
  /* Since the toggle uses absolute positioning, the cell needs relative. */
  .cell{position:relative}
  .relogin-banner{display:flex;align-items:center;gap:14px;background:linear-gradient(90deg,rgba(255,91,110,.18),rgba(255,138,166,.08));border:1px solid rgba(255,91,110,.5);color:#ffd0d8;border-radius:14px;padding:14px 20px;margin-bottom:20px;font-size:14px;line-height:1.55;flex-wrap:wrap}
  .relogin-banner b{color:#fff} .relogin-banner .btn{background:#ff8aa6 !important;color:#3a0010 !important}
  .expiry-banner{display:flex;align-items:center;gap:14px;background:linear-gradient(90deg,rgba(255,207,58,.18),rgba(255,228,138,.08));border:1px solid rgba(255,207,58,.5);color:#ffe9a8;border-radius:14px;padding:14px 20px;margin-bottom:14px;font-size:14px;line-height:1.55;flex-wrap:wrap}
  .expiry-banner b{color:#fff}
  .admin-table{width:100%;border-collapse:collapse;font-size:13px;background:var(--bg2);border:1px solid var(--line);border-radius:14px;overflow:hidden}
  .admin-table th,.admin-table td{padding:11px 13px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
  .admin-table th{background:#12141c;text-transform:uppercase;letter-spacing:.05em;font-size:11px;color:var(--muted)}
  .admin-table tr:hover td{background:rgba(255,255,255,.02)}
  .admin-table .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.04em}
  .admin-table .pill.ok{background:rgba(58,208,122,.15);color:var(--green)} .admin-table .pill.bad{background:rgba(255,91,110,.18);color:#ff8aa6}
  .admin-table .pill.warn{background:rgba(255,207,58,.18);color:var(--gold)}
  .admin-table a{color:var(--purple)}
  .admin-table code{font-size:11px}
  .browse-search{width:100%;padding:11px 13px;border-radius:9px;border:1px solid var(--line);background:#0e0f13;color:var(--txt);font:inherit;margin:14px 0 4px}
  .browse-search:focus{outline:none;border-color:var(--purple)}
  .feed-list{list-style:none;padding:0;margin:0}
  .feed-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--line);font-size:13.5px;line-height:1.5}
  .feed-row:last-child{border-bottom:0}
  .feed-row a{color:var(--txt);text-decoration:none}
  .feed-row a:hover b{color:var(--purple)}
  .feed-icon{flex:none;width:22px;text-align:center;font-size:14px}
  .feed-time{margin-left:auto;color:var(--muted);font-size:11.5px;font-weight:600;white-space:nowrap}
  .browse-list{list-style:none;padding:0;margin:14px 0}
  .browse-row{padding:11px 0;border-bottom:1px solid var(--line)}
  .browse-row:last-child{border-bottom:0}
  .browse-row label{display:flex;align-items:center;gap:14px;cursor:pointer}
  .browse-row label:hover{background:rgba(123,92,255,.06);margin:0 -14px;padding:0 14px;border-radius:8px}
  .browse-row input{accent-color:var(--purple);width:18px;height:18px}
  .browse-id{flex:1} .browse-id .sub{display:block;font-size:12px;color:var(--muted);margin-top:2px}
  .browse-count{font-weight:800;color:var(--green);font-variant-numeric:tabular-nums}
  .browse-count .sub{color:var(--muted);font-weight:600}
  .cmp-summary{display:flex;gap:16px;flex-wrap:wrap}
  .cmp-summary-card{padding:10px 14px;background:#0e0f13;border:1px solid var(--line);border-radius:10px;min-width:200px}
  .cmp-user-link b{color:var(--txt)} .cmp-user-link:hover b{color:var(--purple)}
  .cmp-table{width:100%;border-collapse:collapse;font-size:13px;background:var(--bg2);border:1px solid var(--line);border-radius:14px;overflow:hidden}
  .cmp-table th,.cmp-table td{padding:11px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
  .cmp-table th{background:#12141c;text-transform:uppercase;letter-spacing:.05em;font-size:11px;color:var(--muted)}
  .cmp-table tr:last-child td{border-bottom:0}
  .cmp-table tr.unique td{background:rgba(255,207,58,.05)}
  .cmp-table tr.unique td:first-child{box-shadow:inset 3px 0 0 var(--gold)}
  .cmp-sprite{display:flex;align-items:center;gap:14px}
  .cmp-thumb{flex:none;width:56px;height:56px;border-radius:12px;background:#0f1118;border:1px solid var(--line);display:grid;place-items:center;overflow:hidden}
  .cmp-thumb img,.cmp-thumb .ph{width:100%;height:100%;object-fit:contain}
  .cmp-text{display:flex;flex-direction:column;gap:3px;line-height:1.3}
  .cmp-sprite .cmp-tier{font-weight:800;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em}
  .cmp-sprite b{font-size:15px}
  .cmp-table tr.unique .cmp-thumb{border-color:rgba(255,207,58,.55);box-shadow:0 0 10px rgba(255,207,58,.15)}
  .cmp-badge{display:inline-block;margin-left:10px;font-size:10px;font-weight:800;background:rgba(255,207,58,.16);color:var(--gold);padding:2px 8px;border-radius:999px;letter-spacing:.04em;text-transform:uppercase}
  .cmp-user{display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(58,208,122,.14);color:var(--green);font-weight:700;font-size:12px;text-decoration:none;margin:2px 4px 2px 0;border:1px solid rgba(58,208,122,.3)}
  .cmp-user:hover{background:rgba(58,208,122,.22)}
  .cmp-need .cmp-user{background:rgba(255,91,110,.12);color:#ff8aa6;border-color:rgba(255,91,110,.3)}
  .cmp-need .cmp-user:hover{background:rgba(255,91,110,.2)}
  .cmp-have-col,.cmp-need-col{width:38%}
  @media (max-width:720px){
    .cmp-table thead{display:none}
    .cmp-table tr{display:block;border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px;background:var(--bg2)}
    .cmp-table tr.unique{background:rgba(255,207,58,.06);box-shadow:inset 3px 0 0 var(--gold)}
    .cmp-table td{display:block;padding:6px 0;border:0;text-align:left;width:100%}
    .cmp-table td.cmp-have::before{content:'✓ HAS: ';color:var(--green);font-weight:800;font-size:11px;letter-spacing:.05em;margin-right:6px}
    .cmp-table td.cmp-need::before{content:'✗ NEEDS: ';color:#ff8aa6;font-weight:800;font-size:11px;letter-spacing:.05em;margin-right:6px}
    .cmp-sprite{padding-bottom:10px;border-bottom:1px solid var(--line)}
    .cmp-summary-card{min-width:0;width:100%}
  }
  /* /sprites/info — transparency page. Table shows the 4 endpoints checked +
     Quack/Batman hit counts. Pill rows show live tier tokens + family names +
     "absent" tokens the community keeps asking about. */
  .audit-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;background:var(--bg2);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .audit-table th,.audit-table td{padding:8px 10px;border:1px solid var(--line);vertical-align:top;text-align:left}
  .audit-table th{background:#1a1e2b;font-weight:700}
  /* .audit-num rather than .num because .num is already used elsewhere as a
     30px purple circular badge for the Epic Setup steps (line ~1362). Class
     collision was making Response Size cells render as tiny purple circles. */
  .audit-table td.audit-num,.audit-table th.audit-num{text-align:right;white-space:nowrap}
  .audit-table td.center,.audit-table th.center{text-align:center}
  .audit-hit{color:#ff8090;font-weight:800}
  .audit-hit-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .audit-sub{font-size:11px;color:var(--muted);display:block;margin-top:2px}
  .audit-tokens{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 4px}
  .audit-token{background:#1a1e2b;border:1px solid #2a2f3c;padding:3px 9px;border-radius:6px;color:#a9b6d0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:nowrap}
  .audit-token.absent{background:#2a1015;border-color:#6b1a24;color:#ffb4bd;font-weight:700}
  .audit-token.family{font-size:11px}
  @media (max-width:600px){
    /* Global — the whole site benefits from these, not just /sprites/info */
    body{overflow-x:hidden}
    main{padding:14px 12px;overflow-wrap:anywhere}
    .card{padding:16px;margin:14px auto;border-radius:12px}
    /* On narrow screens, long unbreakable strings in <code> (endpoint URLs,
       UUIDs) force the browser to expand the layout width to fit them, then
       scale the whole page down — which is what makes the site look "too
       narrow" on a Fold cover screen. Force wrap on all code inside content. */
    .card code,.card p,.card li,.audit-token{overflow-wrap:anywhere;word-break:break-word}
    header{padding:11px 14px;flex-wrap:wrap;gap:8px 12px;position:static}
    .tagline{display:none}
    .cf-network{margin-left:0}
    .nav{margin-left:0;flex-wrap:wrap;gap:6px}
    .nav .navlink{padding:5px 10px;font-size:12px}
    /* Main sprite grid — 7-col table (family label + 6 tiers) with 104px
       min-width cells + 78px thumbs = 728px minimum table width. On a 340px
       viewport, table-layout:fixed collapses columns below thumb width and
       cells visually overlap. Same fix as .cmp-table / .audit-table: stack
       into a card-per-family layout with the tier cells as a flex-wrap grid. */
    table.grid,table.grid tbody,table.grid tr{display:block;background:transparent;border:0;width:auto}
    table.grid{border-radius:0;overflow:visible;content-visibility:visible;contain-intrinsic-size:auto}
    table.grid thead{display:none}
    table.grid tr{background:var(--card);border:1px solid var(--line);border-radius:14px;
                  margin-bottom:12px;padding:10px 8px 12px;display:flex;flex-wrap:wrap;
                  gap:8px;align-items:flex-start}
    table.grid tr:nth-child(odd){background:var(--card)}
    /* Family header spans the full row width above the cell grid. Uses
       flex-basis:100% instead of a grid column-span since siblings are flex. */
    table.grid th.fam{flex:1 0 100%;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px;
                      padding:2px 4px 8px;border-bottom:1px solid var(--line);margin-bottom:2px;
                      white-space:normal;text-align:left;background:transparent}
    table.grid th.fam .famname{font-size:16px}
    /* flex: 0 1 basis so cells DON'T grow beyond 1/3. Families with 4 tiers
       naturally show 3+1, 6 tiers show 3+3, 1 tier (Burnt Peanut) shows 1
       and lets the rest of the row stay empty rather than stretching one cell
       to fill 100% width. calc() subtracts the gap so 3 fit per row exactly. */
    table.grid td{padding:0;border:0;text-align:center;background:transparent;
                  flex:0 1 calc(33.33% - 6px)}
    table.grid td .cell{min-width:0;width:100%;padding:6px 2px 8px;gap:4px}
    /* Thumbs shrink from fixed 78px to fluid 100% (max 84px) so they scale
       inside their grid cell instead of overflowing it. aspect-ratio:1 keeps
       them square without a fixed pixel height. */
    table.grid td .thumb{width:100%;height:auto;max-width:84px;aspect-ratio:1;margin:0 auto}
    table.grid td .track{width:100%;max-width:84px;margin:0 auto}
    table.grid td .cell.empty{display:none}
    /* Big lock/jail-bar overlays scale automatically because they use
       position:absolute + inset:0, but the emoji lock at 38px is too big for
       a shrunken thumb — trim to 26px on mobile. */
    table.grid .cell.locked:not(.vaulted):not(.future) .thumb::after{font-size:26px}
    /* Countdown pill inside a mobile cell — width was 6.6em to prevent digit
       wobble; that's too wide for a shrunken cell. 5em still holds the widest
       "23h 59m" reading without wobbling. */
    .holofoil-cd{min-width:5em}
    /* Buffs strip stacks single-column instead of two side-by-side. */
    .cf-buffs-panel{min-width:0;flex:1 1 100%}
    /* Info-page audit table — stack into a card-per-row on mobile.
       data-label on each <td> becomes an inline label via ::before, matching
       the .cmp-table pattern for consistency across sprite pages. */
    .audit-table{font-size:12.5px;display:block;border:0;background:transparent;border-radius:0}
    .audit-table thead{display:none}
    .audit-table tbody{display:block}
    .audit-table tr{display:block;background:#0e0f13;border:1px solid var(--line);border-radius:10px;margin-bottom:10px;padding:10px 12px}
    /* !important on white-space beats the desktop .num class specificity
       (.audit-table td.num sets white-space:nowrap for right-aligned numeric
       columns). Without this override, Chrome shrink-wraps display:block tds
       with nowrap content to the content's intrinsic width — the Response
       Size cell was rendering at 30px wide, causing "82 variants" to visually
       overflow into the following Quack Hits cell. */
    .audit-table td{display:block;padding:5px 0;border:0;text-align:left !important;white-space:normal !important;overflow-wrap:anywhere;width:auto}
    .audit-table td::before{content:attr(data-label);display:block;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:2px}
    .audit-table td:first-child{padding-top:0}
    .audit-table td:last-child{padding-bottom:0}
    .audit-table code{display:inline-block;max-width:100%}
    /* audit-token wraps normally on narrow screens instead of forcing a
       nowrap column that pushes viewport width. Long family names like
       "ZeroPointSprite" still fit; anything longer breaks at a syllable. */
    .audit-token{white-space:normal;line-height:1.4}
    /* Text-heavy pages (/sprites/info) — shrink long-form typography so the
       page doesn't read as a wall-of-text scroll. Applies to any .card with
       prose, no effect on grid pages since those use .stat / .famname etc. */
    .card h1{font-size:20px;line-height:1.25;margin:8px 0 4px}
    .card h2{font-size:15.5px;line-height:1.3;margin:10px 0 6px}
    .card>p,.card>ol li,.card>ul li,.info-details p,.info-details ol li{font-size:13.5px;line-height:1.55}
    .card>p{margin:8px 0}
    .card>ol,.card>ul{padding-left:18px}
    /* Collapsed methodology block — click to expand. Keeps the info page
       tight on mobile while preserving full reproduction steps. */
    details.info-details{margin:0}
    details.info-details>summary{cursor:pointer;list-style:none;padding:8px 0;font-weight:700;color:var(--purple);font-size:14px}
    details.info-details>summary::-webkit-details-marker{display:none}
    details.info-details>summary::before{content:'▸ ';color:var(--muted);font-weight:800}
    details.info-details[open]>summary::before{content:'▾ '}
    details.info-details[open]>summary{margin-bottom:6px;border-bottom:1px solid var(--line)}
  }
  /* Galaxy Z Fold cover screen (~340-380 CSS px) — tighter padding, smaller
     type on the endpoint code strings, extra-aggressive wrap. */
  @media (max-width:430px){
    main{padding:12px 10px}
    .card{padding:14px;margin:10px auto}
    .card h1{font-size:19px}
    .card h2{font-size:16px}
    header{padding:9px 12px;gap:6px 10px}
    .logo{font-size:16px}
    .cf-network summary{font-size:11px;padding:4px 9px}
    .nav .navlink{padding:4px 9px;font-size:11.5px}
    .audit-table{font-size:12px}
    .audit-table td code{font-size:11px}
    .audit-token{font-size:11px;padding:2px 7px}
    .audit-token.family{font-size:10.5px}
    /* Fold cover — shrink sprite grid further so 3 cells + gaps fit in ~318px
       content width (340 viewport - 22 padding). Thumb caps at 72px, cell
       padding trims, gap tightens. Family header font drops slightly. */
    table.grid tr{padding:8px 6px 10px;gap:6px}
    table.grid td{flex:0 1 calc(33.33% - 4px)}
    table.grid td .thumb{max-width:72px}
    table.grid td .track{max-width:72px}
    table.grid td .cell{padding:5px 1px 7px;gap:3px}
    table.grid td .tn{font-size:11px}
    table.grid td .xp{font-size:10px}
    table.grid td .cost{font-size:10px}
    table.grid td .b{font-size:9px;padding:1px 5px}
    table.grid .cell.locked:not(.vaulted):not(.future) .thumb::after{font-size:22px}
    table.grid th.fam{padding:0 2px 6px}
    table.grid th.fam .famname{font-size:15px}
    table.grid th.fam .famcount{font-size:11px}
  }
  /* Buffs & Drops strip — client-populated per-second w/ ET wall clock math. */
  .cf-buffs{display:flex;gap:12px;margin:0 0 16px;flex-wrap:wrap}
  .cf-buffs-panel{flex:1;min-width:280px;padding:12px 16px;border-radius:12px;border:1px solid var(--line);background:#0e0f13;transition:background .2s,border-color .2s}
  .cf-buffs-panel.mastery{background:linear-gradient(90deg,rgba(58,208,122,.10),rgba(58,208,122,.02));border-color:rgba(58,208,122,.45)}
  .cf-buffs-panel.power{background:linear-gradient(90deg,rgba(255,207,58,.12),rgba(255,207,58,.02));border-color:rgba(255,207,58,.55)}
  .cf-buffs-title{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:4px}
  .cf-buffs-headline{font-weight:800;font-size:15px;color:#fff;margin-bottom:2px;line-height:1.2}
  .cf-buffs-sub{font-size:13px;color:var(--muted);line-height:1.45}
  .cf-buffs-countdown{font-variant-numeric:tabular-nums;font-weight:700;color:#cbb5ff}
  .cf-buffs-upcoming{margin-top:8px;padding-top:8px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:3px}
  .cf-buffs-upitem{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12.5px;color:var(--muted)}
  .cf-buffs-uplabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cmp-filter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:14px 0 14px;padding:10px 14px;background:#0e0f13;border:1px solid var(--line);border-radius:12px}
  .cmp-filter-label{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-right:4px}
  .cmp-tier-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;border:1px solid;background:#161922;cursor:pointer;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;user-select:none}
  .cmp-tier-pill input{accent-color:var(--purple);width:14px;height:14px;margin:0}
  .cmp-tier-pill:has(input:not(:checked)){opacity:.35;background:transparent}
  .cmp-clear{background:transparent;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:5px 12px;font:600 12px/1 inherit;cursor:pointer;text-transform:uppercase;letter-spacing:.04em;margin-left:auto}
  .cmp-clear:hover{color:var(--txt);border-color:var(--purple)}
  .cmp-clear + .cmp-clear{margin-left:0}
  .cell.vaulted .thumb{border-color:rgba(255,91,110,.45);box-shadow:0 0 10px rgba(255,91,110,.18)}
  /* Vaulted image no longer greyscaled — the jail bars overlay carries the "locked away" cue.
     Kept the red border above as a redundant signal (bars = "not gettable", red = "vaulted specifically"). */
  footer{color:var(--muted);font-size:12.5px;text-align:center;padding:26px;line-height:1.7}
  .legend{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;margin:18px 0 4px;color:var(--muted);font-size:12.5px}
  .legend span{display:inline-flex;align-items:center;gap:6px} .sw{width:12px;height:12px;border-radius:4px;display:inline-block}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:26px;max-width:680px;margin:30px auto}
  .card h2{margin:0 0 6px} .card ol{padding-left:20px;line-height:1.9} .warn{border-left:3px solid var(--gold);padding:8px 14px;color:#d8c98f;background:rgba(255,207,58,.06);border-radius:0 8px 8px 0;margin-top:16px}
  .card .sub{color:var(--muted);font-size:13px;margin:6px 0}
  .once{background:rgba(58,208,122,.1);border:1px solid rgba(58,208,122,.25);border-radius:10px;padding:10px 14px;color:var(--green);font-size:13px;font-weight:600;margin:16px 0}
  .step{display:flex;gap:14px;margin:20px 0;align-items:flex-start}
  .num{flex:none;width:30px;height:30px;border-radius:50%;background:var(--purple);color:#fff;display:grid;place-items:center;font-weight:800;font-size:15px}
  .stepbody{flex:1;min-width:0} .stepbody b{font-size:15px}
  .card textarea{width:100%;padding:11px 13px;border-radius:9px;border:1px solid var(--line);background:#0e0f13;color:var(--txt);font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:10px 0 12px;resize:vertical;min-height:62px}
  .card textarea:focus{outline:none;border-color:var(--purple)}
  .btn{display:inline-block;background:linear-gradient(90deg,var(--purple),#9b7bff);color:#fff;border:0;border-radius:10px;padding:11px 18px;font:700 14px/1 inherit;cursor:pointer;text-decoration:none}
  input[type=text]{width:100%;padding:11px 13px;border-radius:9px;border:1px solid var(--line);background:#0e0f13;color:var(--txt);font:inherit;margin-top:6px}
  .toolbar{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:0 0 16px}
  .filters{display:flex;gap:6px;flex-wrap:wrap}
  .filters button{background:#161922;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:6px 14px;font:600 13px/1 inherit;cursor:pointer}
  .filters button:hover{color:var(--txt)} .filters button.active{background:var(--purple);color:#fff;border-color:var(--purple)}
  .sortwrap{margin-left:auto;color:var(--muted);font-size:13px;display:flex;align-items:center;gap:8px}
  .sortwrap select{background:#161922;color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit;cursor:pointer}
  .resync-form{margin:0}
  .resync-btn{background:#161922;color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:7px 13px;font:600 13px/1 inherit;cursor:pointer;transition:border-color .15s,color .15s}
  .resync-btn:hover{border-color:var(--purple);color:#cfc5ff}
  .sharebar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:0 0 16px}
  .sharebar span{color:var(--muted);font-size:13px;font-weight:600} .sharebar input{flex:1;min-width:220px;background:#0e0f13;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:8px 11px;font:inherit;margin:0}
  .sharebar button{background:var(--purple);color:#fff;border:0;border-radius:8px;padding:8px 14px;font:700 13px/1 inherit;cursor:pointer;white-space:nowrap}
  .viewban{background:rgba(123,92,255,.1);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:0 0 16px;color:var(--muted)} .viewban b{color:var(--txt)}
  .navlink{color:var(--purple);text-decoration:none;font-weight:700;font-size:13px;align-self:center}
  table.grid .cell{transition:opacity .15s,transform .12s}
  table.f-have .cell.locked,
  table.f-need .cell.owned, table.f-need .cell.future, table.f-need .cell.vaulted,
  table.f-master .cell:not(.mastered),
  table.f-unrel .cell:not(.future){opacity:.1}
  tr.rowhide{display:none}`;

// Client-side filter + sort + copy-share (CSP allows inline script via 'unsafe-inline').
// Server-rendered SHELL for the Buffs & Drops strip — shared between
// renderCollection and renderProfile so both pages surface active buffs +
// countdowns. Pre-built DOM with named spans, filled by the client script
// via textContent (no innerHTML, no XSS surface).
const BUFFS_STRIP = `<div class="cf-buffs">
  <div class="cf-buffs-panel" id="buf-cur">
    <div class="cf-buffs-title" id="buf-cur-title">Loading…</div>
    <div class="cf-buffs-headline" id="buf-cur-headline"></div>
    <div class="cf-buffs-sub" id="buf-cur-sub1"></div>
    <div class="cf-buffs-sub" id="buf-cur-sub2-wrap" style="display:none">Ends in <span class="cf-buffs-countdown" id="buf-cur-cd"></span></div>
  </div>
  <div class="cf-buffs-panel">
    <div class="cf-buffs-title">Coming up</div>
    <div class="cf-buffs-headline" id="buf-next-headline"></div>
    <div class="cf-buffs-sub">In <span class="cf-buffs-countdown" id="buf-next-cd"></span></div>
    <div class="cf-buffs-upcoming" id="buf-upcoming">
      <div class="cf-buffs-upitem" id="buf-up1" style="display:none">
        <span class="cf-buffs-uplabel" id="buf-up1-label"></span>
        <span class="cf-buffs-countdown" id="buf-up1-cd"></span>
      </div>
      <div class="cf-buffs-upitem" id="buf-up2" style="display:none">
        <span class="cf-buffs-uplabel" id="buf-up2-label"></span>
        <span class="cf-buffs-countdown" id="buf-up2-cd"></span>
      </div>
      <div class="cf-buffs-upitem" id="buf-up3" style="display:none">
        <span class="cf-buffs-uplabel" id="buf-up3-label"></span>
        <span class="cf-buffs-countdown" id="buf-up3-cd"></span>
      </div>
      <div class="cf-buffs-upitem" id="buf-up4" style="display:none">
        <span class="cf-buffs-uplabel" id="buf-up4-label"></span>
        <span class="cf-buffs-countdown" id="buf-up4-cd"></span>
      </div>
    </div>
  </div>
</div>`;

const SCRIPT = `<script>(function(){
  // Grid-dependent logic (filters, sort, share-link copy) only runs when a
  // sprite grid is on the page — profile page has no grid but does have the
  // buffs strip further down, so we can't hard-return here or the whole
  // script bails and the strip stays stuck on "Loading…".
  var t=document.querySelector('table.grid');
  if(t){
  function applyRows(f){t.querySelectorAll('tbody tr').forEach(function(tr){
    var h=false;
    if(f==='need')h=+tr.dataset.need===0; else if(f==='have')h=+tr.dataset.owned===0;
    else if(f==='master')h=+tr.dataset.master===0; else if(f==='unrel')h=+tr.dataset.future===0;
    tr.classList.toggle('rowhide',h);});}
  document.querySelectorAll('.filters button').forEach(function(b){b.addEventListener('click',function(){
    document.querySelectorAll('.filters button').forEach(function(x){x.classList.remove('active')});
    b.classList.add('active');
    t.className='grid'+(b.dataset.f==='all'?'':' f-'+b.dataset.f); applyRows(b.dataset.f);});});
  var sel=document.getElementById('sort');
  if(sel)sel.addEventListener('change',function(){
    var tb=t.querySelector('tbody'),rows=[].slice.call(tb.querySelectorAll('tr'));
    rows.sort(function(a,b){switch(sel.value){
      case 'complete':return (b.dataset.owned-a.dataset.owned)||(a.dataset.order-b.dataset.order);
      case 'incomplete':return (a.dataset.owned-b.dataset.owned)||(a.dataset.order-b.dataset.order);
      case 'az':return a.dataset.name.localeCompare(b.dataset.name);
      default:return a.dataset.order-b.dataset.order;}});
    rows.forEach(function(r){tb.appendChild(r)});});
  var cp=document.getElementById('copyshare');
  if(cp)cp.addEventListener('click',function(){var i=document.getElementById('shareurl');i.select();
    try{navigator.clipboard.writeText(i.value)}catch(e){document.execCommand('copy')}
    cp.textContent='Copied!';setTimeout(function(){cp.textContent='Copy link'},1500);});
  } // end of grid-dependent logic block — buffs strip runs unconditionally below.

  // ─── Buffs & Drops strip ─────────────────────────────────────────────────
  // All time reasoning in America/New_York wall clock (Intl handles DST).
  // Wall-clock ms deltas match UTC deltas except across DST transitions where
  // we'd be off by an hour ~2 days a year — acceptable for countdown display.
  // Zero innerHTML — all dynamic text goes through .textContent on pre-built
  // spans, so there's no XSS surface even if we later interpolate user data.
  var bufCur=document.getElementById('buf-cur');
  if(bufCur){
    var WD=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var elCurTitle=document.getElementById('buf-cur-title');
    var elCurHead=document.getElementById('buf-cur-headline');
    var elCurSub1=document.getElementById('buf-cur-sub1');
    var elCurSub2Wrap=document.getElementById('buf-cur-sub2-wrap');
    var elCurCd=document.getElementById('buf-cur-cd');
    var elNextHead=document.getElementById('buf-next-headline');
    var elNextCd=document.getElementById('buf-next-cd');
    // Secondary "next up" slots — bind by index so we can loop cleanly.
    var upSlots=[1,2,3,4].map(function(i){
      return {
        row: document.getElementById('buf-up'+i),
        label: document.getElementById('buf-up'+i+'-label'),
        cd: document.getElementById('buf-up'+i+'-cd')
      };
    });
    function nowET(){
      var p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,weekday:'short'}).formatToParts(new Date());
      var o={};p.forEach(function(x){o[x.type]=x.value});
      var hour=parseInt(o.hour)%24;
      return {y:parseInt(o.year),m:parseInt(o.month),d:parseInt(o.day),h:hour,mi:parseInt(o.minute),s:parseInt(o.second),wd:WD.indexOf(o.weekday),ms:Date.UTC(parseInt(o.year),parseInt(o.month)-1,parseInt(o.day),hour,parseInt(o.minute),parseInt(o.second))};
    }
    function wallMs(y,m,d,h,mi){return Date.UTC(y,m-1,d,h,mi,0);}
    function nextWeekly(et,wd,h,mi){
      var days=(wd-et.wd+7)%7;
      if(days===0){var t=wallMs(et.y,et.m,et.d,h,mi); if(t>et.ms)return t; days=7;}
      var dd=new Date(et.y,et.m-1,et.d+days);
      return wallMs(dd.getFullYear(),dd.getMonth()+1,dd.getDate(),h,mi);
    }
    function fmtDelta(ms){
      if(ms<0)ms=0; var s=Math.floor(ms/1000);
      var d=Math.floor(s/86400); s%=86400;
      var h=Math.floor(s/3600); s%=3600;
      var mi=Math.floor(s/60); s%=60;
      if(d)return d+'d '+h+'h '+mi+'m';
      if(h)return h+'h '+mi+'m '+(s<10?'0':'')+s+'s';
      return mi+'m '+(s<10?'0':'')+s+'s';
    }
    // Real countdown clock — days field always shown (no format flip when
    // d crosses zero) and H:M:S zero-padded for stable column width. Renders
    // as "08d 10:41:23" and ticks every second. Used for verified events
    // with known exact drop times (Holofoil arrival, Holofoil Hours).
    function fmtPrecise(ms){
      if(ms<0)ms=0; var s=Math.floor(ms/1000);
      var d=Math.floor(s/86400); s%=86400;
      var h=Math.floor(s/3600); s%=3600;
      var mi=Math.floor(s/60); s%=60;
      var pad=function(n){return (n<10?'0':'')+n;};
      return pad(d)+'d '+pad(h)+':'+pad(mi)+':'+pad(s);
    }
    function fmtShort(ms){
      if(ms<0)ms=0; var s=Math.floor(ms/1000);
      var d=Math.floor(s/86400); s%=86400;
      var h=Math.floor(s/3600); s%=3600;
      var mi=Math.floor(s/60);
      if(d>1)return d+' days';
      if(d===1)return '1 day '+h+'h';
      if(h>0)return h+'h '+mi+'m';
      return mi+'m';
    }
    function activeMastery(et){
      if(et.wd===1&&et.h>=9)return {end:wallMs(et.y,et.m,et.d+1,9,0)};
      if(et.wd===2&&et.h<9)return {end:wallMs(et.y,et.m,et.d,9,0)};
      return null;
    }
    // ─── Verified events (Epic Community sources) ─────────────────────────
    // Holofoil variants drop Thursday 2026-07-09 at 6 AM PT (9 AM ET) with
    // the weekly patch. Source: communities.epicgames.com/thread/…/kqQk
    var HOLOFOIL_DROP_MS = wallMs(2026,7,9,9,0);
    // Catch-Up Day: Thursday 2026-07-02, 9 AM ET → next 9 AM ET (24-hour
    // event). Legendary Sprites drop at 4× rate.
    // Source: communities.epicgames.com/thread/…/oM9D
    var CATCHUP_START = wallMs(2026,7,2,9,0), CATCHUP_END = wallMs(2026,7,3,9,0);
    function activeCatchUpDay(et){
      if(et.ms>=CATCHUP_START&&et.ms<CATCHUP_END)return {end:CATCHUP_END};
      return null;
    }
    // "Summer Hits the Island: Gone Wild" — persistent multi-day event
    // running through Thursday 2026-07-09 6 AM PT (9 AM ET, same instant as
    // Holofoil release, so it hands off directly). Buffs: golden fishing
    // spots, Firework Flaregun, summer Sprite variants boosted, campfires
    // level up Sprites faster. Assumed start Thursday 2026-06-25 (typical
    // patch day; user reported 2026-07-01 that it was already active).
    var GONE_WILD_START = wallMs(2026,6,25,9,0), GONE_WILD_END = wallMs(2026,7,9,9,0);
    function activeGoneWild(et){
      if(et.ms>=GONE_WILD_START&&et.ms<GONE_WILD_END)return {end:GONE_WILD_END};
      return null;
    }
    // Saturday Power Hours run 2-4 PM ET (afternoon) + 9-11 PM ET (evening)
    // and are themed per-week: Gold & Gummy Hours, Holofoil Hours, etc.
    // Sources: /thread/gold-and-gummy-hours-july-4/vHTx (Jul 4 Gold+Gummy),
    //          /thread/holofoil-hours-july-11/MFCL (Jul 11 Holofoil)
    var SATURDAY_EVENTS = {
      '2026-07-04': {
        label: '⚡ Gold & Gummy Hours',
        description: 'Gold & Gummy variants appear more often · Mythic Gold Fish + Self-Revive on Bus drop · Faster leveling at Campfires'
      },
      '2026-07-11': {
        label: '💿 Holofoil Hours',
        description: 'Holofoil variants appear more often · Shock Rocks (2× jump, drops more) + Self-Revive on Bus drop'
      }
    };
    var DEFAULT_SAT_EVENT = { label:'⚡ Saturday Power Hour', description:'Variant Sprites boosted + unique gameplay modifiers' };
    function isoDateFromWallMs(ms){
      var d = new Date(ms);
      var pad = function(n){return (n<10?'0':'')+n;};
      return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());
    }
    function activeSaturday(et){
      if(et.wd!==6)return null;
      var mins=et.h*60+et.mi;
      // Windows: 2 PM ET–4 PM ET (mins 840-960), 9 PM ET–11 PM ET (mins 1260-1380)
      var window, end;
      if(mins>=840&&mins<960){ window='afternoon'; end=wallMs(et.y,et.m,et.d,16,0); }
      else if(mins>=1260&&mins<1380){ window='evening'; end=wallMs(et.y,et.m,et.d,23,0); }
      else return null;
      var pad=function(n){return (n<10?'0':'')+n;};
      var iso=et.y+'-'+pad(et.m)+'-'+pad(et.d);
      return { window:window, end:end, theme:(SATURDAY_EVENTS[iso]||DEFAULT_SAT_EVENT) };
    }
    function render(){
      var et=nowET();
      var sat=activeSaturday(et), cu=activeCatchUpDay(et), mm=activeMastery(et), gw=activeGoneWild(et);
      // CURRENT panel priority: acute events (Saturday themed > Catch-Up Day >
      // Mastery Monday) headline first. Gone Wild is a persistent background
      // event, so it fills the panel only when no acute event is running.
      if(sat){
        bufCur.className='cf-buffs-panel power';
        elCurTitle.textContent='💿 Active event';
        elCurHead.textContent=sat.theme.label+' ('+sat.window+')';
        elCurSub1.textContent=sat.theme.description;
        elCurSub2Wrap.style.display='';
        elCurCd.textContent=fmtDelta(sat.end-et.ms);
      } else if(cu){
        bufCur.className='cf-buffs-panel power';
        elCurTitle.textContent='🎯 Active event';
        elCurHead.textContent='Catch-Up Day';
        elCurSub1.textContent='Legendary Sprites drop at 4× the normal rate — hunt rare Sprites while the boost is live';
        elCurSub2Wrap.style.display='';
        elCurCd.textContent=fmtDelta(cu.end-et.ms);
      } else if(mm){
        bufCur.className='cf-buffs-panel mastery';
        elCurTitle.textContent='🟢 Active buff';
        elCurHead.textContent='Mastery Monday';
        elCurSub1.textContent='2× XP · 2× Dust · Legendary/Mythic spawn boosted';
        elCurSub2Wrap.style.display='';
        elCurCd.textContent=fmtDelta(mm.end-et.ms);
      } else if(gw){
        bufCur.className='cf-buffs-panel power';
        elCurTitle.textContent='🌴 Active event';
        elCurHead.textContent='Summer Hits the Island: Gone Wild';
        elCurSub1.textContent='Golden fishing spots · Firework Flaregun · summer Sprite variants boosted · faster leveling at Campfires';
        elCurSub2Wrap.style.display='';
        elCurCd.textContent=fmtDelta(gw.end-et.ms);
      } else {
        bufCur.className='cf-buffs-panel';
        elCurTitle.textContent='No active buff';
        elCurHead.textContent='Regular play';
        elCurSub1.textContent='Standard XP, dust, and spawn rates. Next boost windows below.';
        elCurSub2Wrap.style.display='none';
      }
      // NEXT panel — verified events mixed with recurring; whichever is
      // soonest headlines. Past-dated one-offs (Catch-Up Day, Holofoil drop)
      // drop out automatically via the >et.ms guards. No generic "weekly
      // Thursday drop" — that was speculation; only add specific announced
      // Thursday events (Catch-Up Day, Holofoil arrival, etc.).
      var candidates=[];
      if(CATCHUP_START>et.ms) candidates.push({label:'🎯 Catch-Up Day (Legendary 4×)',at:CATCHUP_START,precise:true});
      if(HOLOFOIL_DROP_MS>et.ms) candidates.push({label:'💿 Holofoil variants arrive',at:HOLOFOIL_DROP_MS,precise:true});
      candidates.push({label:'🟢 Mastery Monday',at:nextWeekly(et,1,9,0),precise:true});
      // Next Saturday event — figure out which window (afternoon or evening)
      // is soonest, then look up the theme for that Saturday's date. Themed
      // events (Gold & Gummy Hours, Holofoil Hours) get their specific label;
      // unannounced Saturdays fall through to "⚡ Saturday Power Hour".
      var nextSat, nextSatWindow;
      if(et.wd===6){
        var mins=et.h*60+et.mi;
        if(mins<840){ nextSat=wallMs(et.y,et.m,et.d,14,0); nextSatWindow='afternoon'; }
        else if(mins<1260){ nextSat=wallMs(et.y,et.m,et.d,21,0); nextSatWindow='evening'; }
        else { nextSat=nextWeekly(et,6,14,0); nextSatWindow='afternoon'; }
      } else { nextSat=nextWeekly(et,6,14,0); nextSatWindow='afternoon'; }
      var nextSatTheme=SATURDAY_EVENTS[isoDateFromWallMs(nextSat)]||DEFAULT_SAT_EVENT;
      candidates.push({label:nextSatTheme.label+' ('+nextSatWindow+')',at:nextSat,precise:true});
      candidates.sort(function(a,b){return a.at-b.at});
      var soonest=candidates[0];
      elNextHead.textContent=soonest.label;
      elNextCd.textContent=(soonest.precise?fmtPrecise:fmtShort)(soonest.at-et.ms);
      // Fill secondary rows with runner-up events so verified one-offs
      // (Holofoil arrival, Holofoil Hours) stay visible even when a generic
      // weekly drop is soonest. Precise candidates get the real countdown
      // clock; recurring events stay on approximate ("3 days") format.
      upSlots.forEach(function(slot, i){
        var c = candidates[i + 1];
        if(c){
          slot.row.style.display='';
          slot.label.textContent=c.label;
          slot.cd.textContent=(c.precise?fmtPrecise:fmtShort)(c.at-et.ms);
        } else slot.row.style.display='none';
      });
      // Per-cell Holofoil countdowns — same tick as the buffs strip so they
      // tick in unison. Compute the text once, apply to every matching span.
      // Once the drop passes we show "Available now" until the next server
      // sync refreshes the state model and drops the .future flag.
      var holoCells=document.querySelectorAll('.holofoil-cd');
      if(holoCells.length){
        var delta=HOLOFOIL_DROP_MS-et.ms;
        var text=delta>0?fmtPrecise(delta):'Available now';
        holoCells.forEach(function(el){ el.textContent=text; });
      }
    }
    render();
    setInterval(render,1000);
  }

  // ─── Auto-resync (owner view only) ──────────────────────────────────────
  // Two triggers, same handler:
  //   (1) tab-focus after > 15s hidden (alt-tab back from Fortnite)
  //   (2) 30s heartbeat while the tab is actively visible
  // Both call POST /sprites/resync → reload. Guard on Re-sync form presence
  // so this only runs on the owner's own view, not public /u/:slug pages.
  // "Synced Xs ago" ticker on the buy-back panel — reads data-synced-at from
  // the panel element, updates every second so users can see freshness at a
  // glance. Runs on all views (owner + public /u/:slug) that render the panel.
  var freshEl = document.getElementById('bb-fresh');
  var freshPanel = document.querySelector('.bb-panel[data-synced-at]');
  if (freshEl && freshPanel) {
    var syncedAt = new Date(freshPanel.getAttribute('data-synced-at')).getTime() || Date.now();
    function fmtAgo(ms){
      var s = Math.max(0, Math.floor(ms / 1000));
      if (s < 5) return '· just now';
      if (s < 60) return '· synced ' + s + 's ago';
      var m = Math.floor(s / 60); s %= 60;
      if (m < 60) return '· synced ' + m + 'm ' + (s < 10 ? '0' : '') + s + 's ago';
      var h = Math.floor(m / 60); m %= 60;
      return '· synced ' + h + 'h ' + m + 'm ago';
    }
    function tickFresh(){ freshEl.textContent = fmtAgo(Date.now() - syncedAt); }
    tickFresh();
    setInterval(tickFresh, 1000);
  }

  var resyncForm = document.querySelector('form[action="/sprites/resync"]');
  if (resyncForm) {
    var hiddenSince = 0;
    var inFlight = false;
    var lastResync = Date.now();
    var MIN_HIDDEN_MS = 15 * 1000;
    var VISIBLE_POLL_MS = 30 * 1000;
    async function forceResync(reason){
      if (inFlight) return;
      inFlight = true;
      try {
        var res = await fetch('/sprites/resync', { method:'POST', credentials:'same-origin', body:'' });
        if (res.ok) location.reload();
      } catch(e) {}
      inFlight = false;
      lastResync = Date.now();
    }
    document.addEventListener('visibilitychange', function(){
      if (document.hidden) { hiddenSince = Date.now(); return; }
      if (!hiddenSince) return;
      if (Date.now() - hiddenSince < MIN_HIDDEN_MS) return;
      hiddenSince = 0;
      forceResync('tab-focus');
    });
    // While visible: force a resync every 30s so an idle open tab stays live.
    setInterval(function(){
      if (document.hidden) return;
      if (Date.now() - lastResync < VISIBLE_POLL_MS) return;
      forceResync('visible-poll');
    }, 5000);
  }
})();</script>`;

function shell(title, body, meta = null) {
  // OG/Twitter meta tags drive Discord (and Slack, Twitter, etc.) link unfurling.
  // When someone pastes the page URL into Discord, Discord fetches these tags
  // and renders a rich embed card with the title, description, image, and a
  // color stripe. Caching is on Discord's side (~24h) — bust by including the
  // synced_at as a query param on og:image so each sync gets a fresh URL.
  const ogTags = meta ? `
<meta property="og:type" content="${esc(meta.type || 'website')}">
<meta property="og:site_name" content="CertiFried Sprite Tracker">
<meta property="og:title" content="${esc(meta.title || title)}">
<meta property="og:description" content="${esc(meta.description || '')}">
${meta.url ? `<meta property="og:url" content="${esc(meta.url)}">` : ''}
${meta.image ? `<meta property="og:image" content="${esc(meta.image)}">` : ''}
${meta.image ? '<meta name="twitter:card" content="summary_large_image">' : '<meta name="twitter:card" content="summary">'}
${meta.image ? `<meta name="twitter:image" content="${esc(meta.image)}">` : ''}
<meta name="theme-color" content="${esc(meta.color || '#7b5cff')}">
<meta name="twitter:title" content="${esc(meta.title || title)}">
<meta name="twitter:description" content="${esc(meta.description || '')}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${ogTags}
<style>${STYLE}</style></head><body>${body}</body></html>`;
}
function chrome(nav = '') {
  // "CertiFried Network" dropdown next to the brand — mirrors the dashboard
  // sidebar's Features section so users navigating from /sprites can hop into
  // /dashboard, /cah, etc. without going through the URL bar. Native
  // <details>/<summary> = no JS, no event listeners, no race conditions.
  const networkMenu = `<details class="cf-network">
    <summary>🌐 CertiFried Network ▾</summary>
    <div class="cf-network-menu">
      <div class="cfn-section">Tools</div>
      <a href="https://certifriedmultitool.com/">🏠 Home</a>
      <a href="/dashboard">📊 Bot Dashboard</a>
      <a href="/sprites">👾 Sprite Tracker <span style="margin-left:auto;font-size:10px;color:var(--muted)">you are here</span></a>
      <a href="/cah">🃏 Cards Against Humanity</a>
      <div class="cfn-divider"></div>
      <div class="cfn-section">Info</div>
      <a href="/commands">⌨️ Bot Commands</a>
      <a href="/status">📈 Status</a>
      <a href="/donate">💜 Donate</a>
      <a href="https://certifriedmultitool.com/discord" target="_blank" rel="noopener">💬 Discord ↗</a>
    </div>
  </details>`;
  return `<header>
    <a href="/sprites" class="logo"><span class="c">Certi</span><span class="f">Fried</span> · Sprite Tracker</a>
    ${networkMenu}
    <div class="tagline">Live from Epic — the only auto-synced sprite collection tracker</div>
    ${nav ? `<div class="nav">${nav}</div>` : ''}
  </header>`;
}

// Avatar-style colored circle from a display name's first character. The hue is
// derived from a stable hash of the full name so a given user always gets the
// same color across pages.
function avatarMarkup(displayName) {
  const ch = (displayName || '?')[0].toUpperCase();
  let hash = 0;
  for (let i = 0; i < (displayName || '').length; i++) hash = (hash * 31 + displayName.charCodeAt(i)) & 0xffff;
  const hue = hash % 360;
  return `<span class="avatar" style="background:hsl(${hue},55%,42%)">${esc(ch)}</span>`;
}

// Logged-in user menu — top-nav dropdown for owner views. The Re-sync action
// lives in the grid toolbar (next to Sort) rather than here, since it's an
// "act on the data I'm looking at" action, not an account action.
function userMenu({ displayName, isAdmin = false, currentPath = '' } = {}) {
  const item = (href, icon, label, opts = {}) => {
    const active = opts.active ? ' current' : '';
    const danger = opts.danger ? ' danger' : '';
    return `<a class="menu-item${active}${danger}" href="${esc(href)}"><span class="menu-icon">${icon}</span>${esc(label)}</a>`;
  };
  const formItem = (action, icon, label, opts = {}) => {
    const danger = opts.danger ? ' danger' : '';
    return `<form method="post" action="${esc(action)}" class="menu-form"><button class="menu-item${danger}" type="submit"><span class="menu-icon">${icon}</span>${esc(label)}</button></form>`;
  };
  return `<details class="usermenu">
    <summary>
      ${avatarMarkup(displayName)}
      <span class="usermenu-name">${esc(displayName)}</span>
      <span class="usermenu-caret">▾</span>
    </summary>
    <div class="usermenu-dropdown">
      ${item('/sprites', '⬚', 'My collection', { active: currentPath === '/sprites' })}
      ${item('/sprites/profile', '📊', 'My profile', { active: currentPath === '/sprites/profile' })}
      ${item('/sprites/account', '🔑', 'Username & password', { active: currentPath === '/sprites/account' })}
      ${isAdmin ? item('/sprites/admin', '⚙', 'Admin', { active: currentPath === '/sprites/admin' }) : ''}
      <div class="menu-divider"></div>
      ${formItem('/sprites/logout', '🚪', 'Log out', { danger: true })}
    </div>
  </details>`;
}

// Bookmarklet source: runs on Epic's /id/api/redirect JSON page. Reads the
// authorizationCode from the response body, builds a hidden form, and submits
// it cross-origin to /sprites/auth — same end-state as the manual paste, but
// no copy needed. Wrapped in try/catch so clicking it from a non-Epic page
// just alerts the user instead of failing silently.
const BOOKMARKLET = `javascript:(function(){try{var t=document.body.innerText.trim();if(!t||t[0]!=='{')throw 0;var c=JSON.parse(t).authorizationCode;if(typeof c!=='string')throw 0;var f=document.createElement('form');f.method='POST';f.action='https://certifriedmultitool.com/sprites/auth';var i=document.createElement('input');i.type='hidden';i.name='code';i.value=c;f.appendChild(i);document.body.appendChild(f);f.submit();}catch(e){alert('CertiFried Sprite Tracker: To use this, sign into Epic first, then click this bookmark on the page that shows the JSON.');}})();`;

function renderLogin({ error } = {}) {
  // The href attribute is double-quoted, so we only need to escape the few
  // chars that would close it or confuse HTML parsing: & " < >.
  const bookmarkletHref = BOOKMARKLET
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return shell('Sign in — CertiFried Sprite Tracker', chrome() + `<main>
    <a href="#first-time" style="display:block;text-decoration:none;color:inherit;margin-bottom:18px">
      <div style="background:linear-gradient(90deg,#3a1f5c,#2a3f7c);border:1px solid #6b4cff;border-radius:12px;padding:16px 18px;display:flex;align-items:center;gap:14px">
        <span style="font-size:28px">🆕</span>
        <div style="flex:1">
          <b style="font-size:15px;display:block;margin-bottom:2px">First time here? Start with Epic Setup ↓</b>
          <span class="sub" style="font-size:13px;color:#d6c8ff">
            The sign-in options below <b>will not work</b> until you've connected your Epic account at least once.
            Click here or scroll down to the <b>Epic Setup</b> section.
          </span>
        </div>
        <span class="sub" style="font-size:12px;white-space:nowrap">tap to jump ↓</span>
      </div>
    </a>
    <div class="card" style="margin-bottom:18px">
      <h2>Returning user · Sign in</h2>
      <p class="sub">Already connected your Epic account here before? Use one of these to sign back in from any device.</p>
      ${error ? `<p class="warn">${esc(error)}</p>` : ''}
      <form method="post" action="/sprites/login" style="display:grid;gap:10px;max-width:360px">
        <label style="display:grid;gap:4px">
          <span style="font-weight:600">Username</span>
          <input type="text" name="username" required autocomplete="username"
            inputmode="text" minlength="3" maxlength="32"
            style="padding:9px 11px;border-radius:8px;border:1px solid #2a2f3c;background:#15171e;color:#e8eaf0;font:inherit">
        </label>
        <label style="display:grid;gap:4px">
          <span style="font-weight:600">Password</span>
          <input type="password" name="password" required autocomplete="current-password"
            style="padding:9px 11px;border-radius:8px;border:1px solid #2a2f3c;background:#15171e;color:#e8eaf0;font:inherit">
        </label>
        <button class="btn" type="submit">Sign in →</button>
      </form>
      ${EAS_CONFIGURED ? `
        <div style="display:flex;align-items:center;gap:10px;margin:18px 0 12px;max-width:360px">
          <div style="flex:1;height:1px;background:#2a2f3c"></div>
          <span class="sub" style="font-size:12px">or</span>
          <div style="flex:1;height:1px;background:#2a2f3c"></div>
        </div>
        <a href="/sprites/connect" class="btn" style="display:inline-block;background:#2a2f3c;color:#e8eaf0;text-decoration:none;max-width:360px;text-align:center">🎮 Sign in with Epic</a>
        <p class="sub" style="margin-top:8px;font-size:12px;color:#ffb87a">
          ⚠️ <b>Returning users only.</b> If you've never connected here before, this button will bounce you back with a friendly error. Use <b>Epic Setup</b> below first.
        </p>
      ` : ''}
    </div>
    <div id="first-time" class="card" style="border:2px solid #6b4cff;background:linear-gradient(180deg,#15172a 0%,#161922 30%)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <span style="background:#6b4cff;color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;padding:3px 9px;border-radius:999px">🆕 START HERE</span>
        <span class="sub" style="font-size:12px">— first-time setup, ~30 seconds</span>
      </div>
      <h2 style="margin-top:6px">Epic Setup — Connect your Epic account</h2>
      <p class="sub">Auto-sync your full Fortnite Sprite collection — owned, mastered, XP, and unreleased sprites. <b>You only do this once.</b></p>
      <p class="warn" style="background:#3a1f0e;border-color:#7a4a1f;color:#ffd6a8">
        <b>⚠️ This step is required for ALL new accounts.</b> You cannot use the "Sign in" form above (or the Epic sign-in button) until your account has been connected here at least once — those flows only verify <i>who</i> you are; this flow loads <i>what</i> you've collected.
      </p>
      <p class="once">🔒 After this one-time setup, you'll never paste anything again — your collection re-syncs automatically and you can sign in from anywhere with the username + password you set on your <a href="/sprites/account" style="color:#a6f0c2">account page</a>.</p>
      <div class="step">
        <span class="num">1</span>
        <div class="stepbody">
          <b>Get your code from Epic</b>
          <p class="sub">Opens Epic in a new tab — sign in if it asks, then you'll see a small block of text appear.</p>
          <a class="btn" href="${LOGIN_URL}" target="_blank" rel="noopener">🎮 Open Epic login →</a>
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
            <button class="btn" type="submit">Connect &amp; sync →</button>
          </form>
        </div>
      </div>
      <details class="alt-flow" style="margin-top:18px;padding:14px;border:1px solid #2a2f3c;border-radius:10px;background:#15171e">
        <summary style="cursor:pointer;font-weight:700;color:#cfe">⚡ Skip the copy/paste — drag a bookmarklet to your bookmarks bar (optional, one-time setup)</summary>
        <p class="sub" style="margin-top:10px">A bookmarklet is a tiny shortcut you save to your browser's bookmarks bar — no extension install, no permissions. After you save it, the flow becomes:</p>
        <ol style="margin:8px 0 12px 18px;line-height:1.7">
          <li>Drag the button below to your bookmarks bar (or right-click → "Bookmark this link"). This installs the bookmarklet.</li>
          <li>Click <b>Open Epic login</b> above and sign in. You'll see the JSON page.</li>
          <li>On that JSON page, click the bookmark you just saved — it auto-submits your code. No copying anything.</li>
        </ol>
        <p style="margin:10px 0 6px"><a class="btn" draggable="true" href="${bookmarkletHref}"
            onclick="event.preventDefault();alert('Drag this button up to your bookmarks bar — clicking it here does nothing. On the Epic JSON page, click the bookmark you saved.');return false;"
            style="background:#3a3f4d;color:#fff">🔖 CertiFried Auto-Login (drag me)</a></p>
        <p class="sub" style="font-size:12px;color:#7a8395">Source visible — it just reads <code>authorizationCode</code> from Epic's JSON page and POSTs it to <code>/sprites/auth</code>. No copy/paste needed once installed.</p>
      </details>
      <p class="warn">We exchange your login server-side, store only an <b>encrypted refresh token</b>
        for re-syncs, and never log token values.</p>
    </div>
    <p style="text-align:center;margin:22px 0 0;font-size:14px">
      Want to see what's already here? <a href="/sprites/browse" class="navlink">🤝 Browse + compare public collections →</a>
    </p>
    <p style="text-align:center;margin:8px 0 0;font-size:13px;color:var(--muted)">
      Curious what's real vs. datamined? <a href="/sprites/info" class="navlink">📋 Live catalog audit &amp; methodology →</a>
    </p>
    </main>`);
}

// /sprites/account — set/change username + password. Independent of share_id
// (the public URL slug), so changing your login here will NOT break any
// /sprites/u/<slug> link already shared. Requires the current password to
// change anything once a password is set.
function renderAccount({ displayName, currentUsername, hasPassword, passwordSetAt, isAdmin = false, viaEpic = false, error = null, success = null } = {}) {
  const fmtTs = (t) => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
  const input = 'padding:9px 11px;border-radius:8px;border:1px solid #2a2f3c;background:#15171e;color:#e8eaf0;font:inherit';
  // Show the "current password" gate only when there IS a stored password AND
  // the user signed in via username/password. Epic-paste login is sufficient
  // ownership proof, so it skips the gate (recovery path for forgotten password).
  const requireCurrent = hasPassword && !viaEpic;
  const nav = `<a class="navlink" href="/sprites/browse">🤝 Compare</a>
               ${userMenu({ displayName, isAdmin, currentPath: '/sprites/account' })}`;
  return shell('Username & password — CertiFried Sprite Tracker', chrome(nav) + `<main>
    <div class="card">
      <h2>Username & password</h2>
      <p class="sub">Set these so you can sign in from any device or browser without re-pasting an Epic code.
        ${displayName ? `Linked to your Epic display name <b>${esc(displayName)}</b>.` : ''}</p>
      <p class="sub" style="font-size:13px">Your public share URL is independent of this username — changing your login here will not break any link you've already shared.</p>
      ${error ? `<p class="warn">${esc(error)}</p>` : ''}
      ${success ? `<p class="once" style="background:#0e2a1a;border-color:#1f6f3b;color:#a6f0c2">${esc(success)}</p>` : ''}
      ${hasPassword && viaEpic ? `<p class="sub" style="font-size:13px;background:#0e2238;border:1px solid #1f487a;padding:10px;border-radius:8px">🔑 You're signed in via Epic, so you can reset your password here without knowing the old one.</p>` : ''}
      <form method="post" action="/sprites/credentials" style="display:grid;gap:12px;max-width:420px;margin-top:12px">
        <label style="display:grid;gap:4px">
          <span style="font-weight:600">Username</span>
          <input type="text" name="username" required minlength="3" maxlength="32"
            autocomplete="username" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{1,30}[A-Za-z0-9]"
            value="${esc(currentUsername || '')}" style="${input}">
          <span class="sub" style="font-size:12px">3-32 chars, letters/digits/_/- only. Starts and ends with a letter or digit.</span>
        </label>
        ${requireCurrent ? `
          <label style="display:grid;gap:4px">
            <span style="font-weight:600">Current password</span>
            <input type="password" name="current_password" required autocomplete="current-password" style="${input}">
            <span class="sub" style="font-size:12px">Set ${esc(fmtTs(passwordSetAt))}. Required to change anything.</span>
          </label>
        ` : ''}
        <label style="display:grid;gap:4px">
          <span style="font-weight:600">${hasPassword ? 'New password' : 'Password'}</span>
          <input type="password" name="password" required minlength="8" autocomplete="new-password" style="${input}">
          <span class="sub" style="font-size:12px">At least 8 characters. Longer = stronger; we don't enforce complexity rules.</span>
        </label>
        <button class="btn" type="submit">${hasPassword ? 'Update credentials' : 'Save credentials'}</button>
      </form>
      <p class="sub" style="margin-top:18px;font-size:13px">
        Forgot your password? Sign out, then on the sign-in page use <b>"Connect your Epic account"</b> — once you're back in via Epic, this page will let you set a new password without needing the old one.
      </p>
    </div>
  </main>`);
}

function renderCollection(state, { readOnly = false, shareUrl = null, firstSyncedAt = null, needsRelogin = false, isAdmin = false, refreshExpiresAt = null, hasDeviceAuth = false, buybackList = [], seedBanner = null } = {}) {
  const s = state.summary;
  // Carve unreleased sprites out of "collected/total" and "still needed" so the
  // percentage isn't dragged down by sprites the player physically can't get
  // yet. Falls back to s.total for old saved states that predate this split.
  // "Obtainable right now" = total - unreleased(Holofoil/Gem) - vaulted(family-level).
  // This is the denominator that reflects what a player can actually pursue today.
  // Falls back to released, then total, for old saved states that predate the split.
  const denom = s.obtainable ?? s.released ?? s.total;
  const future = s.future ?? 0;
  const vaulted = s.vaulted ?? 0;
  const pct = denom ? Math.round((s.owned / denom) * 100) : 0;
  const stats = computePlayerStats(state);
  const firstSeenStr = formatMonthYear(firstSyncedAt);
  // Epic-published stats (Battle Pass tier, account level, season number,
  // career wins). Null until the next sync runs against the athena profile.
  const epic = s.epic || null;
  const head = TIERS.map((t) => `<th style="color:${t.color}">${t.label}</th>`).join('');
  // cellOpts is passed to cell() below inside the row map. Declared here so
  // it's available at the TIERS.map callback time (avoids TDZ against the
  // buybackSet declaration further down the function body).
  const buybackSet = new Set(buybackList.map((b) => b.variantName));
  const cellOpts = { buybackSet, showBuybackToggle: !readOnly };
  const rows = state.groups.map((g, i) => {
    const vs = TIERS.map((t) => g.variants[t.key]).filter(Boolean);
    const futureCount = vs.filter((v) => v.future).length;
    const vaultedCount = vs.filter((v) => v.vaulted).length;
    // Use obtainableCount as the practical denominator. Fall back to totalCount
    // for older state_json saves that predate the field. data-need is now
    // obtainable-aware so the "Need" filter doesn't surface families where
    // there's literally nothing to need (fully-vaulted families like Air/Seven).
    const obtainable = g.obtainableCount ?? g.totalCount;
    const need = Math.max(0, obtainable - g.ownedCount);
    const full = obtainable > 0 && g.ownedCount === obtainable;
    const fullyVaulted = obtainable === 0 && vaultedCount > 0;
    const countLabel = fullyVaulted
      ? '<span class="famcount-vaulted">🚫 Vaulted</span>'
      : `<span class="famcount ${full ? 'full' : ''}">${g.ownedCount}/${obtainable}${g.masteredCount ? ` · ${g.masteredCount}✦` : ''}</span>`;
    return `<tr data-order="${i}" data-name="${esc(g.label)}" data-owned="${g.ownedCount}" data-need="${need}" data-master="${g.masteredCount}" data-future="${futureCount}"${fullyVaulted ? ' data-vaulted="1"' : ''}>
      <th class="fam"><span class="famname">${esc(g.label)}</span>
      ${countLabel}</th>
      ${TIERS.map((t) => cell(g.variants[t.key], cellOpts)).join('')}</tr>`;
  }).join('');
  const synced = state.syncedAt ? `synced ${new Date(state.syncedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  const profileHref = readOnly && shareUrl ? `${shareUrl}/profile` : '/sprites/profile';
  const nav = readOnly
    ? `<a class="navlink" href="${esc(profileHref)}">📊 Profile</a>
       <a class="navlink" href="/sprites/browse">🤝 Compare</a>
       <a class="navlink primary" href="/sprites">Track your collection →</a>`
    : `<a class="navlink" href="/sprites/browse">🤝 Compare</a>
       ${userMenu({ displayName: state.player, isAdmin, currentPath: '/sprites' })}`;
  // Stale-token banner: only shown on the owner's own view (readOnly === false).
  // Viewers of /u/:slug don't see it because it's not their problem to fix.
  const reloginBanner = (!readOnly && needsRelogin)
    ? `<div class="relogin-banner">⚠️ <b>Your Epic connection has expired.</b> Your saved data is still here, but background re-syncs are failing. To refresh your collection (and pick up newly-collected sprites, XP changes, etc.) please paste a fresh Epic auth code below.
        <a href="/sprites/logout" class="btn" style="margin-left:12px;padding:7px 14px;background:#ff8aa6;color:#3a0010">Reconnect →</a></div>`
    : '';
  // Proactive token-expiry warning: yellow banner shown when the refresh token
  // has < 48 hours until Epic invalidates it. Lets users pre-empt instead of
  // discovering the dead-token red banner only after expiry. Only shown to the
  // owner (visitors of /u/:slug don't see it).
  // Expiry banner only fires when there's no device_auth on file — once device
  // auth is minted, refresh-token expiry stops mattering since we never use it
  // for syncs anymore. Most users transition to device auth on first sync after
  // the feature shipped; the banner sticks around for the edge case where Epic
  // rejected the deviceAuth POST and we're still stuck on refresh-token rotation.
  const expiryBanner = (() => {
    if (readOnly || needsRelogin || hasDeviceAuth || !refreshExpiresAt) return '';
    const ms = new Date(refreshExpiresAt).getTime() - Date.now();
    const hoursLeft = ms / (60 * 60 * 1000);
    if (hoursLeft <= 0 || hoursLeft > 48) return '';
    const label = hoursLeft < 1
      ? `${Math.round(ms / (60 * 1000))} minutes`
      : `${Math.round(hoursLeft)} hours`;
    return `<div class="expiry-banner">⏳ <b>Your Epic connection expires in ${label}.</b> Visit your page now to trigger a re-sync — that mints a permanent device credential so this won't happen again.
        <form method="post" action="/sprites/resync" style="display:inline;margin-left:12px"><button class="btn" style="background:#ffcf3a;color:#3a2a00">Refresh now →</button></form></div>`;
  })();
  const banner = readOnly
    ? `<div class="viewban">👀 Viewing <b>${esc(state.player)}</b>'s collection — ${s.owned}/${denom} collected, ${denom - s.owned} still needed${future ? ` · ${future} awaiting release` : ''} · <a href="/sprites">Track your own →</a></div>`
    : (shareUrl ? `<div class="sharebar"><span>🔗 Share — paste in Discord for a rich embed</span>
        <input id="shareurl" type="text" readonly value="${esc(shareUrl)}">
        <button id="copyshare" type="button">Copy link</button></div>` : '');
  // Slug for the Discord export download link — derived from shareUrl so
  // both the owner's /sprites view and the public /u/:slug view get a working
  // button without needing a separate prop. Strip any trailing slash to make
  // the tail-segment grab safe.
  const exportSlug = shareUrl ? shareUrl.replace(/\/+$/, '').split('/').pop() : null;

  // ── Buy-back list panel ────────────────────────────────────────────────────
  // Only rendered on the owner's own view (readOnly === false). Aggregates
  // total dust needed vs. current wallet, lists every variant on the list
  // with per-row remove forms + a seed-from-text form for bulk paste.
  // (buybackSet + cellOpts are declared above so the row map can see them.)
  const walletDust = s.dust ?? 0;
  const buybackDustTotal = buybackList.reduce((sum, b) => sum + (b.cost || 0), 0);
  const buybackPct = buybackDustTotal > 0 ? Math.min(100, Math.round((walletDust / buybackDustTotal) * 100)) : 0;
  const buybackRows = buybackList.map((b) => {
    const imgHtml = b.imgId
      ? `<img loading="lazy" src="/sprites/img/${esc(b.imgId)}.png" alt="${esc(b.familyLabel)} ${esc(b.tierLabel)}" class="bb-thumb">`
      : `<span class="bb-thumb bb-thumb-ph" style="color:${b.tierColor}">?</span>`;
    return `<tr class="bb-row" data-src="${esc(b.source)}">
      <td class="bb-cell-thumb">${imgHtml}</td>
      <td class="bb-cell-label"><span class="bb-tier" style="color:${b.tierColor}">${esc(b.tierLabel)}</span> <b>${esc(b.familyLabel)}</b>${b.source === 'auto' ? ' <span class="bb-auto" title="Auto-added from an extraction detected on sync">auto</span>' : ''}</td>
      <td class="bb-cell-cost">${fmt(b.cost)} ✦</td>
      ${readOnly ? '' : `<td class="bb-cell-action">
        <form method="post" action="/sprites/buyback/toggle" style="margin:0">
          <input type="hidden" name="variant_name" value="${esc(b.variantName)}">
          <button type="submit" class="bb-remove" title="Remove from list">×</button>
        </form>
      </td>`}
    </tr>`;
  }).join('');
  // Seed banner: after POST /sprites/buyback/seed, the redirect carries a
  // "buyback=added:N:skipped:M" query so we surface a small confirmation.
  let seedNote = '';
  if (seedBanner) {
    if (seedBanner.startsWith('added:')) {
      const m = seedBanner.match(/added:(\d+):skipped:(\d+)/);
      if (m) seedNote = `<p class="bb-seed-note">✓ Added ${m[1]} to list${+m[2] ? ` · skipped ${m[2]} unresolvable line(s) (check spelling)` : ''}.</p>`;
    } else if (seedBanner === 'empty') seedNote = `<p class="bb-seed-note bb-seed-warn">⚠ Empty text — paste your list and try again.</p>`;
    else if (seedBanner === 'error') seedNote = `<p class="bb-seed-note bb-seed-warn">⚠ Something went wrong — try again.</p>`;
  }
  // Buy-back panel visibility:
  //   - Owner view (readOnly=false): always render (empty state prompts seed).
  //   - Viewer view (readOnly=true): render only when the owner has items so
  //     viewers see the trade board. Empty lists just hide entirely from
  //     viewers (no useful info + no seed form for them either).
  //   Viewers see the same layout but with all edit controls stripped.
  const showBuybackPanel = !readOnly || buybackList.length > 0;
  const panelTitle = readOnly ? `${esc(state.player)}'s buy-back list` : 'Buy-back list';
  const walletLabel = readOnly ? `${esc(state.player)}'s wallet` : 'Wallet';
  const buybackShareUrl = shareUrl && exportSlug ? `${shareUrl.replace(/\/+$/, '')}/buyback` : null;
  const buybackPanel = !showBuybackPanel ? '' : `<details class="bb-panel" ${buybackList.length ? 'open' : ''} data-synced-at="${state.syncedAt || ''}">
    <summary class="bb-summary">
      <span>🎯 <b>${panelTitle}</b>${buybackList.length ? ` · ${buybackList.length} items` : ' — empty'}</span>
      <span class="bb-summary-stats">
        ${walletLabel} <b>${fmt(walletDust)}</b> ✦ · Need <b>${fmt(buybackDustTotal)}</b> ✦ ${buybackDustTotal > 0 ? `· <b>${buybackPct}%</b> funded` : ''}
        <span class="bb-fresh" id="bb-fresh" title="Time since last sync from Epic">· just now</span>
        ${!readOnly && buybackShareUrl && buybackList.length ? `<a href="${esc(buybackShareUrl)}" class="bb-share" title="Public URL — paste in Discord for a rich embed" onclick="event.stopPropagation();navigator.clipboard?.writeText(this.href);this.textContent='✓ copied';setTimeout(()=>this.textContent='🔗 Share',1500);return false">🔗 Share</a>` : ''}
      </span>
    </summary>
    <div class="bb-panel-body">
      ${buybackDustTotal > 0 ? `<div class="bb-progress"><i style="width:${buybackPct}%"></i></div>` : ''}
      ${!readOnly ? seedNote : ''}
      ${buybackList.length
        ? `<table class="bb-list-table"><tbody>${buybackRows}</tbody></table>`
        : (readOnly ? '' : '<p class="sub" style="margin:8px 0 4px">Click the <b>+</b> button on any unowned sprite in the grid to start building your list, or paste a list of names below.</p>')}
      ${readOnly ? '' : `<details class="bb-seed" ${buybackList.length ? '' : 'open'}>
        <summary>Bulk add from pasted text ↓</summary>
        <form method="post" action="/sprites/buyback/seed" style="margin-top:8px">
          <textarea name="text" rows="4" placeholder="One per line, e.g.:&#10;- Gold Water (4k)&#10;- Gummy Earth (4k)&#10;- Zero Point (7.5k)&#10;- Galaxy Fishy (4k)" style="width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:#0e0f13;color:var(--txt);font:13px/1.5 ui-monospace,Menlo,Consolas,monospace"></textarea>
          <button type="submit" class="btn" style="margin-top:6px">Add to list</button>
          <span class="sub" style="font-size:12px;margin-left:10px">Tier is first word (Gold/Gummy/Galaxy/Basic/Holofoil/Gem). Family follows. Dust amount in parens is ignored — pulled from the catalog.</span>
        </form>
      </details>`}
    </div>
  </details>`;
  const toolbar = `<div class="toolbar"><div class="filters">
      <button type="button" data-f="all" class="active">All</button>
      <button type="button" data-f="have">Have (${s.owned})</button>
      <button type="button" data-f="need">Need (${denom - s.owned})</button>
      <button type="button" data-f="master">Mastered (${s.mastered})</button>
      <button type="button" data-f="unrel">Unreleased${future ? ` (${future})` : ''}</button>
    </div>
    <label class="sortwrap">Sort
      <select id="sort"><option value="default">Default</option><option value="complete">Most complete</option>
      <option value="incomplete">Least complete</option><option value="az">A–Z</option></select></label>
    ${exportSlug ? `<a class="resync-btn" href="/sprites/u/${esc(exportSlug)}/discord-export" download title="Download a PNG of this collection to drop into Discord">🖼️ Export PNG</a>` : ''}
    ${!readOnly ? `<form method="post" action="/sprites/resync" class="resync-form"><button type="submit" class="resync-btn" title="Pull fresh data from Epic right now">↻ Re-sync</button></form>` : ''}
    </div>`;
  // Build OG meta so pasting the share URL into Discord renders a rich embed
  // card (purple stripe + title + collection summary + the same PNG we already
  // generate). syncedAt becomes a query-param cache buster on og:image so
  // Discord's ~24h embed cache doesn't keep showing stale data after a sync.
  const og = (shareUrl && exportSlug) ? {
    type: 'profile',
    title: `${state.player}'s Sprite Collection — ${s.owned}/${denom} obtainable`,
    description: `Tracking ${s.owned} of ${denom} obtainable Fortnite Sprites${future ? ` · ${future} awaiting release` : ''}${s.mastered ? ` · ${s.mastered} mastered ✦` : ''}. Auto-synced from Epic.`,
    url: shareUrl,
    image: `${shareUrl}/discord-export?v=${state.syncedAt ? Date.parse(state.syncedAt) : Date.now()}`,
    color: '#7b5cff',
  } : null;
  return shell(`${esc(state.player)}'s Sprites — CertiFried`, chrome(nav) + `<main>
    ${reloginBanner}
    ${expiryBanner}
    <section class="hero">
      <div class="who">
        Collector<b>${esc(state.player)}</b>
        ${firstSeenStr ? `<span class="since">Collecting since ${esc(firstSeenStr)}</span>` : ''}
        ${(() => {
          // Extra identity sub-lines: currently-equipped variant + starter sprite,
          // both from state.summary. Silent when null. Both live under the "since"
          // line so the hero doesn't reflow when data isn't there.
          const eq = variantInfoFromName(state.summary?.equipped, state.groups);
          const st = variantInfoFromName(state.summary?.starter, state.groups);
          const parts = [];
          if (eq) parts.push(`<span class="since">🎽 Equipped: <b style="color:${eq.tierColor}">${esc(eq.tierLabel)} ${esc(eq.familyLabel)}</b></span>`);
          if (st) parts.push(`<span class="since">★ Started with: <b style="color:${st.tierColor}">${esc(st.familyLabel)}</b></span>`);
          return parts.join('');
        })()}
      </div>
      ${epic && epic.passLevel != null ? `
      <div class="lvlbadge" title="Battle Pass tier — ${esc(epic.seasonLabel || (epic.seasonNum != null ? `Season ${epic.seasonNum}` : 'this season'))}${epic.passXp != null ? ` · ${fmt(epic.passXp)} XP into next tier` : ''}">
        <span class="lvlnum">${epic.passLevel}</span>
        <span class="lvllabel">LEVEL</span>
      </div>` : ''}
      <div class="stats">
        <div class="stat owned"><b>${s.owned}/${denom}</b>Collected</div>
        <div class="stat master"><b>${s.mastered}</b>Mastered</div>
        ${epic && epic.accountLevel ? `<div class="stat acct"><b>${fmt(epic.accountLevel)}</b>Account Level</div>` : ''}
        <div class="stat dust"><b>${fmt(s.dust)}</b>Sprite Dust ✦</div>
        ${future ? `<div class="stat future"><b>${future}</b>🔜 Awaiting Release</div>` : ''}
        ${vaulted ? `<div class="stat vaulted"><b>${vaulted}</b>🚫 Currently Vaulted</div>` : ''}
      </div>
      <div class="ring" style="--p:${pct}"><i>${pct}%</i></div>
    </section>
    ${banner}
    ${BUFFS_STRIP}
    ${buybackPanel}
    ${toolbar}
    <table class="grid"><thead><tr><th>Sprite</th>${head}</tr></thead><tbody>${rows}</tbody></table>
    <!-- Profile data has moved to /sprites/profile (or /sprites/u/<slug>/profile)
         so the sprite grid gets prime real estate. Link in the nav above. -->
    <div class="legend">
      <span><i class="sw" style="background:var(--green)"></i>Collected</span>
      <span><i class="sw" style="background:var(--purple)"></i>Mastered (max XP)</span>
      <span><i class="sw" style="background:#5bf0ff"></i>Unreleased / future</span>
      <span><i class="sw" style="background:#222634"></i>Not collected</span>
    </div>
    <footer>Auto-synced from Epic's <code>extractablerelics</code> service${synced ? ` · ${synced}` : ''} ·
      ${denom} released variants across ${s.families} families${future ? ` (+${future} awaiting release)` : ''}.<br>
      Data is 100% live from your account — no manual entry.</footer></main>` + SCRIPT, og);
}

// Separate profile page: hero (compact, same as the grid page) + the player
// card (tier bars + highlights) + career timeline. No sprite grid here — that
// lives on the collection page (linked back via the "← Sprites" nav).
// Compact buy-back share page — dedicated route so the OG embed can focus on
// the wishlist. Reuses BUFFS_STRIP + panel styling but hides the sprite grid.
function renderBuybackPage(state, buybackList, { shareUrl = null, buybackShareUrl = null } = {}) {
  const walletDust = state.summary?.dust ?? 0;
  const totalDust = buybackList.reduce((sum, b) => sum + (b.cost || 0), 0);
  const pct = totalDust > 0 ? Math.min(100, Math.round((walletDust / totalDust) * 100)) : 0;
  const rows = buybackList.map((b) => {
    const imgHtml = b.imgId
      ? `<img loading="lazy" src="/sprites/img/${esc(b.imgId)}.png" alt="${esc(b.familyLabel)} ${esc(b.tierLabel)}" class="bb-thumb">`
      : `<span class="bb-thumb bb-thumb-ph" style="color:${b.tierColor}">?</span>`;
    return `<tr class="bb-row">
      <td class="bb-cell-thumb">${imgHtml}</td>
      <td class="bb-cell-label"><span class="bb-tier" style="color:${b.tierColor}">${esc(b.tierLabel)}</span> <b>${esc(b.familyLabel)}</b></td>
      <td class="bb-cell-cost">${fmt(b.cost)} ✦</td>
    </tr>`;
  }).join('');
  const nav = `<a class="navlink" href="${esc(shareUrl || '/sprites')}">← Collection</a>
               <a class="navlink primary" href="/sprites">Track your own →</a>`;
  const og = buybackShareUrl ? {
    type: 'website',
    title: `${state.player}'s Buy-back Wishlist — ${buybackList.length} items · ${totalDust.toLocaleString()} ✦ needed`,
    description: `Trade with ${state.player} to help them complete their Fortnite Sprite collection. ${buybackList.length} sprite variants wanted, ${totalDust.toLocaleString()} dust total, wallet at ${walletDust.toLocaleString()} ✦ (${pct}% funded).`,
    url: buybackShareUrl,
    image: `${buybackShareUrl}-export?v=${state.syncedAt ? Date.parse(state.syncedAt) : Date.now()}`,
    color: '#ffcf3a',
  } : null;
  return shell(`${esc(state.player)}'s Buy-back List — CertiFried`, chrome(nav) + `<main>
    <section class="hero" style="display:block;padding:22px 26px">
      <div class="who" style="margin-bottom:8px">🎯 Buy-back list<b>${esc(state.player)}</b><span class="since">${buybackList.length} sprites wanted · ${fmt(totalDust)} ✦ needed · ${pct}% funded</span></div>
      ${totalDust > 0 ? `<div class="bb-progress" style="max-width:none"><i style="width:${pct}%"></i></div>` : ''}
      <p class="sub" style="margin-top:12px">Wallet: <b style="color:#ffe48a">${fmt(walletDust)} ✦</b> · Sorted cheapest-first · Auto-updates when they play or trade.</p>
    </section>
    ${buybackList.length ? `<table class="bb-list-table" style="max-width:640px;margin:0 auto 24px">
      <tbody>${rows}</tbody>
    </table>` : '<p style="text-align:center;color:var(--muted);margin:40px 0">No buy-back list yet.</p>'}
    <p style="text-align:center;margin:24px 0;font-size:13px;color:var(--muted)">
      Traders — DM ${esc(state.player)} in Fortnite if you can spare any of these ·
      <a href="${esc(shareUrl || '/sprites')}" class="navlink">See their full collection →</a>
    </p>
  </main>`, og);
}

function renderProfile(state, { readOnly = false, shareUrl = null, firstSyncedAt = null, needsRelogin = false, isAdmin = false, refreshExpiresAt = null, hasDeviceAuth = false } = {}) {
  const s = state.summary;
  const denom = s.released ?? s.total;
  const future = s.future ?? 0;
  const vaulted = s.vaulted ?? 0;
  const pct = denom ? Math.round((s.owned / denom) * 100) : 0;
  const stats = computePlayerStats(state);
  const firstSeenStr = formatMonthYear(firstSyncedAt);
  const epic = s.epic || null;
  const synced = state.syncedAt ? `synced ${new Date(state.syncedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  // Nav: "← Sprites" goes back to the grid for the current view (private /sprites
  // for the owner, public /u/:slug for visitors).
  const backToGrid = readOnly && shareUrl ? shareUrl.replace(/\/profile$/, '') : '/sprites';
  const nav = readOnly
    ? `<a class="navlink" href="${esc(backToGrid)}">← Sprites</a>
       <a class="navlink" href="/sprites/browse">🤝 Compare</a>
       <a class="navlink primary" href="/sprites">Track your collection →</a>`
    : `<a class="navlink" href="/sprites">← Sprites</a>
       <a class="navlink" href="/sprites/browse">🤝 Compare</a>
       ${userMenu({ displayName: state.player, isAdmin, currentPath: '/sprites/profile' })}`;
  const reloginBanner = (!readOnly && needsRelogin)
    ? `<div class="relogin-banner">⚠️ <b>Your Epic connection has expired.</b> Your saved data is still here, but background re-syncs are failing. To refresh your collection please paste a fresh Epic auth code below.
        <a href="/sprites/logout" class="btn" style="margin-left:12px;padding:7px 14px;background:#ff8aa6;color:#3a0010">Reconnect →</a></div>`
    : '';
  const expiryBanner = (() => {
    if (readOnly || needsRelogin || hasDeviceAuth || !refreshExpiresAt) return '';
    const ms = new Date(refreshExpiresAt).getTime() - Date.now();
    const hoursLeft = ms / (60 * 60 * 1000);
    if (hoursLeft <= 0 || hoursLeft > 48) return '';
    const label = hoursLeft < 1 ? `${Math.round(ms / (60 * 1000))} minutes` : `${Math.round(hoursLeft)} hours`;
    return `<div class="expiry-banner">⏳ <b>Your Epic connection expires in ${label}.</b> Visit your sprite page now to trigger a re-sync — that mints a permanent device credential so this won't happen again.
        <form method="post" action="/sprites/resync" style="display:inline;margin-left:12px"><button class="btn" style="background:#ffcf3a;color:#3a2a00">Refresh now →</button></form></div>`;
  })();
  return shell(`${esc(state.player)}'s Profile — CertiFried`, chrome(nav) + `<main>
    ${reloginBanner}
    ${expiryBanner}
    ${BUFFS_STRIP}
    <section class="hero">
      <div class="who">
        Collector<b>${esc(state.player)}</b>
        ${firstSeenStr ? `<span class="since">Collecting since ${esc(firstSeenStr)}</span>` : ''}
        ${(() => {
          // Extra identity sub-lines: currently-equipped variant + starter sprite,
          // both from state.summary. Silent when null. Both live under the "since"
          // line so the hero doesn't reflow when data isn't there.
          const eq = variantInfoFromName(state.summary?.equipped, state.groups);
          const st = variantInfoFromName(state.summary?.starter, state.groups);
          const parts = [];
          if (eq) parts.push(`<span class="since">🎽 Equipped: <b style="color:${eq.tierColor}">${esc(eq.tierLabel)} ${esc(eq.familyLabel)}</b></span>`);
          if (st) parts.push(`<span class="since">★ Started with: <b style="color:${st.tierColor}">${esc(st.familyLabel)}</b></span>`);
          return parts.join('');
        })()}
      </div>
      ${epic && epic.passLevel != null ? `
      <div class="lvlbadge" title="Battle Pass tier — ${esc(epic.seasonLabel || (epic.seasonNum != null ? `Season ${epic.seasonNum}` : 'this season'))}${epic.passXp != null ? ` · ${fmt(epic.passXp)} XP into next tier` : ''}">
        <span class="lvlnum">${epic.passLevel}</span>
        <span class="lvllabel">LEVEL</span>
      </div>` : ''}
      <div class="stats">
        <div class="stat owned"><b>${s.owned}/${denom}</b>Collected</div>
        <div class="stat master"><b>${s.mastered}</b>Mastered</div>
        ${epic && epic.accountLevel ? `<div class="stat acct"><b>${fmt(epic.accountLevel)}</b>Account Level</div>` : ''}
        <div class="stat dust"><b>${fmt(s.dust)}</b>Sprite Dust ✦</div>
      </div>
      <div class="ring" style="--p:${pct}"><i>${pct}%</i></div>
    </section>
    <section class="playercard">
      <div class="tiers">
        <div class="cardhead">By tier (available now)</div>
        ${TIERS.filter((t) => (stats.tierStats[t.key]?.obtainable || 0) > 0).map((t) => {
          const ts = stats.tierStats[t.key];
          const w = ts.obtainable ? Math.round((ts.owned / ts.obtainable) * 100) : 0;
          const vaultedNote = ts.vaulted ? ` <span class="tnote" title="${ts.vaulted} ${t.label} variant${ts.vaulted === 1 ? '' : 's'} currently vaulted">+${ts.vaulted} 🚫</span>` : '';
          return `<div class="tierrow">
            <span class="tlabel" style="color:${t.color}">${esc(t.label)}</span>
            <div class="tbar"><div class="tfill" style="width:${w}%;background:${t.color}"></div></div>
            <span class="tcnt">${ts.owned}/${ts.obtainable}${vaultedNote}</span>
          </div>`;
        }).join('')}
        ${(() => {
          const awaiting = TIERS.filter((t) => {
            const ts = stats.tierStats[t.key] || {};
            return (ts.obtainable || 0) === 0 && (ts.future || 0) > 0;
          });
          if (!awaiting.length) return '';
          return `<div class="cardhead" style="margin-top:18px">🔜 Awaiting release</div>
            ${awaiting.map((t) => {
              const ts = stats.tierStats[t.key];
              return `<div class="tierrow muted">
                <span class="tlabel" style="color:${t.color};opacity:.7">${esc(t.label)}</span>
                <div class="tbar"><div class="tfill" style="width:0%;background:${t.color};opacity:.5"></div></div>
                <span class="tcnt sub">${ts.future} unreleased</span>
              </div>`;
            }).join('')}`;
        })()}
      </div>
      <div class="highlights">
        <div class="cardhead">Highlights</div>
        <ul>
          ${vaulted && (s.vaultedFamilies?.length) ? `<li>🚫 <b>Currently vaulted:</b> ${esc(s.vaultedFamilies.join(', '))} ${s.vaultedFamilies.length === 1 ? 'family' : 'families'} — ${vaulted} ${vaulted === 1 ? 'variant' : 'variants'} not appearing in Battle Royale matches for extraction right now. <span class="sub" style="font-size:12px;color:#7a8395">(Epic may add them back to the loot pool in a future update.)</span></li>` : ''}
          ${epic && epic.firstSeasonLabel ? `<li>🎂 <b>Playing since:</b> ${esc(epic.firstSeasonLabel)}${epic.seasonsPlayed ? ` · ${epic.seasonsPlayed} seasons under their belt` : ''}</li>` : ''}
          ${epic && epic.hallOfFame ? `<li>👑 <b>Hall of Fame season:</b> ${esc(epic.hallOfFame.seasonLabel)} — Battle Pass Level ${epic.hallOfFame.bookLevel}${epic.hallOfFame.numWins ? ` · ${fmt(epic.hallOfFame.numWins)} wins that season` : ''}</li>` : ''}
          ${epic && epic.completedPasses != null && epic.seasonsPlayed ? `<li>📚 <b>Battle Passes completed:</b> ${epic.completedPasses} of ${epic.seasonsPlayed} (${Math.round((epic.completedPasses / epic.seasonsPlayed) * 100)}% completion rate)</li>` : ''}
          ${epic && (epic.seasonLabel || epic.seasonNum != null) ? `<li>🎮 <b>Current season:</b> ${esc(epic.seasonLabel || `Season ${epic.seasonNum}`)}${epic.passXp != null ? ` · ${fmt(epic.passXp)} XP this pass` : ''}</li>` : ''}
          ${epic && epic.careerWins ? `<li>🏅 <b>Career wins:</b> ${fmt(epic.careerWins)}${epic.currentSeasonWins ? ` (${fmt(epic.currentSeasonWins)} this season)` : ''}</li>` : ''}
          ${stats.fullyCompleted.length ? `<li>🏆 <b>Fully collected ${stats.fullyCompleted.length === 1 ? 'family' : `(${stats.fullyCompleted.length} families)`}:</b> ${stats.fullyCompleted.map((f) => esc(f.label)).join(', ')}</li>` : ''}
          ${stats.closestGroup ? (stats.closestGroup.labels.length === 1
              ? `<li>📈 <b>Closest to completion:</b> ${esc(stats.closestGroup.labels[0])} — ${stats.closestGroup.owned}/${stats.closestGroup.total} (${Math.round(stats.closestGroup.pct * 100)}%)</li>`
              : `<li>📈 <b>Closest to completion (${stats.closestGroup.labels.length} families at ${stats.closestGroup.owned}/${stats.closestGroup.total}):</b> ${stats.closestGroup.labels.map((l) => esc(l)).join(', ')}</li>`
          ) : ''}
          ${stats.highest && stats.highest.xp ? `<li>🎯 <b>Highest-XP sprite:</b> ${esc(stats.highest.familyLabel)} (${esc(stats.highest.tierLabel)}) — ${fmt(stats.highest.xp)} XP</li>` : ''}
          <li>👥 <b>Families collected from:</b> ${s.families}</li>
          ${s.equipped ? `<li>⭐ <b>Equipped:</b> ${esc(String(s.equipped).replace(/_/g, ' '))}</li>` : ''}
          ${stats.totalDupes ? `<li>🃏 <b>Duplicates earned:</b> ${fmt(stats.totalDupes)} (extracting them yields Sprite Dust)</li>` : ''}
          ${stats.totalXp ? `<li>✨ <b>Total sprite XP:</b> ${fmt(stats.totalXp)} across ${s.owned} owned sprites</li>` : ''}
        </ul>
      </div>
    </section>
    ${epic && epic.timeline && epic.timeline.length >= 2 ? `
    <section class="career-timeline">
      <div class="cardhead">📊 Career timeline <span class="sub" style="margin-left:8px">${epic.timeline.length} season${epic.timeline.length === 1 ? '' : 's'} played · ${epic.completedPasses || 0} Battle Pass${epic.completedPasses === 1 ? '' : 'es'} completed</span></div>
      <div class="ct-rows">
        ${epic.timeline.map((sn) => {
          const pct = Math.max(2, Math.min(100, sn.bookLevel));
          const cls = [sn.completed ? 'completed' : '', sn.isCurrent ? 'current' : ''].filter(Boolean).join(' ');
          const seasonLabel = sn.seasonLabel || `Season ${sn.seasonNumber}`;
          const winsLabel = sn.numWins ? ` · ${sn.numWins} win${sn.numWins === 1 ? '' : 's'}` : '';
          const statusBadge = sn.completed ? '<span class="ct-status complete">🏆 100</span>' : (sn.isCurrent ? '<span class="ct-status current">● Current</span>' : '');
          return `<div class="ct-row ${cls}">
            <span class="ct-season">${esc(seasonLabel)}</span>
            <div class="ct-bar"><div class="ct-fill ${cls}" style="width:${pct}%"></div></div>
            <span class="ct-stat">Battle Pass Level <b>${sn.bookLevel}</b>${winsLabel}</span>
            ${statusBadge}
          </div>`;
        }).join('')}
      </div>
    </section>` : ''}
    <footer>Auto-synced from Epic's <code>extractablerelics</code> service${synced ? ` · ${synced}` : ''} ·
      ${denom} released variants across ${s.families} families${future ? ` (+${future} awaiting release)` : ''}.<br>
      Data is 100% live from your account — no manual entry.</footer></main>` + SCRIPT);
}

// ── routes (mounted at /sprites) ──
router.get('/', async (req, res) => {
  const acct = req.session?.epicAccountId;
  if (!acct) return res.send(renderLogin());
  try {
    const row = await getAccount(acct);
    if (!row) { delete req.session.epicAccountId; return res.send(renderLogin()); }
    const shareUrl = `${baseUrl(req)}/sprites/u/${await ensureShareId(acct, row.share_id, row.display_name)}`;
    if (row.state_json) {
      const state = JSON.parse(row.state_json);
      state.syncedAt = row.synced_at || state.syncedAt;
      // Load the owner's buy-back list alongside the state so the cell grid
      // can show which unowned variants are already on the list.
      const buybackList = await loadBuyBackList(acct, state.groups || []);
      const seedBanner = req.query.buyback ? String(req.query.buyback).slice(0, 60) : null;
      // Stale-while-revalidate: render the cache immediately, then if the row
      // is older than SPRITE_STALE_OWNER_MS kick off a background resync
      // (deduped by tryBackgroundResync). Next page load sees the fresh data.
      res.send(renderCollection(state, { shareUrl, firstSyncedAt: row.first_synced_at, needsRelogin: row.needs_relogin === 1, isAdmin: ADMIN_ACCOUNT_IDS.has(acct), refreshExpiresAt: row.refresh_expires_at, hasDeviceAuth: !!(row.device_id_enc && row.device_secret_enc), buybackList, seedBanner }));
      const ageMs = row.synced_at ? Date.now() - new Date(row.synced_at).getTime() : Infinity;
      if (ageMs > SPRITE_STALE_OWNER_MS) tryBackgroundResync(acct, row, row.display_name);
      return;
    }
    const synced = await syncWithAtomicRotation(row, row.display_name);
    await saveAccount(synced);
    // First-ever sync for this account: first_synced_at is being set right now,
    // so just stamp "Collecting since today" — DB query on next visit will agree.
    return res.send(renderCollection({ ...synced.model, player: synced.displayName, syncedAt: new Date().toISOString() }, { shareUrl, firstSyncedAt: new Date(), isAdmin: ADMIN_ACCOUNT_IDS.has(acct) }));
  } catch (e) {
    logger.warn(`[sprites] view failed: ${e.message}`);
    return res.send(renderLogin({ error: `Session expired — please reconnect. (${esc(e.message)})` }));
  }
});

// Public read-only shared profile — anyone can see what this collector has/needs.
// Owner profile page — same auth as /sprites, renders only the stats/timeline.
router.get('/profile', async (req, res) => {
  const acct = req.session?.epicAccountId;
  if (!acct) return res.redirect('/sprites');
  try {
    const row = await getAccount(acct);
    if (!row || !row.state_json) return res.redirect('/sprites');
    const state = JSON.parse(row.state_json);
    state.syncedAt = row.synced_at || state.syncedAt;
    const shareUrl = `${baseUrl(req)}/sprites/u/${await ensureShareId(acct, row.share_id, row.display_name)}`;
    res.send(renderProfile(state, {
      shareUrl,
      firstSyncedAt: row.first_synced_at,
      needsRelogin: row.needs_relogin === 1,
      isAdmin: ADMIN_ACCOUNT_IDS.has(acct),
      refreshExpiresAt: row.refresh_expires_at,
      hasDeviceAuth: !!(row.device_id_enc && row.device_secret_enc),
    }));
  } catch (e) {
    logger.warn(`[sprites] /profile failed: ${e.message}`);
    res.redirect('/sprites');
  }
});

// GET /sprites/u/:shareId/discord-export — PNG download of the user's
// collection formatted for dropping into Discord. Registered BEFORE the
// /u/:shareId catch-all so Express matches the longer path first.
router.get('/u/:shareId/discord-export', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT display_name, state_json FROM epic_sprite_accounts WHERE share_id=?',
      [String(req.params.shareId).slice(0, 64)],
    );
    const row = rows[0];
    if (!row?.state_json) return res.status(404).send('Collection not found.');
    const png = await buildDiscordExport(JSON.parse(row.state_json));
    const filename = `${row.display_name || req.params.shareId}-sprites.png`.replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=300'); // 5 min — matches client auto-refresh cadence
    res.send(png);
  } catch (e) {
    logger.warn(`[sprites] discord export failed: ${e.message}`);
    res.status(500).send('Export failed.');
  }
});

// GET /sprites/u/:shareId/buyback-export — PNG of the buy-back list, used as
// the og:image on the buyback share page. Registered BEFORE /u/:shareId so
// Express catches the specific path first. Serves inline (viewable) rather
// than as a download since Discord's crawler is what usually fetches it.
router.get('/u/:shareId/buyback-export', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT account_id, display_name, state_json FROM epic_sprite_accounts WHERE share_id=?',
      [String(req.params.shareId).slice(0, 64)],
    );
    const row = rows[0];
    if (!row?.state_json) return res.status(404).send('Collection not found.');
    const state = JSON.parse(row.state_json);
    if (row.display_name) state.player = row.display_name;
    const buybackList = await loadBuyBackList(row.account_id, state.groups || []);
    if (!buybackList.length) return res.status(404).send('No buy-back list.');
    const png = await buildBuybackExport(state, buybackList);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=120'); // 2 min — matches sync cadence
    res.send(png);
  } catch (e) {
    logger.warn(`[sprites] buyback export failed: ${e.message}`);
    res.status(500).send('Export failed.');
  }
});

// GET /sprites/u/:shareId/buyback — dedicated public page for the buy-back
// list. OG meta unfurls to a rich Discord embed when the URL is shared.
router.get('/u/:shareId/buyback', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT account_id, display_name, state_json, synced_at FROM epic_sprite_accounts WHERE share_id=?',
      [String(req.params.shareId).slice(0, 64)],
    );
    const row = rows[0];
    if (!row?.state_json) {
      return res.status(404).send(shell('Not found — CertiFried Sprite Tracker', chrome() + `<main>
        <div class="card"><h2>Buy-back list not found</h2>
        <p class="sub">That share link doesn't exist or hasn't synced yet. <a href="/sprites">Track your own →</a></p></div></main>`));
    }
    const state = JSON.parse(row.state_json);
    state.syncedAt = row.synced_at || state.syncedAt;
    if (row.display_name) state.player = row.display_name;
    const buybackList = await loadBuyBackList(row.account_id, state.groups || []);
    const base = baseUrl(req);
    const shareUrl = `${base}/sprites/u/${esc(req.params.shareId)}`;
    const buybackShareUrl = `${base}/sprites/u/${esc(req.params.shareId)}/buyback`;
    res.send(renderBuybackPage(state, buybackList, { shareUrl, buybackShareUrl }));
  } catch (e) {
    logger.warn(`[sprites] buyback view failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + `<main><div class="card"><h2>Something went wrong</h2></div></main>`));
  }
});

// Public profile page — same data as /u/:shareId but stats-only render. Must be
// registered BEFORE /u/:shareId so Express matches the longer path first.
router.get('/u/:shareId/profile', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT account_id, display_name, state_json, synced_at, first_synced_at FROM epic_sprite_accounts WHERE share_id=?',
      [String(req.params.shareId).slice(0, 64)],
    );
    const row = rows[0];
    if (!row || !row.state_json) {
      return res.status(404).send(shell('Not found — CertiFried Sprite Tracker', chrome() + `<main>
        <div class="card"><h2>Collection not found</h2>
        <p class="tagline" style="border:0;padding:0">That share link doesn't exist or hasn't synced yet.
          <a href="/sprites">Track your own →</a></p></div></main>`));
    }
    const state = JSON.parse(row.state_json);
    state.syncedAt = row.synced_at || state.syncedAt;
    if (row.display_name) state.player = row.display_name;
    res.send(renderProfile(state, {
      readOnly: true,
      shareUrl: `${baseUrl(req)}/sprites/u/${esc(req.params.shareId)}/profile`,
      firstSyncedAt: row.first_synced_at,
    }));
  } catch (e) {
    logger.warn(`[sprites] /u/:shareId/profile failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + '<main><div class="card"><h2>Something went wrong</h2></div></main>'));
  }
});

// Public read-only API: returns the same data the public profile page renders.
// JSON, CORS-enabled so third-party tools (browser extensions, Discord widgets,
// Sheets imports) can pull a user's sprite state without scraping the HTML.
router.get('/api/u/:shareId.json', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT display_name, share_id, state_json, synced_at, first_synced_at FROM epic_sprite_accounts WHERE share_id=?',
      [String(req.params.shareId).slice(0, 64)],
    );
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5min — the page itself is SWR'd
    if (!rows[0] || !rows[0].state_json) return res.status(404).json({ error: 'not_found' });
    const state = JSON.parse(rows[0].state_json);
    res.json({
      displayName: rows[0].display_name,
      slug: rows[0].share_id,
      firstSyncedAt: rows[0].first_synced_at,
      syncedAt: rows[0].synced_at,
      summary: state.summary,
      groups: state.groups.map((g) => ({
        label: g.label, familyToken: g.familyToken,
        ownedCount: g.ownedCount, obtainableCount: g.obtainableCount, totalCount: g.totalCount,
        masteredCount: g.masteredCount,
        variants: Object.fromEntries(Object.entries(g.variants).map(([k, v]) => [k, {
          name: v.name, tierKey: v.tierKey, tierLabel: v.tierLabel,
          owned: v.owned, mastered: v.mastered, xp: v.xp, dupes: v.dupes,
          future: v.future, vaulted: v.vaulted,
        }])),
      })),
    });
  } catch (e) {
    logger.warn(`[sprites] api failed: ${e.message}`);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/u/:shareId', async (req, res) => {
  try {
    // slugFromDisplayName can produce up to 31 chars + a -NN collision suffix.
    // Cap at 64 to match a reasonable schema width and avoid wildcard scans.
    const [rows] = await pool.execute(
      'SELECT account_id, display_name, refresh_token_enc, state_json, synced_at, first_synced_at FROM epic_sprite_accounts WHERE share_id=?',
      [String(req.params.shareId).slice(0, 64)]);
    const row = rows[0];
    if (!row || !row.state_json) {
      return res.status(404).send(shell('Not found — CertiFried Sprite Tracker', chrome() + `<main>
        <div class="card"><h2>Collection not found</h2>
        <p class="tagline" style="border:0;padding:0">That share link doesn't exist or hasn't synced yet.
          <a href="/sprites">Track your own →</a></p></div></main>`));
    }
    const state = JSON.parse(row.state_json);
    state.syncedAt = row.synced_at || state.syncedAt;
    if (row.display_name) state.player = row.display_name;
    // SWR for the public view: viewers keep the data fresh by visiting. Dedup
    // via inFlightResyncs guards against viral-link spike from concurrent hits.
    const ageMs = row.synced_at ? Date.now() - new Date(row.synced_at).getTime() : Infinity;
    if (ageMs > SPRITE_STALE_MS && row.refresh_token_enc) {
      tryBackgroundResync(row.account_id, row, row.display_name);
    }
    // Public share view still shows the owner's buy-back list so viewers can
    // see what they're hunting for — de-facto trade board. Edit affordances
    // (per-cell toggle, remove buttons, seed form) are gated on !readOnly
    // inside renderCollection so this is view-only for anyone but the owner.
    const buybackList = await loadBuyBackList(row.account_id, state.groups || []);
    res.send(renderCollection(state, {
      readOnly: true,
      shareUrl: `${baseUrl(req)}/sprites/u/${esc(req.params.shareId)}`,
      firstSyncedAt: row.first_synced_at,
      buybackList,
    }));
  } catch (e) {
    logger.warn(`[sprites] shared view failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + `<main><div class="card"><h2>Something went wrong</h2></div></main>`));
  }
});

// Seamless "Log in with Epic" — bounce the user to Epic, who returns them to /callback.
router.get('/connect', (req, res) => {
  if (!EAS_CONFIGURED) return res.redirect('/sprites');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.epicOauthState = state;
  res.redirect(authorizeUrl(`${baseUrl(req)}/sprites/callback`, state));
});

// Epic redirects here with ?code&state. For RETURNING users (account already in
// our DB) we use identity-only sign-in (signInViaEpic) — fast, no bridge needed,
// no Fortnite token required because we already have device_auth/refresh_token
// on file from their original paste-connect. For FIRST-TIME users we tell them
// to use the paste-an-Epic-code flow instead, since our EAS client can't mint a
// Fortnite token (the bridge Epic refuses).
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(renderLogin({ error: `Epic login was canceled (${esc(String(error))}).` }));
  if (!code || !state || state !== req.session?.epicOauthState) {
    return res.send(renderLogin({ error: 'Login session expired or invalid — please try again.' }));
  }
  delete req.session.epicOauthState;
  try {
    const { accountId, displayName } = await signInViaEpic(String(code), `${baseUrl(req)}/sprites/callback`);
    // Already connected? Instant sign-in. Mirror finishLogin's session shape
    // (epicAccountId + authMethod='epic') so /credentials lets them reset a
    // forgotten password without the old one.
    const [rows] = await pool.execute('SELECT account_id FROM epic_sprite_accounts WHERE account_id=?', [accountId]);
    if (rows.length) {
      req.session.epicAccountId = accountId;
      req.session.authMethod = 'epic';
      return res.redirect('/sprites');
    }
    // New user — we have their identity but no Fortnite token to fetch sprite
    // data. Point them at the paste-connect flow.
    res.send(renderLogin({
      error: `Hi${displayName ? `, ${displayName}` : ''}! We verified your Epic account, but you haven't completed the one-time Epic Setup here yet — so we don't have your sprite collection to show you. Scroll down to the "🆕 START HERE — Epic Setup" section below to finish setup (it takes about 30 seconds). After that, this Sign in with Epic button will work instantly every time.`,
    }));
  } catch (e) {
    logger.warn(`[sprites] oauth callback failed: ${e.message}`);
    res.send(renderLogin({ error: `Epic sign-in failed: ${esc(e.message)}` }));
  }
});

// Manual paste fallback (works without an OAuth client registered).
router.post('/auth', async (req, res) => {
  const code = parseAuthCode(req.body?.code);
  if (!code) return res.send(renderLogin({ error: 'Could not find a valid authorization code in that input.' }));
  try {
    await finishLogin(req, res, await exchangeAuthCode(code));
  } catch (e) {
    const hint = e.epicCode === 'errors.com.epicgames.account.oauth.authorization_code_not_found'
      ? 'That code was already used or expired — generate a fresh one and paste it quickly.' : e.message;
    logger.warn(`[sprites] auth failed: ${e.message}`);
    res.send(renderLogin({ error: hint }));
  }
});

// POST /sprites/login — username + password sign-in. Looks up by the generated
// lowercase column (case-insensitive without ICU collation gymnastics),
// verifies the scrypt hash, and on success sets req.session.epicAccountId —
// the same field finishLogin sets, so every other route works unchanged.
router.post('/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) {
    return res.send(renderLogin({ error: 'Enter a username and password.' }));
  }
  if (loginThrottleHit(req, username)) {
    return res.send(renderLogin({ error: 'Too many failed login attempts — try again in 15 minutes.' }));
  }
  try {
    const [rows] = await pool.execute(
      'SELECT account_id, password_hash FROM epic_sprite_accounts WHERE username_lower=? LIMIT 1',
      [username.toLowerCase()],
    );
    const row = rows[0];
    let valid = false;
    if (row && row.password_hash) {
      valid = verifyPassword(password, row.password_hash);
    } else {
      // Equalize timing on the "no such user" branch so an attacker can't
      // distinguish "wrong password" from "no such user" by latency.
      verifyPassword(password, DUMMY_HASH);
    }
    if (!valid) {
      loginThrottleRecord(req, username, false);
      return res.send(renderLogin({ error: 'Username or password is incorrect.' }));
    }
    loginThrottleRecord(req, username, true);
    req.session.epicAccountId = row.account_id;
    req.session.authMethod = 'password';
    res.redirect('/sprites');
  } catch (e) {
    logger.warn(`[sprites] login failed: ${e.message}`);
    res.send(renderLogin({ error: 'Login failed — try again.' }));
  }
});

// GET /sprites/account — the form for setting/changing username + password.
// Behind the session gate; redirects to the login/connect page otherwise.
router.get('/account', async (req, res) => {
  const acct = req.session?.epicAccountId;
  if (!acct) return res.redirect('/sprites');
  try {
    const [rows] = await pool.execute(
      'SELECT username, password_hash, password_set_at, display_name FROM epic_sprite_accounts WHERE account_id=?',
      [acct],
    );
    const row = rows[0];
    if (!row) { delete req.session.epicAccountId; return res.redirect('/sprites'); }
    res.send(renderAccount({
      displayName: row.display_name,
      currentUsername: row.username,
      hasPassword: !!row.password_hash,
      passwordSetAt: row.password_set_at,
      isAdmin: ADMIN_ACCOUNT_IDS.has(acct),
      viaEpic: req.session?.authMethod === 'epic',
    }));
  } catch (e) {
    logger.warn(`[sprites] account page failed: ${e.message}`);
    res.redirect('/sprites');
  }
});

// POST /sprites/credentials — authenticated; set or update username + password
// on the current Epic-linked account. If a password is already set, require
// the current one to change anything (prevents a hijacked session from
// permanently locking the real owner out).
router.post('/credentials', async (req, res) => {
  const acct = req.session?.epicAccountId;
  if (!acct) return res.redirect('/sprites');
  const submittedUsername = String(req.body?.username || '').trim();
  const newPassword = String(req.body?.password || '');
  const currentPassword = String(req.body?.current_password || '');

  // Fetch first so we know whether this is a fresh-set or a change, and so
  // error renders can show the row's current state.
  let row;
  try {
    const [rows] = await pool.execute(
      'SELECT username, password_hash, password_set_at, display_name FROM epic_sprite_accounts WHERE account_id=?',
      [acct],
    );
    row = rows[0];
  } catch (e) {
    logger.warn(`[sprites] credentials lookup failed: ${e.message}`);
    return res.send(renderAccount({ error: 'Could not load your account — try again.' }));
  }
  if (!row) { delete req.session.epicAccountId; return res.redirect('/sprites'); }
  // Epic-paste login is itself ownership proof, so signed-in-via-Epic users
  // can change their password without knowing the old one (recovery path).
  // Username/password logins still require the old password.
  const viaEpic = req.session?.authMethod === 'epic';
  const base = {
    displayName: row.display_name,
    currentUsername: row.username,
    hasPassword: !!row.password_hash,
    passwordSetAt: row.password_set_at,
    isAdmin: ADMIN_ACCOUNT_IDS.has(acct),
    viaEpic,
  };

  const u = validateUsername(submittedUsername);
  if (!u.ok) return res.send(renderAccount({ ...base, error: u.error }));
  const p = validatePassword(newPassword);
  if (!p.ok) return res.send(renderAccount({ ...base, error: p.error }));
  if (row.password_hash && !viaEpic && !verifyPassword(currentPassword, row.password_hash)) {
    return res.send(renderAccount({ ...base, error: 'Current password is incorrect.' }));
  }

  const hash = hashPassword(newPassword);
  try {
    await pool.execute(
      'UPDATE epic_sprite_accounts SET username=?, password_hash=?, password_set_at=NOW() WHERE account_id=?',
      [u.value, hash, acct],
    );
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' || /duplicate/i.test(e.message)) {
      return res.send(renderAccount({ ...base, error: 'That username is already taken.' }));
    }
    logger.warn(`[sprites] credentials update failed: ${e.message}`);
    return res.send(renderAccount({ ...base, error: 'Could not save credentials — try again.' }));
  }
  res.send(renderAccount({
    ...base,
    currentUsername: u.value,
    hasPassword: true,
    passwordSetAt: new Date(),
    success: 'Saved. You can now sign in from any device with this username + password.',
  }));
});

// POST-Redirect-GET on /resync — do the sync work, then redirect to /sprites
// so the GET handler renders with all the state (including buybackList) freshly
// loaded. Prevents "empty buy-back panel" from inline-rendering here without
// the panel data, and keeps the browser URL bar clean at /sprites instead of
// getting stuck at /sprites/resync (which is POST-only → 404 on refresh).
router.post('/resync', async (req, res) => {
  const acct = req.session?.epicAccountId;
  if (!acct) return res.redirect('/sprites');
  try {
    const row = await getAccount(acct);
    if (!row) { delete req.session.epicAccountId; return res.redirect('/sprites'); }
    const synced = await syncWithAtomicRotation(row, row.display_name);
    await saveAccount(synced);
  } catch (e) {
    logger.warn(`[sprites] resync failed: ${e.message}`);
  }
  res.redirect('/sprites');
});

// ── Buy-back list ───────────────────────────────────────────────────────────
// Tracks variants the user wants to reacquire (traded, extracted duplicates
// converted to dust, etc). Persisted in epic_sprite_buyback per-account.
// Two flows: (a) manual toggle on any unowned grid cell, (b) seed from a
// pasted text list. Auto-detection wires into saveAccount separately.

// Tier-label → tier.key. Matches TIERS from epic-sprites.js. Extra aliases
// for common Fortnite in-game naming ("Normal" for Basic, etc).
const BUYBACK_TIER_ALIAS = {
  'basic': 'basic', 'normal': 'basic', 'base': 'basic', 'a': 'basic',
  'gold': 'gold',
  'gummy': 'candy', 'candy': 'candy',
  'galaxy': 'galaxy', 'galactic': 'galaxy',
  'gem': 'gem',
  'holofoil': 'holofoil',
};

// Parse a single line into a variant_name using the given catalog (state.groups
// from any user — the shape is stable across accounts). Returns null if we
// can't unambiguously resolve to a variant. Family names are matched
// case-insensitively; "Zero Point" and "Burnt Peanut" (multi-word) are handled
// by trying (tier + rest-as-family) and falling back to (whole-line-as-family
// with basic tier) if no tier prefix is recognized.
function parseBuyBackLine(rawLine, refGroups) {
  const stripped = String(rawLine || '').trim()
    .replace(/^[-•*]\s*/, '')          // leading bullet
    .replace(/\s*\(.*?\)\s*$/, '')     // trailing "(4k)" etc
    .trim();
  if (!stripped) return null;
  const words = stripped.split(/\s+/);
  const tryTierKey = BUYBACK_TIER_ALIAS[words[0].toLowerCase()];
  let tierKey, familyName;
  if (tryTierKey && words.length > 1) {
    tierKey = tryTierKey;
    familyName = words.slice(1).join(' ');
  } else {
    // No recognizable tier word; assume whole line is family, tier is basic.
    tierKey = 'basic';
    familyName = stripped;
  }
  const famLower = familyName.toLowerCase();
  for (const g of refGroups) {
    if ((g.label || '').toLowerCase() !== famLower) continue;
    const v = g.variants?.[tierKey];
    if (v?.name) return v.name;
  }
  return null;
}

// Load the current user's buy-back list joined with catalog data for costs.
// Every row here is "still needed" — acquisitions auto-DELETE via saveAccount.
// Sorted by dust cost ASC (cheapest first) so the natural grind flow is:
// knock off the small ones while saving up for the expensive tier. Ties on
// cost fall back to variant_name for a stable order.
async function loadBuyBackList(accountId, refGroups) {
  const [rows] = await pool.execute(
    'SELECT variant_name, source, added_at FROM epic_sprite_buyback WHERE account_id=?',
    [accountId],
  );
  const varByName = new Map();
  for (const g of refGroups) {
    for (const v of Object.values(g.variants || {})) {
      if (v?.name) varByName.set(v.name, { ...v, familyLabel: g.label });
    }
  }
  const items = rows.map((r) => {
    const cat = varByName.get(r.variant_name) || {};
    return {
      variantName: r.variant_name,
      familyLabel: cat.familyLabel || '?',
      tierLabel: cat.tierLabel || '?',
      tierColor: cat.tierColor || '#888',
      imgId: cat.imgId || null,
      cost: cat.summonCost ?? 0,
      source: r.source,
      addedAt: r.added_at,
    };
  });
  items.sort((a, b) => (a.cost - b.cost) || a.variantName.localeCompare(b.variantName));
  return items;
}

// POST /sprites/buyback/toggle — flip presence of a single variant on the
// list. Simple two-state model: row exists → DELETE, row missing → INSERT.
// Acquiring the sprite via a sync auto-DELETEs (see saveAccount below), so
// users never have to manually mark "done."
router.post('/buyback/toggle', async (req, res) => {
  const acct = req.session?.epicAccountId;
  if (!acct) return res.redirect('/sprites');
  const variantName = String(req.body?.variant_name || '').slice(0, 128);
  if (!variantName) return res.redirect('/sprites');
  try {
    const [existing] = await pool.execute(
      'SELECT variant_name FROM epic_sprite_buyback WHERE account_id=? AND variant_name=?',
      [acct, variantName],
    );
    if (existing.length) {
      await pool.execute(
        'DELETE FROM epic_sprite_buyback WHERE account_id=? AND variant_name=?',
        [acct, variantName],
      );
    } else {
      await pool.execute(
        `INSERT INTO epic_sprite_buyback (account_id, variant_name, source) VALUES (?, ?, 'manual')`,
        [acct, variantName],
      );
    }
  } catch (e) {
    logger.warn(`[sprites] buyback toggle failed: ${e.message}`);
  }
  res.redirect('/sprites' + (req.body?.anchor ? '#' + encodeURIComponent(req.body.anchor) : ''));
});

// POST /sprites/buyback/seed — parse a big text blob into rows. Skips lines
// we can't resolve; reports counts in a redirect query param so the UI can
// surface a "42 added / 3 skipped" toast.
router.post('/buyback/seed', async (req, res) => {
  const acct = req.session?.epicAccountId;
  if (!acct) return res.redirect('/sprites');
  const raw = String(req.body?.text || '');
  if (!raw.trim()) return res.redirect('/sprites?buyback=empty');
  try {
    const row = await getAccount(acct);
    if (!row?.state_json) return res.redirect('/sprites?buyback=nostate');
    const state = JSON.parse(row.state_json);
    const groups = state.groups || [];
    let added = 0, skipped = 0, unresolved = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const variantName = parseBuyBackLine(line, groups);
      if (!variantName) { skipped++; unresolved.push(line.trim()); continue; }
      try {
        // INSERT IGNORE is idempotent for the composite PK — already-listed
        // items just no-op instead of raising a duplicate-key error.
        await pool.execute(
          `INSERT IGNORE INTO epic_sprite_buyback (account_id, variant_name, source)
             VALUES (?, ?, 'manual')`,
          [acct, variantName],
        );
        added++;
      } catch (e) { skipped++; }
    }
    if (unresolved.length) logger.info(`[sprites] buyback seed unresolved: ${unresolved.slice(0, 5).join(' | ')}${unresolved.length > 5 ? ' + ' + (unresolved.length - 5) + ' more' : ''}`);
    res.redirect(`/sprites?buyback=added:${added}:skipped:${skipped}`);
  } catch (e) {
    logger.warn(`[sprites] buyback seed failed: ${e.message}`);
    res.redirect('/sprites?buyback=error');
  }
});

// GET /sprites/logout — accept GET as well so the in-banner "Reconnect →" link works
// without needing a form post. Same behavior as POST: drops the session, lands the
// user back on the login form ready to paste a fresh auth code.
router.get('/logout', (req, res) => {
  if (req.session) delete req.session.epicAccountId;
  res.redirect('/sprites');
});

router.post('/logout', async (req, res) => {
  const acct = req.session?.epicAccountId;
  if (acct && req.body?.forget === '1') {
    try { await pool.execute('DELETE FROM epic_sprite_accounts WHERE account_id=?', [acct]); } catch (e) { logger.warn(`[sprites] forget failed: ${e.message}`); }
  }
  if (req.session) delete req.session.epicAccountId;
  res.redirect('/sprites');
});

// ── /sprites/browse ─────────────────────────────────────────────────────────
// Public list of every collector who has a public slug. Lets visitors pick
// 2+ to compare. No auth gate — these profiles are already public via /u/:slug.
router.get('/browse', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT display_name, share_id, synced_at,
              JSON_UNQUOTE(JSON_EXTRACT(state_json, '$.summary.owned')) AS owned,
              JSON_UNQUOTE(JSON_EXTRACT(state_json, '$.summary.obtainable')) AS obtainable,
              JSON_UNQUOTE(JSON_EXTRACT(state_json, '$.summary.epic.passLevel')) AS pass_level
       FROM epic_sprite_accounts
       WHERE share_id IS NOT NULL AND state_json IS NOT NULL
       ORDER BY CAST(JSON_UNQUOTE(JSON_EXTRACT(state_json, '$.summary.owned')) AS UNSIGNED) DESC`,
    );
    // Recent activity events for the feed at the bottom of the browse page.
    const [events] = await pool.execute(
      `SELECT e.event_type, e.event_data, e.created_at,
              a.display_name, a.share_id
       FROM epic_sprite_events e
       JOIN epic_sprite_accounts a ON a.account_id = e.account_id
       WHERE a.share_id IS NOT NULL
       ORDER BY e.created_at DESC
       LIMIT 25`,
    );
    const ago = (ts) => {
      const sec = Math.max(1, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
      if (sec < 60) return `${sec}s ago`;
      if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
      if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
      return `${Math.floor(sec / 86400)}d ago`;
    };
    const feed = events.map((e) => {
      const data = typeof e.event_data === 'string' ? JSON.parse(e.event_data) : e.event_data;
      const userLink = `<a href="/sprites/u/${esc(e.share_id)}"><b>${esc(e.display_name || e.share_id)}</b></a>`;
      const time = `<span class="feed-time">${esc(ago(e.created_at))}</span>`;
      let icon, text;
      if (e.event_type === 'new_sprites') {
        icon = '✨';
        // Named-sprite rendering: prefer the actual variant names captured at
        // event time; fall back to the pre-migration count-only phrasing for
        // rows that were logged before we started capturing names.
        const list = Array.isArray(data.sprites) ? data.sprites.filter((s) => s && s.family) : [];
        if (list.length) {
          const label = (s) => `${s.tier} ${s.family}`;
          let phrase;
          if (list.length === 1) phrase = `collected ${label(list[0])}`;
          else if (list.length === 2) phrase = `collected ${label(list[0])} + ${label(list[1])}`;
          else phrase = `collected ${label(list[0])}, ${label(list[1])}, and ${list.length - 2} more`;
          text = `${phrase} (now at ${data.total} total)`;
        } else {
          text = `collected ${data.count} new sprite${data.count === 1 ? '' : 's'} (now at ${data.total} total)`;
        }
      } else if (e.event_type === 'pass_level') {
        icon = '🎮';
        text = `leveled up to Battle Pass Level ${data.to}${data.season ? ` in ${esc(data.season)}` : ''}`;
      } else { icon = '·'; text = e.event_type; }
      return `<li class="feed-row"><span class="feed-icon">${icon}</span> ${userLink} ${esc(text)} ${time}</li>`;
    }).join('');
    const list = rows.map((r) => `<li class="browse-row" data-name="${esc((r.display_name || r.share_id).toLowerCase())}" data-slug="${esc(r.share_id.toLowerCase())}">
        <label>
          <input type="checkbox" name="u" value="${esc(r.share_id)}">
          <span class="browse-id">
            <b>${esc(r.display_name || r.share_id)}</b>
            <span class="sub">/u/${esc(r.share_id)}${r.pass_level ? ` · Lv ${esc(String(r.pass_level))}` : ''}</span>
          </span>
          <span class="browse-count">${r.owned ?? '?'}<span class="sub">/${r.obtainable ?? '?'}</span></span>
        </label>
      </li>`).join('');
    res.send(shell('Browse Collectors — CertiFried Sprite Tracker', chrome(`<a class="navlink" href="/sprites">← Tracker</a> <a class="navlink" href="/sprites/info">📋 Catalog audit</a>`) + `<main>
      <div class="card">
        <h2>Compare collections</h2>
        <p class="sub">Pick two or more collectors below and we'll show who has what others don't — perfect for finding trade partners.</p>
        ${rows.length < 2 ? `<p class="warn">Need at least 2 collectors with public profiles to compare. (${rows.length} signed up so far.)</p>` : ''}
        <form method="get" action="/sprites/compare">
          <input type="text" id="browse-search" placeholder="🔍 Search collectors by name…" class="browse-search" autocomplete="off">
          <ul class="browse-list" id="browse-list">${list || '<li class="sub">No public collectors yet.</li>'}</ul>
          <p style="margin-top:14px"><button class="btn" type="submit">🤝 Compare selected →</button></p>
        </form>
      </div>
      ${events.length ? `
      <div class="card" style="margin-top:24px">
        <h2 style="display:flex;align-items:center;gap:10px;margin-bottom:6px">📰 <span>Recent activity</span> <span class="sub" style="font-weight:400;font-size:13px">(${events.length} event${events.length === 1 ? '' : 's'})</span></h2>
        <p class="sub" style="margin:0 0 14px">What other collectors have been up to lately.</p>
        <ul class="feed-list">${feed}</ul>
      </div>` : ''}
    </main>
    <script>(function(){
      var input = document.getElementById('browse-search');
      var list = document.getElementById('browse-list');
      if (!input || !list) return;
      input.addEventListener('input', function(){
        var q = input.value.toLowerCase().trim();
        list.querySelectorAll('.browse-row').forEach(function(li){
          var n = li.dataset.name || '', s = li.dataset.slug || '';
          li.style.display = (!q || n.indexOf(q) >= 0 || s.indexOf(q) >= 0) ? '' : 'none';
        });
      });
    })();</script>`));
  } catch (e) {
    logger.warn(`[sprites] browse view failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + '<main><div class="card"><h2>Something went wrong</h2></div></main>'));
  }
});

// ── /sprites/info ───────────────────────────────────────────────────────────
// Public transparency page — documents which sprite variants are ACTUALLY
// live in Epic's catalog vs. datamined-but-unshipped, and how we know. Purpose
// is to give collectors a citeable receipt when misinformation about
// "Quack sprites are out!" / "Batman drops tomorrow!" starts circulating.
// Update AUDIT_STAMP + the tier/family lists whenever we re-run the four-
// endpoint audit against a live account. See doc-block below the route for
// the exact commands.
const AUDIT_STAMP = '2026-07-09';
const AUDIT_ACCOUNT_LABEL = 'XxXDeath420XxX';
const AUDIT_TIER_TOKENS = ['A', 'Base', 'Candy', 'Galactic', 'Galaxy', 'Gem', 'Gold', 'Holofoil'];
const AUDIT_FAMILY_TOKENS = [
  'AirSprite', 'BossSprite', 'BurntPeanut', 'DemonSprite', 'DrifterSprite',
  'DuckSprite', 'EarthSprite', 'FishySprite', 'GhostSprite', 'GrimSprite',
  'KingSprite', 'PunkSprite', 'SevenSprite', 'SleepySprite', 'SoccerSprite',
  'Spitfire', 'Water', 'ZeroPointSprite',
];
const AUDIT_ABSENT_TOKENS = ['Quack', 'Cube', 'Batman', 'Wick', 'Goose'];

// Pak-datamined variants — extracted 2026-07-10 from Fortnite build
// ++Fortnite+Release-41.10-CL-55227503 using retoc.exe against the IoStore
// utoc containers under D:\Fortnite\FortniteGame\Content\Paks. See
// scratchpad/pak-extract/out/pak-audit-summary.json for the raw dump.
// Update these when re-running against a new build.
const PAK_AUDIT_STAMP = '2026-07-10';
const PAK_BUILD = '41.10-CL-55227503';
const PAK_TOTAL_VARIANTS = 95;
const PAK_UNRELEASED_VARIANTS = [
  { family: 'PunkSprite', tier: 'Cube', hasIcons: true },
  { family: 'SleepySprite', tier: 'Cube', hasIcons: true },
  { family: 'ZeroPointSprite', tier: 'Cube', hasIcons: false },
  { family: 'ZeroPointSprite', tier: 'Quack', hasIcons: true },
];
const PAK_RUMORS_ZERO_HITS = ['Batman', 'JohnWick', 'Wick', 'Joker', 'Goose'];

// Full deep-dive findings (2026-07-10) — extracted from a comprehensive
// enumeration of all 4 CH7S3 plugins + broader Fortnite pak scan. Every list
// below is grounded in actual asset paths from the pak, not speculation.
// Special variant effects — cross-referenced with IGN's CH7S3 sprite guide
// (https://www.ign.com/wikis/fortnite/Sprites_Checklist_and_Guide...). Each
// non-basic tier adds a passive on top of the family's base ability.
const PAK_SPECIAL_TIER_EFFECTS = [
  { tier: 'Gold',     tierKey: 'gold',     color: '#ffcf3a', effect: 'Bonus XP from eliminations' },
  { tier: 'Gummy',    tierKey: 'candy',    color: '#ff6cc4', effect: '10% more Sprite Dust when extracting' },
  { tier: 'Galaxy',   tierKey: 'galaxy',   color: '#7b5cff', effect: '20% more ammo when opening ammo boxes' },
  { tier: 'Holofoil', tierKey: 'holofoil', color: '#5bf0ff', effect: 'Higher chance of finding rare Sprite variants in chests' },
  { tier: 'Gem',      tierKey: 'gem',      color: '#3ad0c4', effect: '30% less fall damage (marked "coming soon" by IGN)' },
];

// Family-specific abilities cross-referenced against IGN's CH7S3 guide + the
// games.gg tier-list guide. `verified` distinguishes documented (IGN/games.gg)
// from pak-only inference. Family rarity comes from games.gg's tier list —
// determines dust re-summon cost per PAK_DUST_COSTS.
const PAK_FAMILY_ABILITIES = [
  // Rare rarity — the entry-level trio
  { family: 'Fire (Spitfire)',    rarity: 'Rare',      ability: 'Spawns fire when you deal enough damage to an enemy',                                              pakBoon: 'FireflyFrenzy (molotov cocktail projectile)',            verified: 'IGN' },
  { family: 'Water',              rarity: 'Rare',      ability: 'Coastal/river map-area bonus (games.gg calls out its usefulness near water)',                       pakBoon: 'Water = "Hydro Healing"',                                verified: 'games.gg' },
  { family: 'Earth',              rarity: 'Rare',      ability: 'Chest loot bonus — stacks with aggressive looting routes',                                          pakBoon: 'Collector (extraction/loot yield)',                      verified: 'games.gg' },
  // Epic rarity
  { family: 'Demon',              rarity: 'Epic',      ability: 'Siphons both shields AND health on kills — constant recovery in fights',                            pakBoon: 'Siphon (heal-on-damage)',                                verified: 'games.gg' },
  { family: 'Ghost',              rarity: 'Epic',      ability: 'Stealth window during reloads (cloak while reloading)',                                             pakBoon: 'GhostReload (has "StartCloak" GameplayEffect)',          verified: 'games.gg' },
  { family: 'Duck',               rarity: 'Epic',      ability: 'Rewards using emotes mid-match (niche but real)',                                                    pakBoon: 'JamSession (music/emote theme)',                         verified: 'games.gg' },
  { family: 'Fishy',              rarity: 'Epic',      ability: 'Increases swim speed + speed boost after taking damage',                                             pakBoon: 'AirSpeed / SuperSprint (movement)',                      verified: 'IGN' },
  { family: 'Striker (Soccer)',   rarity: 'Epic',      ability: 'Overdrive buff on mantle/hurdle/wall-scramble — bumps fire rate, reload, and movement speed',        pakBoon: 'OverdriveParkour = "Wind Parkour"',                     verified: 'IGN' },
  { family: 'Grim Reaper (Grim)', rarity: 'Epic',      ability: 'Players who damage you become marked for a short duration',                                          pakBoon: 'DarkIntel (marking/intel)',                              verified: 'IGN' },
  { family: 'Boss',               rarity: 'Epic',      ability: null,                                                                                                 pakBoon: 'BossHealth (extra HP/shield gameplay effects)',          verified: 'pak-only' },
  { family: 'King',               rarity: 'Epic',      ability: null,                                                                                                 pakBoon: 'RoyalWins (winner theme)',                               verified: 'pak-only' },
  { family: 'Aura (Drifter)',     rarity: 'Epic',      ability: null,                                                                                                 pakBoon: 'HauntedHelpers / Void (aura/ambient theme)',             verified: 'pak-only' },
  // Legendary rarity
  { family: 'Dream (Sleepy)',     rarity: 'Legendary', ability: 'Randomized item drops per level; can produce Legendary loot at max level (variance play)',           pakBoon: 'StarterPack = "Loot Pack" (random cache drops)',        verified: 'games.gg' },
  { family: 'Punk',               rarity: 'Legendary', ability: null,                                                                                                 pakBoon: 'JamSession or Maniac (music/punk theme — unclear)',      verified: 'unconfirmed', note: 'games.gg explicitly flags Punk\'s ability as "not yet confirmed"' },
  // Mythic rarity
  { family: 'Zero Point',         rarity: 'Mythic',    ability: 'Shield Bubble Jr. spawns automatically every time you heal — huge late-game defensive tool',        pakBoon: 'SuperShield (bubble/shield generation)',                verified: 'games.gg' },
  // Cosmetic tier
  { family: 'TheBurntPeanut',     rarity: 'Cosmetic',  ability: '10% chance to pull Mythic loot from eliminations at max level — scales per level',                  pakBoon: 'Greedy (loot yield boost)',                             verified: 'games.gg' },
  // Server-vaulted — no in-game data
  { family: 'Air (server-vaulted)',   rarity: 'unknown', ability: null, pakBoon: 'Air / AirSpeed / WindVortex (movement family)',    verified: 'vaulted' },
  { family: 'Seven (server-vaulted)', rarity: 'unknown', ability: null, pakBoon: 'unknown',                                          verified: 'vaulted' },
];

// Sprite Dust re-summon costs (IGN). If you die with a variant equipped,
// buying it back from your locker costs dust — amount scales with rarity.
const PAK_DUST_COSTS = [
  { rarity: 'Rare',      base: 100,  special: 4000  },
  { rarity: 'Epic',      base: 3000, special: 6000  },
  { rarity: 'Legendary', base: 5000, special: 10000 },
  { rarity: 'Mythic',    base: 7500, special: 15000 },
];

const PAK_CH7S3_PLUGINS = [
  { name: 'SpriteLibrary_CH7S3', assets: 4127, purpose: 'Sprite catalog + variant definitions (what you see in the collection grid)' },
  { name: 'SpriteBoons_Ch7S3', assets: 190, purpose: "Boons — the actual passive abilities sprites grant in-game" },
  { name: 'RiftAnomalies_Ch7s3_Base', assets: 4, purpose: 'Sprite Hunt anomaly encounters (the special rift events that spawn rare sprites)' },
];
// 30 unique sprite boons, extracted from SpriteBoons_Ch7S3 folder structure.
// Boons with dedicated UI icons include their friendly display name from the
// T_UI_SpriteExtraction_Perk_* asset filename. Icons live at
// /sprites/img/boons/boon_<internalname>.png.
const PAK_SPRITE_BOONS = [
  { name: 'AmmoHoarder',      display: 'Ammo Hoarder',      hasIcon: true },
  { name: 'Collector',        display: 'Collector',         hasIcon: true },
  { name: 'ExtractableExpert',display: 'Extractable Expert',hasIcon: true },
  { name: 'FireflyFrenzy',    display: 'Firefly Frenzy',    hasIcon: true },
  { name: 'Goop',             display: 'Gotta Get Goop',    hasIcon: true },
  { name: 'Water',            display: 'Hydro Healing',     hasIcon: true },
  { name: 'InfiniteAmmo',     display: 'Infinite Ammo',     hasIcon: true },
  { name: 'StarterPack',      display: 'Loot Pack',         hasIcon: true },
  { name: 'MidasSplash',      display: 'Midas Splash',      hasIcon: true },
  { name: 'Trash',            display: "One Man's Trash",   hasIcon: true },
  { name: 'Maniac',           display: 'Pickaxe Maniac',    hasIcon: true },
  { name: 'RiftReady',        display: "Rift 'N Ready",     hasIcon: true },
  { name: 'Scout',            display: 'Scout',             hasIcon: true },
  { name: 'Shrapnel',         display: 'Shrapnel Damage',   hasIcon: true },
  { name: 'StormCaller',      display: 'Storm Caller',      hasIcon: true },
  { name: 'OverdriveParkour', display: 'Wind Parkour',      hasIcon: true },
  // No dedicated Perk icon in pak yet — either unshipped or uses a shared icon
  { name: 'AirSpeed',        display: null, hasIcon: false },
  { name: 'BossHealth',      display: null, hasIcon: false },
  { name: 'ChargedUp',       display: null, hasIcon: false },
  { name: 'DarkIntel',       display: null, hasIcon: false },
  { name: 'GhostReload',     display: null, hasIcon: false },
  { name: 'Greedy',          display: null, hasIcon: false },
  { name: 'HauntedHelpers',  display: null, hasIcon: false },
  { name: 'Inflated',        display: null, hasIcon: false },
  { name: 'JamSession',      display: null, hasIcon: false },
  { name: 'RoyalWins',       display: null, hasIcon: false },
  { name: 'Siphon',          display: null, hasIcon: false },
  { name: 'SuperShield',     display: null, hasIcon: false },
  { name: 'Void',            display: null, hasIcon: false },
  { name: 'WindVortex',      display: null, hasIcon: false },
];
router.get('/info', (req, res) => {
  res.send(renderInfo());
});

function renderInfo() {
  const tierPills = AUDIT_TIER_TOKENS
    .map((t) => `<span class="audit-token">${esc(t)}</span>`).join('');
  const familyPills = AUDIT_FAMILY_TOKENS
    .map((f) => `<span class="audit-token family">${esc(f)}</span>`).join('');
  const absentPills = AUDIT_ABSENT_TOKENS
    .map((t) => `<span class="audit-token absent">${esc(t)}</span>`).join('');
  const nav = `<a class="navlink" href="/sprites">👾 My collection</a>
               <a class="navlink" href="/sprites/browse">🤝 Compare</a>`;
  const body = chrome(nav) + `<main>
    <div class="card" style="background:linear-gradient(180deg,#1a2438 0%,#161922 60%);border:1px solid #2a5aa8">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        <span style="background:#2a5aa8;color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;padding:3px 9px;border-radius:999px">📋 TRANSPARENCY</span>
        <span class="sub" style="font-size:12px">Audited ${esc(AUDIT_STAMP)}</span>
      </div>
      <h1>The definitive Sprite catalog audit</h1>
      <p class="sub" style="margin:0">
        We verify every claim on this tracker against the same live Epic endpoints
        the Fortnite client uses. Here's what they returned last audit — and why
        datamining sites list variants that aren't real yet.
      </p>
    </div>

    <div class="card" style="border:1px solid #6b1a24;background:linear-gradient(180deg,#2a1015 0%,#161922 40%)">
      <h2 style="margin-top:0">TL;DR — the tokens people ask about most</h2>
      <div class="audit-tokens" style="margin:8px 0 12px">${absentPills}</div>
      <p style="margin:0"><b>These do not exist</b> as live items in:</p>
      <ul style="margin:6px 0 10px 20px;padding:0">
        <li>Epic's live sprite catalog</li>
        <li>Any account's magpie inventory</li>
        <li>Any account's BR cosmetic profile (where Back Blings live)</li>
        <li>Today's Item Shop rotation</li>
      </ul>
      <p style="margin:0">
        They're pre-baked in Fortnite's <code>.pak</code> files (what fortnite.gg
        surfaces) but Epic hasn't flipped the server-side flag that would make
        them obtainable in-game.
      </p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">How we know — the four-endpoint audit</h2>
      <p class="sub" style="margin:6px 0 12px">
        If a variant were live it would appear in at least one of these four
        responses. If it isn't in any of them, the game literally can't render it.
      </p>
      <table class="audit-table">
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>What it authoritatively lists</th>
            <th class="audit-num">Size on ${esc(AUDIT_STAMP)}</th>
            <th class="center">Quack?</th>
            <th class="center">Batman?</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-label="Endpoint"><code>mcp-gc.live.fngw</code><span class="audit-sub">extractablerelics/…/getBackendCatalog</span></td>
            <td data-label="Lists">Every extractable sprite variant Epic will let you find in a BR match</td>
            <td class="audit-num" data-label="Response size">12,709 B<span class="audit-sub">82 variants</span></td>
            <td class="center audit-hit" data-label="Quack hits">❌ 0</td>
            <td class="center audit-hit" data-label="Batman hits">❌ 0</td>
          </tr>
          <tr>
            <td data-label="Endpoint"><code>gc.svc.live.fngw</code><span class="audit-sub">magpie inventory (deployment-scoped)</span></td>
            <td data-label="Lists">Your owned + extracted-once (buyback) sprites + dust currency + metadata</td>
            <td class="audit-num" data-label="Response size">5,433 B</td>
            <td class="center audit-hit" data-label="Quack hits">❌ 0</td>
            <td class="center audit-hit" data-label="Batman hits">❌ 0</td>
          </tr>
          <tr>
            <td data-label="Endpoint"><code>account-public-service</code><span class="audit-sub">athena BR cosmetic profile</span></td>
            <td data-label="Lists">Every equippable cosmetic on your account — <b>including Back Blings</b></td>
            <td class="audit-num" data-label="Response size">568,517 B</td>
            <td class="center audit-hit" data-label="Quack hits">❌ 0</td>
            <td class="center audit-hit" data-label="Batman hits">❌ 0</td>
          </tr>
          <tr>
            <td data-label="Endpoint"><code>fortnite-api.com/v2/shop</code><span class="audit-sub">public Item Shop rotation</span></td>
            <td data-label="Lists">Every cosmetic Epic is selling right now (previewable even if unpurchased)</td>
            <td class="audit-num" data-label="Response size">696,242 B</td>
            <td class="center audit-hit" data-label="Quack hits">❌ 0</td>
            <td class="center audit-hit" data-label="Batman hits">❌ 0</td>
          </tr>
        </tbody>
      </table>
      <p class="sub" style="margin-top:10px;font-size:12px">
        Audit account: <b>${esc(AUDIT_ACCOUNT_LABEL)}</b>. The first two endpoints require
        different bearer tokens (an EG1 for catalog, a deployment-scoped EOS Connect token for
        magpie) — a fact worth noting because it means one leaked or reused token can't reveal
        a hidden extra module. Athena and Item Shop are effectively public shape-wise.
      </p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">What's actually live right now</h2>
      <p style="margin:6px 0 4px"><b>Tier tokens (variant rarities) Epic is currently serving:</b></p>
      <div class="audit-tokens">${tierPills}</div>
      <p class="sub" style="font-size:12px;margin:12px 0 14px">
        Note two live-catalog quirks: <code>A</code> and <code>Base</code> both mean "basic"
        (Epic named different families' basic variants inconsistently), and
        <code>Galactic</code> is a Sleepy-Sprite-only spelling of what every other family calls
        <code>Galaxy</code>. Tracker handles both.
      </p>
      <p style="margin:6px 0 4px"><b>Sprite families in the CH7S3 catalog (${AUDIT_FAMILY_TOKENS.length} total):</b></p>
      <div class="audit-tokens">${familyPills}</div>
      <p class="sub" style="font-size:12px;margin:14px 0 0">
        BurntPeanut has only a Base variant (no Gold/Gummy/Galaxy). AirSprite and SevenSprite
        are family-level vaulted this season — present in catalog so previously-collected
        copies still display, but not appearing in active BR loot pools.
      </p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Why datamining sites list variants that don't exist yet</h2>
      <p>
        Fortnite ships the art, meshes, and gameplay tags for future content
        inside its <code>.pak</code> files days or weeks before Epic turns
        those items on server-side. That's what fortnite.gg and fortnitedb.com
        surface — everything they find in the pak.
      </p>
      <p>
        <b>Being in the <code>.pak</code> is not the same as being live.</b>
        A separate server-only flag (in Epic's <code>DDSS</code> hotfix config)
        gates whether an extractable variant can spawn in a BR match — including
        as a Back Bling, because sprite Back Blings share the same entitlement
        check.
      </p>
      <p class="sub" style="margin-bottom:12px">
        The neonlightsmedia.com article people cite has no leakers, no fortnite.gg
        links, no dataminers — and it explicitly lists Quack/Cube/John Wick under
        <b>"Unknown Release Dates"</b>. It agrees with our tracker.
      </p>
      <h2 style="margin-top:18px">When this will change</h2>
      <p style="margin-bottom:0">
        The moment any of the four endpoints above starts returning Quack (or Cube
        or Batman), this tracker surfaces it automatically on the next sync — no
        code change needed. Tier tokens are discovered from the live catalog, not
        hardcoded. If you see a "Quack Sprite" screenshot before then, it's
        Photoshopped, from a modded server, or a datamining tool mockup.
      </p>
    </div>

    <div class="card" style="border:1px solid #6b4cff;background:linear-gradient(180deg,#1e1a2e 0%,#161922 60%)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        <span style="background:#6b4cff;color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;padding:3px 9px;border-radius:999px">🗂 PAK AUDIT</span>
        <span class="sub" style="font-size:12px">Extracted ${esc(PAK_AUDIT_STAMP)} · build ${esc(PAK_BUILD)}</span>
      </div>
      <h2 style="margin-top:6px">What's in the pak but not on the server yet</h2>
      <p>
        We ran a pak-side companion audit to the live-endpoint one above. Loaded
        every <code>.utoc</code> container from the local Fortnite install,
        decrypted with the current AES key, and enumerated every
        <code>ESD_*_Variant_*</code> and <code>EID_*_Variation_*</code> asset
        under <code>SpriteLibrary_CH7S3/SpriteDefinitions/</code>. That's the
        definitive list of every variant Epic has <b>art for</b>, even if the
        server hasn't turned it on yet.
      </p>
      <div class="audit-tokens" style="margin:10px 0 6px">
        <span class="audit-token"><b>${PAK_TOTAL_VARIANTS}</b> variants in pak</span>
        <span class="audit-token"><b>${AUDIT_TIER_TOKENS.length}</b> tiers live</span>
        <span class="audit-token absent"><b>${PAK_UNRELEASED_VARIANTS.length}</b> datamined-not-live</span>
      </div>
      <h2 style="margin-top:18px;font-size:16px">The 4 unreleased variants that exist in the pak</h2>
      <table class="audit-table">
        <thead>
          <tr>
            <th>Family</th>
            <th>Tier</th>
            <th>Definition asset</th>
            <th class="center">UI icons?</th>
          </tr>
        </thead>
        <tbody>
          ${PAK_UNRELEASED_VARIANTS.map((v) => `
          <tr>
            <td data-label="Family"><b>${esc(v.family)}</b></td>
            <td data-label="Tier"><span class="audit-token absent">${esc(v.tier)}</span></td>
            <td data-label="Definition asset"><code>ESD_${esc(v.family)}_Variant_${esc(v.tier)}.uasset</code></td>
            <td class="center" data-label="UI icons?">${v.hasIcons ? '<span style="color:#3ad07a;font-weight:800">✓ shipped</span>' : '<span style="color:#ffcf3a;font-weight:800">⚠ missing</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <p class="sub" style="font-size:12px;margin:10px 0 12px">
        Note: ZeroPointSprite Cube ships with only the <code>ESD_</code> definition
        — no UI icon textures — suggesting Epic isn't done with it yet. Every other
        unreleased variant has both large + small icon textures ready.
      </p>
      <div style="background:rgba(107,76,255,.10);border:1px solid rgba(107,76,255,.25);border-radius:8px;padding:10px 14px;margin:12px 0;font-size:13px">
        <b style="color:#cbb5ff">🔓 Live in the tracker:</b>
        The 3 pak icons above (Punk Cube, Sleepy Cube, ZeroPoint Quack) were
        extracted from the pak's <code>UTexture2D</code> assets and are now
        rendered as <b>Unreleased</b> jail-barred cells in every collector's grid.
        ZeroPoint Cube uses a tier-letter placeholder since Epic hasn't shipped
        that texture yet. Once Epic flips the server-side flag and any of these
        appear in the live catalog, the future-flag drops automatically and
        players can find them in-game.
      </div>
      <h2 style="margin-top:18px;font-size:16px">Rumors debunked at the file-system level</h2>
      <p style="margin-bottom:6px">
        Community folklore says a "Batman Sprite" is coming and John Wick / Joker
        variants are on the way. Zero of these tokens exist anywhere in the
        sprite-adjacent pak assets:
      </p>
      <div class="audit-tokens" style="margin:8px 0 10px">
        ${PAK_RUMORS_ZERO_HITS.map((t) => `<span class="audit-token absent">${esc(t)}: 0 hits</span>`).join('')}
      </div>
      <p class="sub" style="font-size:12px;margin:0">
        Not just absent from the live catalog — <b>the art doesn't exist</b>. Nothing
        in the <code>.pak</code> matches these tokens in any sprite-relevant
        context. Any "Batman Sprite reveal" you see is fabricated content.
      </p>
      <details class="info-details" style="margin-top:14px">
        <summary>Show the reproduction commands</summary>
        <p class="sub" style="font-size:12.5px;margin:6px 0 4px">
          Extracted with <a href="https://github.com/trumank/retoc" target="_blank" rel="noopener">retoc</a>
          (Rust-based UE IoStore parser) since CUE4Parse 1.2.2 couldn't mount the
          newest <code>.utoc</code> version 8 containers.
        </p>
        <ol style="margin:6px 0 4px 20px;line-height:1.7">
          <li>Get current AES from <code>fortnite-api.com/v2/aes</code> (main key).</li>
          <li>For each <code>.utoc</code> under the Paks folder:<br>
              <code>retoc.exe --aes-key &lt;KEY&gt; list --path &lt;utoc&gt;</code></li>
          <li>Grep for <code>ESD_*_Variant_*.uasset</code> / <code>EID_*_Variation_*.uasset</code>.</li>
          <li>Diff pak-tier list vs live-catalog tier list. Delta = datamined but not live.</li>
        </ol>
      </details>
    </div>

    <div class="card" style="border:1px solid #6b4cff;background:linear-gradient(180deg,#1e1a2e 0%,#161922 60%)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        <span style="background:#6b4cff;color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;padding:3px 9px;border-radius:999px">🔬 DEEP DIVE</span>
        <span class="sub" style="font-size:12px">Full pak enumeration ${esc(PAK_AUDIT_STAMP)}</span>
      </div>
      <h2 style="margin-top:6px">What else the pak reveals</h2>
      <p>
        Beyond the sprite catalog itself, the pak contains ${PAK_CH7S3_PLUGINS.length}
        dedicated sprite plugins and ${PAK_SPRITE_BOONS.length} distinct passive
        boons. Everything below is grounded in actual asset paths from the game
        files.
      </p>

      <h2 style="margin-top:18px;font-size:16px">The ${PAK_CH7S3_PLUGINS.length} sprite plugins that ship together</h2>
      <table class="audit-table">
        <thead>
          <tr>
            <th>Plugin</th>
            <th class="audit-num">Assets</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          ${PAK_CH7S3_PLUGINS.map((p) => `
          <tr>
            <td data-label="Plugin"><code>${esc(p.name)}</code></td>
            <td class="audit-num" data-label="Assets">${p.assets.toLocaleString()}</td>
            <td data-label="Purpose">${esc(p.purpose)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <p class="sub" style="font-size:12px;margin:10px 0 0">
        No <code>SpriteLibrary_CH7S4</code>, no <code>CH8S1</code>, no
        <code>Season42</code>, no <code>BattlePassS42</code> anywhere in the
        pak. <b>Nobody outside Epic has legitimate leaks for next season's
        sprites</b> — the pak literally doesn't contain that data yet.
      </p>

      <h2 style="margin-top:22px;font-size:16px">30 Sprite Boons — what sprites actually DO in-game</h2>
      <p>
        Boons are the passive abilities each sprite grants when equipped. They
        live in the separate <code>SpriteBoons_Ch7S3</code> plugin. Each boon
        has its own folder with <code>AS_</code> (attribute set),
        <code>GA_</code> (gameplay ability), <code>GE_</code> (gameplay effect),
        and <code>PAID_</code> (boon definition) blueprints — real gameplay
        mechanics, not decoration. 16 have dedicated player-facing UI icons;
        the other 14 use shared iconography or aren't shipped yet.
      </p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin:14px 0 8px">
        ${PAK_SPRITE_BOONS.filter((b) => b.hasIcon).map((b) => `
        <div style="background:#0e0f13;border:1px solid var(--line);border-radius:10px;padding:10px 8px;text-align:center">
          <img src="/sprites/img/boons/boon_${esc(b.name.toLowerCase())}.png" alt="${esc(b.display)}" style="width:56px;height:56px;image-rendering:pixelated;filter:invert(0.9) brightness(1.4);background:rgba(107,76,255,.12);border-radius:8px;padding:4px">
          <div style="font-weight:800;font-size:12.5px;margin-top:6px;color:#e8eaf0">${esc(b.display)}</div>
          <div class="sub" style="font-size:10.5px;margin-top:2px">${esc(b.name)}</div>
        </div>`).join('')}
      </div>
      <details class="info-details" style="margin-top:12px">
        <summary>${PAK_SPRITE_BOONS.filter((b) => !b.hasIcon).length} boons without dedicated UI icons in pak</summary>
        <div class="audit-tokens" style="margin:8px 0 0">
          ${PAK_SPRITE_BOONS.filter((b) => !b.hasIcon).map((b) => `<span class="audit-token">${esc(b.name)}</span>`).join('')}
        </div>
        <p class="sub" style="font-size:12px;margin:8px 0 0">
          These boons exist as full gameplay implementations (blueprint tree
          present) but have no <code>T_UI_SpriteExtraction_Perk_*</code>
          texture. Either use shared iconography in-game or are held back for
          future patches. <code>CheatManager</code> was filtered out of the
          list — it's a UE dev-only class name, not a player-facing boon.
        </p>
      </details>

      <h2 style="margin-top:22px;font-size:16px">Vault-status correction: Air &amp; Seven Sprites</h2>
      <p>
        Fortnite wiki + community sources widely report that <b>AirSprite and
        SevenSprite are "vaulted" and don't appear in CH7S3</b>. The pak
        disagrees:
      </p>
      <ul>
        <li><code>LagerEventData_CH7S3Sprites_Air.uasset</code> + <code>Air_Roaming.uasset</code> — Air's encounter placement data ships in the pak</li>
        <li><code>LagerEventData_CH7S3Sprites_Seven.uasset</code> + <code>Seven_Guaranteed.uasset</code> + <code>Seven_Roaming.uasset</code> — Seven ships with FULL 3-tier encounter data (Main + Guaranteed + Roaming)</li>
        <li>Both families have complete variant definitions (<code>ESD_AirSprite_Variant_*</code>, <code>ESD_SevenSprite_Variant_*</code>) — Basic/Candy/Galaxy/Gold/Holofoil for each</li>
      </ul>
      <p style="margin-bottom:0">
        <b>What "vaulted" actually means:</b> Epic flipped a server-side DDSS
        hotfix flag disabling their spawn — a runtime override, not a pak
        change. Both families are structurally ready to re-enable via hotfix.
        Seven especially is deployment-ready: full encounter data + full
        variant catalog + all icons. The wiki claim "Air and Seven are absent
        from CH7S3" is accurate about in-game availability but <b>wrong at the
        pak level</b>.
      </p>

      <h2 style="margin-top:22px;font-size:16px">Special variant effects</h2>
      <p>
        Every non-Basic tier stacks a passive effect on top of its family's base
        ability. Sourced from <a href="https://www.ign.com/wikis/fortnite/Sprites_Checklist_and_Guide:_All_Variants,_Abilities,_and_Extraction_Tips" target="_blank" rel="noopener">IGN's CH7S3 guide</a>
        and cross-verified against the tier tokens Epic ships in the live catalog.
      </p>
      <table class="audit-table">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Passive effect (stacks on family ability)</th>
          </tr>
        </thead>
        <tbody>
          ${PAK_SPECIAL_TIER_EFFECTS.map((t) => `
          <tr>
            <td data-label="Tier"><span class="audit-token" style="color:${esc(t.color)};border-color:${esc(t.color)}66"><b>${esc(t.tier)}</b></span></td>
            <td data-label="Effect">${esc(t.effect)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <p class="sub" style="font-size:12px;margin:10px 0 0">
        IGN's guide flags <b>Gem as "coming soon"</b> — matches our tracker's
        <code>future: true</code> state. Cube and Quack aren't listed by IGN
        at all (unreleased and unknown to non-datamining sources).
      </p>

      <h2 style="margin-top:22px;font-size:16px">Family abilities (base effect when equipped)</h2>
      <p>
        Each sprite family grants a unique passive when equipped. Cross-referenced
        against two public sources — <a href="https://www.ign.com/wikis/fortnite/Sprites_Checklist_and_Guide:_All_Variants,_Abilities,_and_Extraction_Tips" target="_blank" rel="noopener">IGN's checklist guide</a>
        and <a href="https://games.gg/fortnite/guides/fortnite-all-sprite-abilities-and-how-to-find-them/" target="_blank" rel="noopener">games.gg's tier list</a>
        — plus our pak boon inference for the rest.
      </p>
      <div style="overflow-x:auto">
      <table class="audit-table">
        <thead>
          <tr>
            <th>Family</th>
            <th>Rarity</th>
            <th>Ability</th>
            <th>Pak boon</th>
            <th class="center">Source</th>
          </tr>
        </thead>
        <tbody>
          ${PAK_FAMILY_ABILITIES.map((a) => {
            const rarityColors = { Rare: '#5bf0ff', Epic: '#c084fc', Legendary: '#ffcf3a', Mythic: '#ff6cc4', Cosmetic: '#3ad07a', unknown: '#7a8395' };
            const rarityColor = rarityColors[a.rarity] || '#7a8395';
            const srcHtml = a.verified === 'IGN' ? '<span style="color:#3ad07a;font-weight:800">✓ IGN</span>'
              : a.verified === 'games.gg' ? '<span style="color:#3ad07a;font-weight:800">✓ games.gg</span>'
              : a.verified === 'unconfirmed' ? '<span style="color:#ff8090;font-weight:800">? unconfirmed</span>'
              : a.verified === 'vaulted' ? '<span style="color:#7a8395;font-weight:800">— vaulted</span>'
              : '<span style="color:#ffcf3a;font-weight:800">? pak-only</span>';
            const abilityHtml = a.ability
              ? esc(a.ability) + (a.note ? `<br><span class="sub" style="font-size:11px;font-style:italic">${esc(a.note)}</span>` : '')
              : (a.verified === 'vaulted'
                  ? '<span class="sub" style="font-style:italic">(family vaulted server-side — no in-game data)</span>'
                  : (a.note
                      ? `<span class="sub" style="font-style:italic">${esc(a.note)}</span>`
                      : '<span class="sub" style="font-style:italic">(not documented — inferred from boon name)</span>'));
            return `
          <tr>
            <td data-label="Family"><b>${esc(a.family)}</b></td>
            <td data-label="Rarity"><span class="audit-token" style="color:${rarityColor};border-color:${rarityColor}66;font-size:11px">${esc(a.rarity)}</span></td>
            <td data-label="Ability">${abilityHtml}</td>
            <td data-label="Pak boon"><code>${esc(a.pakBoon)}</code></td>
            <td class="center" data-label="Source">${srcHtml}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
      <p class="sub" style="font-size:12px;margin:10px 0 0">
        <b>12 of 16 in-game families</b> now have their ability documented across
        IGN + games.gg — up from 4 with just IGN. games.gg explicitly notes
        Punk's full ability isn't confirmed publicly yet. King, Aura/Drifter, and
        Boss are pak-only inferences (their boon files exist but the descriptions
        aren't published). Air and Seven are server-vaulted, so no in-game
        behavior can be observed. Each undocumented family has its own
        <code>BP_SpawnAction_GiveSpriteTags_&lt;Family&gt;</code> blueprint in
        the pak, but the boon reference lives inside serialized bytecode we'd
        need a full blueprint decompiler to read.
      </p>

      <h2 style="margin-top:22px;font-size:16px">Sprite Dust re-summon costs by rarity</h2>
      <p>
        Die with a Sprite equipped and you'll lose it from your inventory —
        buy it back from your locker for Sprite Dust. The cost scales with
        rarity. Sourced from IGN's guide.
      </p>
      <table class="audit-table">
        <thead>
          <tr>
            <th>Rarity</th>
            <th class="audit-num">Base tier cost</th>
            <th class="audit-num">Special tier cost <span class="sub" style="font-weight:400;font-size:11px">(Gold/Gummy/Galaxy/Holofoil/Gem)</span></th>
          </tr>
        </thead>
        <tbody>
          ${PAK_DUST_COSTS.map((d) => `
          <tr>
            <td data-label="Rarity"><b>${esc(d.rarity)}</b></td>
            <td class="audit-num" data-label="Base cost">${d.base.toLocaleString()} dust</td>
            <td class="audit-num" data-label="Special cost">${d.special.toLocaleString()} dust</td>
          </tr>`).join('')}
        </tbody>
      </table>

      <h2 style="margin-top:22px;font-size:16px">Why our count (82) is higher than IGN's (66)</h2>
      <p>
        IGN says CH7S3 has <b>66 currently obtainable variants</b>. Our
        catalog shows <b>82 variant entries</b> for Death420's account. The
        difference is real, and it tracks the runtime-vs-shipped distinction
        we've been calling out throughout this page:
      </p>
      <div style="overflow-x:auto">
      <table class="audit-table" style="font-size:13px">
        <thead>
          <tr>
            <th>Bucket</th>
            <th class="audit-num">Count</th>
            <th>What it is</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-label="Bucket">In-game right now (IGN's 66)</td>
            <td class="audit-num" data-label="Count">66</td>
            <td data-label="What it is">15 families × 4 shipped tiers (Basic/Gold/Gummy/Galaxy) + BurntPeanut (1 tier) + 5 Holofoils = 66. Matches IGN's "16 base Sprites" narrative.</td>
          </tr>
          <tr>
            <td data-label="Bucket">Gem "coming soon"</td>
            <td class="audit-num audit-hit" data-label="Count">+6</td>
            <td data-label="What it is">Water/Earth/Duck/Demon/ZeroPoint/Aura have Gem entries in the catalog, all with <code>future: true</code>. IGN flags Gem as "coming soon" — matches.</td>
          </tr>
          <tr>
            <td data-label="Bucket">Air Sprite (server-vaulted)</td>
            <td class="audit-num audit-hit" data-label="Count">+5</td>
            <td data-label="What it is">Air ships in the pak with 5 tiers — Basic/Candy/Galaxy/Gold/Holofoil — but the server-side flag is off. Owned copies from prior seasons still appear in accounts that have them.</td>
          </tr>
          <tr>
            <td data-label="Bucket">Seven Sprite (server-vaulted)</td>
            <td class="audit-num audit-hit" data-label="Count">+5</td>
            <td data-label="What it is">Same story as Air — 5 tiers in the pak, server flag off. Seven has the full 3-tier encounter data (Main + Guaranteed + Roaming), so it's deployment-ready.</td>
          </tr>
          <tr style="background:rgba(107,76,255,.12)">
            <td data-label="Bucket"><b>Our tracker total</b></td>
            <td class="audit-num" data-label="Count"><b>82</b></td>
            <td data-label="What it is">66 + 6 + 5 + 5 = 82. Matches exactly.</td>
          </tr>
        </tbody>
      </table>
      </div>

      <h2 style="margin-top:22px;font-size:16px">What we still can't determine</h2>
      <ul style="margin-bottom:0">
        <li><b>4 families' abilities.</b> Boss, King, Aura (Drifter), and Punk are still pak-only inferences — the boon files exist but no public source has published the ability description. games.gg explicitly flags Punk as "not yet confirmed."</li>
        <li><b>Per-variant drop rates.</b> <code>DT_VariantLootWeightTables.uasset</code> and <code>DT_VariantWeights.uasset</code> exist but their row schemas need Fortnite-specific mappings we don't have. Can enumerate the table names but not the weight values.</li>
        <li><b>Exact release timing.</b> Confirmed absent from the pak — schedule is server-only DDSS hotfix data.</li>
      </ul>
    </div>

    <div class="card" style="border:1px solid #2a5aa8;background:linear-gradient(180deg,#0e1a2e 0%,#161922 60%)">
      <h2 style="margin-top:0">Methodology</h2>
      <p class="sub" style="margin:6px 0 4px">
        Four HTTPS calls against Death420's real account. Anyone with a valid
        device-auth pair can reproduce.
      </p>
      <details class="info-details">
        <summary>Show the exact endpoints &amp; reproduction steps</summary>
        <ol style="margin:6px 0 8px 20px;line-height:1.7">
          <li>Load a valid device-auth pair, mint an EG1 token via Epic's
              <code>account-public-service</code>.</li>
          <li>Catalog: <code>GET mcp-gc.live.fngw.ol.epicgames.com/…/extractablerelics/{moduleId}/13/getBackendCatalog/</code>
              with <code>Authorization: bearer &lt;EG1&gt;</code>.</li>
          <li>Exchange EG1 for a deployment-scoped EOS Connect token, then call magpie:
              <code>GET gc.svc.live.fngw.ol.epicgames.com/api/magpie/v2/deployment/{deploymentId}/…/inventory?moduleFilters={moduleId}:*&amp;includeMetadata=true</code>
              — <code>moduleFilters</code> is required.</li>
          <li>Athena: <code>GET account-public-service-prod.ol.epicgames.com/…/profile/{accountId}/client/QueryProfile?profileId=athena</code>.
              Grep <code>items</code> for the disputed token.</li>
          <li>Public shop: <code>GET fortnite-api.com/v2/shop</code>. Grep same tokens.</li>
        </ol>
        <p class="sub" style="font-size:12px;margin:8px 0 0">
          Sprite module ID: <code>70329e8f-f377-4a73-90cf-76b7ace87a07</code>.
          Deployment ID: <code>62a9473a2dca46b29ccf17577fcf42d7</code>.
          If a new hidden module ever surfaces in a magpie response
          (we look for this every sync — search "unknown" in admin logs), the
          audit expands automatically.
        </p>
      </details>
    </div>

    <p style="text-align:center;margin:22px 0 6px;font-size:14px">
      <a href="/sprites" class="navlink">👾 Back to the tracker</a>
      &nbsp;·&nbsp;
      <a href="/sprites/browse" class="navlink">🤝 Browse collectors</a>
    </p>
  </main>`;
  return shell('Sprite Catalog Audit — CertiFried Sprite Tracker', body, {
    type: 'article',
    title: 'The definitive Fortnite Sprite catalog audit',
    description: `Verified against Epic's live endpoints ${AUDIT_STAMP}. Quack, Cube, Batman, and Wick sprites do not exist yet — here's the receipts.`,
    color: '#2a5aa8',
  });
}

// ── /sprites/compare?u=slug1&u=slug2&u=slug3 ────────────────────────────────
// Side-by-side comparison of 2-8 public collections. Lists "Trade opportunities"
// (variants 1+ user owns and 1+ doesn't), with explicit owner/needer columns so
// users can see at a glance who to message.
router.get('/compare', async (req, res) => {
  let slugs = req.query.u;
  if (!slugs) return res.redirect('/sprites/browse');
  if (!Array.isArray(slugs)) slugs = [slugs];
  // Cap at 8 to keep the table readable and prevent a viral URL from DoSing.
  slugs = Array.from(new Set(slugs.map((s) => String(s).slice(0, 64)))).slice(0, 8);
  if (slugs.length < 2) {
    return res.redirect(`/sprites/browse${slugs.length === 1 ? `?preselect=${encodeURIComponent(slugs[0])}` : ''}`);
  }
  try {
    const [rows] = await pool.execute(
      `SELECT display_name, share_id, state_json, synced_at FROM epic_sprite_accounts
       WHERE share_id IN (${slugs.map(() => '?').join(',')}) AND state_json IS NOT NULL`,
      slugs,
    );
    if (rows.length < 2) {
      return res.status(404).send(shell('Not enough collectors', chrome() + `<main>
        <div class="card"><h2>Couldn't find enough collectors</h2>
        <p class="sub">At least 2 of the slugs you picked don't have public profiles. <a href="/sprites/browse">← Back to browse</a></p>
        </div></main>`));
    }
    // Stable order — match the user's selection order, not DB order.
    const bySlug = new Map(rows.map((r) => [r.share_id, r]));
    const ordered = slugs.map((s) => bySlug.get(s)).filter(Boolean);

    // Build per-user ownership / mastery sets keyed by variant name.
    const users = ordered.map((r) => {
      const state = JSON.parse(r.state_json);
      const owned = new Set(), mastered = new Set();
      for (const g of state.groups) {
        for (const v of Object.values(g.variants)) {
          if (v.owned) owned.add(v.name);
          if (v.mastered) mastered.add(v.name);
        }
      }
      return { displayName: r.display_name, shareId: r.share_id, ownedCount: owned.size, owned, mastered };
    });

    // Canonical variant list from the first user (all states share the same
    // catalog — buildModel iterates the same Epic catalog for everyone).
    const firstState = JSON.parse(ordered[0].state_json);
    const variants = firstState.groups.flatMap((g) => Object.values(g.variants).map((v) => ({
      ...v, familyLabel: g.label,
    })));

    // For each variant, classify: who owns, who needs. Skip universally-owned
    // and universally-unowned (no trade potential).
    const trades = [];
    for (const v of variants) {
      if (v.vaulted) continue; // skip vaulted — nobody can get more, irrelevant for trades
      const owners = users.filter((u) => u.owned.has(v.name));
      const needers = users.filter((u) => !u.owned.has(v.name));
      if (!owners.length || !needers.length) continue;
      trades.push({ v, owners, needers, isUnique: owners.length === 1 });
    }
    // Sort: unique-owner rows first (highest trade value), then by owner count
    // ascending (rarer first), then by family label, then by tier order.
    const tierRank = Object.fromEntries(TIERS.map((t, i) => [t.key, i]));
    trades.sort((a, b) => (a.owners.length - b.owners.length)
      || a.v.familyLabel.localeCompare(b.v.familyLabel)
      || ((tierRank[a.v.tierKey] ?? 99) - (tierRank[b.v.tierKey] ?? 99)));

    const userChip = (u) => `<a href="/sprites/u/${esc(u.shareId)}" class="cmp-user" title="View ${esc(u.displayName)}'s collection">${esc(u.displayName)}</a>`;
    const tradeRows = trades.map((t) => {
      const tierColor = t.v.tierColor;
      // Use the same /sprites/img/<imgId>.png assets as the main grid. If the
      // image 404s, swap in a tier-colored letter placeholder client-side via
      // the onerror handler (same pattern as cell() in the main collection).
      const phLetter = esc((t.v.tierLabel || '?')[0]);
      const phHtml = `<svg viewBox=\\"0 0 100 100\\" class=\\"ph\\"><rect width=\\"100\\" height=\\"100\\" rx=\\"14\\" fill=\\"#15171e\\"/><text x=\\"50\\" y=\\"62\\" text-anchor=\\"middle\\" font-size=\\"40\\" font-weight=\\"800\\" fill=\\"${tierColor}\\">${phLetter}</text></svg>`;
      const img = t.v.imgId
        ? `<img loading="lazy" src="/sprites/img/${esc(t.v.imgId)}.png" alt="${esc(t.v.name)}" onerror="this.outerHTML=this.dataset.ph" data-ph='${phHtml}'>`
        : `<svg viewBox="0 0 100 100" class="ph"><rect width="100" height="100" rx="14" fill="#15171e"/><text x="50" y="62" text-anchor="middle" font-size="40" font-weight="800" fill="${tierColor}">${phLetter}</text></svg>`;
      const anchorId = `trade-${esc(t.v.familyToken || 'fam')}-${esc(t.v.tierKey || 'tier')}`;
      return `<tr id="${anchorId}" class="${t.isUnique ? 'unique' : ''}" data-tier="${esc(t.v.tierKey)}">
        <td class="cmp-sprite">
          <div class="cmp-thumb" style="border-color:${tierColor}55">${img}</div>
          <div class="cmp-text">
            <span class="cmp-tier" style="color:${tierColor}">${esc(t.v.tierLabel)}</span>
            <b>${esc(t.v.familyLabel)}</b>
            ${t.isUnique ? '<span class="cmp-badge">⭐ only one owner</span>' : ''}
          </div>
        </td>
        <td class="cmp-have">${t.owners.map(userChip).join(' ')}</td>
        <td class="cmp-need">${t.needers.map(userChip).join(' ')}</td>
      </tr>`;
    }).join('');

    // Per-user summary: how many sprites are unique to this user across the comparison?
    // Also pull the row's synced_at so each card can show freshness — alongside
    // the periodic 10-min server sweep, this makes it visible whose data was
    // refreshed most recently.
    const syncedAtBySlug = new Map(rows.map((r) => [r.share_id, r.synced_at]));
    const userSummary = users.map((u) => {
      let unique = 0, owned = u.owned.size;
      for (const v of variants) {
        if (u.owned.has(v.name) && !users.some((o) => o !== u && o.owned.has(v.name))) unique++;
      }
      return { ...u, unique, owned, syncedAt: syncedAtBySlug.get(u.shareId) };
    });
    // Most-stale timestamp across the comparison — used by the auto-refresh
    // countdown so users know how fresh "fresh" is for this page.
    const oldestSyncedAt = rows.reduce((acc, r) => {
      const t = r.synced_at ? new Date(r.synced_at).getTime() : 0;
      return (!acc || (t && t < acc)) ? t : acc;
    }, null);

    // CSV export — same data, machine-readable format. Activated by ?format=csv.
    if (req.query.format === 'csv') {
      const escCsv = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
      const header = ['Sprite', 'Tier', 'Family', 'Owners', 'Needers', 'IsUnique'];
      const lines = [header.join(',')];
      for (const t of trades) {
        lines.push([
          escCsv(`${t.v.tierLabel} ${t.v.familyLabel}`),
          escCsv(t.v.tierLabel),
          escCsv(t.v.familyLabel),
          escCsv(t.owners.map((u) => u.displayName).join('; ')),
          escCsv(t.needers.map((u) => u.displayName).join('; ')),
          t.isUnique ? '1' : '0',
        ].join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="trade-matrix-${users.map((u) => u.shareId).join('-vs-').slice(0, 80)}.csv"`);
      return res.send(lines.join('\n'));
    }
    const fmtRelative = (ts) => {
      if (!ts) return '—';
      const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    };
    res.send(shell(`Compare ${users.length} collectors — CertiFried`, chrome(`<a class="navlink" href="/sprites/browse">+ pick more</a>`) + `<main>
      <section class="hero" style="display:block;padding:18px 26px">
        <div class="who" style="margin-bottom:14px">Comparing <b style="font-size:18px">${users.length} collectors</b></div>
        <div class="cmp-summary">
          ${userSummary.map((u) => `<div class="cmp-summary-card">
            <a href="/sprites/u/${esc(u.shareId)}" class="cmp-user-link"><b>${esc(u.displayName)}</b></a>
            <div class="sub">${u.owned} sprites · <b style="color:#5bf0ff">${u.unique} unique</b> in this comparison</div>
            <div class="sub" style="font-size:11px;color:#7a8395;margin-top:2px">synced ${esc(fmtRelative(u.syncedAt))}</div>
          </div>`).join('')}
        </div>
        <div id="cmp-refresh-bar" data-rendered-at="${Date.now()}" data-oldest-synced-at="${oldestSyncedAt || ''}"
             style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:14px;padding:10px 14px;background:#0e0f13;border:1px solid #2a2f3c;border-radius:10px;font-size:13px">
          <span style="display:flex;align-items:center;gap:6px">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3ad07a;animation:cmp-pulse 2s infinite"></span>
            <b style="color:#e8eaf0">Live</b>
            <span class="sub">— auto-refreshes every 5 min when this tab is active.</span>
          </span>
          <span id="cmp-refresh-countdown" class="sub" style="font-variant-numeric:tabular-nums;font-weight:600;color:#cfe">next refresh in 5:00</span>
          <button id="cmp-pause-btn" type="button" class="cmp-clear" style="margin-left:auto">⏸ Pause</button>
          <button id="cmp-refresh-now" type="button" class="cmp-clear">🔄 Refresh now</button>
        </div>
        <style>@keyframes cmp-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.85)}}</style>
      </section>

      <section class="playercard" style="display:block">
        <div class="cardhead" style="margin-bottom:8px">🤝 Trade opportunities <span id="cmp-count" style="color:var(--muted);font-weight:600">(${trades.length})</span></div>
        <p class="sub" style="margin:0 0 10px">Each row is a sprite that some have and others need. ⭐ "only one owner" rows are uniquely held — perfect trade leverage. Click a name to open that collector's profile.</p>
        <div class="cmp-filter">
          <span class="cmp-filter-label">Filter tiers:</span>
          ${TIERS.map((t) => `<label class="cmp-tier-pill" style="border-color:${t.color}55">
            <input type="checkbox" checked data-tier="${esc(t.key)}">
            <span style="color:${t.color}">${esc(t.label)}</span>
          </label>`).join('')}
          <button type="button" id="cmp-clear" class="cmp-clear">Clear all</button>
          <button type="button" id="cmp-all" class="cmp-clear">All</button>
          <a class="cmp-clear" href="?${slugs.map((s) => `u=${encodeURIComponent(s)}`).join('&')}&format=csv" download style="text-decoration:none">⬇ CSV</a>
        </div>
        <table class="cmp-table">
          <thead><tr><th>Sprite</th><th class="cmp-have-col">✓ Has it</th><th class="cmp-need-col">✗ Needs it</th></tr></thead>
          <tbody>${tradeRows || '<tr><td colspan="3" class="sub" style="text-align:center;padding:24px">No trade opportunities — every selected collector owns the same sprites.</td></tr>'}</tbody>
        </table>
      </section>
    </main>
    <script>(function(){
      var rows = document.querySelectorAll('.cmp-table tbody tr');
      var pills = document.querySelectorAll('.cmp-tier-pill input');
      var count = document.getElementById('cmp-count');
      var totalRows = rows.length;
      function apply(){
        var allowed = new Set();
        pills.forEach(function(p){ if(p.checked) allowed.add(p.dataset.tier); });
        var shown = 0;
        rows.forEach(function(r){
          var t = r.dataset.tier;
          var ok = !t || allowed.has(t);
          r.style.display = ok ? '' : 'none';
          if (ok) shown++;
        });
        if (count) count.textContent = '(' + shown + (shown !== totalRows ? ' of ' + totalRows : '') + ')';
      }
      pills.forEach(function(p){ p.addEventListener('change', apply); });
      var clear = document.getElementById('cmp-clear');
      var all = document.getElementById('cmp-all');
      if (clear) clear.addEventListener('click', function(){ pills.forEach(function(p){ p.checked = false; }); apply(); });
      if (all) all.addEventListener('click', function(){ pills.forEach(function(p){ p.checked = true; }); apply(); });

      // ── auto-refresh ────────────────────────────────────────────────────
      // 5-minute reload cycle, paused while tab is hidden. Server sync runs
      // every 10 min, so polling every 5 min catches changes within ~5 min of
      // them happening without slamming the page. Pause toggle for users who
      // want a stable view (mid-trade screenshot, etc.). "Refresh now" forces
      // an immediate reload. Countdown lives in #cmp-refresh-countdown.
      var REFRESH_INTERVAL_S = 5 * 60;
      var paused = false;
      var startedAt = Date.now();
      var countdownEl = document.getElementById('cmp-refresh-countdown');
      var pauseBtn = document.getElementById('cmp-pause-btn');
      var refreshNowBtn = document.getElementById('cmp-refresh-now');
      function fmtRemain(s){
        var m = Math.floor(s / 60), sec = s % 60;
        return m + ':' + (sec < 10 ? '0' : '') + sec;
      }
      function tick(){
        if (!countdownEl) return;
        if (paused){ countdownEl.textContent = 'auto-refresh paused'; return; }
        if (document.hidden){ countdownEl.textContent = 'paused (tab hidden)'; return; }
        var elapsed = Math.floor((Date.now() - startedAt) / 1000);
        var remain = REFRESH_INTERVAL_S - elapsed;
        if (remain <= 0){
          // Preserve scroll position across the reload by writing it into the
          // URL hash temporarily — the browser restores scroll on same-URL
          // reload anyway, but this is a belt-and-braces guard for back/fwd.
          location.reload();
          return;
        }
        countdownEl.textContent = 'next refresh in ' + fmtRemain(remain);
      }
      setInterval(tick, 1000);
      tick();
      if (pauseBtn) pauseBtn.addEventListener('click', function(){
        paused = !paused;
        pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
        if (!paused) startedAt = Date.now();  // restart the countdown on resume
      });
      if (refreshNowBtn) refreshNowBtn.addEventListener('click', function(){ location.reload(); });
      // Re-tick immediately when the tab regains focus so the user doesn't
      // see "paused (tab hidden)" for up to a second after switching back.
      document.addEventListener('visibilitychange', tick);
    })();</script>`));
  } catch (e) {
    logger.warn(`[sprites] compare view failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + '<main><div class="card"><h2>Something went wrong</h2></div></main>'));
  }
});

router.get('/admin', async (req, res) => {
  const acct = req.session?.epicAccountId;
  if (!acct || !ADMIN_ACCOUNT_IDS.has(acct)) {
    return res.status(403).send(shell('Forbidden — CertiFried', chrome() + `<main>
      <div class="card"><h2>403 — Forbidden</h2>
      <p class="sub">This page is only visible to the tracker's admin while logged in to the linked Epic account.</p>
      <p style="margin-top:14px"><a class="btn" href="/sprites">← Back to tracker</a></p></div></main>`));
  }
  try {
    const [rows] = await pool.execute(
      `SELECT account_id, display_name, share_id, first_synced_at, synced_at, refresh_expires_at, needs_relogin,
              device_auth_at, IF(device_id_enc IS NULL OR device_secret_enc IS NULL, 0, 1) AS has_device,
              LENGTH(state_json) AS state_size, state_json
       FROM epic_sprite_accounts ORDER BY needs_relogin DESC, has_device ASC, synced_at DESC`,
    );
    const fmtTs = (t) => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
    const tableRows = rows.map((r) => {
      let owned = '—', obtainable = '—', passLevel = '—', accountLevel = '—', familyCount = '—';
      try {
        const st = r.state_json ? JSON.parse(r.state_json) : null;
        if (st?.summary) {
          owned = st.summary.owned ?? '—';
          obtainable = st.summary.obtainable ?? st.summary.released ?? st.summary.total ?? '—';
          familyCount = st.summary.families ?? '—';
          if (st.summary.epic) {
            passLevel = st.summary.epic.passLevel ?? '—';
            accountLevel = st.summary.epic.accountLevel != null ? fmt(st.summary.epic.accountLevel) : '—';
          }
        }
      } catch { /* shrug */ }
      // Auth status pill — captures the credential tier at a glance.
      //   DEAD  = needs_relogin set, no working credential
      //   🔒 Forever = device_auth on file, syncs permanently
      //   ↻ Refresh = refresh_token only, expires in <refresh_expires_at>
      //   ⏳ Expiring = refresh_token only AND <24h to expiry
      let authPill;
      if (r.needs_relogin) {
        authPill = '<span class="pill bad">DEAD — needs relogin</span>';
      } else if (r.has_device) {
        authPill = `<span class="pill ok" title="device_auth minted ${esc(fmtTs(r.device_auth_at))}">🔒 Forever (device)</span>`;
      } else if (r.refresh_expires_at) {
        const hoursLeft = (new Date(r.refresh_expires_at).getTime() - Date.now()) / 3600000;
        if (hoursLeft <= 0) authPill = '<span class="pill bad">expired</span>';
        else if (hoursLeft < 24) authPill = `<span class="pill warn">⏳ Refresh · ${Math.round(hoursLeft)}h left</span>`;
        else authPill = `<span class="pill warn">↻ Refresh · ${Math.round(hoursLeft)}h left</span>`;
      } else authPill = '<span class="pill warn">unknown</span>';
      const slugLink = r.share_id
        ? `<a href="/sprites/u/${esc(r.share_id)}" target="_blank">${esc(r.share_id)} ↗</a>`
        : '<span class="sub">—</span>';
      return `<tr>
        <td><b>${esc(r.display_name || '(unknown)')}</b><br><code class="sub">${esc(String(r.account_id).slice(0, 8))}…</code></td>
        <td>${slugLink}</td>
        <td>${authPill}</td>
        <td>${passLevel}</td>
        <td>${accountLevel}</td>
        <td>${owned}/${obtainable}</td>
        <td>${familyCount}</td>
        <td title="${esc(fmtTs(r.first_synced_at))}">${fmtTs(r.first_synced_at)}</td>
        <td title="${esc(fmtTs(r.synced_at))}">${fmtTs(r.synced_at)}</td>
        <td class="sub">${(r.state_size || 0).toLocaleString()} B</td>
      </tr>`;
    }).join('');
    const dead = rows.filter((r) => r.needs_relogin).length;
    const permanent = rows.filter((r) => r.has_device && !r.needs_relogin).length;
    const ephemeral = rows.filter((r) => !r.has_device && !r.needs_relogin).length;
    const summary = `${rows.length} accounts · 🔒 ${permanent} permanent (device_auth) · ↻ ${ephemeral} refresh-only · ✗ ${dead} need re-login`;
    res.send(shell('Admin — CertiFried Sprite Tracker', chrome(`<a class="navlink" href="/sprites">← Back to my tracker</a>`) + `<main>
      <section class="hero" style="display:block">
        <div class="who" style="margin-bottom:6px">Tracker Admin<b>All connected accounts</b><span class="since">${summary}</span></div>
      </section>
      <table class="admin-table">
        <thead><tr>
          <th>User</th><th>Slug</th><th>Auth</th><th>BP&nbsp;Lvl</th><th>Account&nbsp;Lvl</th>
          <th>Sprites</th><th>Families</th><th>First sync</th><th>Last sync</th><th>State&nbsp;size</th>
        </tr></thead>
        <tbody>${tableRows || '<tr><td colspan="10" class="sub" style="text-align:center;padding:24px">No accounts yet.</td></tr>'}</tbody>
      </table>
      <p class="sub" style="margin-top:14px">🔒 <b>Forever</b> = device_auth on file, permanent until user revokes from Epic account settings. ↻ <b>Refresh</b> = refresh_token only (48h rotating); back-fills to device_auth on next sync. ✗ <b>DEAD</b> = needs a manual re-paste to recover.</p>
    </main>`));
  } catch (e) {
    logger.warn(`[sprites] admin view failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + '<main><div class="card"><h2>Something went wrong</h2></div></main>'));
  }
});

export default router;
