/*
 * Link intelligence — pure checks on the NAME of a link (unit-tested in tests/link-intel.test.js). The live side
 * (core/link-intel.js) adds domain age from RDAP and Discord invite resolution.
 *
 * Nothing here, nor in the live side, ever requests a member's URL. Following redirects was left out of the
 * Kick / Twitch defenders on purpose (server-side request forgery), and that stays true: a link is judged on
 * its host name, the registry's record of that name, and the lists we hold.
 *
 *   punycode      an internationalised host (xn--…, or written in Unicode): decoded, and flagged when the
 *                 decoded name folds to a brand ("dіscord.com" with a Cyrillic і → discord.com).
 *   lookalike     the registrable label within edit distance 1-2 of a brand, or the brand plus lure words
 *                 ("discord-nitro-gift.com", "steamcommunlty.com", "dlscord.gg").
 *   brand in sub  the brand as a subdomain of something else ("discord.com.gift-claim.ru").
 *   shortener     the destination is hidden (bit.ly, …) — the same list core/link-policy.js blocks.
 *   shape         IP-address hosts, userinfo before the host ("https://discord.com@evil.ru"), many labels,
 *                 throwaway TLDs.
 */
import { domainToASCII, domainToUnicode } from 'node:url';
import { foldLeet, skeleton } from '../utils/text-fold.js';
import { registrable, BLOCKED_HOSTS } from './link-policy.js';

// Brand → its real registrable domains. A lookalike is a near-miss of a key that is none of its values.
export const BRANDS = Object.freeze({
    discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discord.new', 'discord.gift', 'discordstatus.com', 'dis.gd', 'discord.co', 'discord.dev'],
    steam: ['steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steam.tv', 'steamchina.com', 'steamdeck.com'],
    steamcommunity: ['steamcommunity.com'],
    steampowered: ['steampowered.com'],
    roblox: ['roblox.com', 'rbxcdn.com'],
    epicgames: ['epicgames.com', 'unrealengine.com', 'fortnite.com'],
    twitch: ['twitch.tv', 'twitchcdn.net', 'twitchsvc.net'],
    paypal: ['paypal.com', 'paypal.me', 'paypalobjects.com'],
    binance: ['binance.com', 'binance.us'],
    coinbase: ['coinbase.com'],
    metamask: ['metamask.io'],
    opensea: ['opensea.io'],
    youtube: ['youtube.com', 'youtu.be', 'ytimg.com'],
    instagram: ['instagram.com'],
    tiktok: ['tiktok.com'],
    minecraft: ['minecraft.net'],
    riotgames: ['riotgames.com', 'leagueoflegends.com', 'playvalorant.com'],
    microsoft: ['microsoft.com', 'live.com', 'xbox.com', 'office.com'],
    google: ['google.com', 'gstatic.com', 'googleusercontent.com'],
    apple: ['apple.com', 'icloud.com'],
});
const BRAND_KEYS = Object.keys(BRANDS);
const ALL_REAL = new Set(Object.values(BRANDS).flat());
const LURE_PARTS = /(?:gift|nitro|free|claim|promo|drop|airdrop|login|verify|verification|secure|support|help|appeal|ticket|account|wallet|bonus|reward|event|giveaway|official|auth)/;

export const SUSPICIOUS_TLDS = Object.freeze(new Set([
    'xyz', 'top', 'click', 'link', 'icu', 'buzz', 'rest', 'gq', 'ml', 'cf', 'ga', 'tk', 'cfd', 'sbs', 'monster', 'quest', 'cyou',
    'lol', 'mom', 'beauty', 'hair', 'skin', 'bond', 'zip', 'mov', 'country', 'kim', 'work', 'support', 'gift',
]));
const SHORTENERS = new Set([...BLOCKED_HOSTS.slice(0, 14), 'tiny.cc', 'shorturl.asia', 'v.gd', 'bit.do', 'clck.ru', 'qr.ae', 'lnkd.in', 'u.to', 'tinyurl.is']);
// IP loggers are not hidden destinations, they ARE the payload.
export const IP_LOGGERS = Object.freeze(new Set(['grabify.link', 'iplogger.org', 'iplogger.com', 'iplogger.ru', '2no.co', 'yip.su', 'blasze.tk', 'ps3cfw.com']));

// Hosts written in any script, optional scheme, optional userinfo. Kept separate from link-policy's
// ASCII-only extractor because an IDN host is exactly the case that one cannot see.
const HOST_RE = /\b(?:(https?):\/\/)?(?:([^\s/@:]{1,64})@)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}[\p{L}\p{N}])?[.。．｡])+(?:xn--[a-z0-9-]{2,59}|\p{L}{2,24}))(?::\d{2,5})?(\/[^\s<>"')\]]*)?/giu;
const IPV4_RE = /\bhttps?:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\b/gi;
// A bare "word.word" without a scheme is only a link when the last label is a real-looking TLD.
const COMMON_TLDS = new Set(['com', 'net', 'org', 'gg', 'io', 'co', 'me', 'tv', 'xyz', 'ru', 'shop', 'store', 'site', 'online', 'app', 'dev', 'link', 'live', 'gift', 'gifts', 'top', 'click', 'info', 'biz', 'us', 'uk', 'de', 'fr', 'cc', 'ly', 'su', 'pro', 'fun', 'icu', 'cfd', 'sbs', 'lol', 'tk', 'ml', 'ga', 'cf', 'gq', 'buzz', 'rest', 'monster', 'quest', 'cyou', 'support', 'zip', 'mov', 'pw', 'ws', 'to', 'gd', 'is', 'at', 'in', 'eu', 'nl', 'pl', 'br', 'es', 'it', 'ca', 'au', 'ee', 'sh', 'vip', 'win', 'bet', 'casino', 'games', 'game', 'tech', 'space', 'website', 'world', 'news', 'club', 'one', 'cloud', 'page', 'art', 'bond', 'work', 'country', 'kim', 'beauty', 'hair', 'skin', 'mom']);

/** Every host in a text: { host (ASCII), unicode, scheme, userinfo, path, raw }. */
export function extractHosts(text) {
    const s = String(text || '').slice(0, 6000);
    const out = [];
    const seen = new Set();
    for (const m of s.matchAll(HOST_RE)) {
        const written = m[3].replace(/[。．｡]/g, '.').toLowerCase();
        const tld = written.slice(written.lastIndexOf('.') + 1);
        // Without a scheme, require a TLD that looks real (IDN TLDs and xn-- always count): "i said no.thats it" is not a link.
        // eslint-disable-next-line no-control-regex
        if (!m[1] && !COMMON_TLDS.has(tld) && !tld.startsWith('xn--') && !/[^\x00-\x7F]/.test(tld)) continue;
        const ascii = domainToASCII(written);
        if (!ascii) continue;
        if (seen.has(ascii)) continue;
        seen.add(ascii);
        const unicode = domainToUnicode(ascii) || written;
        out.push({ host: ascii, unicode, scheme: m[1] || null, userinfo: m[2] || null, path: m[4] || '', raw: m[0] });
    }
    for (const m of s.matchAll(IPV4_RE)) {
        if (!seen.has(m[1])) { seen.add(m[1]); out.push({ host: m[1], unicode: m[1], scheme: 'http', userinfo: null, path: '', raw: m[0], ip: true }); }
    }
    return out.slice(0, 20);
}

/** Damerau-Levenshtein (optimal string alignment), capped: returns max+1 once it is clearly further. */
export function editDistance(a, b, max = 3) {
    a = String(a); b = String(b);
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        let rowMin = Infinity;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
            rowMin = Math.min(rowMin, d[i][j]);
        }
        if (rowMin > max) return max + 1;
    }
    return d[a.length][b.length];
}

export function isRealBrandHost(host) {
    const reg = registrable(String(host || '').toLowerCase());
    return ALL_REAL.has(reg) || ALL_REAL.has(host);
}

/**
 * Which brand a registrable label imitates, or null.
 * @returns {{ brand:string, how:'homoglyph'|'typo'|'brand+lure' }|null}
 */
export function lookalikeBrand(label, { unicodeLabel = null } = {}) {
    const raw = String(label || '').toLowerCase();
    if (!raw || raw.length < 4) return null;
    const plain = raw.replace(/-/g, '');
    if (unicodeLabel && unicodeLabel !== raw) {
        const folded = foldLeet(unicodeLabel).replace(/[^a-z0-9]/g, '');
        for (const b of BRAND_KEYS) if (folded === b || skeleton(folded) === skeleton(b)) return { brand: b, how: 'homoglyph' };
    }
    const parts = raw.split('-').filter(Boolean);
    for (const b of BRAND_KEYS) {
        if (plain === b) return null;                          // the brand's own name on another TLD: link_brand_other_tld
        const sk = skeleton(plain), bk = skeleton(b);
        if (sk === bk) return { brand: b, how: 'homoglyph' };  // dlscord → discord (l ↔ i), rn ↔ m
        if (b.length >= 5 && plain.length >= 5 && editDistance(plain, b, 2) <= (b.length >= 8 ? 2 : 1)) return { brand: b, how: 'typo' };
        if (plain.includes(b) && LURE_PARTS.test(plain.replace(b, ''))) return { brand: b, how: 'brand+lure' };
        if (parts.length > 1 && parts.some(p => p !== b && (skeleton(p) === bk || (b.length >= 5 && p.length >= 5 && editDistance(p, b, 1) <= 1)))
            && parts.some(p => LURE_PARTS.test(p))) return { brand: b, how: 'typo' };
        // Brand typo glued to a lure word without a hyphen: "dlscordgift", "steamcomunitylogin".
        const m = plain.match(LURE_PARTS);
        if (m) {
            const rest = plain.replace(m[0], '');
            if (rest.length >= 5 && rest !== b && (skeleton(rest) === bk || (b.length >= 6 && editDistance(rest, b, 1) <= 1))) return { brand: b, how: 'typo' };
        }
    }
    return null;
}

/**
 * Signals for one extracted host (see extractHosts). Points are on the same scale as
 * core/ai-moderation-logic.js SIGNAL_POINTS.
 * @returns {Array<{ id:string, points:number, category:string, host:string, detail?:string }>}
 */
export function hostSignals(h) {
    const out = [];
    const add = (id, points, category, detail) => out.push({ id, points, category, host: h.host, ...(detail ? { detail } : {}) });
    const host = h.host;
    if (h.ip) { add('link_ip_host', 3, 'malicious_link'); return out; }
    if (h.userinfo) add('link_userinfo', 4, 'malicious_link', h.userinfo.slice(0, 40));
    if (isRealBrandHost(host)) return out;                       // discord.com, steamcommunity.com, …
    const reg = registrable(host);
    const label = reg.split('.')[0];
    const tld = host.slice(host.lastIndexOf('.') + 1);
    const idn = host.split('.').some(p => p.startsWith('xn--'));
    const unicodeLabel = registrable(String(h.unicode || host)).split('.')[0];
    if (IP_LOGGERS.has(reg) || IP_LOGGERS.has(host)) add('link_ip_logger', 8, 'malicious_link');
    else if (SHORTENERS.has(host) || SHORTENERS.has(reg)) add('link_shortener', 2, 'malicious_link');
    const look = lookalikeBrand(label, { unicodeLabel: idn ? unicodeLabel : null });
    if (look) {
        const strong = idn || look.how === 'homoglyph';
        add(strong ? 'link_lookalike_homoglyph' : 'link_lookalike', strong ? 7 : 6, 'malicious_link', `${look.brand} (${look.how})`);
    } else if (idn) add('link_punycode', 3, 'malicious_link', h.unicode);
    if (!look && BRANDS[label]) add('link_brand_other_tld', 5, 'malicious_link', label);
    const subs = host.slice(0, Math.max(0, host.length - reg.length - 1)).split('.').filter(Boolean);
    const brandSub = subs.find(s => BRANDS[s.replace(/-/g, '')] || (BRAND_KEYS.some(b => s.includes(b)) && LURE_PARTS.test(s)));
    if (brandSub && !look) add('link_brand_in_subdomain', 4, 'malicious_link', brandSub);
    if (SUSPICIOUS_TLDS.has(tld)) add('link_suspicious_tld', 2, 'malicious_link', tld);
    if (host.split('.').length >= 5) add('link_many_labels', 1, 'malicious_link');
    return out;
}

/** Signals for every host in a text. */
export function linkSignals(text) {
    const hosts = extractHosts(text);
    return { hosts, signals: hosts.flatMap(hostSignals) };
}

/**
 * The same links read in several forms of one message (as written, leet-folded, stretched letters cut): the
 * reading with the most link points wins, so "5t34mc0mmunlty.c0m" and "discoooord-gift.com" are seen for what they
 * are without one link being counted twice. Hosts are the union, for the list lookups.
 */
export function linkSignalsBest(texts) {
    const reads = [...new Set((texts || []).filter(Boolean))].map(linkSignals);
    if (!reads.length) return { hosts: [], signals: [] };
    const pts = (r) => r.signals.reduce((n, s) => n + s.points, 0);
    const best = reads.reduce((a, b) => (pts(b) > pts(a) ? b : a));
    const hosts = [];
    const seen = new Set();
    for (const r of [best, ...reads]) for (const h of r.hosts) if (!seen.has(h.host)) { seen.add(h.host); hosts.push(h); }
    return { hosts: hosts.slice(0, 20), signals: best.signals };
}

/** Points for a domain registered `days` ago (null = unknown, nothing). */
export function domainAgeSignal(host, days) {
    if (days == null || !Number.isFinite(days) || days < 0) return null;
    if (days < 7) return { id: 'link_new_domain_week', points: 6, category: 'malicious_link', host, detail: `${Math.floor(days)} days old` };
    if (days < 30) return { id: 'link_new_domain_month', points: 4, category: 'malicious_link', host, detail: `${Math.floor(days)} days old` };
    return null;
}

// ── Discord invites ──────────────────────────────────────────────────────────

const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.me|dsc\.gg|invite\.gg)\/([a-z0-9-]{2,32})/gi;

export function extractInviteCodes(text) {
    const out = new Set();
    for (const m of String(text || '').matchAll(INVITE_RE)) out.add(m[1]);
    return [...out].slice(0, 5);
}

// Server names fake-support and free-Nitro invites use.
const INVITE_NAME_LURE = /\b(?:discord\s*(?:support|staff|team|help|appeals?|moderation|security|trust)|nitro|free\s*(?:nitro|gift|robux)|steam\s*(?:support|gift)|giveaway|airdrop|crypto\s*(?:signals|pump)|nsfw|18\+|onlyfans|leaks?|e-?girls?)\b/i;

/**
 * Signals from a resolved invite ({ guildId, name, createdDays? } or null when it did not resolve).
 * @param {Set<string>} blocked  guild ids confirmed as scam servers (signatures)
 */
const INVITE_CODE_LURE = /(cam|g[i1]rl|nsfw|onlyfans|porn|nude|leak|18plus|sexy|hentai)/i;
const INVITE_CODE_SCAM = /(nitro|gift|free|support|appeal|airdrop|giveaway|claim|crypto)/i;

export function inviteSignals(code, info, blocked = new Set()) {
    const out = [];
    // The vanity code is chosen by the inviter ("discord.gg/camgirls", "discord.gg/nitro-gift").
    if (INVITE_CODE_LURE.test(String(code))) out.push({ id: 'invite_lure_code', points: 3, category: 'sexual', detail: code });
    else if (INVITE_CODE_SCAM.test(String(code))) out.push({ id: 'invite_lure_code', points: 3, category: 'scam', detail: code });
    if (!info) { out.push({ id: 'invite_unresolved', points: 1, category: 'spam_bot', detail: code }); return out; }
    if (blocked.has(String(info.guildId))) out.push({ id: 'signature_invite', points: 8, category: 'scam', detail: info.name });
    if (INVITE_NAME_LURE.test(foldLeet(String(info.name || '')))) out.push({ id: 'invite_lure_name', points: 4, category: 'scam', detail: info.name });
    if (info.createdDays != null && info.createdDays < 7) out.push({ id: 'invite_new_server', points: 2, category: 'scam', detail: `${Math.floor(info.createdDays)} days old` });
    return out;
}

export default {
    BRANDS, SUSPICIOUS_TLDS, IP_LOGGERS, extractHosts, editDistance, isRealBrandHost, lookalikeBrand, hostSignals, linkSignals, linkSignalsBest,
    domainAgeSignal, extractInviteCodes, inviteSignals,
};
