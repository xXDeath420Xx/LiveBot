const axios = require("axios");
const {getBrowser} = require("./browserManager");
const logger = require("./logger");

let twitchToken = null;
let tokenExpires = 0;

// Helper to break an array into smaller chunks
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

async function getYouTubeChannelId(identifier) {
  if (!process.env.YOUTUBE_API_KEY) {
    logger.error("[YouTube API Error] YOUTUBE_API_KEY is not set.");
    return null;
  }
  if (identifier && identifier.startsWith("UC")) {
    return {channelId: identifier, channelName: null};
  }
  try {
    const searchResponse = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {part: "snippet", q: identifier, type: "channel", maxResults: 1, key: process.env.YOUTUBE_API_KEY}
    });
    if (searchResponse.data.items?.[0]) {
      return {
        channelId: searchResponse.data.items[0].id.channelId,
        channelName: searchResponse.data.items[0].snippet.title
      };
    }
    const channelResponse = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
      params: {part: "snippet", forUsername: identifier, key: process.env.YOUTUBE_API_KEY}
    });
    if (channelResponse.data.items?.[0]) {
      return {
        channelId: channelResponse.data.items[0].id,
        channelName: channelResponse.data.items[0].snippet.title
      };
    }
    return null;
  } catch (error) {
    logger.error(`[YouTube API Check Error] for "${identifier}":`, {error: error.response?.data?.error?.message || error.message});
    return null;
  }
}

async function getKickUser(cycleTLS, username) {
  if (typeof username !== "string" || !username) {
    return null;
  }
  try {
    const response = await cycleTLS(`https://kick.com/api/v1/channels/${username.toLowerCase()}`, {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    });
    if (response.status === 200 && response.body) {
      return typeof response.body === "string" ? JSON.parse(response.body) : response.body;
    }
    return null;
  } catch (error) {
    logger.error(`[Kick API Check Error] for "${username}":`, {error: error.message});
    return null;
  }
}

async function getTwitchAccessToken() {
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    logger.error("[Twitch Auth Error] Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET.");
    return null;
  }
  if (twitchToken && tokenExpires > Date.now()) {
    return twitchToken;
  }
  try {
    const response = await axios.post("https://id.twitch.tv/oauth2/token", `client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`);
    twitchToken = response.data.access_token;
    tokenExpires = Date.now() + (response.data.expires_in * 1000);
    logger.info("[Twitch Auth] Successfully refreshed Twitch API access token.");
    return twitchToken;
  } catch (error) {
    logger.error("[Twitch Auth Error]", {error: error.response ? error.response.data : error.message});
    return null;
  }
}

async function getTwitchUser(identifier) {
    const users = await getTwitchUsers([identifier]);
    return users?.[0] || null;
}

async function getTwitchUsers(identifiers) {
    const token = await getTwitchAccessToken();
    if (!token) return null;

    const allUsers = [];
    const idChunks = chunkArray(identifiers.filter(id => /^[0-9]+$/.test(id)), 100);
    const loginChunks = chunkArray(identifiers.filter(id => !/^[0-9]+$/.test(id)), 100);

    const headers = { "Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}` };

    try {
        for (const chunk of idChunks) {
            const res = await axios.get(`https://api.twitch.tv/helix/users`, { headers, params: { id: chunk } });
            if (res.data.data) allUsers.push(...res.data.data);
        }
        for (const chunk of loginChunks) {
            const res = await axios.get(`https://api.twitch.tv/helix/users`, { headers, params: { login: chunk } });
            if (res.data.data) allUsers.push(...res.data.data);
        }
        return allUsers;
    } catch (e) {
        logger.error(`[Twitch Users Check Error]:`, { error: e.response ? e.response.data : e.message });
        return null;
    }
}

async function getTwitchTeamMembers(teamName) {
  const token = await getTwitchAccessToken();
  if (!token) return null;
  try {
    const res = await axios.get(`https://api.twitch.tv/helix/teams?name=${teamName.toLowerCase()}`, {headers: {"Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}`}});
    return res.data.data?.[0]?.users || null;
  } catch (e) {
    logger.error(`[Twitch Team Check Error] for "${teamName}":`, {error: e.response ? e.response.data : e.message});
    return null;
  }
}

async function checkKick(cycleTLS, username) {
  const defaultResponse = {isLive: false, profileImageUrl: null};
  try {
    const kickData = await getKickUser(cycleTLS, username);
    const profileImageUrl = kickData?.user?.profile_pic || null;
    if (kickData?.livestream) {
      return {
        isLive: true, platform: "kick", username: kickData.user.username, url: `https://kick.com/${kickData.user.username}`,
        title: kickData.livestream.session_title || "Untitled Stream", game: kickData.livestream.categories?.[0]?.name || "N/A",
        thumbnailUrl: kickData.livestream.thumbnail?.src || profileImageUrl, viewers: kickData.livestream.viewer_count || 0, profileImageUrl
      };
    }
    return {...defaultResponse, profileImageUrl};
  } catch (error) {
    logger.error(`[Check Kick Error] for "${username}":`, {error: error.message});
    return defaultResponse;
  }
}

async function checkTwitch(streamer) {
  const defaultResponse = { isLive: false, profileImageUrl: streamer.profile_image_url };
  const token = await getTwitchAccessToken();
  if (!token) return defaultResponse;

  try {
    const streamRes = await axios.get(`https://api.twitch.tv/helix/streams?user_id=${streamer.platform_user_id}`, {headers: {"Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}`}});
    const streamData = streamRes.data.data[0];

    if (!streamData) {
      return defaultResponse; // Stream is not live
    }

    // Stream is live, gather data
    const uptimeSeconds = Math.floor((Date.now() - new Date(streamData.started_at).getTime()) / 1000);
    let gameArtUrl = null;

    if (streamData.game_id) {
      try {
        const gameRes = await axios.get(`https://api.twitch.tv/helix/games?id=${streamData.game_id}`, {headers: {"Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}`}});
        gameArtUrl = gameRes.data.data?.[0]?.box_art_url.replace("{width}", "285").replace("{height}", "380") || null;
      } catch (gameError) {
        logger.warn(`[Twitch Game Check] Failed to get game art for game ID ${streamData.game_id}.`, { error: gameError.message });
      }
    }

    const userRes = await getTwitchUser(streamer.platform_user_id);

    return {
      isLive: true,
      platform: "twitch",
      username: streamData.user_name,
      url: `https://www.twitch.tv/${streamData.user_login}`,
      title: streamData.title || "Untitled Stream",
      game: streamData.game_name || "N/A",
      thumbnailUrl: streamData.thumbnail_url?.replace("{width}", "1280").replace("{height}", "720"),
      viewers: streamData.viewer_count,
      profileImageUrl: userRes?.profile_image_url || streamer.profile_image_url,
      uptime: uptimeSeconds,
      gameArtUrl
    };

  } catch (e) {
    logger.error(`[Check Twitch Error] for user ID "${streamer.platform_user_id}":`, {error: e.message});
    return defaultResponse;
  }
}

async function checkYouTube(channelId) {
  const defaultResponse = {isLive: false, profileImageUrl: null, visibility: 'public'};
  let page = null;
  try {
    const browser = await getBrowser();
    if (!browser) return defaultResponse;
    page = await browser.newPage();
    const url = `https://www.youtube.com/channel/${channelId}/live`;
    await page.goto(url, {waitUntil: "domcontentloaded", timeout: 45000});
    const profileImageUrl = await page.locator("#avatar #img").getAttribute("src").catch(() => null);
    if (page.url().includes("/watch")) {
      const isLiveBadge = await page.locator("span.ytp-live-badge").isVisible({timeout: 5000});
      if (isLiveBadge) {
        const isMembersOnly = await page.locator('ytd-sponsorships-offer-renderer').isVisible({ timeout: 2000 }).catch(() => false);
        const title = await page.title().then(t => t.replace(" - YouTube", "").trim());
        return {
          isLive: true, platform: "youtube", username: title, url: page.url(), title, profileImageUrl,
          thumbnailUrl: await page.locator("meta[property=\"og:image\"]").getAttribute("content").catch(() => null), game: "N/A", viewers: "N/A",
          visibility: isMembersOnly ? 'members-only' : 'public'
        };
      }
    }
    return {...defaultResponse, profileImageUrl};
  } catch (e) {
    logger.error(`[Check YouTube Error] for channel ID "${channelId}":`, {error: e.message});
    return defaultResponse;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function checkTikTok(username) {
    const defaultResponse = { isLive: false, profileImageUrl: null };
    let page = null;
    try {
        const browser = await getBrowser();
        if (!browser) return defaultResponse;
        page = await browser.newPage();
        const url = `https://www.tiktok.com/@${username}/live`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

        const isLiveIndicator = await page.locator("*[class*='LiveRoom-liveBadge']").isVisible({ timeout: 7000 });

        if (isLiveIndicator) {
            const title = await page.locator("*[class*='LiveRoom-title']").textContent().catch(() => "Untitled Stream");
            const profileImageUrl = await page.locator("*[class*='LiveRoom-creatorAvatar'] img").getAttribute("src").catch(() => null);
            return {
                isLive: true,
                platform: "tiktok",
                username: username,
                url: url,
                title: title,
                game: "N/A",
                viewers: "N/A",
                profileImageUrl: profileImageUrl
            };
        }
        return defaultResponse;
    } catch (e) {
        logger.debug(`[Check TikTok] Non-fatal error for "${username}" (likely not live): ${e.message}`);
        return defaultResponse;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

async function checkTrovo(username) {
    const defaultResponse = { isLive: false, profileImageUrl: null };
    try {
        const response = await axios.post('https://api-web.trovo.live/graphql', 
            {
                "operationName": "live_getLiveInfo",
                "variables": {"params":{"userName":username}},
                "query": "query live_getLiveInfo($params: LiveInfoRequest) {\n  live_getLiveInfo(params: $params) {\n    isLive\n    liveInfo {\n      streamerInfo {\n        userName\n        nickName\n        profilePic\n      }\n      programInfo {\n        id\n        title\n        coverUrl\n        thumbnailUrl\n      }\n      categoryInfo {\n        shortName\n      }\n      viewers\n      followers\n    }\n  }\n}\n"
            },
            {
                headers: { 'Content-Type': 'application/json' }
            }
        );

        const liveData = response.data?.data?.live_getLiveInfo;
        if (liveData && liveData.isLive) {
            const info = liveData.liveInfo;
            return {
                isLive: true,
                platform: "trovo",
                username: info.streamerInfo.userName,
                url: `https://trovo.live/s/${info.streamerInfo.userName}`,
                title: info.programInfo.title || "Untitled Stream",
                game: info.categoryInfo?.shortName || "N/A",
                thumbnailUrl: info.programInfo.coverUrl,
                viewers: info.viewers || 0,
                profileImageUrl: info.streamerInfo.profilePic
            };
        }
        const profilePic = response.data?.data?.live_getLiveInfo?.liveInfo?.streamerInfo?.profilePic || null;
        return { ...defaultResponse, profileImageUrl: profilePic };

    } catch (error) {
        logger.error(`[Check Trovo Error] for "${username}":`, { error: error.response?.data || error.message });
        return defaultResponse;
    }
}

async function checkFacebook(username) {
    const defaultResponse = { isLive: false, profileImageUrl: null };
    let page = null;
    try {
        const browser = await getBrowser();
        if (!browser) return defaultResponse;
        page = await browser.newPage();
        const url = `https://www.facebook.com/${username}/live`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

        const isLiveIndicator = await page.locator('[role="main"] :text("is live now")').or(page.locator('[aria-label="LIVE"]')).first().isVisible({ timeout: 7000 });

        if (isLiveIndicator) {
            const profileImageUrl = await page.locator('meta[property="og:image"]').getAttribute("content").catch(() => null);
            const title = await page.title().then(t => t.split('|')[0].trim()).catch(() => "Untitled Stream");

            return {
                isLive: true,
                platform: "facebook",
                username: username,
                url: page.url(),
                title: title,
                game: "N/A",
                viewers: "N/A",
                profileImageUrl: profileImageUrl
            };
        }
        return defaultResponse;
    } catch (e) {
        logger.debug(`[Check Facebook] Non-fatal error for "${username}" (likely not live or page unavailable): ${e.message}`);
        return defaultResponse;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

async function checkInstagram(username) {
    const defaultResponse = { isLive: false, profileImageUrl: null };
    let page = null;
    try {
        const browser = await getBrowser();
        if (!browser) return defaultResponse;
        page = await browser.newPage({
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Mobile/15E148 Safari/604.1'
        });
        const url = `https://www.instagram.com/${username}/`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

        const isLiveIndicator = await page.locator('a[href*="/live/"] canvas').or(page.locator(':text("Live")')).first().isVisible({ timeout: 7000 });

        if (isLiveIndicator) {
             const profileImageUrl = await page.locator('meta[property="og:image"]').getAttribute("content").catch(() => null);
            return {
                isLive: true,
                platform: "instagram",
                username: username,
                url: `https://www.instagram.com/${username}/live`,
                title: "Live on Instagram",
                game: "N/A",
                viewers: "N/A",
                profileImageUrl: profileImageUrl
            };
        }
        return defaultResponse;
    } catch (e) {
        logger.debug(`[Check Instagram] Non-fatal error for "${username}" (likely not live or private): ${e.message}`);
        return defaultResponse;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

module.exports = {getYouTubeChannelId, getTwitchUser, getKickUser, checkTwitch, checkYouTube, checkKick, checkTikTok, checkTrovo, getTwitchTeamMembers, getTwitchUsers, checkFacebook, checkInstagram};