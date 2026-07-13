/*
 * A canonical identity for a free game, derived from its STORE URL.
 *
 * We need to answer one question — "has this guild already been told about this game?" — across two
 * sources that agree on almost nothing:
 *
 *   our scraper       external_id = `epic_9bf3d3188d1e498095bc23c0955538d9`  (Epic's internal GUID)
 *   FreeStuff's post  a link to   `store.epicgames.com/en-US/p/river-city-girls-2-77af3a`
 *
 * The GUID and the slug never match, and titles are hopeless (punctuation, ™, edition suffixes,
 * "Free to keep" chatter). The one thing BOTH sides always carry is the store URL, so that is the
 * key. `epic:river-city-girls-2-77af3a` means the same game no matter who announced it.
 *
 * Returns null for anything we cannot identify confidently. A null key must NEVER be treated as a
 * match — it means "unknown", and unknown must fall through to "not yet announced" rather than
 * silently suppressing a real game.
 */

const PATTERNS = [
  // Steam: the appid is stable and canonical.
  [/store\.steampowered\.com\/app\/(\d+)/i, 'steam'],
  // FreeStuff's own "open in client" deep link carries the same appid.
  [/freestuffbot\.xyz\/ext\/open-client\/steam\/(\d+)/i, 'steam'],
  [/steam:\/\/.*\/(\d+)/i, 'steam'],

  // Epic: locale segment is optional and varies (/p/, /en-US/p/), so it is skipped.
  [/store\.epicgames\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?p\/([a-z0-9-]+)/i, 'epic'],
  [/epicgames\.com\/[a-z-]*\/?p\/([a-z0-9-]+)/i, 'epic'],

  [/gog\.com\/(?:[a-z]{2}\/)?game\/([a-z0-9_]+)/i, 'gog'],

  // Prime shows up as either gaming.amazon.com or the Luna claim URL.
  [/gaming\.amazon\.com\/([a-z0-9-]+)/i, 'prime'],
  [/luna\.amazon\.com\/claims\/([a-z0-9-]+)/i, 'prime'],
];

/** `<store>:<id>` for a single URL, or null if it is not a store URL we understand. */
export function gameKey(url) {
  if (!url || typeof url !== 'string') return null;
  for (const [re, store] of PATTERNS) {
    const m = url.match(re);
    if (m?.[1]) return `${store}:${m[1].toLowerCase()}`;
  }
  return null;
}

/**
 * Every game key mentioned anywhere in a blob of text — a whole Discord message, embeds and
 * Components V2 text included. One FreeStuff message routinely announces several games at once.
 */
export function gameKeysIn(text) {
  const keys = new Set();
  if (!text) return keys;
  for (const url of String(text).match(/https?:\/\/[^\s)>\]]+/gi) ?? []) {
    const k = gameKey(url);
    if (k) keys.add(k);
  }
  // Bare "steam://" deep links are not http(s), so they are matched separately.
  for (const m of String(text).matchAll(/store\.steampowered\.com\/app\/(\d+)/gi)) {
    keys.add(`steam:${m[1]}`);
  }
  return keys;
}

export default { gameKey, gameKeysIn };
