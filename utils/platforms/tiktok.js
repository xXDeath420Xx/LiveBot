import logger from '../logger.js';
import { WebcastPushConnection } from 'tiktok-live-connector';
import axios from 'axios';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

// Cache for live status to avoid excessive API calls
const liveStatusCache = new Map();
const CACHE_DURATION = 60 * 1000; // 1 minute

// Cache for access tokens (official API)
let accessTokenCache = {
    token: null,
    expiresAt: 0
};

// Cache for user profile data (to get secUid)
const userProfileCache = new Map();
const PROFILE_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

/**
 * Get TikTok API access token (official API)
 */
async function getAccessToken() {
    // Return cached token if still valid
    if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt) {
        return accessTokenCache.token;
    }

    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;

    if (!clientKey || !clientSecret) {
        logger.warn('[TikTok API] No TikTok API credentials configured');
        return null;
    }

    try {
        const response = await axios.post('https://open.tiktokapis.com/v2/oauth/token/',
            `client_key=${clientKey}&client_secret=${clientSecret}&grant_type=client_credentials`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        if (response.data.access_token) {
            accessTokenCache = {
                token: response.data.access_token,
                expiresAt: Date.now() + (response.data.expires_in * 1000) - 60000 // Refresh 1 min early
            };
            logger.info('[TikTok API] Access token obtained successfully');
            return accessTokenCache.token;
        }
    } catch (error) {
        logger.error('[TikTok API] Failed to get access token:', { error: error.message });
    }

    return null;
}

/**
 * Check if a TikTok user is currently live streaming
 */
async function isStreamerLive(username) {
    try {
        // Check cache first
        const cached = liveStatusCache.get(username);
        if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
            return cached.isLive;
        }

        logger.info(`[TikTok API] Checking if ${username} is live`);

        // Try to get room info
        const tiktokLiveConnection = new WebcastPushConnection(username);

        try {
            // getRoomInfo will throw if user is not live or doesn't exist
            const roomInfo = await tiktokLiveConnection.getRoomInfo();
            const isLive = roomInfo && roomInfo.status === 2; // Status 2 = Live

            // Cache the result
            liveStatusCache.set(username, {
                isLive,
                timestamp: Date.now()
            });

            logger.info(`[TikTok API] ${username} live status: ${isLive}`);
            return isLive;
        } catch (error) {
            // User is not live or doesn't exist
            liveStatusCache.set(username, {
                isLive: false,
                timestamp: Date.now()
            });
            return false;
        }
    } catch (error) {
        logger.error(`[TikTok API] Error checking live status for ${username}:`, {
            error: error.message,
            stack: error.stack
        });
        return false;
    }
}

/**
 * Get TikTok live stream details
 */
async function getStreamDetails(username) {
    try {
        logger.info(`[TikTok API] Fetching stream details for ${username}`);

        const tiktokLiveConnection = new WebcastPushConnection(username);
        const roomInfo = await tiktokLiveConnection.getRoomInfo();

        if (!roomInfo || roomInfo.status !== 2) {
            return null;
        }

        return {
            title: roomInfo.title || `${username} is live on TikTok!`,
            viewer_count: roomInfo.user_count || 0,
            thumbnail: roomInfo.cover?.url_list?.[0] || null,
            started_at: roomInfo.create_time ? new Date(roomInfo.create_time * 1000).toISOString() : new Date().toISOString(),
            stream_url: `https://www.tiktok.com/@${username}/live`
        };
    } catch (error) {
        logger.error(`[TikTok API] Failed to get stream details for ${username}:`, {
            error: error.message
        });
        return null;
    }
}

/**
 * Get user profile data from TikTok profile page
 */
async function getUserProfile(username) {
    // Check cache first
    const cached = userProfileCache.get(username.toLowerCase());
    if (cached && (Date.now() - cached.timestamp) < PROFILE_CACHE_DURATION) {
        return cached.data;
    }

    try {
        logger.info(`[TikTok API] Fetching profile page for ${username}`);

        const response = await axios.get(`https://www.tiktok.com/@${username}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 15000
        });

        // Extract JSON data from the page
        const match = response.data.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/);
        if (!match) {
            logger.warn(`[TikTok API] Could not find rehydration data for ${username}`);
            return null;
        }

        const json = JSON.parse(match[1]);
        const userDetail = json.__DEFAULT_SCOPE__?.['webapp.user-detail'];

        if (!userDetail?.userInfo?.user) {
            logger.warn(`[TikTok API] Could not find user info for ${username}`);
            return null;
        }

        const profileData = {
            id: userDetail.userInfo.user.id,
            uniqueId: userDetail.userInfo.user.uniqueId,
            secUid: userDetail.userInfo.user.secUid,
            nickname: userDetail.userInfo.user.nickname,
            avatarUrl: userDetail.userInfo.user.avatarMedium || userDetail.userInfo.user.avatarThumb,
            videoCount: userDetail.userInfo.stats?.videoCount || 0,
            followerCount: userDetail.userInfo.stats?.followerCount || 0,
            // Videos from initial page load (if available)
            initialVideos: userDetail.itemList || []
        };

        // Cache the result
        userProfileCache.set(username.toLowerCase(), {
            data: profileData,
            timestamp: Date.now()
        });

        logger.info(`[TikTok API] Got profile for ${username}: ${profileData.videoCount} videos`);
        return profileData;
    } catch (error) {
        logger.error(`[TikTok API] Failed to get profile for ${username}:`, {
            error: error.message
        });
        return null;
    }
}

// TikWM rate limit cache (1 request per second)
const tikwmCache = new Map();
const TIKWM_CACHE_DURATION = 5 * 60 * 1000; // Cache results for 5 minutes
let lastTikWMRequest = 0;

// Track TikWM failures to avoid wasting time on a dead API
let tikwmConsecutiveFailures = 0;
let tikwmLastFailure = 0;
const TIKWM_BACKOFF_THRESHOLD = 3; // After 3 failures, back off
const TIKWM_BACKOFF_DURATION = 30 * 60 * 1000; // Back off for 30 minutes

/**
 * Get recent videos from a TikTok user using TikWM API (primary method)
 */
async function getUserVideosViaTikWM(username, limit = 10) {
    try {
        // Remove @ prefix if present
        const cleanUsername = username.replace(/^@/, '').toLowerCase();

        // Skip if TikWM is in backoff mode (too many consecutive failures)
        if (tikwmConsecutiveFailures >= TIKWM_BACKOFF_THRESHOLD) {
            const timeSinceFailure = Date.now() - tikwmLastFailure;
            if (timeSinceFailure < TIKWM_BACKOFF_DURATION) {
                logger.debug(`[TikTok API] TikWM in backoff (${tikwmConsecutiveFailures} failures), skipping`);
                return [];
            }
            // Backoff expired, reset and try again
            logger.info('[TikTok API] TikWM backoff expired, retrying');
            tikwmConsecutiveFailures = 0;
        }

        // Check cache first to avoid rate limits
        const cached = tikwmCache.get(cleanUsername);
        if (cached && (Date.now() - cached.timestamp) < TIKWM_CACHE_DURATION) {
            logger.debug(`[TikTok API] Using cached TikWM data for ${cleanUsername}`);
            return cached.videos;
        }

        // Rate limit: wait if last request was less than 1 second ago
        const timeSinceLastRequest = Date.now() - lastTikWMRequest;
        if (timeSinceLastRequest < 1000) {
            const waitTime = 1000 - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        logger.info(`[TikTok API] Fetching videos via TikWM for ${cleanUsername}`);
        lastTikWMRequest = Date.now();

        const response = await axios.get('https://tikwm.com/api/user/posts', {
            params: {
                unique_id: cleanUsername,
                count: limit
            },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });

        if (response.data?.code === 0 && response.data?.data?.videos) {
            const videos = response.data.data.videos.map(item => ({
                video_id: item.video_id,
                url: `https://www.tiktok.com/@${item.author?.unique_id || cleanUsername}/video/${item.video_id}`,
                title: item.title || '',
                description: item.title || '',
                thumbnail: item.cover || item.origin_cover || '',
                view_count: item.play_count || 0,
                like_count: item.digg_count || 0,
                share_count: item.share_count || 0,
                comment_count: item.comment_count || 0,
                posted_at: item.create_time ? new Date(item.create_time * 1000).toISOString() : new Date().toISOString(),
                duration: item.duration || 0,
                author: {
                    id: item.author?.id,
                    unique_id: item.author?.unique_id || cleanUsername,
                    nickname: item.author?.nickname,
                    avatar: item.author?.avatar
                }
            }));

            logger.info(`[TikTok API] TikWM returned ${videos.length} videos for ${cleanUsername}`);

            // Reset failure counter on success
            tikwmConsecutiveFailures = 0;

            // Cache the results
            tikwmCache.set(cleanUsername, {
                videos: videos,
                timestamp: Date.now()
            });

            return videos;
        }

        logger.warn(`[TikTok API] TikWM returned no videos for ${cleanUsername}:`, {
            code: response.data?.code,
            msg: response.data?.msg
        });
        return [];
    } catch (error) {
        tikwmConsecutiveFailures++;
        tikwmLastFailure = Date.now();
        logger.warn(`[TikTok API] TikWM API error for ${username} (failure ${tikwmConsecutiveFailures}):`, {
            error: error.message,
            status: error.response?.status
        });
        return [];
    }
}

/**
 * Get recent videos using EnsembleData API (paid service with trial)
 */
async function getUserVideosViaEnsembleData(username, limit = 10) {
    const apiKey = process.env.ENSEMBLEDATA_API_KEY;
    if (!apiKey) {
        return [];
    }

    try {
        const cleanUsername = username.replace(/^@/, '').toLowerCase();
        logger.info(`[TikTok API] Fetching videos via EnsembleData for ${cleanUsername}`);

        const response = await axios.get('https://ensembledata.com/apis/tt/user/posts', {
            params: {
                username: cleanUsername,
                depth: 1,
                oldest_createtime: 0,
                alternative_method: false,
                token: apiKey
            },
            timeout: 30000
        });

        if (response.data?.data) {
            const posts = response.data.data;
            const videos = posts.slice(0, limit).map(item => ({
                video_id: item.aweme_id || item.id,
                url: `https://www.tiktok.com/@${cleanUsername}/video/${item.aweme_id || item.id}`,
                title: item.desc || '',
                description: item.desc || '',
                thumbnail: item.video?.cover?.url_list?.[0] || item.video?.origin_cover?.url_list?.[0] || '',
                view_count: item.statistics?.play_count || 0,
                like_count: item.statistics?.digg_count || 0,
                share_count: item.statistics?.share_count || 0,
                comment_count: item.statistics?.comment_count || 0,
                posted_at: item.create_time ? new Date(item.create_time * 1000).toISOString() : new Date().toISOString(),
                duration: item.video?.duration || 0
            }));

            logger.info(`[TikTok API] EnsembleData found ${videos.length} videos for ${cleanUsername}`);
            return videos;
        }

        return [];
    } catch (error) {
        logger.warn(`[TikTok API] EnsembleData error for ${username}: ${error.message}`);
        return [];
    }
}

// Cache for yt-dlp results to avoid spawning subprocesses too frequently
const ytdlpCache = new Map();
const YTDLP_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Get recent videos using yt-dlp (free, reliable - PRIMARY METHOD)
 * Uses yt-dlp to extract video list from TikTok profile
 */
async function getUserVideosViaYtDlp(username, limit = 10) {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const cleanUsername = username.replace(/^@/, '').toLowerCase();

    // Check cache first
    const cached = ytdlpCache.get(cleanUsername);
    if (cached && (Date.now() - cached.timestamp) < YTDLP_CACHE_DURATION) {
        logger.debug(`[TikTok API] Using cached yt-dlp data for ${cleanUsername}`);
        return cached.videos;
    }

    try {
        logger.info(`[TikTok API] Fetching videos via yt-dlp for ${cleanUsername}`);

        // Use yt-dlp to get video list as JSON
        const { stdout } = await execAsync(
            `yt-dlp --flat-playlist --dump-json "https://www.tiktok.com/@${cleanUsername}" 2>/dev/null | head -${limit}`,
            { timeout: 60000 }
        );

        if (!stdout.trim()) {
            return [];
        }

        // Parse each line as separate JSON object
        const videos = stdout.trim().split('\n').map(line => {
            try {
                const item = JSON.parse(line);
                return {
                    video_id: item.id,
                    url: item.url || `https://www.tiktok.com/@${cleanUsername}/video/${item.id}`,
                    title: item.title || '',
                    description: item.title || '',
                    thumbnail: item.thumbnail || item.thumbnails?.[0]?.url || '',
                    view_count: item.view_count || 0,
                    like_count: item.like_count || 0,
                    posted_at: item.timestamp ? new Date(item.timestamp * 1000).toISOString() : null,
                    duration: item.duration || 0
                };
            } catch (e) {
                return null;
            }
        }).filter(Boolean);

        if (videos.length > 0) {
            logger.info(`[TikTok API] yt-dlp found ${videos.length} videos for ${cleanUsername}`);

            // Cache successful results
            ytdlpCache.set(cleanUsername, {
                videos: videos,
                timestamp: Date.now()
            });
        }

        return videos;
    } catch (error) {
        logger.warn(`[TikTok API] yt-dlp error for ${username}: ${error.message}`);
        return [];
    }
}

/**
 * Get recent videos from a TikTok user - tries multiple methods
 */
async function getUserVideos(username, limit = 10) {
    try {
        logger.info(`[TikTok API] Fetching recent videos for ${username}`);

        // PRIMARY METHOD: yt-dlp (free, reliable, no Cloudflare issues)
        const ytdlpVideos = await getUserVideosViaYtDlp(username, limit);
        if (ytdlpVideos.length > 0) {
            return ytdlpVideos;
        }

        // FALLBACK 1: TikWM API (has backoff logic for Cloudflare 403s)
        const tikwmVideos = await getUserVideosViaTikWM(username, limit);
        if (tikwmVideos.length > 0) {
            return tikwmVideos;
        }

        // FALLBACK 2: Try to get videos from the profile page directly
        const profile = await getUserProfile(username);

        if (profile) {
            // If we have initial videos from the page load, use those
            if (profile.initialVideos && profile.initialVideos.length > 0) {
                const videos = profile.initialVideos.slice(0, limit).map(item => ({
                    video_id: item.id,
                    url: `https://www.tiktok.com/@${username}/video/${item.id}`,
                    title: item.desc || '',
                    description: item.desc || '',
                    thumbnail: item.video?.cover || item.video?.originCover || '',
                    view_count: item.stats?.playCount || 0,
                    like_count: item.stats?.diggCount || 0,
                    share_count: item.stats?.shareCount || 0,
                    comment_count: item.stats?.commentCount || 0,
                    posted_at: item.createTime ? new Date(item.createTime * 1000).toISOString() : new Date().toISOString(),
                    duration: item.video?.duration || 0
                }));

                logger.info(`[TikTok API] Found ${videos.length} videos from profile page for ${username}`);
                return videos;
            }

            // FALLBACK 3: If no videos in initial load, try to fetch via TikTok internal API (requires secUid)
            if (profile.secUid) {
                try {
                    const videosResponse = await axios.get('https://www.tiktok.com/api/post/item_list/', {
                        params: {
                            WebIdLastTime: Date.now(),
                            aid: 1988,
                            count: limit,
                            coverFormat: 2,
                            secUid: profile.secUid
                        },
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Referer': `https://www.tiktok.com/@${username}`
                        },
                        timeout: 10000
                    });

                    if (videosResponse.data?.itemList && videosResponse.data.itemList.length > 0) {
                        const videos = videosResponse.data.itemList.map(item => ({
                            video_id: item.id,
                            url: `https://www.tiktok.com/@${username}/video/${item.id}`,
                            title: item.desc || '',
                            description: item.desc || '',
                            thumbnail: item.video?.cover || item.video?.originCover || '',
                            view_count: item.stats?.playCount || 0,
                            like_count: item.stats?.diggCount || 0,
                            share_count: item.stats?.shareCount || 0,
                            comment_count: item.stats?.commentCount || 0,
                            posted_at: item.createTime ? new Date(item.createTime * 1000).toISOString() : new Date().toISOString(),
                            duration: item.video?.duration || 0
                        }));

                        logger.info(`[TikTok API] Found ${videos.length} videos via TikTok API for ${username}`);
                        return videos;
                    }
                } catch (apiError) {
                    logger.warn(`[TikTok API] TikTok API call failed for ${username}:`, { error: apiError.message });
                }
            }
        }

        // FALLBACK 4: Try EnsembleData API (if API key available - paid service)
        const ensembleVideos = await getUserVideosViaEnsembleData(username, limit);
        if (ensembleVideos.length > 0) {
            return ensembleVideos;
        }

        // FALLBACK 5: Use Puppeteer browser rendering as last resort
        logger.info(`[TikTok API] Trying Puppeteer fallback for ${username}`);
        const puppeteerVideos = await getUserVideosWithPuppeteer(username, limit);
        if (puppeteerVideos.length > 0) {
            return puppeteerVideos;
        }

        logger.warn(`[TikTok API] No videos found for ${username} via any method`);
        return [];

    } catch (error) {
        logger.error(`[TikTok API] Error fetching videos for ${username}:`, {
            error: error.message,
            stack: error.stack
        });
        return [];
    }
}

/**
 * Get video details using oEmbed API
 */
async function getVideoEmbed(videoUrl) {
    try {
        const response = await axios.get('https://www.tiktok.com/oembed', {
            params: { url: videoUrl },
            timeout: 10000
        });

        if (response.data) {
            return {
                title: response.data.title,
                author_name: response.data.author_name,
                author_url: response.data.author_url,
                thumbnail_url: response.data.thumbnail_url,
                thumbnail_width: response.data.thumbnail_width,
                thumbnail_height: response.data.thumbnail_height,
                html: response.data.html
            };
        }

        return null;
    } catch (error) {
        logger.error(`[TikTok API] Error fetching embed for ${videoUrl}:`, {
            error: error.message
        });
        return null;
    }
}

/**
 * Query videos using official TikTok Research API
 * Note: Requires approved Research API access
 */
async function queryVideosOfficial(username, startDate, endDate, limit = 10) {
    const token = await getAccessToken();
    if (!token) {
        logger.warn('[TikTok API] No access token available for Research API');
        return null;
    }

    try {
        const response = await axios.post(
            'https://open.tiktokapis.com/v2/research/video/query/',
            {
                query: {
                    and: [
                        { field_name: 'username', operation: 'EQ', field_values: [username.toLowerCase()] }
                    ]
                },
                max_count: limit,
                start_date: startDate,
                end_date: endDate
            },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                params: {
                    fields: 'id,video_description,create_time,username,share_count,view_count,like_count,comment_count'
                },
                timeout: 15000
            }
        );

        if (response.data?.data?.videos) {
            return response.data.data.videos.map(video => ({
                video_id: video.id,
                url: `https://www.tiktok.com/@${video.username}/video/${video.id}`,
                title: video.video_description || '',
                description: video.video_description || '',
                view_count: video.view_count || 0,
                like_count: video.like_count || 0,
                share_count: video.share_count || 0,
                comment_count: video.comment_count || 0,
                posted_at: video.create_time ? new Date(video.create_time * 1000).toISOString() : new Date().toISOString()
            }));
        }

        return null;
    } catch (error) {
        logger.error('[TikTok API] Research API query failed:', {
            error: error.response?.data?.error || error.message
        });
        return null;
    }
}

/**
 * Get user videos using Puppeteer (browser rendering)
 * This is a fallback when the API methods don't work
 */
async function getUserVideosWithPuppeteer(username, limit = 10) {
    let browser = null;

    try {
        logger.info(`[TikTok API] Launching Puppeteer for ${username}`);

        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.env.CHROME_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
                '--window-size=1920,1080',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--lang=en-US,en'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        const page = await browser.newPage();

        // Set viewport to match mobile device
        await page.setViewport({
            width: 390,
            height: 844,
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: 3
        });

        // Set extra HTTP headers to look like mobile Safari
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none'
        });

        // Use mobile user agent (less aggressive bot detection on mobile site)
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');

        // Override webdriver property and other automation indicators
        await page.evaluateOnNewDocument(() => {
            // Override webdriver
            Object.defineProperty(navigator, 'webdriver', { get: () => false });

            // Override plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });

            // Override languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });

            // Override platform for iOS
            Object.defineProperty(navigator, 'platform', {
                get: () => 'iPhone'
            });

            // Override maxTouchPoints
            Object.defineProperty(navigator, 'maxTouchPoints', {
                get: () => 5
            });

            // Override chrome
            window.chrome = {
                runtime: {},
                loadTimes: function() {},
                csi: function() {},
                app: {}
            };

            // Override permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
        });

        // Intercept network requests to capture video data
        let capturedVideos = [];
        await page.setRequestInterception(true);

        page.on('request', request => {
            request.continue();
        });

        page.on('response', async response => {
            const url = response.url();
            // Capture various API endpoints TikTok might use
            if (url.includes('/api/post/item_list') ||
                url.includes('ItemModule') ||
                url.includes('/api/user/detail') ||
                url.includes('api/recommend/item_list')) {
                try {
                    const json = await response.json();
                    if (json.itemList && json.itemList.length > 0) {
                        capturedVideos = [...capturedVideos, ...json.itemList];
                        logger.info(`[TikTok API] Captured ${json.itemList.length} videos from network (total: ${capturedVideos.length})`);
                    }
                } catch (e) {
                    // Not JSON or parsing error
                }
            }
        });

        // Navigate directly to the user's profile on mobile TikTok
        logger.info(`[TikTok API] Navigating to @${username} profile (mobile)...`);
        await page.goto(`https://www.tiktok.com/@${username}`, {
            waitUntil: 'networkidle2',
            timeout: 45000
        });

        // Check if we hit a challenge page
        const pageContent = await page.content();
        if (pageContent.includes('captcha') || pageContent.includes('verify')) {
            logger.warn(`[TikTok API] Detected challenge/captcha page for ${username}`);
            await page.screenshot({ path: '/tmp/tiktok_captcha.png' });
        }

        // Wait for initial page load
        await new Promise(resolve => setTimeout(resolve, 4000));

        // Move mouse randomly to simulate human behavior
        await page.mouse.move(
            100 + Math.random() * 800,
            100 + Math.random() * 400
        );
        await new Promise(resolve => setTimeout(resolve, 500));

        // Scroll down multiple times to trigger lazy loading with realistic behavior
        for (let i = 0; i < 5; i++) {
            const scrollAmount = 200 + Math.random() * 300;
            await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount);
            await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 700));

            // Occasionally pause like a human would
            if (i === 2) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        // Wait for any delayed network requests
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Take a screenshot for debugging
        await page.screenshot({ path: '/tmp/tiktok_debug.png' });
        logger.info(`[TikTok API] Screenshot saved to /tmp/tiktok_debug.png`);

        // If we captured videos from network, use those
        if (capturedVideos.length > 0) {
            const videos = capturedVideos.slice(0, limit).map(item => ({
                video_id: item.id,
                url: `https://www.tiktok.com/@${username}/video/${item.id}`,
                title: item.desc || '',
                description: item.desc || '',
                thumbnail: item.video?.cover || item.video?.originCover || '',
                view_count: item.stats?.playCount || 0,
                like_count: item.stats?.diggCount || 0,
                share_count: item.stats?.shareCount || 0,
                comment_count: item.stats?.commentCount || 0,
                posted_at: item.createTime ? new Date(item.createTime * 1000).toISOString() : new Date().toISOString(),
                duration: item.video?.duration || 0
            }));

            logger.info(`[TikTok API] Returning ${videos.length} videos from network capture for ${username}`);
            return videos;
        }

        // Wait for video elements to load
        await page.waitForSelector('[data-e2e="user-post-item"], [class*="DivItemContainerV2"], a[href*="/video/"]', { timeout: 10000 }).catch(() => null);

        // Extract video data from the page
        let videos = await page.evaluate((limit) => {
            // Try multiple selector patterns
            const selectors = [
                '[data-e2e="user-post-item"] a[href*="/video/"]',
                '[data-e2e="user-post-item-list"] a[href*="/video/"]',
                '[class*="DivItemContainerV2"] a[href*="/video/"]',
                'a[href*="/video/"]'
            ];

            let videoElements = [];
            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    videoElements = elements;
                    break;
                }
            }

            const results = [];
            const seenIds = new Set();

            for (let i = 0; i < videoElements.length && results.length < limit; i++) {
                const el = videoElements[i];
                const href = el.getAttribute('href');

                if (href && href.includes('/video/')) {
                    const videoIdMatch = href.match(/\/video\/(\d+)/);
                    if (videoIdMatch) {
                        const videoId = videoIdMatch[1];

                        // Skip duplicates
                        if (seenIds.has(videoId)) continue;
                        seenIds.add(videoId);

                        // Try to get thumbnail
                        const img = el.querySelector('img');
                        const thumbnail = img ? img.src : '';

                        // Try to get description from title attribute or nearby text
                        const desc = el.getAttribute('title') ||
                                    el.closest('[data-e2e="user-post-item"]')?.querySelector('[class*="desc"]')?.textContent ||
                                    '';

                        results.push({
                            video_id: videoId,
                            url: `https://www.tiktok.com${href.startsWith('/') ? href : '/' + href}`,
                            title: desc,
                            description: desc,
                            thumbnail: thumbnail
                        });
                    }
                }
            }

            return results;
        }, limit);

        logger.info(`[TikTok API] Puppeteer DOM found ${videos.length} videos for ${username}`);

        // If we still have no videos, try parsing embedded SIGI_STATE data
        if (videos.length === 0) {
            logger.info(`[TikTok API] Attempting to extract from SIGI_STATE/hydration data...`);
            const embeddedVideos = await page.evaluate((username, limit) => {
                const results = [];

                // Try to find SIGI_STATE script (older TikTok)
                const sigiScript = document.querySelector('#SIGI_STATE, script#SIGI_STATE');
                if (sigiScript) {
                    try {
                        const data = JSON.parse(sigiScript.textContent);
                        const itemModule = data.ItemModule || {};
                        for (const [id, item] of Object.entries(itemModule)) {
                            if (results.length >= limit) break;
                            if (item.author === username || item.authorId) {
                                results.push({
                                    video_id: item.id || id,
                                    url: `https://www.tiktok.com/@${username}/video/${item.id || id}`,
                                    title: item.desc || '',
                                    description: item.desc || '',
                                    thumbnail: item.video?.cover || item.video?.originCover || '',
                                    view_count: item.stats?.playCount || 0,
                                    like_count: item.stats?.diggCount || 0,
                                    posted_at: item.createTime ? new Date(item.createTime * 1000).toISOString() : null
                                });
                            }
                        }
                    } catch (e) {
                        // Parse error
                    }
                }

                // Try __UNIVERSAL_DATA_FOR_REHYDRATION__ (newer TikTok)
                const scripts = document.querySelectorAll('script');
                for (const script of scripts) {
                    const text = script.textContent || '';
                    if (text.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__')) {
                        try {
                            const match = text.match(/__UNIVERSAL_DATA_FOR_REHYDRATION__\s*=\s*({.+?});?\s*<\/script>/s);
                            if (match) {
                                const data = JSON.parse(match[1]);
                                const defaultScope = data?.__DEFAULT_SCOPE__ || {};
                                const userDetail = defaultScope['webapp.user-detail'];
                                const userPosts = userDetail?.userInfo?.user?.itemList ||
                                                defaultScope['webapp.video-detail']?.itemList || [];

                                for (const item of userPosts) {
                                    if (results.length >= limit) break;
                                    results.push({
                                        video_id: item.id,
                                        url: `https://www.tiktok.com/@${username}/video/${item.id}`,
                                        title: item.desc || '',
                                        description: item.desc || '',
                                        thumbnail: item.video?.cover || '',
                                        view_count: item.stats?.playCount || 0,
                                        like_count: item.stats?.diggCount || 0,
                                        posted_at: item.createTime ? new Date(item.createTime * 1000).toISOString() : null
                                    });
                                }
                            }
                        } catch (e) {
                            // Parse error
                        }
                    }

                    // Also try webapp.video-feed pattern
                    if (text.includes('ItemList') || text.includes('itemList')) {
                        try {
                            const jsonMatch = text.match(/\{[\s\S]*"itemList"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
                            if (jsonMatch) {
                                const parsed = JSON.parse(jsonMatch[0]);
                                const items = parsed.itemList || [];
                                for (const item of items) {
                                    if (results.length >= limit) break;
                                    if (!results.find(v => v.video_id === item.id)) {
                                        results.push({
                                            video_id: item.id,
                                            url: `https://www.tiktok.com/@${username}/video/${item.id}`,
                                            title: item.desc || '',
                                            description: item.desc || '',
                                            thumbnail: item.video?.cover || '',
                                            view_count: item.stats?.playCount || 0,
                                            like_count: item.stats?.diggCount || 0,
                                            posted_at: item.createTime ? new Date(item.createTime * 1000).toISOString() : null
                                        });
                                    }
                                }
                            }
                        } catch (e) {
                            // Parse error
                        }
                    }
                }

                return results;
            }, username, limit);

            if (embeddedVideos.length > 0) {
                logger.info(`[TikTok API] Found ${embeddedVideos.length} videos from embedded data`);
                videos = embeddedVideos;
            }
        }

        // Get additional details for each video via oEmbed
        const enrichedVideos = await Promise.all(videos.map(async (video) => {
            try {
                const embedData = await axios.get('https://www.tiktok.com/oembed', {
                    params: { url: video.url },
                    timeout: 5000
                }).catch(() => null);

                if (embedData?.data) {
                    return {
                        ...video,
                        title: embedData.data.title || video.title,
                        thumbnail: embedData.data.thumbnail_url || video.thumbnail,
                        author_name: embedData.data.author_name
                    };
                }
            } catch (e) {
                // Ignore oEmbed errors
            }
            return video;
        }));

        return enrichedVideos;

    } catch (error) {
        logger.error(`[TikTok API] Puppeteer error for ${username}:`, {
            error: error.message
        });
        return [];
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

/**
 * Download TikTok video file using TikWM API
 * Returns the video buffer for uploading to Discord
 */
async function downloadTikTokVideo(videoUrl) {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const fs = await import('fs');
    const pathModule = await import('path');
    const execAsync = promisify(exec);

    try {
        logger.info(`[TikTok API] Downloading video from ${videoUrl}`);

        // Create temp directory if it doesn't exist
        const tempDir = process.env.YTDLP_CACHE_DIR || './temp_audio';
        if (!fs.default.existsSync(tempDir)) {
            fs.default.mkdirSync(tempDir, { recursive: true });
        }

        // Generate unique filename
        const videoId = videoUrl.match(/video\/(\d+)/)?.[1] || Date.now();
        const outputPath = pathModule.default.join(tempDir, `tiktok_${videoId}.mp4`);

        // Use yt-dlp to download the video (no watermark)
        const ytdlpCmd = `yt-dlp -f "best[ext=mp4]/best" --no-warnings -o "${outputPath}" "${videoUrl}"`;

        logger.info(`[TikTok API] Running yt-dlp for video download...`);

        await execAsync(ytdlpCmd, { timeout: 120000 }); // 2 minute timeout

        // Check if file exists and read it
        if (fs.default.existsSync(outputPath)) {
            const stats = fs.default.statSync(outputPath);
            const buffer = fs.default.readFileSync(outputPath);

            // Clean up temp file
            fs.default.unlinkSync(outputPath);

            logger.info(`[TikTok API] Downloaded video via yt-dlp: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);

            return {
                buffer: buffer,
                size: stats.size
            };
        }

        logger.error('[TikTok API] yt-dlp completed but file not found');
        return null;

    } catch (error) {
        logger.error(`[TikTok API] Failed to download video:`, {
            error: error.message,
            url: videoUrl
        });

        // Clean up any partial downloads
        try {
            const tempDir = process.env.YTDLP_CACHE_DIR || './temp_audio';
            const videoId = videoUrl.match(/video\/(\d+)/)?.[1];
            if (videoId) {
                const outputPath = `${tempDir}/tiktok_${videoId}.mp4`;
                if (fs.default.existsSync(outputPath)) {
                    fs.default.unlinkSync(outputPath);
                }
            }
        } catch (cleanupError) {
            // Ignore cleanup errors
        }

        return null;
    }
}

export { isStreamerLive, getStreamDetails, getUserVideos, getUserVideosViaTikWM, getVideoEmbed, getAccessToken, queryVideosOfficial, getUserProfile, getUserVideosWithPuppeteer, downloadTikTokVideo };
