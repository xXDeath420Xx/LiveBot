import axios from 'axios';
import logger from '../logger.js';

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const PAGE_TOKEN = process.env.META_FACEBOOK_PAGE_TOKEN;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PAGE_ID = process.env.META_FACEBOOK_PAGE_ID;

/**
 * Get Facebook page info
 */
async function getFacebookUser(usernameOrPageId) {
    if (!ACCESS_TOKEN) { logger.warn('[Facebook API] No META_ACCESS_TOKEN configured'); return null; }
    const id = usernameOrPageId || PAGE_ID;
    if (!id) return null;

    try {
        const { data } = await axios.get(`${GRAPH_API}/${id}`, {
            params: { fields: 'name,id,fan_count,about,picture', access_token: PAGE_TOKEN || ACCESS_TOKEN },
        });
        return {
            id: data.id,
            username: data.name,
            displayName: data.name,
            avatarUrl: data.picture?.data?.url || null,
            followers: data.fan_count || 0,
            about: data.about || null,
        };
    } catch (error) {
        logger.error(`[Facebook API] Error getting user ${usernameOrPageId}:`, { message: error.message });
        return null;
    }
}

/**
 * Check if Facebook page has an active live video
 * NOTE: Requires live-video-api permission (needs Meta app review)
 * Returns false until approved — placeholder for future use
 */
async function isStreamerLive(usernameOrPageId) {
    if (!PAGE_TOKEN) return false;
    const id = usernameOrPageId || PAGE_ID;

    try {
        const { data } = await axios.get(`${GRAPH_API}/${id}/live_videos`, {
            params: { fields: 'status,title,live_views', access_token: PAGE_TOKEN },
        });
        const liveVideo = data.data?.find(v => v.status === 'LIVE');
        return !!liveVideo;
    } catch (error) {
        // Expected to fail without live-video-api permission
        if (error.response?.data?.error?.code === 10) {
            return false; // Permission not granted — silent fail
        }
        logger.debug(`[Facebook API] Live check failed for ${id}:`, { message: error.message });
        return false;
    }
}

/**
 * Get stream details for a live Facebook video
 */
async function getStreamDetails(usernameOrPageId) {
    if (!PAGE_TOKEN) return null;
    const id = usernameOrPageId || PAGE_ID;

    try {
        const { data } = await axios.get(`${GRAPH_API}/${id}/live_videos`, {
            params: { fields: 'status,title,description,live_views,permalink_url,embed_html', access_token: PAGE_TOKEN },
        });
        const liveVideo = data.data?.find(v => v.status === 'LIVE');
        if (!liveVideo) return null;

        return {
            title: liveVideo.title || 'Live on Facebook',
            description: liveVideo.description || '',
            viewers: liveVideo.live_views || 0,
            url: liveVideo.permalink_url ? `https://facebook.com${liveVideo.permalink_url}` : `https://facebook.com/${id}`,
            thumbnailUrl: null,
        };
    } catch {
        return null;
    }
}

/**
 * Get recent posts from a Facebook page
 */
async function getRecentPosts(pageId, limit = 5) {
    if (!PAGE_TOKEN) return [];
    const id = pageId || PAGE_ID;

    try {
        const { data } = await axios.get(`${GRAPH_API}/${id}/feed`, {
            params: {
                fields: 'id,message,created_time,type,permalink_url,full_picture,attachments{media_type,url,title}',
                limit,
                access_token: PAGE_TOKEN,
            },
        });
        return (data.data || []).map(post => ({
            id: post.id,
            message: post.message || '',
            createdAt: post.created_time,
            type: post.type || 'status',
            url: post.permalink_url,
            imageUrl: post.full_picture || null,
        }));
    } catch (error) {
        logger.error(`[Facebook API] Error fetching posts:`, { message: error.message });
        return [];
    }
}

/**
 * Publish a post to the Facebook page
 */
async function publishPost(message, imageUrl = null) {
    if (!PAGE_TOKEN || !PAGE_ID) { logger.warn('[Facebook API] No page token/ID for publishing'); return null; }

    try {
        const params = { message, access_token: PAGE_TOKEN };
        let endpoint = `${GRAPH_API}/${PAGE_ID}/feed`;

        if (imageUrl) {
            params.url = imageUrl;
            endpoint = `${GRAPH_API}/${PAGE_ID}/photos`;
        }

        const { data } = await axios.post(endpoint, params);
        logger.info(`[Facebook API] Published post: ${data.id}`);
        return data.id;
    } catch (error) {
        logger.error(`[Facebook API] Error publishing post:`, { message: error.message });
        return null;
    }
}

export { getFacebookUser, isStreamerLive, getStreamDetails, getRecentPosts, publishPost };
