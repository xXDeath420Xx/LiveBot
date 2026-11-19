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
// Chapter 7 Season 4 "Override" is a NEW sprite system on a NEW backend module,
// discovered via a live mitmproxy boot capture 2026-08-20 (12 families ×
// A/Gold/CheatMaster = 36 variants). The OLD module below is now the "Sprite
// Garden" — your preserved CH7S3 collection — still live in parallel. The
// tracker's active module is Override; the Garden snapshot is served from
// garden_json. Same host/path/shape, so buildModel parses it unchanged — only
// the GUID + starting catalog version differ (Override starts at v9, not v17).
// 2026-11-01 cutover: the CH7 "Treasure Hunters" mini-season started a NEW
// sprite collection on its OWN backend module (05b7e211, found via mitmproxy
// boot capture — the game cut the active rotation over to it, locking Override
// like Override locked the Garden). Override (828c9446) is now legacy, its last
// state snapshotted per-account into override_json. Three parallel modules now:
// Treasure Hunters (active) / Override (legacy) / Garden (legacy).
const SPRITE_MODULE = '05b7e211-c684-4622-a9e2-10e6ede94d60';   // CH7 Treasure Hunters mini-season (active)
export const OVERRIDE_MODULE = '828c9446-3eb8-497e-a282-d95b92243c14'; // CH7S4 Override (legacy, snapshotted to override_json)
export const GARDEN_MODULE = '70329e8f-f377-4a73-90cf-76b7ace87a07'; // CH7S3 (Sprite Garden, legacy)

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

// Terminate the Epic session for a minted access token. Every grant_type exchange
// (device_auth or refresh_token) opens a SESSION that lingers until it expires.
// Sync many accounts on a timer without killing sessions and they pile up until
// Epic flags "you're logged in in too many places" and forces a password reset.
// Killing the token right after we're done reading data keeps exactly ZERO
// standing sessions between syncs. Best-effort: a failed kill must never break a
// sync (worst case the session just expires on its own). Killing an access token
// does NOT touch the device-auth credential (deviceId/secret) — that's permanent.
const SESSIONS_KILL_URL = (accessToken) =>
  `https://account-public-service-prod.ol.epicgames.com/account/api/oauth/sessions/kill/${accessToken}`;
export async function killSession(accessToken) {
  if (!accessToken) return false;
  try {
    const res = await fetch(SESSIONS_KILL_URL(accessToken), {
      method: 'DELETE',
      headers: { Authorization: `bearer ${accessToken}` },
    });
    return res.ok || res.status === 204;
  } catch { return false; }
}

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

// Catalog cache: the extractablerelics catalog usually changes once per week
// (major patch) or during Sprite Day hotfixes. Cache for 10 minutes — long
// enough to dramatically cut API load across the ~60s per-account sync sweep,
// short enough that patch-day rollouts show up quickly. Any refetch that comes
// back with a different variant count auto-invalidates the cache too (so a
// mid-cache-window Epic flip is caught immediately on the first sync after).
const CATALOG_TTL_MS = 10 * 60 * 1000;
let cachedCatalog = null;
let cachedCatalogAt = 0;
let cachedCatalogVariantCount = 0;
// Version segment Epic bumps per major sprite patch (v13 = CH7S3 initial,
// v15 = v41.20 "Hot Bat Summer", v17 = v41.30 Act III). Cached across the
// process so we probe once per bump, not once per sync.
//
// ⚠ CRITICAL: Epic keeps OLD versions returning HTTP 200 with STALE data after
// a bump (v41.30: /15/ and /16/ still served 21 families while /17/ served 25).
// So a "probe only on 404" auto-detect never notices the bump — it happily
// serves the old catalog forever. We therefore probe FORWARD on success too,
// hourly, and adopt a higher version when it returns MORE variants.
// Override module's catalog version. Bumped 9→12 for the Sep-2026 patch (v9=36
// variants/12 families STALE; v12=61 variants/16 families incl LootHacker tier —
// the live one). This is a module-level `let` that RESETS on every restart, so a
// stale compile-time baseline silently serves the OLD catalog until the probe
// climbs (and I restart often). Persisted across restarts via setCatalogVersion()
// (sprites.js loads the last-known version from DB on boot, saves forward bumps).
// 2026-11-01: baseline reset to 10 for the Treasure Hunters module (05b7e211),
// which starts at v10 (live capture). The forward-only probe climbs from here;
// sprites.js persists the DB catalog_version — that row was reset 21→10 at the
// module cutover (a stale 21 would 404 the MS module forever, since the probe
// never walks backward).
let currentCatalogVersion = 10;
export function getCatalogVersion() { return currentCatalogVersion; }
export function setCatalogVersion(v) {
  // Only ever move FORWARD — never regress below what we've already discovered.
  const n = Number(v);
  if (Number.isInteger(n) && n > currentCatalogVersion) currentCatalogVersion = n;
}
let lastCatalogVersionProbe = 0;
async function tryCatalogVersion(v, eg1) {
  const catUrl = `https://mcp-gc.live.fngw.ol.epicgames.com/fortnite/api/game/v2/extractablerelics/${SPRITE_MODULE}/${v}/getBackendCatalog/`;
  const res = await fetch(catUrl, { headers: { Authorization: `bearer ${eg1}`, Accept: 'application/json' } });
  return res;
}
async function fetchCatalog(eg1) {
  const now = Date.now();
  if (cachedCatalog && (now - cachedCatalogAt) < CATALOG_TTL_MS) return cachedCatalog;
  let res = await tryCatalogVersion(currentCatalogVersion, eg1);
  // 404 path: current version is gone — probe forward for the first that exists.
  if (res.status === 404 && (now - lastCatalogVersionProbe) > 60 * 60 * 1000) {
    lastCatalogVersionProbe = now;
    logger.warn(`[sprite-catalog] v${currentCatalogVersion} returned 404 — probing newer versions`);
    for (let v = currentCatalogVersion + 1; v <= currentCatalogVersion + 5; v++) {
      const probeRes = await tryCatalogVersion(v, eg1);
      if (probeRes.ok) {
        logger.warn(`[sprite-catalog] VERSION BUMPED (404): v${currentCatalogVersion} → v${v}`);
        currentCatalogVersion = v;
        res = probeRes;
        break;
      }
    }
  }
  let fresh = res.ok ? await res.json() : null;
  // 200-but-stale path: hourly, check whether a higher version exists AND serves
  // MORE variants. If so, Epic bumped and left the old one alive — adopt the new
  // one. This is what a 404-only detector misses.
  if (fresh && (now - lastCatalogVersionProbe) > 60 * 60 * 1000) {
    lastCatalogVersionProbe = now;
    const currentCount = Object.keys(fresh).length;
    for (let v = currentCatalogVersion + 1; v <= currentCatalogVersion + 2; v++) {
      let probeRes;
      try { probeRes = await tryCatalogVersion(v, eg1); } catch { break; }
      if (!probeRes.ok) break;                    // v18=500 etc → no higher version
      const probeJson = await probeRes.json().catch(() => null);
      const probeCount = probeJson ? Object.keys(probeJson).length : 0;
      if (probeCount > currentCount) {
        logger.warn(`[sprite-catalog] FORWARD BUMP: v${currentCatalogVersion} (${currentCount}) → v${v} (${probeCount} variants)`);
        currentCatalogVersion = v;
        fresh = probeJson;
      } else break;                               // higher version not richer → stop
    }
  }
  if (!fresh) throw new Error(`sprite catalog failed (${res.status}) at v${currentCatalogVersion}`);
  // catalog is a plain-object map of `${Family}_Variant_${Tier}` → catalog entry.
  // Log the count every fetch (INFO level) + family-count on change so patch-day
  // rollouts are visible in server logs.
  const variantCount = Object.keys(fresh || {}).length;
  const familyCount = new Set(Object.keys(fresh || {}).map((n) => n.split(/_Variant_|_Variation_/)[0])).size;
  logger.info(`[sprite-catalog] fetched: ${variantCount} variants across ${familyCount} families`);
  if (cachedCatalogVariantCount && variantCount !== cachedCatalogVariantCount) {
    logger.warn(`[sprite-catalog] VARIANT COUNT CHANGED: ${cachedCatalogVariantCount} → ${variantCount}`);
  }
  // TEMP debug: dump catalog keys once so we can see what Epic is serving.
  try {
    const fs = await import('fs/promises');
    await fs.writeFile('/tmp/sprite-catalog-dump.json', JSON.stringify(fresh, null, 2));
    logger.info(`[sprite-catalog] dumped to /tmp/sprite-catalog-dump.json (${Object.keys(fresh).sort().join(',')})`);
  } catch (e) { /* best-effort */ }
  cachedCatalog = fresh;
  cachedCatalogAt = now;
  cachedCatalogVariantCount = variantCount;
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

// Families that are currently **vaulted** in Battle Royale. Populated
// exclusively by explicit user-observed evidence + patch-note callouts — we
// used to hardcode airsprite/sevensprite here based on the v41.10 patch, but
// the v41.20 "Hot Bat Summer" update unvaulted both, so the hardcoded override
// is now empty. If Epic vaults something in a future patch AND the catalog
// endpoint doesn't reflect it, add the family token back here with a source
// note.
//
// Reminder: sprites are FOUND in BR matches and extracted post-game — they're
// not bought/summoned from a shop. The `summonCost` catalog field is Epic's
// name for the extraction-dust re-summon value, not a purchase price.
// Family tokens are the lowercase pre-tier prefix as seen on a variant name,
// e.g. AirSprite_Variant_A → 'airsprite'.
export const VAULTED_FAMILIES = new Set();
export const VAULTED_SOURCE = 'Empty. Ironmouse was briefly listed here (2026-07-31) but is NOT vaulted — it is UPCOMING, releasing Aug 4 2026 (confirmed by Ironmouse herself + all sources), so it lives in the release schedule as a future gate, not here. `vaulted` is for was-available-now-pulled; a not-yet-released sprite is a `future` gate. Add entries here ONLY when Epic pulls something that was live AND still ships the catalog entry; entries self-clear on observed ownership.';

// Holofoil variants ship Thursday 2026-07-09 at 9 AM ET (6 AM PT). Until
// that instant, buildModel flags them `future: true` (jail bars, hidden from
// Need filter, excluded from obtainable count). At that instant onward, they
// become normal locked-but-obtainable variants — same as any unowned Gold or
// Gummy. Gem variants remain `future` since Epic hasn't announced a date.
//   9 AM EDT = 13:00 UTC on the release day.
// Source: communities.epicgames.com/thread/…/kqQk
export const HOLOFOIL_RELEASE_MS = Date.UTC(2026, 6, 9, 13, 0, 0);

// Cube tier debut — Thursday 2026-07-23 at 6:00 AM PT (New Sprite Day).
// 6 AM PT summer (PDT) = 13:00 UTC. Which families get Cube is NOT listed
// here — that comes from Epic's live catalog (8 as of writing). Effect:
// "Overdrive when in Storm."
// Per Vice: vice.com/en/article/fortnite-cube-sprites-release-date-locations-powers/
export const CUBE_RELEASE_MS = Date.UTC(2026, 6, 23, 13, 0, 0);

// Chapter 7 Season 4 "Override" launch (Gaming Legends). v42.00. Downtime Thu
// 2026-08-20 2–7 AM ET; servers online 7 AM ET = 11:00 UTC — the real handoff
// instant (earlier than the 9 AM ET first assumed). A self-expiring COUNTDOWN
// note only (not sprite data) — Season 4's 16 new sprites auto-absorb from the
// live catalog/pak when Epic flips it. Drops off upcomingReleases() once passed.
// Source: beebom.com/fortnite-chapter-7-season-4-patch-notes.
export const SEASON4_DROP_MS = Date.UTC(2026, 7, 20, 11, 0, 0);

// ── Release schedule ────────────────────────────────────────────────────────
// The ONLY hand-maintained availability data in the whole tracker, and it is
// deliberately tiny: it holds just the things Epic has announced but not yet
// shipped. Anything absent is assumed live.
//
// Everything else that used to be hardcoded — which families have which tiers,
// which variants are obtainable — is now derived from Epic's live catalog on
// every sync (verified 2026-07-23 to match the in-game collection menu
// exactly). Entries here self-expire when their timestamp passes, and are
// overridden entirely the moment a real player is observed owning one, so a
// wrong or stale date corrects itself without a redeploy.
//
// To retire an entry: delete it. To add one: give it `at` (epoch ms, or null
// for "announced but undated") and optionally a `note` for the tile banner.
export const RELEASE_SCHEDULE = {
  tiers: {
    // Cube — Thursday 2026-07-23 6 AM PT. Epic in-game announcement +
    // communities post; corroborated by Vice.
    cube: { at: CUBE_RELEASE_MS, label: '⬢ Cube variants arrive' },
    // Gem — present in the catalog and shown locked in-game, but Epic has
    // never announced a date. null = indefinitely unreleased, no countdown.
    gem: { at: null },
  },
  families: {
    // Pollo enters the regular CHEST pool alongside the Cube drop — same
    // instant, per Epic's in-game announcement (confirmed 2026-07-23).
    //
    // gate:false is important — Pollo is genuinely obtainable RIGHT NOW via
    // Pollo's stream event, it's just not in normal chest rotation. So we do
    // NOT lock the tile; we only attach the explanatory note. Contrast with a
    // tier entry (Cube), which is not obtainable by any means until `at`.
    companystargazer: {
      at: CUBE_RELEASE_MS,
      gate: false,
      label: '🐔 Pollo enters chest rotation',
      note: {
        label: 'Stream event only',
        text: "Obtainable now, but only through Pollo's stream event — not yet in the regular chest pool. Enters normal chest rotation alongside the Cube variants on Thursday 2026-07-23 at 6 AM PT.",
      },
    },
    // CH7S4 Override: 11 of 12 sprites are obtainable at launch — Storm Scout
    // (Mythic) is in the files but NOT yet obtainable, "expected a future Sprite
    // Day" (Thursday, undated). `at: null` = indefinitely gated, no countdown.
    // Self-clears the instant any player is observed owning one. Sources:
    // accountshark.net + gamerant (2026-08). This is why the in-game roster is
    // 11 families (base+gold = 22 slots), not 12.
    stormscoutsprite: {
      at: null,
      label: '🌩️ Storm Scout arrives on a future Sprite Day',
      note: {
        label: 'Not yet obtainable',
        text: 'Storm Scout is in the game files but not yet available — Epic is expected to release it on a future Sprite Day (typically a Thursday). No date announced.',
      },
    },
  },
};

// ── Runtime overrides (live data injected by the web layer) ─────────────────
// This module deliberately has no DB access, so the route layer pushes live
// state in here. RELEASE_SCHEDULE above is only a compile-time FALLBACK used
// before the first DB load (and if the table is empty) — the authoritative
// copy lives in `epic_sprite_release_schedule` and is editable at runtime.
let runtimeSchedule = null;
export function setReleaseSchedule(next) {
  runtimeSchedule = (next && (Object.keys(next.tiers || {}).length || Object.keys(next.families || {}).length || Object.keys(next.cells || {}).length))
    ? { tiers: next.tiers || {}, families: next.families || {}, cells: next.cells || {} }
    : null;
}
export function activeSchedule() {
  return runtimeSchedule || RELEASE_SCHEDULE;
}

// Global observed-ownership set, aggregated across EVERY synced account. A
// per-account view is far too weak: one player not owning a Cube says nothing
// about whether Cube is live. Fed from `epic_sprite_observed_variants`.
// `cells` (family:tier pairs) is the important one — tier/family are coarse
// roll-ups kept for the schedule/hotfix skip logic. Gem ships STAGGERED (only
// some families live at a time, e.g. Llama Gem before the Aug-6 blanket drop),
// so "this exact variant was observed" must not be conflated with "the whole
// Gem tier is live". See isObtainable / isTierLive in buildModel.
let globalObserved = { tiers: new Set(), families: new Set(), cells: new Set() };
export function setObservedAvailability({ tiers = [], families = [], cells = [] } = {}) {
  globalObserved = { tiers: new Set(tiers), families: new Set(families), cells: new Set(cells) };
}
export function getObservedAvailability() {
  return { tiers: [...globalObserved.tiers], families: [...globalObserved.families], cells: [...globalObserved.cells] };
}

// Epic's OWN authoritative "disabled right now" list — variants it unmapped in
// the DDSS hotfix (`MappingID;None`). This DRIVES gating directly: a variant here
// is not in the loot pool, full stop. Pushed in from the hotfix poll. Guarded by
// freshness — if the poll dies, the set expires and we fall back to the schedule
// rather than trusting stale data. Note: only ever gates (authoritative NO);
// ABSENCE from the list is NOT treated as "enabled" (could just be untouched).
let epicDisabledSet = new Set();
let epicDisabledFreshUntil = 0;

// Epic's disable list uses TWO name shapes and we must match BOTH against our
// catalog (whose names are always the `_Variant_<Tier>` form):
//   • `<Family>_Variant_<Tier>`  e.g. DuckSprite_Variant_Gem  → ducksprite:gem
//   • `<Family>_<n>`             e.g. PedicureAntacidSprite_0 → the collab base
//     variant; the numeric index is the base (basic) tier.
// Normalising to `familyToken:tierKey` is what lets Epic's disable list gate
// Ironmouse. Without it, `PedicureAntacidSprite_0` never matched our
// `PedicureAntacidSprite_Variant_A`, so the disable list couldn't override the
// schedule timer — and a passed timer falsely showed Ironmouse obtainable while
// Epic still had it disabled. Returns null for shapes we can't confidently map.
export function normDisabledKey(name) {
  const mv = String(name).match(/^(.+?)_(?:Variant|Variation)_(.+)$/i);
  if (mv) {
    const tier = TIER_BY_TOKEN[mv[2].toLowerCase()];
    return tier ? `${mv[1].toLowerCase()}:${tier.key}` : null;
  }
  const mn = String(name).match(/^(.+?)_(\d+)$/);
  if (mn) return `${mn[1].toLowerCase()}:basic`;   // numeric-index base variant = basic tier
  return null;
}
export function setEpicDisabled({ variants = [], polledAtMs = 0, freshForMs = 6 * 60 * 60 * 1000 } = {}) {
  epicDisabledSet = new Set(variants.map(normDisabledKey).filter(Boolean));
  epicDisabledFreshUntil = polledAtMs ? polledAtMs + freshForMs : 0;
}
export function getEpicDisabled() {
  return { keys: [...epicDisabledSet], fresh: Date.now() < epicDisabledFreshUntil };
}

// Extract every (family, tier) a magpie counts map proves has reached players.
// Exported so the sync path can persist observations without re-deriving.
export function observationsFromCounts(counts = {}) {
  const out = [];
  for (const [vName, n] of Object.entries(counts)) {
    if (!n || vName.startsWith('Currency_')) continue;
    const { familyToken, tierToken } = parseVariant(vName);
    const tier = TIER_BY_TOKEN[tierToken];
    if (!tier || !familyToken) continue;
    out.push({ variantName: vName, familyToken, tierKey: tier.key });
  }
  return out;
}

// Upcoming announced drops, soonest-first, for UI countdowns. Reads the live
// schedule and filters out anything undated or already past.
export function upcomingReleases(now = Date.now()) {
  const sched = activeSchedule();
  // The DATE is the "fully live yet?" signal: a FUTURE date means the tier/family
  // isn't fully shipped, so show its countdown; a PAST date means it's live and
  // it drops out on its own (Cube: Jul 23 → gone). No observed-guard here — a
  // STAGGERED tier (Gem: Llama live, 7 gated for Aug 6) must still show its
  // countdown even though one variant is already observed. reconcileWithHotfix
  // already prevents a live tier's date being dragged into the future, so a stale
  // future date can't reintroduce the old Cube phantom.
  const out = [];
  for (const [key, s] of Object.entries(sched.tiers || {})) {
    if (s.at != null && s.at > now) out.push({ kind: 'tier', key, at: s.at, label: s.label || key });
  }
  for (const [key, s] of Object.entries(sched.families || {})) {
    if (s.at != null && s.at > now) out.push({ kind: 'family', key, at: s.at, label: s.label || key });
  }
  // Season 4 "Override" countdown — a self-expiring announcement note, not a
  // sprite gate. Falls off once the date passes.
  if (SEASON4_DROP_MS > now) out.push({ kind: 'season', key: 'season4', at: SEASON4_DROP_MS, label: '🎮 Season 4: Override' });
  return out.sort((a, b) => a.at - b.at);
}

// ── Model (catalog × inventory → families × tiers) ───────────────────────────
// Epic family token -> fnsprites image prefix (= our /sprites/img/<prefix>_<tier>.png).
export const FAMILY_TO_IMG = {
  spitfire: 'fire', water: 'water', earthsprite: 'earth', airsprite: 'air',
  sleepysprite: 'dream', punksprite: 'punk', bosssprite: 'boss', demonsprite: 'demon',
  fishysprite: 'fishy', sevensprite: 'seven', soccersprite: 'striker',
  zeropointsprite: 'zeropoint', driftersprite: 'aura', ghostsprite: 'ghost',
  ducksprite: 'duck', grimsprite: 'grim', kingsprite: 'king', burntpeanut: 'theburntpeanut',
  // v41.20 "Hot Bat Summer" additions — codename → image-prefix. Display names
  // extracted from ESD_*.uasset strings (see FAMILY_LABEL below). Icon PNGs
  // TBD via pak-audit texture-export — until then the grid renders tier-color
  // placeholders for these families.
  fossilmealsprite: 'batman', cokeparmesan: 'vinijr', companystargazer: 'pollo',
  // v41.30 Act III additions. Codename → image-prefix; the two collab codenames
  // (FillerGrunt=John Wick, PedicureAntacid=Ironmouse) don't derive from the
  // token, so they're explicit. Llama/Peely would derive fine but are listed
  // for clarity. Icon PNGs deployed via pak-audit texture-export.
  llamasprite: 'llama', peelysprite: 'peely',
  fillergruntsprite: 'johnwick',
  // Ironmouse's ESD codename is bare "PedicureAntacid" but Epic's catalog token
  // adds the suffix → "pedicureantacidsprite". Key on the catalog token so the
  // image resolves; keep the bare form too for safety.
  pedicureantacidsprite: 'ironmouse', pedicureantacid: 'ironmouse',
  // CH7S4 "Override" — catalog token → image prefix. Icon PNGs extracted from
  // the v42 pak (SpriteLibrary_Ch7S4). The Sonic trio's texture codenames differ
  // from the catalog tokens (verified by viewing the icons): Sonic's icon is
  // NarrowFlea_Obsidian, Shadow's is NarrowFlea_Scribe, Tails' is NarrowFlea_Monkey.
  '8bitblaster': '8bit', bushrangersprite: 'bush',
  cosmicthunderdoublejumpsprite: 'jackrabbit', crownsprite: 'crown',
  dwarf: 'adventure', jonesy: 'jonesy', killswitchsprite: 'killswitch',
  klombo: 'klombo', narrowfleamonkeysprite: 'tails', narrowfleasprite: 'sonic',
  reloadovertimesprite: 'shadow', stormscoutsprite: 'stormscout',
  // Sep-2026 patch — 4 new families. Icons extracted from the v42.x pak
  // (SpriteDefinitions/{Overshield,WinnerBSprite,WinnerCSprite,ImprovedSlide}).
  overshieldsprite: 'overshield', winnerbsprite: 'winnerb',
  winnercsprite: 'winnerc', improvedslide: 'improvedslide',
  // Sep-17-2026 patch — 5 more families (+ reaper tier).
  increasehealssprite: 'increaseheals', bodyslamsprite: 'bodyslam',
  winnerasprite: 'winnera', ghostdamage: 'ghostdamage', birthdaysprite: 'birthday',
  // Oct-1-2026 "Fortnitemares" patch — 4 new live families (+ TrickTreat tier).
  // Icon codenames (pak): HealthSiphon, IncreasedMelee, PhaseDash, WinnerD.
  healthsiphonsprite: 'vampire', increasedmeleesprite: 'thedeer',
  phasedashsprite: 'spookydash', winnerdsprite: 'winnerd',
  // Oct-15-2026 patch — 2 new families (gated to the Oct-15 13:00Z drop).
  // Icon codenames (pak): WinnerE, CargoLying.
  winnere: 'honey', cargolyingsprite: 'onewishwillow',
  // CH7 Treasure Hunters mini-season (module 05b7e211, boot capture 2026-11-01).
  // Catalog token (lowercased) → image prefix; icon PNGs extracted from the
  // SpriteLibrary_Ch7MS pak. Codename → DisplayName in FAMILY_LABEL below.
  treasuremap: 'treasuremap', compass: 'compass', treasurechest: 'treasurechest',
  coinpile: 'coinpile', unbotheredfish: 'unbotheredfish', barreloffish: 'barreloffish',
  parrot: 'parrot', peelybones: 'peelybones', playmakerbrewery: 'playmakerbrewery',
  rookgecko: 'rookgecko', squibbly: 'squibbly', feedjet: 'feedjet', starlight: 'starlight',
  // v43.10 (2026-11-12) S43 Battle Pass additions — same Ch7MS module. Icon PNGs
  // extracted (ART codenames differ: DaffodilChurn icon=LushlyZest, YortMelee
  // icon=ZeroPointPiece — handled in TextureExport, output uses catalog tokens).
  piratecalamari: 'piratecalamari', whitetiger: 'whitetiger',
  daffodilchurn: 'daffodilchurn', yortmelee: 'yortmelee',
};
export const FAMILY_LABEL = {
  spitfire: 'Fire', water: 'Water', earthsprite: 'Earth', airsprite: 'Air',
  sleepysprite: 'Dream', punksprite: 'Punk', bosssprite: 'Boss', demonsprite: 'Demon',
  fishysprite: 'Fishy', sevensprite: 'Seven', soccersprite: 'Striker',
  zeropointsprite: 'Zero Point', driftersprite: 'Aura', ghostsprite: 'Ghost',
  ducksprite: 'Duck', grimsprite: 'Grim', kingsprite: 'King', burntpeanut: 'Burnt Peanut',
  // v41.20 display names — pulled directly from the ESD_*.uasset DisplayName
  // strings (Epic's own text). Codenames in comments for future grep.
  fossilmealsprite: 'Batman',         // codename: FossilMealSprite. DC crossover, Mythic
  cokeparmesan: 'Vini Jr.',           // codename: CokeParmesan. Vinícius Jr. — real-life Brazilian footballer
  companystargazer: 'Pollo',          // codename: CompanyStargazer. Squad-shield support sprite
  // CH7S4 Override (module 828c9446, capture 2026-08-20). Only the confidently
  // self-named codenames are mapped here; the ability-codenamed ones
  // (cosmicthunderdoublejumpsprite, narrowfleasprite, narrowfleamonkeysprite,
  // dwarf) are LEFT to the boot pak-scan so we never guess a misleading name.
  killswitchsprite: 'Killswitch',     // ability: enter Hangtime with improved accuracy
  crownsprite: 'Crown',               // ability: extra Crown Wins after Victory Royale
  klombo: 'Klombo',                   // ability: grants random items each level
  jonesy: 'Jonesy',                   // ability: health/shield recovery after damage
  stormscoutsprite: 'Storm Scout',    // ability: Overdrive after storm damage
  // Sep-2026 patch — display names pulled from the pak ESD DisplayName strings
  // (Epic's own text, via the pak-scan). Authoritative, not guesses.
  improvedslide: 'Mega Man',          // codename: ImprovedSlide. Capcom collab; ability: reduced sliding friction
  overshieldsprite: 'Overshield',     // codename: OvershieldSprite. Fortnite original (blue knight)
  winnerbsprite: 'X-Ray',             // codename: WinnerBSprite. Scientist; ability: periodically marks nearby enemies
  winnercsprite: 'Onigiri',           // codename: WinnerCSprite. Rice ball; ability: Overdrive after a Consumable
  // Sep-17-2026 patch — names from pak ESD DisplayName (pak-scan). Collabs confirmed.
  bodyslamsprite: 'Crash Bandicoot',  // codename: BodySlamSprite. Crash collab; active whirlwind attack
  ghostdamage: 'Blinky',              // codename: GhostDamageSprite. Pac-Man ghost; cloak on damage
  increasehealssprite: 'Morgana',     // codename: IncreaseHealsSprite. Persona 5; boosts healing items
  winnerasprite: 'Pond',              // codename: WinnerASprite. Super Jump after landing
  birthdaysprite: 'Birthday',         // codename: BirthdaySprite. Chests spawn cake
  // Oct-1-2026 "Fortnitemares" patch — names from pak ESD DisplayName (pak-scan). Halloween-themed.
  healthsiphonsprite: 'Vampire',      // codename: HealthSiphonSprite. Recover health when damaging an enemy
  increasedmeleesprite: 'The Deer',   // codename: IncreasedMeleeSprite. Melee attacks deal more damage
  phasedashsprite: 'Spooky Dash',     // codename: PhaseDashSprite. Active: phase through objects (air-jump)
  winnerdsprite: 'Dumpster Dive',     // codename: WinnerDSprite. Food provides bonus healing
  '8bitblaster': '8-Bit',             // ability: 8-Bit Shotgun in first chest
  bushrangersprite: 'Bush',           // ability: spawns bush; bush on elimination at max
  reloadovertimesprite: 'Shadow',     // Shadow the Hedgehog (icon: NarrowFlea_Scribe)
  // The remaining catalog tokens differ from the pak codenames, so map explicitly
  // (verified via pak ESD DisplayName strings + icon inspection):
  narrowfleasprite: 'Sonic',                    // pak NarrowFlea / icon NarrowFlea_Obsidian
  narrowfleamonkeysprite: 'Tails',              // pak NarrowFleaMonkey / icon NarrowFlea_Monkey
  dwarf: 'Adventure',                           // pak DwarfSprite
  cosmicthunderdoublejumpsprite: 'Jackrabbit',  // pak DoubleJumpSprite / icon JazzJackrabbit
  // Oct-15-2026 patch — names from pak ESD DisplayName (pak-scan). Both gated to
  // the Oct-15 13:00Z drop via epic_sprite_release_schedule (family rows).
  winnere: 'Honey',                    // codename: WinnerESprite. Ch7S3 design-a-Sprite contest winner; bees spawn on ranged damage
  cargolyingsprite: 'One Wish Willow', // codename: CargoLyingSprite. Curry Barker "Obsession" horror-movie collab (articles say "Obsession Sprite"; locker renders the ESD character name, same Morgana/Persona pattern). Extract foes' sprites on elim; push on damage; marks you
  // CH7 Treasure Hunters mini-season (module 05b7e211, 2026-11-01). DisplayNames
  // pulled VERBATIM from each ESD_<Codename>Sprite.uasset (Epic's own text) — NOT
  // press names. Cross-verified in-game: #1 Halfpeel'd (PeelyBones), #57
  // Transponder Snail (FeedJet). Pirate/music-collab puns; never guessable.
  treasuremap: 'Exmarks',             // ability: reveals Treasure Maps & Wanted Posters; spawns a Treasure Map at max
  compass: 'Wayfinder',               // ability: reveals nearby Sprites; +items from Buried Chests
  treasurechest: 'Chester',           // ability: chance of extra Treasure Chest loot; nullifies fall damage
  coinpile: 'Plundarrgh',             // ability: opening a Chest grants pickaxe + movement speed
  unbotheredfish: 'Kelper',           // ability: restores health over time while in water
  barreloffish: "Barry O'Fish",       // ability: less sprint-stamina drain in water; Slap at max
  parrot: 'Re-Pete',                  // ability: faster reload + chance to refund ammo
  peelybones: "Halfpeel'd",           // ability: marks eliminations on the map (ESD codename PeelyBone, catalog token PeelyBones)
  playmakerbrewery: "Lil' Flacko",    // ability: shockwave on landing, knockback (A$AP Rocky collab)
  rookgecko: "Lil' Uzi Vert Jr.",     // ability: Chug Splash effect when restoring shields (Lil Uzi collab)
  squibbly: "Lil' Squibbly",          // ability: fishing a hole gives bonus loot
  feedjet: 'Transponder Snail',       // ability: extra resources on pickup; teammates share
  starlight: 'Sweet Dreams',          // ability: random item each level; Mythic loot at max
  // v43.10 (2026-11-12) S43 Battle Pass additions. DisplayNames VERBATIM from the
  // ST_SpriteBoons string table (Epic's own text). YortMelee is DELIBERATELY absent:
  // Epic shipped it with an EMPTY ItemName (unlocalized) — no valid name exists in
  // the files, so it renders as the honest PENDING_FAMILY_LABEL ("New Sprite") until
  // Epic localizes it. Never invent one.
  piratecalamari: 'Squiplash',        // ability: deploys a Healing Smoke Bomb at low health (calamari/squid pun)
  whitetiger: 'Sir Oscar the Second', // ability: +Pickaxe damage; speed boost when Shield breaks
  daffodilchurn: 'Mini Miku',         // ability: Friendship Bubble when emoting with others (Hatsune Miku collab)
};
// Tier order matters: it drives the column order in the sprite grid.
// Basic/Gold/Gummy/Galaxy are the four the game has actually shipped so far.
// Holofoil + Gem are pak-baked and being drip-released.
// Cube + Quack are also pak-baked per the datamine (see
// [[reference_fortnite_sprite_pak_datamine]]) but Epic hasn't enabled the
// catalog entries yet — added preemptively so if/when they ship, our tracker
// picks them up automatically instead of silently dropping the variants.
// If tier tokens appear that aren't matched here, buildModel logs a warning
// with the unknown token so we can add it quickly.
export const TIERS = [
  { key: 'basic', label: 'Basic', match: ['a', 'base'], color: '#9aa6b2' },
  // CH7 Treasure Hunters mini-season (2026-11-01) — two premium tiers on module
  // 05b7e211. Catalog tokens 'Cursed' / 'Jeweled' (lowercased to match). Cursed
  // was disabled at launch per the patch notes; the live availability signal
  // (unmapped variant) handles that automatically, no hard gate needed.
  { key: 'cursed', label: 'Cursed', match: ['cursed'], color: '#7c3aed' },
  { key: 'jeweled', label: 'Jeweled', match: ['jeweled'], color: '#e11d48' },
  // 'liquidgold' = Epic's raw token for the v43.10 (2026-11-12) Treasure Hunters
  // Gold return. Folded onto the canonical Gold tier so it reuses the Gold label +
  // color + icon slug (<fam>_gold.png) instead of the muddy auto-discovered styling.
  // Kept GATED via an epic_sprite_release_schedule tier row (item_key='gold',
  // release_at=null) because obtainability is unconfirmed + 0 owned network-wide —
  // self-unlocks per-cell the instant any player is observed owning one.
  { key: 'gold', label: 'Gold', match: ['gold', 'liquidgold'], color: '#ffcf3a' },
  // CH7S4 Override tier — the new premium variant (replaces the old Gummy/Galaxy/
  // Gem/Holofoil/Cube ladder). Raw token 'CheatMaster'.
  { key: 'cheatmaster', label: 'Cheat Master', match: ['cheatmaster'], color: '#ff4d6d' },
  // Sep-2026 patch: 4th Override tier. Catalog token "loothacker"; icon suffix "_Hacker".
  // Nice label instead of the auto-discovered "Loothacker". Kept gated (DB tier row,
  // release_at=null) since 0 are owned network-wide — not obtainable yet, catalog shipped
  // ahead of the drop. Owned cells still self-unlock via the observedCells override.
  { key: 'loothacker', label: 'Loot Hacker', match: ['loothacker', 'hacker'], color: '#22c55e' },
  // Sep-2026 5th Override tier. Catalog/variant codename "reaper", icon suffix "_BountyHunter",
  // but the PLAYER-FACING name is "Bounty Hunter" (the Sep-24 "New Sprite Day: Bounty Hunter
  // Sprites" event + the _BountyHunter icons). "Reaper" was the internal codename — corrected.
  { key: 'reaper', label: 'Bounty Hunter', match: ['reaper', 'bountyhunter'], color: '#a855f7' },
  // Oct-1-2026 "Fortnitemares" patch: 6th Override tier. Catalog/variant codename
  // "TrickTreat", icon suffix "_TrickTreat". Player-facing label "Trick or Treat"
  // (Halloween/Fortnitemares event). NOT gated — greyed-in-locker = obtainable.
  { key: 'tricktreat', label: 'Trick or Treat', match: ['tricktreat', 'trickortreat'], color: '#ff7518' },
  // key 'gummy' but match Epic's raw 'candy' string — Epic ships the tier as
  // "Extraction.VariantRarity.Candy" but the in-game label is "Gummy".
  { key: 'gummy', label: 'Gummy', match: ['candy'], color: '#ff6cc4' },
  { key: 'galaxy', label: 'Galaxy', match: ['galaxy', 'galactic'], color: '#7b5cff' },
  { key: 'gem', label: 'Gem', match: ['gem'], color: '#3ad0c4' },
  { key: 'holofoil', label: 'Holofoil', match: ['holofoil'], color: '#5bf0ff' },
  { key: 'cube', label: 'Cube', match: ['cube'], color: '#c084fc' },
  { key: 'quack', label: 'Quack', match: ['quack'], color: '#facc15' },
];
const TIER_BY_TOKEN = Object.fromEntries(TIERS.flatMap((t) => t.match.map((m) => [m, t])));

// ── Auto-discovered tiers ───────────────────────────────────────────────────
// Epic ships new tiers into the catalog before announcing them (Cube and Gem
// both appeared this way). Previously an unrecognised tier token was counted
// in `unknownTiers` and then DROPPED — the variants vanished from the grid
// entirely until someone hand-added them to TIERS and redeployed.
//
// Now we synthesise a tier on sight and PUSH it into the exported TIERS array,
// so every existing consumer (grid columns, filters, compare pills, sort
// ranks) picks it up with no further changes. Registration is idempotent and
// additive; new tiers land as the right-most column.
const DISCOVERED_TIER_KEYS = new Set();

// Deterministic colour so a given tier keeps the same hue across restarts and
// across processes — derived from the token, not from registration order.
function colorForTierToken(token) {
  let h = 0;
  for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 85% 68%)`;
}

function registerDiscoveredTier(tierToken) {
  const key = String(tierToken || '').toLowerCase();
  if (!key) return null;
  if (TIER_BY_TOKEN[key]) return TIER_BY_TOKEN[key];
  const tier = {
    key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
    match: [key],
    color: colorForTierToken(key),
    discovered: true,     // marks it as unannounced -> assumed not live yet
  };
  TIERS.push(tier);
  TIER_BY_TOKEN[key] = tier;
  DISCOVERED_TIER_KEYS.add(key);
  logger.warn(`[sprite-tier] NEW TIER DISCOVERED in Epic's catalog: "${tierToken}" -> rendering as "${tier.label}" (${tier.color}). Treated as UNRELEASED until a player is observed owning one, or a row is added to epic_sprite_release_schedule.`);
  return tier;
}

export function discoveredTierKeys() {
  return [...DISCOVERED_TIER_KEYS];
}
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
//
// The list is now DERIVED at request time by deriveDataminedVariants(pak) from
// the daily pak-scan.json output — see the function below. Any tier the pak
// ships that Epic hasn't enabled in the live catalog auto-appears here without
// a code change. `hasIcon` is resolved by the caller via disk existence.
// Some Fortnite families ship as `_Variation_` (Spitfire, BurntPeanut) instead
// of `_Variant_`; this table encodes that quirk.
const PAK_VARIANT_PREFIX = { spitfire: 'Variation', burntpeanut: 'Variation' };

export function deriveDataminedVariants(pak) {
  if (!pak || !pak.per_family_pak) return [];
  const out = [];
  for (const [family, tiers] of Object.entries(pak.per_family_pak)) {
    const familyToken = family.toLowerCase();
    if (!FAMILY_TO_IMG[familyToken]) continue;    // unknown family — skip
    const seenKeys = new Set();
    for (const rawTier of tiers) {
      const tierToken = rawTier.toLowerCase();
      const tier = TIER_BY_TOKEN[tierToken];
      if (!tier) continue;                         // unknown tier token
      if (tier.key === 'basic') continue;          // base tier is always live
      if (seenKeys.has(tier.key)) continue;        // dedupe Galaxy vs Galactic
      seenKeys.add(tier.key);
      const prefix = PAK_VARIANT_PREFIX[familyToken] || 'Variant';
      out.push({
        name: `${family}_${prefix}_${rawTier}`,
        familyToken,
        tierToken,
        hasIcon: null,        // resolved by caller (disk check)
      });
    }
  }
  return out;
}

export function parseVariant(name) {
  const m = name.match(/^(.+?)_(?:Variant|Variation)_(.+)$/);
  if (!m) return { familyToken: name.toLowerCase(), tierToken: 'a' };
  return { familyToken: m[1].toLowerCase(), tierToken: m[2].toLowerCase() };
}
// File names on disk mirror Epic's raw pak naming (the daily audit exports
// icons by Epic's own filenames — Gummy files are `*_candy.png`). Remap
// tier.key='gummy' back to 'candy' for the URL slug only; internal state
// stays 'gummy'.
const IMG_TIER_SLUG = { gummy: 'candy' };
export function imgIdFor(name) {
  const { familyToken, tierToken } = parseVariant(name);
  // Prefer the explicit map; else derive a prefix from the token (strip the
  // "sprite" suffix) so a NEW family with a descriptive codename (llamasprite →
  // llama) still gets an imgId instead of null. Collab codenames that don't
  // derive cleanly (fillergruntsprite) rely on the explicit map above.
  const fam = FAMILY_TO_IMG[familyToken] || (familyToken || '').replace(/sprite$/, '') || null;
  const tier = TIER_BY_TOKEN[tierToken];
  if (!fam || !tier) return null;
  const slug = IMG_TIER_SLUG[tier.key] || tier.key;
  return `${fam}_${slug}`;
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

// ── Sprite-extras extractor ────────────────────────────────────────────────
// Athena profile also carries per-account sprite quest completion + owned
// sprite-adjacent cosmetics (extraction frames, sprite-themed backblings).
// Not part of the sprite catalog itself but useful for a "you as a sprite
// player" summary card. Called from buildModel; result attached to
// state.summary.spriteExtras.
export function extractSpriteExtras(athena) {
  const items = athena?.items || {};
  if (!items || typeof items !== 'object') return null;

  // Quest progression by phase — sprite mastery + extraction
  const questsByPhase = {}; // { p01: {total, active, completed, claimed}, p02: {...}, extraction: {...} }
  let pinnedSpriteQuest = null;
  const pinnedQuestId = athena?.stats?.attributes?.pinned_quest;
  for (const [instanceId, item] of Object.entries(items)) {
    const tid = item?.templateId;
    if (!tid || !tid.startsWith('Quest:')) continue;
    // Match sprite mastery + extraction quests only
    const m = tid.match(/quest_s41_(?:sprite)?mastery_(p\d+)/i)
           || tid.match(/quest_s41_extraction_(p\d+)/i);
    if (!m) continue;
    const phase = m[1].toLowerCase();
    const isMastery = /mastery/i.test(tid);
    const bucket = isMastery ? `mastery_${phase}` : `extraction_${phase}`;
    if (!questsByPhase[bucket]) {
      questsByPhase[bucket] = { total: 0, active: 0, completed: 0, claimed: 0, unattainable: 0 };
    }
    const s = questsByPhase[bucket];
    s.total++;
    const state = item.attributes?.quest_state;
    if (state === 'Claimed') s.claimed++;
    else if (state === 'Completed') s.completed++;
    else if (state === 'Active') s.active++;
    if (item.attributes?.quest_rarity === 'unattainable') s.unattainable++;
    // Pin match
    if (instanceId === pinnedQuestId) {
      pinnedSpriteQuest = { templateId: tid, ...item.attributes };
    }
  }

  // Owned sprite-adjacent cosmetics — group by theme. Themes are inferred
  // from the templateId's family word (coppermoggy/pixieparts/funkyfeather/
  // tideking/etc.). Anything under AthenaBackpack:backpack_extractionframe_*
  // is a Sprite Extraction Frame — the back-mounted cosmetic that plays a
  // custom animation when you extract a sprite.
  const cosmeticThemes = {}; // { themeName: [{ templateId, category }] }
  const COSMETIC_CATEGORIES = new Set(['AthenaBackpack','AthenaCharacter','AthenaItemWrap','AthenaLoadingScreen','AthenaDance','AthenaPickaxe','AthenaGlider','AthenaEmoji','AthenaSpray']);
  for (const item of Object.values(items)) {
    const tid = item?.templateId;
    if (!tid) continue;
    const [category, rawId] = tid.split(':');
    if (!COSMETIC_CATEGORIES.has(category)) continue;
    const id = (rawId || '').toLowerCase();
    // Identify sprite-adjacent themes. Keep this list additive as we discover
    // more; unknown cosmetics with sprite/extraction naming still get grouped.
    let theme = null;
    if (id.startsWith('backpack_extractionframe')) theme = 'Extraction Frames';
    else if (/coppermoggy/.test(id)) theme = 'Copper Moggy';
    else if (/pixieparts/.test(id)) theme = 'Pixie Parts';
    else if (/funkyfeather/.test(id)) theme = 'Funky Feather';
    else if (/tideking/.test(id)) theme = 'Tide King';
    else if (/kin[_-]?quack|quackduck|quack_duck/.test(id)) theme = 'Kin Quack';
    else if (/cluster/.test(id)) theme = 'Cluster';
    else if (/spritepod|sprite_pod/.test(id)) theme = 'Sprite Pod';
    else continue;
    if (!cosmeticThemes[theme]) cosmeticThemes[theme] = [];
    cosmeticThemes[theme].push({ templateId: tid, category });
  }

  // Nothing to show for this user? Return null so renderer skips the section.
  if (Object.keys(questsByPhase).length === 0 && Object.keys(cosmeticThemes).length === 0) {
    return null;
  }
  return { questsByPhase, cosmeticThemes, pinnedSpriteQuest };
}

// Shown in place of an unresolved family's raw codename until its real display
// name lands (via the boot pak-scan's per_family_meta or a FAMILY_LABEL entry).
// Honest > misleading: "New Sprite" beats leaking "PedicureAntacidSprite".
export const PENDING_FAMILY_LABEL = 'New Sprite';

export function buildModel(catalog, invJson, athena, opts = {}) {
  const block = Array.isArray(invJson?.inventory)
    ? (invJson.inventory.find((b) => b.counts || b.entitlementMetadata) || invJson.inventory[0] || {})
    : (invJson || {});
  const counts = block.counts || {};
  const ent = block.entitlementMetadata || {};
  let meta = {};
  try { meta = typeof block.metadata === 'string' ? JSON.parse(block.metadata) : (block.metadata || {}); } catch { /* ignore */ }
  const dust = counts.Currency_ExtractionPoints ?? null;
  const epicStats = extractAthenaStats(athena);
  const spriteExtras = extractSpriteExtras(athena);

  // Discovery hooks — log anything in the raw magpie response we don't
  // currently consume. Catches new currency types + metadata keys the moment
  // Epic ships them, so we can extend the model instead of silently dropping
  // data. Only reports keys, never values (values may contain PII).
  // Both arrived with CH7S4 (Oct 1 2026). PityScore is a small counter (0-4 seen), stored as
  // summary.pityScore; what raises or resets it is not documented yet, so nothing renders it.
  // conversionOutcomes is Epic's receipt ledger ({<guid>: {outcome: 'SUCCEEDED', operationId}})
  // for server-side conversions: opaque, ever-growing, nothing to show, so it is not stored.
  const KNOWN_META_KEYS = new Set(['StarterRelic', 'EquippedVariant', 'PityScore', 'conversionOutcomes']);
  const unknownCurrencyKeys = Object.keys(counts).filter(
    (k) => k.startsWith('Currency_') && k !== 'Currency_ExtractionPoints',
  );
  const unknownMetaKeys = Object.keys(meta).filter((k) => !KNOWN_META_KEYS.has(k));

  // Suppression list — variants Epic's catalog exposes but that are NOT
  // actually enabled in the in-game locker. Currently empty: FAQ (2026-07-19)
  // confirms Cube variants are in the code AND show in the collection menu
  // (just locked/unreleased) — so we surface them via the normal future-tile
  // flow below. Add entries here only if a user has visually verified a
  // variant is missing entirely from the in-game collection menu.
  const CATALOG_SUPPRESS = new Set();

  // ── Availability model ──────────────────────────────────────────────────
  // Two independent questions, answered by two independent LIVE sources.
  // Neither is a hand-maintained per-family list — the old whitelist drifted
  // out of date on every patch and had to be re-transcribed from news posts.
  //
  //   1. Does (family, tier) EXIST?
  //      → Epic's catalog, iterated verbatim below. Whatever Epic ships shows
  //        up automatically: new family, new tier, new collab, all of it.
  //        Verified 2026-07-23 that the catalog's family×tier matrix matches
  //        the in-game collection menu exactly (Cube on 8 families, Holofoil
  //        on 8, Gem on 6), so there is nothing left for a whitelist to add.
  //
  //   2. Is that tier / family LIVE in the loot pool yet?
  //      → RELEASE_SCHEDULE below, which holds ONLY things Epic has announced
  //        but not yet shipped. Anything absent is assumed live. Entries
  //        self-expire the moment their timestamp passes — no redeploy — and
  //        are short-circuited entirely as soon as we observe a real player
  //        owning one, because ownership is ground truth that outranks any
  //        schedule we were told.
  //
  // Net effect: the only thing a human ever needs to touch is a countdown for
  // an unreleased drop, and even that is self-clearing.
  // (Defined at module scope as RELEASE_SCHEDULE so the web layer can render
  // the same countdowns without re-declaring any dates.)

  // Ground truth: anything a real player has actually held is, by definition,
  // obtainable. Magpie's counts map is ternary (0 never had / 1 had+extracted
  // / 2 in locker) so any non-zero entry proves the variant reached players.
  // This makes the schedule above self-correcting — if Epic drops early, ships
  // late, or our announced date was simply wrong, the first synced account to
  // hold one flips the tier live for everyone.
  // Seed from the GLOBAL ledger (every account we've ever synced), then union
  // this account's own inventory so a brand-new observation counts immediately
  // rather than waiting for the next ledger refresh.
  const globals = globalObserved;
  const observedTiers = new Set(globals.tiers);
  const observedFamilies = new Set(globals.families);
  const observedCells = new Set(globals.cells);   // `${familyToken}:${tierKey}` — per-cell proof
  for (const o of observationsFromCounts(counts)) {
    observedTiers.add(o.tierKey);
    observedFamilies.add(o.familyToken);
    observedCells.add(`${o.familyToken}:${o.tierKey}`);
  }

  // Epic's authoritative disable list (fresh only) — see setEpicDisabled. Drives
  // gating directly. Empty when the hotfix poll is stale, so we fall back to the
  // schedule instead of trusting old data.
  const epicDisabled = Date.now() < epicDisabledFreshUntil ? epicDisabledSet : new Set();

  // Live schedule (DB-backed), falling back to the compile-time constant only
  // before the first successful load.
  const SCHED = activeSchedule();

  const isTierLive = (tierKey) => {
    // A tier with an explicit schedule row follows its DATE — NOT a stray
    // observation. Gem ships staggered (Llama Gem is obtainable weeks before the
    // Aug-6 blanket drop), so one observed Gem cell must not flip the whole tier
    // live. Per-variant proof is applied in isObtainable via `observedCells`;
    // this tier-wide check stays coarse on purpose.
    const s = SCHED.tiers[tierKey];
    if (s) return s.at != null && Date.now() >= s.at;
    // No schedule row: ownership anywhere proves the tier live (atomic launches
    // like Holofoil had no future gate). An established tier with no row is live
    // (Basic/Gold/Gummy/Galaxy). A tier auto-discovered from the catalog this
    // patch is assumed NOT live until observed — Epic ships tiers into the
    // catalog ahead of release; wrong-but-locked self-corrects on first sync.
    if (observedTiers.has(tierKey)) return true;
    return !DISCOVERED_TIER_KEYS.has(tierKey);
  };
  const isFamilyLive = (familyToken) => {
    if (observedFamilies.has(familyToken)) return true;
    const s = SCHED.families[familyToken];
    // gate:false = the family is obtainable already and the schedule entry
    // exists only to carry an explanatory note (e.g. "stream event only").
    if (!s || s.gate === false) return true;
    return s.at != null && Date.now() >= s.at;
  };
  const isObtainable = (familyToken, tierKey) => {
    const cell = `${familyToken}:${tierKey}`;
    // 1) Epic's fresh disable list is AUTHORITATIVE — and beats even observed
    //    ownership. A variant Epic has pulled from the loot pool is not obtainable
    //    even if a player still owns one from before (a rotated-out collab, e.g.
    //    when Ironmouse/John Wick leave at a season change). Matched on the
    //    normalized family:tier key so Epic's `_0`-style names gate correctly.
    //    (Absence from the list is NOT "enabled" — see setEpicDisabled.)
    if (epicDisabled.has(cell)) return false;
    // 2) Concrete proof: observed in any inventory ⇒ obtainable, even while the
    //    rest of its tier is gated (the staggered-Gem / Llama-Gem case).
    if (observedCells.has(cell)) return true;
    // 3) Cell-specific dated gate: one variant debuts on its own date while the
    //    rest of its tier/family is already live (e.g. the 4 Cheat Masters that
    //    debut on New Sprite Day, Aug 27). Authoritative for THIS cell and self-
    //    expiring — once the date passes it returns true regardless of tier/family.
    const cs = (SCHED.cells || {})[cell];
    if (cs && cs.at != null) return Date.now() >= cs.at;
    return isTierLive(tierKey) && isFamilyLive(familyToken);
  };

  // Per-family disclaimer surfaced on the tile + info card, for families that
  // exist but have an unusual availability window. Auto-clears the instant the
  // family goes live so a stale "not in chests yet" banner can't outlive the
  // drop it describes.
  // Note visibility keys off the timestamp ONLY — deliberately not off
  // observed ownership. "Already in someone's locker" and "in the regular
  // chest pool" are different facts: an early adopter who grabbed Pollo from
  // the stream event should still see why it was hard to get. The note clears
  // itself the moment the announced rotation date passes.
  const noteFor = (familyToken) => {
    const s = SCHED.families[familyToken];
    if (!s?.note) return null;
    if (s.at != null && Date.now() >= s.at) return null;
    return s.note;
  };

  // When does this specific tile unlock? A variant is gated by BOTH its tier
  // and its family, so it goes live at whichever unlocks last. Returned on the
  // variant itself so the UI can render a countdown generically — the renderer
  // never has to know that "cube" or "holofoil" are special. null = either
  // already live, or unreleased with no announced date (renders "Unreleased").
  const releasesAtFor = (familyToken, tierKey) => {
    const fam = SCHED.families[familyToken];
    const stamps = [
      // Skip note-only (gate:false) families — they aren't locked, so a
      // "Releases in …" countdown would contradict the tile being available.
      fam && fam.gate !== false ? fam.at : null,
      SCHED.tiers[tierKey]?.at,
      // Cell-specific dated gate (e.g. a single Cheat Master's New Sprite Day).
      (SCHED.cells || {})[`${familyToken}:${tierKey}`]?.at,
      // Only FUTURE stamps are a countdown. A gated variant whose scheduled date
      // has already PASSED but that Epic still hasn't enabled (e.g. Ironmouse's
      // Aug-4 estimate lapsed while Epic kept it disabled) must not render a
      // bogus "released"/negative countdown — it stays a plain "Unreleased".
    ].filter((x) => x != null && x > Date.now());
    return stamps.length ? Math.max(...stamps) : null;
  };
  const families = new Map();
  const unknownTierTokens = new Set();
  for (const [name, c] of Object.entries(catalog || {})) {
    const { familyToken, tierToken } = parseVariant(name);
    let tier = TIER_BY_TOKEN[tierToken];
    if (!tier) {
      // Epic shipped a tier we've never seen. Register it on the fly so the
      // variants RENDER (previously they were dropped and the tier silently
      // vanished from the site until someone edited TIERS and redeployed).
      // Still tracked in unknownTiers so the sync logs one loud warning.
      unknownTierTokens.add(tierToken);
      tier = registerDiscoveredTier(tierToken);
      if (!tier) continue;   // unparseable token — nothing sensible to show
    }
    // Drop suppressed catalog entries (Epic exposes them but the in-game
    // locker doesn't show them — usually DDSS-gated).
    if (CATALOG_SUPPRESS.has(`${familyToken}:${tier.key}`)) continue;
    let xp = null, ml = false, owned = false;
    if (name in counts) {
      owned = true;
      try { const e = JSON.parse(ent[name] ?? '{}'); xp = e.xp ?? 0; ml = !!e.ml; } catch { xp = 0; }
    }
    // Observed ownership overrides the vaulted list too (same rule as the tier/
    // schedule gates): if any account is seen owning this family, it's obtainable
    // by definition, so a stale VAULTED_FAMILIES entry can't outlive a re-release.
    const familyVaulted = VAULTED_FAMILIES.has(familyToken) && !observedFamilies.has(familyToken);
    const cellKey = `${familyToken}:${tier.key}`;
    // VAULTED vs FUTURE — both mean "not obtainable", but they're distinct facts:
    //  • vaulted = was live, now pulled. Epic DISABLED a variant that has been
    //    observed in an inventory (a collab rotated out at a season change), or a
    //    manual VAULTED_FAMILIES override.
    //  • future  = gated but NEVER seen live (announced/unreleased) → gets a
    //    "Releases in …" countdown; vaulted does not.
    // Owners always keep it as a normal Collected cell (both flags need !owned).
    const wasEverLive = observedCells.has(cellKey);
    const obtainable = isObtainable(familyToken, tier.key);
    const isVaulted = !owned && ((epicDisabled.has(cellKey) && wasEverLive) || familyVaulted);
    const isFuture = !owned && !obtainable && !isVaulted;
    const variant = {
      name, familyToken, tierKey: tier.key, tierLabel: tier.label, tierColor: tier.color,
      owned, vaulted: isVaulted,
      xp, mastered: ml, dupes: counts[name] ?? 0,
      summonCost: c.attributes?.summonCost ?? null, starter: !!c.attributes?.bIsStarter,
      // Existence comes from the catalog (we're iterating it). `future` is
      // purely "exists but not live yet" per RELEASE_SCHEDULE + observed
      // ownership — matches the in-game visible-but-locked display. Owned
      // variants from prior availability windows keep their owned/XP state.
      imgId: imgIdFor(name), future: isFuture,
      // Soft disclaimer — informational only, doesn't affect obtainable/future
      // counts. Renders as a tile badge + info-card callout, and self-clears
      // once the family's release timestamp passes.
      availabilityNote: noteFor(familyToken),
      // Epoch ms this tile unlocks, or null. Only a FUTURE (coming) variant gets
      // a countdown — a vaulted one is gone, not arriving.
      releasesAt: isFuture ? releasesAtFor(familyToken, tier.key) : null,
    };
    if (!families.has(familyToken)) {
      // Display label priority:
      //   1) pak-scan's per_family_meta.display_name (Epic's own text, live)
      //   2) hardcoded FAMILY_LABEL fallback (for families the pak scan hasn't seen)
      //   3) raw familyToken (last resort if nothing else matches)
      // Strip trailing " Sprite" so cells read "Batman" not "Batman Sprite".
      // opts.familyDisplayNames is a { familyToken: "Real Name Sprite" } map.
      const pakName = opts.familyDisplayNames?.[familyToken];
      const cleanPakName = pakName?.replace(/\s+Sprite$/i, '').trim();
      // Never fall through to the raw `familyToken`. Epic codenames are
      // deliberately misleading (FossilMeal=Batman, PedicureAntacid=Ironmouse),
      // so leaking one is worse than showing nothing. A family we can't yet name
      // (a brand-new drop before the boot pak-scan runs, or a token whose pak
      // match failed) renders a neutral PENDING label + a `labelPending` flag so
      // the self-audit surfaces it and we can add the mapping. This generalizes
      // the one-off Ironmouse fix into a permanent rule for every future collab.
      const resolved = cleanPakName || FAMILY_LABEL[familyToken];
      const g = { familyToken, label: resolved || PENDING_FAMILY_LABEL, variants: {} };
      if (!resolved) g.labelPending = true;
      families.set(familyToken, g);
    }
    families.get(familyToken).variants[tier.key] = variant;
  }

  // Inject pak-datamined variants that aren't in the live catalog yet. Skipped
  // if the family already has that tier from the catalog (Epic shipped it in
  // between pak extraction and this sync — the live entry wins with real
  // owned/xp state). Same-shape entries as the catalog-derived variants so the
  // grid renderer treats them identically; `future: true` triggers the jail-
  // bar overlay + "unreleased" pool inclusion.
  // opts.pakDatamined comes from sprites.js which resolves hasIcon by disk check.
  const dataminedList = opts.pakDatamined || [];
  for (const p of dataminedList) {
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
    // in a vaulted family. For most families this is 4 (Basic/Gummy/Galaxy/Gold,
    // with Gem/Holofoil future-flagged) or 1 (Burnt Peanut, sole variant), and
    // the family-row count should be owned/obtainable rather than owned/total
    // so a player at the practical cap reads "4/4" instead of a misleading "4/6".
    g.obtainableCount = vs.filter((v) => !v.future && !v.vaulted).length;
    g.masteredCount = vs.filter((v) => v.mastered).length;
    // Stamp the resolved family label onto every variant so the UI can build a
    // friendly alt/title ("John Wick Basic") instead of leaking the raw catalog
    // codename ("FillerGruntSprite_Variant_A") while an icon is still loading.
    for (const v of vs) v.familyLabel = g.label;
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
    pityScore: meta.PityScore ?? null,
    epic: epicStats,                              // null if no athena data this sync
    spriteExtras,                                 // null if no sprite quests / cosmetics
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
