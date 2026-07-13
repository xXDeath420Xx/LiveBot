// Epic Games sprite-collection data layer for the dashboard /sprites tracker.
//
// Sprites are the internal "ExtractableRelic" system — NOT in MCP profiles or the
// locker. They live in two services, each needing a different token:
//   catalog   (all variants)        -> MCP host,   EG1  `bearer` token
//   inventory (owned + XP/mastery)  -> magpie svc,  EOS  `Bearer` token (deployment-scoped)
//
// We never persist access tokens — only the user's refresh token, encrypted at rest
// (utils/encryption.js). See migration 136 / dashboard/routes/sprites.js.
import crypto from 'node:crypto';
import logger from '../utils/logger.js';

// fortniteAndroidGameClient — the only practical client for exchanging a Fortnite auth code.
const ANDROID = { id: '3f69e56c7649492c8cc29f1af08a8a12', secret: 'b51ee9cb12234f50a69efa67ef53812e' };
const ANDROID_BASIC = 'basic ' + Buffer.from(`${ANDROID.id}:${ANDROID.secret}`).toString('base64');
const OAUTH_TOKEN = 'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token';

// fortnitePCGameClient — the deployment-scoped client the magpie inventory service accepts.
const EOS_PC = { id: 'ec684b8c687f479fadea3cb2ad83f5c6', secret: 'e1f31c211f28413186262d37a13fc84d' };
const EOS_TOKEN = 'https://api.epicgames.dev/auth/v1/oauth/token';

const FN_DEPLOYMENT = '62a9473a2dca46b29ccf17577fcf42d7';
const SPRITE_MODULE = '70329e8f-f377-4a73-90cf-76b7ace87a07';

// URL the user opens to obtain an authorization code (Epic returns a small JSON blob).
export const LOGIN_URL = `https://www.epicgames.com/id/api/redirect?clientId=${ANDROID.id}&responseType=code`;

// ── OAuth ──────────────────────────────────────────────────────────────────
async function tokenRequest(body) {
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { Authorization: ANDROID_BASIC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Epic token request failed (${res.status}): ${data.errorMessage || data.errorCode || res.statusText}`);
    err.epicCode = data.errorCode; err.status = res.status;
    throw err;
  }
  return data; // { access_token, refresh_token, account_id, displayName, refresh_expires_at, ... }
}

export const exchangeAuthCode = (code) => tokenRequest({ grant_type: 'authorization_code', code, token_type: 'eg1' });
export const refreshToken = (refresh_token) => tokenRequest({ grant_type: 'refresh_token', refresh_token, token_type: 'eg1' });

// ── Device Auth (long-lived credentials) ───────────────────────────────────
// Epic's refresh tokens expire after 48h. Device auth is the long-lived
// alternative: create one (deviceId, secret) pair per user, store it forever,
// and exchange it for fresh access tokens whenever we need to sync. Only ever
// invalidated if the user revokes it from their Epic account settings page.
const DEVICE_AUTH_URL = (accountId) =>
  `https://account-public-service-prod.ol.epicgames.com/account/api/public/account/${accountId}/deviceAuth`;

export async function createDeviceAuth(accountId, eg1) {
  const res = await fetch(DEVICE_AUTH_URL(accountId), {
    method: 'POST',
    headers: {
      Authorization: `bearer ${eg1}`,
      'Content-Type': 'application/json',
      // Custom UA so the device shows up identifiably in the user's Epic
      // account settings device-list view (account.epicgames.com).
      'User-Agent': 'CertiFried-Sprite-Tracker/1.0',
    },
    body: '{}',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.deviceId || !data.secret) {
    throw new Error(`device auth creation failed (${res.status}): ${data.errorMessage || data.errorCode || res.statusText}`);
  }
  return { deviceId: data.deviceId, accountId: data.accountId || accountId, secret: data.secret };
}

// Exchange (deviceId, secret) for a fresh EG1 access token. The Android client
// (whose secret we already use elsewhere) is the auth carrier here too.
export const deviceAuthLogin = ({ accountId, deviceId, secret }) =>
  tokenRequest({ grant_type: 'device_auth', account_id: accountId, device_id: deviceId, secret, token_type: 'eg1' });

// ── Seamless "Login with Epic" redirect flow ─────────────────────────────────
// Requires our OWN registered Epic Account Services client (env: EPIC_OAUTH_CLIENT_ID/SECRET).
// Epic redirects back with a code; we exchange it for an account token, then bridge that to a
// first-party Fortnite token (via an exchange code) which can read sprites. Bridge proven 2026-06-26.
export const EAS_CONFIGURED = !!(process.env.EPIC_OAUTH_CLIENT_ID && process.env.EPIC_OAUTH_CLIENT_SECRET);
const EXCHANGE_URL = 'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/exchange';

// The page the "Login with Epic" button sends the user to (Epic shows its own login first if needed).
export function authorizeUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: process.env.EPIC_OAUTH_CLIENT_ID || '',
    response_type: 'code', scope: 'basic_profile',
    redirect_uri: redirectUri, state,
  });
  return `https://www.epicgames.com/id/authorize?${p.toString()}`;
}

// Identity-only sign-in: exchange the OAuth code for an EAS account session and
// return just the user's account_id + displayName. This is the SAME first step
// that connectViaOAuth does, minus the bridge-to-Fortnite-token (steps 2+3 of
// connectViaOAuth, which Epic refuses for our custom EAS client — see the 403
// 'account:oauth:exchangeTokenCode CREATE' incident on 2026-06-26).
//
// Used for "Sign in with Epic" returning-user logins where we already have the
// user's row in epic_sprite_accounts (with device_auth or refresh_token) — we
// only need to prove which account_id is in front of us, then session cookies +
// background sync do the rest. NOT usable for first-time connects (those still
// need the paste-an-Epic-code flow to obtain a Fortnite token for sprite data).
export async function signInViaEpic(code, redirectUri) {
  if (!EAS_CONFIGURED) throw new Error('Epic OAuth client not configured');
  const OUR_BASIC = 'basic ' + Buffer.from(`${process.env.EPIC_OAUTH_CLIENT_ID}:${process.env.EPIC_OAUTH_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { Authorization: OUR_BASIC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, token_type: 'eg1' }).toString(),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.account_id) {
    const e = new Error(`Epic sign-in failed (${res.status}): ${tok.errorMessage || tok.errorCode || res.statusText}`);
    e.epicCode = tok.errorCode; throw e;
  }
  return { accountId: tok.account_id, displayName: tok.displayName };
}

// Callback handler core: redirect `code` -> account token -> exchange code -> Fortnite game token.
// Returns the same shape as exchangeAuthCode (account_id, displayName, access_token, refresh_token…).
export async function connectViaOAuth(code, redirectUri) {
  if (!EAS_CONFIGURED) throw new Error('Epic OAuth client not configured');
  const OUR_BASIC = 'basic ' + Buffer.from(`${process.env.EPIC_OAUTH_CLIENT_ID}:${process.env.EPIC_OAUTH_CLIENT_SECRET}`).toString('base64');
  // 1) our-client authorization_code -> account session token
  const acctRes = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { Authorization: OUR_BASIC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, token_type: 'eg1' }).toString(),
  });
  const acctTok = await acctRes.json().catch(() => ({}));
  if (!acctRes.ok || !acctTok.access_token) {
    const e = new Error(`OAuth code exchange failed (${acctRes.status}): ${acctTok.errorMessage || acctTok.errorCode || acctRes.statusText}`);
    e.epicCode = acctTok.errorCode; throw e;
  }
  // 2) mint an exchange code from that account session
  const exRes = await fetch(EXCHANGE_URL, { headers: { Authorization: `bearer ${acctTok.access_token}` } });
  const ex = await exRes.json().catch(() => ({}));
  if (!exRes.ok || !ex.code) throw new Error(`exchange-code mint failed (${exRes.status}): ${ex.errorMessage || ex.errorCode || exRes.statusText}`);
  // 3) redeem it as the first-party Fortnite client -> game token (+ refresh) that can read sprites
  return tokenRequest({ grant_type: 'exchange_code', exchange_code: ex.code, token_type: 'eg1' });
}

// Accepts a raw 32-hex code, a pasted ?code=… URL, or Epic's JSON blob; returns the code.
export function parseAuthCode(input) {
  if (!input) return null;
  const s = String(input).trim();
  return (s.match(/^[a-f0-9]{32}$/i)?.[0]
    || s.match(/[?&]code=([a-f0-9]{32})/i)?.[1]
    || s.match(/"authorizationCode"\s*:\s*"([a-f0-9]{32})"/i)?.[1]
    || s.match(/[a-f0-9]{32}/i)?.[0] || null)?.toLowerCase() || null;
}

// ── Sprite endpoints ─────────────────────────────────────────────────────────
async function eosConnectToken(eg1) {
  const res = await fetch(EOS_TOKEN, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${EOS_PC.id}:${EOS_PC.secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'external_auth', external_auth_type: 'epicgames_access_token',
      external_auth_token: eg1, deployment_id: FN_DEPLOYMENT, nonce: crypto.randomBytes(16).toString('hex'),
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`EOS connect failed (${res.status}): ${data.errorMessage || data.error || res.statusText}`);
  return data.access_token;
}

// Athena profile = Battle Royale account state, including the in-lobby
// account level + XP. Same MCP host the catalog uses, different profileId.
async function fetchAthenaProfile(accountId, eg1) {
  const url = `https://fngw-mcp-gc-livefn.ol.epicgames.com/fortnite/api/game/v2/profile/${accountId}/client/QueryProfile?profileId=athena&rvn=-1`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `bearer ${eg1}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    logger.warn(`[sprites] athena profile fetch failed (${res.status})`);
    return null;
  }
  const data = await res.json().catch(() => null);
  // The interesting stuff is one change deep — extract it for the caller.
  const change = data?.profileChanges?.find?.((c) => c?.profile?.stats?.attributes)?.profile;
  return change || null;
}

// Catalog cache: the extractablerelics catalog changes maybe once a week (when
// Epic ships a new sprite). Re-fetching it on every user sync wastes Epic's
// bandwidth and slows our sync round-trip. Cache for 1 hour — long enough to
// dramatically cut API load, short enough to pick up new sprites within an hour
// of Epic shipping them.
const CATALOG_TTL_MS = 60 * 60 * 1000;
let cachedCatalog = null;
let cachedCatalogAt = 0;
async function fetchCatalog(eg1) {
  const now = Date.now();
  if (cachedCatalog && (now - cachedCatalogAt) < CATALOG_TTL_MS) return cachedCatalog;
  const catUrl = `https://mcp-gc.live.fngw.ol.epicgames.com/fortnite/api/game/v2/extractablerelics/${SPRITE_MODULE}/13/getBackendCatalog/`;
  const res = await fetch(catUrl, { headers: { Authorization: `bearer ${eg1}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`sprite catalog failed (${res.status})`);
  cachedCatalog = await res.json();
  cachedCatalogAt = now;
  return cachedCatalog;
}
// Returns { catalog, inventory, athena } raw JSON for buildModel().
export async function fetchSpriteData(accountId, eg1) {
  const eos = await eosConnectToken(eg1);
  const invUrl = `https://gc.svc.live.fngw.ol.epicgames.com/api/magpie/v2/deployment/${FN_DEPLOYMENT}/domain/FN1/account/${accountId}/workspace/default/linkMode/live/inventory?moduleFilters=${encodeURIComponent(SPRITE_MODULE + ':*')}&includeMetadata=true`;
  const [catalog, invRes, athena] = await Promise.all([
    fetchCatalog(eg1),
    fetch(invUrl, { headers: { Authorization: `Bearer ${eos}`, Accept: 'application/json' } }),
    fetchAthenaProfile(accountId, eg1),
  ]);
  if (!invRes.ok) throw new Error(`sprite inventory failed (${invRes.status})`);
  return { catalog, inventory: await invRes.json(), athena };
}

// Families whose variants are currently **vaulted** in Battle Royale — present
// in Epic's catalog (so the tracker still surfaces them), but NOT appearing in
// active BR matches for players to find and extract. Owned counts from prior
// availability windows still display normally; unowned vaulted variants get
// marked `vaulted: true` and are excluded from the "obtainable" denominator so
// progress isn't misleadingly low. (Reminder: sprites are FOUND in BR matches
// and extracted post-game — they're not bought/summoned from a shop. The
// `summonCost` field in the catalog is Epic's name for the extraction-dust
// value, not a purchase price.) Family tokens are the lowercase pre-tier
// prefix as seen on a variant name, e.g. AirSprite_Variant_A → 'airsprite'.
//
// Verified entries (with the source for each, so future-you can re-check):
//   airsprite   — v41.10 patch notes: "Air and Water Sprites were vaulted at
//                 some point during the season"; absent from in-game UI
//   sevensprite — zero mentions in any Season 41 sprite guide; confirmed
//                 absent from the in-game Sprite Mastery Pod (crawf, 2026-06-27)
//
// TODO(crawf): consider 'water' as well — patch-notes phrasing implies it was
// vault-rotated at some point, but you own 4/6 Water already from prior
// availability so adding it would only affect the "obtainable" math, not your
// owned counts. Check in-game; add if Water sprites are not currently appearing
// in BR matches for extraction.
// Last verified: 2026-06-27 against Fortnite v41.10 patch notes + in-game UI.
export const VAULTED_FAMILIES = new Set(['airsprite', 'sevensprite']);
export const VAULTED_SOURCE = 'Vaulted in Battle Royale per Fortnite v41.10 patch notes + in-game absence';

// Holofoil variants ship Thursday 2026-07-09 at 9 AM ET (6 AM PT). Until
// that instant, buildModel flags them `future: true` (jail bars, hidden from
// Need filter, excluded from obtainable count). At that instant onward, they
// become normal locked-but-obtainable variants — same as any unowned Gold or
// Gummy. Gem variants remain `future` since Epic hasn't announced a date.
//   9 AM EDT = 13:00 UTC on the release day.
// Source: communities.epicgames.com/thread/…/kqQk
export const HOLOFOIL_RELEASE_MS = Date.UTC(2026, 6, 9, 13, 0, 0);

// ── Model (catalog × inventory → families × tiers) ───────────────────────────
// Epic family token -> fnsprites image prefix (= our /sprites/img/<prefix>_<tier>.png).
export const FAMILY_TO_IMG = {
  spitfire: 'fire', water: 'water', earthsprite: 'earth', airsprite: 'air',
  sleepysprite: 'dream', punksprite: 'punk', bosssprite: 'boss', demonsprite: 'demon',
  fishysprite: 'fishy', sevensprite: 'seven', soccersprite: 'striker',
  zeropointsprite: 'zeropoint', driftersprite: 'aura', ghostsprite: 'ghost',
  ducksprite: 'duck', grimsprite: 'grim', kingsprite: 'king', burntpeanut: 'theburntpeanut',
};
export const FAMILY_LABEL = {
  spitfire: 'Fire', water: 'Water', earthsprite: 'Earth', airsprite: 'Air',
  sleepysprite: 'Dream', punksprite: 'Punk', bosssprite: 'Boss', demonsprite: 'Demon',
  fishysprite: 'Fishy', sevensprite: 'Seven', soccersprite: 'Striker',
  zeropointsprite: 'Zero Point', driftersprite: 'Aura', ghostsprite: 'Ghost',
  ducksprite: 'Duck', grimsprite: 'Grim', kingsprite: 'King', burntpeanut: 'Burnt Peanut',
};
// Tier order matters: it drives the column order in the sprite grid.
// Basic/Gold/Candy/Galaxy are the four the game has actually shipped so far.
// Holofoil + Gem are pak-baked and being drip-released.
// Cube + Quack are also pak-baked per the datamine (see
// [[reference_fortnite_sprite_pak_datamine]]) but Epic hasn't enabled the
// catalog entries yet — added preemptively so if/when they ship, our tracker
// picks them up automatically instead of silently dropping the variants.
// If tier tokens appear that aren't matched here, buildModel logs a warning
// with the unknown token so we can add it quickly.
export const TIERS = [
  { key: 'basic', label: 'Basic', match: ['a', 'base'], color: '#9aa6b2' },
  { key: 'gold', label: 'Gold', match: ['gold'], color: '#ffcf3a' },
  { key: 'candy', label: 'Gummy', match: ['candy'], color: '#ff6cc4' },
  { key: 'galaxy', label: 'Galaxy', match: ['galaxy', 'galactic'], color: '#7b5cff' },
  { key: 'gem', label: 'Gem', match: ['gem'], color: '#3ad0c4' },
  { key: 'holofoil', label: 'Holofoil', match: ['holofoil'], color: '#5bf0ff' },
  { key: 'cube', label: 'Cube', match: ['cube'], color: '#c084fc' },
  { key: 'quack', label: 'Quack', match: ['quack'], color: '#facc15' },
];
const TIER_BY_TOKEN = Object.fromEntries(TIERS.flatMap((t) => t.match.map((m) => [m, t])));
export const MASTERY_XP = 4000;

// Variants that exist in the CH7S3 pak as ESD_*_Variant_*.uasset definitions
// but aren't in Epic's live catalog yet — the "datamined but server-gated"
// bucket. Sourced from a retoc pak scan (2026-07-10) against build
// 41.10-CL-55227503; see [[reference_fortnite_sprite_pak_datamine]] +
// scratchpad/pak-extract/out/pak-audit-summary.json.
//
// buildModel merges these into their family's variant map ONLY if the tier
// isn't already present from the live catalog. So the moment Epic ships the
// catalog entry, the live version takes over (with real owned/xp/mastery data)
// and this entry becomes a no-op. Until then, they render as `future: true`
// jail-barred cells with icon PNGs extracted from the pak (see
// public/sprites/img/punk_cube.png / dream_cube.png / zeropoint_quack.png).
// hasIcon:false variants render with a tier-colored placeholder thumb.
// name = the exact Epic asset name (matches ESD_*_Variant_*.uasset pattern in
// the pak). Used for display + as the state.groups[].variants[].name field.
export const PAK_DATAMINED_VARIANTS = [
  { name: 'PunkSprite_Variant_Cube',       familyToken: 'punksprite',      tierToken: 'cube',  hasIcon: true },
  { name: 'SleepySprite_Variant_Cube',     familyToken: 'sleepysprite',    tierToken: 'cube',  hasIcon: true },
  { name: 'ZeroPointSprite_Variant_Cube',  familyToken: 'zeropointsprite', tierToken: 'cube',  hasIcon: false },
  { name: 'ZeroPointSprite_Variant_Quack', familyToken: 'zeropointsprite', tierToken: 'quack', hasIcon: true },
];

export function parseVariant(name) {
  const m = name.match(/^(.+?)_(?:Variant|Variation)_(.+)$/);
  if (!m) return { familyToken: name.toLowerCase(), tierToken: 'a' };
  return { familyToken: m[1].toLowerCase(), tierToken: m[2].toLowerCase() };
}
export function imgIdFor(name) {
  const { familyToken, tierToken } = parseVariant(name);
  const fam = FAMILY_TO_IMG[familyToken], tier = TIER_BY_TOKEN[tierToken];
  return (fam && tier) ? `${fam}_${tier.key}` : null;
}

// Public Fortnite "Chapter X · Season Y" labels for Epic's internal global
// season_num counter. Epic returns a monotonically-increasing season_num (e.g.
// 41 = the 41st season since Chapter 1 launched), but public-facing Fortnite
// renumbers seasons per chapter — so season_num 41 is "Chapter 7 · Season 3".
// This map is brittle (needs an entry added each new season) and intentionally
// hand-maintained rather than computed, because chapter boundaries have
// drifted historically (OG events, sub-seasons, etc.) and a formula would be
// fragile. Falls back to "Season N" when the map doesn't know an entry.
// Last updated: 2026-06-27 (Chapter 7 · Season 3 is current).
// Fortnite renumbers seasons per CHAPTER; Epic's internal `season_num` field
// is a global monotonically-increasing counter from launch (Oct 2017). This
// map converts the global counter to the public "Chapter X · Season Y" label
// players actually use. Boundaries are best-effort: chapter lengths vary,
// OG events confuse the counting, but for player-facing display "close enough"
// beats raw "S38" by miles.
//
// TODO(crawf): re-verify if Fortnite Wiki updates contradict any of these
// boundaries. Add 42+ when next season launches.
const CHAPTER_SEASON_LABELS = {
  // Chapter 1 (Oct 2017 – Oct 2019, 10 seasons; "Season X" is the popular name for S10)
  1: 'Chapter 1 · Season 1', 2: 'Chapter 1 · Season 2',
  3: 'Chapter 1 · Season 3', 4: 'Chapter 1 · Season 4',
  5: 'Chapter 1 · Season 5', 6: 'Chapter 1 · Season 6',
  7: 'Chapter 1 · Season 7', 8: 'Chapter 1 · Season 8',
  9: 'Chapter 1 · Season 9', 10: 'Chapter 1 · Season X',
  // Chapter 2 (Oct 2019 – Dec 2021, 8 seasons)
  11: 'Chapter 2 · Season 1', 12: 'Chapter 2 · Season 2',
  13: 'Chapter 2 · Season 3', 14: 'Chapter 2 · Season 4',
  15: 'Chapter 2 · Season 5', 16: 'Chapter 2 · Season 6',
  17: 'Chapter 2 · Season 7', 18: 'Chapter 2 · Season 8',
  // Chapter 3 (Dec 2021 – Dec 2022, 4 seasons)
  19: 'Chapter 3 · Season 1', 20: 'Chapter 3 · Season 2',
  21: 'Chapter 3 · Season 3', 22: 'Chapter 3 · Season 4',
  // Chapter 4 (Dec 2022 – Dec 2023, 5 seasons + OG)
  23: 'Chapter 4 · Season 1', 24: 'Chapter 4 · Season 2',
  25: 'Chapter 4 · Season 3', 26: 'Chapter 4 · Season 4',
  27: 'Chapter 4 · Season 5', 28: 'Chapter 4 · OG',
  // Chapter 5 (Dec 2023 – Nov 2024, 4 seasons)
  29: 'Chapter 5 · Season 1', 30: 'Chapter 5 · Season 2',
  31: 'Chapter 5 · Season 3', 32: 'Chapter 5 · Season 4',
  // Chapter 6 (Nov 2024 – Jun 2026, 6 seasons)
  33: 'Chapter 6 · Season 1', 34: 'Chapter 6 · Season 2',
  35: 'Chapter 6 · Season 3', 36: 'Chapter 6 · Season 4',
  37: 'Chapter 6 · Season 5', 38: 'Chapter 6 · Season 6',
  // Chapter 7 (current, Jun 2026 –)
  39: 'Chapter 7 · Season 1', 40: 'Chapter 7 · Season 2',
  41: 'Chapter 7 · Season 3',
};
export function labelForSeasonNum(n) {
  if (n == null) return null;
  return CHAPTER_SEASON_LABELS[n] || `Season ${n}`;
}
// Compact form for the career-timeline chart where space is tight.
// "Chapter 1 · Season 3" → "C1S3"; "Chapter 4 · OG" → "C4 OG"; unknown → "?"
export function shortLabelForSeasonNum(n) {
  if (n == null) return '?';
  const full = CHAPTER_SEASON_LABELS[n];
  if (!full) return `?${n}`;  // visible hint that we lack a clean label for this global number
  const m = full.match(/^Chapter (\d+) · (?:Season (\w+)|(.+))$/);
  if (!m) return full;
  const ch = m[1];
  const sn = m[2];   // numeric season "3" or "X"
  const ev = m[3];   // event name like "OG"
  return ev ? `C${ch} ${ev}` : `C${ch}S${sn}`;
}

// Pull just the player-stat fields we care about from the athena profile. Epic
// stuffs everything into `stats.attributes`; we surface the in-lobby pass tier,
// lifetime account level, current season number, and total wins.
function extractAthenaStats(athena) {
  const a = athena?.stats?.attributes;
  if (!a) return null;
  const past = Array.isArray(a.past_seasons) ? a.past_seasons : [];
  const currentWins = a?.season?.numWins || 0;
  const careerWins = past.reduce((sum, s) => sum + (s.numWins || 0), 0) + currentWins;
  const bestPastPassLevel = past.reduce((m, s) => Math.max(m, s.bookLevel || 0), 0);
  const seasonNum = a.season_num ?? null;

  // Vintage = first season this account appeared in (the earliest seasonNumber
  // in the past_seasons array). Anchors "Collecting since Season X" to real data.
  const firstSeasonNumber = past.length
    ? past.reduce((m, s) => Math.min(m, s.seasonNumber ?? Infinity), Infinity)
    : seasonNum;
  // Hall of Fame: peak season by bookLevel (with numWins as tiebreaker so
  // a 100-tier season with 50 wins beats a 100-tier season with 5).
  let hallOfFame = null;
  for (const s of past) {
    if (!s || s.bookLevel == null) continue;
    if (!hallOfFame
        || s.bookLevel > hallOfFame.bookLevel
        || (s.bookLevel === hallOfFame.bookLevel && (s.numWins || 0) > (hallOfFame.numWins || 0))) {
      hallOfFame = { seasonNumber: s.seasonNumber, bookLevel: s.bookLevel, numWins: s.numWins || 0 };
    }
  }
  if (hallOfFame) hallOfFame.seasonLabel = labelForSeasonNum(hallOfFame.seasonNumber);
  // Completed Battle Passes = past seasons where the player hit Level 100.
  const completedPasses = past.filter((s) => (s.bookLevel || 0) >= 100).length;
  // Timeline: sorted [{ seasonNumber, bookLevel, numWins, completed }] for the
  // career-bar chart render. Includes current season as the last bar.
  const timeline = past
    .filter((s) => s && s.seasonNumber != null && s.bookLevel != null)
    .map((s) => ({
      seasonNumber: s.seasonNumber,
      seasonLabel: labelForSeasonNum(s.seasonNumber),
      bookLevel: s.bookLevel,
      numWins: s.numWins || 0,
      completed: (s.bookLevel || 0) >= 100,
    }))
    .sort((x, y) => x.seasonNumber - y.seasonNumber);
  if (seasonNum != null && (a.book_level != null || a.level != null)) {
    const curLvl = a.book_level ?? a.level;
    timeline.push({
      seasonNumber: seasonNum,
      seasonLabel: labelForSeasonNum(seasonNum),
      bookLevel: curLvl,
      numWins: currentWins,
      completed: curLvl >= 100,
      isCurrent: true,
    });
  }

  return {
    passLevel: a.book_level ?? a.level ?? null,
    passXp: a.book_xp ?? a.xp ?? null,
    accountLevel: a.accountLevel ?? null,
    seasonNum,
    seasonLabel: labelForSeasonNum(seasonNum),
    currentSeasonWins: currentWins,
    careerWins,
    bestPastPassLevel,
    seasonsPlayed: past.length + (seasonNum ? 1 : 0),
    firstSeasonNumber,
    firstSeasonLabel: labelForSeasonNum(firstSeasonNumber),
    hallOfFame,
    completedPasses,
    timeline,
  };
}

export function buildModel(catalog, invJson, athena) {
  const block = Array.isArray(invJson?.inventory)
    ? (invJson.inventory.find((b) => b.counts || b.entitlementMetadata) || invJson.inventory[0] || {})
    : (invJson || {});
  const counts = block.counts || {};
  const ent = block.entitlementMetadata || {};
  let meta = {};
  try { meta = typeof block.metadata === 'string' ? JSON.parse(block.metadata) : (block.metadata || {}); } catch { /* ignore */ }
  const dust = counts.Currency_ExtractionPoints ?? null;
  const epicStats = extractAthenaStats(athena);

  // Discovery hooks — log anything in the raw magpie response we don't
  // currently consume. Catches new currency types + metadata keys the moment
  // Epic ships them, so we can extend the model instead of silently dropping
  // data. Only reports keys, never values (values may contain PII).
  const KNOWN_META_KEYS = new Set(['StarterRelic', 'EquippedVariant']);
  const unknownCurrencyKeys = Object.keys(counts).filter(
    (k) => k.startsWith('Currency_') && k !== 'Currency_ExtractionPoints',
  );
  const unknownMetaKeys = Object.keys(meta).filter((k) => !KNOWN_META_KEYS.has(k));

  const families = new Map();
  const unknownTierTokens = new Set();
  for (const [name, c] of Object.entries(catalog || {})) {
    const { familyToken, tierToken } = parseVariant(name);
    const tier = TIER_BY_TOKEN[tierToken];
    if (!tier) {
      // Track any unrecognized tier tokens so buildModel's caller can log a
      // single "unknown tier detected" warning per sync instead of dropping
      // variants silently. Common cause: Epic shipping a pak-baked tier we
      // haven't added to TIERS yet (e.g. Quack/Cube back-in-2026 timeframe).
      unknownTierTokens.add(tierToken);
      continue;
    }
    let xp = null, ml = false, owned = false;
    if (name in counts) {
      owned = true;
      try { const e = JSON.parse(ent[name] ?? '{}'); xp = e.xp ?? 0; ml = !!e.ml; } catch { xp = 0; }
    }
    const familyVaulted = VAULTED_FAMILIES.has(familyToken);
    const variant = {
      name, familyToken, tierKey: tier.key, tierLabel: tier.label, tierColor: tier.color,
      // `vaulted` = currently unobtainable in-game even though Epic still ships
      // the catalog entry. Only flag unowned variants — anything you already
      // own from a prior availability window stays a normal "Collected" cell.
      owned, vaulted: !owned && familyVaulted,
      xp, mastered: ml, dupes: counts[name] ?? 0,
      summonCost: c.attributes?.summonCost ?? null, starter: !!c.attributes?.bIsStarter,
      // Holofoil future-flag drops the moment Epic ships them (2026-07-09).
      // Gem stays future indefinitely — no announced release yet.
      imgId: imgIdFor(name), future: !owned && (tier.key === 'gem' || (tier.key === 'holofoil' && Date.now() < HOLOFOIL_RELEASE_MS)),
    };
    if (!families.has(familyToken)) {
      families.set(familyToken, { familyToken, label: FAMILY_LABEL[familyToken] || familyToken, variants: {} });
    }
    families.get(familyToken).variants[tier.key] = variant;
  }

  // Inject pak-datamined variants that aren't in the live catalog yet. Skipped
  // if the family already has that tier from the catalog (Epic shipped it in
  // between pak extraction and this sync — the live entry wins with real
  // owned/xp state). Same-shape entries as the catalog-derived variants so the
  // grid renderer treats them identically; `future: true` triggers the jail-
  // bar overlay + "unreleased" pool inclusion.
  for (const p of PAK_DATAMINED_VARIANTS) {
    const tier = TIER_BY_TOKEN[p.tierToken];
    if (!tier) continue;
    const family = families.get(p.familyToken);
    if (!family) continue;                    // family isn't in current catalog (e.g. fully vaulted)
    if (family.variants[tier.key]) continue;  // live catalog already has this tier — respect it
    family.variants[tier.key] = {
      name: p.name,
      familyToken: p.familyToken,
      tierKey: tier.key,
      tierLabel: tier.label,
      tierColor: tier.color,
      owned: false,
      vaulted: false,
      xp: null,
      mastered: false,
      dupes: 0,
      summonCost: null,
      starter: false,
      // Icon PNGs live at /sprites/img/{prefix}_{tier}.png — we deploy the ones
      // we successfully extracted from the pak. hasIcon=false skips the imgId
      // so the grid falls back to the tier-colored placeholder.
      imgId: p.hasIcon ? imgIdFor(p.name) : null,
      future: true,
      pakDatamined: true,   // grid can use this to flag "from pak, not from live catalog"
    };
  }

  const groups = [...families.values()].map((g) => {
    const vs = Object.values(g.variants);
    g.ownedCount = vs.filter((v) => v.owned).length;
    g.totalCount = vs.length;
    // obtainableCount = variants that are NOT future-tier (Gem/Holofoil) AND NOT
    // in a vaulted family. For most families this is 4 (Basic/Candy/Galaxy/Gold,
    // with Gem/Holofoil future-flagged) or 1 (Burnt Peanut, sole variant), and
    // the family-row count should be owned/obtainable rather than owned/total
    // so a player at the practical cap reads "4/4" instead of a misleading "4/6".
    g.obtainableCount = vs.filter((v) => !v.future && !v.vaulted).length;
    g.masteredCount = vs.filter((v) => v.mastered).length;
    return g;
  });
  const ELEMENTAL = ['water', 'earthsprite', 'spitfire', 'airsprite'];
  groups.sort((a, b) => {
    const ea = ELEMENTAL.indexOf(a.familyToken), eb = ELEMENTAL.indexOf(b.familyToken);
    if (ea !== -1 || eb !== -1) return (ea === -1 ? 99 : ea) - (eb === -1 ? 99 : eb);
    return b.ownedCount - a.ownedCount || a.label.localeCompare(b.label);
  });

  const all = groups.flatMap((g) => Object.values(g.variants));
  const futureCount = all.filter((v) => v.future).length;
  const vaultedCount = all.filter((v) => v.vaulted).length;
  // Distinct labels of vaulted families present in the catalog, in the order
  // they appear in `groups` so the rendered list is deterministic.
  const vaultedFamilyLabels = [];
  for (const g of groups) {
    if (VAULTED_FAMILIES.has(g.familyToken) && !vaultedFamilyLabels.includes(g.label)) {
      vaultedFamilyLabels.push(g.label);
    }
  }
  const summary = {
    owned: all.filter((v) => v.owned).length, total: all.length,
    released: all.length - futureCount,         // total - unreleased Holofoil/Gem
    // obtainable = neither future-tier nor vaulted-family. Filtering the union
    // directly (vs. total - future - vaulted) avoids double-counting variants
    // that are BOTH unreleased Holofoil AND in a vaulted family (e.g. Air's
    // Holofoil tier would otherwise be subtracted twice).
    obtainable: all.filter((v) => !v.future && !v.vaulted).length,
    future: futureCount, vaulted: vaultedCount,
    vaultedFamilies: vaultedFamilyLabels,
    mastered: all.filter((v) => v.mastered).length, families: groups.length, dust,
    starter: meta.StarterRelic ?? null,
    equipped: (meta.EquippedVariant && meta.EquippedVariant !== 'None') ? meta.EquippedVariant : null,
    epic: epicStats,                              // null if no athena data this sync
  };
  return {
    groups,
    summary,
    unknownTiers: unknownTierTokens.size ? [...unknownTierTokens] : undefined,
    unknownCurrencyKeys: unknownCurrencyKeys.length ? unknownCurrencyKeys : undefined,
    unknownMetaKeys: unknownMetaKeys.length ? unknownMetaKeys : undefined,
  };
}

// Convenience: refresh -> fetch -> model, returning everything the route needs.
export async function syncFromRefreshToken(refresh_token, prevDisplayName) {
  const tok = await refreshToken(refresh_token);
  const { catalog, inventory, athena } = await fetchSpriteData(tok.account_id, tok.access_token);
  const model = buildModel(catalog, inventory, athena);
  return {
    accountId: tok.account_id,
    displayName: tok.displayName || prevDisplayName || tok.account_id,
    refreshToken: tok.refresh_token,
    refreshExpiresAt: tok.refresh_expires_at,
    model,
  };
}

export function logSyncError(where, e) {
  logger.warn(`[epic-sprites] ${where}: ${e.message}`);
}
