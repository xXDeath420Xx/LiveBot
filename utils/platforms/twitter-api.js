import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import logger from '../logger.js';

// List of RSS sources to try (rotates through on failure)
// NOTE: Free Twitter scraping is unreliable due to Twitter/X's anti-scraping measures
// Most Nitter/RssBridge instances are blocked or rate-limited
// If reliable Twitter feeds are needed, consider adding RapidAPI integration
const RSS_SOURCES = [
    // Nitter instances (try various ones)
    { type: 'nitter', url: 'https://nitter.poast.org/{username}/rss' },
    { type: 'nitter', url: 'https://nitter.privacydev.net/{username}/rss' },
    { type: 'nitter', url: 'https://nitter.net/{username}/rss' },
    { type: 'nitter', url: 'https://nitter.cz/{username}/rss' },
    { type: 'nitter', url: 'https://nitter.woodland.cafe/{username}/rss' }
];

// Track which instances are working
const instanceHealth = new Map();
const INSTANCE_COOLDOWN = 10 * 60 * 1000; // 10 minute cooldown for failed instances

// Cache for user data
const userCache = new Map();
const CACHE_DURATION = 2 * 60 * 1000; // 2 minute cache

/**
 * Mark a source as failed
 */
function markSourceFailed(sourceUrl) {
    instanceHealth.set(sourceUrl, { failedAt: Date.now() });
    logger.debug(`[Twitter API] Marked source as failed: ${sourceUrl.substring(0, 50)}...`);
}

/**
 * Mark a source as working
 */
function markSourceWorking(sourceUrl) {
    instanceHealth.delete(sourceUrl);
}

/**
 * Check if a source is on cooldown
 */
function isSourceOnCooldown(sourceUrl) {
    const health = instanceHealth.get(sourceUrl);
    return health && health.failedAt + INSTANCE_COOLDOWN > Date.now();
}

/**
 * Fetch tweets via RSS sources (Nitter/RssBridge)
 */
async function fetchViaRSS(username, count = 10) {
    const errors = [];

    for (const source of RSS_SOURCES) {
        const feedUrl = source.url.replace('{username}', username);

        if (isSourceOnCooldown(feedUrl)) {
            continue; // Skip recently failed sources
        }

        try {
            logger.info(`[Twitter API] Trying ${source.type}: ${feedUrl.substring(0, 60)}...`);

            const response = await axios.get(feedUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
                },
                timeout: 15000,
                maxRedirects: 3
            });

            const parser = new XMLParser({ ignoreAttributes: false });
            const result = parser.parse(response.data);

            // Handle different RSS structures
            let items = null;
            if (result.rss?.channel?.item) {
                items = result.rss.channel.item;
            } else if (result.feed?.entry) {
                items = result.feed.entry;
            }

            if (!items) {
                throw new Error('No items in feed');
            }

            items = Array.isArray(items) ? items : [items];

            if (items.length === 0) {
                throw new Error('Empty feed');
            }

            markSourceWorking(feedUrl);
            logger.info(`[Twitter API] Success from ${source.type} - found ${items.length} items`);

            return items.slice(0, count).map(item => parseRSSItem(item, username, source.type));

        } catch (error) {
            markSourceFailed(feedUrl);
            errors.push(`${source.type}: ${error.message}`);
        }
    }

    logger.warn(`[Twitter API] All RSS sources failed for ${username}`);
    return null;
}

/**
 * Parse an RSS item into a standardized tweet object
 */
function parseRSSItem(item, username, sourceType) {
    // Handle different RSS formats
    const title = item.title?.['#text'] || item.title || '';
    const description = item.description?.['#text'] || item.description || item.content?.['#text'] || item.content || '';
    const link = item.link?.['@_href'] || item.link || item.guid?.['#text'] || item.guid || '';
    const pubDate = item.pubDate || item.published || item.updated || '';

    // Extract tweet ID from URL
    const id = extractTweetId(link);

    // Clean and combine text
    let text = description || title;
    text = cleanTweetText(text);

    // Detect if it's a retweet or reply
    const isRetweet = title.startsWith('RT by') ||
                       text.startsWith('RT @') ||
                       text.includes('RT @');
    const isReply = text.startsWith('@') && !isRetweet;

    return {
        id: id,
        text: text,
        author: {
            username: username,
            name: username,
            avatar: null
        },
        created_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        url: link.includes('twitter.com') || link.includes('x.com')
            ? link
            : `https://twitter.com/${username}/status/${id}`,
        media: extractMediaFromHtml(description),
        is_retweet: isRetweet,
        is_reply: isReply,
        metrics: {
            likes: 0,
            retweets: 0,
            replies: 0
        },
        source: sourceType
    };
}

/**
 * Fetch user info via FxTwitter API
 */
async function fetchViaFxTwitter(username) {
    try {
        const url = `https://api.fxtwitter.com/${username}`;
        logger.info(`[Twitter API] Trying FxTwitter: ${url}`);

        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });

        if (response.data?.code === 200 && response.data?.user) {
            const user = response.data.user;
            return {
                user: {
                    username: user.screen_name || username,
                    name: user.name || username,
                    avatar: user.avatar_url || null,
                    followers: user.followers || 0,
                    following: user.following || 0
                }
            };
        }

        return null;
    } catch (error) {
        logger.warn(`[Twitter API] FxTwitter failed for ${username}:`, error.message);
        return null;
    }
}

/**
 * Get tweet details via FxTwitter (for individual tweets)
 */
async function getTweetDetails(tweetUrl) {
    try {
        const match = tweetUrl.match(/(?:twitter|x)\.com\/(\w+)\/status\/(\d+)/);
        if (!match) return null;

        const [, username, tweetId] = match;
        const url = `https://api.fxtwitter.com/${username}/status/${tweetId}`;

        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });

        if (response.data?.code === 200 && response.data?.tweet) {
            const tweet = response.data.tweet;
            return {
                id: tweet.id,
                text: tweet.text,
                author: {
                    username: tweet.author?.screen_name,
                    name: tweet.author?.name,
                    avatar: tweet.author?.avatar_url
                },
                created_at: tweet.created_at,
                url: tweet.url,
                media: tweet.media?.all?.map(m => ({
                    type: m.type,
                    url: m.url,
                    thumbnail: m.thumbnail_url
                })) || [],
                metrics: {
                    likes: tweet.likes || 0,
                    retweets: tweet.retweets || 0,
                    replies: tweet.replies || 0
                },
                source: 'fxtwitter'
            };
        }

        return null;
    } catch (error) {
        logger.warn(`[Twitter API] FxTwitter tweet fetch failed:`, error.message);
        return null;
    }
}

/**
 * Get user's recent tweets - tries multiple sources
 */
async function getUserTweets(username, count = 10) {
    username = username.replace(/^@/, '').toLowerCase();

    // Check cache
    const cached = userCache.get(`tweets:${username}`);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        logger.info(`[Twitter API] Using cached tweets for ${username}`);
        return cached.data;
    }

    // Try RSS sources
    const tweets = await fetchViaRSS(username, count);
    if (tweets && tweets.length > 0) {
        userCache.set(`tweets:${username}`, { data: tweets, timestamp: Date.now() });
        return tweets;
    }

    logger.warn(`[Twitter API] Could not fetch tweets for ${username}`);
    return [];
}

/**
 * Validate that a Twitter user exists
 */
async function validateUser(username) {
    username = username.replace(/^@/, '').toLowerCase();

    // Try FxTwitter first (fastest for validation)
    const fxData = await fetchViaFxTwitter(username);
    if (fxData?.user) {
        return {
            valid: true,
            username: fxData.user.username,
            name: fxData.user.name,
            avatar: fxData.user.avatar,
            source: 'fxtwitter'
        };
    }

    // Try RSS sources
    const tweets = await fetchViaRSS(username, 1);
    if (tweets && tweets.length > 0) {
        return {
            valid: true,
            username: username,
            source: 'rss'
        };
    }

    return { valid: false };
}

/**
 * Get user profile information
 */
async function getUserProfile(username) {
    username = username.replace(/^@/, '').toLowerCase();

    // Try FxTwitter for profile (has avatar)
    const fxData = await fetchViaFxTwitter(username);
    if (fxData?.user) {
        return fxData.user;
    }

    // Fallback to basic info
    const tweets = await fetchViaRSS(username, 1);
    if (tweets && tweets.length > 0) {
        return {
            username: username,
            name: tweets[0].author?.name || username,
            avatar: null
        };
    }

    return null;
}

// Helper functions

function extractTweetId(url) {
    if (!url) return null;
    const match = url.match(/status\/(\d+)/);
    return match ? match[1] : url;
}

function cleanTweetText(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '$2')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function extractMediaFromHtml(html) {
    if (!html) return [];
    const media = [];

    // Extract images
    const imgMatches = html.matchAll(/<img[^>]*src="([^"]*)"[^>]*>/gi);
    for (const match of imgMatches) {
        const url = match[1];
        if (url && !url.includes('emoji') && !url.includes('avatar') && !url.includes('icon')) {
            media.push({
                type: 'image',
                url: url
            });
        }
    }

    // Extract video thumbnails
    const videoMatches = html.matchAll(/href="([^"]*\/video\/[^"]*)"/gi);
    for (const match of videoMatches) {
        media.push({
            type: 'video',
            url: match[1]
        });
    }

    // Extract enclosure (media RSS)
    const enclosureMatches = html.matchAll(/<enclosure[^>]*url="([^"]*)"[^>]*type="image[^"]*"/gi);
    for (const match of enclosureMatches) {
        media.push({
            type: 'image',
            url: match[1]
        });
    }

    return media;
}

export {
    getUserTweets,
    getUserProfile,
    validateUser,
    getTweetDetails
};
