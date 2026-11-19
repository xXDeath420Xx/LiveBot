/*
 * Domains that must never be flagged as phishing, and the host normalisation
 * both detectors share.
 *
 * The community feeds (mitchellkrogza/Phishing.Database, nikolaischunk's
 * discord-phishing-links) are bulk lists ~390k entries deep. They are good at
 * the thing they are for and bad at one specific thing: any domain that
 * deliberately *resembles* a big platform's domain looks exactly like a
 * typosquat to an automated lister. That is how `kkinstagram.com` — the embed
 * fixer people use to make an Instagram reel actually play inside Discord —
 * ended up on the list and got members' meme links deleted as phishing.
 *
 * So this list is not "domains we like", it is "domains a bulk lister will get
 * wrong". Two groups:
 *
 *   1. Platforms whose own domain is in the feeds because some subdomain or
 *      path was abused once.
 *   2. Embed fixers — third-party proxies that serve nothing but OpenGraph tags
 *      and a video file so a link unfurls properly in Discord. They never ask
 *      for credentials; resembling the platform's domain is the entire point of
 *      the product.
 *
 * Caveat worth knowing before adding to group 2: a lapsed fixer domain can be
 * re-registered by someone else, and an entry here suppresses detection for
 * every guild. Only list fixers that are actively maintained and widely used,
 * and pull one the moment it goes dark.
 *
 * Pure and DB-free so both the Discord manager and the Kick defender can share
 * one copy instead of maintaining two that drift, and so it is unit-testable.
 *
 * Disputes (core/domain-reports.js): when the bot owner approves a dispute of a
 * blocked domain, the domain goes on the global allow list (link_policy_domains
 * rows with guild_id '0', kind 'allow') and PhishingDetectionManager hands that
 * list to setOverrideSafeDomains() each time it loads the phishing list. From then
 * on it is treated exactly like an entry above, for every guild, until removed.
 */

export const SAFE_DOMAINS = new Set([
    // Discord's own plumbing — flagging these breaks the client itself.
    'discord.com',
    'discordapp.com',
    'cdn.discordapp.com',
    'cdn.discord.com',
    'media.discordapp.net',
    'images-ext-1.discordapp.net',
    'images-ext-2.discordapp.net',
    'discord.gg',
    'discord.media',
    'discordstatus.com',

    // Platforms.
    'twitch.tv',
    'kick.com',
    'youtube.com',
    'youtu.be',
    'twitter.com',
    'x.com',
    'instagram.com',
    'tiktok.com',
    'reddit.com',
    'redd.it',
    'bsky.app',
    'steamcommunity.com',
    'store.steampowered.com',
    'github.com',
    'tenor.com',
    'giphy.com',
    'imgur.com',

    // Embed fixers. Look-alike by design; see the note above.
    'kkinstagram.com',      // Instagram (successor to ddinstagram)
    'ddinstagram.com',      // Instagram (legacy, still linked in old messages)
    'instagramez.com',      // Instagram
    'vxtwitter.com',        // Twitter/X
    'fxtwitter.com',        // Twitter/X
    'fixupx.com',           // Twitter/X
    'fixvx.com',            // Twitter/X
    'vxtiktok.com',         // TikTok
    'tnktok.com',           // TikTok
    'tiktxk.com',           // TikTok
    'rxddit.com',           // Reddit
    'vxreddit.com',         // Reddit
    'fxbsky.app',           // Bluesky
    'bskx.app',             // Bluesky
    'phixiv.net',           // Pixiv
    'fxdeviantart.com',     // DeviantArt
]);

// Global allow-list overrides from approved disputes (see the note at the top).
let overrideSafe = new Set();

/** Replace the dispute overrides (normalised hosts). */
export function setOverrideSafeDomains(list) {
    const next = new Set();
    for (const d of list || []) {
        const h = normalizeHost(d);
        if (h) next.add(h);
    }
    overrideSafe = next;
}

export function overrideSafeDomains() {
    return [...overrideSafe];
}

/**
 * Bare lowercase hostname from a URL, a bare domain, or a host with a port.
 * Returns '' for anything that has no host to speak of.
 */
export function normalizeHost(input) {
    let h = String(input || '').toLowerCase().trim();
    if (!h) return '';
    // Accept a pasted URL. Someone typing an allowlist entry copies the address
    // bar, so "https://www.kkinstagram.com/" has to mean the same thing as
    // "kkinstagram.com" — otherwise the entry silently never matches.
    if (h.includes('://') || h.includes('/') || h.includes('?')) {
        try {
            h = new URL(h.includes('://') ? h : `http://${h}`).hostname;
        } catch {
            h = h.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0];
        }
    }
    h = h.split('@').pop();          // strip any userinfo
    h = h.replace(/:\d+$/, '');      // strip port
    h = h.replace(/\.+$/, '');       // strip the root-zone trailing dot
    if (h.startsWith('www.')) h = h.slice(4);
    return h;
}

/**
 * Is this host on the never-flag list, either exactly or as a subdomain of one?
 *
 * Subdomains count because the fixers use them (`d.ddinstagram.com` serves the
 * video for `ddinstagram.com`), and because a platform's CDN subdomain landing
 * in a feed should not take the platform down with it.
 */
export function isSafeDomain(host) {
    return safeSource(host) !== null;
}

/**
 * Why a host is never flagged: 'builtin' (the list above), 'override' (an approved
 * dispute), or null when it is not.
 */
export function safeSource(host) {
    const h = normalizeHost(host);
    if (!h) return null;
    if (SAFE_DOMAINS.has(h)) return 'builtin';
    if (overrideSafe.has(h)) return 'override';
    const parts = h.split('.');
    // Walk parents: a.b.example.com → b.example.com → example.com. Bounded by
    // label count, so this stays cheap enough to run per row on a 390k-row load.
    for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join('.');
        if (SAFE_DOMAINS.has(parent)) return 'builtin';
        if (overrideSafe.has(parent)) return 'override';
    }
    return null;
}

export default { SAFE_DOMAINS, normalizeHost, isSafeDomain, safeSource, setOverrideSafeDomains, overrideSafeDomains };
