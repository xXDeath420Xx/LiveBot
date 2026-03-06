/**
 * Stream URL Parser
 * Extracts {platform, username, url} from messy message content.
 */

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

// Non-user paths to ignore
const BLOCKED_PATHS = new Set([
    'directory', 'watch', 'explore', 'videos', 'clips', 'about',
    'schedule', 'search', 'settings', 'following', 'followers',
    'subscriptions', 'feed', 'trending', 'gaming', 'live', 'results',
    'playlist', 'shorts', 'premium', 'categories', 'browse'
]);

const PLATFORM_PATTERNS = [
    {
        platform: 'twitch',
        regex: /(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]{2,25})(?:\/|$|\?)/,
    },
    {
        platform: 'kick',
        regex: /(?:www\.)?kick\.com\/([a-zA-Z0-9_-]+)(?:\/|$|\?)/,
    },
    {
        platform: 'youtube',
        // @handle format
        regex: /(?:www\.)?youtube\.com\/@([a-zA-Z0-9_.-]+)(?:\/|$|\?)/,
    },
    {
        platform: 'youtube',
        // /channel/ID format
        regex: /(?:www\.)?youtube\.com\/channel\/([a-zA-Z0-9_-]+)(?:\/|$|\?)/,
    },
    {
        platform: 'tiktok',
        regex: /(?:www\.)?tiktok\.com\/@([a-zA-Z0-9_.]+)(?:\/|$|\?)/,
    },
    {
        platform: 'trovo',
        regex: /(?:www\.)?trovo\.live\/s\/([a-zA-Z0-9_]+)(?:\/|$|\?)/,
    },
    {
        platform: 'facebook',
        regex: /(?:www\.)?facebook\.com\/gaming\/([a-zA-Z0-9_.]+)(?:\/|$|\?)/,
    },
    {
        platform: 'instagram',
        regex: /(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]+)(?:\/|$|\?)/,
    },
];

/**
 * Parse a message for a streaming platform URL.
 * @param {string} content - The message content
 * @returns {{ platform: string, username: string, url: string } | null}
 */
export function parseStreamUrl(content) {
    if (!content || typeof content !== 'string') return null;

    const urls = content.match(URL_REGEX);
    if (!urls) return null;

    for (const url of urls) {
        // Skip youtu.be short links (video links, can't derive channel)
        if (/youtu\.be\//i.test(url)) continue;

        for (const { platform, regex } of PLATFORM_PATTERNS) {
            const match = url.match(regex);
            if (!match) continue;

            const username = match[1];

            // Skip blocked paths
            if (BLOCKED_PATHS.has(username.toLowerCase())) continue;

            return { platform, username, url };
        }
    }

    return null;
}
