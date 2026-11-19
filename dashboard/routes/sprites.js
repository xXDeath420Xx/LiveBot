// certifriedmultitool.com/sprites — the only auto-synced Fortnite Sprite collection
// tracker. Users connect their Epic account once (auth-code paste); we persist ONLY an
// encrypted refresh token (utils/encryption.js) + a cached model, and re-sync on demand.
// Public route (no Discord login) — the Epic session lives in req.session.epicAccountId.
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pool from '../../utils/db.js';
import encryptionService from '../../utils/encryption.js';
import logger from '../../utils/logger.js';
import {
  LOGIN_URL, exchangeAuthCode, fetchSpriteData, buildModel, parseAuthCode,
  syncFromRefreshToken, TIERS, EAS_CONFIGURED, authorizeUrl, connectViaOAuth, signInViaEpic,
  deriveDataminedVariants, imgIdFor, FAMILY_LABEL,
  refreshToken as epicRefreshToken, shortLabelForSeasonNum,
  createDeviceAuth, deviceAuthLogin, killSession, upcomingReleases,
  getCatalogVersion, setCatalogVersion,
  setReleaseSchedule, setObservedAvailability, getObservedAvailability, activeSchedule, discoveredTierKeys,
  setEpicDisabled, normDisabledKey, PENDING_FAMILY_LABEL,
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
  const model = buildModel(catalog, inventory, athena, {
    pakDatamined: await getPakDataminedVariants(),
    familyDisplayNames: getPakFamilyDisplayNames(),
  });

  // Capture the live-endpoint response sizes so /sprites/info can show fresh
  // "12,709 B on <today>" values instead of frozen 2026-07-09 numbers.
  // Best-effort — failure to persist doesn't block the sync.
  try {
    const sizes = {
      catalog: JSON.stringify(catalog).length,
      magpie:  JSON.stringify(inventory).length,
      athena:  JSON.stringify(athena).length,
      catalogVariants: catalog ? Object.keys(catalog).length : null,
    };
    // Persist against ALL accounts — cheap and lets us use any account as
    // the audit source later. Column is added by migration on first read.
    await pool.execute(
      `UPDATE epic_sprite_accounts SET last_endpoint_sizes=? WHERE account_id=?`,
      [JSON.stringify(sizes), tok.account_id],
    ).catch(async (e) => {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        // First-run migration — add the column and retry.
        await pool.execute(`ALTER TABLE epic_sprite_accounts ADD COLUMN last_endpoint_sizes JSON NULL`);
        await pool.execute(`UPDATE epic_sprite_accounts SET last_endpoint_sizes=? WHERE account_id=?`,
          [JSON.stringify(sizes), tok.account_id]);
      } else throw e;
    });
  } catch (e) {
    logger.warn(`[sprites] size capture failed for ${tok.account_id}: ${e.message}`);
  }

  // Back-fill: any successful sync on an account WITHOUT device auth becomes
  // the moment we mint one. After this lands, every active user transitions
  // from rotating-refresh to forever-device-auth automatically without anyone
  // having to do anything.
  let deviceAuth = null;
  if (!hasDevice) {
    try { deviceAuth = await createDeviceAuth(tok.account_id, tok.access_token); }
    catch (e) { logger.warn(`[sprites] device auth back-fill failed for ${tok.account_id}: ${e.message}`); }
  }

  // Terminate THIS sync's Epic session so they don't accumulate and trip Epic's
  // "logged in too many places" security (which forces the user to reset their
  // password). Only when the account has device auth for the NEXT sync — device
  // auth doesn't depend on the killed access token, so this is fully safe there.
  // A refresh-only account whose device-auth back-fill just failed KEEPS its
  // session (killing could invalidate the just-rotated refresh token → brick it).
  if (usedDeviceAuth || deviceAuth) {
    const killed = await killSession(tok.access_token);
    if (!killed) logger.warn(`[sprites] session kill non-ok for ${tok.account_id} (harmless — session will expire itself)`);
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
// Includes device-auth rejection ("account credentials you are using are
// invalid", HTTP 400) — a revoked/expired device auth OR a dead refresh token.
// Without this, such accounts never trip needs_relogin: they just retry every
// sweep and keep showing their last-good (now stale) snapshot. (2026-11-01: this
// was 25/42 accounts frozen on the Override collection, stale since Oct-30.)
const DEAD_TOKEN_PATTERN = /TOKEN_NOT_FOUND|invalid_grant|errors\.com\.epicgames\.account\.auth_token\.invalid_refresh_token|account credentials you are using are invalid/i;

function tryBackgroundResync(accountId, encryptedRefreshTokenRow, displayName) {
  if (inFlightResyncs.has(accountId)) return Promise.resolve();
  inFlightResyncs.add(accountId);
  return syncWithAtomicRotation(encryptedRefreshTokenRow, displayName)
    .then((synced) => saveAccount(synced))
    .catch((e) => {
      logger.warn(`[sprites] bg resync failed for ${accountId}: ${e.message}`);
      if (DEAD_TOKEN_PATTERN.test(e.message)) setTokenStatus(accountId, true);
    })
    .finally(() => inFlightResyncs.delete(accountId));
}

// ── Discord export (PNG with composited sprite icons) ──────────────────────
// Renders a shareable PNG: 4 tier columns (NORMAL=basic, GOLD=gold, GUMMY=gummy,
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
const ESC_XML = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

async function buildDiscordExport(state) {
  // Filter out fully-vaulted families (Air, Seven currently) — they'd be
  // entirely greyscaled and just clutter the export.
  const families = state.groups.filter((g) => (g.obtainableCount ?? g.totalCount ?? 0) > 0);
  if (!families.length) throw new Error('no obtainable families to export');

  // The embed shows ONLY obtainable sprites — owned or still-gettable — never
  // unreleased or vaulted ones. `obtainable` is the single predicate driving
  // every decision below (which columns exist, which icons draw, which get a
  // padlock), so the three can't disagree:
  //   - future (Gem, pre-release tiers)  → excluded
  //   - vaulted                          → excluded
  //   - pak-datamined-only leaks (Quack) → excluded (also `future`)
  //   - owned / obtainable-but-unowned   → INCLUDED
  const isObtainable = (v) => !!(v?.imgId && !v.future && !v.vaulted && !v.pakDatamined);

  // Tier columns are DERIVED from the live catalog, not hardcoded. A tier gets
  // a column iff at least one exported family has an OBTAINABLE variant for it —
  // so the base tiers always show, Cube/Holofoil appear once Epic ships them,
  // and an all-unreleased tier like Gem gets no column at all. This used to be a
  // fixed 4-tier list (Basic/Gold/Gummy/Galaxy), which is why Cube never
  // appeared even after it went live.
  const DISCORD_TIERS = TIERS
    .filter((t) => families.some((g) => isObtainable(g.variants[t.key])))
    .map((t) => ({ key: t.key, label: t.label.toUpperCase() }));
  if (!DISCORD_TIERS.length) throw new Error('no tier columns to export');

  const ICON = 64;
  const CELL_W = 100;
  const CELL_H = 80;
  const LABEL_COL = 168;
  const HEADER_H = 56;
  const FOOTER_H = 56;
  const W = LABEL_COL + DISCORD_TIERS.length * CELL_W;
  const H = HEADER_H + families.length * CELL_H + FOOTER_H;

  // Load + process all icons in parallel — each becomes a sharp.composite()
  // layer. Only obtainable variants are drawn (owned in full color, unowned in
  // full color with a padlock painted on top). Unreleased/vaulted variants
  // aren't drawn at all — their cell stays empty background.
  const iconJobs = [];
  for (let i = 0; i < families.length; i++) {
    const g = families[i];
    for (let t = 0; t < DISCORD_TIERS.length; t++) {
      const tier = DISCORD_TIERS[t];
      const v = g.variants[tier.key];
      if (!isObtainable(v)) continue;
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

  // Overlay SVG — painted on TOP of the icons. Only one decoration remains:
  //   - obtainable but unowned → dark scrim + centered white padlock
  //   - owned                  → nothing (the color icon is the answer)
  // There are no jail bars anymore: unreleased/vaulted variants aren't drawn at
  // all (they're filtered out above), so every cell with an icon is obtainable.
  const overlays = [];
  for (let i = 0; i < families.length; i++) {
    const g = families[i];
    for (let t = 0; t < DISCORD_TIERS.length; t++) {
      const tier = DISCORD_TIERS[t];
      const v = g.variants[tier.key];
      if (!isObtainable(v) || v.owned) continue;
      const x = LABEL_COL + t * CELL_W + Math.round((CELL_W - ICON) / 2);
      const y = HEADER_H + i * CELL_H + Math.round((CELL_H - ICON) / 2);
      {
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
// 10 minutes (NOT 60s — that was a regression: the comments above/below both say
// "every 10 min", but the constant had drifted to 60s, so all accounts re-synced
// every single minute). Sprite data changes on a ~daily event cadence, so 10 min
// is already generous; combined with per-sync session-kill it keeps standing Epic
// sessions at zero and stops the "logged in too many places" lockouts.
const PERIODIC_SYNC_INTERVAL_MS = 10 * 60 * 1000;
// Serialize the sweep with a gap between accounts. Each device-auth sync opens
// an Epic session and kills it on completion (see syncWithAtomicRotation), but
// firing all N resyncs at once opens N concurrent sessions BEFORE any killSession
// runs → trips Epic's "logged in too many places" cap. That's why, after the
// 2026-11-01 Treasure Hunters module cutover, only ~17/42 accounts re-synced and
// the other 25 kept reporting the stale Override totals (the "/162" on compare).
// One-at-a-time + a short delay holds us to a single live session at a time.
const PERIODIC_SYNC_STAGGER_MS = 4 * 1000;
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
    logger.info(`[sprites] periodic sync sweep: ${rows.length} accounts (staggered ${PERIODIC_SYNC_STAGGER_MS}ms apart)`);
    for (const row of rows) {
      await tryBackgroundResync(row.account_id, row, row.display_name);
      await new Promise((r) => setTimeout(r, PERIODIC_SYNC_STAGGER_MS));
    }
  } catch (e) {
    logger.warn(`[sprites] periodic sync sweep query failed: ${e.message}`);
  }
}
// Fire one sweep ~30s after boot to catch up immediately rather than waiting a
// full interval, then keep ticking every 10 min. Both calls return Timeout
// handles we deliberately don't track — process lifetime owns them.
setTimeout(periodicBackgroundSync, 30 * 1000);
setInterval(periodicBackgroundSync, PERIODIC_SYNC_INTERVAL_MS);

// ── Hotfix DDSS poller ──────────────────────────────────────────────────────
// Fortnite ships live-config overrides via /cloudstorage/system/*.ini files —
// the same mechanism that flips sprite plugin availability, adjusts drop
// rates, and sets the ComingSoonTimestamp for the next scheduled drop. We
// poll every 15 min from the SERVER (no Windows scheduled task, no mitmproxy)
// using Death420's device_auth. Results land in dashboard/data/hotfix-current.json
// which /sprites/info + /sprites/countdown read on every render.
//
// The polling reuses any account with valid device_auth — Death420 is preferred
// (his account has the tracker's most stable auth). Falls back to any other
// account if his auth expires. Zero user impact — just a couple HTTPS calls
// per 15 min per online instance.
const HOTFIX_POLL_INTERVAL_MS = 15 * 60 * 1000;
const HOTFIX_CACHE_PATH = path.resolve(__dirname, '../data/hotfix-current.json');
// Files we care about (matched exactly). Every other .ini in the hotfix system
// is ignored to keep processing cheap. Add here as we discover new relevant ones.
const HOTFIX_TARGET_FILES = new Set([
  'DefaultEngine.ini',
  'DefaultGame.ini',
  'DefaultPH_OrangeRemote_Week2Game.ini',
  'DefaultPH_OrangeRemote_Week4Game.ini',
  'DefaultOrangeRemote_AllDayEventGame.ini',
  'DefaultOrangeRemoteGreatOutdoorsGame.ini',
  'DefaultForbiddenFruitGame.ini',
  'DefaultBlastberryGame.ini',
  'DefaultFigmentCoreGame.ini',
]);
async function pollHotfixConfig() {
  try {
    // Find any account with device_auth we can use — prefer Death420 by name
    const [rows] = await pool.execute(
      `SELECT account_id, display_name, device_id_enc, device_secret_enc
       FROM epic_sprite_accounts
       WHERE needs_relogin = 0 AND device_id_enc IS NOT NULL AND device_secret_enc IS NOT NULL
       ORDER BY (display_name='XxXDeath420XxX') DESC, synced_at DESC
       LIMIT 3`,
    );
    if (rows.length === 0) {
      logger.warn('[hotfix] no accounts with device_auth — poll skipped');
      return;
    }
    let tok = null;
    let sourceAccount = null;
    for (const row of rows) {
      try {
        const deviceId = encryptionService.decrypt(JSON.parse(row.device_id_enc));
        const secret = encryptionService.decrypt(JSON.parse(row.device_secret_enc));
        tok = await deviceAuthLogin({ accountId: row.account_id, deviceId, secret });
        sourceAccount = row.display_name;
        break;
      } catch (e) {
        logger.warn(`[hotfix] device_auth failed for ${row.display_name}: ${e.message}`);
      }
    }
    if (!tok) { logger.warn('[hotfix] no working device_auth across candidates — poll skipped'); return; }

    // Step 1: fetch the file list
    const listRes = await fetch(
      'https://mcp-gc.live.fngw.ol.epicgames.com/fortnite/api/cloudstorage/system',
      { headers: { Authorization: `bearer ${tok.access_token}` } },
    );
    if (!listRes.ok) { logger.warn(`[hotfix] system list HTTP ${listRes.status}`); return; }
    const files = await listRes.json();

    // Step 2: fetch bodies of files we care about (parallel, but bounded)
    const targets = files.filter((f) => HOTFIX_TARGET_FILES.has(f.filename) && f.length > 0);
    const bodies = {};
    for (const f of targets) {
      try {
        const r = await fetch(
          `https://mcp-gc.live.fngw.ol.epicgames.com/fortnite/api/cloudstorage/system/${f.uniqueFilename}`,
          { headers: { Authorization: `bearer ${tok.access_token}` } },
        );
        if (r.ok) bodies[f.filename] = { hash: f.hash256, uploaded: f.uploaded, body: await r.text() };
      } catch (e) {
        logger.warn(`[hotfix] fetch ${f.filename} failed: ${e.message}`);
      }
    }

    // Step 3: parse sprite-relevant CVars out of the bodies
    const parsed = parseHotfixBodies(bodies);
    parsed.polled_at = new Date().toISOString();
    parsed.source_account = sourceAccount;
    parsed.file_count = files.length;
    parsed.targets_matched = Object.keys(bodies).length;

    // Step 4: persist
    await mkdir(path.dirname(HOTFIX_CACHE_PATH), { recursive: true });
    await writeFile(HOTFIX_CACHE_PATH, JSON.stringify(parsed, null, 2));
    logger.info(`[hotfix] polled OK — nextDrop=${parsed.next_drop_iso || 'none'} weights=${Object.keys(parsed.variant_weights || {}).length} families`);
  } catch (e) {
    logger.warn(`[hotfix] poll failed: ${e.message}`);
  }
}
function parseHotfixBodies(bodies) {
  const out = {
    next_drop_ts: null,           // Unix seconds
    next_drop_iso: null,
    variant_weights: {},          // { family: { tier: weight } }
    xp_curves: {},                // { key: value } — e.g. XPPerElim: 200
    extraction_multipliers: {},   // { tier|Default: multiplier }
    extraction_multipliers_win: {},
    disabled_variants: [],        // GROUND TRUTH: variants Epic unmapped (MappingID;None) = NOT obtainable
    raw_cvars: {},                // any other Extraction.* CVars
    file_stamps: {},              // last-modified per file
  };
  const disabledSet = new Set();
  for (const [fname, entry] of Object.entries(bodies)) {
    out.file_stamps[fname] = entry.uploaded;
    const body = entry.body;
    // ComingSoonTimestamp — the next scheduled drop
    for (const m of body.matchAll(/Extraction\.Persistence\.ComingSoonTimestamp\s*=\s*(\d+)/g)) {
      out.next_drop_ts = parseInt(m[1], 10);
      out.next_drop_iso = new Date(out.next_drop_ts * 1000).toISOString();
    }
    // DT_VariantWeights row updates: RowUpdate;Family_Tier;Weight;0.63
    // Epic occasionally ships typo'd family names in their hotfix configs
    // (e.g. "Punky_Galaxy" instead of "Punk_Galaxy" in Week2 config). We
    // canonicalize known typos here so the drop-rates table doesn't split
    // one family across two rows. Log any unknown-shape family we see once
    // so future typos surface for review.
    const FAMILY_ALIAS = { Punky: 'Punk' };
    for (const m of body.matchAll(/DT_VariantWeights[^;]*;RowUpdate;(\w+?)_(\w+);Weight;([\d.]+)/g)) {
      const [_, rawFam, tier, w] = m;
      const fam = FAMILY_ALIAS[rawFam] || rawFam;
      if (!out.variant_weights[fam]) out.variant_weights[fam] = {};
      out.variant_weights[fam][tier] = parseFloat(w);
    }
    // SpriteExtractionGameplay.XPPerElim (etc.) — take the ROW value at time 2.0 (max level)
    for (const m of body.matchAll(/SpriteExtractionGameplay\.(\w+)[^;]*;\s*[\d.]+\s*;\s*([\d.]+)/g)) {
      // Store the LAST value seen per key — usually the max-level value
      out.xp_curves[m[1]] = parseFloat(m[2]);
    }
    // Extraction point multipliers
    for (const m of body.matchAll(/DT_ExtractionMulltiplier(_Win)?[^;]*;RowUpdate;(\S+?);[\d.]+;([\d.]+)/g)) {
      const bucket = m[1] === '_Win' ? out.extraction_multipliers_win : out.extraction_multipliers;
      // Tier name normalization: "Extraction.VariantRarity.Candy" → "Candy"; "Default" stays.
      // Kept as Epic's raw string here so debugging matches the payload — display-side
      // remaps "Candy" → "Gummy" at render time (see renderHotfixSection).
      const tier = m[2].replace(/^Extraction\.VariantRarity\./, '');
      bucket[tier] = parseFloat(m[3]);
    }
    // Any other Extraction.* CVars for future analysis
    for (const m of body.matchAll(/(Extraction\.\w+(?:\.\w+)*)\s*=\s*([\w.-]+)/g)) {
      out.raw_cvars[m[1]] = m[2];
    }
    // GROUND-TRUTH AVAILABILITY: Epic disables a variant by unmapping it in the
    // Sprite asset registry — `DT_SpriteAssetRegistry;RowUpdate;<Variant>;MappingID;None`.
    // A variant here is NOT in the loot pool right now (this is how the 7 Gems
    // are gated while Llama Gem, absent from the list, stays live). The audit
    // reconciles our obtainable set against this so an over-claim can't hide.
    for (const m of body.matchAll(/DT_SpriteAssetRegistry;RowUpdate;([^;]+);MappingID;None/g)) {
      disabledSet.add(m[1].trim());
    }
  }
  out.disabled_variants = [...disabledSet];
  return out;
}
// Fire ~15s after boot then every 15 min. Non-blocking, best-effort.
setTimeout(pollHotfixConfig, 15 * 1000);
setInterval(pollHotfixConfig, HOTFIX_POLL_INTERVAL_MS);

// In-memory cache for reads from /sprites/info + /sprites/countdown
let _hotfixCache = null;
let _hotfixCacheMtime = 0;
function getHotfixCache() {
  try {
    const stat = fsSync.statSync(HOTFIX_CACHE_PATH);
    if (_hotfixCache && stat.mtimeMs === _hotfixCacheMtime) return _hotfixCache;
    _hotfixCache = JSON.parse(fsSync.readFileSync(HOTFIX_CACHE_PATH, 'utf8'));
    _hotfixCacheMtime = stat.mtimeMs;
    return _hotfixCache;
  } catch (e) {
    return null;   // Not fatal — page still renders without hotfix data
  }
}

// ── Live availability wiring (migration 166) ────────────────────────────────
// epic-sprites.js has no DB access by design, so this is where live state gets
// pushed into it. Three sources of truth, in increasing order of authority:
//
//   1. epic_sprite_release_schedule  — human-editable prediction. Editable at
//      runtime via /sprites/admin; no redeploy to change a date.
//   2. Epic's hotfix ComingSoonTimestamp — Epic's OWN next-drop stamp, polled
//      every 15 min. If Epic moves a drop, this moves with it.
//   3. epic_sprite_observed_variants — variants players have actually held.
//      Ground truth; overrides both of the above the moment it disagrees.
//
// NOTE: hotfix `variant_weights` is deliberately NOT used for availability.
// Epic ships those as RowUpdate deltas, so a live tier can have zero weight
// rows (Holofoil has none despite shipping 2026-07-09). Absence proves nothing.
const AVAILABILITY_REFRESH_MS = 30 * 1000;
let _availabilityLoadedAt = 0;

async function loadReleaseSchedule() {
  const [rows] = await pool.execute(
    'SELECT scope, item_key, release_at, gate, label, note_label, note_text FROM epic_sprite_release_schedule WHERE enabled=1',
  );
  const sched = { tiers: {}, families: {}, cells: {} };
  for (const r of rows) {
    const entry = {
      at: r.release_at == null ? null : Number(r.release_at),
      gate: r.gate === 1 || r.gate === true,
      label: r.label || undefined,
    };
    if (r.note_label && r.note_text) entry.note = { label: r.note_label, text: r.note_text };
    // scope 'cell' gates one specific family:tier (item_key = "familyToken:tierKey"),
    // e.g. a single Cheat Master variant that debuts on a dated New Sprite Day while
    // the rest of its tier/family is already live. 'tier' and 'family' stay coarse.
    const bucket = r.scope === 'tier' ? sched.tiers : r.scope === 'cell' ? sched.cells : sched.families;
    bucket[r.item_key] = entry;
  }
  reconcileWithHotfix(sched);
  setReleaseSchedule(sched);
  return sched;
}

// Epic's ComingSoonTimestamp is a single global "next drop" instant — we use it
// ONLY to fill in a date for an announced-but-undated entry (at == null). We
// NEVER overwrite a confident date we already have: one global stamp can't be
// right for every entry at once (Ironmouse drops Aug 4, Gems Aug 6, but
// next_drop_ts is a single value — blindly stamping it onto both would drag
// Ironmouse to Aug 6). Gating is now driven by Epic's PER-VARIANT disable list,
// so these dates are for countdown display only; an exact date isn't load-bearing.
// (This also permanently kills the old Cube phantom: a confident past date like
// Cube's Jul 23 is never overwritten.)
function reconcileWithHotfix(sched) {
  const ts = getHotfixCache()?.next_drop_ts;
  if (!ts) return;
  const epicAt = ts * 1000;
  if (epicAt <= Date.now()) return;              // stale/past stamp, ignore
  for (const bucket of ['tiers', 'families']) {
    for (const [key, e] of Object.entries(sched[bucket])) {
      if (e.gate === false) continue;            // note-only entries carry no countdown
      // NEVER auto-date an entry that carries an explicit note. A note means we
      // have real context (e.g. Storm Scout = "future Sprite Day, undated"; Gold
      // = "Power Hours only") and the generic hotfix next-drop stamp would be a
      // FABRICATED countdown pointing at the wrong instant. These stay dateless
      // (gated, no "releases in X" clock) until Epic gives a real date.
      if (e.note) continue;
      if (e.at == null) {                         // fill a MISSING date only — never overwrite a confident one
        e.at = epicAt;
        logger.info(`[sprite-schedule] filled missing date for ${bucket}/${key} from Epic hotfix: ${new Date(epicAt).toISOString()}`);
      }
    }
  }
}

async function loadObservedAvailability() {
  const [rows] = await pool.execute(
    'SELECT DISTINCT tier_key, family_token FROM epic_sprite_observed_variants',
  );
  setObservedAvailability({
    tiers: rows.map((r) => r.tier_key),
    families: rows.map((r) => r.family_token),
    cells: rows.map((r) => `${r.family_token}:${r.tier_key}`),
  });
}

// Officially-announced-but-unshipped sprites (migration 167). Cached in-process
// and refreshed alongside the schedule so the /info reporting reflects edits
// within ~30s. Best-effort: the table may not exist on an un-migrated box.
let _announcedSprites = [];
async function loadAnnouncedSprites() {
  try {
    const [rows] = await pool.execute(
      'SELECT slug, name, release_at, rarity, ability, how_to_get, source_url, family_token FROM epic_sprite_announced WHERE enabled=1 ORDER BY release_at IS NULL, release_at',
    );
    _announcedSprites = rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      releaseAt: r.release_at == null ? null : Number(r.release_at),
      rarity: r.rarity || null,
      ability: r.ability || null,
      howToGet: r.how_to_get || null,
      sourceUrl: r.source_url || null,
      familyToken: r.family_token || null,
    }));
  } catch (e) {
    _announcedSprites = [];
  }
}
const getAnnouncedSprites = () => _announcedSprites;

// Append-only ledger write. Called after every successful sync; a variant only
// ever needs recording once, so INSERT IGNORE keeps this to a no-op in steady
// state. Never throws into the sync path — availability data is best-effort.
async function recordObservations(model) {
  try {
    const seen = [];
    for (const g of model?.groups || []) {
      for (const v of Object.values(g.variants || {})) {
        if (v.owned && v.name && v.familyToken && v.tierKey) seen.push([v.name, v.familyToken, v.tierKey]);
      }
    }
    if (!seen.length) return;
    const ph = seen.map(() => '(?,?,?)').join(',');
    await pool.execute(
      `INSERT IGNORE INTO epic_sprite_observed_variants (variant_name, family_token, tier_key) VALUES ${ph}`,
      seen.flat(),
    );
  } catch (e) {
    logger.warn(`[sprite-observed] record failed: ${e.message}`);
  }
}

// Self-heal stale gates. A family/cell gate exists to hide something UNTIL it
// releases. The moment ANY player is observed owning it, it has demonstrably
// shipped — so drop the gate. Without this the per-player observed override
// still shows it obtainable on LIVE accounts, but a frozen (needs_relogin)
// account keeps rendering the pre-release "locked" state forever, and someone
// has to notice + un-gate by hand on every drop (Storm Scout 2026-08). Tier
// gates are deliberately EXCLUDED — tiers ship staggered, so one observed cell
// must not flip a whole tier live (see isTierLive / the Gem-staggering note).
async function autoClearReleasedGates() {
  try {
    const obs = getObservedAvailability();
    const ownedFamilies = new Set(obs.families || []);
    const ownedCells = new Set(obs.cells || []);
    const sched = activeSchedule();
    const toDrop = [];
    for (const [key, s] of Object.entries(sched.families || {})) {
      // gate:false rows are note-only (already obtainable) — nothing to clear.
      if (s && s.gate !== false && ownedFamilies.has(key)) toDrop.push(['family', key]);
    }
    for (const key of Object.keys(sched.cells || {})) {
      if (ownedCells.has(key)) toDrop.push(['cell', key]);
    }
    if (!toDrop.length) return;
    for (const [scope, key] of toDrop) {
      await pool.execute('DELETE FROM epic_sprite_release_schedule WHERE scope=? AND item_key=?', [scope, key]);
      delete sched[scope === 'family' ? 'families' : 'cells'][key];
      logger.info(`[sprite-schedule] auto-cleared ${scope} gate "${key}" — a player is observed owning it, so it has released`);
    }
    setReleaseSchedule(sched); // apply the pruned schedule to the model immediately
  } catch (e) {
    logger.warn(`[sprite-schedule] auto-clear failed: ${e.message}`);
  }
}

// Persist the catalog version across restarts. `currentCatalogVersion` is an
// in-memory `let` that resets to the compile-time baseline on every restart — so
// without this, each restart re-stales the catalog (serving an OLD version until
// the probe slowly climbs, which is how we ended up on v9/12-families while the
// game was on v12/16-families). Load the last-known version on boot; save every
// forward bump. So a future Epic version bump, once discovered, survives restarts.
let _catalogVerLoaded = false;
let _lastPersistedCatalogVer = 0;
async function syncCatalogVersion() {
  try {
    await pool.execute('CREATE TABLE IF NOT EXISTS epic_sprite_meta (k VARCHAR(40) PRIMARY KEY, v VARCHAR(64))');
    if (!_catalogVerLoaded) {
      const [rows] = await pool.execute('SELECT v FROM epic_sprite_meta WHERE k=?', ['catalog_version']);
      if (rows.length) { setCatalogVersion(Number(rows[0].v)); _lastPersistedCatalogVer = Number(rows[0].v); }
      _catalogVerLoaded = true;
    }
    const cur = getCatalogVersion();
    if (cur > _lastPersistedCatalogVer) {
      await pool.execute('INSERT INTO epic_sprite_meta (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)', ['catalog_version', String(cur)]);
      _lastPersistedCatalogVer = cur;
      logger.info('[sprite-catalog] persisted catalog version v' + cur);
    }
  } catch (e) { logger.warn('[sprite-catalog] version persist failed: ' + e.message); }
}

// Keep both caches warm. Cheap (two small queries) and gives us a ~30s worst
// case between an admin editing a date and the site reflecting it.
async function refreshAvailability() {
  try {
    // Observed ownership must load BEFORE the schedule: loadReleaseSchedule()
    // calls reconcileWithHotfix(), which consults getObservedAvailability() to
    // avoid dragging an already-shipped tier's date forward. Loading them
    // concurrently would race that dependency on the very first cycle.
    await loadObservedAvailability();
    await Promise.all([loadReleaseSchedule(), loadAnnouncedSprites()]);
    // Drop any family/cell gate that a player is now observed owning (released).
    await autoClearReleasedGates();
    // Load/persist the catalog version so restarts don't re-stale it.
    await syncCatalogVersion();
    // Push Epic's own disable list (from the hotfix cache) into the model as an
    // authoritative gate. Carries the poll time so the model can expire it if the
    // hotfix poller dies — a stale list must never keep gating past reality.
    const hf = getHotfixCache();
    setEpicDisabled({
      variants: hf?.disabled_variants || [],
      polledAtMs: hf?.polled_at ? new Date(hf.polled_at).getTime() : 0,
    });
    _availabilityLoadedAt = Date.now();
  } catch (e) {
    logger.warn(`[sprite-availability] refresh failed: ${e.message}`);
  }
}
setTimeout(refreshAvailability, 3000);
setInterval(refreshAvailability, AVAILABILITY_REFRESH_MS);

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

  // Record every variant this account holds into the global observed ledger.
  // This is what makes availability self-correcting: the first player anywhere
  // to loot a Cube flips the tier live for every viewer on the next refresh,
  // regardless of what date the schedule predicted.
  if (model) await recordObservations(model);

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
  // Fire off Discord embed refresh in the background — never blocks the sync
  // response. refreshAllEmbedsForAccount checks rate-limits internally
  // (skips embeds refreshed in the last 30s).
  setImmediate(() => {
    refreshDiscordEmbedsForAccount(accountId).catch((e) => {
      logger.warn(`[sprites] discord embed refresh failed for ${accountId}: ${e.message}`);
    });
  });
}

// Lazy-load the Discord embed refresh function — bot code lives in a sibling
// module that imports discord.js. Guarded so a bot-side crash doesn't break
// the web sync path.
let _refreshEmbeds = null;
async function refreshDiscordEmbedsForAccount(accountId) {
  if (_refreshEmbeds === null) {
    try {
      const cmd = await import('../../commands/tools/sprites.js');
      _refreshEmbeds = cmd?.refreshAllEmbedsForAccount || (() => {});
    } catch (e) {
      logger.warn(`[sprites] sprites-command import failed: ${e.message}`);
      _refreshEmbeds = () => {};
      return;
    }
  }
  // BotManager exposes a getClientForGuild(guildId) method — some guilds have
  // custom bots. We look up each embed's guild individually inside the
  // refresh function; here we just pass a resolver.
  const bm = global.botManager;
  if (!bm) return;
  const clientResolver = (guildId) => {
    try {
      return bm.getClientForGuild ? bm.getClientForGuild(guildId) : bm.getDefaultClient?.();
    } catch { return bm.getDefaultClient?.(); }
  };
  await _refreshEmbeds(accountId, clientResolver);
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
  const model = buildModel(catalog, inventory, athena, {
    pakDatamined: await getPakDataminedVariants(),
    familyDisplayNames: getPakFamilyDisplayNames(),
  });
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
  // Friendly name for alt/title — shown by the browser while the icon loads or
  // if it 404s. Uses the display label, never the raw catalog codename.
  const friendly = `${v.familyLabel ? v.familyLabel + ' ' : ''}${v.tierLabel || ''}`.trim() || v.tierLabel || 'Sprite';
  const img = v.imgId
    ? `<img loading="lazy" src="/sprites/img/${esc(v.imgId)}.png" alt="${esc(friendly)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:this.dataset.ph}).firstChild)" data-ph="${esc(placeholder(v))}">`
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
    // Countdown is data-driven: buildModel puts the unlock instant on the
    // variant as `releasesAt`, so this renderer never needs to know which
    // tiers are special. Anything without a committed date (Gem, Quack, and
    // speculative pak-datamined tiles) has releasesAt=null and falls back to
    // the static "Unreleased" pill — we don't promise a moment we can't back
    // up. The client script ticks every [data-release-at] span in unison.
    if (v.releasesAt && !v.pakDatamined) {
      badges.push(`<span class="b countdown">Releases in <span class="rel-cd" data-release-at="${v.releasesAt}">…</span></span>`);
    } else {
      badges.push('<span class="b soon">Unreleased</span>');
    }
  }
  if (v.vaulted) badges.push('<span class="b vaulted">🚫 Vaulted</span>');
  // Availability disclaimer badge — appears alongside future/vaulted for
  // sprites with unusual availability (e.g. Pollo's stream-event debut). The
  // full explanation lives on the info-card; the tile just gets a short
  // headline. Owned variants still get the badge so the user knows their copy
  // came from a limited event.
  if (v.availabilityNote) badges.push(`<span class="b note" title="${esc(v.availabilityNote.text)}">⚠ ${esc(v.availabilityNote.label)}</span>`);
  const xpLine = v.owned
    ? `<span class="xp">${fmt(v.xp)} XP${v.mastered ? '' : ` / ${fmt(4000)}`}</span>`
    : `<span class="cost">${v.summonCost != null ? `${fmt(v.summonCost)} ✦` : ''}</span>`;
  const bar = v.owned && !v.mastered
    ? `<i class="prog" style="width:${Math.min(100, Math.round((v.xp / 4000) * 100))}%"></i>` : '';
  // data-* attributes power the click-to-open info-card modal. Every field
  // needed to render the card is on the tile itself — family label + ability
  // text come from window.__SPRITE_META (injected once per page) so we don't
  // duplicate the full ability description on every one of the ~100 tiles.
  const dataAttrs = [
    `data-name="${esc(v.name)}"`,
    `data-family-token="${esc(v.familyToken)}"`,
    `data-tier-key="${esc(v.tierKey)}"`,
    `data-tier-label="${esc(v.tierLabel)}"`,
    `data-tier-color="${esc(v.tierColor)}"`,
    `data-owned="${v.owned ? 1 : 0}"`,
    `data-xp="${v.xp ?? ''}"`,
    `data-mastered="${v.mastered ? 1 : 0}"`,
    `data-dupes="${v.dupes ?? 0}"`,
    `data-summon="${v.summonCost ?? ''}"`,
    `data-starter="${v.starter ? 1 : 0}"`,
    `data-vaulted="${v.vaulted ? 1 : 0}"`,
    `data-future="${v.future ? 1 : 0}"`,
    `data-pak-datamined="${v.pakDatamined ? 1 : 0}"`,
    `data-img="${esc(v.imgId || '')}"`,
    'data-info-trigger="1"',
  ].join(' ');
  return `<td><div class="${cls.join(' ')}" ${dataAttrs} title="${esc(friendly)}">
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
  /* Sprite extras — quest progression + cosmetic locker cards. Mirror the
     .card padding/margin/border of the info page's cards so they blend into
     the profile view visually. Grid layout stacks vertically at ≤700px. */
  .sprite-extras .card{padding:18px 20px}
  .sprite-extras .cardhead{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px;font-weight:700}
  .sprite-quest-row{margin-bottom:10px}
  .sprite-quest-row:last-child{margin-bottom:0}
  .sprite-quest-row .ct-bar{position:relative;height:6px;background:#1c2030;border-radius:3px;overflow:hidden}
  .sprite-quest-row .ct-fill{height:100%;background:linear-gradient(90deg,var(--purple),#5bf0ff);transition:width .3s}
  .sprite-quest-row .ct-fill.completed{background:linear-gradient(90deg,var(--green),#8ff0b0)}
  .sqr-label{font-size:13px;line-height:1.35}
  .sprite-cosmetic-row{margin-bottom:14px}
  .sprite-cosmetic-row:last-child{margin-bottom:0}
  .scr-header{font-size:13px;margin-bottom:6px}
  .scr-header .sub{font-size:11px;color:var(--muted);margin-left:6px}
  .scr-chips{display:flex;flex-wrap:wrap;gap:5px}
  .cosmetic-chip{font-size:11px;padding:3px 8px;border:1px solid var(--line);border-radius:999px;background:#0e0f13;color:var(--txt);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .cosmetic-chip b{color:var(--purple);font-weight:800;margin-right:4px}
  @media (max-width:700px){
    .sprite-extras{grid-template-columns:1fr!important}
  }
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
  /* Availability disclaimer — warm gold like the countdown, but with a solid
     border to visually distinguish "unusual availability" from "releases in X".
     Owned + note = still shows so users know their copy came from a limited
     window. Full explanation opens on tile click via the info-card modal. */
  .b.note{color:#ffcf3a;background:rgba(255,207,58,.1);border:1px solid rgba(255,207,58,.35);cursor:help}
  .rel-cd{color:#ffe48a;font-variant-numeric:tabular-nums;letter-spacing:.02em;display:inline-block;min-width:6.6em;text-align:right}
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
  /* Global pill (health-audit card renders pills outside .admin-table). Less
     specific than the scoped admin-table pill rule, so that still wins there. */
  .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.04em;background:#1a1d26;color:var(--muted)}
  .pill.ok{background:rgba(58,208,122,.15);color:var(--green)}
  .pill.bad{background:rgba(255,91,110,.18);color:#ff8aa6}
  .pill.warn{background:rgba(255,207,58,.15);color:var(--gold)}
  .audit-list{margin:4px 0 0;padding-left:18px;font-size:12.5px;line-height:1.5}
  .audit-list.bad li{color:#ff9db2}
  .audit-list.warn li{color:#d9c47a}
  /* ── Compare "Viewing as" visual board (cb-*) ─────────────────────────── */
  .cb-standings{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
  .cb-stand{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;background:#0e0f13;border:1px solid var(--line);text-decoration:none;color:var(--txt);font-size:12.5px}
  .cb-stand:hover{border-color:var(--purple)}
  .cb-stand.on{border-color:var(--gold);background:rgba(255,207,58,.08)}
  .cb-stand .cb-rank{color:var(--muted);font-weight:800;font-variant-numeric:tabular-nums}
  .cb-stand .cb-stand-n{color:var(--green);font-weight:800;font-variant-numeric:tabular-nums}
  .cb-stand .cb-stand-go{color:var(--muted);font-weight:800;margin-left:1px}
  .cb-stand:hover .cb-stand-go{color:var(--purple)}
  .cb-fromlink{color:var(--green);text-decoration:none;font-weight:700}
  .cb-fromlink:hover{text-decoration:underline}
  .cb-agg{margin:6px 0 14px}
  .cb-agg-bar{height:8px;border-radius:999px;background:#0e0f13;border:1px solid var(--line);overflow:hidden}
  .cb-agg-bar span{display:block;height:100%;background:linear-gradient(90deg,#3ad07a,#5bf0ff)}
  .cb-agg-txt{font-size:13px;color:var(--muted);margin-top:6px}
  .cb-agg-txt b{color:var(--txt)}
  .cb-viewas{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px}
  .cb-viewas-lbl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:800}
  .cb-chips{display:flex;flex-wrap:wrap;gap:6px}
  .cb-vchip{padding:5px 12px;border-radius:999px;background:#0e0f13;border:1px solid var(--line);text-decoration:none;color:var(--muted);font-size:12.5px;font-weight:700}
  .cb-vchip:hover{color:var(--txt);border-color:var(--purple)}
  .cb-vchip.on{background:var(--purple);border-color:var(--purple);color:#fff}
  .cb-vselect{display:none;background:#0e0f13;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:7px 10px;font-size:13px;max-width:100%}
  .cb-controls{display:flex;flex-direction:column;gap:10px;margin-bottom:14px}
  .cb-tiers{display:flex;flex-wrap:wrap;gap:6px}
  .cb-tierpill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);cursor:pointer;font-size:12px;font-weight:700;user-select:none}
  .cb-tierpill span{color:var(--tc)}
  .cb-tierpill input{accent-color:var(--tc)}
  .cb-ctl-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  #cb-search,#cb-sort{background:#0e0f13;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:7px 10px;font-size:13px}
  #cb-search{min-width:140px}
  .cb-toggle{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);cursor:pointer}
  .cb-csv{padding:6px 11px;border-radius:8px;background:#0e0f13;border:1px solid var(--line);color:var(--muted);text-decoration:none;font-size:12.5px;font-weight:700;cursor:pointer}
  .cb-csv:hover{color:var(--txt);border-color:var(--purple)}
  .cb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px}
  .cb-tile{position:relative;background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:8px;border-top:3px solid var(--tc)}
  .cb-tile.cb-uniq{box-shadow:0 0 0 1px rgba(255,207,58,.4),0 0 14px rgba(255,207,58,.1)}
  .cb-tile.cb-dim{opacity:.62}
  .cb-tile[role=button]{cursor:pointer}
  .cb-tile[role=button]:hover{border-color:var(--tc)}
  .cb-art{aspect-ratio:1/1;border-radius:10px;background:#0f1118;display:grid;place-items:center;overflow:hidden}
  .cb-art img,.cb-art .ph{width:100%;height:100%;object-fit:contain}
  .cb-meta{display:flex;flex-direction:column;gap:2px;line-height:1.25}
  .cb-tier{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--tc)}
  .cb-fam{font-size:14px}
  .cb-ctx{font-size:11.5px;color:var(--muted);margin-top:2px}
  .cb-ctx.cb-from{color:var(--green)}
  .cb-ctx.cb-hunt{color:#8ab4ff}
  .cb-ctx.cb-vault{color:#ff8aa6}
  .cb-ctx.cb-need{color:var(--gold)}
  .cb-detail{display:none;font-size:11.5px;border-top:1px solid var(--line);padding-top:7px;margin-top:2px}
  .cb-tile.open .cb-detail{display:block}
  .cb-detail>div{display:flex;flex-wrap:wrap;gap:4px 6px;margin-bottom:5px;align-items:baseline}
  .cb-detail>div>span{font-weight:800;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
  .cb-has>span{color:var(--green)}
  .cb-needs>span{color:#ff8aa6}
  .cb-detail a{color:var(--txt);text-decoration:none;background:#0f1118;border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-weight:600}
  .cb-detail a:hover{border-color:var(--purple)}
  .cb-detail i{color:var(--muted)}
  .cb-empty{text-align:center;padding:40px 20px;font-size:15px;color:var(--muted);background:var(--bg2);border:1px dashed var(--line);border-radius:14px}
  .cb-lev{margin-top:18px;background:#0e0f13;border:1px solid var(--line);border-radius:12px;padding:12px 14px}
  .cb-lev summary{cursor:pointer;font-weight:700;color:var(--txt)}
  @media (max-width:640px){
    .cb-chips{display:none}
    .cb-vselect{display:inline-block}
    .cb-grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:9px}
  }
  /* Matrix view — auto-selected for large collector groups (>5). A sticky
     sprite column on the left, then one narrow column per collector. Scan a
     COLUMN for one person's gaps, a ROW for scarcity. Horizontal scroll
     instead of the unreadable 17-chips-per-cell soup the chip table becomes. */
  .cmp-matrix-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--bg2);-webkit-overflow-scrolling:touch}
  .cmp-matrix{border-collapse:collapse;font-size:12px;min-width:100%}
  .cmp-matrix td,.cmp-matrix th{border-bottom:1px solid var(--line);vertical-align:middle}
  .cmp-matrix tr:last-child td{border-bottom:0}
  .cmp-matrix thead th{background:#12141c;padding:6px 4px}
  .cmp-matrix .mx-sprite{position:sticky;left:0;background:var(--bg2);min-width:190px;max-width:190px;padding:7px 12px;box-shadow:1px 0 0 var(--line)}
  .cmp-matrix thead .mx-sprite{z-index:5;background:#12141c;text-transform:uppercase;letter-spacing:.05em;font-size:11px;color:var(--muted);text-align:left}
  .cmp-matrix tbody .mx-sprite{z-index:1}
  .mx-sprite-in{display:flex;align-items:center;gap:10px}
  .mx-ico{flex:none;width:34px;height:34px;border-radius:8px;background:#0f1118;border:1px solid var(--line);display:grid;place-items:center;overflow:hidden;font-size:14px}
  .mx-ico img{width:100%;height:100%;object-fit:contain}
  .mx-txt{display:flex;flex-direction:column;line-height:1.25;min-width:0}
  .mx-txt .mx-tier{font-weight:800;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em}
  .mx-txt b{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}
  .cmp-matrix .mx-user{writing-mode:vertical-rl;white-space:nowrap;height:120px;width:26px;max-width:26px;padding:6px 0;font-weight:700}
  .cmp-matrix .mx-user a{color:var(--muted);text-decoration:none;font-size:11px}
  .cmp-matrix .mx-user a:hover{color:var(--purple)}
  .cmp-matrix .mx-cell{text-align:center;width:26px;font-size:15px;line-height:1;padding:4px 0}
  .mx-miss{color:#2c3140}
  .mx-master{color:var(--gold)}
  .cmp-matrix .mx-count{text-align:center;min-width:48px;font-variant-numeric:tabular-nums;font-weight:800;padding:4px 10px;color:var(--txt)}
  .cmp-matrix .mx-count .mx-of{color:var(--muted);font-weight:600}
  .cmp-matrix tbody tr.unique td{background:rgba(255,207,58,.05)}
  .cmp-matrix tbody tr.unique .mx-sprite{background:#1b1a12;box-shadow:inset 3px 0 0 var(--gold),1px 0 0 var(--line)}
  .cmp-rank{display:inline-block;min-width:20px;font-variant-numeric:tabular-nums;color:var(--muted);font-weight:800;margin-right:6px}
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
  /* Confirmed-shipped rumor pill. Carries a codename + live count so it runs
     longer than the terse absent pills — allow it to wrap. */
  .audit-token.present{background:#0f2418;border-color:#1f6b3a;color:#8ce8ac;font-weight:700;white-space:normal}
  .audit-token.present code{color:#c8f7d8;background:rgba(0,0,0,.25);padding:1px 4px;border-radius:4px}
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
    .rel-cd{min-width:5em}
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
  tr.rowhide{display:none}
  /* ── Trading-card modal (Pokemon / Yu-Gi-Oh vibe) ─────────────────────── */
  .cell[data-info-trigger]{cursor:pointer}
  .info-modal{position:fixed;inset:0;background:rgba(6,7,10,.82);backdrop-filter:blur(10px);
    display:none;align-items:center;justify-content:center;z-index:9999;padding:16px;
    animation:info-fade .2s ease-out}
  .info-modal.open{display:flex}
  @keyframes info-fade{from{opacity:0}to{opacity:1}}
  @keyframes card-in{
    0%{transform:scale(.85) rotateY(-8deg);opacity:0}
    60%{transform:scale(1.03) rotateY(2deg);opacity:1}
    100%{transform:scale(1) rotateY(0);opacity:1}
  }
  @keyframes holo-shimmer{
    0%{background-position:0% 50%}
    50%{background-position:100% 50%}
    100%{background-position:0% 50%}
  }
  @keyframes card-glow{
    0%,100%{filter:drop-shadow(0 0 12px var(--card-glow, rgba(123,92,255,.4)))}
    50%{filter:drop-shadow(0 0 22px var(--card-glow, rgba(123,92,255,.7)))}
  }
  /* Card outer frame — colored border per rarity. Width capped like a real
     trading card; height auto-fits content so the ability panels never scroll. */
  .info-card{
    width:min(380px, 92vw);
    max-height:92vh;
    position:relative;padding:0;
    background:linear-gradient(155deg,var(--card-a,#2a2438) 0%,var(--card-b,#0f1018) 100%);
    border-radius:22px;
    border:none;
    box-shadow:
      0 0 0 3px var(--card-frame,#3a3550),
      0 0 0 5px rgba(0,0,0,.35),
      0 30px 80px rgba(0,0,0,.7);
    animation:card-in .35s cubic-bezier(.2,.9,.3,1.3);
    display:flex;flex-direction:column;
    /* Card content flows naturally; only scroll if the card itself
       exceeds the viewport (very tall descriptions on tiny screens). */
    overflow:hidden auto;
    scrollbar-width:thin;scrollbar-color:var(--card-frame) transparent;
  }
  .info-card::-webkit-scrollbar{width:5px}
  .info-card::-webkit-scrollbar-thumb{background:var(--card-frame);border-radius:3px}
  /* Rarity variables set via data attribute */
  .info-card[data-rarity="Rare"]{--card-frame:#5bf0ff;--card-a:#0e2833;--card-b:#0a1418;--card-glow:rgba(91,240,255,.35)}
  .info-card[data-rarity="Epic"]{--card-frame:#c084fc;--card-a:#241238;--card-b:#0e0a18;--card-glow:rgba(192,132,252,.4)}
  .info-card[data-rarity="Legendary"]{--card-frame:#ffcf3a;--card-a:#332510;--card-b:#161006;--card-glow:rgba(255,207,58,.45)}
  .info-card[data-rarity="Mythic"]{--card-frame:#ff6cc4;--card-a:#331428;--card-b:#180a12;--card-glow:rgba(255,108,196,.5);animation:card-in .35s cubic-bezier(.2,.9,.3,1.3), card-glow 2.4s ease-in-out infinite 1s}
  /* CH7S4 Override rarity system (Common/Uncommon/Rare/Very Rare). "Rare" reuses the cyan above. */
  .info-card[data-rarity="Common"]{--card-frame:#b6c0cf;--card-a:#1c2027;--card-b:#0d0f13;--card-glow:rgba(182,192,207,.28)}
  .info-card[data-rarity="Uncommon"]{--card-frame:#4fd77a;--card-a:#0f2a1a;--card-b:#08160e;--card-glow:rgba(79,215,122,.35)}
  .info-card[data-rarity="Very Rare"]{--card-frame:#a678ff;--card-a:#221338;--card-b:#100a18;--card-glow:rgba(166,120,255,.42)}
  /* Holofoil / Gem / Cube tiers get the iridescent conic-gradient overlay */
  .info-card.holo::before{
    content:'';position:absolute;inset:0;pointer-events:none;border-radius:22px;
    background:conic-gradient(from 0deg, #ff6cc4, #ffcf3a, #3ad07a, #5bf0ff, #7b5cff, #ff6cc4);
    background-size:200% 200%;
    mix-blend-mode:overlay;
    opacity:.32;
    animation:holo-shimmer 4.5s ease-in-out infinite;
    z-index:1;
  }
  .info-card > *{position:relative;z-index:2}

  /* Header bar — sprite name + level/HP badge */
  .info-hdr{
    display:flex;align-items:center;justify-content:space-between;gap:8px;
    padding:11px 16px 8px;
  }
  .info-hdr .fam-wrap{flex:1;min-width:0}
  .info-hdr .fam-name{
    font:900 20px/1.05 inherit;letter-spacing:-.01em;margin:0;
    color:#f5f0ff;text-shadow:0 1px 0 rgba(0,0,0,.5);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }
  .info-hdr .fam-sub{
    font:800 9px/1 inherit;letter-spacing:.14em;text-transform:uppercase;
    color:var(--card-frame);margin-top:3px;opacity:.9;
  }
  .info-hdr .level-badge{
    background:rgba(0,0,0,.55);border:2px solid var(--card-frame);
    padding:5px 10px 4px;border-radius:22px;text-align:center;
    min-width:56px;line-height:1;flex-shrink:0;
  }
  .info-hdr .level-badge .lvl-num{
    font:900 18px/1 inherit;color:var(--card-frame);display:block;
    text-shadow:0 0 8px var(--card-glow,rgba(255,255,255,.3));
  }
  .info-hdr .level-badge .lvl-lbl{
    font:800 8px/1 inherit;letter-spacing:.1em;text-transform:uppercase;
    color:#e8eaf0;opacity:.85;margin-top:2px;display:block;
  }
  .info-close{position:absolute;top:8px;right:8px;background:rgba(0,0,0,.55);
    border:1.5px solid var(--card-frame);color:#e8eaf0;width:28px;height:28px;
    border-radius:50%;font:800 16px/1 inherit;cursor:pointer;
    display:flex;align-items:center;justify-content:center;z-index:10;
    transition:background .12s,transform .12s}
  .info-close:hover{background:var(--card-frame);color:#000;transform:scale(1.1)}

  /* Art window */
  .info-art{
    margin:0 14px;
    aspect-ratio: 1 / 1;
    background:radial-gradient(ellipse at 50% 45%, rgba(255,255,255,.06) 0%, rgba(0,0,0,.5) 80%);
    border:2px solid var(--card-frame);
    border-radius:10px;
    display:flex;align-items:center;justify-content:center;
    overflow:hidden;position:relative;
    box-shadow:inset 0 2px 8px rgba(0,0,0,.6);
  }
  .info-art img{width:88%;height:88%;object-fit:contain;
    filter:drop-shadow(0 6px 18px rgba(0,0,0,.6))}
  .info-art svg{width:70%;height:70%}
  .info-art .art-tier-badge{
    position:absolute;top:8px;left:8px;
    background:var(--card-frame);color:#000;
    font:900 10px/1 inherit;letter-spacing:.08em;text-transform:uppercase;
    padding:3px 8px;border-radius:6px;
    box-shadow:0 2px 4px rgba(0,0,0,.4);
  }
  .info-art .art-status{
    position:absolute;bottom:8px;right:8px;
    background:rgba(0,0,0,.7);color:#e8eaf0;
    font:800 10px/1 inherit;letter-spacing:.08em;text-transform:uppercase;
    padding:4px 9px;border-radius:6px;border:1px solid rgba(255,255,255,.15);
  }
  .info-art .art-status.owned{color:#3ad07a;border-color:rgba(58,208,122,.4)}
  .info-art .art-status.mastered{color:#c084fc;border-color:rgba(192,132,252,.4)}

  /* Body — ability boxes + stats. No internal scroll — card grows to fit. */
  .info-body{padding:10px 14px 12px}

  /* Ability box — mimic Pokemon's move-description box */
  .info-move{
    background:linear-gradient(180deg,rgba(255,255,255,.05) 0%,rgba(0,0,0,.15) 100%);
    border:1.5px solid rgba(255,255,255,.14);
    border-radius:8px;
    padding:9px 11px;
    margin-bottom:8px;
    position:relative;
  }
  .info-move-hdr{
    display:flex;align-items:center;gap:8px;margin-bottom:5px;
  }
  .info-move-hdr .icon{
    width:22px;height:22px;border-radius:50%;
    background:var(--card-frame);color:#000;
    display:flex;align-items:center;justify-content:center;
    font:900 14px/1 inherit;flex-shrink:0;
  }
  .info-move-hdr .name{
    font:900 12.5px/1.1 inherit;color:#f5f0ff;flex:1;
    text-transform:uppercase;letter-spacing:.04em;
  }
  .info-move-hdr .power{
    font:900 12.5px/1 inherit;color:var(--card-frame);
    text-shadow:0 0 6px var(--card-glow,rgba(255,255,255,.2));
  }
  .info-move-desc{
    font:500 11.5px/1.4 inherit;color:#d5d8e0;margin:0;
  }
  /* Per-level scaling table under the ability description */
  .lvl-list{
    display:grid;
    grid-template-columns:auto 1fr;
    gap:3px 8px;
    margin-top:6px;
    padding-top:6px;
    border-top:1px dashed rgba(255,255,255,.08);
  }
  .lvl-tag{
    font:900 9.5px/1.35 inherit;letter-spacing:.05em;text-transform:uppercase;
    color:var(--card-frame);
    background:rgba(0,0,0,.35);
    padding:2px 7px;border-radius:4px;
    text-align:center;white-space:nowrap;align-self:center;
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.04);
  }
  .lvl-val{
    color:#e4e7ee;font:600 11px/1.4 inherit;
    align-self:center;
  }
  /* On the /sprites/info ability table use neutral color (no card-frame var) */
  .audit-table .lvl-list{border-top-color:rgba(123,92,255,.15)}
  .audit-table .lvl-tag{color:var(--purple);background:rgba(123,92,255,.12)}

  /* Stats strip — mimic Pokemon's weakness/retreat row */
  .info-stats{
    display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;
    padding:8px;
    background:rgba(0,0,0,.35);
    border:1px solid rgba(255,255,255,.08);
    border-radius:6px;
    margin-bottom:8px;
  }
  .info-stat{text-align:center}
  .info-stat b{display:block;font:900 14px/1 inherit;color:var(--card-frame);margin-bottom:2px;
    text-shadow:0 0 6px var(--card-glow,rgba(255,255,255,.2))}
  .info-stat .lbl{font:800 8px/1 inherit;letter-spacing:.08em;text-transform:uppercase;
    color:#a9b6d0;opacity:.85}

  /* XP progress bar */
  .info-progress{height:5px;background:rgba(0,0,0,.5);border-radius:3px;overflow:hidden;
    margin:6px 0 3px;border:1px solid rgba(255,255,255,.05)}
  .info-progress i{display:block;height:100%;background:linear-gradient(90deg,var(--card-frame),#fff);
    transition:width .3s;box-shadow:0 0 6px var(--card-glow,rgba(255,255,255,.4))}
  .info-progress-lbl{font:700 10px/1 inherit;text-align:center;color:#a9b6d0;
    letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px}

  /* Footer with rarity dot + codename */
  .info-foot{
    display:flex;align-items:center;justify-content:space-between;gap:8px;
    padding:6px 14px 10px;
    font:600 9px/1.2 inherit;color:#7a8395;
    border-top:1px solid rgba(255,255,255,.05);
  }
  .info-foot .codename{
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    font-size:9.5px;opacity:.8;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    flex:1;min-width:0;
  }
  .info-foot .rarity-dot{
    display:inline-flex;align-items:center;gap:5px;flex-shrink:0;
    font:900 9px/1 inherit;letter-spacing:.1em;text-transform:uppercase;
    color:var(--card-frame);
  }
  .info-foot .rarity-dot::before{
    content:'';width:8px;height:8px;border-radius:50%;
    background:var(--card-frame);
    box-shadow:0 0 6px var(--card-glow,rgba(255,255,255,.3));
  }

  /* Special-status ribbons that appear as banners over the art */
  .info-ribbon{
    position:absolute;top:12px;right:-30px;
    background:var(--card-frame);color:#000;
    padding:3px 34px;font:900 10px/1 inherit;letter-spacing:.1em;text-transform:uppercase;
    transform:rotate(35deg);
    box-shadow:0 2px 4px rgba(0,0,0,.35);z-index:3;
  }
  .info-ribbon.vaulted{background:#ff5b6e;color:#fff}
  .info-ribbon.mastered{background:linear-gradient(90deg,#ffcf3a,#c084fc);color:#000}

  /* Compact mobile tweaks */
  @media(max-width:420px){
    .info-card{width:96vw;max-height:95vh}
    .info-hdr .fam-name{font-size:17px}
    .info-hdr .level-badge{min-width:48px;padding:4px 8px 3px}
    .info-hdr .level-badge .lvl-num{font-size:16px}
    .info-body{padding:8px 12px 10px}
  }
  /* ── /sprites/cards catalogue grid ─────────────────────────────────────── */
  .cards-toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:end;
    background:rgba(0,0,0,.2);border:1px solid var(--line);
    border-radius:10px;padding:12px 14px;margin-top:12px}
  .cards-toolbar label{display:flex;flex-direction:column;gap:4px;
    font:800 10.5px/1 inherit;letter-spacing:.06em;text-transform:uppercase;
    color:var(--muted);min-width:130px}
  .cards-toolbar select{background:#0e0f13;border:1px solid var(--line);
    color:var(--txt);border-radius:8px;padding:8px 10px;font:600 13px/1 inherit;
    cursor:pointer;min-width:130px}
  .cards-toolbar button{margin-left:6px}
  .cards-grid{
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(340px,1fr));
    gap:22px;
    margin-top:16px;
  }
  /* Catalogue cards render inline (not as modal) — remove animation + shadows
     tuned for modal-in-viewport, add a subtle hover lift. */
  .catalogue-card{
    width:100%!important;
    max-height:none!important;
    max-width:400px;
    margin:0 auto;
    animation:none;
    transition:transform .18s ease-out, box-shadow .18s ease-out;
  }
  .catalogue-card:hover{
    transform:translateY(-4px) scale(1.01);
    box-shadow:
      0 0 0 3px var(--card-frame,#3a3550),
      0 0 0 5px rgba(0,0,0,.35),
      0 20px 40px rgba(0,0,0,.7),
      0 0 30px var(--card-glow, rgba(123,92,255,.4));
  }
  @media(max-width:600px){
    .cards-grid{grid-template-columns:1fr;gap:16px}
    .cards-toolbar label{min-width:100%}
    .cards-toolbar select{width:100%}
  }
  /* PNG download button per card */
  .card-dl{
    position:absolute;top:8px;right:8px;z-index:10;
    background:rgba(0,0,0,.6);border:1.5px solid var(--card-frame,#7b5cff);
    color:var(--card-frame,#e8eaf0);
    width:30px;height:30px;border-radius:50%;
    font:900 15px/1 inherit;cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    transition:transform .12s, background .12s, color .12s;
    opacity:.7;
  }
  .card-dl:hover{opacity:1;background:var(--card-frame,#7b5cff);color:#000;transform:scale(1.12)}
  .card-dl.working{background:var(--card-frame);color:#000;animation:card-in .5s ease-in-out infinite alternate}
  .card-dl.done{background:#3ad07a;border-color:#3ad07a;color:#000}
  /* Bulk-download bar */
  .cards-bulk{display:flex;gap:10px;align-items:center;flex-wrap:wrap;
    background:rgba(123,92,255,.08);border:1px solid rgba(123,92,255,.3);
    border-radius:10px;padding:10px 14px;margin-top:12px}
  .cards-bulk .dl-all{background:var(--purple);color:#fff;border:0;
    border-radius:8px;padding:8px 14px;font:800 12.5px/1 inherit;cursor:pointer;
    letter-spacing:.04em;text-transform:uppercase}
  .cards-bulk .dl-all:hover{background:#8f70ff}
  .cards-bulk .dl-status{color:var(--muted);font:600 12.5px/1 inherit;flex:1}
  .cards-bulk progress{height:8px;flex:1;max-width:280px;
    background:#0e0f13;border:1px solid var(--line);border-radius:4px;
    overflow:hidden;appearance:none;-webkit-appearance:none}
  .cards-bulk progress::-webkit-progress-bar{background:#0e0f13}
  .cards-bulk progress::-webkit-progress-value{background:var(--purple)}
  .cards-bulk progress::-moz-progress-bar{background:var(--purple)}
  /* ── Shared layout pass (2026-11-18): one header + tab row on every page,
     readable contrast, visible keyboard focus, no squeezed hero on phones. ── */
  :root{--muted:#9ca3b8;--link:#ab98ff}
  html{background:var(--bg)}
  body{min-height:100vh}
  a{color:var(--link)}
  .navlink{color:var(--link)}
  :where(a,button,summary,input,select,textarea,[tabindex]):focus-visible{outline:2px solid var(--link);outline-offset:2px}
  header.st-header{display:block;padding:0;position:sticky;top:0;z-index:30;background:#0c0d12;border-bottom:1px solid var(--line)}
  .st-bar{display:flex;align-items:center;gap:10px 14px;flex-wrap:wrap;padding:12px 26px}
  .st-bar .logo{white-space:nowrap}
  .st-bar .nav{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .st-tabs{display:flex;gap:2px;padding:0 20px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
  .st-tabs::-webkit-scrollbar{display:none}
  .st-tabs a{flex:none;padding:9px 12px 10px;color:var(--muted);font-weight:700;font-size:13.5px;text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap}
  .st-tabs a:hover{color:var(--txt)}
  .st-tabs a[aria-current="page"]{color:var(--txt);border-bottom-color:var(--purple)}
  .cfn-here{margin-left:auto;font-size:10px;color:var(--muted);font-weight:600}
  .nav .navlink[aria-current="page"]{background:#161922;color:var(--txt)}
  .btn,.nav .navlink.primary,.nav .navlink.primary:hover{background:linear-gradient(90deg,#6744f0,#7a5cf6);color:#fff}
  .btn:hover{filter:brightness(1.08)}
  .btn.btn-quiet{background:#262a37;color:var(--txt)}
  .st-input{width:100%;padding:9px 11px;border-radius:8px;border:1px solid #2f3446;background:#12141b;color:var(--txt);font:inherit;margin:0}
  .st-input:focus{border-color:var(--purple)}
  .st-field{display:grid;gap:4px}
  .st-field > span:first-child{font-weight:600}
  .st-hint{font-size:12px;color:var(--muted)}
  main input:not([type=checkbox]):not([type=radio]),main select,main textarea{max-width:100%}
  .table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .st-empty{text-align:center;color:var(--muted);padding:22px 12px;margin:0}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .stats{flex:1 1 320px;min-width:0}
  .browse-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px}
  .browse-actions .btn[disabled]{opacity:.5;cursor:not-allowed;filter:none}
  .catalogue-card .info-hdr{padding-right:44px}
  .table-scroll{overflow-wrap:normal;word-break:normal}
  .table-scroll > table{min-width:880px}
  @media (max-width:600px){
    header.st-header{position:static}
    .st-bar{padding:10px 14px;gap:8px 10px}
    .st-bar .nav{margin-left:0}
    .st-tabs{padding:0 6px;flex-wrap:wrap;overflow:visible}
    .st-tabs a{padding:8px 10px 9px;font-size:13px}
    .hero{gap:14px;padding:14px 16px}
    .stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;flex-basis:100%}
    .stat,.stat b{overflow-wrap:normal;word-break:normal}
    .stat b{font-size:19px}
  }`;

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
  // ── Sprite info card modal ──────────────────────────────────────────────
  // Click any tile (data-info-trigger="1") to open a card showing full sprite
  // metadata. Data comes from the tile's data-* attributes + window.__SPRITE_META
  // (server-injected map of familyToken → { label, ability } + tier bonuses).
  var META = window.__SPRITE_META || { families: {}, abilities: {}, tiers: {} };
  var modal = document.getElementById('info-modal');
  if (modal) {
    function fmtNum(n){ n = +n; if(!n && n!==0) return ''; return n.toLocaleString(); }
    function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
    function openModal(cell){
      var d = cell.dataset;
      var famToken = d.familyToken || '';
      var famLabel = META.families[famToken] || famToken;
      var ability = META.abilities[famToken] || '';
      var tierKey = d.tierKey || '';
      var tierLabel = d.tierLabel || '';
      var tierColor = d.tierColor || '#7a8395';
      var tierMeta = META.tiers[tierKey] || {};
      var owned = d.owned === '1';
      var xp = +d.xp || 0;
      var mastered = d.mastered === '1';
      var dupes = +d.dupes || 0;
      var summon = d.summon ? +d.summon : null;
      var starter = d.starter === '1';
      var vaulted = d.vaulted === '1';
      var future = d.future === '1';
      var pakDatamined = d.pakDatamined === '1';
      var name = d.name || '';
      var img = d.img;
      // Rarity is a FAMILY property from the base-tier cost, computed server-side
      // with the correct bands (META.rarities) so every variant of a family shows
      // the SAME rarity — a special tile no longer inflates it. Fallback to a
      // base-cost heuristic only if META somehow lacks it.
      var rarity = (META.rarities && META.rarities[famToken] && META.rarities[famToken] !== 'unknown')
        ? META.rarities[famToken]
        : (summon >= 6750 ? 'Mythic' : summon >= 4500 ? 'Legendary' : summon >= 2700 ? 'Epic' : 'Rare');

      // Card level display — for owned, show numeric level (1-5 based on XP).
      // For locked, show padlock. Unreleased = clock. Vaulted = 🚫.
      var lvl = Math.max(1, Math.min(5, Math.ceil(xp / 800)));  // 800 XP/lvl, mastered=5
      var lvlNumHtml, lvlLblHtml;
      if (vaulted && !owned) { lvlNumHtml = '🚫'; lvlLblHtml = 'Vaulted'; }
      else if (future && !owned) { lvlNumHtml = '⏳'; lvlLblHtml = 'Locked'; }
      else if (!owned) { lvlNumHtml = '🔒'; lvlLblHtml = 'Locked'; }
      else if (mastered) { lvlNumHtml = '✦'; lvlLblHtml = 'Master'; }
      else { lvlNumHtml = 'Lv ' + lvl; lvlLblHtml = fmtNum(xp) + ' XP'; }

      // Image / placeholder for the art window
      var imgHtml = img
        ? '<img src="/sprites/img/' + esc(img) + '.png" alt="' + esc(name) + '" onerror="this.style.display=\\'none\\'; this.parentNode.querySelector(\\'.art-fallback\\').style.display=\\'block\\'">'
          + '<svg class="art-fallback" style="display:none" viewBox="0 0 100 100"><rect width="100" height="100" rx="14" fill="#15171e"/><text x="50" y="62" text-anchor="middle" font-size="40" font-weight="800" fill="' + esc(tierColor) + '">' + esc((tierLabel||'?')[0]) + '</text></svg>'
        : '<svg viewBox="0 0 100 100"><rect width="100" height="100" rx="14" fill="#15171e"/><text x="50" y="62" text-anchor="middle" font-size="40" font-weight="800" fill="' + esc(tierColor) + '">' + esc((tierLabel||'?')[0]) + '</text></svg>';

      // Art window overlays
      var artStatusHtml = '';
      if (mastered) artStatusHtml = '<div class="art-status mastered">✦ Mastered</div>';
      else if (owned) artStatusHtml = '<div class="art-status owned">✓ Collected</div>';

      // Ribbon (top-right diagonal) for special states
      var ribbonHtml = '';
      if (vaulted && !owned) ribbonHtml = '<div class="info-ribbon vaulted">Vaulted</div>';
      else if (starter) ribbonHtml = '<div class="info-ribbon">Starter</div>';
      else if (mastered) ribbonHtml = '<div class="info-ribbon mastered">Mastered</div>';

      // Progress bar for owned + not mastered
      var progressHtml = '';
      if (owned && !mastered) {
        var pct = Math.min(100, Math.round((xp / 4000) * 100));
        progressHtml = '<div class="info-progress"><i style="width:' + pct + '%"></i></div>'
                     + '<div class="info-progress-lbl">' + fmtNum(xp) + ' / 4,000 XP · ' + pct + '%</div>';
      }

      // Tier bonus (Pokemon-move-style box)
      var tierMoveHtml = tierMeta.effect
        ? '<div class="info-move">'
          + '<div class="info-move-hdr">'
            + '<span class="icon" style="background:' + esc(tierColor) + '">✦</span>'
            + '<span class="name">' + esc(tierLabel) + ' Bonus</span>'
            + '<span class="power">×</span>'
          + '</div>'
          + '<p class="info-move-desc">' + esc(tierMeta.effect) + '</p>'
        + '</div>'
        : '';

      // Family ability box — parse per-level scaling into a compact table
      function parseAbil(text){
        if (!text) return { base:'', levels:[] };
        var luIdx = text.search(/Level Ups?[!:]/i);
        if (luIdx === -1 || text.indexOf('->') === -1) return { base:text.trim(), levels:[] };
        var preLU = text.slice(0, luIdx);
        var m = preLU.match(/^([\s\S]*[.!?])\s*(.+?)$/);
        var base = (m ? m[1] : preLU).trim();
        var afterLU = text.slice(luIdx).replace(/^Level Ups?[!:]\s*/i, '');
        var levels = afterLU.split(/\s*->\s*/).map(function(s){return s.trim();}).filter(Boolean);
        return { base:base, levels:levels };
      }
      var abilityMoveHtml = '';
      if (ability) {
        var parsed = parseAbil(ability);
        var lvlHtml = '';
        if (parsed.levels.length) {
          lvlHtml = '<div class="lvl-list">';
          for (var li = 0; li < parsed.levels.length; li++) {
            lvlHtml += '<span class="lvl-tag">Lv ' + (li+1) + '</span>'
                    + '<span class="lvl-val">' + esc(parsed.levels[li]) + '</span>';
          }
          lvlHtml += '</div>';
        }
        abilityMoveHtml = '<div class="info-move">'
          + '<div class="info-move-hdr">'
            + '<span class="icon">⚔</span>'
            + '<span class="name">Family Passive</span>'
          + '</div>'
          + (parsed.base ? '<p class="info-move-desc">' + esc(parsed.base) + '</p>' : '')
          + lvlHtml
        + '</div>';
      }

      // Datamined / vaulted flavor text
      var flavorHtml = '';
      if (pakDatamined) {
        flavorHtml = '<div class="info-move" style="border-color:rgba(192,132,252,.3);background:linear-gradient(180deg,rgba(192,132,252,.06),rgba(0,0,0,.15))">'
          + '<div class="info-move-hdr"><span class="icon" style="background:#c084fc">i</span>'
          + '<span class="name">Datamined</span></div>'
          + '<p class="info-move-desc" style="font-style:italic;color:#c084fc">Defined in Fortnite\\'s pak files but not yet enabled server-side. Confirmed real — just not extractable from matches yet.</p>'
        + '</div>';
      } else if (vaulted && !owned) {
        flavorHtml = '<div class="info-move" style="border-color:rgba(255,91,110,.3)">'
          + '<div class="info-move-hdr"><span class="icon" style="background:#ff5b6e">!</span>'
          + '<span class="name">Vaulted</span></div>'
          + '<p class="info-move-desc" style="font-style:italic">Currently not appearing in Battle Royale matches. Prior-window copies still count.</p>'
        + '</div>';
      }

      // Availability-note callout — shown for sprites with unusual constraints
      // (event/timed releases). Renders even for owned copies so the user has
      // context on why their variant is rare. Sourced from META.notes so the
      // full text lives once per family in the injected payload, not on every
      // tile's data-* attributes.
      var noteHtml = '';
      var note = META.notes && META.notes[famToken];
      if (note) {
        noteHtml = '<div class="info-move" style="border-color:rgba(255,207,58,.4);background:linear-gradient(180deg,rgba(255,207,58,.08),rgba(0,0,0,.15))">'
          + '<div class="info-move-hdr"><span class="icon" style="background:#ffcf3a;color:#1a1613">⚠</span>'
          + '<span class="name">' + esc(note.label) + '</span></div>'
          + '<p class="info-move-desc" style="color:#ffcf3a">' + esc(note.text) + '</p>'
        + '</div>';
      }

      // Stats row — always shows something meaningful
      var statsHtml =
        '<div class="info-stats">'
          + '<div class="info-stat"><b>' + (owned ? fmtNum(xp) : '—') + '</b><span class="lbl">XP</span></div>'
          + '<div class="info-stat"><b>' + fmtNum(dupes) + '</b><span class="lbl">In Locker</span></div>'
          + '<div class="info-stat"><b>' + (summon ? fmtNum(summon) : '—') + '</b><span class="lbl">Dust ✦</span></div>'
        + '</div>';

      // Set card frame color via CSS var + rarity data attribute
      var card = modal.querySelector('.info-card');
      card.dataset.rarity = rarity;
      // Holofoil / Gem / Cube get the holographic overlay
      var isHolo = ['holofoil','gem','cube','quack'].indexOf(tierKey) !== -1;
      card.classList.toggle('holo', isHolo);

      card.innerHTML =
        '<button class="info-close" aria-label="Close">&times;</button>'
        + ribbonHtml
        + '<div class="info-hdr">'
          + '<div class="fam-wrap">'
            + '<h3 class="fam-name">' + esc(famLabel) + '</h3>'
            + '<div class="fam-sub">' + esc(tierLabel) + ' · ' + esc(rarity) + '</div>'
          + '</div>'
          + '<div class="level-badge">'
            + '<span class="lvl-num">' + lvlNumHtml + '</span>'
            + '<span class="lvl-lbl">' + esc(lvlLblHtml) + '</span>'
          + '</div>'
        + '</div>'
        + '<div class="info-art">'
          + '<div class="art-tier-badge">' + esc(tierLabel) + '</div>'
          + imgHtml
          + artStatusHtml
        + '</div>'
        + '<div class="info-body">'
          + progressHtml
          + noteHtml
          + tierMoveHtml
          + abilityMoveHtml
          + flavorHtml
          + statsHtml
        + '</div>'
        + '<div class="info-foot">'
          + '<span class="codename">' + esc(name) + '</span>'
          + '<span class="rarity-dot">' + esc(rarity) + '</span>'
        + '</div>';
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function closeModal(){
      modal.classList.remove('open');
      document.body.style.overflow = '';
    }
    // Delegated click: any tile with data-info-trigger triggers modal. Guard
    // against the buy-back toggle button (inside cell) — its clicks shouldn't
    // open the modal.
    document.addEventListener('click', function(e){
      // Close button / backdrop
      if (e.target === modal || e.target.classList.contains('info-close')) {
        return closeModal();
      }
      // Ignore clicks originating in the buyback toggle (its own form handler runs)
      if (e.target.closest('.buyback-toggle') || e.target.closest('.buyback-toggle-form')) return;
      var cell = e.target.closest('[data-info-trigger="1"]');
      if (!cell) return;
      openModal(cell);
    });
    // Esc closes
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
    });
  }

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
    // NOTE: sprite/tier drop dates are deliberately NOT declared here. They
    // live in epic-sprites.js RELEASE_SCHEDULE and reach the client via
    // __SPRITE_META.releases, so the buffs strip and the per-tile countdowns
    // read from one source and can never disagree. Only recurring//windowed
    // gameplay events belong below.
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
    // ─── Sprite Spree Week (CH7S3: Runners finale, Aug 14–20 2026) ─────────
    // Sources: communities.epicgames.com/thread/whats-new-in-fortnite-runners-
    // august-14/Gvie + vice.com fortnite-sprite-spree-week-schedule. All-week
    // bonuses (below) run to Season 4's drop (Aug 20 9 AM ET = 13:00 UTC, same
    // instant as SEASON4_DROP_MS). Each day themes a rarer variant with a 24h
    // "Hours" spawn boost; Mythic Hours (Aug 15) lives in SATURDAY_EVENTS since
    // it uses the Saturday windows. 6 AM PT = 9 AM ET, so every edge is 9 AM ET.
    var SPREE_WEEK_START = wallMs(2026,8,14,9,0), SPREE_WEEK_END = wallMs(2026,8,20,7,0);
    var SPREE_WEEK_DESC = 'Sprites level up 2× faster · resummoning extracted Sprites costs 0 Dust · faster leveling at Campfires · Daily Quests grant Lucky Locators';
    function activeSpreeWeek(et){
      return (et.ms>=SPREE_WEEK_START&&et.ms<SPREE_WEEK_END)?{end:SPREE_WEEK_END}:null;
    }
    var SPREE_HOURS = [
      { s:wallMs(2026,8,16,9,0), e:wallMs(2026,8,17,9,0), label:'🌌 Galaxy Hours',   desc:'Galaxy Sprites appear more often — all day' },
      { s:wallMs(2026,8,17,9,0), e:wallMs(2026,8,18,9,0), label:'💿 Holofoil Hours', desc:'Holofoil Sprites appear more often — equip one to help find other rare Sprites' },
      { s:wallMs(2026,8,18,9,0), e:wallMs(2026,8,19,9,0), label:'⬢ Cube Hours',       desc:'Cube Sprites appear more often — equip one for Overdrive in the Storm' },
      { s:wallMs(2026,8,19,9,0), e:wallMs(2026,8,20,7,0), label:'💎 Gem Hours',        desc:'Gem Sprites appear more often — equip one for −30% fall damage' }
    ];
    function activeSpreeHours(et){
      for(var i=0;i<SPREE_HOURS.length;i++){ var h=SPREE_HOURS[i]; if(et.ms>=h.s&&et.ms<h.e) return h; }
      return null;
    }
    // Mythic Hours (Aug 15) session starts, for the "Coming up" list.
    var MYTHIC_SESSIONS = [wallMs(2026,8,15,14,0), wallMs(2026,8,15,21,0)];
    // One-off weekday events (Season 4 Override). Source: vice.com
    // /fortnite-cheat-master-sprites-august-27-update. 6 AM PT = 9 AM ET reset.
    // Aug 24 Cheat Code Day · Aug 27 New Sprite Day (4 Cheat Master Sprites debut:
    // Klombo, Shadow, Jackrabbit, Killswitch).
    var CHEATCODE_DAY = wallMs(2026,8,24,9,0);
    var NEWSPRITE_DAY = wallMs(2026,8,27,9,0);
    // ─── Chapter 7 Season 4: Override (v42.00, live Aug 20 7 AM ET) ─────────
    // Persistent "new season" banner shown as the baseline once Override goes
    // live — yields to any acute event (Power Hours, Mastery Monday). The 16 new
    // sprites (Sonic/Tails/Shadow/Klombo/…) auto-absorb from Epic's catalog when
    // it flips; this is season CONTEXT, not sprite data.
    var OVERRIDE_START = wallMs(2026,8,20,7,0);
    var OVERRIDE_DESC = 'New generation of Sprites (Sonic, Tails, Shadow, Klombo & more) rolling out · Sprite Garden keeps your old collection · redeem Lobby Hacks codes in the lobby for Sprite Dust & rare variants';
    function activeOverride(et){ return et.ms>=OVERRIDE_START?{}:null; }
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
      },
      // Sprite Spree Week finale (CH7S3): Mythic Hours runs the Saturday
      // afternoon+evening windows. Source: communities.epicgames.com
      // /thread/whats-new-in-fortnite-runners-august-14/Gvie + vice.com
      // sprite-spree-week schedule. 11 AM–1 PM PT = 2–4 PM ET, 6–8 PM PT = 9–11 PM ET.
      '2026-08-15': {
        label: '🟣 Mythic Hours',
        description: 'Mythic Sprites appear far more often — two 2-hour windows (2–4 PM & 9–11 PM ET). Sprite Spree Week finale'
      },
      // Chapter 7 Season 4: Override — first Power Hours of the new season.
      // Source: beebom.com/fortnite-chapter-7-season-4-patch-notes (Aug 22, Gold).
      '2026-08-22': {
        label: '⚡ Gold Hours',
        description: 'Gold Sprite variants appear more often — Season 4: Override Power Hours (2–4 PM & 9–11 PM ET)'
      },
      // Source: vice.com/fortnite-cheat-master-sprites-august-27-update — Sonic-themed
      // Power Hours the Saturday after the Aug 27 Cheat Master debut.
      '2026-08-29': {
        label: '🦔 Sonic Power Hours',
        description: 'Sonic-themed Power Hours — Sonic Sprite variants appear more often (2–4 PM & 9–11 PM ET)'
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
      var sh=activeSpreeHours(et), sw=activeSpreeWeek(et), ov=activeOverride(et);
      // CURRENT panel priority: acute events headline first. During the Spree
      // finale the daily 24h "Hours" (sh) outrank everything; the general
      // week bonus (sw) is a background event like Gone Wild, filling the panel
      // only when no acute Hours/Saturday event is live.
      if(sh){
        bufCur.className='cf-buffs-panel power';
        elCurTitle.textContent='🎉 Sprite Spree — active event';
        elCurHead.textContent=sh.label;
        elCurSub1.textContent=sh.desc;
        elCurSub2Wrap.style.display='';
        elCurCd.textContent=fmtDelta(sh.e-et.ms);
      } else if(sat){
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
      } else if(sw){
        bufCur.className='cf-buffs-panel mastery';
        elCurTitle.textContent='🎉 Sprite Spree Week';
        elCurHead.textContent='Runners finale — all-week bonuses';
        elCurSub1.textContent=SPREE_WEEK_DESC;
        elCurSub2Wrap.style.display='';
        elCurCd.textContent=fmtDelta(sw.end-et.ms);
      } else if(ov){
        bufCur.className='cf-buffs-panel power';
        elCurTitle.textContent='🎮 New season';
        elCurHead.textContent='Chapter 7 Season 4: Override';
        elCurSub1.textContent=OVERRIDE_DESC;
        elCurSub2Wrap.style.display='none';
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
      if(CHEATCODE_DAY>et.ms) candidates.push({label:'🎟️ Cheat Code Day',at:CHEATCODE_DAY,precise:true});
      // NOTE: the 4 "New Sprite Day" Cheat Masters (Klombo/Shadow/Jackrabbit/Killswitch)
      // released EARLY (grabbable in-game by Aug 25, ahead of the Aug 27 announce), so the
      // Aug-27 countdown was pulled — no confirmed content left for that date, and a
      // speculative clock is worse than none. Re-add only if Epic announces new Aug-27 content.
      // Sprite/tier drops come from the server's RELEASE_SCHEDULE (injected as
      // __SPRITE_META.releases) rather than dates duplicated here — one source
      // of truth with the tile countdowns, and past entries are pre-filtered
      // server-side so they can't linger.
      //
      // Those stamps are TRUE epochs, but everything in this strip is measured
      // against et.ms (Eastern wall-clock via Date.UTC — a shifted pseudo-
      // epoch). Rebase them with etShift so the subtraction downstream yields
      // the real remaining duration instead of one off by the ET offset.
      var etShift=et.ms-Date.now();
      (META.releases||[]).forEach(function(r){
        var atWall=r.at+etShift;
        if(atWall>et.ms) candidates.push({label:r.label,at:atWall,precise:true});
      });
      // Sprite Spree Week finale: surface the real daily "Hours" schedule. While
      // the finale runs, suppress the generic recurring events (Mastery Monday,
      // unannounced Saturday Power Hour) — the announced Hours ARE this week's
      // schedule, so a speculative "weekly" line would be noise. They resume
      // automatically once the week ends (inSpree=false → Season 4 cadence).
      var inSpree = et.ms < SPREE_WEEK_END;
      SPREE_HOURS.forEach(function(h){ if(h.s>et.ms) candidates.push({label:h.label,at:h.s,precise:true}); });
      MYTHIC_SESSIONS.forEach(function(t){ if(t>et.ms) candidates.push({label:'🟣 Mythic Hours',at:t,precise:true}); });
      if(!inSpree){
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
      }
      // Safety net: if every dated event has passed (e.g. mid-transition to a
      // new season before releases are re-seeded), fall back to the recurring
      // Mastery Monday so the panel never dereferences an empty list.
      if(!candidates.length) candidates.push({label:'🟢 Mastery Monday',at:nextWeekly(et,1,9,0),precise:true});
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
      // Per-cell release countdowns — same tick as the buffs strip so every
      // clock on the page advances in unison. Each span carries its own
      // unlock instant in data-release-at (server-computed), so this loop is
      // tier-agnostic: new gated tiers need zero client changes. Post-drop we
      // show "Available now" until the next sync refreshes state_json and
      // clears the .future flag.
      var relCells=document.querySelectorAll('.rel-cd[data-release-at]');
      if(relCells.length){
        var cache={};
        relCells.forEach(function(el){
          var at=+el.getAttribute('data-release-at');
          if(!at) return;
          if(!(at in cache)){
            // data-release-at is a TRUE epoch (Date.UTC on the server), so it
            // must be differenced against Date.now(), NOT et.ms. et.ms is
            // Eastern wall-clock run through Date.UTC — a shifted pseudo-epoch
            // — and mixing the two silently adds the ET offset (a 4h error in
            // EDT). See the note on nowET() above.
            var d=at-Date.now();
            cache[at]=d>0?fmtPrecise(d):'Available now';
          }
          el.textContent=cache[at];
        });
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
    var MIN_HIDDEN_MS = 60 * 1000;
    // 5 min (was 30s). An idle open owner tab used to force an Epic re-login every
    // 30 seconds — the single biggest source of session churn on the owner's own
    // account. Sprite data changes on a daily cadence; 5 min keeps the tab fresh
    // without hammering Epic. Tab-focus after >60s hidden still triggers an
    // immediate refresh, so returning to the tab is still snappy.
    var VISIBLE_POLL_MS = 5 * 60 * 1000;
    var currentFp = resyncForm.getAttribute('data-fp') || '';
    async function forceResync(reason){
      if (inFlight) return;
      inFlight = true;
      try {
        // Ask for JSON so the server returns a fingerprint instead of the page.
        // Only hard-reload when it actually changed — an idle tab with nothing
        // new no longer flashes/reloads every 30s. A tab-focus after alt-tabbing
        // from the game still reloads if you collected something.
        var res = await fetch('/sprites/resync', {
          method:'POST', credentials:'same-origin', body:'',
          headers:{ 'Accept':'application/json' },
        });
        if (res.ok) {
          var data = await res.json().catch(function(){ return null; });
          if (data && data.fingerprint && data.fingerprint !== currentFp) location.reload();
        }
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
// Section tabs shown on every Sprite Tracker page. `match` lists the paths that
// mark a tab as the current one (set client-side from location.pathname, so no
// route has to thread a "current page" argument through to chrome()).
const SITE_TABS = [
  { href: '/sprites', label: 'My collection', match: '/sprites /sprites/profile /sprites/account /sprites/discord-connect /sprites/admin' },
  { href: '/sprites/browse', label: 'Compare', match: '/sprites/browse /sprites/compare' },
  { href: '/sprites/cards', label: 'Cards', match: '/sprites/cards /sprites/override /sprites/garden' },
  { href: '/sprites/codes', label: 'Codes', match: '/sprites/codes' },
  { href: '/sprites/countdown', label: 'Next drop', match: '/sprites/countdown' },
  { href: '/sprites/info', label: 'Catalog audit', match: '/sprites/info' },
];
function chrome(nav = '') {
  // One header for every page: brand, the CertiFried Network menu (native
  // <details>, no JS), page-specific actions on the right (user menu or a
  // call to action), and the section tabs underneath.
  const networkMenu = `<details class="cf-network">
    <summary>CertiFried Network <span aria-hidden="true">▾</span></summary>
    <div class="cf-network-menu">
      <div class="cfn-section">Tools</div>
      <a href="https://certifriedmultitool.com/">Home</a>
      <a href="/dashboard">Bot dashboard</a>
      <a href="/sprites">Sprite Tracker <span class="cfn-here">you are here</span></a>
      <a href="/cah">Cards Against Humanity</a>
      <div class="cfn-divider"></div>
      <div class="cfn-section">Info</div>
      <a href="/commands">Bot commands</a>
      <a href="/status">Status</a>
      <a href="/donate">Donate</a>
      <a href="https://certifriedmultitool.com/discord" target="_blank" rel="noopener">Discord server ↗</a>
    </div>
  </details>`;
  const tabs = SITE_TABS.map((t) => `<a href="${t.href}" data-match="${t.match}">${t.label}</a>`).join('');
  return `<header class="st-header">
    <div class="st-bar">
      <a href="/sprites" class="logo"><span class="c">Certi</span><span class="f">Fried</span> · Sprite Tracker</a>
      ${networkMenu}
      ${nav ? `<div class="nav">${nav}</div>` : ''}
    </div>
    <nav class="st-tabs" aria-label="Sprite Tracker sections">${tabs}</nav>
  </header>
  <script>(function(){var p=location.pathname.replace(/\\/+$/,'')||'/';document.querySelectorAll('.st-tabs a').forEach(function(a){if((a.getAttribute('data-match')||'').split(' ').indexOf(p)!==-1)a.setAttribute('aria-current','page');});})();</script>`;
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
            inputmode="text" minlength="3" maxlength="32" class="st-input">
        </label>
        <label style="display:grid;gap:4px">
          <span style="font-weight:600">Password</span>
          <input type="password" name="password" required autocomplete="current-password" class="st-input">
        </label>
        <button class="btn" type="submit">Sign in →</button>
      </form>
      ${EAS_CONFIGURED ? `
        <div style="display:flex;align-items:center;gap:10px;margin:18px 0 12px;max-width:360px">
          <div style="flex:1;height:1px;background:#2a2f3c"></div>
          <span class="sub" style="font-size:12px">or</span>
          <div style="flex:1;height:1px;background:#2a2f3c"></div>
        </div>
        <a href="/sprites/connect" class="btn btn-quiet" style="max-width:360px;text-align:center">Sign in with Epic</a>
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
  // Show the "current password" gate only when there IS a stored password AND
  // the user signed in via username/password. Epic-paste login is sufficient
  // ownership proof, so it skips the gate (recovery path for forgotten password).
  const requireCurrent = hasPassword && !viaEpic;
  const nav = userMenu({ displayName, isAdmin, currentPath: '/sprites/account' });
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
  // "Obtainable right now" = total - future (unreleased / Epic-disabled) - vaulted.
  // Derived per-variant in buildModel (s.obtainable), so it tracks whatever Epic
  // has enabled today — no hardcoded tier list. Denominator = what a player can
  // actually pursue right now.
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
  // Only render tier columns that actually exist in this roster. CH7S4 Override
  // uses Base/Gold/Cheat Master, so the dead CH7S3 tiers (Gummy/Galaxy/Gem/
  // Holofoil/Cube/Quack) shouldn't show as empty columns. Dynamic = future-proof.
  const activeTiers = TIERS.filter((t) => state.groups.some((g) => g.variants[t.key]));
  const head = activeTiers.map((t) => `<th style="color:${t.color}">${t.label}</th>`).join('');
  // cellOpts is passed to cell() below inside the row map. Declared here so
  // it's available at the TIERS.map callback time (avoids TDZ against the
  // buybackSet declaration further down the function body).
  const buybackSet = new Set(buybackList.map((b) => b.variantName));
  const cellOpts = { buybackSet, showBuybackToggle: !readOnly };
  const rows = state.groups.map((g, i) => {
    const vs = activeTiers.map((t) => g.variants[t.key]).filter(Boolean);
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
      ${activeTiers.map((t) => cell(g.variants[t.key], cellOpts)).join('')}</tr>`;
  }).join('');
  const synced = state.syncedAt ? `synced ${new Date(state.syncedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  const profileHref = readOnly && shareUrl ? `${shareUrl}/profile` : '/sprites/profile';
  const nav = readOnly
    ? `<a class="navlink" href="${esc(profileHref)}">Profile</a>
       <a class="navlink primary" href="/sprites">Track your collection</a>`
    : `<a class="navlink" href="/sprites/discord-connect">Link Discord</a>
       ${userMenu({ displayName: state.player, isAdmin, currentPath: '/sprites' })}`;
  // Stale-token banner: only shown on the owner's own view (readOnly === false).
  // Viewers of /u/:slug don't see it because it's not their problem to fix.
  const reloginBanner = (!readOnly && needsRelogin)
    ? `<div class="relogin-banner">⚠️ <b>Your Epic connection has expired.</b> Your saved data is still here, but background re-syncs are failing. To pick up newly collected sprites and XP changes, sign out and reconnect with a fresh Epic code.
        <a href="/sprites/logout" class="btn" style="padding:7px 14px">Reconnect</a></div>`
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
    ${!readOnly ? `<form method="post" action="/sprites/resync" class="resync-form" data-fp="${esc(`${state.summary?.owned ?? 0}:${state.summary?.mastered ?? 0}:${state.summary?.total ?? 0}`)}"><button type="submit" class="resync-btn" title="Pull fresh data from Epic right now">↻ Re-sync</button></form>` : ''}
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
  return shell(`${state.player}'s Sprites — CertiFried`, chrome(nav) + `<main>
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
        <div class="stat dust"><b>${fmt(s.dust) || '—'}</b>Sprite Dust ✦</div>
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
      Data is 100% live from your account — no manual entry.</footer>
    ${spriteInfoModalBlock(state)}
    </main>` + SCRIPT, og);
}

// Build the per-page injected script + modal container that powers click-to-open
// info cards for every sprite tile. Family abilities come from pak-scan meta
// (Epic's own DataAsset text); labels come from state.groups; tier effects use
// the PAK_SPECIAL_TIER_EFFECTS list. JSON is safely stringified so " and </
// don't break out of the script/HTML context.
// Sprite rarity is inferred from Epic's BASE-tier `summonCost` (the family's
// cheapest re-summon price), which is the classic Epic rarity marker. Bands are
// anchored to the LIVE cost distribution + web-confirmed rarities:
//   100/1800 → Rare (Water, Fire, Earth, Air, Fishy)
//   2700     → Epic (Duck, Aura, Demon, Ghost, King, Striker)
//   4500     → Legendary (Dream, Boss, Seven, Punk, Llama, Peely)
//   6750     → Mythic (Zero Point, Batman, Grim, Burnt Peanut, John Wick, Pollo,
//                       Vini Jr., IRONMOUSE)
// Single source of truth for BOTH the info-card and /sprites/info — the old two
// heuristics disagreed (card said 5000/7500/15000, /info said 3000/5000/7500),
// so Ironmouse's 6750 fell into neither's Mythic band (card→Epic, /info→unknown).
function rarityFromBaseCost(cost) {
  if (cost == null) return 'unknown';
  if (cost >= 6750) return 'Mythic';
  if (cost >= 4500) return 'Legendary';
  if (cost >= 2700) return 'Epic';
  return 'Rare';
}
// CH7S4 "Override" player-facing rarity — the classic Rare/Epic/Legendary/Mythic
// system (NOT the internal Common/Uncommon/Rare/VeryRare roaming-weight bands, and
// NOT cost-derivable: Killswitch & Jackrabbit share base cost 1750 but are Epic vs
// Legendary). Confirmed 2026 by accountshark.net + gamerant + thebiglead. Keyed by
// catalog familyToken; takes precedence over the cost heuristic for these families.
const OVERRIDE_RARITY = {
  // catalog familyTokens
  '8bitblaster': 'Rare', dwarf: 'Rare', bushrangersprite: 'Rare', jonesy: 'Rare',
  narrowfleasprite: 'Epic', narrowfleamonkeysprite: 'Epic', reloadovertimesprite: 'Epic', killswitchsprite: 'Epic',
  cosmicthunderdoublejumpsprite: 'Legendary',
  klombo: 'Mythic', crownsprite: 'Mythic', stormscoutsprite: 'Mythic',
  // pak ESD codename aliases (/sprites/info keys on the pak codename, which differs)
  eightbitblaster: 'Rare', '8bitblastersprite': 'Rare', dwarfsprite: 'Rare', bushranger: 'Rare', jonesysprite: 'Rare',
  narrowflea: 'Epic', klombosprite: 'Mythic',
  doublejumpsprite: 'Legendary', jazzjackrabbit: 'Legendary',
};
function rarityForFamily(familyToken, baseCost) {
  return OVERRIDE_RARITY[familyToken] || rarityFromBaseCost(baseCost);
}

function spriteInfoModalBlock(state) {
  const groups = state?.groups || [];
  const pak = getPakScan();
  const familyMeta = pak?.per_family_meta || {};
  const families = {};
  const abilities = {};
  const notes = {};
  const rarities = {};
  for (const g of groups) {
    families[g.familyToken] = g.label;
    // Rarity from the family's BASE-tier cost — a family property, identical for
    // all its variants (so a special tier no longer mis-reports a higher rarity).
    rarities[g.familyToken] = rarityForFamily(g.familyToken, Object.values(g.variants || {}).find((v) => v.tierKey === 'basic')?.summonCost);
    // Look up pak per_family_meta by matching the codename to the family token,
    // tolerating the "Sprite"-suffix mismatch (ESD_PedicureAntacid → catalog
    // pedicureantacidsprite) by normalizing both sides.
    const ab = resolveFamilyAbility(g.familyToken, familyMeta);
    if (ab) abilities[g.familyToken] = ab;
    // Every variant in a group carries the same availabilityNote (family-level
    // constraint), so grab the first one that has it — saves repeating identical
    // objects across the payload.
    for (const v of Object.values(g.variants || {})) {
      if (v.availabilityNote) { notes[g.familyToken] = v.availabilityNote; break; }
    }
  }
  const tiers = {};
  for (const t of PAK_SPECIAL_TIER_EFFECTS) {
    tiers[t.tierKey] = { label: t.tier, color: t.color, effect: t.effect };
  }
  // Announced-but-unshipped drops, straight from epic-sprites.js
  // RELEASE_SCHEDULE (already filtered to future-only). Drives the buffs-strip
  // "NEXT" countdown so it can't drift from the per-tile countdowns.
  const releases = upcomingReleases();
  const json = JSON.stringify({ families, abilities, tiers, notes, releases, rarities })
    .replace(/</g, '\\u003c')   // prevent </script> break-out
    .replace(/-->/g, '--\\>');
  return `<div id="info-modal" class="info-modal" aria-hidden="true" role="dialog"><div class="info-card"></div></div>
    <script>window.__SPRITE_META=${json};</script>`;
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
  const nav = `<a class="navlink" href="${esc(shareUrl || '/sprites')}">Collection</a>
               <a class="navlink primary" href="/sprites">Track your own</a>`;
  const og = buybackShareUrl ? {
    type: 'website',
    title: `${state.player}'s Buy-back Wishlist — ${buybackList.length} items · ${totalDust.toLocaleString()} ✦ needed`,
    description: `Trade with ${state.player} to help them complete their Fortnite Sprite collection. ${buybackList.length} sprite variants wanted, ${totalDust.toLocaleString()} dust total, wallet at ${walletDust.toLocaleString()} ✦ (${pct}% funded).`,
    url: buybackShareUrl,
    image: buybackList.length ? `${buybackShareUrl}-export?v=${state.syncedAt ? Date.parse(state.syncedAt) : Date.now()}` : null,
    color: '#ffcf3a',
  } : null;
  return shell(`${state.player}'s Buy-back List — CertiFried`, chrome(nav) + `<main>
    <section class="hero" style="display:block;padding:22px 26px">
      <div class="who" style="margin-bottom:8px">🎯 Buy-back list<b>${esc(state.player)}</b><span class="since">${buybackList.length} sprites wanted · ${fmt(totalDust)} ✦ needed · ${pct}% funded</span></div>
      ${totalDust > 0 ? `<div class="bb-progress" style="max-width:none"><i style="width:${pct}%"></i></div>` : ''}
      <p class="sub" style="margin-top:12px">Wallet: <b style="color:#ffe48a">${fmt(walletDust)} ✦</b> · Sorted cheapest-first · Auto-updates when they play or trade.</p>
    </section>
    ${buybackList.length ? `<table class="bb-list-table" style="max-width:640px;margin:0 auto 24px">
      <tbody>${rows}</tbody>
    </table>` : '<p class="st-empty" style="margin:30px 0">No sprites on this buy-back list right now.</p>'}
    <p style="text-align:center;margin:24px 0;font-size:13px;color:var(--muted)">
      Traders — DM ${esc(state.player)} in Fortnite if you can spare any of these ·
      <a href="${esc(shareUrl || '/sprites')}" class="navlink">See their full collection →</a>
    </p>
  </main>`, og);
}

// Renders two cards (quest progression + sprite cosmetic locker) from the
// spriteExtras block that buildModel attaches to state.summary. Both come from
// the same athena profile fetch we already do — no extra Epic API cost.
// Returns empty string if the user has no sprite quests / cosmetics.
function renderSpriteExtras(extras) {
  if (!extras) return '';
  const { questsByPhase = {}, cosmeticThemes = {} } = extras;
  const questBuckets = Object.entries(questsByPhase);
  const themeEntries = Object.entries(cosmeticThemes);
  if (questBuckets.length === 0 && themeEntries.length === 0) return '';

  // Quest phase labels — Epic's internal keys are terse. Map to friendly names.
  const PHASE_LABEL = {
    mastery_p01: 'Sprite Mastery — Phase 1',
    mastery_p02: 'Sprite Mastery — Phase 2',
    mastery_p03: 'Sprite Mastery — Phase 3',
    extraction_p01: 'Extraction Quests — Phase 1',
    extraction_p02: 'Extraction Quests — Phase 2',
    extraction_p03: 'Extraction Quests — Phase 3',
  };
  // Sort mastery phases before extraction, then alphabetically within
  questBuckets.sort(([a], [b]) => {
    const aIsM = a.startsWith('mastery'), bIsM = b.startsWith('mastery');
    if (aIsM !== bIsM) return aIsM ? -1 : 1;
    return a.localeCompare(b);
  });
  const questCards = questBuckets.map(([key, s]) => {
    const label = PHASE_LABEL[key] || key.replace(/_/g, ' ');
    // "Progress" = claimed + completed (both are "done"), active = in progress,
    // remaining = total - done - active. unattainable variants are hidden
    // rewards that require the paid Battle Pass to claim.
    const done = (s.claimed || 0) + (s.completed || 0);
    const inProg = s.active || 0;
    const total = s.total || 0;
    const donePct = total ? Math.round((done / total) * 100) : 0;
    const inProgPct = total ? Math.round((inProg / total) * 100) : 0;
    const barCls = donePct === 100 ? 'ct-fill completed' : 'ct-fill';
    return `<div class="sprite-quest-row">
      <div class="sqr-label"><b>${esc(label)}</b>
        <span class="sub" style="font-size:11px;margin-left:6px">${done}/${total}${inProg ? ` · ${inProg} active` : ''}${s.unattainable ? ` · ${s.unattainable} 🔒 paid` : ''}</span>
      </div>
      <div class="ct-bar" style="margin-top:4px">
        <div class="${barCls}" style="width:${donePct}%"></div>
        ${inProg ? `<div class="ct-fill" style="width:${inProgPct}%;background:#ffcf3a;opacity:.55;position:absolute;top:0;left:${donePct}%"></div>` : ''}
      </div>
    </div>`;
  }).join('');

  // Cosmetic themes — group by theme name; each shows count + item list
  const themeCards = themeEntries.sort(([a], [b]) => a.localeCompare(b)).map(([theme, items]) => {
    // Deduplicate by templateId
    const uniq = [...new Map(items.map((i) => [i.templateId, i])).values()];
    const chips = uniq.map((i) => {
      const shortName = (i.templateId.split(':')[1] || i.templateId).replace(/_/g, ' ');
      const catShort = i.category.replace(/^Athena/, '');
      return `<span class="cosmetic-chip"><b>${esc(catShort)}</b>: ${esc(shortName)}</span>`;
    }).join('');
    return `<div class="sprite-cosmetic-row">
      <div class="scr-header"><b>${esc(theme)}</b> <span class="sub">${uniq.length} item${uniq.length === 1 ? '' : 's'}</span></div>
      <div class="scr-chips">${chips}</div>
    </div>`;
  }).join('');

  const hasQuests = questBuckets.length > 0;
  const hasCosmetics = themeEntries.length > 0;
  return `
    <section class="sprite-extras" style="display:grid;grid-template-columns:${hasQuests && hasCosmetics ? '1fr 1fr' : '1fr'};gap:16px;margin-bottom:24px">
      ${hasQuests ? `<div class="card" style="margin:0;background:var(--card);border:1px solid var(--line)">
        <div class="cardhead">📋 Your sprite quests</div>
        <div class="sprite-quest-list">${questCards}</div>
        <p class="sub" style="font-size:11.5px;margin:12px 0 0">
          From your athena profile. Bar green = done, yellow = active, dark = remaining.
          <b>🔒 paid</b> = quests that require the paid Battle Pass to claim rewards.
        </p>
      </div>` : ''}
      ${hasCosmetics ? `<div class="card" style="margin:0;background:var(--card);border:1px solid var(--line)">
        <div class="cardhead">🎨 Your sprite cosmetic locker</div>
        <div class="sprite-cosmetic-list">${themeCards}</div>
        <p class="sub" style="font-size:11.5px;margin:12px 0 0">
          Sprite-adjacent cosmetics you own — extraction frames + character
          themes tied to sprite content (usually Fortnite Crew rewards or
          sprite-themed shop bundles).
        </p>
      </div>` : ''}
    </section>`;
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
    ? `<a class="navlink" href="${esc(backToGrid)}">Collection</a>
       <a class="navlink primary" href="/sprites">Track your collection</a>`
    : userMenu({ displayName: state.player, isAdmin, currentPath: '/sprites/profile' });
  const reloginBanner = (!readOnly && needsRelogin)
    ? `<div class="relogin-banner">⚠️ <b>Your Epic connection has expired.</b> Your saved data is still here, but background re-syncs are failing. Sign out and reconnect with a fresh Epic code to refresh it.
        <a href="/sprites/logout" class="btn" style="padding:7px 14px">Reconnect</a></div>`
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
  return shell(`${state.player}'s Profile — CertiFried`, chrome(nav) + `<main>
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
        <div class="stat dust"><b>${fmt(s.dust) || '—'}</b>Sprite Dust ✦</div>
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
    ${renderSpriteExtras(state.summary?.spriteExtras)}
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
    return res.send(renderLogin({ error: `Session expired — please reconnect. (${e.message})` }));
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
        <p class="sub">That share link doesn't exist or hasn't synced yet.
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
        <p class="sub">That share link doesn't exist or hasn't synced yet.
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
  if (error) return res.send(renderLogin({ error: `Epic login was canceled (${String(error).slice(0, 120)}).` }));
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
    res.send(renderLogin({ error: `Epic sign-in failed: ${e.message}` }));
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
  // The background heartbeat calls this with Accept: application/json and only
  // reloads the page when the returned fingerprint changed — so an idle tab
  // stops hard-reloading (and flashing) every 30s when nothing actually moved.
  const wantsJson = (req.get('accept') || '').includes('application/json');
  if (!acct) return wantsJson ? res.json({ ok: false }) : res.redirect('/sprites');
  let fingerprint = null;
  try {
    const row = await getAccount(acct);
    if (!row) {
      delete req.session.epicAccountId;
      return wantsJson ? res.json({ ok: false }) : res.redirect('/sprites');
    }
    const synced = await syncWithAtomicRotation(row, row.display_name);
    await saveAccount(synced);
    // Fingerprint = what a user would actually see change: owned count, mastered
    // count, and the total (so a new-sprite drop that grows the catalog counts).
    const s = synced?.model?.summary;
    if (s) fingerprint = `${s.owned}:${s.mastered}:${s.total}`;
  } catch (e) {
    logger.warn(`[sprites] resync failed: ${e.message}`);
  }
  if (wantsJson) return res.json({ ok: true, fingerprint });
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
  'gummy': 'gummy', 'candy': 'gummy',
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

// ── Discord linking flow ──────────────────────────────────────────────────
// User visits /sprites/discord-connect while signed in. We generate a 6-digit
// code and stash it in a global map (shared with the bot command via a global
// singleton on globalThis.__spriteLinkCodes). User goes to Discord, types
// `/tools sprites link <code>`, bot verifies and creates the DB row.
// Codes expire after 5 minutes.
if (!globalThis.__spriteLinkCodes) globalThis.__spriteLinkCodes = new Map();
const SPRITE_LINK_CODES = globalThis.__spriteLinkCodes;
function issueLinkCode(accountId, displayName) {
  // Sweep expired codes
  const now = Date.now();
  for (const [code, entry] of SPRITE_LINK_CODES) {
    if (now - entry.issuedAt > 5 * 60 * 1000) SPRITE_LINK_CODES.delete(code);
  }
  // Also invalidate any prior code for this account so users can't accidentally
  // link a stale code from a previous visit.
  for (const [code, entry] of SPRITE_LINK_CODES) {
    if (entry.accountId === accountId) SPRITE_LINK_CODES.delete(code);
  }
  // 6 random digits, avoid leading zero for readability
  const code = String(Math.floor(100000 + Math.random() * 900000));
  SPRITE_LINK_CODES.set(code, { accountId, displayName, issuedAt: now });
  return code;
}

// ── One-click Discord OAuth linking ──────────────────────────────────────
// Kicks off the app-wide passport-discord flow; on callback control returns
// to /sprites/discord-oauth-finish which reads req.user + req.session and
// writes the link row. Zero manual code paste required.
router.get('/discord-oauth-init', (req, res) => {
  const acct = req.session?.epicAccountId;
  if (!acct) return res.redirect('/sprites');
  // Set returnTo so the app-wide /auth/discord/callback bounces here
  req.session.returnTo = '/sprites/discord-oauth-finish';
  res.redirect('/auth/discord?returnTo=/sprites/discord-oauth-finish');
});

router.get('/discord-oauth-finish', async (req, res) => {
  const acct = req.session?.epicAccountId;
  const discordUser = req.user;
  if (!acct) return res.redirect('/sprites');
  if (!discordUser?.id) return res.redirect('/sprites/discord-connect?err=oauth');
  try {
    // Confirm the sprite account still exists
    const [rows] = await pool.execute(
      'SELECT display_name FROM epic_sprite_accounts WHERE account_id = ?',
      [acct],
    );
    if (!rows.length) return res.redirect('/sprites');
    // If a *different* Discord user is already linked to this sprite account,
    // block the swap and tell the user how to unlink first.
    const [existing] = await pool.execute(
      'SELECT discord_user_id FROM epic_sprite_discord_links WHERE sprite_account_id = ?',
      [acct],
    );
    if (existing.length && existing[0].discord_user_id !== discordUser.id) {
      return res.redirect('/sprites/discord-connect?err=already-linked');
    }
    // If *this* Discord user is already linked to a *different* sprite account,
    // block that too — Discord users can only link to one sprite account.
    const [reverse] = await pool.execute(
      'SELECT sprite_account_id FROM epic_sprite_discord_links WHERE discord_user_id = ?',
      [discordUser.id],
    );
    if (reverse.length && reverse[0].sprite_account_id !== acct) {
      return res.redirect('/sprites/discord-connect?err=discord-user-taken');
    }
    await pool.execute(
      'INSERT INTO epic_sprite_discord_links (discord_user_id, sprite_account_id, linked_at) VALUES (?, ?, NOW()) ' +
      'ON DUPLICATE KEY UPDATE sprite_account_id = VALUES(sprite_account_id), linked_at = NOW()',
      [discordUser.id, acct],
    );
    logger.info(`[sprites] OAuth link: sprite=${acct} discord=${discordUser.id} (${discordUser.username})`);
    return res.redirect('/sprites/discord-connect?ok=linked');
  } catch (e) {
    logger.warn(`[sprites] /discord-oauth-finish failed: ${e.message}`);
    return res.redirect('/sprites/discord-connect?err=server');
  }
});

router.get('/discord-connect', async (req, res) => {
  const acct = req.session?.epicAccountId;
  if (!acct) return res.redirect('/sprites');
  try {
    const [rows] = await pool.execute(
      'SELECT display_name FROM epic_sprite_accounts WHERE account_id = ?',
      [acct],
    );
    if (!rows.length) return res.redirect('/sprites');
    const displayName = rows[0].display_name;
    // Check existing link status
    const [existing] = await pool.execute(
      'SELECT discord_user_id, linked_at FROM epic_sprite_discord_links WHERE sprite_account_id = ?',
      [acct],
    );
    // Only issue a code if the user explicitly asks for the fallback method
    // (?method=code) or requests a fresh one (?new=1). OAuth is the default.
    const wantsCode = req.query.method === 'code' || req.query.new === '1';
    const code = wantsCode && !existing.length ? issueLinkCode(acct, displayName) : null;
    // Query-param status banners (?ok=linked / ?err=xxx)
    const statusBanner = (() => {
      if (req.query.ok === 'linked') {
        return `<div class="card" style="background:rgba(58,208,122,.08);border:1px solid rgba(58,208,122,.35)">
          <h3 style="margin-top:0;color:#3ad07a">✓ Discord connected!</h3>
          <p>Head to a server with the CertiFried bot and run <code>/tools sprites embed collection</code> to post your first auto-updating tracker.</p>
        </div>`;
      }
      const errs = {
        oauth: 'Discord returned no user info. Try again.',
        'already-linked': 'This sprite account is already linked to a different Discord user. Run <code>/tools sprites unlink</code> in Discord from that account first.',
        'discord-user-taken': 'That Discord account is already linked to a different sprite tracker. Sign out of that other tracker\'s Discord link first.',
        server: 'Something went wrong on our end. Try again in a minute.',
      };
      if (req.query.err && errs[req.query.err]) {
        return `<div class="card" style="background:rgba(255,91,110,.08);border:1px solid rgba(255,91,110,.35)">
          <h3 style="margin-top:0;color:#ff5b6e">⚠ Link failed</h3>
          <p>${errs[req.query.err]}</p>
        </div>`;
      }
      return '';
    })();
    const linkedInfo = existing.length
      ? `<div class="card" style="background:rgba(58,208,122,.08);border:1px solid rgba(58,208,122,.35)">
          <h3 style="margin-top:0;color:#3ad07a">✓ Already linked</h3>
          <p>Your sprite tracker is linked to Discord user <code>${esc(existing[0].discord_user_id)}</code>
             since ${new Date(existing[0].linked_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.</p>
          <p>To move your link to a different Discord account: run <code>/tools sprites unlink</code> in Discord first,
             then click "Sign in with Discord" below or <a href="/sprites/discord-connect?method=code" class="navlink">use a code instead</a>.</p>
        </div>`
      : '';
    const nav = `<a class="navlink" href="/sprites/profile">Profile</a>`;
    const body = chrome(nav) + `<main>
      <div class="card" style="background:linear-gradient(180deg,#1a1638 0%,#161922 60%);border:1px solid #6b4cff">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
          <span style="background:#5865F2;color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;padding:3px 9px;border-radius:999px">🔗 DISCORD</span>
        </div>
        <h1 style="margin:0 0 6px">Link to Discord</h1>
        <p class="sub">Connect this sprite account to a Discord user so the bot can post auto-updating tracker embeds in your servers.</p>
      </div>
      ${statusBanner}
      ${linkedInfo}
      ${!existing.length ? `
      <div class="card">
        <h2 style="margin-top:0">🚀 Sign in with Discord (recommended)</h2>
        <p>One click — Discord's own OAuth confirms who you are, we save the link, done.</p>
        <a href="/sprites/discord-oauth-init" style="display:inline-flex;align-items:center;gap:10px;background:#5865F2;color:#fff;border-radius:12px;padding:14px 22px;font:800 15px/1 inherit;text-decoration:none;margin:10px 0;box-shadow:0 4px 12px rgba(88,101,242,.35);transition:transform .1s, box-shadow .15s"
           onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 18px rgba(88,101,242,.5)'"
           onmouseout="this.style.transform='';this.style.boxShadow='0 4px 12px rgba(88,101,242,.35)'">
          <svg width="20" height="20" viewBox="0 0 71 55" fill="#fff"><path d="M60.1 4.9A58.5 58.5 0 0 0 45.5.4a41.3 41.3 0 0 0-1.9 3.8 54.1 54.1 0 0 0-16.2 0A41.3 41.3 0 0 0 25.5.4 58.5 58.5 0 0 0 10.9 4.9C1.6 18.7-.9 32.2.3 45.5a58.9 58.9 0 0 0 17.8 9c1.4-2 2.7-4.1 3.7-6.3a38 38 0 0 1-5.8-2.8l1.4-1.1a41.9 41.9 0 0 0 36.2 0l1.4 1.1a38 38 0 0 1-5.8 2.8c1.1 2.2 2.4 4.3 3.7 6.3a58.9 58.9 0 0 0 17.8-9c1.6-15.5-2.5-28.9-9.6-40.6zM23.7 37.3c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.2 6.4-7.2c3.6 0 6.5 3.2 6.4 7.2 0 4-2.8 7.2-6.4 7.2zm23.6 0c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.2 6.4-7.2c3.6 0 6.5 3.2 6.4 7.2 0 4-2.8 7.2-6.4 7.2z"/></svg>
          Sign in with Discord to link
        </a>
        <p class="sub" style="font-size:12px;margin-bottom:0">You'll be redirected to Discord to authorize. We only ask for your basic profile — no server or DM access.
          Prefer to type a code manually? <a href="/sprites/discord-connect?method=code" class="navlink" style="font-size:12px">Use a 6-digit code instead</a>.</p>
      </div>` : ''}
      ${code ? `
      <div class="card">
        <h2 style="margin-top:0">Or link with a code</h2>
        <p>If OAuth doesn't work (guild bots without OAuth scope, etc.), you can paste this code into any Discord server that has the CertiFried bot:</p>
        <div style="background:#0e0f13;border:1px solid var(--line);border-radius:12px;padding:20px;text-align:center;margin:14px 0">
          <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:36px;font-weight:900;letter-spacing:.14em;color:var(--purple);text-shadow:0 0 12px rgba(123,92,255,.4)">${code}</div>
          <div style="margin-top:10px;font-size:12px;color:var(--muted)">Expires in 5 minutes · linked to <b>${esc(displayName)}</b></div>
        </div>
        <div style="background:#0e0f13;border:1px solid var(--line);border-radius:8px;padding:14px 16px;font-family:ui-monospace,monospace;font-size:14px;margin:14px 0">
          <code>/tools sprites link ${code}</code>
        </div>
        <p class="sub" style="font-size:12px">If your code expires, <a href="/sprites/discord-connect?method=code&new=1" class="navlink">get a new one</a>.</p>
      </div>` : ''}
      <div class="card">
        <h2 style="margin-top:0">What can I do after linking?</h2>
        <ul style="line-height:1.8">
          <li><b>Post an auto-updating collection embed</b> in any channel — <code>/tools sprites embed collection</code>. The bot edits the same message every time your sprites sync (roughly every 60 seconds when you're actively collecting).</li>
          <li><b>Post an auto-updating buy-back list embed</b> — <code>/tools sprites embed buyback</code>. Shows which variants you're saving dust for, grouped by rarity, with the funded percentage.</li>
          <li><b>Multiple channels supported</b> — post the same embed in multiple servers/channels. Each one auto-updates independently.</li>
          <li><b>Remove embeds anytime</b> — <code>/tools sprites remove-embed</code> or <code>/tools sprites unlink</code>.</li>
          <li><b>Check status</b> — <code>/tools sprites status</code> shows which channels have active embeds.</li>
        </ul>
      </div>
    </main>`;
    res.send(shell('Link to Discord — CertiFried Sprite Tracker', body));
  } catch (e) {
    logger.warn(`[sprites] /discord-connect failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + '<main><div class="card"><h2>Couldn\'t generate a code</h2><p class="sub">Try again in a minute.</p></div></main>'));
  }
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
         -- Hide accounts that can't currently sync (dead/expired credentials):
         -- their snapshot is frozen on the PREVIOUS collection, so showing it on
         -- the live leaderboard mixes an old denominator (e.g. Override /162)
         -- with the current one. They reappear automatically once they re-auth
         -- (saveAccount clears needs_relogin on the next successful sync).
         AND (needs_relogin = 0 OR needs_relogin IS NULL)
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
        text = `leveled up to Battle Pass Level ${data.to}${data.season ? ` in ${data.season}` : ''}`;
      } else { icon = '·'; text = String(e.event_type || '').replace(/_/g, ' '); }
      return `<li class="feed-row"><span class="feed-icon" aria-hidden="true">${icon}</span> ${userLink} ${esc(text)} ${time}</li>`;
    }).join('');
    const preRaw = req.query.preselect;
    const preselect = new Set((Array.isArray(preRaw) ? preRaw : (preRaw ? [preRaw] : [])).map((s) => String(s).slice(0, 64)).slice(0, 25));
    const list = rows.map((r) => `<li class="browse-row" data-name="${esc((r.display_name || r.share_id).toLowerCase())}" data-slug="${esc(r.share_id.toLowerCase())}">
        <label>
          <input type="checkbox" name="u" value="${esc(r.share_id)}"${preselect.has(r.share_id) ? ' checked' : ''}>
          <span class="browse-id">
            <b>${esc(r.display_name || r.share_id)}</b>
            <span class="sub">/u/${esc(r.share_id)}${r.pass_level ? ` · Lv ${esc(String(r.pass_level))}` : ''}</span>
          </span>
          <span class="browse-count">${esc(r.owned ?? '?')}<span class="sub">/${esc(r.obtainable ?? '?')}</span></span>
        </label>
      </li>`).join('');
    res.send(shell('Browse Collectors — CertiFried Sprite Tracker', chrome() + `<main>
      <div class="card">
        <h2>Compare collections</h2>
        <p class="sub">Pick two or more collectors below and we'll show who has what others don't — perfect for finding trade partners.</p>
        ${rows.length < 2 ? `<p class="warn">Need at least 2 collectors with public profiles to compare. (${rows.length} signed up so far.)</p>` : ''}
        ${preselect.size === 1 ? '<p class="warn" role="status">Pick at least one more collector to compare with.</p>' : ''}
        <form method="get" action="/sprites/compare" id="browse-form">
          <label for="browse-search" class="sr-only">Search collectors</label>
          <input type="search" id="browse-search" placeholder="Search collectors by name" class="browse-search" autocomplete="off">
          <ul class="browse-list" id="browse-list">${list || '<li class="st-empty">No public collectors yet. Connect your Epic account to be the first.</li>'}</ul>
          <p class="st-empty" id="browse-nomatch" hidden>No collectors match that search.</p>
          <div class="browse-actions"><button class="btn" type="submit" id="browse-go">Compare selected</button><span class="sub" id="browse-picked" aria-live="polite"></span></div>
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
      var nomatch = document.getElementById('browse-nomatch');
      input.addEventListener('input', function(){
        var q = input.value.toLowerCase().trim(), shown = 0;
        list.querySelectorAll('.browse-row').forEach(function(li){
          var n = li.dataset.name || '', s = li.dataset.slug || '';
          var on = !q || n.indexOf(q) >= 0 || s.indexOf(q) >= 0;
          li.style.display = on ? '' : 'none'; if (on) shown++;
        });
        if (nomatch) nomatch.hidden = !(q && shown === 0 && list.querySelector('.browse-row'));
      });
      var go = document.getElementById('browse-go'), picked = document.getElementById('browse-picked');
      function sync(){
        var n = list.querySelectorAll('input[name="u"]:checked').length;
        if (go) go.disabled = n < 2;
        if (picked) picked.textContent = n === 0 ? 'Pick two or more.' : (n === 1 ? '1 picked, pick one more.' : n + ' picked.');
      }
      list.addEventListener('change', sync); sync();
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
// ── Dynamic pak-audit values, loaded from the nightly pak-scan.json ────────
// The daily Windows scheduled task at B:\Code\pak-audit\run-daily.ps1 pushes
// a fresh pak-scan.json to /home/death/CertiFriedUtility/data/ every night
// at 00:00 PT. getPakScan() reads it with a 1-hour in-memory cache invalidated
// by mtime — so the info page always reflects the latest audit without needing
// a service restart.
// pak-scan.json can land in either data dir depending on which uploader ran: the
// code historically read ../data (= dashboard/data) while the nightly/boot scanner
// targeted ../../data (= CertiFriedUtility/data) — an off-by-one that let the file
// silently go 6 weeks stale. Resolve BOTH candidates and always use the most
// recently modified, so a fresh scan is picked up no matter which dir it lands in.
const PAK_SCAN_CANDIDATES = [
  path.resolve(__dirname, '../data/pak-scan.json'),     // dashboard/data
  path.resolve(__dirname, '../../data/pak-scan.json'),  // CertiFriedUtility/data (nightly/boot target)
];
let _pakScanCache = null;
let _pakScanCacheKey = '';   // "<path>:<mtime>" — a switch to a newer candidate busts the cache
let _pakScanCacheExpiresAt = 0;
function getPakScan() {
  const now = Date.now();
  try {
    // Pick the most recently modified candidate — wherever the freshest scan landed.
    let best = null, bestStat = null;
    for (const p of PAK_SCAN_CANDIDATES) {
      try { const s = fsSync.statSync(p); if (!bestStat || s.mtimeMs > bestStat.mtimeMs) { best = p; bestStat = s; } } catch (_) { /* candidate absent */ }
    }
    if (!best) throw new Error('no pak-scan.json in any candidate path');
    // Cache hit ONLY when path+mtime match AND TTL valid — a fresh push (or a newer
    // file in the other candidate dir) is noticed immediately, not up to 1h later.
    const key = `${best}:${bestStat.mtimeMs}`;
    if (_pakScanCache && key === _pakScanCacheKey && now < _pakScanCacheExpiresAt) {
      return _pakScanCache;
    }
    _pakScanCache = JSON.parse(fsSync.readFileSync(best, 'utf8'));
    _pakScanCacheKey = key;
    _pakScanCacheExpiresAt = now + 60 * 60 * 1000;
    return _pakScanCache;
  } catch (e) {
    logger.warn(`[sprites] pak-scan.json read failed: ${e.message}, using hardcoded fallback`);
    return PAK_SCAN_FALLBACK;
  }
}
// Families the pak-scan can't resolve by itself. Two cases, both rare:
//  - { aliasToken } : Epic's ESD asset name differs from the catalog token so the
//    nf-normalizer can't match them (Jackrabbit's catalog token is
//    cosmicthunderdoublejumpsprite but its ESD is ESD_DoubleJumpSprite). The
//    alias points at the pak key that DOES carry the description, so we still use
//    Epic's live text — no hardcoded copy.
//  - { text } : the ability FText is StringTable-backed, not inline in the ESD
//    blob the pak-scan reads, so the longest-string heuristic finds nothing
//    (Overshield). Here we must carry Epic's text literally.
const ABILITY_FALLBACK = {
  cosmicthunderdoublejumpsprite: { aliasToken: 'doublejump' },
  // Datamined string from fortnite.gg (corroborated by AccountShark). Its ability
  // FText is StringTable-backed, so the pak-scan's inline-string heuristic can't see it.
  overshieldsprite: { text: 'Grants overshield, scaling with level.' },
};
// Single resolution path for a family's ability text, used by the main sprite
// page, the cards catalogue, AND the admin audit — so all three agree.
function resolveFamilyAbility(token, familyMeta) {
  const nf = (s) => String(s).toLowerCase().replace(/sprite$/, '');
  for (const [pakName, m] of Object.entries(familyMeta || {})) {
    if (nf(pakName) === nf(token) && m?.description) return m.description;
  }
  const fb = ABILITY_FALLBACK[token];
  if (fb?.aliasToken) {
    for (const [pakName, m] of Object.entries(familyMeta || {})) {
      if (nf(pakName) === nf(fb.aliasToken) && m?.description) return m.description;
    }
  }
  if (fb?.text) return fb.text;
  return null;
}
// Hardcoded fallback used only if pak-scan.json is missing on disk (e.g. first
// deploy before nightly task fires, or file gets deleted). Kept in sync with
// the last known good scan.
const PAK_SCAN_FALLBACK = {
  audit_stamp: '2026-07-10 00:00:00 UTC',
  fortnite_build: '++Fortnite+Release-41.10-CL-55227503',
  matching_assets: 1916,
  unique_families: ['AirSprite','BossSprite','BurntPeanut','DemonSprite','DrifterSprite','DuckSprite','EarthSprite','FishySprite','GhostSprite','GrimSprite','KingSprite','PunkSprite','SevenSprite','SleepySprite','SoccerSprite','Spitfire','Water','ZeroPointSprite'],
  unique_tiers: ['A','Base','Gummy','Cube','Galactic','Galaxy','Gem','Gold','Holofoil','Quack'],
  per_family_pak: {},
};

const AUDIT_ACCOUNT_LABEL = 'XxXDeath420XxX';

// Vault status, read from the live model.
//
// This section used to be a standing argument that Air + Seven were vaulted at
// runtime but shipped in the pak. v41.20 un-vaulted both, which turned the whole
// section into fiction — it kept telling readers two fully-obtainable families
// were disabled. Now it reports whatever is actually vaulted, and says so when
// nothing is.
function renderVaultStatus(state) {
  const groups = state?.groups || [];
  const vaultedGroups = groups.filter((g) => Object.values(g.variants || {}).some((v) => v.vaulted));

  if (!vaultedGroups.length) {
    return `<p style="margin-bottom:0">
      <b>Nothing is currently vaulted.</b> Every family in Epic's catalog is
      reachable in Battle Royale right now. Air and Seven — long reported as
      vaulted by wiki and community sources — were re-enabled in v41.20 and are
      fully obtainable again.
    </p>
    <p class="sub" style="font-size:12px;margin:8px 0 0">
      Vaulting is a server-side DDSS hotfix flag, not a pak change: the assets
      never leave the build, Epic just stops spawning them. That's why a family
      can come back in a patch with no download. This section is generated from
      the live model, so it reflects the current flag state rather than a
      remembered one.
    </p>`;
  }

  return `<p>
      ${vaultedGroups.length === 1 ? 'One family is' : `${vaultedGroups.length} families are`}
      currently pulled from the Battle Royale loot pool. Copies already owned
      still count toward your collection.
    </p>
    <div class="audit-tokens" style="margin:8px 0 10px">
      ${vaultedGroups.map((g) => {
        const vs = Object.values(g.variants || {});
        return `<span class="audit-token absent">${esc(g.label)} · ${vs.filter((v) => v.vaulted).length}/${vs.length} tiers</span>`;
      }).join('')}
    </div>
    <p class="sub" style="font-size:12px;margin:0">
      Vaulting is a server-side DDSS hotfix flag, not a pak change — the assets
      stay in the build and Epic simply stops spawning them, so a family can
      return in a patch with no download.
    </p>`;
}

// Re-summon costs, read straight off the catalog's `summonCost` attribute
// instead of transcribed from IGN. The transcribed table was incomplete: it
// listed Rare as base=100, missing the 2,000-dust band entirely (Air + Fishy),
// so two families' buy-back prices were simply wrong on this page.
function renderDustCosts(state) {
  const groups = state?.groups || [];
  if (!groups.length) return '<p class="sub">No synced account yet.</p>';

  // Group families by their (base cost, special cost) pair — that pairing IS
  // the rarity band, so we don't have to guess where the thresholds sit.
  const bands = new Map();
  for (const g of groups) {
    const vs = Object.values(g.variants || {});
    const base = vs.find((v) => v.tierKey === 'basic')?.summonCost ?? null;
    const special = [...new Set(vs.filter((v) => v.tierKey !== 'basic' && v.summonCost).map((v) => v.summonCost))];
    if (base == null && !special.length) continue;
    const key = `${base}|${special.sort((a, b) => a - b).join(',')}`;
    if (!bands.has(key)) bands.set(key, { base, special, families: [] });
    bands.get(key).families.push(g.label);
  }
  const rows = [...bands.values()].sort((a, b) => (a.base ?? 0) - (b.base ?? 0));

  return `
    <p>
      Die with a Sprite equipped and it leaves your inventory — buy it back from
      the locker with Sprite Dust. These are Epic's own <code>summonCost</code>
      values from the live catalog, grouped by the families that share them.
    </p>
    <div style="overflow-x:auto">
    <table class="audit-table">
      <thead><tr>
        <th class="audit-num">Base tier</th>
        <th class="audit-num">Special tiers</th>
        <th>Families</th>
      </tr></thead>
      <tbody>
        ${rows.map((r) => `<tr>
          <td class="audit-num" data-label="Base tier">${r.base != null ? `${r.base.toLocaleString()} ✦` : '—'}</td>
          <td class="audit-num" data-label="Special tiers">${r.special.length ? r.special.map((s) => `${s.toLocaleString()} ✦`).join(' / ') : '<span class="sub">base only</span>'}</td>
          <td data-label="Families">${esc(r.families.sort().join(', '))}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    </div>
    <p class="sub" style="font-size:12px;margin-top:8px">
      "Special tiers" means everything above Basic — Gold, Gummy, Galaxy,
      Holofoil, Cube, Gem. Epic prices every one of them the same within a
      family.
    </p>`;
}

// Accounts for every variant in the catalog: how many are obtainable today, and
// for each one that isn't, exactly why. Replaces a hardcoded "our 82 vs IGN's
// 66" table whose every row went stale (Cube shipped, Batman/Vini Jr./Pollo
// shipped, Air + Seven were un-vaulted) and which pinned us to a third-party
// number we can't keep current. The underlying question — "why is your count
// what it is?" — is answered here from live state instead.
function renderCountBreakdown(state) {
  const groups = state?.groups || [];
  const all = groups.flatMap((g) => Object.values(g.variants || {}).map((v) => ({ ...v, famLabel: g.label })));
  if (!all.length) return '<p class="sub">No synced account yet — nothing to break down.</p>';

  const sched = activeSchedule();
  const tierLabelFor = (k) => (TIERS.find((t) => t.key === k) || {}).label || k;
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const rows = [];

  const obtainable = all.filter((v) => !v.future && !v.vaulted);
  rows.push({
    bucket: 'Obtainable right now',
    count: obtainable.length,
    primary: true,
    what: 'In Epic\'s live catalog and not gated — what a player can actually find and extract today.',
  });

  // Everything not obtainable, grouped by tier, each with its own reason.
  const byTier = {};
  for (const v of all.filter((v) => v.future)) (byTier[v.tierKey] ||= []).push(v);
  for (const [tierKey, vs] of Object.entries(byTier).sort((a, b) => b[1].length - a[1].length)) {
    const s = sched.tiers[tierKey];
    const pakOnly = vs.every((v) => v.pakDatamined);
    let what;
    if (pakOnly) {
      what = 'Present in the <code>.pak</code> but absent from Epic\'s live catalog — datamined only, no server entry yet.';
    } else if (s && s.at == null) {
      what = 'In the catalog and visible in the in-game collection menu, but locked. Epic hasn\'t announced a date, so no countdown is shown.';
    } else if (s && s.at > Date.now()) {
      what = `Announced — unlocks <b>${esc(stamp(s.at))}</b>. Flips to obtainable automatically.`;
    } else {
      what = 'Not yet live in the loot pool.';
    }
    const fams = [...new Set(vs.map((v) => v.famLabel))].sort();
    rows.push({
      bucket: `${tierLabelFor(tierKey)} — not out yet`,
      count: vs.length,
      what: `${what}<span class="audit-sub">${esc(fams.join(', '))}</span>`,
    });
  }

  const vaulted = all.filter((v) => v.vaulted);
  if (vaulted.length) {
    const fams = [...new Set(vaulted.map((v) => v.famLabel))].sort();
    rows.push({
      bucket: 'Vaulted',
      count: vaulted.length,
      what: `Pulled from the loot pool by Epic. Copies already owned still count.<span class="audit-sub">${esc(fams.join(', '))}</span>`,
    });
  }

  const owned = all.filter((v) => v.owned).length;
  return `
    <p>
      Epic's catalog returns <b>${all.length} variants</b> for
      <b>${esc(AUDIT_ACCOUNT_LABEL)}</b>'s account. Every one is accounted for
      below — this table is generated from the live model on each page load, so
      it can't drift from what the grid shows.
    </p>
    <div style="overflow-x:auto">
    <table class="audit-table" style="font-size:13px">
      <thead><tr><th>Bucket</th><th class="audit-num">Count</th><th>What it is</th></tr></thead>
      <tbody>
        ${rows.map((r) => `<tr${r.primary ? ' style="background:rgba(58,208,122,.10)"' : ''}>
          <td data-label="Bucket">${r.primary ? `<b>${esc(r.bucket)}</b>` : esc(r.bucket)}</td>
          <td class="audit-num${r.primary ? '' : ' audit-hit'}" data-label="Count">${r.primary ? `<b>${r.count}</b>` : `+${r.count}`}</td>
          <td data-label="What it is">${r.what}</td>
        </tr>`).join('')}
        <tr style="background:rgba(107,76,255,.12)">
          <td data-label="Bucket"><b>Catalog total</b></td>
          <td class="audit-num" data-label="Count"><b>${all.length}</b></td>
          <td data-label="What it is">Every variant Epic ships to this account, obtainable or not. <b>${owned}</b> currently collected.</td>
        </tr>
      </tbody>
    </table>
    </div>`;
}
// Community-rumored sprites, VERIFIED AGAINST LIVE DATA on every render rather
// than asserted as absent.
//
// This used to be a hardcoded "zero hits" list and it published a flatly false
// claim: it grepped the pak for the marketing name "Batman", found nothing, and
// concluded the sprite was fabricated. Epic ships families under internal
// codenames — Batman is `FossilMealSprite`, Vini Jr. is `CokeParmesan`, Pollo is
// `CompanyStargazer` — so searching asset paths for a marketing name is a
// guaranteed false negative. The real name lives in the DataAsset's DisplayName
// FText (`FossilMealSprite` → "Batman Sprite"), which is exactly where we look
// now. A rumor is only reported absent when it appears in NEITHER Epic's live
// catalog NOR any pak DisplayName.
// Names the community asks about but that Epic has neither shipped nor announced
// — pure "does this exist?" folklore. Confirmed-upcoming sprites live in the DB
// (epic_sprite_announced) and are merged in below, so this stays small.
const RUMOR_WATCHLIST = ['Joker', 'Goose'];

// Resolve each watched name against live data. One row per name, three states:
//   'shipped'   -> in Epic's catalog/pak now (with the codename that masked it)
//   'announced' -> officially confirmed + dated, but not in the catalog yet
//   'absent'    -> no evidence anywhere: not shipped, not announced
// Checked in that order, so a sprite that actually ships is reported as shipped
// even if a stale announcement row lingers.
function verifyRumors(state) {
  const meta = getPakScan()?.per_family_meta || {};
  const groups = state?.groups || [];
  const announced = getAnnouncedSprites();
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // Every name we report on: the folklore watchlist + everything announced.
  const names = [...new Set([...announced.map((a) => a.name), ...RUMOR_WATCHLIST])];

  return names.map((name) => {
    const n = norm(name);
    // 1) Epic's live catalog, matched on the family's display label.
    const group = groups.find((g) => norm(g.label).includes(n));
    // 2) The pak's DisplayName strings — this is what unmasks codenames.
    let codename = null;
    for (const [pakName, m] of Object.entries(meta)) {
      if (m?.display_name && norm(m.display_name).includes(n)) { codename = pakName; break; }
    }
    if (group || codename) {
      const variants = group ? Object.values(group.variants || {}) : [];
      return {
        name,
        status: 'shipped',
        codename: codename || group?.familyToken || null,
        label: group?.label || null,
        total: variants.length,
        owned: variants.filter((v) => v.owned).length,
        live: variants.filter((v) => !v.future && !v.vaulted).length,
      };
    }
    // 3) Officially announced but not in the catalog yet.
    const ann = announced.find((a) => norm(a.name) === n);
    if (ann) return { name, status: 'announced', ...ann };

    return { name, status: 'absent' };
  });
}

// Auto-derived list of pak variants Epic hasn't shipped in the live catalog.
// Computed from pak-scan.json (per_family_pak) minus what Epic returns in the
// live catalog (source: one recent state_json's Epic-native variants). hasIcon
// is resolved by disk-checking whether the audit exported the icon to
// public/sprites/img/. Cached and invalidated on pak-scan.json mtime change,
// with a 10-min live-catalog re-fetch heartbeat.
let _dataminedCache = null;
let _dataminedCacheMtime = 0;
let _liveCatalogSet = null;
let _liveCatalogAt = 0;
async function getLiveCatalogTierSet() {
  const now = Date.now();
  if (_liveCatalogSet && now - _liveCatalogAt < 10 * 60 * 1000) return _liveCatalogSet;
  try {
    const [rows] = await pool.execute(
      "SELECT state_json FROM epic_sprite_accounts WHERE state_json IS NOT NULL ORDER BY synced_at DESC LIMIT 1"
    );
    if (!rows.length) return new Set();
    const state = JSON.parse(rows[0].state_json);
    const set = new Set();
    for (const g of state.groups || []) {
      for (const v of Object.values(g.variants || {})) {
        // Only Epic-native counts as "live" — backfilled pakDatamined variants
        // must NOT filter themselves out of the derive.
        if (v.pakDatamined) continue;
        set.add(`${g.familyToken}:${v.tierKey}`);
      }
    }
    _liveCatalogSet = set;
    _liveCatalogAt = now;
    return set;
  } catch (e) {
    logger.warn(`[sprites] live-catalog reference fetch failed: ${e.message}`);
    return new Set();
  }
}
async function getPakDataminedVariants() {
  const pak = getPakScan();
  if (!pak) return [];
  const liveSet = await getLiveCatalogTierSet();
  try {
    const stat = fsSync.statSync(PAK_SCAN_PATH);
    if (_dataminedCache && stat.mtimeMs === _dataminedCacheMtime && _dataminedCache._liveSize === liveSet.size) {
      return _dataminedCache;
    }
    _dataminedCacheMtime = stat.mtimeMs;
  } catch { /* pak-scan missing — fall through and derive from fallback */ }
  const raw = deriveDataminedVariants(pak);
  // ESD-exists + icon-exists in pak isn't strong enough evidence a variant
  // is actually enabled in-game — the pak retains prior-season art (Duck
  // Holofoil, Punk Gem, etc) that Epic no longer serves in the catalog.
  // Injecting those creates phantom tiles that render "Available now" but
  // are jail-barred, which is worse than showing nothing.
  //
  // ALLOWLIST — variants we've explicitly confirmed Epic is teasing but
  // hasn't yet enabled in the catalog. Add entries here ONLY when there's
  // affirmative evidence (patch note mention, boss encounter plugin, DDSS
  // hotfix reference, etc). Format: `familytoken:tierkey`.
  const PAK_ONLY_ALLOWLIST = new Set([
    'zeropointsprite:quack',  // datamined, teased since CH7S3 launch; no catalog entry yet
  ]);
  const filtered = raw
    // Filter out anything Epic already ships in the live catalog.
    .filter((v) => {
      const t = TIERS.find((x) => x.match.includes(v.tierToken));
      const tierKey = t ? t.key : v.tierToken;
      return !liveSet.has(`${v.familyToken}:${tierKey}`);
    })
    // Additionally require explicit allowlist entry (see above).
    .filter((v) => {
      const t = TIERS.find((x) => x.match.includes(v.tierToken));
      const tierKey = t ? t.key : v.tierToken;
      return PAK_ONLY_ALLOWLIST.has(`${v.familyToken}:${tierKey}`);
    })
    // Attach hasIcon by disk-checking whether the audit extracted a PNG.
    .map((v) => {
      const id = imgIdFor(v.name);
      const hasIcon = !!id && fsSync.existsSync(path.join(SPRITE_IMG_DIR, `${id}.png`));
      return { ...v, hasIcon };
    })
    .filter((v) => v.hasIcon);
  filtered._liveSize = liveSet.size;
  _dataminedCache = filtered;
  return filtered;
}
// Read per-family base summonCost from a recent state_json to enable pure
// data-driven rarity inference. Cached 10 min alongside the live-catalog set.
let _famBaseCosts = null;
let _famBaseCostsAt = 0;
async function getFamilyBaseCosts() {
  const now = Date.now();
  if (_famBaseCosts && now - _famBaseCostsAt < 10 * 60 * 1000) return _famBaseCosts;
  try {
    const [rows] = await pool.execute(
      "SELECT state_json FROM epic_sprite_accounts WHERE state_json IS NOT NULL ORDER BY synced_at DESC LIMIT 1"
    );
    if (!rows.length) return {};
    const state = JSON.parse(rows[0].state_json);
    const out = {};
    for (const g of state.groups || []) {
      // Prefer the actual "basic" (A/Base) tier — that's the family's cheapest
      // variant and its summonCost is the classic Epic rarity marker.
      const basicCost = g.variants?.basic?.summonCost;
      if (basicCost != null) out[g.familyToken] = basicCost;
    }
    _famBaseCosts = out;
    _famBaseCostsAt = now;
    return out;
  } catch (e) {
    logger.warn(`[sprites] family base-cost fetch failed: ${e.message}`);
    return {};
  }
}

// Parse Epic's ability descriptions into { base, levels[] }. The pak text
// almost always follows the pattern:
//   "<base sentence(s)>. <transition phrase> at each Level Up: A -> B -> C -> D -> E<optional trailing suffix>"
// The transition phrase varies ("Increases in power", "Duration increases",
// "Required damage decreases", etc.) so we cut on "Level Up:" / "Level Up!"
// and trim the base back to the last sentence-ending punctuation. If the
// description has no leveling structure (Air, Batman, Punk, Dream), returns
// the description as base with an empty levels array.
function parseAbilityText(desc) {
  if (!desc || typeof desc !== 'string') return { base: desc || '', levels: [] };
  const luIdx = desc.search(/Level Ups?[!:]/i);
  if (luIdx === -1 || !desc.includes('->')) return { base: desc.trim(), levels: [] };
  // Trim base back to the last sentence terminator before the Level Up marker
  const preLU = desc.slice(0, luIdx);
  const sentEndMatch = preLU.match(/^([\s\S]*[.!?])\s*(.+?)$/);
  const base = (sentEndMatch ? sentEndMatch[1] : preLU).trim();
  // Everything after Level Up marker split on ->
  const afterLU = desc.slice(luIdx).replace(/^Level Ups?[!:]\s*/i, '');
  const levels = afterLU.split(/\s*->\s*/).map((s) => s.trim()).filter(Boolean);
  return { base, levels };
}

// Render a parsed ability as: base paragraph + a Lv 1..Lv N table below.
function renderAbilityBody(desc) {
  const { base, levels } = parseAbilityText(desc);
  let html = base ? `<p class="info-move-desc">${esc(base)}</p>` : '';
  if (levels.length) {
    html += '<div class="lvl-list">';
    for (let i = 0; i < levels.length; i++) {
      html += `<span class="lvl-tag">Lv ${i + 1}</span><span class="lvl-val">${esc(levels[i])}</span>`;
    }
    html += '</div>';
  }
  return html;
}

// Return { family, rarity, ability, source } rows for /sprites/info's ability
// table. Descriptions come DIRECTLY from Epic's own text (extracted from the
// ESD_*.uasset DisplayName + Description fields during pak-audit). Rarity is
// inferred purely from Epic's own summonCost economy — no hardcoded map,
// so any new family Epic ships auto-classifies without a code change.
async function getPakFamilyAbilities() {
  const pak = getPakScan();
  const meta = pak?.per_family_meta || {};
  if (Object.keys(meta).length === 0) return [];
  const famCosts = await getFamilyBaseCosts();
  // Normalize BOTH sides of the lookup: famCosts is keyed by the CATALOG token
  // (`pedicureantacidsprite`), but the pak meta key is the codename
  // (`PedicureAntacid`). A raw lookup missed Ironmouse → null → "unknown" even
  // though its base cost (6750) is right there. Strip the trailing "sprite".
  const nf = (s) => String(s).toLowerCase().replace(/sprite$/, '');
  const famCostByNorm = {};
  for (const [k, v] of Object.entries(famCosts)) famCostByNorm[nf(k)] = v;
  const out = [];
  for (const [pakFamName, m] of Object.entries(meta)) {
    if (!m?.description) continue;
    const token = pakFamName.toLowerCase();
    const displayName = (m.display_name || pakFamName).replace(/\s+Sprite$/i, '').trim();
    out.push({
      family: displayName,
      familyToken: token,
      rarity: rarityForFamily(token, famCostByNorm[nf(pakFamName)]),   // explicit Override grades + cost fallback
      ability: m.description.trim(),
      source: 'Epic (extracted from pak ESD_*.uasset)',
    });
  }
  return out.sort((a, b) => {
    const order = { Rare: 0, Epic: 1, Legendary: 2, Mythic: 3, unknown: 9 };
    return (order[a.rarity] - order[b.rarity]) || a.family.localeCompare(b.family);
  });
}

// Extract { familyToken: "Real Name Sprite" } from pak-scan's per_family_meta.
// buildModel prefers this over hardcoded FAMILY_LABEL so a new family shipped
// by Epic auto-gets its real display name on the next pak-audit run (per build),
// no code changes needed. Falls back to {} if pak-scan is missing.
function getPakFamilyDisplayNames() {
  const pak = getPakScan();
  if (!pak?.per_family_meta) return {};
  const out = {};
  for (const [pakFamName, meta] of Object.entries(pak.per_family_meta)) {
    if (!meta?.display_name) continue;
    // pak family names are like "AirSprite", "CokeParmesan" — lowercase to
    // match familyToken (buildModel's `parseVariant` lowercases too).
    const base = pakFamName.toLowerCase();
    out[base] = meta.display_name;
    // Epic sometimes appends "Sprite" to the CATALOG token even when the ESD
    // codename doesn't (ESD_PedicureAntacid → catalog pedicureantacidsprite →
    // "Ironmouse Sprite"). Emit the suffixed key too so buildModel's lookup by
    // the catalog token matches either form — otherwise the raw codename leaks
    // to the UI ("pedicureantacidsprite" instead of "Ironmouse").
    if (!base.endsWith('sprite')) out[base + 'sprite'] = meta.display_name;
  }
  return out;
}

// Adapter — /sprites/info's audit table wants { family, tier, hasIcons } shape.
async function getPakUnreleasedForInfo() {
  const list = await getPakDataminedVariants();
  return list.map((v) => {
    // Extract "Family" + "Tier" from the pak variant name.
    const parts = v.name.split(/_Variant_|_Variation_/);
    return { family: parts[0], tier: parts[1] || v.tierToken, hasIcons: v.hasIcon };
  });
}

// ── Live endpoint size cache — fetched fresh on /sprites/info load ─────────
// The four sizes shown in the audit table (12,709 B catalog, 5,433 B magpie,
// 568,517 B athena, 696,242 B item shop) come from a live probe against
// Death420's account. Cached for 10 min so refreshing /sprites/info doesn't
// hammer Epic every request.
let _endpointSizeCache = null;
let _endpointSizeCacheExpiresAt = 0;
async function getEndpointSizes() {
  const now = Date.now();
  if (_endpointSizeCache && now < _endpointSizeCacheExpiresAt) return _endpointSizeCache;
  const sizes = { catalog: null, magpie: null, athena: null, shop: null, catalogVariants: null, stamp: null };
  try {
    // Reuse Death420's cached raw sizes if we've captured them recently;
    // otherwise fall back to the hardcoded values while a background sync
    // updates them. See the fetchSpriteData wrapper below.
    const [rows] = await pool.execute(
      `SELECT display_name, last_endpoint_sizes, synced_at
       FROM epic_sprite_accounts WHERE display_name=? LIMIT 1`,
      [AUDIT_ACCOUNT_LABEL],
    );
    if (rows.length && rows[0].last_endpoint_sizes) {
      const p = typeof rows[0].last_endpoint_sizes === 'string'
        ? JSON.parse(rows[0].last_endpoint_sizes) : rows[0].last_endpoint_sizes;
      sizes.catalog = p.catalog ?? null;
      sizes.magpie  = p.magpie  ?? null;
      sizes.athena  = p.athena  ?? null;
      sizes.catalogVariants = p.catalogVariants ?? null;
      sizes.stamp = rows[0].synced_at || null;
    }
    // Item shop is public, no auth. 5-min TTL is fine.
    const shopRes = await fetch('https://fortnite-api.com/v2/shop', { headers: { 'User-Agent': 'CertiFriedSpriteTracker/1.0' } });
    const shopBuf = await shopRes.text();
    sizes.shop = shopBuf.length;
  } catch (e) {
    logger.warn(`[sprites] endpoint size probe failed: ${e.message}`);
  }
  _endpointSizeCache = sizes;
  _endpointSizeCacheExpiresAt = now + 10 * 60 * 1000;
  return _endpointSizeCache;
}

// Full deep-dive findings (2026-07-10) — extracted from a comprehensive
// enumeration of all 4 CH7S3 plugins + broader Fortnite pak scan. Every list
// below is grounded in actual asset paths from the pak, not speculation.
// Special variant effects — cross-referenced with IGN's CH7S3 sprite guide
// (https://www.ign.com/wikis/fortnite/Sprites_Checklist_and_Guide...). Each
// non-basic tier adds a passive on top of the family's base ability.
// Tier passive effects — refreshed 2026-07-17 from IGN's post-v41.20 guide.
// These stack ON TOP of the family's base ability (from pak per_family_meta).
// Values are per-tier bonuses that apply regardless of family.
const PAK_SPECIAL_TIER_EFFECTS = [
  { tier: 'Gold',     tierKey: 'gold',     color: '#ffcf3a', effect: '3× Elimination XP (extraction bonus)' },
  // CH7S4 Override tier bonuses — confirmed live (datamine via spritechecklist.org /
  // fortnite.gg). Each is a tier-wide bonus that STACKS on the sprite's base ability.
  { tier: 'Cheat Master',  tierKey: 'cheatmaster', color: '#ff4d6d', effect: 'All Cheat Code inputs count as correct (never fumble a Cheat Code entry)' },
  { tier: 'Loot Hacker',   tierKey: 'loothacker',  color: '#22c55e', effect: 'Increases the chance of spawning items from your Loot Hacks' },
  { tier: 'Bounty Hunter', tierKey: 'reaper',      color: '#a855f7', effect: 'Chance to find Sprites when eliminating opponents; only gains Sprite XP from eliminations (unless the Sprite has special XP rules, e.g. Crown/Klombo)' },
  // Trick or Treat (Fortnitemares) tier is live in the catalog but Epic has NOT
  // published its bonus effect yet. effect:null = "known tier, no bonus to show" —
  // registers it so the audit stops flagging it, without inventing an effect.
  // Fill in when the Fortnitemares patch notes / datamine confirm it.
  { tier: 'Trick or Treat', tierKey: 'tricktreat', color: '#ff7518', effect: null },
  { tier: 'Gummy',    tierKey: 'gummy',    color: '#ff6cc4', effect: '20% more Sprite Dust when extracting' },
  { tier: 'Galaxy',   tierKey: 'galaxy',   color: '#7b5cff', effect: '30% more ammo when opening ammo boxes' },
  { tier: 'Holofoil', tierKey: 'holofoil', color: '#5bf0ff', effect: '5% higher chance of finding rare Sprite variants in chests' },
  { tier: 'Cube',     tierKey: 'cube',     color: '#c084fc', effect: 'Grants the Overdrive effect while inside the Storm — easier repositioning and safer extractions' },
  { tier: 'Gem',      tierKey: 'gem',      color: '#3ad0c4', effect: '30% less fall damage' },
  { tier: 'Quack',    tierKey: 'quack',    color: '#facc15', effect: 'Whenever this Sprite earns XP, every other Sprite in your match inventory gains an extra 50% of that XP' },
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
router.get('/info', async (req, res) => {
  try {
    res.send(await renderInfo());
  } catch (e) {
    logger.warn(`[sprites] /info render failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + '<main><div class="card"><h2>Info page unavailable</h2><p class="sub">Try again in a minute.</p></div></main>'));
  }
});

// ── /sprites/codes — Override Admin Panel / Lobby Hack codes ─────────────
// Season-specific free-reward codes (Cheat Master sprites, gizmos, dust, XP,
// cosmetics). Static list, community-verified; update when Epic adds/expires
// codes. Copy-to-clipboard, grouped by reward type.
const OVERRIDE_CODES = [
  { code: 'GottaGoFast', reward: 'Cheat Master Sonic Sprite', cat: 'Sprites' },
  { code: 'IWannaFlyHigh', reward: 'Cheat Master Tails Sprite', cat: 'Sprites' },
  { code: '8BitBlast', reward: 'Cheat Master 8-Bit Sprite', cat: 'Sprites' },
  { code: 'Born2Play', reward: 'Cheat Master Adventure Sprite', cat: 'Sprites' },
  { code: 'Play4All', reward: 'Cheat Master Jonesy Sprite', cat: 'Sprites' },
  { code: 'O2Override', reward: 'Llama Supply Drop + Portable Extractor', cat: 'Gizmos' },
  { code: 'TakeYourHeart', reward: '2× Extraction Accelerator', cat: 'Gizmos' },
  { code: 'PerfectOrder', reward: '4× Spicy Taco', cat: 'Gizmos' },
  { code: 'SurviveTheNight', reward: '2× Cheat Code Extractor', cat: 'Gizmos' },
  { code: 'FindItChat', reward: '2× Cheat Code Locator', cat: 'Gizmos' },
  { code: 'OverrideXP', reward: '40,000 XP', cat: 'XP & Dust' },
  { code: 'Perlimpinpin', reward: '2,000 Sprite Dust', cat: 'XP & Dust' },
  { code: 'Magilume', reward: '2,000 Sprite Dust', cat: 'XP & Dust' },
  { code: 'Chispambo', reward: '2,000 Sprite Dust', cat: 'XP & Dust' },
  { code: 'Abgestaubt', reward: '2,000 Sprite Dust', cat: 'XP & Dust' },
  { code: 'BeMoreAlien', reward: 'Override Ready Loading Screen', cat: 'Cosmetics' },
  { code: 'ReachYourImpossible', reward: 'Block Party Loading Screen', cat: 'Cosmetics' },
  { code: 'LetsBlockAndRoll', reward: 'Transform into a Tetris block', cat: 'Cosmetics', reusable: true },
  { code: 'DontBlockMe', reward: 'Revert to normal lobby appearance', cat: 'Cosmetics', reusable: true },
];
// Codes live in the epic_sprite_codes DB table (runtime-editable + auto-polled by
// pollLobbyHackCodes below). OVERRIDE_CODES above is only the compile-time
// FALLBACK used if the table is empty/unreachable.
let _codesCache = null, _codesCheckedAt = null, _codesLoadedAt = 0;
const CODES_CACHE_TTL_MS = 3 * 60 * 1000;   // DB edits reflect within ~3 min, no redeploy/restart
async function loadCodesFromDB() {
  try {
    // expires_at gate: an event-dated code (e.g. birthday codes) self-retires
    // from the public list the moment it lapses — the poller only ADDS codes, so
    // without this a time-limited code would linger as stale/invalid info. NULL =
    // no known expiry (permanent unlocks, easter-eggs, undated drops). The column
    // may be absent on an un-migrated box, so fall back to the un-gated query.
    let rows;
    try {
      [rows] = await pool.query(
        "SELECT code, reward, category, reusable, expires_at FROM epic_sprite_codes WHERE enabled=1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY FIELD(category,'Sprites','Gizmos','XP & Dust','Cosmetics','Other'), code");
    } catch (colErr) {
      [rows] = await pool.query(
        "SELECT code, reward, category, reusable FROM epic_sprite_codes WHERE enabled=1 ORDER BY FIELD(category,'Sprites','Gizmos','XP & Dust','Cosmetics','Other'), code");
    }
    _codesCache = rows.length ? rows.map((r) => ({ code: r.code, reward: r.reward, cat: r.category, reusable: !!r.reusable, expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null })) : null;
    _codesLoadedAt = Date.now();
  } catch (e) { logger.warn(`[codes] DB load failed: ${e.message}`); }
}
router.get('/codes', async (req, res) => {
  try {
    if (!_codesCache || Date.now() - _codesLoadedAt > CODES_CACHE_TTL_MS) await loadCodesFromDB();
    const CODES = _codesCache || OVERRIDE_CODES;
    const cats = ['Sprites', 'Gizmos', 'XP & Dust', 'Cosmetics', 'Other'];
    const catIcon = { 'Sprites': '\u{1F47E}', 'Gizmos': '\u{1F381}', 'XP & Dust': '✨', 'Cosmetics': '\u{1F3A8}' };
    const sections = cats.map((cat) => {
      const items = CODES.filter((c) => c.cat === cat);
      if (!items.length) return '';
      const rows = items.map((c) => {
        // Time-limited codes still show while valid (loadCodesFromDB already drops
        // lapsed ones); flag the end date so a user knows to grab it before it goes.
        const endTag = c.expiresAt ? ` <span class="code-tag ends">ends ${new Date(c.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>` : '';
        return `<div class="code-row">
        <button type="button" class="code-copy" data-code="${esc(c.code)}" title="Copy code" aria-label="Copy code ${esc(c.code)}"><code>${esc(c.code)}</code><span class="copy-ic">⧉</span></button>
        <span class="code-reward">${esc(c.reward)}${c.reusable ? ' <span class="code-tag">reusable</span>' : ''}${endTag}</span>
      </div>`;
      }).join('');
      return `<section class="code-cat"><h2>${catIcon[cat] ? `<span aria-hidden="true">${catIcon[cat]}</span> ` : ''}${esc(cat)} <span class="sub" style="font-weight:600;font-size:13px">(${items.length})</span></h2><div class="code-list">${rows}</div></section>`;
    }).join('');
    const nav = '';
    const body = `<main>
      <section class="hero" style="display:block;padding:20px 26px">
        <h1 style="margin:0 0 6px">\u{1F579}️ Override Cheat Codes</h1>
        <p class="sub" style="margin:0 0 10px">All <b>${CODES.length}</b> Admin Panel / Lobby Hack codes for Chapter 7 Season 4: Override — free Cheat Master sprites, gizmos, Sprite Dust, XP &amp; cosmetics, no grind.</p>
        <div class="code-howto"><b>How to redeem:</b> In the lobby, open the <b>…/ Admin Panel</b> prompt (top-right of the screen), type the code <b>exactly</b> (case-sensitive), and Submit. Most are <b>one-time</b>; the two Tetris codes are reusable. Redeeming a Sprite you already own grants <b>10,000 Sprite Dust</b> instead.</div>
      </section>
      ${sections || '<p class="st-empty">No codes are active right now. New ones show up here on their own.</p>'}
      <p class="sub" style="text-align:center;margin:16px 0 24px">Auto-tracked — this list refreshes itself from community sources (Dexerto, GamesRadar, PCGamesN, GameRant); new codes appear here on their own.${_codesCheckedAt ? ` Last checked ${new Date(_codesCheckedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : ''} Tap any code to copy it.</p>
    </main>
    <style>
      .code-cat{max-width:820px;margin:0 auto}
      .code-cat h2{font-size:16px;margin:18px 16px 8px;color:#e8eaf0}
      .code-list{display:flex;flex-direction:column;gap:8px;padding:0 16px}
      .code-row{display:flex;align-items:center;gap:14px;background:#12141a;border:1px solid #2a2f3c;border-radius:10px;padding:10px 14px;flex-wrap:wrap}
      .code-copy{display:inline-flex;align-items:center;gap:10px;background:#1a1d26;border:1px solid #3a4250;border-radius:8px;padding:7px 12px;cursor:pointer;color:#cbb5ff;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700;font-size:14px;transition:all .12s;min-width:190px;justify-content:space-between}
      .code-copy:hover{border-color:var(--purple,#8b5cf6);background:#211a34;color:#fff}
      .code-copy.copied{border-color:#3ad07a;color:#3ad07a;background:#0f2a1a}
      .code-copy code{background:none;padding:0;color:inherit;font:inherit}
      .code-copy .copy-ic{opacity:.55;font-size:13px}
      .code-reward{color:#c3cad6;font-size:14px;flex:1;min-width:180px}
      .code-tag{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:800;background:#0f2a1a;color:#4fd77a;border:1px solid #1f5a36}
      .code-tag.ends{background:#2a2410;color:#ffcf3a;border-color:#5a4a1f}
      .code-howto{background:#0e0f13;border:1px solid #2a2f3c;border-radius:10px;padding:11px 14px;font-size:13px;color:#c3cad6;line-height:1.5}
      .code-howto b{color:#e8eaf0}
    </style>
    <script>(function(){
      document.querySelectorAll('.code-copy').forEach(function(b){
        b.addEventListener('click', function(){
          var code=b.getAttribute('data-code');
          var ic=b.querySelector('.copy-ic');var old=ic.textContent;
          function done(ok){b.classList.toggle('copied',ok);ic.textContent=ok?'✓':'!';b.title=ok?'Copied':'Copy failed: select the code and copy it';setTimeout(function(){b.classList.remove('copied');ic.textContent=old;b.title='Copy code';},1400);}
          function legacy(){var t=document.createElement('textarea');t.value=code;t.setAttribute('readonly','');t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.select();var ok=false;try{ok=document.execCommand('copy');}catch(_){}document.body.removeChild(t);done(ok);}
          if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(code).then(function(){done(true);},legacy);}else{legacy();}
        });
      });
    })();</script>`;
    res.send(shell('Override Cheat Codes — CertiFried Sprite Tracker', chrome(nav) + body));
  } catch (e) {
    logger.warn(`[sprites] /codes render failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + '<main><div class="card"><h2>Codes page unavailable</h2></div></main>'));
  }
});

// ── Lobby Hack codes auto-poller ─────────────────────────────────────────
// Scrapes community code trackers, cross-validates (a NEW code must appear on
// >=2 independent sources), and upserts epic_sprite_codes so /codes stays current
// with no redeploy. Known codes get last_seen bumped; genuinely new confirmed
// codes are added (auto=1) and DM'd for review. Best-effort — a source that 403s
// a bot is skipped; a false positive is easy to disable in the table.
const CODE_SOURCES = [
  'https://www.dexerto.com/fortnite/fortnite-admin-panel-cheat-codes-august-2026-3400374/',
  'https://www.gamesradar.com/games/fortnite/fortnite-lobby-hack-codes/',
  'https://www.pcgamesn.com/fortnite/lobby-hack-codes',
  'https://gamerant.com/fortnite-all-lobby-hack-codes/',
  // Added 2026-09-17 — beebom/nintendolife often publish new codes early (they had
  // BLINKYINKYPINKYCLYDE / SAYH12WR1X3L before the others). Broader net for the ≥2-source poller.
  'https://beebom.com/fortnite-lobby-hack-codes/',
  'https://www.nintendolife.com/guides/fortnite-lobby-hack-codes-admin-panel',
  // Vice runs a per-update "all new codes" article — had MagicIsReal / DestinyAwaits /
  // ChatFindMeAnotherCode before the others. Authoritative for fresh-drop codes.
  'https://www.vice.com/en/article/fortnite-admin-panel-codes-september-17-update/',
];
const CODE_REWARD_KW = /(Cheat Master|Sprite Dust|Sprite|\bXP\b|Gizmo|Taco|Extractor|Locator|Loading Screen|Llama|Tetris|Accelerator|Portable)/i;
const CODE_STOPWORDS = new Set(['sprite', 'sprites', 'cheat', 'master', 'codes', 'code', 'admin', 'panel', 'fortnite', 'lobby', 'hack', 'hacks', 'override', 'season', 'chapter', 'battle', 'royale', 'reward', 'rewards', 'loading', 'screen', 'block', 'party', 'tetris', 'free', 'gizmo', 'gizmos', 'dust', 'extractor', 'locator', 'portable', 'llama', 'supply', 'spicy', 'taco', 'tacos', 'with', 'that', 'this', 'your', 'from', 'what', 'each', 'used', 'once', 'only', 'type', 'into', 'then', 'they', 'will', 'more', 'also', 'list', 'click', 'enter', 'august', 'september', 'october', 'here', 'these', 'available', 'unlock', 'unlocks', 'redeem', 'grants',
  // category headers + JSON-LD/page-structure words (systematic false positives)
  'cosmetics', 'sprite dust', 'other', 'position', 'item', 'name', 'context', 'schema', 'listitem', 'webpage', 'article', 'guide', 'latest', 'updated', 'section', 'header', 'category', 'itemlistelement', 'primaryimageofpage', 'imageobject', 'caption', 'following', 'below', 'above', 'about',
  // Intro/outro PROSE words that leaked as candidates (poller scans the whole page,
  // so boilerplate sentences — shared across code sites — clear the >=2-source bar).
  // Observed false-positive DMs: "already", "Extraction", "Locators", "SIGNUP".
  // These only ever block a STANDALONE single-word token, never a concatenated code
  // (JONESYISGOLDEN / PerfectOrder are matched as whole tokens, not "order"), so adding
  // reward-noun singulars/plurals here is safe.
  'already', 'being', 'since', 'start', 'started', 'added', 'adding', 'turn', 'turns', 'turning',
  'briefly', 'before', 'after', 'complete', 'completed', 'completing', 'record', 'records',
  'pieces', 'piece', 'claiming', 'claim', 'need', 'needs', 'needed', 'their', 'have', 'been',
  'make', 'sure', 'without', 'when', 'where', 'which', 'while', 'you', 'the', 'and', 'for', 'all',
  'get', 'gets', 'give', 'gives', 'find', 'finds', 'extraction', 'accelerator', 'accelerators',
  'locators', 'signup', 'signin', 'order', 'orders', 'voice', 'line', 'story', 'quest', 'quests',
  'jumpscare', 'nights', 'freddy', 'scarecrow', 'pumpkin', 'snack', 'lantern', 'lanterns', 'black',
  'disguise', 'outfit', 'style', 'spray', 'emote', 'portrait', 'bling', 'backbling', 'wrap', 'snackolanterns']);
function codeCategory(r) {
  if (/Cheat Master/i.test(r)) return 'Sprites';
  if (/\bXP\b|Dust/i.test(r)) return 'XP & Dust';
  if (/Loading Screen|Tetris|lobby appearance/i.test(r)) return 'Cosmetics';
  if (/Gizmo|Taco|Extractor|Locator|Llama|Portable|Accelerator/i.test(r)) return 'Gizmos';
  if (/Sprite/i.test(r)) return 'Sprites';
  return 'Other';
}
async function pollLobbyHackCodes() {
  const seen = new Map();
  for (const url of CODE_SOURCES) {
    let html = '';
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120', 'Accept': 'text/html' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      html = await res.text();
    } catch (e) { continue; }
    // Decode \uXXXX (pages embed the code list in JSON-LD) BEFORE stripping tags,
    // else en-dash separators arrive as literal "–" and fragment the codes.
    const text = html.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/<[^>]+>/g, ' ').replace(/&#8211;|&ndash;/g, '-').replace(/&amp;/g, '&').replace(/&#?[a-z0-9]+;/gi, ' ').replace(/[ \t]+/g, ' ');
    // Token may START WITH A DIGIT (e.g. 8BITBLAST) — the old [A-Za-z] lead clipped
    // it to "BITBLAST" and DM'd a bogus "new" code. Lookahead requires >=1 letter so
    // pure numbers ("5000" from "5,000 Sprite Dust") still don't match.
    // Code = EITHER a 5-30 char contiguous alnum run (IMTHEREALEDGELORD, 8BITBLAST)
    // OR a dash-segmented code (S7H-50P-R03 — segments too short for the 5+ run, so
    // the old regex captured nothing and the poller never surfaced it). Lookahead
    // still requires ≥1 letter so "5,000" / "50-50" are rejected.
    const re = /((?=[0-9A-Za-z-]*[A-Za-z])(?:[A-Za-z0-9]{5,30}|[A-Za-z0-9]{2,}(?:-[A-Za-z0-9]{2,}){1,4}))[\s\-–—:|)]{1,4}([^\n|]{3,90})/g;
    let m, hits = 0;
    while ((m = re.exec(text)) && hits < 4000) {
      hits++;
      const tok = m[1], rewardRaw = m[2].trim();
      if (CODE_STOPWORDS.has(tok.toLowerCase())) continue;
      // A dash-segmented token is only a real code if it carries a digit (S7H-50P-R03).
      // Hyphenated prose the dash-alternative now matches ("cheat-code", "drop-in") never
      // does — reject it so widening the regex for dash codes didn't open a prose hole.
      if (tok.includes('-') && !/[0-9]/.test(tok)) continue;
      if (!CODE_REWARD_KW.test(rewardRaw)) continue;
      const key = tok.toLowerCase();
      if (!seen.has(key)) seen.set(key, { code: tok, reward: rewardRaw, sources: new Set() });
      seen.get(key).sources.add(url);
    }
  }
  if (!seen.size) { logger.warn('[codes] poll: no sources readable'); _codesCheckedAt = Date.now(); return; }
  const [known] = await pool.query('SELECT code FROM epic_sprite_codes');
  const knownSet = new Set(known.map((r) => r.code.toLowerCase()));
  // DM-dedup ledger: every candidate we've EVER alerted about. The user only wants
  // a DM the FIRST time a genuinely-new code appears — not the same candidate
  // re-DM'd every 6h. knownSet covers codes on the curated list; this ledger
  // additionally covers candidates never added (a real one not yet curated, or a
  // false positive) so neither is ever alerted twice.
  const [alerted] = await pool.query('SELECT code FROM epic_sprite_code_alerts').catch(() => [[]]);
  const alertedSet = new Set((alerted || []).map((r) => r.code.toLowerCase()));
  let refreshed = 0; const candidates = []; const newAlerts = [];
  for (const [key, info] of seen) {
    if (knownSet.has(key)) {
      // Only ever REFRESH the last_seen of codes already curated in the table.
      await pool.query('UPDATE epic_sprite_codes SET last_seen=CURRENT_TIMESTAMP, sources_seen=? WHERE code=?', [info.sources.size, info.code]);
      refreshed++;
    } else if (info.sources.size >= 2 && !alertedSet.has(key)) {
      // NEVER auto-insert. Community pages produce false positives (category
      // headers, prose fragments) and getting one wrong on a public page is worse
      // than a missed code. The /codes list is DB-curated ONLY; the poller just
      // surfaces a NEW candidate ONCE for a human to add if real.
      candidates.push(info.code + ' -> ' + info.reward.replace(/\s{2,}/g, ' ').trim().slice(0, 90));
      newAlerts.push([info.code]);
    }
  }
  _codesCheckedAt = Date.now();
  await loadCodesFromDB();
  logger.info('[codes] poll: ' + seen.size + ' seen, ' + refreshed + ' known refreshed, ' + candidates.length + ' NEW (never alerted)');
  if (candidates.length) {
    try { await dmSpriteAlert('🕹️ **NEW Override code(s) detected** (>=2 sources, first-time alert — NOT auto-added):\n' + candidates.slice(0, 15).join('\n') + '\n\nIf real, add them to the codes list.'); } catch (e) {}
    // Record them so they are NEVER DM'd again, even if never added to the list.
    try { await pool.query('INSERT IGNORE INTO epic_sprite_code_alerts (code) VALUES ?', [newAlerts]); }
    catch (e) { logger.warn('[codes] alert-ledger write failed: ' + e.message); }
  }
}
// Only schedule the poller in the REAL app process. A stray
// `node -e "import('./dashboard/routes/sprites.js')"` (an import test) would otherwise
// run this top-level scheduling too, spawning a zombie poller that outlives the shell
// and keeps re-adding false codes on its 6h timer. That was the ACTUAL root cause of the
// recurring "cosmetics" code — abandoned import-test processes, not the pm2 app.
// Primary signal: pm2 sets process.env.pm_id for managed apps; `node -e` tests never have it.
// Fallback: a direct `node index.js` run. `node -e`/--eval has process.argv.length < 2.
const _isImportEval = process.argv.length < 2;
const _isMainApp = !_isImportEval && (process.env.pm_id !== undefined || /(?:^|[\\/])index\.js$/.test(process.argv[1] || ''));
logger.info('[codes] poller scheduling: isMainApp=' + _isMainApp + ' pm_id=' + (process.env.pm_id ?? 'unset') + ' argv1=' + (process.argv[1] || 'none'));
if (_isMainApp) {
  setTimeout(pollLobbyHackCodes, 25 * 1000);
  setInterval(pollLobbyHackCodes, 6 * 60 * 60 * 1000);
}

// ── /sprites/cards — full trading-card catalogue ─────────────────────────
// Public page showing every sprite variant as a fully-rendered trading card.
// No user state — reads catalog + pak metadata only. Same styling as the
// click-to-open modal cards on the grid pages.
router.get('/cards', async (req, res) => {
  try {
    res.send(await renderCardsCatalogue(req.query));
  } catch (e) {
    logger.warn(`[sprites] /cards render failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + '<main><div class="card"><h2>Catalogue unavailable</h2><p class="sub">Try again in a minute.</p></div></main>'));
  }
});

// Legacy collection views — read the per-account snapshots frozen at each module
// cutover. Same catalogue renderer, different source column + archived styling.
// Override = CH7S4 (locked when Treasure Hunters began); Garden = CH7S3 (locked
// when Override began). Browsable, read-only; linked from the catalogue nav.
router.get('/override', async (req, res) => {
  try {
    res.send(await renderCardsCatalogue(req.query, { column: 'override_json', legacy: true, collLabel: 'Override', formAction: '/sprites/override' }));
  } catch (e) {
    logger.warn(`[sprites] /override render failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + '<main><div class="card"><h2>Override archive unavailable</h2><p class="sub">Try again in a minute.</p></div></main>'));
  }
});
router.get('/garden', async (req, res) => {
  try {
    res.send(await renderCardsCatalogue(req.query, { column: 'garden_json', legacy: true, collLabel: 'Sprite Garden', formAction: '/sprites/garden' }));
  } catch (e) {
    logger.warn(`[sprites] /garden render failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + '<main><div class="card"><h2>Garden archive unavailable</h2><p class="sub">Try again in a minute.</p></div></main>'));
  }
});

// Build one trading-card HTML (server-side mirror of the modal's openModal()).
// Same class names, same data structure — CSS in STYLE renders them identically.
function renderCatalogueCard(v, opts = {}) {
  const { familyLabel, ability, tierMeta, availabilityNote, rarity: rarityOpt } = opts;
  const tierColor = v.tierColor || '#7a8395';
  const tierLabel = v.tierLabel || '';
  const tierKey = v.tierKey || '';
  const summon = v.summonCost;
  // Rarity is a FAMILY property (base-tier cost, shared bands) — passed in via
  // opts.rarity. Fallback to a base-cost heuristic only if not provided.
  const rarity = rarityOpt
    || (summon >= 6750 ? 'Mythic' : summon >= 4500 ? 'Legendary' : summon >= 2700 ? 'Epic' : 'Rare');
  const isHolo = ['holofoil', 'gem', 'cube', 'quack'].includes(tierKey);
  // Catalogue view is "showcase" — no owned/XP/vaulted signals since it's
  // public data. Level badge shows the tier icon symbol.
  const tierIcon = { basic: 'A', gold: 'G', gummy: '★', galaxy: '✧', gem: '◆', holofoil: '✦', cube: '⬢', quack: '🦆' }[tierKey] || '?';
  const imgHtml = v.imgId
    ? `<img src="/sprites/img/${esc(v.imgId)}.png" alt="${esc(v.name)}" onerror="this.style.display='none';this.parentNode.querySelector('.art-fallback').style.display='block'">
       <svg class="art-fallback" style="display:none" viewBox="0 0 100 100"><rect width="100" height="100" rx="14" fill="#15171e"/><text x="50" y="62" text-anchor="middle" font-size="40" font-weight="800" fill="${esc(tierColor)}">${esc((tierLabel||'?')[0])}</text></svg>`
    : `<svg viewBox="0 0 100 100"><rect width="100" height="100" rx="14" fill="#15171e"/><text x="50" y="62" text-anchor="middle" font-size="40" font-weight="800" fill="${esc(tierColor)}">${esc((tierLabel||'?')[0])}</text></svg>`;
  const tierMoveHtml = tierMeta?.effect
    ? `<div class="info-move">
        <div class="info-move-hdr">
          <span class="icon" style="background:${esc(tierColor)}">✦</span>
          <span class="name">${esc(tierLabel)} Bonus</span>
          <span class="power">×</span>
        </div>
        <p class="info-move-desc">${esc(tierMeta.effect)}</p>
      </div>` : '';
  const abilityMoveHtml = ability
    ? `<div class="info-move">
        <div class="info-move-hdr">
          <span class="icon">⚔</span>
          <span class="name">Family Passive</span>
        </div>
        ${renderAbilityBody(ability)}
      </div>` : '';
  // Catalogue-card variant of the note callout — same visual language as the
  // modal so downloaded PNGs carry the disclaimer inline (which is the whole
  // point of a share-friendly card).
  const noteHtml = availabilityNote
    ? `<div class="info-move" style="border-color:rgba(255,207,58,.4);background:linear-gradient(180deg,rgba(255,207,58,.08),rgba(0,0,0,.15))">
        <div class="info-move-hdr">
          <span class="icon" style="background:#ffcf3a;color:#1a1613">⚠</span>
          <span class="name">${esc(availabilityNote.label)}</span>
        </div>
        <p class="info-move-desc" style="color:#ffcf3a">${esc(availabilityNote.text)}</p>
      </div>` : '';
  // Filename for downloaded PNG — safe for cross-platform saves.
  const dlName = `${(familyLabel || v.familyToken).replace(/[^\w]+/g, '')}_${tierLabel || tierKey}.png`;
  return `<div class="info-card catalogue-card${isHolo ? ' holo' : ''}" data-rarity="${esc(rarity)}" data-family="${esc(v.familyToken)}" data-tier="${esc(tierKey)}" data-rarity-tag="${esc(rarity)}">
    <button class="card-dl" type="button" data-dl-name="${esc(dlName)}" title="Download as PNG" aria-label="Download ${esc(dlName)}">⬇</button>
    <div class="info-hdr">
      <div class="fam-wrap">
        <h3 class="fam-name">${esc(familyLabel || v.familyToken)}</h3>
        <div class="fam-sub">${esc(tierLabel)} · ${esc(rarity)}</div>
      </div>
      <div class="level-badge">
        <span class="lvl-num">${esc(tierIcon)}</span>
        <span class="lvl-lbl">${esc(tierLabel)}</span>
      </div>
    </div>
    <div class="info-art">
      <div class="art-tier-badge">${esc(tierLabel)}</div>
      ${imgHtml}
    </div>
    <div class="info-body">
      ${noteHtml}
      ${tierMoveHtml}
      ${abilityMoveHtml}
      <div class="info-stats">
        <div class="info-stat"><b>${summon ? fmt(summon) : '—'}</b><span class="lbl">Dust ✦</span></div>
        <div class="info-stat"><b>${esc(rarity[0])}</b><span class="lbl">${esc(rarity)}</span></div>
        <div class="info-stat"><b>${esc(tierIcon)}</b><span class="lbl">${esc(tierLabel)}</span></div>
      </div>
    </div>
    <div class="info-foot">
      <span class="codename">${esc(v.name)}</span>
      <span class="rarity-dot">${esc(rarity)}</span>
    </div>
  </div>`;
}

async function renderCardsCatalogue(query = {}, opts = {}) {
  // Source column: the live catalogue reads state_json; the legacy collection
  // views read the per-account snapshots frozen at each module cutover
  // (override_json = CH7S4 Override, garden_json = CH7S3 Garden). Whitelisted —
  // the column name is interpolated, not bound, so it can never be user-driven.
  const COLUMN = ({ state_json: 1, override_json: 1, garden_json: 1 }[opts.column]) ? opts.column : 'state_json';
  const legacy = !!opts.legacy;
  const collLabel = opts.collLabel || null;
  const formAction = opts.formAction || '/sprites/cards';
  // Most-recent snapshot that actually has this column populated.
  const [rows] = await pool.execute(
    `SELECT ${COLUMN} AS sj FROM epic_sprite_accounts WHERE ${COLUMN} IS NOT NULL ORDER BY synced_at DESC LIMIT 1`
  );
  if (!rows.length) {
    return shell('Cards Catalogue — CertiFried', chrome() + `<main><div class="card"><h2>${esc(collLabel || 'Catalogue')} unavailable</h2><p class="sub">No ${legacy ? 'archived snapshot for this collection' : 'sync data'} yet.</p></div></main>`);
  }
  const state = JSON.parse(rows[0].sj);
  const groups = state.groups || [];
  const pak = getPakScan();
  const familyMeta = pak?.per_family_meta || {};
  // Family ability text is resolved per-card via resolveFamilyAbility (shared with
  // the main page + admin audit), which handles nf-matching + alias/text fallbacks.
  // Tier bonus lookup
  const tierMetaByKey = {};
  for (const t of PAK_SPECIAL_TIER_EFFECTS) tierMetaByKey[t.tierKey] = t;

  // Flatten every variant across every family
  const allCards = [];
  for (const g of groups) {
    const variants = Object.values(g.variants || {});
    // Rarity is a family property from the base-tier cost (shared bands).
    const rarity = rarityForFamily(g.familyToken, variants.find((v) => v.tierKey === 'basic')?.summonCost);
    for (const v of variants) {
      allCards.push({
        v,
        familyLabel: g.label,
        ability: resolveFamilyAbility(g.familyToken, familyMeta) || '',
        tierMeta: tierMetaByKey[v.tierKey] || null,
        familyToken: g.familyToken,
        rarity,
      });
    }
  }

  // Filter/sort (via query params — bookmarkable)
  const filterFam = query.family || '';
  const filterTier = query.tier || '';
  const filterRarity = query.rarity || '';
  const sortMode = query.sort || 'family';
  let filtered = allCards.filter((c) => {
    if (filterFam && c.familyToken !== filterFam) return false;
    if (filterTier && c.v.tierKey !== filterTier) return false;
    if (filterRarity && c.rarity !== filterRarity) return false;
    return true;
  });
  const tierOrder = { basic: 0, gold: 1, gummy: 2, galaxy: 3, gem: 4, holofoil: 5, cube: 6, quack: 7 };
  const rarityOrder = { Rare: 0, Epic: 1, Legendary: 2, Mythic: 3 };
  filtered.sort((a, b) => {
    if (sortMode === 'rarity') {
      return (rarityOrder[b.rarity] || 0) - (rarityOrder[a.rarity] || 0)
        || (a.familyLabel || '').localeCompare(b.familyLabel || '') || (tierOrder[a.v.tierKey] || 9) - (tierOrder[b.v.tierKey] || 9);
    }
    if (sortMode === 'tier') {
      return (tierOrder[a.v.tierKey] || 9) - (tierOrder[b.v.tierKey] || 9)
          || (a.familyLabel || '').localeCompare(b.familyLabel || '');
    }
    // family (default)
    return (a.familyLabel || '').localeCompare(b.familyLabel || '')
        || (tierOrder[a.v.tierKey] || 9) - (tierOrder[b.v.tierKey] || 9);
  });

  const cardsHtml = filtered.map(({ v, familyLabel, ability, tierMeta, rarity }) =>
    renderCatalogueCard(v, { familyLabel, ability, tierMeta, rarity, availabilityNote: v.availabilityNote })
  ).join('');

  // Filter form values for the toolbar
  const uniqueFams = [...new Set(groups.map((g) => ({ token: g.familyToken, label: g.label })).map(JSON.stringify))].map(JSON.parse).sort((a, b) => a.label.localeCompare(b.label));
  const famOptions = uniqueFams.map((f) => `<option value="${esc(f.token)}" ${filterFam === f.token ? 'selected' : ''}>${esc(f.label)}</option>`).join('');
  const tierOptions = TIERS.map((t) => `<option value="${esc(t.key)}" ${filterTier === t.key ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
  const rarityOptions = ['Rare', 'Epic', 'Legendary', 'Mythic'].map((r) => `<option value="${r}" ${filterRarity === r ? 'selected' : ''}>${r}</option>`).join('');

  // Cross-link live + both legacy collections; mark the one you're on.
  const here = (p) => formAction === p ? ' aria-current="page"' : '';
  const nav = `<a class="navlink" href="/sprites/cards"${here('/sprites/cards')}>Live catalogue</a>
               <a class="navlink" href="/sprites/override"${here('/sprites/override')}>Override archive</a>
               <a class="navlink" href="/sprites/garden"${here('/sprites/garden')}>Garden archive</a>`;
  // Legacy collections get a distinct (muted) banner + an archived note so nobody
  // mistakes a frozen snapshot for the live, collectable set.
  const badge = legacy
    ? `<span style="background:#5a6072;color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;padding:3px 9px;border-radius:999px">🗄 LEGACY${collLabel ? ' · ' + esc(collLabel.toUpperCase()) : ''}</span>`
    : `<span style="background:#7b5cff;color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;padding:3px 9px;border-radius:999px">🃏 CATALOGUE</span>`;
  const heading = legacy ? `The ${esc(collLabel)} collection — archived` : 'The complete Sprite card catalogue';
  const blurb = legacy
    ? `A frozen snapshot of the <b>${esc(collLabel)}</b> sprite collection as it stood when Epic rotated it out of the active lineup. Preserved read-only — it no longer live-syncs. Your current collection is on the <a href="/sprites/cards" style="color:#9b7bff">live catalogue →</a>`
    : `Every variant Epic serves in the live catalog, rendered as its own trading card.
        Holofoil / Gem / Cube / Quack tiers get the animated iridescent shimmer.
        No user state — pure showcase.`;
  const cardBorder = legacy ? '#4a5160' : '#6b4cff';
  const cardBg = legacy ? 'linear-gradient(180deg,#1c2030 0%,#161922 60%)' : 'linear-gradient(180deg,#1a1638 0%,#161922 60%)';
  const body = chrome(nav) + `<main>
    <div class="card" style="background:${cardBg};border:1px solid ${cardBorder}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        ${badge}
        <span class="sub" style="font-size:12px">${filtered.length} of ${allCards.length} cards shown</span>
      </div>
      <h1 style="margin:0 0 8px">${heading}</h1>
      <p class="sub" style="margin:0 0 14px">${blurb}</p>
      <form method="get" action="${formAction}" class="cards-toolbar">
        <label>Family:
          <select name="family"><option value="">All (${uniqueFams.length})</option>${famOptions}</select>
        </label>
        <label>Tier:
          <select name="tier"><option value="">All</option>${tierOptions}</select>
        </label>
        <label>Rarity:
          <select name="rarity"><option value="">All</option>${rarityOptions}</select>
        </label>
        <label>Sort by:
          <select name="sort">
            <option value="family" ${sortMode === 'family' ? 'selected' : ''}>Family → Tier</option>
            <option value="tier" ${sortMode === 'tier' ? 'selected' : ''}>Tier → Family</option>
            <option value="rarity" ${sortMode === 'rarity' ? 'selected' : ''}>Rarity (high → low)</option>
          </select>
        </label>
        <button type="submit" class="resync-btn" style="background:var(--purple);color:#fff;border-color:var(--purple)">Apply</button>
        <a href="${formAction}" class="navlink" style="margin-left:auto">Reset</a>
      </form>
    </div>
    ${filtered.length === 0
      ? '<div class="card"><h3>No cards match those filters</h3><p class="sub">Try loosening the filter or hit Reset.</p></div>'
      : `<div class="cards-bulk">
          <button class="dl-all" type="button" id="dl-all-btn">⬇ Download all ${filtered.length} as PNG</button>
          <span class="dl-status" id="dl-status">Or click ⬇ on any individual card.</span>
          <progress id="dl-progress" value="0" max="${filtered.length}" style="display:none"></progress>
        </div>
        <div class="cards-grid">${cardsHtml}</div>`}
  </main>
  <script src="/sprites/html2canvas.min.js"></script>
  <script>(function(){
    // ── PNG downloader for /sprites/cards ────────────────────────────────
    if (typeof html2canvas === 'undefined') {
      console.warn('[cards] html2canvas failed to load');
      document.querySelectorAll('.card-dl,.cards-bulk').forEach(function(el){ el.hidden = true; el.style.display = 'none'; });
      return;
    }
    function download(dataUrl, filename) {
      var a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){ document.body.removeChild(a); }, 100);
    }
    // Render one card element to a PNG data-URL. Uses html2canvas with
    // pixel-ratio 2 for retina-quality output.
    async function cardToPng(cardEl) {
      // Hide the download button before capture so it doesn't appear in the PNG
      var dlBtn = cardEl.querySelector('.card-dl');
      var origDisplay = dlBtn ? dlBtn.style.display : '';
      if (dlBtn) dlBtn.style.display = 'none';
      // Also disable animations so the shimmer freezes at a good frame
      cardEl.style.animation = 'none';
      try {
        var canvas = await html2canvas(cardEl, {
          backgroundColor: null,   // preserve card's own background/glow
          scale: 2,                // retina-quality (2× pixel density)
          useCORS: true,
          allowTaint: false,
          logging: false,
          // Card has box-shadow glow — grow the capture area to include it
          width: cardEl.offsetWidth + 40,
          height: cardEl.offsetHeight + 40,
          x: -20,
          y: -20,
        });
        return canvas.toDataURL('image/png');
      } finally {
        if (dlBtn) dlBtn.style.display = origDisplay;
        cardEl.style.animation = '';
      }
    }
    // Single-card download via delegated click
    document.addEventListener('click', async function(e){
      var btn = e.target.closest('.card-dl');
      if (!btn) return;
      var card = btn.closest('.catalogue-card');
      if (!card) return;
      var filename = btn.dataset.dlName || 'sprite.png';
      btn.classList.add('working');
      btn.textContent = '…';
      try {
        var dataUrl = await cardToPng(card);
        download(dataUrl, filename);
        btn.classList.remove('working');
        btn.classList.add('done');
        btn.textContent = '✓';
        setTimeout(function(){ btn.classList.remove('done'); btn.textContent = '⬇'; }, 1500);
      } catch (err) {
        console.error('[cards] PNG render failed', err);
        btn.classList.remove('working');
        btn.textContent = '⚠';
        setTimeout(function(){ btn.textContent = '⬇'; }, 2000);
      }
    });
    // Bulk-download — iterate through all cards, save each as PNG.
    // Uses a small delay between captures so the browser stays responsive.
    var dlAllBtn = document.getElementById('dl-all-btn');
    var dlStatus = document.getElementById('dl-status');
    var dlProgress = document.getElementById('dl-progress');
    if (dlAllBtn) {
      dlAllBtn.addEventListener('click', async function(){
        var cards = Array.from(document.querySelectorAll('.catalogue-card'));
        if (!cards.length) return;
        dlAllBtn.disabled = true;
        dlAllBtn.textContent = 'Rendering…';
        dlProgress.style.display = '';
        dlProgress.max = cards.length;
        dlProgress.value = 0;
        var ok = 0, failed = 0;
        for (var i = 0; i < cards.length; i++) {
          var card = cards[i];
          var btn = card.querySelector('.card-dl');
          var name = btn ? (btn.dataset.dlName || ('sprite_' + i + '.png')) : ('sprite_' + i + '.png');
          dlStatus.textContent = 'Rendering ' + (i + 1) + ' / ' + cards.length + ': ' + name;
          try {
            var dataUrl = await cardToPng(card);
            download(dataUrl, name);
            ok++;
          } catch (err) {
            console.error('[cards] failed:', name, err);
            failed++;
          }
          dlProgress.value = i + 1;
          // Yield to browser between saves to prevent tab freeze
          await new Promise(function(r){ setTimeout(r, 150); });
        }
        dlAllBtn.disabled = false;
        dlAllBtn.textContent = '⬇ Download all ' + cards.length + ' as PNG';
        dlStatus.textContent = 'Done — saved ' + ok + (failed ? ' · ' + failed + ' failed' : '') + '.';
      });
    }
  })();</script>`;
  return shell(legacy ? `${collLabel} (legacy) — CertiFried Sprite Tracker` : 'Card Catalogue — CertiFried Sprite Tracker', body);
}


// ── Renders the "Live hotfix state" section for /sprites/info ──────────────
// Sources data from the server-side hotfix poller (pollHotfixConfig above).
// Returns empty string if the cache doesn't exist yet — first poll fires ~15s
// after boot so this is rare but handled.
function renderHotfixSection(hf) {
  if (!hf) {
    return `<h2 style="margin-top:22px;font-size:16px">Live hotfix state</h2>
      <p class="sub">Waiting on first hotfix poll... (fires every 15 min from server)</p>`;
  }
  const polledAgo = hf.polled_at ? Math.round((Date.now() - new Date(hf.polled_at).getTime()) / 60000) : null;
  // Tier columns: [epicKey, displayLabel]. Epic ships "Candy" in the hotfix
  // payload but the in-game label is "Gummy" — we keep the lookup key raw so
  // tiers[epicKey] finds it, and render the label so users see "Gummy".
  const TIER_COLS = [
    ['Base', 'Base'], ['Candy', 'Gummy'], ['Gold', 'Gold'], ['Galaxy', 'Galaxy'],
    ['Gem', 'Gem'], ['Holofoil', 'Holofoil'], ['Cube', 'Cube'], ['Quack', 'Quack'],
  ];
  // Drop rates table — grouped by family
  const weightRows = Object.entries(hf.variant_weights || {})
    .filter(([fam]) => fam.length > 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fam, tiers]) => {
      const cells = TIER_COLS.map(([epicKey]) => {
        const w = tiers[epicKey];
        if (w == null) return '<td class="center sub">—</td>';
        const pct = (w * 100).toFixed(1);
        const color = w >= 0.3 ? '#e8eaf0' : w >= 0.05 ? '#ffcf3a' : w >= 0.005 ? '#ff8090' : '#9b6bff';
        return `<td class="center" style="color:${color};font-weight:${w >= 0.05 ? 800 : 600}">${pct}%</td>`;
      }).join('');
      return `<tr><td><b>${esc(fam)}</b></td>${cells}</tr>`;
    }).join('');
  // Next drop timestamp
  const nextDropBlock = hf.next_drop_ts
    ? (() => {
        const dropDate = new Date(hf.next_drop_ts * 1000);
        const iso = dropDate.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
        const msUntil = dropDate.getTime() - Date.now();
        const hoursUntil = Math.round(msUntil / 3600000);
        const isPast = msUntil < 0;
        return `<div style="background:rgba(255,207,58,.10);border:1px solid rgba(255,207,58,.35);border-radius:10px;padding:14px 16px;margin:10px 0">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
            <span style="background:#ffcf3a;color:#000;font-size:11px;font-weight:800;letter-spacing:0.06em;padding:3px 9px;border-radius:999px">🕐 EPIC'S SCHEDULED TIME</span>
            <b style="font-size:15px">${esc(iso)}</b>
            <span class="sub" style="font-size:12px">(${isPast ? Math.abs(hoursUntil) + ' h ago' : '~' + hoursUntil + ' h out'})</span>
          </div>
          <p class="sub" style="margin:0;font-size:12.5px">Epic's <code>ComingSoonTimestamp</code> — their <i>advertised</i> next-drop time, not a guarantee.
            <b>Epic frequently ships early</b> (v41.30 dropped ~2h ahead of this stamp), so sprites tied to this window may already be live — this tracker follows what's actually in the live catalog, not the clock.
            <a href="/sprites/countdown" class="navlink" style="padding:0;color:#ffcf3a">→ Live countdown widget</a></p>
        </div>`;
      })()
    : '';
  // Extraction multipliers — remap Epic's raw "Candy" tier to display "Gummy"
  const displayTier = (t) => t === 'Candy' ? 'Gummy' : t;
  const multRows = Object.entries(hf.extraction_multipliers_win || {}).sort(([a], [b]) => a.localeCompare(b));
  const multTable = multRows.length ? multRows.map(([tier, mult]) => `
    <tr><td><b>${esc(displayTier(tier))}</b></td><td class="center audit-num"><b>${mult}×</b></td></tr>`).join('') : '';
  const xpKeys = ['XPPerElim', 'XPPerAssist', 'XPPerExtract', 'XPPerDown', 'XPPerContainer', 'XPPerDupeExtract'];
  const xpRows = xpKeys.filter((k) => hf.xp_curves && hf.xp_curves[k] != null).map((k) => `
    <tr><td><b>${esc(k.replace('XPPer', 'XP per '))}</b></td><td class="center audit-num">${hf.xp_curves[k]}</td></tr>`).join('');

  return `<h2 style="margin-top:22px;font-size:16px">🔥 Live hotfix state</h2>
    <p>
      Fortnite pushes runtime config overrides via <code>/cloudstorage/system/*.ini</code>
      files — same mechanism that flips sprite plugin availability + adjusts drop rates.
      We poll this endpoint from the server every 15 min using our device_auth
      (no mitmproxy, no client instrumentation). Last poll:
      <b>${polledAgo != null ? polledAgo + ' min ago' : 'unknown'}</b>
      via account <code>${esc(hf.source_account || 'unknown')}</code>.
      Watching ${hf.targets_matched}/${hf.file_count} hotfix .ini files.
    </p>
    ${nextDropBlock}
    ${weightRows ? `
      <h2 style="margin-top:18px;font-size:15px">Live drop rates per family</h2>
      <p class="sub">Base/Gummy/Gold/Galaxy weights currently in effect (from
        <code>DT_VariantWeights</code> hotfix overrides). Values are relative —
        each family's row sums to ~1.0. Green cells = common,
        gold = uncommon, red = rare, purple = mythic-rare.</p>
      <div style="overflow-x:auto"><table class="audit-table" style="font-size:12.5px">
        <thead><tr><th>Family</th>${TIER_COLS.map(([, label]) => `<th class="center">${label}</th>`).join('')}</tr></thead>
        <tbody>${weightRows}</tbody>
      </table></div>
    ` : ''}
    ${xpRows ? `
      <h2 style="margin-top:18px;font-size:15px">XP curves (per action, max sprite level)</h2>
      <table class="audit-table" style="font-size:12.5px"><tbody>${xpRows}</tbody></table>
    ` : ''}
    ${multTable ? `
      <h2 style="margin-top:18px;font-size:15px">Extraction point multipliers (on match win)</h2>
      <p class="sub">Bonus multiplier applied to the base extraction reward when you Victory Royale with a variant of that tier equipped.</p>
      <table class="audit-table" style="font-size:12.5px">
        <thead><tr><th>Tier</th><th class="center">Multiplier</th></tr></thead>
        <tbody>${multTable}</tbody>
      </table>
    ` : ''}`;
}

// ── /sprites/countdown ──────────────────────────────────────────────────────
// Public widget page — live tick-tocking countdown to ComingSoonTimestamp from
// the hotfix poller cache. Auto-refreshes with a client-side JS timer for the
// visual countdown; server-side data reloads on every page load via mtime check.
router.get('/countdown', (req, res) => {
  const hf = getHotfixCache();
  const nav = '';
  if (!hf || !hf.next_drop_ts) {
    return res.send(shell('Next drop — CertiFried Sprite Tracker', chrome(nav) + `<main>
      <div class="card">
        <h1>Countdown unavailable</h1>
        <p class="sub">Waiting on the first hotfix poll — comes back in a minute or two after server startup.</p>
        <p><a href="/sprites" class="navlink">← Back to tracker</a></p>
      </div>
    </main>`));
  }
  const dropTsMs = hf.next_drop_ts * 1000;
  const dropIso = new Date(dropTsMs).toISOString();
  const polledAgo = hf.polled_at ? Math.round((Date.now() - new Date(hf.polled_at).getTime()) / 60000) : null;
  // A ComingSoonTimestamp that lapsed more than a drop-day ago is not an
  // imminent drop — Epic simply hasn't published a new one yet. Rendering a
  // week-old date as "DROP LIVE" is misinformation on a public page, so show
  // an honest "nothing scheduled" card instead. Self-heals: the moment Epic
  // sets a future timestamp, the hotfix poller picks it up and the live
  // countdown returns with no code change.
  const STALE_GRACE_MS = 12 * 60 * 60 * 1000;
  if (dropTsMs < Date.now() - STALE_GRACE_MS) {
    const sinceDays = Math.floor((Date.now() - dropTsMs) / 86400000);
    return res.send(shell('Next drop — CertiFried Sprite Tracker', chrome(nav) + `<main>
      <div class="card" style="background:linear-gradient(180deg,#1f2330 0%,#161922 60%);border:1px solid #39405a;text-align:center">
        <div style="display:flex;justify-content:center;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
          <span style="background:#39405a;color:#cdd3e0;font-size:11px;font-weight:800;letter-spacing:0.08em;padding:3px 9px;border-radius:999px">🕐 NEXT SCHEDULED DROP</span>
        </div>
        <h1 style="margin:10px 0">No drop currently scheduled</h1>
        <p class="sub" style="font-size:14px;line-height:1.7;max-width:460px;margin:0 auto">
          Epic's live hotfix config isn't pointing at an upcoming sprite drop right now —
          the last scheduled time (<b>${esc(dropIso)}</b>) was about <b>${sinceDays} day${sinceDays === 1 ? '' : 's'}</b> ago.
          This page updates on its own the moment Epic sets a new <code>ComingSoonTimestamp</code>.
        </p>
        <div class="sub" style="font-size:13px;margin-top:16px">
          Last polled: <b>${polledAgo != null ? polledAgo + ' min ago' : 'unknown'}</b>
          via account <code>${esc(hf.source_account || 'unknown')}</code>.
        </div>
      </div>
      <p style="text-align:center;margin:22px 0 0;font-size:14px">
        <a href="/sprites/info" class="navlink">📋 Full audit &amp; drop rates</a>
        &nbsp;·&nbsp;
        <a href="/sprites" class="navlink">👾 Back to tracker</a>
      </p>
    </main>`));
  }
  const body = chrome(nav) + `<main>
    <div class="card" style="background:linear-gradient(180deg,#2a2338 0%,#161922 60%);border:1px solid #ffcf3a;text-align:center">
      <div style="display:flex;justify-content:center;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <span style="background:#ffcf3a;color:#000;font-size:11px;font-weight:800;letter-spacing:0.08em;padding:3px 9px;border-radius:999px">🕐 NEXT SCHEDULED DROP</span>
        <span class="sub" style="font-size:12px">Live from Epic's DDSS hotfix service</span>
      </div>
      <div id="cd-display" style="font-family:'Segoe UI',sans-serif;font-weight:900;font-size:56px;color:#ffcf3a;letter-spacing:0.02em;line-height:1.1;margin:20px 0 6px;text-shadow:0 2px 20px rgba(255,207,58,.25)">
        <span id="cd-d">—</span>d <span id="cd-h">—</span>h <span id="cd-m">—</span>m <span id="cd-s">—</span>s
      </div>
      <p style="font-size:14px;margin:6px 0 22px"><b>Drop time:</b> <span id="cd-drop-local">${esc(dropIso)}</span></p>
      <div class="sub" style="font-size:13px;line-height:1.7">
        Source: <code>Extraction.Persistence.ComingSoonTimestamp</code> from
        <code>DefaultEngine.ini</code> in Fortnite's live hotfix config.<br>
        Last polled: <b>${polledAgo != null ? polledAgo + ' min ago' : 'unknown'}</b>
        via account <code>${esc(hf.source_account || 'unknown')}</code>.<br>
        Auto-refreshes on this page — no action needed.
      </div>
    </div>
    <p style="text-align:center;margin:22px 0 0;font-size:14px">
      <a href="/sprites/info" class="navlink">📋 Full audit &amp; drop rates</a>
      &nbsp;·&nbsp;
      <a href="/sprites" class="navlink">👾 Back to tracker</a>
    </p>
  </main>
  <script>(function(){
    var dropMs = ${dropTsMs};
    var el = { d: document.getElementById('cd-d'), h: document.getElementById('cd-h'),
               m: document.getElementById('cd-m'), s: document.getElementById('cd-s'),
               dropLocal: document.getElementById('cd-drop-local'),
               display: document.getElementById('cd-display') };
    // Render drop time in viewer's local timezone
    try { el.dropLocal.textContent = new Date(dropMs).toLocaleString(undefined,
      { weekday:'short', year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZoneName:'short' });
    } catch(e){}
    function tick() {
      var diff = dropMs - Date.now();
      if (diff <= 0) {
        el.display.innerHTML = '<span style="color:#3ad07a">DROP LIVE — check the tracker</span>';
        return;
      }
      var s = Math.floor(diff / 1000);
      var d = Math.floor(s / 86400); s -= d * 86400;
      var h = Math.floor(s / 3600);  s -= h * 3600;
      var m = Math.floor(s / 60);    s -= m * 60;
      el.d.textContent = d;
      el.h.textContent = String(h).padStart(2,'0');
      el.m.textContent = String(m).padStart(2,'0');
      el.s.textContent = String(s).padStart(2,'0');
    }
    tick(); setInterval(tick, 1000);
    // Auto-reload the whole page every 15 min so we pick up new hotfix state
    setTimeout(function(){ location.reload(); }, 15 * 60 * 1000);
  })();</script>`;
  res.send(shell('Next drop countdown — CertiFried Sprite Tracker', body, {
    type: 'website',
    title: 'Next Fortnite Sprite drop countdown',
    description: 'Live countdown to the next scheduled sprite drop, pulled from Epic\'s DDSS hotfix config.',
    color: '#ffcf3a',
  }));
});

async function renderInfo() {
  const pak = getPakScan();
  const sizes = await getEndpointSizes();
  // The audit account's model. This page is PUBLIC and names the account it
  // audits, so it must read that specific account — not "whoever synced most
  // recently", which would render a stranger's collection totals under the
  // audit account's name. Falls back to catalog-only rendering if that account
  // hasn't synced, rather than silently substituting someone else's data.
  let state = null;
  try {
    const [[row]] = await pool.execute(
      'SELECT state_json FROM epic_sprite_accounts WHERE display_name=? AND state_json IS NOT NULL LIMIT 1',
      [AUDIT_ACCOUNT_LABEL],
    );
    if (row?.state_json) state = JSON.parse(row.state_json);
  } catch { /* sections that need it degrade to a "no data" note */ }
  // Derive display values from the latest pak-scan.json instead of hardcoding.
  // pak.audit_stamp is "YYYY-MM-DD HH:MM:SS UTC" — take the date part for display.
  const pakAuditStamp = (pak.audit_stamp || '').split(' ')[0] || '(unknown)';
  const pakBuild = (pak.fortnite_build || '').replace(/^\+\+Fortnite\+Release-/, '') || '(unknown)';
  const totalVariants = Object.values(pak.per_family_pak || {}).reduce((sum, tiers) => sum + tiers.length, 0)
    || pak.matching_assets || 0;
  // pak-scan.json comes from the raw pak file names — Epic ships the tier
  // as "Candy" there but the user-facing label is "Gummy". Remap for display.
  // These come from the PAK, so they include things Epic hasn't enabled (Quack).
  // Kept for the pak-side section further down — NOT for "what's live", which
  // must read the live catalog or it contradicts itself.
  const tierTokens = (pak.unique_tiers || []).map((t) => t === 'Candy' ? 'Gummy' : t);
  // Live-catalog view: what Epic is actually serving right now.
  const liveTierPills = (() => {
    const seen = new Map();
    for (const g of state?.groups || []) {
      for (const v of Object.values(g.variants || {})) {
        if (v.pakDatamined) continue;               // catalog only
        if (!seen.has(v.tierKey)) seen.set(v.tierKey, { label: v.tierLabel, color: v.tierColor, live: 0, locked: 0 });
        const e = seen.get(v.tierKey);
        if (v.future) e.locked++; else e.live++;
      }
    }
    return [...seen.values()]
      .sort((a, b) => (b.live + b.locked) - (a.live + a.locked))
      .map((t) => `<span class="audit-token" style="border-color:${esc(t.color)}55;color:${esc(t.color)}">${esc(t.label)}${t.locked ? ` <span class="sub" style="font-size:11px">${t.live ? `${t.live} live · ` : ''}${t.locked} locked</span>` : ''}</span>`)
      .join('');
  })();
  const liveFamilyPills = (state?.groups || [])
    .map((g) => `<span class="audit-token family">${esc(g.label)}</span>`).join('');
  // Auto-derived from pak_scan minus live catalog — replaces the old
  // hardcoded PAK_UNRELEASED_VARIANTS so new pak-only tiers auto-appear.
  const unreleasedVariants = await getPakUnreleasedForInfo();
  // Live audit stamp for the 4-endpoint table: use the timestamp of the last
  // successful sync we captured sizes from, falling back to today's date.
  const liveAuditStamp = sizes.stamp
    ? new Date(sizes.stamp).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  // Quack column, measured rather than asserted. We only token-search the two
  // endpoints we actually parse; claiming a zero for athena/shop would be
  // stating a result we never computed.
  const quackAudit = (() => {
    const all = (state?.groups || []).flatMap((g) => Object.values(g.variants || {}));
    const q = all.filter((v) => v.tierKey === 'quack');
    const inCatalog = q.filter((v) => !v.pakDatamined).length;
    const ownedQ = q.filter((v) => v.owned).length;
    const cell = (n) => (n > 0 ? `✅ ${n}` : '❌ 0');
    return {
      catalogCell: state ? cell(inCatalog) : '<span class="sub">—</span>',
      magpieCell: state ? cell(ownedQ) : '<span class="sub">—</span>',
      notSearched: '<span class="sub" title="We do not token-search this endpoint">not searched</span>',
    };
  })();
  // Single source for both the TL;DR pills and the rumor section further down,
  // so the two can never contradict each other (they did: the TL;DR listed
  // Batman as absent while the abilities table below rendered its ability).
  const rumorRows = verifyRumors(state);
  const rumorsAbsent = rumorRows.filter((r) => r.status === 'absent');
  const rumorsShipped = rumorRows.filter((r) => r.status === 'shipped');
  const rumorsAnnounced = rumorRows.filter((r) => r.status === 'announced');
  const dateShort = (ms) => (ms == null ? 'TBA'
    : new Date(ms).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
      + ' ' + new Date(ms).toISOString().slice(11, 16) + ' UTC');
  const absentPills = rumorsAbsent.length
    ? rumorsAbsent.map((t) => `<span class="audit-token absent">${esc(t.name)}</span>`).join('')
    : '<span class="sub">Nothing on the watchlist is unaccounted for.</span>';
  const nav = '';
  const body = chrome(nav) + `<main>
    <div class="card" style="background:linear-gradient(180deg,#1a2438 0%,#161922 60%);border:1px solid #2a5aa8">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        <span style="background:#2a5aa8;color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;padding:3px 9px;border-radius:999px">📋 TRANSPARENCY</span>
        <span class="sub" style="font-size:12px">Audited ${esc(liveAuditStamp)}</span>
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
      ${rumorsAnnounced.length ? `<p style="margin:0 0 8px"><b>Confirmed, not out yet:</b>
        ${rumorsAnnounced.map((r) => `${esc(r.name)} <span class="sub">(releases ${esc(dateShort(r.releaseAt))}${r.rarity ? `, ${esc(r.rarity)}` : ''})</span>`).join(' · ')}</p>` : ''}
      ${rumorsShipped.length ? `<p style="margin:0 0 8px"><b>Now shipped:</b>
        ${rumorsShipped.map((r) => `${esc(r.name)} <span class="sub">(Epic codename <code>${esc(r.codename)}</code>${r.total ? `, ${r.live}/${r.total} live` : ''})</span>`).join(' · ')}</p>` : ''}
      <div class="audit-tokens" style="margin:8px 0 12px">${absentPills}</div>
      ${rumorsAbsent.length ? `
      <p style="margin:0"><b>No trace of these</b> in either place we can check:</p>
      <ul style="margin:6px 0 10px 20px;padding:0">
        <li>Epic's live sprite catalog (what you can find in a match)</li>
        <li>Any <code>DisplayName</code> inside the pak's sprite DataAssets — the
            field that reveals a family's real name even when its asset path uses
            an internal codename</li>
      </ul>
      <p style="margin:0">
        That's a statement about the current build only. A sprite can exist in the
        pak long before Epic flips the server flag that makes it obtainable — and
        it can ship under a codename that looks nothing like its marketing name,
        which is why we match on <code>DisplayName</code> rather than file paths.
      </p>` : ''}
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
            <th class="audit-num">Size on ${esc(liveAuditStamp)}</th>
            <th class="center">Quack?</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-label="Endpoint"><code>mcp-gc.live.fngw</code><span class="audit-sub">extractablerelics/…/getBackendCatalog</span></td>
            <td data-label="Lists">Every extractable sprite variant Epic will let you find in a BR match</td>
            <td class="audit-num" data-label="Response size">${sizes.catalog != null ? sizes.catalog.toLocaleString() : '—'} B${sizes.catalogVariants ? `<span class="audit-sub">${sizes.catalogVariants} variants</span>` : ''}</td>
            <td class="center audit-hit" data-label="Quack hits">${quackAudit.catalogCell}</td>
          </tr>
          <tr>
            <td data-label="Endpoint"><code>gc.svc.live.fngw</code><span class="audit-sub">magpie inventory (deployment-scoped)</span></td>
            <td data-label="Lists">Your owned + extracted-once (buyback) sprites + dust currency + metadata</td>
            <td class="audit-num" data-label="Response size">${sizes.magpie != null ? sizes.magpie.toLocaleString() : '—'} B</td>
            <td class="center audit-hit" data-label="Quack hits">${quackAudit.magpieCell}</td>
          </tr>
          <tr>
            <td data-label="Endpoint"><code>account-public-service</code><span class="audit-sub">athena BR cosmetic profile</span></td>
            <td data-label="Lists">Every equippable cosmetic on your account — <b>including Back Blings</b></td>
            <td class="audit-num" data-label="Response size">${sizes.athena != null ? sizes.athena.toLocaleString() : '—'} B</td>
            <td class="center audit-hit" data-label="Quack hits">${quackAudit.notSearched}</td>
          </tr>
          <tr>
            <td data-label="Endpoint"><code>fortnite-api.com/v2/shop</code><span class="audit-sub">public Item Shop rotation</span></td>
            <td data-label="Lists">Every cosmetic Epic is selling right now (previewable even if unpurchased)</td>
            <td class="audit-num" data-label="Response size">${sizes.shop != null ? sizes.shop.toLocaleString() : '—'} B</td>
            <td class="center audit-hit" data-label="Quack hits">${quackAudit.notSearched}</td>
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
      <p style="margin:6px 0 4px"><b>Tiers Epic is currently serving:</b></p>
      <div class="audit-tokens">${liveTierPills || '<span class="sub">no synced account</span>'}</div>
      <p class="sub" style="font-size:12px;margin:12px 0 14px">
        Straight from the live catalog — <b>not</b> the pak, so a tier only appears
        here once Epic actually serves it. "Locked" means Epic ships the entry and
        the in-game collection menu shows it, but it can't be found in a match yet.
        Two naming quirks the tracker normalises: <code>A</code> and <code>Base</code>
        both mean Basic, and <code>Galactic</code> is Dream Sprite's spelling of
        what every other family calls <code>Galaxy</code>.
      </p>
      <p style="margin:6px 0 4px"><b>Sprite families in the live catalog (${(state?.groups || []).length} total):</b></p>
      <div class="audit-tokens">${liveFamilyPills || '<span class="sub">no synced account</span>'}</div>
      <p class="sub" style="font-size:12px;margin:14px 0 0">
        Shown under their in-game names. Epic's internal codenames differ — Batman
        ships as <code>FossilMealSprite</code>, Vini&nbsp;Jr. as <code>CokeParmesan</code>,
        Pollo as <code>CompanyStargazer</code> — which is why the raw asset names
        further down this page won't all look familiar.
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
      <h2 style="margin-top:18px">When this will change</h2>
      <p>
        Automatically, on the next sync. Nothing on this page is a stored verdict:
        tiers and families are read from the live catalog, and <b>what's obtainable
        is driven straight from Epic's own hotfix — the exact list of variants Epic
        has disabled (unmapped from the loot pool) gates them directly, per
        variant</b>. On top of that, <b>anything a real player is observed owning is
        treated as obtainable no matter what</b>, and release dates come from Epic's
        hotfix too. A drop that lands, or a variant Epic flips on or off, corrects
        itself within one sync cycle.
      </p>
      <p style="margin-bottom:0">
        That is how <b>Cube</b> went live on this page — it flipped the moment
        Cube variants started showing up in synced accounts, with no code change
        and nobody editing a date. The same path is waiting for anything still
        listed as locked above.
      </p>
    </div>

    <div class="card" style="border:1px solid #6b4cff;background:linear-gradient(180deg,#1e1a2e 0%,#161922 60%)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        <span style="background:#6b4cff;color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;padding:3px 9px;border-radius:999px">🗂 PAK AUDIT</span>
        <span class="sub" style="font-size:12px">Extracted ${esc(pakAuditStamp)} · build ${esc(pakBuild)}</span>
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
        <span class="audit-token"><b>${totalVariants}</b> variants in pak</span>
        <span class="audit-token"><b>${tierTokens.length}</b> tiers in pak</span>
        <span class="audit-token absent"><b>${unreleasedVariants.length}</b> datamined-not-live</span>
      </div>
      <h2 style="margin-top:18px;font-size:16px">The ${unreleasedVariants.length} unreleased variant${unreleasedVariants.length === 1 ? '' : 's'} that exist${unreleasedVariants.length === 1 ? 's' : ''} in the pak</h2>
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
          ${unreleasedVariants.map((v) => `
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
      <h2 style="margin-top:18px;font-size:16px">Rumored sprites — checked against live data</h2>
      <p style="margin-bottom:6px">
        Every name the community asks about, re-checked on each page load against
        Epic's live catalog <i>and</i> the <code>DisplayName</code> strings inside
        the pak's DataAssets. Nothing here is a stored verdict.
      </p>
      ${(() => {
        const rumors = verifyRumors(state);
        const shipped = rumors.filter((r) => r.status === 'shipped');
        const announced = rumors.filter((r) => r.status === 'announced');
        const absent = rumors.filter((r) => r.status === 'absent');
        const dateLong = (ms) => (ms == null ? 'a date Epic hasn\'t published'
          : new Date(ms).toLocaleString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
            + ' ' + new Date(ms).toISOString().slice(11, 16) + ' UTC');
        return `
        ${shipped.length ? `<div class="audit-tokens" style="margin:8px 0 10px">
          ${shipped.map((r) => `<span class="audit-token present">${esc(r.name)}: shipped as <code>${esc(r.codename)}</code>${r.total ? ` · ${r.live}/${r.total} live` : ''}</span>`).join('')}
        </div>` : ''}
        ${announced.map((r) => `<div class="info-move" style="margin:10px 0;border-color:rgba(91,240,255,.35);background:linear-gradient(180deg,rgba(91,240,255,.06),rgba(0,0,0,.15))">
          <div class="info-move-hdr"><span class="icon" style="background:#5bf0ff;color:#04212a">◷</span>
          <span class="name">${esc(r.name)} — confirmed, not out yet</span></div>
          <p class="info-move-desc" style="margin:2px 0 0">
            Releases <b>${esc(dateLong(r.releaseAt))}</b>${r.rarity ? ` · <b>${esc(r.rarity)}</b>` : ''}. Not in Epic's catalog or the current pak yet, so it has no grid tile — it appears automatically once it ships.
            ${r.ability ? `<br><b>Ability:</b> ${esc(r.ability)}` : ''}
            ${r.howToGet ? `<br><b>How to get:</b> ${esc(r.howToGet)}` : ''}
            ${r.sourceUrl ? `<br><a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">source</a>` : ''}
          </p>
        </div>`).join('')}
        ${absent.length ? `<div class="audit-tokens" style="margin:8px 0 10px">
          ${absent.map((r) => `<span class="audit-token absent">${esc(r.name)}: no catalog entry, no DisplayName match, not announced</span>`).join('')}
        </div>` : ''}
        <p class="sub" style="font-size:12px;margin:0">
          <b>Why a name search alone isn't proof.</b> Epic ships families under
          internal codenames, so the marketing name never appears in the asset
          path. Batman is <code>FossilMealSprite</code>, Vini&nbsp;Jr. is
          <code>CokeParmesan</code>, Pollo is <code>CompanyStargazer</code>.
          Grepping the pak for "Batman" returns zero hits even though the sprite
          is fully shipped — this page previously drew exactly that wrong
          conclusion. The reliable signal is the <code>DisplayName</code> FText
          inside each <code>ESD_*.uasset</code>, which spells out the real name.
          ${absent.length ? `The ${absent.length === 1 ? 'name' : 'names'} above ${absent.length === 1 ? 'matches' : 'match'} no live catalog family and no DisplayName in the current pak — but that is a statement about today's build, not a prediction.` : ''}
        </p>`;
      })()}
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
        <span class="sub" style="font-size:12px">Full pak enumeration ${esc(pakAuditStamp)}</span>
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

      <h2 style="margin-top:22px;font-size:16px">Vault status</h2>
      ${renderVaultStatus(state)}

      <h2 style="margin-top:22px;font-size:16px">Special variant effects</h2>
      <p>
        Every non-Basic tier stacks a passive effect on top of its family's base
        ability. The effect wording is community-sourced
        (<a href="https://www.ign.com/wikis/fortnite/Sprites_Checklist_and_Guide:_All_Variants,_Abilities,_and_Extraction_Tips" target="_blank" rel="noopener">IGN's CH7S3 guide</a>)
        — unlike the family abilities above, which come from Epic's own DataAssets.
        Treat the numbers here as reported rather than verified; where Epic's
        hotfix config exposes a matching multiplier, it appears in the live-hotfix
        section further down, and that is the part we can confirm first-hand.
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
        Effect text is community-sourced; the tier list itself is read from Epic's
        live catalog, so a tier can't appear here unless Epic is actually serving
        it. A tier being served isn't the same as every variant being obtainable,
        though — availability is tracked <b>per variant</b> against Epic's own
        enable/disable config, so a tier can be part-live (e.g. Gem is mid-rollout:
        some families' Gem variants are obtainable now, the rest gated until Epic
        flips them). Cube and Quack are fully live.
      </p>

      <h2 style="margin-top:22px;font-size:16px">Family abilities (base effect when equipped)</h2>
      <p>
        Every sprite family grants a unique passive when equipped. These descriptions
        are the <code>Description</code> FText lifted directly from Epic's own
        <code>ESD_*.uasset</code> DataAssets — the same text the in-game locker shows you,
        word for word. Rarity is inferred from the catalog's <code>summonCost</code>.
        Last extracted from <b>build ${esc(pakBuild)}</b> on <b>${esc(pakAuditStamp)}</b>;
        the audit re-runs whenever Fortnite ships a new build (a pak only changes on a
        client patch, so an unchanged stamp means Epic hasn't patched — not that the
        data is stale).
      </p>
      <div style="overflow-x:auto">
      <table class="audit-table">
        <thead>
          <tr>
            <th>Family</th>
            <th>Rarity</th>
            <th>Ability (from Epic's DataAsset)</th>
          </tr>
        </thead>
        <tbody>
          ${(await getPakFamilyAbilities()).map((a) => {
            const rarityColors = { Common: '#b6c0cf', Uncommon: '#4fd77a', Rare: '#5bf0ff', 'Very Rare': '#a678ff', Epic: '#c084fc', Legendary: '#ffcf3a', Mythic: '#ff6cc4', unknown: '#7a8395' };
            const rarityColor = rarityColors[a.rarity] || '#7a8395';
            return `
          <tr>
            <td data-label="Family"><b>${esc(a.family)}</b></td>
            <td data-label="Rarity"><span class="audit-token" style="color:${rarityColor};border-color:${rarityColor}66;font-size:11px">${esc(a.rarity)}</span></td>
            <td data-label="Ability" style="font-size:12.5px;line-height:1.5">${renderAbilityBody(a.ability)}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
      <p class="sub" style="font-size:12px;margin:10px 0 0">
        Ability text above is no longer sourced from third-party guides at all —
        every line is the <code>Description</code> FText lifted from that family's
        own <code>ESD_*.uasset</code> during the pak audit, so it matches what the
        in-game locker shows word for word. That closed the last gaps: Boss, King,
        Aura and Punk were previously listed here as undocumented because no
        public guide had published them, and Punk's real text turns out to be
        Epic's own joke — "Possibly nothing... or infinitely something."
      </p>

      <h2 style="margin-top:22px;font-size:16px">Sprite Dust re-summon costs</h2>
      ${renderDustCosts(state)}

      <h2 style="margin-top:22px;font-size:16px">Where our number comes from</h2>
      ${renderCountBreakdown(state)}

      ${renderHotfixSection(getHotfixCache())}

      <h2 style="margin-top:22px;font-size:16px">What we still can't determine</h2>
      <ul style="margin-bottom:0">
        <li><b>Release dates Epic hasn't announced.</b> Variants sitting in the
            catalog with no published date show as "Unreleased" with no countdown.
            We don't guess — if Epic's hotfix starts advertising a timestamp, or a
            player is observed owning one, the tracker updates itself.</li>
        <li><b>Two of the four audit endpoints aren't token-searched.</b> We record
            the athena cosmetic profile and Item Shop response sizes, but don't
            scan their bodies for individual tokens, so those cells read
            "not searched" rather than asserting a zero we never measured.</li>
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
    description: `Every Sprite variant Epic is actually serving, verified against four live endpoints on ${liveAuditStamp} — plus what's sitting in the pak unreleased. Receipts included.`,
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
  // Cap at 25 collectors — a whole friend group / clan, still bounds the query.
  slugs = Array.from(new Set(slugs.map((s) => String(s).slice(0, 64)))).slice(0, 25);
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
    const bySlug = new Map(rows.map((r) => [r.share_id, r]));
    const ordered = slugs.map((s) => bySlug.get(s)).filter(Boolean);
    const syncedAtBySlug = new Map(rows.map((r) => [r.share_id, r.synced_at]));

    // Per-user ownership / mastery sets keyed by variant name.
    const users = ordered.map((r) => {
      const state = JSON.parse(r.state_json);
      const owned = new Set(), mastered = new Set();
      for (const g of state.groups) for (const v of Object.values(g.variants)) {
        if (v.owned) owned.add(v.name);
        if (v.mastered) mastered.add(v.name);
      }
      return { displayName: r.display_name, shareId: r.share_id, owned, mastered, ownedCount: owned.size, masteredCount: mastered.size, syncedAt: syncedAtBySlug.get(r.share_id) };
    });
    const userBySlug = new Map(users.map((u) => [u.shareId, u]));

    // Canonical variant list (every state shares the same Epic catalog).
    const firstState = JSON.parse(ordered[0].state_json);
    const variants = firstState.groups.flatMap((g) => Object.values(g.variants).map((v) => ({ ...v, familyLabel: g.label })));
    const tierRank = Object.fromEntries(TIERS.map((t, i) => [t.key, i]));

    // Per-variant ownership across the group, rarest-first.
    const board = variants.map((v) => {
      const owners = users.filter((u) => u.owned.has(v.name));
      const masters = users.filter((u) => u.mastered.has(v.name));   // maxed (Lv5) it
      return { v, owners, ownerCount: owners.length, masters, masterCount: masters.length, obtainable: !v.vaulted && !v.future };
    });
    board.sort((a, b) => (a.ownerCount - b.ownerCount)
      || a.v.familyLabel.localeCompare(b.v.familyLabel)
      || ((tierRank[a.v.tierKey] ?? 99) - (tierRank[b.v.tierKey] ?? 99)));

    // Group aggregate: how much of the obtainable universe the group holds together.
    const obtainableCells = board.filter((b) => b.obtainable);
    const groupHas = obtainableCells.filter((b) => b.ownerCount > 0).length;
    const groupTotal = obtainableCells.length;
    const groupMissing = obtainableCells.filter((b) => b.ownerCount === 0);

    // Focus: view from ONE collector's perspective. Persisted in the URL (?as=)
    // so the auto-refresh reload keeps it and a focused view is shareable. null
    // = group view.
    const focus = (typeof req.query.as === 'string' && userBySlug.get(req.query.as)) || null;

    // "Trade-relevant" = obtainable AND some-have-some-don't. Drives the group
    // board default and the CSV. Vaulted/universal are excluded (nothing to do).
    const differ = board.filter((b) => b.obtainable && b.ownerCount > 0 && b.ownerCount < users.length);

    // ── Mastery axis ─────────────────────────────────────────────────────────
    // Second comparison mode for near-complete collectors: once everyone owns
    // everything, the endgame is MASTERY (Lv5). Trade signal here is "someone's
    // maxed it, someone who owns it is still leveling" — they can hand off a
    // maxed copy to cap each other. You can only master what you own, so a
    // mastery "needer" is an OWNER who hasn't mastered (not just anyone missing).
    const mode = req.query.mode === 'mastery' ? 'mastery' : 'collection';
    const isMastery = mode === 'mastery';
    // Sprites whose mastery CANNOT be traded: they auto-extract at max level, so
    // a Lv5 copy can't be held or handed off — each collector must solo the
    // grind. Dream (sleepysprite) explodes into legendary loot at Lv5 and
    // self-extracts (web-confirmed: gamerant / neonlightsmedia, 2026-08). Matched
    // on DISPLAY family label, never asset path (codenames make paths lie).
    const NO_TRADE_MASTERY = new Set(['dream']);
    const noTrade = (v) => NO_TRADE_MASTERY.has((v.familyLabel || '').toLowerCase());
    // Mastery-trade-relevant: obtainable, at least one owner maxed it AND at
    // least one owner hasn't (masterCount within (0, ownerCount)).
    const masteryDiffer = board.filter((b) => b.obtainable && b.masterCount > 0 && b.masterCount < b.ownerCount);

    // ── CSV export (?format=csv) — the trade-relevant set, machine-readable ──
    if (req.query.format === 'csv') {
      const escCsv = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
      let lines;
      if (isMastery) {
        lines = [['Sprite', 'Tier', 'Family', 'Mastered', 'StillLeveling', 'Tradeable'].join(',')];
        for (const b of masteryDiffer) {
          const laggards = b.owners.filter((u) => !u.mastered.has(b.v.name));
          lines.push([
            escCsv(`${b.v.tierLabel} ${b.v.familyLabel}`), escCsv(b.v.tierLabel), escCsv(b.v.familyLabel),
            escCsv(b.masters.map((u) => u.displayName).join('; ')),
            escCsv(laggards.map((u) => u.displayName).join('; ')),
            noTrade(b.v) ? 'NO (solo — auto-extracts at Lv5)' : 'yes',
          ].join(','));
        }
      } else {
        lines = [['Sprite', 'Tier', 'Family', 'Owners', 'Needers', 'OnlyOneOwner'].join(',')];
        for (const b of differ) {
          const needers = users.filter((u) => !u.owned.has(b.v.name));
          lines.push([
            escCsv(`${b.v.tierLabel} ${b.v.familyLabel}`), escCsv(b.v.tierLabel), escCsv(b.v.familyLabel),
            escCsv(b.owners.map((u) => u.displayName).join('; ')),
            escCsv(needers.map((u) => u.displayName).join('; ')),
            b.ownerCount === 1 ? '1' : '0',
          ].join(','));
        }
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="sprite-${isMastery ? 'mastery' : 'compare'}-${users.map((u) => u.shareId).join('-vs-').slice(0, 80)}.csv"`);
      return res.send(lines.join('\n'));
    }

    // ── shared bits ──
    const slugQS = slugs.map((s) => `u=${encodeURIComponent(s)}`).join('&');
    const modeQS = isMastery ? '&mode=mastery' : '';
    const hrefAs = (asSlug) => `/sprites/compare?${slugQS}${asSlug ? `&as=${encodeURIComponent(asSlug)}` : ''}${modeQS}`;
    // Mode toggle keeps the current "viewing as" focus so switching Collection ⇄
    // Mastery doesn't bounce you back to the group view.
    const hrefMode = (m) => `/sprites/compare?${slugQS}${focus ? `&as=${encodeURIComponent(focus.shareId)}` : ''}${m === 'mastery' ? '&mode=mastery' : ''}`;
    const modeToggle = `<div class="cb-modetoggle" role="tablist" aria-label="Compare by">
      <span class="cb-mode-lbl">Compare&nbsp;by</span>
      <a class="cb-mchip ${isMastery ? '' : 'on'}" role="tab" aria-selected="${isMastery ? 'false' : 'true'}" href="${hrefMode('collection')}">🗃️ Collection</a>
      <a class="cb-mchip ${isMastery ? 'on' : ''}" role="tab" aria-selected="${isMastery ? 'true' : 'false'}" href="${hrefMode('mastery')}">⭐ Mastery</a>
    </div>
    <style>
      .cb-modetoggle{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:2px 0 12px}
      .cb-mode-lbl{font-size:12px;color:#8b93a3;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
      .cb-mchip{display:inline-flex;align-items:center;gap:5px;padding:7px 15px;border-radius:999px;border:1px solid #2a2f3c;background:#12141a;color:#c3cad6;font-weight:700;font-size:13px;text-decoration:none;transition:all .12s}
      .cb-mchip:hover{border-color:#3a4250;color:#e8eaf0}
      .cb-mchip.on{background:linear-gradient(180deg,#2a2140,#211a34);border-color:var(--purple,#8b5cf6);color:#fff;box-shadow:0 0 0 1px var(--purple,#8b5cf6) inset}
      .cb-caveat{display:flex;gap:10px;align-items:flex-start;margin:0 0 12px;padding:10px 14px;background:#1a1508;border:1px solid #4a3a12;border-radius:10px;font-size:12.5px;color:#e8d9a8;line-height:1.45}
      .cb-caveat b{color:#ffd479}
      .cb-mtag{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:800;letter-spacing:.02em;vertical-align:middle}
      .cb-mtag.solo{background:#3a2a08;color:#ffd479;border:1px solid #5a4410}
      .cb-tile.cb-solo{outline:1px solid #5a4410}
      .cb-ctx.cb-mastered{color:#ffd479}
      .cb-detail .cb-mast>span{color:#ffd479}
    </style>`;
    const fmtRelative = (ts) => {
      if (!ts) return '—';
      const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    };
    const oldestSyncedAt = rows.reduce((acc, r) => {
      const t = r.synced_at ? new Date(r.synced_at).getTime() : 0;
      return (!acc || (t && t < acc)) ? t : acc;
    }, null);

    // Visual sprite tile — the shared unit of both views. `ctx` is the one-line
    // context under the name; `detail` is optional hidden who-has/who-needs HTML
    // revealed on click. `cls` adds state classes (dim/vault/unique).
    const tile = (b, { ctx = '', detail = '', cls = '', differ = null } = {}) => {
      const v = b.v;
      const tc = v.tierColor || '#9aa6b2';
      const phLetter = esc((v.tierLabel || '?')[0]);
      const phHtml = `<svg viewBox="0 0 100 100" class="ph"><rect width="100" height="100" rx="14" fill="#15171e"/><text x="50" y="62" text-anchor="middle" font-size="40" font-weight="800" fill="${esc(tc)}">${phLetter}</text></svg>`;
      const art = v.imgId
        ? `<img loading="lazy" src="/sprites/img/${esc(v.imgId)}.png" alt="${esc(v.familyLabel)} ${esc(v.tierLabel)}" onerror="this.outerHTML=this.dataset.ph" data-ph="${esc(phHtml)}">`
        : `<svg viewBox="0 0 100 100" class="ph"><rect width="100" height="100" rx="14" fill="#15171e"/><text x="50" y="62" text-anchor="middle" font-size="40" font-weight="800" fill="${tc}">${phLetter}</text></svg>`;
      const isDiffer = differ == null ? (b.obtainable && b.ownerCount > 0 && b.ownerCount < users.length) : differ;
      return `<div class="cb-tile ${cls}" data-tier="${esc(v.tierKey)}" data-tr="${tierRank[v.tierKey] ?? 99}" data-fam="${esc(v.familyLabel.toLowerCase())}" data-owners="${b.ownerCount}" data-differ="${isDiffer ? 1 : 0}" style="--tc:${tc}"${detail ? ' tabindex="0" role="button"' : ''}>
        <div class="cb-art">${art}</div>
        <div class="cb-meta">
          <span class="cb-tier">${esc(v.tierLabel)}</span>
          <b class="cb-fam">${esc(v.familyLabel)}</b>
          ${ctx}
        </div>
        ${detail}
      </div>`;
    };

    // Standings strip (compact leaderboard — you ranked this low, so it's a glance).
    const standings = [...users].sort((a, b) => (isMastery ? (b.masteredCount - a.masteredCount) || (b.ownedCount - a.ownedCount) : b.ownedCount - a.ownedCount));
    // Leaderboard entries link straight to each collector's full PROFILE — the
    // most accessible "go see this person's collection" spot. Switching the
    // analysis perspective is the separate "Viewing as" row below, so the two
    // intents don't collide (and profile links aren't buried in tile popovers).
    const standingsHtml = standings.map((u, i) => `<a class="cb-stand ${focus && focus.shareId === u.shareId ? 'on' : ''}" href="/sprites/u/${esc(u.shareId)}" title="View ${esc(u.displayName)}'s full collection — ${u.ownedCount} owned, ${u.masteredCount} mastered">
      <span class="cb-rank">#${i + 1}</span><b>${esc(u.displayName)}</b><span class="cb-stand-n" title="${isMastery ? 'mastered' : 'owned'}">${isMastery ? `⭐${u.masteredCount}` : u.ownedCount}</span><span class="cb-stand-go" aria-hidden="true">↗</span></a>`).join('');

    // "Viewing as" selector — chips on wide screens, a <select> on narrow.
    const chips = `<a class="cb-vchip ${focus ? '' : 'on'}" href="${hrefAs(null)}">👥 Whole group</a>` +
      users.map((u) => `<a class="cb-vchip ${focus && focus.shareId === u.shareId ? 'on' : ''}" href="${hrefAs(u.shareId)}">${esc(u.displayName)}</a>`).join('');
    const selectOpts = `<option value="${esc(hrefAs(null))}"${focus ? '' : ' selected'}>👥 Whole group</option>` +
      users.map((u) => `<option value="${esc(hrefAs(u.shareId))}"${focus && focus.shareId === u.shareId ? ' selected' : ''}>${esc(u.displayName)}</option>`).join('');
    const viewingAs = `<div class="cb-viewas">
      <span class="cb-viewas-lbl" title="Switch whose gaps/trades the board shows. Tap a name in the leaderboard above to open their full profile instead.">Viewing as</span>
      <div class="cb-chips">${chips}</div>
      <select class="cb-vselect" onchange="if(this.value)location.href=this.value">${selectOpts}</select>
    </div>`;

    // Controls: tier filter + sort + search (+ show-all only in group view).
    const controls = `<div class="cb-controls">
      <div class="cb-tiers">${TIERS.map((t) => `<label class="cb-tierpill" style="--tc:${t.color}"><input type="checkbox" checked data-tier="${esc(t.key)}"><span>${esc(t.label)}</span></label>`).join('')}</div>
      <div class="cb-ctl-row">
        <input type="search" id="cb-search" placeholder="🔍 family…" autocomplete="off">
        <select id="cb-sort">
          <option value="rarity">Rarest first</option>
          <option value="family">By family</option>
          <option value="tier">By tier</option>
        </select>
        ${focus ? '' : (isMastery
          ? '<label class="cb-toggle" title="Also show sprites nobody here has mastered yet and ones every owner already maxed — i.e. every owned sprite, not just the tradeable ones. Sprites nobody owns are never shown."><input type="checkbox" id="cb-showall"> ＋ show all owned</label>'
          : '<label class="cb-toggle" title="Also show sprites everyone here already owns. (Sprites nobody has are never shown.)"><input type="checkbox" id="cb-showall"> ＋ ones everyone has</label>')}
        <a class="cb-csv" href="/sprites/compare?${slugQS}&format=csv${modeQS}" download>⬇ CSV</a>
      </div>
    </div>`;

    // ── build the board body for whichever view ──
    let heading, boardHtml, footNote = '';
    if (isMastery && focus) {
      // Mastery focus — from ONE collector's chair, three buckets:
      //  • canCap  : me owns it, hasn't maxed it, someone here HAS → trade a Lv5 in
      //  • soloCap : same, but Dream — can't be traded, must grind it solo
      //  • lend    : me maxed it, others own-but-haven't → me can hand a Lv5 out
      const me = focus;
      const canCap = [], soloCap = [], lend = [];
      for (const b of board) {
        const v = b.v;
        if (!b.obtainable || !me.owned.has(v.name)) continue;   // can only master what you own
        if (me.mastered.has(v.name)) {
          const needers = users.filter((u) => u !== me && u.owned.has(v.name) && !u.mastered.has(v.name));
          if (needers.length && !noTrade(v)) lend.push({ b, needers });
        } else {
          const from = users.filter((u) => u !== me && u.mastered.has(v.name));
          if (!from.length) continue;
          (noTrade(v) ? soloCap : canCap).push({ b, from });
        }
      }
      canCap.sort((a, b) => a.b.masterCount - b.b.masterCount);   // rarest maxed-source first

      heading = `<b>${esc(me.displayName)}</b> can cap <b style="color:var(--gold)">${canCap.length}</b> ${canCap.length === 1 ? 'sprite' : 'sprites'} with a maxed copy from someone here`;
      const capTiles = canCap.map(({ b, from }) => {
        const links = from.slice(0, 3).map((u) => `<a href="/sprites/u/${esc(u.shareId)}" class="cb-fromlink">${esc(u.displayName)}</a>`).join(', ');
        const ctx = `<span class="cb-ctx cb-from">⭐ max from ${links}${from.length > 3 ? ` +${from.length - 3}` : ''}</span>`;
        return tile(b, { ctx, differ: true });
      }).join('');
      const soloTiles = soloCap.map(({ b }) => tile(b, {
        ctx: `<span class="cb-ctx cb-mastered">⚠ solo only — auto-extracts at Lv5<span class="cb-mtag solo">DREAM</span></span>`,
        cls: 'cb-solo', differ: true,
      })).join('');
      const lendTiles = lend.map(({ b, needers }) => tile(b, {
        ctx: `<span class="cb-ctx cb-need">${needers.length} here still leveling it</span>`, differ: true,
      })).join('');

      boardHtml = canCap.length
        ? `<div class="cb-grid" id="cb-grid">${capTiles}</div>`
        : `<div class="cb-empty">🎉 <b>${esc(me.displayName)}</b> has already mastered every sprite someone here could trade a Lv5 copy of. Nothing left to cap by trade.</div>`;
      footNote = `<p class="sub" style="margin:6px 0 0">Sprites <b>${esc(me.displayName)}</b> owns but hasn't mastered, where someone here holds a Lv5 to trade — tap a name to open their collection.</p>`;
      if (soloCap.length) {
        boardHtml += `<details class="cb-lev" open><summary>⚠ ${soloCap.length} sprite${soloCap.length === 1 ? '' : 's'} that must be mastered solo (can't be traded at Lv5)</summary>
          <div class="cb-grid" style="margin-top:12px">${soloTiles}</div></details>`;
      }
      if (lend.length) {
        boardHtml += `<details class="cb-lev"><summary>💪 ${lend.length} sprite${lend.length === 1 ? '' : 's'} <b>${esc(me.displayName)}</b> has maxed that others still need</summary>
          <div class="cb-grid" style="margin-top:12px">${lendTiles}</div></details>`;
      }
    } else if (isMastery) {
      // Mastery group board. Obtainable sprites ≥1 owner holds; default to the
      // mastery-differ set (someone maxed, someone still leveling). "Show all"
      // reveals ones every owner already maxed (nothing left to trade).
      const showTiles = board.filter((b) => !b.v.future && !b.v.vaulted && b.ownerCount > 0);
      const masteryDifferSet = new Set(masteryDiffer.map((b) => b.v.name));
      heading = `<b style="color:var(--gold)">${masteryDiffer.length}</b> sprites tradeable for mastery — someone's maxed, someone's still leveling`;
      boardHtml = `<div class="cb-grid" id="cb-grid">${showTiles.map((b) => {
        const v = b.v;
        const laggards = b.owners.filter((u) => !u.mastered.has(v.name));
        const isDiff = masteryDifferSet.has(v.name);
        const uniq = b.masterCount === 1 && isDiff;
        const solo = noTrade(v);
        const ctx = `<span class="cb-ctx cb-mastered">${uniq ? '⭐ ' : ''}${b.masterCount}/${b.ownerCount} mastered${solo ? '<span class="cb-mtag solo">SOLO</span>' : ''}</span>`;
        const detail = `<div class="cb-detail"><div class="cb-has cb-mast"><span>⭐ mastered</span> ${b.masters.map((u) => `<a href="/sprites/u/${esc(u.shareId)}">${esc(u.displayName)}</a>`).join('') || '<i>nobody yet</i>'}</div>
          <div class="cb-needs"><span>◔ leveling</span> ${laggards.map((u) => `<a href="/sprites/u/${esc(u.shareId)}">${esc(u.displayName)}</a>`).join('') || '<i>all owners maxed</i>'}</div>
          ${solo ? '<div class="cb-needs" style="color:#ffd479"><span>⚠</span> <i>Dream auto-extracts at Lv5 — cannot be traded; each owner must solo it.</i></div>' : ''}</div>`;
        return tile(b, { ctx, detail, cls: (uniq ? 'cb-uniq ' : '') + (solo ? 'cb-solo' : ''), differ: isDiff });
      }).join('')}</div>`;
      footNote = `<p class="sub" style="margin:6px 0 0">Owners who've maxed a sprite can trade a Lv5 copy to owners still leveling it — that's how you both hit the cap. Tap a sprite for who's maxed / still leveling. ⭐ = only one person has mastered it. Toggle <b>＋ show all owned</b> to include not-yet-started and already-fully-mastered sprites.</p>`;
    } else if (focus) {
      const me = focus;
      const missing = [];
      const leverage = [];
      for (const b of board) {
        const v = b.v;
        if (me.owned.has(v.name)) {
          const needers = users.filter((u) => u !== me && !u.owned.has(v.name));
          if (b.obtainable && needers.length) leverage.push({ b, needers });
        } else {
          // Only show gaps someone here can actually fill. Skip unreleased,
          // vaulted, AND sprites nobody in the group owns (a dead-end gap — matches
          // "don't show what nobody has"). Left: sprites this collector lacks that
          // at least one other collector owns.
          if (v.future || v.vaulted || b.owners.length === 0) continue;
          missing.push({ b });
        }
      }
      missing.sort((a, b) => a.b.ownerCount - b.b.ownerCount);   // rarest source first

      heading = `<b>${esc(me.displayName)}</b> is missing <b style="color:var(--gold)">${missing.length}</b> ${missing.length === 1 ? 'sprite' : 'sprites'} someone here can trade`;
      const missTiles = missing.map(({ b }) => {
        // Each owner links to their profile — the "who can I get this from" flow.
        const links = b.owners.slice(0, 3)
          .map((u) => `<a href="/sprites/u/${esc(u.shareId)}" class="cb-fromlink">${esc(u.displayName)}</a>`)
          .join(', ');
        const ctx = `<span class="cb-ctx cb-from">from ${links}${b.owners.length > 3 ? ` +${b.owners.length - 3}` : ''}</span>`;
        return tile(b, { ctx });
      }).join('');

      const levTiles = leverage.map(({ b, needers }) => tile(b, {
        ctx: `<span class="cb-ctx cb-need">${needers.length} here need${needers.length === 1 ? 's' : ''} it</span>`,
      })).join('');

      boardHtml = missing.length
        ? `<div class="cb-grid" id="cb-grid">${missTiles}</div>`
        : `<div class="cb-empty">🎉 <b>${esc(me.displayName)}</b> already has every sprite anyone else here owns. Nothing to trade for.</div>`;
      footNote = `<p class="sub" style="margin:6px 0 0">Sprites <b>${esc(me.displayName)}</b> lacks that someone here owns — tap a name to open their collection. Sprites nobody here has (and vaulted / unreleased) are hidden.</p>`;

      if (leverage.length) {
        boardHtml += `<details class="cb-lev"><summary>💪 ${leverage.length} sprite${leverage.length === 1 ? '' : 's'} <b>${esc(me.displayName)}</b> has that others still need</summary>
          <div class="cb-grid" style="margin-top:12px">${levTiles}</div></details>`;
      }
    } else {
      // Group view — the trade board. Only sprites SOMEONE here owns (ownerCount
      // > 0): a sprite nobody in the comparison has is noise, so it's dropped
      // entirely (not just hidden). Default shows the differ set (some have, some
      // don't); "show all" additionally reveals the ones EVERYONE already has.
      // Unreleased + vaulted are excluded too (not tradeable; the main grid still
      // shows those jail-barred).
      const showTiles = board.filter((b) => !b.v.future && !b.v.vaulted && b.ownerCount > 0);
      heading = `<b style="color:var(--gold)">${differ.length}</b> tradeable sprites — someone has, someone needs`;
      boardHtml = `<div class="cb-grid" id="cb-grid">${showTiles.map((b) => {
        const needers = users.filter((u) => !u.owned.has(b.v.name));
        const uniq = b.ownerCount === 1 && b.obtainable;
        const ctx = `<span class="cb-ctx">${uniq ? '⭐ ' : ''}${b.ownerCount}/${users.length} have it</span>`;
        const detail = `<div class="cb-detail"><div class="cb-has"><span>✓ has</span> ${b.owners.map((u) => `<a href="/sprites/u/${esc(u.shareId)}">${esc(u.displayName)}</a>`).join('') || '<i>nobody</i>'}</div>
          <div class="cb-needs"><span>✗ needs</span> ${needers.map((u) => `<a href="/sprites/u/${esc(u.shareId)}">${esc(u.displayName)}</a>`).join('') || '<i>everyone has it</i>'}</div></div>`;
        return tile(b, { ctx, detail, cls: uniq ? 'cb-uniq' : '' });
      }).join('')}</div>`;
      footNote = `<p class="sub" style="margin:6px 0 0">Only sprites someone here owns are shown — ones nobody has are hidden. Tap a sprite for who has / needs it. ⭐ = only one owner. Toggle <b>＋ ones everyone has</b> to add the ones you all share.</p>`;
    }

    const groupMastered = obtainableCells.filter((b) => b.masterCount > 0).length;
    const groupUnmastered = obtainableCells.filter((b) => b.masterCount === 0);
    const aggHas = isMastery ? groupMastered : groupHas;
    const aggMissList = isMastery ? groupUnmastered : groupMissing;
    const aggPct = groupTotal ? Math.round((aggHas / groupTotal) * 100) : 0;
    const missNames = aggMissList.slice(0, 4).map((b) => `${b.v.familyLabel} ${b.v.tierLabel}`).join(', ');
    const aggregate = `<div class="cb-agg">
      <div class="cb-agg-bar"><span style="width:${aggPct}%"></span></div>
      <div class="cb-agg-txt">Together this group ${isMastery ? 'has mastered' : 'holds'} <b>${aggHas}/${groupTotal}</b> obtainable sprites (${aggPct}%).
      ${aggMissList.length ? `${isMastery ? 'Nobody here has mastered' : 'Still missing as a group'}: <b>${esc(missNames)}</b>${aggMissList.length > 4 ? ` +${aggMissList.length - 4} more` : ''}.` : (isMastery ? 'Between you, every obtainable sprite is mastered. 🏆' : 'You collectively own every obtainable sprite. 🏆')}</div>
    </div>`;

    res.send(shell(`Compare ${users.length} collectors — CertiFried`, chrome(`<a class="navlink" href="/sprites/browse?${slugs.map((s) => `preselect=${encodeURIComponent(s)}`).join('&amp;')}">Add or remove collectors</a>`) + `<main>
      <section class="hero" style="display:block;padding:18px 26px">
        <div class="who" style="margin-bottom:10px">Comparing <b style="font-size:18px">${users.length} collectors</b></div>
        <div class="cb-standings">${standingsHtml}</div>
        ${aggregate}
        <div class="sub" style="margin:0 0 10px;font-size:12px">🔗 The more collectors linked, the faster this tracker sees exactly what's obtainable. <a href="/sprites" style="color:var(--purple);font-weight:700">Link your account →</a></div>
        ${modeToggle}
        ${viewingAs}
        <div id="cmp-refresh-bar" data-rendered-at="${Date.now()}" data-oldest-synced-at="${oldestSyncedAt || ''}"
             style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:12px;padding:9px 14px;background:#0e0f13;border:1px solid #2a2f3c;border-radius:10px;font-size:12.5px">
          <span style="display:flex;align-items:center;gap:6px">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3ad07a;animation:cmp-pulse 2s infinite"></span>
            <b style="color:#e8eaf0">Live</b><span class="sub">— auto-refreshes every 5 min.</span>
          </span>
          <span id="cmp-refresh-countdown" class="sub" style="font-variant-numeric:tabular-nums;font-weight:600;color:#cfe">next refresh in 5:00</span>
          <button id="cmp-pause-btn" type="button" class="cb-csv" style="margin-left:auto">⏸ Pause</button>
          <button id="cmp-refresh-now" type="button" class="cb-csv">🔄 Refresh now</button>
        </div>
        <style>@keyframes cmp-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.85)}}</style>
      </section>

      <section class="playercard" style="display:block">
        <div class="cardhead" style="margin-bottom:8px">${focus ? '🎯 ' : (isMastery ? '⭐ ' : '🤝 ')}${heading} <span id="cb-count" class="sub" style="font-weight:600"></span></div>
        ${controls}
        ${isMastery ? `<div class="cb-caveat">⚠️ <div><b>Dream can't be traded at Level 5.</b> It explodes into legendary loot and auto-extracts the instant it maxes, so a Lv5 Dream can't be held or handed off — everyone has to master Dream solo. Every other sprite's mastery can be passed around freely.</div></div>` : ''}
        ${boardHtml}
        ${footNote}
      </section>
    </main>
    <script>(function(){
      var grid = document.getElementById('cb-grid');
      var tiles = [].slice.call(document.querySelectorAll('#cb-grid > .cb-tile'));
      var pills = [].slice.call(document.querySelectorAll('.cb-tierpill input'));
      var search = document.getElementById('cb-search');
      var sortSel = document.getElementById('cb-sort');
      var showAll = document.getElementById('cb-showall');
      var count = document.getElementById('cb-count');
      function apply(){
        var allowed = {}; pills.forEach(function(p){ if(p.checked) allowed[p.dataset.tier]=1; });
        var q = (search && search.value || '').trim().toLowerCase();
        var shown = 0;
        tiles.forEach(function(el){
          var ok = allowed[el.dataset.tier];
          if (ok && q) ok = el.dataset.fam.indexOf(q) !== -1;
          if (ok && showAll && !showAll.checked) ok = el.dataset.differ === '1';
          el.style.display = ok ? '' : 'none';
          if (ok) shown++;
        });
        if (count) count.textContent = '(' + shown + ')';
      }
      function sortTiles(){
        if (!grid) return;
        var mode = sortSel ? sortSel.value : 'rarity';
        tiles.sort(function(a,b){
          if (mode === 'family') return a.dataset.fam.localeCompare(b.dataset.fam) || (a.dataset.tr - b.dataset.tr);
          if (mode === 'tier') return (a.dataset.tr - b.dataset.tr) || a.dataset.fam.localeCompare(b.dataset.fam);
          return (a.dataset.owners - b.dataset.owners) || a.dataset.fam.localeCompare(b.dataset.fam); // rarity
        });
        tiles.forEach(function(el){ grid.appendChild(el); });
      }
      pills.forEach(function(p){ p.addEventListener('change', apply); });
      if (search) search.addEventListener('input', apply);
      if (showAll) showAll.addEventListener('change', apply);
      if (sortSel) sortSel.addEventListener('change', function(){ sortTiles(); });
      // Tap a tile to reveal who-has / who-needs (group view only).
      tiles.forEach(function(el){
        if (!el.querySelector('.cb-detail')) return;
        el.addEventListener('click', function(){ el.classList.toggle('open'); });
        el.addEventListener('keydown', function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); el.classList.toggle('open'); } });
      });
      apply();

      // ── auto-refresh (focus is in the URL, so reload keeps the view) ──
      var REFRESH_INTERVAL_S = 5 * 60, paused = false, startedAt = Date.now();
      var countdownEl = document.getElementById('cmp-refresh-countdown');
      var pauseBtn = document.getElementById('cmp-pause-btn');
      var refreshNowBtn = document.getElementById('cmp-refresh-now');
      function fmtRemain(s){ var m = Math.floor(s/60), sec = s%60; return m + ':' + (sec<10?'0':'') + sec; }
      function tick(){
        if (!countdownEl) return;
        if (paused){ countdownEl.textContent = 'auto-refresh paused'; return; }
        if (document.hidden){ countdownEl.textContent = 'paused (tab hidden)'; return; }
        var remain = REFRESH_INTERVAL_S - Math.floor((Date.now()-startedAt)/1000);
        if (remain <= 0){ location.reload(); return; }
        countdownEl.textContent = 'next refresh in ' + fmtRemain(remain);
      }
      setInterval(tick, 1000); tick();
      if (pauseBtn) pauseBtn.addEventListener('click', function(){ paused = !paused; pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause'; if(!paused) startedAt = Date.now(); });
      if (refreshNowBtn) refreshNowBtn.addEventListener('click', function(){ location.reload(); });
      document.addEventListener('visibilitychange', tick);
    })();</script>`));
  } catch (e) {
    logger.warn(`[sprites] compare view failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + '<main><div class="card"><h2>Something went wrong</h2></div></main>'));
  }
});

// ── Release-schedule admin ──────────────────────────────────────────────────
// Editing availability without a redeploy. Rows here are the *prediction*
// layer only: Epic's hotfix ComingSoonTimestamp can override a date, and real
// observed ownership overrides everything, so a mistake here is self-limiting.
// Changes reach the site within ~30s (AVAILABILITY_REFRESH_MS).
//
// Times are entered/displayed in UTC deliberately. Epic drops land on a UTC
// instant (6 AM PT = 13:00 UTC in summer) and rendering the admin form in the
// operator's local zone is how off-by-an-offset bugs get introduced.
const dtLocalToMs = (s) => {
  if (!s) return null;
  const ms = Date.parse(`${s}:00Z`);      // treat the field as UTC, not local
  return Number.isFinite(ms) ? ms : null;
};
const msToDtLocal = (ms) => (ms == null ? '' : new Date(Number(ms)).toISOString().slice(0, 16));

// ── Self-audit: continuous accuracy + pipeline-health check ─────────────────
// Makes the one-off "0% doubt" audit permanent. Same bug classes we chased by
// hand — missing images, codename leaks, blank abilities, availability
// contradictions, label drift, a frozen sync pipeline — now surface themselves
// via /sprites/admin and an hourly timer that logs loudly on any regression.
// Reads the STABLE audit-account model (AUDIT_ACCOUNT_LABEL) for the accuracy
// checks — catalog structure is identical across accounts, and this never
// touches a stranger's ownership. Pipeline freshness aggregates all accounts.
const STALE_PIPELINE_MS = 6 * 60 * 60 * 1000;   // no sync anywhere in 6h = frozen
async function runSpriteHealthAudit() {
  const problems = [];
  const warnings = [];
  const P = (m) => problems.push(m);
  const W = (m) => warnings.push(m);
  const isLeak = (label) => label && label !== PENDING_FAMILY_LABEL && /sprite$/i.test(label);

  const [[ref]] = await pool.execute(
    'SELECT synced_at, state_json FROM epic_sprite_accounts WHERE display_name=? AND state_json IS NOT NULL LIMIT 1',
    [AUDIT_ACCOUNT_LABEL],
  );
  const model = ref?.state_json ? JSON.parse(ref.state_json) : null;
  const groups = model?.groups || [];

  let imgFiles = new Set();
  try {
    imgFiles = new Set(fsSync.readdirSync(SPRITE_IMG_DIR).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)));
  } catch (e) { W(`image dir unreadable: ${e.message}`); }

  const familyMeta = getPakScan()?.per_family_meta || {};
  const nf = (s) => String(s).toLowerCase().replace(/sprite$/, '');
  const abilityFor = (token) => !!resolveFamilyAbility(token, familyMeta);

  let variantCount = 0;
  const labelsByFam = new Map();
  for (const g of groups) {
    if (g.labelPending) W(`family "${g.familyToken}" has no resolved name yet (showing "${PENDING_FAMILY_LABEL}") — add a FAMILY_LABEL entry or boot the game so the pak-scan runs`);
    if (isLeak(g.label)) P(`CODENAME LEAK: family "${g.familyToken}" label = "${g.label}"`);
    if (!g.labelPending && !abilityFor(g.familyToken)) W(`family "${g.familyToken}" (${g.label}) has no pak ability text`);
    if (!labelsByFam.has(g.familyToken)) labelsByFam.set(g.familyToken, new Set());
    for (const v of Object.values(g.variants || {})) {
      variantCount++;
      labelsByFam.get(g.familyToken).add(v.familyLabel);
      const id = `${g.familyToken}/${v.tierKey}`;
      if (!v.imgId) { if (!v.future) W(`${id} (${g.label} ${v.tierLabel}) has no imgId`); }
      else if (imgFiles.size && !imgFiles.has(v.imgId)) P(`MISSING IMAGE: ${id} → ${v.imgId}.png not on disk`);
      if (isLeak(v.familyLabel)) P(`CODENAME LEAK: ${id} familyLabel = "${v.familyLabel}"`);
      if (!v.tierLabel) P(`no tier label: ${id}`);
      if (v.future && v.owned) P(`contradiction future+owned: ${id}`);
      if (v.future && v.vaulted) P(`contradiction future+vaulted: ${id}`);
    }
  }
  for (const [token, set] of labelsByFam) if (set.size > 1) P(`label drift: "${token}" → ${[...set].join(' / ')}`);

  const effectTiers = new Set(PAK_SPECIAL_TIER_EFFECTS.map((t) => t.tierKey));
  const usedTiers = new Set(groups.flatMap((g) => Object.values(g.variants || {}).map((v) => v.tierKey)));
  for (const t of usedTiers) if (t !== 'basic' && !effectTiers.has(t)) W(`tier "${t}" has no effect text in PAK_SPECIAL_TIER_EFFECTS`);

  // ── #2 GROUND-TRUTH reconciliation vs Epic's own hotfix ────────────────────
  // Epic disables a variant by unmapping it (`MappingID;None`) in the DDSS
  // registry. Anything we show OBTAINABLE that Epic has disabled is an
  // over-claim — the dangerous direction (this would have caught the Gem drift).
  // Match on the NORMALIZED family:tier key (not the raw name) so Epic's
  // `_0`-style names (Ironmouse) are caught — the old exact-name match silently
  // missed them, which is exactly how Ironmouse over-claimed off a lapsed timer.
  const disabled = new Set((getHotfixCache()?.disabled_variants || []).map(normDisabledKey).filter(Boolean));
  const byKey = new Map();
  for (const g of groups) for (const v of Object.values(g.variants || {})) byKey.set(`${g.familyToken}:${v.tierKey}`, { v, g });
  let disabledGated = 0;
  for (const key of disabled) {
    const hit = byKey.get(key);
    if (!hit) continue;   // Epic disabled a variant our catalog doesn't serve (e.g. Punk Gem) — irrelevant
    const { v, g } = hit;
    if (!v.future && !v.vaulted && !v.owned) {
      P(`OVER-CLAIM: ${g.familyToken}/${v.tierKey} shown obtainable but Epic's hotfix has it DISABLED (MappingID;None) — should be gated`);
    } else disabledGated++;
  }

  // ── #1 drift signals ───────────────────────────────────────────────────────
  // Staggered tier (some cells live, some gated — the Gem case). Not a problem,
  // but surfaced so a partial rollout is visible rather than silent.
  const tierState = {};
  for (const g of groups) for (const v of Object.values(g.variants || {})) {
    if (!tierState[v.tierKey]) tierState[v.tierKey] = { live: 0, gated: 0 };
    if (v.future) tierState[v.tierKey].gated++; else if (!v.vaulted) tierState[v.tierKey].live++;
  }
  const staggered = Object.entries(tierState)
    .filter(([, s]) => s.live > 0 && s.gated > 0)
    .map(([t, s]) => `${t} (${s.live} live / ${s.gated} gated)`);
  if (staggered.length) W(`staggered tier rollout: ${staggered.join(', ')} — per-family availability, verify it tracks Epic`);

  // Ghost drop: a scheduled date has passed but NOTHING of that tier has been
  // observed anywhere — did the drop actually land, or did Epic slip it?
  const sched = activeSchedule();
  const obsTiers = new Set(getObservedAvailability().tiers);
  for (const [key, s] of Object.entries(sched.tiers || {})) {
    if (s.at != null && s.at < Date.now() && !obsTiers.has(key)) {
      W(`scheduled tier "${key}" release date passed (${new Date(s.at).toISOString().slice(0, 10)}) but ZERO observed ownership — did it drop, or slip?`);
    }
  }

  const [[agg]] = await pool.execute(
    `SELECT COUNT(*) total, SUM(state_json IS NOT NULL) withState, SUM(needs_relogin=1) dead,
            MAX(synced_at) newest, SUM(synced_at < (NOW() - INTERVAL 6 HOUR)) stale
     FROM epic_sprite_accounts`,
  );
  const newestMs = agg.newest ? new Date(agg.newest).getTime() : 0;
  const pipeline = {
    accounts: Number(agg.total) || 0,
    withState: Number(agg.withState) || 0,
    dead: Number(agg.dead) || 0,
    stale: Number(agg.stale) || 0,
    newestSyncedAt: agg.newest || null,
    newestAgeMin: newestMs ? Math.floor((Date.now() - newestMs) / 60000) : null,
  };
  if (newestMs && (Date.now() - newestMs) > STALE_PIPELINE_MS) {
    P(`PIPELINE STALE: newest sync across all accounts is ${pipeline.newestAgeMin} min old (> 6h) — sync may be broken`);
  }
  if (!groups.length) P(`no reference model — audit account "${AUDIT_ACCOUNT_LABEL}" has no state_json`);

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    stats: { families: groups.length, variants: variantCount, imageFiles: imgFiles.size, refSyncedAt: ref?.synced_at || null },
    pipeline,
    reconcile: { hotfixDisabled: disabled.size, disabledGatedOk: disabledGated, staggered },
  };
}

// Alerts go to the tracker owner's Discord DM (via the bot token). Deduped so a
// standing problem pings ONCE, not every hour, plus an all-clear when it resolves.
const SPRITE_ALERT_USER_ID = '365905620060340224';
let _lastSpriteAlertSig = null;
async function dmSpriteAlert(content) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return;
  try {
    const r1 = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: SPRITE_ALERT_USER_ID }),
    });
    const ch = await r1.json();
    if (!ch?.id) { logger.warn(`[sprite-audit] DM channel open failed: ${r1.status}`); return; }
    await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
      method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
    });
  } catch (e) { logger.warn(`[sprite-audit] DM alert failed: ${e.message}`); }
}

// Hourly self-check: log LOUDLY on any hard problem so a regression can't hide
// between admin visits. Accuracy drifts on patch/sync boundaries, not by the
// second, so hourly is plenty.
async function periodicHealthCheck() {
  try {
    const a = await runSpriteHealthAudit();
    if (a.problems.length) {
      logger.error(`[sprite-audit] ${a.problems.length} PROBLEM(S): ${a.problems.slice(0, 6).join(' | ')}`);
      const sig = a.problems.join('\n');
      if (sig !== _lastSpriteAlertSig) {              // only DM when the problem set CHANGES — no hourly spam
        _lastSpriteAlertSig = sig;
        await dmSpriteAlert(`⚠️ **Sprite Tracker — ${a.problems.length} accuracy problem(s) detected:**\n${a.problems.map((p) => `• ${p}`).join('\n')}\n\nSee /sprites/admin for the full audit.`);
      }
    } else if (_lastSpriteAlertSig) {                 // problems just cleared — send one all-clear
      _lastSpriteAlertSig = null;
      await dmSpriteAlert('✅ Sprite Tracker — all accuracy problems resolved. Back to clean.');
    }
  } catch (e) { logger.warn(`[sprite-audit] health check failed: ${e.message}`); }
}
setTimeout(periodicHealthCheck, 15000);
setInterval(periodicHealthCheck, 60 * 60 * 1000);

// Renders the health audit as an admin card: a PASS/FAIL verdict, the pipeline
// freshness line, and any problem/warning detail.
function renderHealthAudit(a) {
  const fmtTs = (t) => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
  const verdict = a.ok
    ? `<span class="pill ok">✓ ${a.warnings.length ? 'PASS (with notes)' : 'ALL CLEAR'}</span>`
    : `<span class="pill bad">✗ ${a.problems.length} PROBLEM${a.problems.length === 1 ? '' : 'S'}</span>`;
  const pl = a.pipeline;
  const freshPill = pl.newestAgeMin == null ? '<span class="pill warn">no syncs</span>'
    : pl.newestAgeMin > 360 ? `<span class="pill bad">newest sync ${pl.newestAgeMin}m ago</span>`
      : `<span class="pill ok">newest sync ${pl.newestAgeMin}m ago</span>`;
  const list = (arr, cls) => arr.length
    ? `<ul class="audit-list ${cls}">${arr.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`
    : '';
  return `<section class="playercard" style="display:block;margin-top:22px">
    <div class="cardhead" style="margin-bottom:8px">🩺 Health &amp; accuracy audit ${verdict}</div>
    <p class="sub" style="margin:0 0 10px">Auto-runs hourly (DMs the owner on any change) and on every visit here. Checks images on disk, codename leaks, ability coverage, availability contradictions, label drift, pipeline freshness, and reconciles our obtainable set against <b>Epic's own hotfix disable list</b> (the ground-truth availability feed). Reference: <b>${esc(AUDIT_ACCOUNT_LABEL)}</b> · ${a.stats.families} families / ${a.stats.variants} variants / ${a.stats.imageFiles} images.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      ${freshPill}
      ${a.reconcile ? `<span class="pill ${a.problems.some((p) => p.startsWith('OVER-CLAIM')) ? 'bad' : 'ok'}">Epic hotfix: ${a.reconcile.hotfixDisabled} disabled · ${a.reconcile.disabledGatedOk} correctly gated</span>` : ''}
      ${a.reconcile && a.reconcile.staggered.length ? `<span class="pill warn">staggered: ${esc(a.reconcile.staggered.join(', '))}</span>` : ''}
      <span class="pill ${pl.dead ? 'warn' : 'ok'}">${pl.dead} need re-login</span>
      <span class="pill ${pl.stale ? 'warn' : 'ok'}">${pl.stale} stale (&gt;6h)</span>
      <span class="pill ok">${pl.withState}/${pl.accounts} accounts synced</span>
      <span class="sub">reference synced ${esc(fmtTs(a.stats.refSyncedAt))}</span>
    </div>
    ${a.problems.length ? `<div class="sub" style="color:#ff8aa6;font-weight:800;margin:4px 0">Problems</div>${list(a.problems, 'bad')}` : ''}
    ${a.warnings.length ? `<div class="sub" style="color:#ffcf3a;font-weight:800;margin:8px 0 4px">Notes / warnings</div>${list(a.warnings, 'warn')}` : ''}
    ${a.ok && !a.warnings.length ? '<p class="sub">Nothing to flag — every variant has a real name, image, ability, and consistent availability. 0% doubt. ✓</p>' : ''}
  </section>`;
}

async function renderScheduleAdmin(req) {
  const [rows] = await pool.execute(
    'SELECT scope,item_key,release_at,gate,label,note_label,note_text FROM epic_sprite_release_schedule ORDER BY scope, item_key',
  );
  const [obs] = await pool.execute(
    'SELECT tier_key, COUNT(*) n FROM epic_sprite_observed_variants GROUP BY tier_key ORDER BY n DESC',
  );
  // One recent model so each row can say how many sprites it actually affects —
  // "affects 8 sprites" means far more to an operator than a raw tier key does.
  const counts = {};
  try {
    const [[recent]] = await pool.execute(
      'SELECT state_json FROM epic_sprite_accounts WHERE state_json IS NOT NULL ORDER BY synced_at DESC LIMIT 1',
    );
    for (const g of JSON.parse(recent.state_json).groups || []) {
      for (const v of Object.values(g.variants || {})) {
        counts[`tier:${v.tierKey}`] = (counts[`tier:${v.tierKey}`] || 0) + 1;
        counts[`family:${v.familyToken}`] = (counts[`family:${v.familyToken}`] || 0) + 1;
      }
    }
  } catch { /* the count is a nicety — never block the page on it */ }

  const sched = activeSchedule();
  const hf = getHotfixCache();
  const epicAt = hf?.next_drop_ts ? hf.next_drop_ts * 1000 : null;
  const tierLabel = Object.fromEntries(TIERS.map((t) => [t.key, t.label]));
  const prettyName = (scope, key) => (scope === 'tier'
    ? `${tierLabel[key] || key} variants`
    : (FAMILY_LABEL[key] || key));
  const human = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const until = (ms) => {
    const d = ms - Date.now();
    if (d <= 0) return 'now';
    const h = Math.floor(d / 3600000);
    const m = Math.floor((d % 3600000) / 60000);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    return h ? `${h}h ${m}m` : `${m}m`;
  };

  const cards = rows.map((r) => {
    const live = (r.scope === 'tier' ? sched.tiers : sched.families)[r.item_key];
    const effAt = live?.at ?? (r.release_at == null ? null : Number(r.release_at));
    const epicWon = effAt != null && r.release_at != null && Number(r.release_at) !== effAt;
    const proven = obs.find((o) => o.tier_key === r.item_key);
    const n = counts[`${r.scope}:${r.item_key}`];

    // Status in plain language: what a visitor sees right now, and why.
    let badge; let why;
    if (proven) {
      badge = '<span class="pill ok">Available</span>';
      why = `Players own ${proven.n} of these, so it stays unlocked no matter what date is set below.`;
    } else if (!r.gate) {
      badge = '<span class="pill ok">Available</span>';
      why = (effAt != null && Date.now() < effAt)
        ? `Obtainable already — this row only adds the note below, which clears itself in <b>${until(effAt)}</b>.`
        : 'Obtainable already — this row only adds the note below.';
    } else if (effAt == null) {
      badge = '<span class="pill">Locked</span>';
      why = 'Locked with no date, so it shows as "Unreleased" with no countdown.';
    } else if (Date.now() >= effAt) {
      badge = '<span class="pill ok">Available</span>';
      why = `Unlocked on ${human(effAt)}.`;
    } else {
      badge = '<span class="pill warn">Locked</span>';
      why = `Counting down — unlocks in <b>${until(effAt)}</b> (${human(effAt)}).`;
    }

    return `<div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <b style="font-size:15px">${esc(prettyName(r.scope, r.item_key))}</b>
        ${badge}
        <span class="sub">${n ? `affects ${n} sprite${n === 1 ? '' : 's'}` : ''}</span>
      </div>
      <p class="sub" style="margin:6px 0 0">${why}</p>
      ${epicWon ? `<p class="sub" style="margin:4px 0 0;color:#ffcf3a">⚠ Epic's own hotfix says <b>${esc(human(effAt))}</b>, so that is being used instead of the date below.</p>` : ''}
      ${(r.note_label || r.note_text) ? `<p class="sub" style="margin:8px 0 0;padding:8px 10px;border-left:3px solid #ffcf3a;background:rgba(255,207,58,.07);border-radius:0 6px 6px 0">
        <b>Note shown on this sprite:</b> ${r.note_label ? `<b>${esc(r.note_label)}</b>` : ''}${(r.note_label && r.note_text) ? ' — ' : ''}${esc(r.note_text || '')}</p>` : ''}

      <form method="post" action="/sprites/admin/schedule" style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="hidden" name="scope" value="${esc(r.scope)}">
        <input type="hidden" name="item_key" value="${esc(r.item_key)}">
        <label class="sub">${r.gate ? 'Unlocks at' : 'Note clears at'}
          <input type="datetime-local" name="release_at" value="${esc(msToDtLocal(r.release_at))}" style="margin-left:6px">
          <span style="opacity:.7">UTC</span>
        </label>
        <button class="btn" type="submit" name="action" value="save">Save date</button>
        ${(r.gate && !proven && (effAt == null || Date.now() < effAt))
          ? '<button class="btn" type="submit" name="action" value="unlock" title="Mark available immediately">Unlock now</button>'
          : ''}
        <details style="width:100%;margin-top:4px">
          <summary class="sub" style="cursor:pointer">More options</summary>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">
            <label class="sub" title="Off = already obtainable; the row then only shows the note">
              <input type="checkbox" name="gate" value="1" ${r.gate ? 'checked' : ''}> Lock until the date
            </label>
            <input type="text" name="label" aria-label="Countdown label" value="${esc(r.label || '')}" placeholder="Countdown label" size="24">
            <input type="text" name="note_label" aria-label="Note title" value="${esc(r.note_label || '')}" placeholder="Note title" size="16">
            <input type="text" name="note_text" aria-label="Note shown on the sprite" value="${esc(r.note_text || '')}" placeholder="Note shown on the sprite" size="34">
            <button class="btn" type="submit" name="action" value="save">Save all</button>
            <button class="btn" type="submit" name="action" value="delete"
              onclick="return confirm('Remove this from the schedule? It will be treated as available.')">Remove row</button>
          </div>
        </details>
      </form>
    </div>`;
  }).join('');

  const provenPills = obs.map((o) => `<span class="pill ok">${esc(tierLabel[o.tier_key] || o.tier_key)} · ${o.n}</span>`).join(' ')
    || '<span class="sub">nothing recorded yet</span>';
  const discovered = discoveredTierKeys();
  const emptyState = '<div class="card"><p class="sub">No rows — everything in Epic&#39;s catalog is treated as available.</p></div>';

  return `<section style="margin-top:30px">
    <div class="who" style="margin-bottom:4px">Release schedule<b>What shows as locked</b>
      <span class="since">Changes go live within ~30 seconds — no redeploy</span></div>
    <p class="sub" style="margin:6px 0 16px">
      Only add a row for something that <b>isn&#39;t out yet</b>. Anything without a row counts as available.
      Two things can override a date you set here: Epic&#39;s own hotfix, and players actually owning the sprite — whichever says &quot;available&quot; wins.
    </p>

    ${cards || emptyState}

    <details style="margin-top:6px">
      <summary class="sub" style="cursor:pointer">➕ Add a row</summary>
      <form method="post" action="/sprites/admin/schedule" class="card" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select name="scope"><option value="tier">a whole tier</option><option value="family">one sprite family</option></select>
        <input type="text" name="item_key" placeholder="e.g. cube  /  companystargazer" size="26" required>
        <label class="sub">Unlocks at <input type="datetime-local" name="release_at" style="margin-left:6px"><span style="opacity:.7">UTC</span></label>
        <label class="sub"><input type="checkbox" name="gate" value="1" checked> Lock until then</label>
        <input type="text" name="label" placeholder="Countdown label" size="20">
        <button class="btn" type="submit" name="action" value="save">Add</button>
        <p class="sub" style="width:100%;margin:2px 0 0">Leave the date blank for &quot;announced, no date yet&quot; — shows as Unreleased with no countdown.</p>
      </form>
    </details>

    <div style="margin-top:16px">
      <div class="sub" style="margin-bottom:6px"><b>Proven available</b> — tiers a real account is holding. These stay unlocked regardless of any date above.</div>
      ${provenPills}
    </div>

    ${epicAt ? `<p class="sub" style="margin-top:12px">Epic&#39;s hotfix currently advertises the next drop as <b>${esc(human(epicAt))}</b>${epicAt <= Date.now() ? ' — in the past, so it is being ignored' : ''}.</p>` : ''}

    ${discovered.length ? `<p class="sub" style="margin-top:12px;color:#ffcf3a">
      ⚠ <b>New tier${discovered.length === 1 ? '' : 's'} spotted in Epic&#39;s catalog:</b> ${discovered.map((d) => `<code>${esc(d)}</code>`).join(', ')}.
      Added to the grid automatically and shown as locked. Add a row above to give ${discovered.length === 1 ? 'it' : 'them'} a countdown.
    </p>` : ''}
  </section>`;
}


// ── Announced-but-unshipped sprites (epic_sprite_announced) ─────────────────
// The /info "rumored sprites" check reports these as "announced" (with date, rarity, ability and
// how to get) until Epic's catalog or the pak shows the sprite, at which point "shipped" wins.
// Only enabled rows are read (loadAnnouncedSprites); this form is the table's only writer.
const ANN_RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic', 'Exotic'];
const annSlugOf = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

async function renderAnnouncedAdmin() {
  let rows = [];
  let missing = false;
  try {
    [rows] = await pool.execute(
      'SELECT slug, name, release_at, rarity, ability, how_to_get, source_url, family_token, enabled, updated_at FROM epic_sprite_announced ORDER BY enabled DESC, release_at IS NULL, release_at, name',
    );
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    missing = true;
  }
  const human = (ms) => new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const rarityList = `<datalist id="ann-rarities">${ANN_RARITIES.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>`;
  const fields = (r = {}) => `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
        <input type="text" name="name" aria-label="Name" value="${esc(r.name || '')}" placeholder="Name, as Epic writes it" maxlength="80" size="22" required>
        <label class="sub">Release <input type="datetime-local" name="release_at" value="${esc(msToDtLocal(r.release_at))}" style="margin-left:6px"><span style="opacity:.7">UTC</span></label>
        <input type="text" name="rarity" aria-label="Rarity" value="${esc(r.rarity || '')}" placeholder="Rarity" maxlength="24" size="10" list="ann-rarities">
        <input type="text" name="family_token" aria-label="Catalog codename" value="${esc(r.family_token || '')}" placeholder="Catalog codename (when known)" maxlength="48" size="24">
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <textarea name="ability" aria-label="Ability" rows="2" maxlength="2000" placeholder="Ability" style="flex:1 1 240px;min-width:0">${esc(r.ability || '')}</textarea>
        <textarea name="how_to_get" aria-label="How to get it" rows="2" maxlength="2000" placeholder="How to get it" style="flex:1 1 240px;min-width:0">${esc(r.how_to_get || '')}</textarea>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">
        <input type="url" name="source_url" aria-label="Source link" value="${esc(r.source_url || '')}" placeholder="Source link (Epic post, article)" maxlength="300" size="46">
      </div>`;

  const cards = rows.map((r) => {
    const at = r.release_at == null ? null : Number(r.release_at);
    const badge = !r.enabled ? '<span class="pill">Hidden</span>'
      : at == null ? '<span class="pill warn">Announced, no date</span>'
        : at > Date.now() ? `<span class="pill warn">Due ${esc(human(at))}</span>`
          : `<span class="pill bad">Date passed ${esc(human(at))}</span>`;
    return `<div class="card" style="margin-bottom:12px${r.enabled ? '' : ';opacity:.7'}">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <b style="font-size:15px">${esc(r.name)}</b>${badge}
        <code class="sub">${esc(r.slug)}</code>
        ${r.rarity ? `<span class="sub">${esc(r.rarity)}</span>` : ''}
      </div>
      ${(at != null && at <= Date.now() && r.enabled) ? '<p class="sub" style="margin:6px 0 0">If it has shipped, /info already reports it as shipped; remove or hide this row when you like.</p>' : ''}
      <form method="post" action="/sprites/admin/announced">
        <input type="hidden" name="slug" value="${esc(r.slug)}">
        ${fields(r)}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <button class="btn" type="submit" name="action" value="save">Save</button>
          ${r.enabled
    ? '<button class="btn" type="submit" name="action" value="disable" formnovalidate title="Stop reporting it, keep the row">Hide</button>'
    : '<button class="btn" type="submit" name="action" value="enable" formnovalidate>Show again</button>'}
          <button class="btn" type="submit" name="action" value="delete" formnovalidate
            onclick="return confirm('Remove this announced sprite?')">Remove</button>
        </div>
      </form>
    </div>`;
  }).join('');

  return `<section style="margin-top:30px">
    <div class="who" style="margin-bottom:4px">Announced sprites<b>Confirmed but not in Epic&#39;s catalog yet</b>
      <span class="since">Used by the rumored-sprites check on /sprites/info; changes apply at once</span></div>
    <p class="sub" style="margin:6px 0 16px">
      Add a sprite Epic has announced but not shipped, so it is reported as <b>announced</b> (with its date) instead of &quot;no evidence&quot;.
      It never adds a grid tile. As soon as the sprite is in the catalog or the pak it is reported as shipped, whatever this list says.
    </p>
    ${missing ? '<div class="card"><p class="sub">The announced-sprites table does not exist on this server yet (migration 167).</p></div>' : (cards || '<div class="card"><p class="sub">No announced sprites.</p></div>')}
    ${missing ? '' : `<details style="margin-top:6px">
      <summary class="sub" style="cursor:pointer">Add an announced sprite</summary>
      <form method="post" action="/sprites/admin/announced" class="card" style="margin-top:8px">
        <input type="hidden" name="action" value="save">
        <input type="hidden" name="is_new" value="1">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" name="slug" aria-label="Short id" placeholder="Short id, e.g. john-wick (made from the name if blank)" maxlength="48" size="44" pattern="[a-z0-9][a-z0-9-]*">
        </div>
        ${fields()}
        <div style="margin-top:8px"><button class="btn" type="submit">Add</button></div>
      </form>
    </details>`}
    ${rarityList}
  </section>`;
}

router.post('/admin/announced', async (req, res) => {
  const acct = req.session?.epicAccountId;
  if (!acct || !ADMIN_ACCOUNT_IDS.has(acct)) return res.status(403).send('Forbidden');
  const back = (msg) => res.redirect('/sprites/admin' + (msg ? `?ann=${encodeURIComponent(msg)}` : '') + '#announced');
  try {
    const action = String(req.body.action || 'save');
    const isNew = req.body.is_new === '1';
    const text = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
    const slug = annSlugOf(text(req.body.slug, 48) || (isNew ? text(req.body.name, 80) : ''));
    if (!slug) return back('Give the sprite a name.');

    if (action === 'delete') {
      await pool.execute('DELETE FROM epic_sprite_announced WHERE slug = ?', [slug]);
      logger.warn(`[sprite-announced] admin ${acct} REMOVED ${slug}`);
    } else if (action === 'disable' || action === 'enable') {
      await pool.execute('UPDATE epic_sprite_announced SET enabled = ? WHERE slug = ?', [action === 'enable' ? 1 : 0, slug]);
      logger.warn(`[sprite-announced] admin ${acct} ${action === 'enable' ? 'SHOWED' : 'HID'} ${slug}`);
    } else {
      const name = text(req.body.name, 80);
      if (!name) return back('Give the sprite a name.');
      const rawAt = text(req.body.release_at, 32);
      // Strict YYYY-MM-DDTHH:MM (the datetime-local format): Date.parse alone accepts junk such as
      // "not-a-date:00Z" as the year 2000.
      const at = rawAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(rawAt) ? dtLocalToMs(rawAt) : null;
      if (rawAt && at == null) return back('That release date is not a valid date.');
      const rarity = text(req.body.rarity, 24);
      const ability = text(req.body.ability, 2000);
      const howToGet = text(req.body.how_to_get, 2000);
      let sourceUrl = text(req.body.source_url, 300);
      if (sourceUrl) {
        try {
          const u = new URL(sourceUrl);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
          sourceUrl = u.href.slice(0, 300);
        } catch { return back('The source link must be a full http(s) address.'); }
      }
      const fam = text(req.body.family_token, 48);
      const familyToken = fam ? fam.toLowerCase() : null;
      if (familyToken && !/^[a-z0-9_-]+$/.test(familyToken)) return back('The catalog codename can only use letters, numbers, - and _.');
      if (isNew) {
        const [[exists]] = await pool.execute('SELECT 1 AS x FROM epic_sprite_announced WHERE slug = ?', [slug]);
        if (exists) return back(`"${slug}" is already in the list; edit that row instead.`);
        await pool.execute(
          `INSERT INTO epic_sprite_announced (slug, name, release_at, rarity, ability, how_to_get, source_url, family_token, enabled)
           VALUES (?,?,?,?,?,?,?,?,1)`,
          [slug, name, at, rarity, ability, howToGet, sourceUrl, familyToken],
        );
        logger.warn(`[sprite-announced] admin ${acct} ADDED ${slug} at=${at ? new Date(at).toISOString() : 'null'}`);
      } else {
        const [r] = await pool.execute(
          `UPDATE epic_sprite_announced SET name=?, release_at=?, rarity=?, ability=?, how_to_get=?, source_url=?, family_token=?
            WHERE slug=?`,
          [name, at, rarity, ability, howToGet, sourceUrl, familyToken, slug],
        );
        if (!r.affectedRows) return back('That row no longer exists.');
        logger.warn(`[sprite-announced] admin ${acct} SAVED ${slug} at=${at ? new Date(at).toISOString() : 'null'}`);
      }
    }
    await loadAnnouncedSprites();   // apply now rather than at the next 30s refresh
    return back('Saved.');
  } catch (e) {
    logger.warn(`[sprites] announced save failed: ${e.message}`);
    return back('Could not save: ' + e.message);
  }
});

router.post('/admin/schedule', async (req, res) => {
  const acct = req.session?.epicAccountId;
  if (!acct || !ADMIN_ACCOUNT_IDS.has(acct)) return res.status(403).send('Forbidden');
  try {
    const scope = req.body.scope === 'family' ? 'family' : 'tier';
    const key = String(req.body.item_key || '').trim().toLowerCase();
    if (!key) return res.redirect('/sprites/admin');
    if (req.body.action === 'delete') {
      await pool.execute('DELETE FROM epic_sprite_release_schedule WHERE scope=? AND item_key=?', [scope, key]);
      logger.warn(`[sprite-schedule] admin ${acct} DELETED ${scope}/${key} — now treated as live`);
    } else if (req.body.action === 'unlock') {
      // "Unlock now" — backdate rather than delete, so the row (and its label
      // and note) survives and the change is auditable via updated_at.
      await pool.execute(
        'UPDATE epic_sprite_release_schedule SET release_at=?, gate=1 WHERE scope=? AND item_key=?',
        [Date.now(), scope, key],
      );
      logger.warn(`[sprite-schedule] admin ${acct} UNLOCKED ${scope}/${key} immediately`);
    } else {
      const at = dtLocalToMs(req.body.release_at);
      const gate = req.body.gate ? 1 : 0;
      const noteLabel = String(req.body.note_label || '').trim() || null;
      const noteText = String(req.body.note_text || '').trim() || null;
      await pool.execute(
        `INSERT INTO epic_sprite_release_schedule (scope,item_key,release_at,gate,label,note_label,note_text,enabled)
         VALUES (?,?,?,?,?,?,?,1)
         ON DUPLICATE KEY UPDATE release_at=VALUES(release_at), gate=VALUES(gate),
           label=VALUES(label), note_label=VALUES(note_label), note_text=VALUES(note_text), enabled=1`,
        [scope, key, at, gate, String(req.body.label || '').trim() || null, noteLabel, noteText],
      );
      logger.warn(`[sprite-schedule] admin ${acct} SAVED ${scope}/${key} at=${at ? new Date(at).toISOString() : 'null'} gate=${gate}`);
    }
    await refreshAvailability();   // apply immediately rather than waiting 30s
  } catch (e) {
    logger.warn(`[sprites] schedule save failed: ${e.message}`);
  }
  res.redirect('/sprites/admin');
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
        ? `<a href="/sprites/u/${esc(r.share_id)}" target="_blank" rel="noopener">${esc(r.share_id)} ↗</a>`
        : '<span class="sub">—</span>';
      return `<tr>
        <td><b>${esc(r.display_name || '(unknown)')}</b><br><code class="sub">${esc(String(r.account_id).slice(0, 8))}…</code></td>
        <td>${slugLink}</td>
        <td>${authPill}</td>
        <td>${esc(passLevel)}</td>
        <td>${esc(accountLevel)}</td>
        <td>${esc(owned)}/${esc(obtainable)}</td>
        <td>${esc(familyCount)}</td>
        <td title="${esc(fmtTs(r.first_synced_at))}">${fmtTs(r.first_synced_at)}</td>
        <td title="${esc(fmtTs(r.synced_at))}">${fmtTs(r.synced_at)}</td>
        <td class="sub">${(r.state_size || 0).toLocaleString()} B</td>
      </tr>`;
    }).join('');
    const dead = rows.filter((r) => r.needs_relogin).length;
    const permanent = rows.filter((r) => r.has_device && !r.needs_relogin).length;
    const ephemeral = rows.filter((r) => !r.has_device && !r.needs_relogin).length;
    const summary = `${rows.length} accounts · 🔒 ${permanent} permanent (device_auth) · ↻ ${ephemeral} refresh-only · ✗ ${dead} need re-login`;
    res.send(shell('Admin — CertiFried Sprite Tracker', chrome() + `<main>
      <section class="hero" style="display:block">
        <div class="who" style="margin-bottom:6px">Tracker Admin<b>All connected accounts</b><span class="since">${summary}</span></div>
      </section>
      <div class="table-scroll"><table class="admin-table">
        <thead><tr>
          <th>User</th><th>Slug</th><th>Auth</th><th>BP&nbsp;Lvl</th><th>Account&nbsp;Lvl</th>
          <th>Sprites</th><th>Families</th><th>First sync</th><th>Last sync</th><th>State&nbsp;size</th>
        </tr></thead>
        <tbody>${tableRows || '<tr><td colspan="10" class="sub" style="text-align:center;padding:24px">No accounts yet.</td></tr>'}</tbody>
      </table></div>
      <p class="sub" style="margin-top:14px">🔒 <b>Forever</b> = device_auth on file, permanent until user revokes from Epic account settings. ↻ <b>Refresh</b> = refresh_token only (48h rotating); back-fills to device_auth on next sync. ✗ <b>DEAD</b> = needs a manual re-paste to recover.</p>
      ${renderHealthAudit(await runSpriteHealthAudit().catch((e) => {
    logger.warn(`[sprites] health audit failed: ${e.message}`);
    return { ok: false, problems: [`audit crashed: ${e.message}`], warnings: [], stats: { families: 0, variants: 0, imageFiles: 0, refSyncedAt: null }, pipeline: { accounts: 0, withState: 0, dead: 0, stale: 0, newestAgeMin: null } };
  }))}
      ${await renderScheduleAdmin(req)}
      <div id="announced"></div>
      ${req.query.ann ? `<div class="card" style="margin-top:30px" role="status"><p class="sub">${esc(String(req.query.ann).slice(0, 200))}</p></div>` : ''}
      ${await renderAnnouncedAdmin()}
    </main>`));
  } catch (e) {
    logger.warn(`[sprites] admin view failed: ${e.message}`);
    res.status(500).send(shell('Error', chrome() + '<main><div class="card"><h2>Something went wrong</h2></div></main>'));
  }
});

export default router;
