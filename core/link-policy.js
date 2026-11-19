/*
 * Link policy — default-deny URL classification.
 *
 * The rule is "if it is not a social platform and we have not explicitly allowed it, block it",
 * with a middle tier for links that look fine but might not be, which go to a verification channel
 * for an admin instead of being guessed at.
 *
 * Three verdicts, and the middle one is the important one:
 *
 *   allow   — a known social/streaming platform, a guild's own allowlist, or plumbing (Discord's
 *             own CDN) that would break the client if it were filtered.
 *   review  — plausible but unverifiable from the domain alone. Posted to the verification channel;
 *             the message stays up until someone rules. Approving adds the domain to the guild
 *             allowlist, so the same link is never asked about twice.
 *   block   — known-bad shapes (link shorteners hiding their destination, commission marketplaces)
 *             and, per the policy, anything unrecognised.
 *
 * NOT handled here: Discord invites. events/inviteLinkFilter.js already owns those with its own
 * per-guild config and user/role/channel whitelist; duplicating it would mean two systems deleting
 * the same message for different reasons and disagreeing about who is exempt.
 *
 * Pure and DB-free so it can be unit-tested and reused, matching commission-spam-match.js.
 */

// ── extraction ───────────────────────────────────────────────────────────────
// Deliberately generous about obfuscation. Someone routing around the filter with "example [dot] com"
// is telling you they know it would be blocked, so the evasion itself is the signal.
const OBFUSCATION = [
  [/\bh(?:xx|tt)ps?\s*:\s*\/\//gi, 'http://'],
  [/\s*\[\s*(?:dot|\.)\s*\]\s*/gi, '.'],
  [/\s*\(\s*(?:dot|\.)\s*\)\s*/gi, '.'],
  [/\s+dot\s+/gi, '.'],
  [/\s*\[\s*(?:at|@)\s*\]\s*/gi, '@'],
];

const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(\/[^\s<>"')\]]*)?/gi;

// A trailing label only counts as a TLD if it plausibly is one — otherwise "i said no.thats it"
// parses as the domain "no.thats".
//
// Every real two-letter TLD is a ccTLD, so any two-letter alphabetic label is accepted rather than
// enumerated. Enumerating them is how `linktr.ee`, `is.gd` and `redd.it` became INVISIBLE to the
// filter — and an unrecognised link that cannot be seen is not blocked, it is silently allowed.
// A default-deny filter that fails open on unusual TLDs is worse than no filter, because it looks
// like it is working.
const LONG_TLD = new Set([
  'com', 'net', 'org', 'int', 'gov', 'edu', 'mil', 'info', 'biz', 'pro', 'name', 'mobi',
  'xyz', 'top', 'club', 'fun', 'site', 'online', 'store', 'shop', 'live', 'link', 'page',
  'app', 'dev', 'art', 'blog', 'cloud', 'space', 'website', 'tech', 'social', 'media', 'news',
  'video', 'watch', 'stream', 'studio', 'design', 'agency', 'digital', 'network', 'group',
  'world', 'life', 'today', 'zone', 'wiki', 'gallery', 'graphics', 'pics', 'photo', 'photos',
  'games', 'game', 'gg', 'lol', 'wtf', 'ninja', 'guru', 'rocks', 'cool', 'help', 'support',
  'services', 'solutions', 'company', 'center', 'email', 'chat', 'community', 'team', 'fans',
  'shopping', 'market', 'sale', 'deals', 'gift', 'gifts', 'money', 'cash', 'bet', 'casino',
]);

function isTld(label) {
  if (!/^[a-z]+$/.test(label)) return false;          // numeric or mixed — not a TLD ("v1.2")
  if (label.length === 2) return true;                // every 2-letter TLD is a ccTLD
  return LONG_TLD.has(label);
}

/** Every hostname referenced in a message, normalised and de-duplicated. */
export function extractLinks(content) {
  let s = String(content || '');
  for (const [re, rep] of OBFUSCATION) s = s.replace(re, rep);

  const out = [];
  const seen = new Set();
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s)) !== null) {
    const host = m[1].toLowerCase();
    if (!isTld(host.slice(host.lastIndexOf('.') + 1))) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    out.push({ host, path: m[2] || '', raw: m[0] });
  }
  return out;
}

/** example.co.uk -> example.co.uk ; www.foo.twitch.tv -> twitch.tv (for allowlist matching) */
export function registrable(host) {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const twoLevel = ['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'org.uk', 'ac.uk'];
  const last2 = parts.slice(-2).join('.');
  if (twoLevel.includes(last2)) return parts.slice(-3).join('.');
  return last2;
}

// ── the lists ────────────────────────────────────────────────────────────────
// Social and streaming platforms: the "allowable links to legitimate platforms" of the policy.
export const SOCIAL_PLATFORMS = Object.freeze([
  'twitch.tv', 'youtube.com', 'youtu.be', 'tiktok.com', 'twitter.com', 'x.com', 'instagram.com',
  'facebook.com', 'fb.watch', 'bsky.app', 'kick.com', 'reddit.com', 'redd.it', 'threads.net',
  'snapchat.com', 'tumblr.com', 'mastodon.social', 'rumble.com', 'dlive.tv',
  'twitcasting.tv', 'vk.com', 'linkedin.com', 'pinterest.com',
]);

// Discord's own plumbing plus the media hosts chat is built on. Filtering these does not stop
// advertising, it stops people posting GIFs and screenshots at each other.
export const MEDIA_HOSTS = Object.freeze([
  'cdn.discordapp.com', 'media.discordapp.net', 'discordapp.com', 'discord.com',
  'tenor.com', 'giphy.com', 'gph.is', 'imgur.com', 'i.imgur.com',
  'spotify.com', 'open.spotify.com', 'music.apple.com', 'soundcloud.com', 'bandcamp.com',
]);

// Legitimate for some servers, self-promotion in others — and the bot already integrates several
// of these for supporter roles, so blocking outright would break paid features.
export const MONETISATION_HOSTS = Object.freeze([
  'ko-fi.com', 'patreon.com', 'buymeacoffee.com', 'throne.com', 'throne.me',
  'fourthwall.com', 'streamlabs.com', 'streamelements.com', 'donationalerts.com',
]);

// Blocked outright: the destination is hidden, or the site exists to sell commissioned work.
export const BLOCKED_HOSTS = Object.freeze([
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly', 'cutt.ly',
  'rb.gy', 'shorturl.at', 'rebrand.ly', 'adf.ly', 'shorte.st', 'linkvertise.com',
  'fiverr.com', 'vgen.co', 'upwork.com', 'freelancer.com', 'peopleperhour.com', 'etsy.com',
  'gumroad.com', 'payhip.com', 'sellfy.com', 'carrd.co', 'linktr.ee', 'beacons.ai', 'allmylinks.com',
]);

const set = arr => new Set(arr);
const SOCIAL = set(SOCIAL_PLATFORMS);
const MEDIA = set(MEDIA_HOSTS);
const MONEY = set(MONETISATION_HOSTS);
const BLOCKED = set(BLOCKED_HOSTS);

/**
 * Classify one hostname.
 *
 * @param {string} host
 * @param {object} [opts]
 * @param {string[]} [opts.allow]   guild's own allowlist (registrable domains)
 * @param {string[]} [opts.deny]    guild's own blocklist, checked first so a guild can ban a
 *                                  platform the defaults allow
 * @param {'allow'|'review'|'block'} [opts.monetisation] how to treat Ko-fi/Patreon/Throne
 * @param {'review'|'block'} [opts.unknown] what to do with an unrecognised domain
 * @returns {{host:string, domain:string, category:string, verdict:'allow'|'review'|'block'}}
 */
export function classifyHost(host, opts = {}) {
  const { allow = [], deny = [], monetisation = 'review', unknown = 'review' } = opts;
  const h = String(host || '').toLowerCase();
  const domain = registrable(h);
  const hit = (category, verdict) => ({ host: h, domain, category, verdict });

  const inList = (list) => list.includes(h) || list.includes(domain);

  // A guild's explicit choices outrank every built-in list, in both directions.
  if (inList(deny.map(d => d.toLowerCase()))) return hit('guild-denied', 'block');
  if (inList(allow.map(d => d.toLowerCase()))) return hit('guild-allowed', 'allow');

  if (MEDIA.has(h) || MEDIA.has(domain)) return hit('media', 'allow');
  if (SOCIAL.has(h) || SOCIAL.has(domain)) return hit('social', 'allow');
  if (BLOCKED.has(h) || BLOCKED.has(domain)) return hit('blocked-host', 'block');
  if (MONEY.has(h) || MONEY.has(domain)) return hit('monetisation', monetisation);

  return hit('unknown', unknown);
}

/**
 * Verdict for a whole message: the strictest verdict among its links wins, because one blocked link
 * is enough to make the message unpostable.
 *
 * @returns {{verdict:'allow'|'review'|'block', links:object[], worst:object|null}}
 */
export function classifyMessage(content, opts = {}) {
  const links = extractLinks(content).map(l => ({ ...l, ...classifyHost(l.host, opts) }));
  if (!links.length) return { verdict: 'allow', links: [], worst: null };

  const rank = { allow: 0, review: 1, block: 2 };
  let worst = links[0];
  for (const l of links) if (rank[l.verdict] > rank[worst.verdict]) worst = l;
  return { verdict: worst.verdict, links, worst };
}



// ── who is the link about ────────────────────────────────────────────────────
/*
 * A self-promo channel exists for people posting THEIR OWN stream. Someone saying "go watch
 * twitch.tv/somebody, they're amazing" is doing something legitimate and should not be blocked —
 * but auto-tracking that channel against the poster's Discord account would be wrong: it is not
 * their channel, and the go-live announcements would fire for the wrong person and link the wrong
 * Discord identity.
 *
 * self-promo-handler already has looksLikeOwnedChannel(), which compares the platform username to
 * the poster's Discord name. That catches the common case but is only a name-similarity heuristic;
 * it says nothing about a message that explicitly frames the link as someone else's. This is the
 * linguistic half, and it takes priority — an explicit "go follow them" outranks any coincidental
 * name match.
 */
const THIRD_PARTY = [
  /\b(?:go|please|pls|plz|everyone|yall|y'all)\s+(?:go\s+)?(?:watch|follow|sub|subscribe|support|check)\b/,
  /\bcheck\s+(?:out|this|him|her|them)\b/,
  /\b(?:support|follow|watch)\s+(?:him|her|them|this\s+(?:guy|girl|person|streamer|creator))\b/,
  /\b(?:he|she|they)(?:'s|s| is| are|'re)\s+(?:live|streaming|going live)\b/,
  /\bmy\s+(?:friend|buddy|mate|bro|sis|homie|partner)\b/,
  /\bshout\s?out\s+to\b/,
  /\bthis\s+(?:guy|girl|person|streamer|creator|dude)\b/,
  /\b(?:showing|sharing)\s+(?:some\s+)?(?:love|support)\b/,
];

const FIRST_PERSON = [
  /\bmy\s+(?:stream|channel|twitch|youtube|kick|tiktok|page|link)\b/,
  /\bi(?:'m| am|m)\s+(?:live|streaming|going live|now live)\b/,
  /\bcome\s+(?:watch|hang|join)\s+(?:me|my)\b/,
  /\bi(?:'ll| will)\s+be\s+(?:live|streaming)\b/,
  /\bfollow\s+me\b/,
];

/**
 * Whose channel is this message promoting?
 *
 * @returns {'third-party'|'self'|'unknown'} 'unknown' when the message is just a bare link, which
 *          is the normal self-promo shape and is left to the existing name-similarity gate.
 */
export function promotionSubject(content) {
  const s = String(content || '').toLowerCase();
  if (!s) return 'unknown';
  // Third-party framing wins: the cost of wrongly auto-tracking someone else's channel is higher
  // than the cost of making a genuine owner ask a mod to link them.
  if (THIRD_PARTY.some(re => re.test(s))) return 'third-party';
  if (FIRST_PERSON.some(re => re.test(s))) return 'self';
  return 'unknown';
}

export default {
  extractLinks, registrable, classifyHost, classifyMessage, promotionSubject,
  SOCIAL_PLATFORMS, MEDIA_HOSTS, MONETISATION_HOSTS, BLOCKED_HOSTS,
};
