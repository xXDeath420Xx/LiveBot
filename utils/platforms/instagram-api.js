import axios from 'axios';
import logger from '../logger.js';

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const IG_ACCOUNT_ID = process.env.META_INSTAGRAM_ACCOUNT_ID;

/**
 * Get Instagram account info
 */
async function getInstagramUser(username) {
    if (!ACCESS_TOKEN || !IG_ACCOUNT_ID) { logger.warn('[Instagram API] No META_ACCESS_TOKEN or account ID configured'); return null; }

    try {
        const { data } = await axios.get(`${GRAPH_API}/${IG_ACCOUNT_ID}`, {
            params: { fields: 'name,username,media_count,followers_count,profile_picture_url,biography', access_token: ACCESS_TOKEN },
        });
        return {
            id: data.id,
            username: data.username,
            displayName: data.name,
            avatarUrl: data.profile_picture_url || null,
            followers: data.followers_count || 0,
            mediaCount: data.media_count || 0,
            bio: data.biography || null,
        };
    } catch (error) {
        logger.error(`[Instagram API] Error getting user ${username}:`, { message: error.message });
        return null;
    }
}

/**
 * Check if Instagram user is currently live
 * NOTE: Instagram Graph API doesn't directly expose live status.
 * This checks for very recent media as a proxy — true live detection
 * requires Instagram's private API or app review for additional permissions.
 */
async function isStreamerLive(username) {
    // Instagram live status isn't available via Graph API without special access
    return false;
}

/**
 * Get stream/live details (placeholder — requires additional permissions)
 */
async function getStreamDetails(username) {
    return null;
}

/**
 * Get recent Instagram posts/reels
 */
async function getRecentMedia(limit = 10) {
    if (!ACCESS_TOKEN || !IG_ACCOUNT_ID) return [];

    try {
        const { data } = await axios.get(`${GRAPH_API}/${IG_ACCOUNT_ID}/media`, {
            params: {
                fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
                limit,
                access_token: ACCESS_TOKEN,
            },
        });
        return (data.data || []).map(media => ({
            id: media.id,
            caption: media.caption || '',
            type: media.media_type, // IMAGE, VIDEO, CAROUSEL_ALBUM
            mediaUrl: media.media_url || null,
            thumbnailUrl: media.thumbnail_url || null,
            permalink: media.permalink,
            timestamp: media.timestamp,
            likes: media.like_count || 0,
            comments: media.comments_count || 0,
        }));
    } catch (error) {
        logger.error(`[Instagram API] Error fetching media:`, { message: error.message });
        return [];
    }
}

/**
 * Publish a photo to Instagram
 * Two-step process: 1) create media container, 2) publish it
 */
async function publishPhoto(imageUrl, caption = '') {
    if (!ACCESS_TOKEN || !IG_ACCOUNT_ID) { logger.warn('[Instagram API] No credentials for publishing'); return null; }

    try {
        // Step 1: Create media container
        const { data: container } = await axios.post(`${GRAPH_API}/${IG_ACCOUNT_ID}/media`, {
            image_url: imageUrl,
            caption,
            access_token: ACCESS_TOKEN,
        });

        if (!container.id) throw new Error('No container ID returned');

        // Step 2: Publish
        const { data: result } = await axios.post(`${GRAPH_API}/${IG_ACCOUNT_ID}/media_publish`, {
            creation_id: container.id,
            access_token: ACCESS_TOKEN,
        });

        logger.info(`[Instagram API] Published photo: ${result.id}`);
        return result.id;
    } catch (error) {
        logger.error(`[Instagram API] Error publishing photo:`, { message: error.message });
        return null;
    }
}

/**
 * Publish a reel/video to Instagram
 */
async function publishReel(videoUrl, caption = '', coverUrl = null) {
    if (!ACCESS_TOKEN || !IG_ACCOUNT_ID) return null;

    try {
        const params = {
            media_type: 'REELS',
            video_url: videoUrl,
            caption,
            access_token: ACCESS_TOKEN,
        };
        if (coverUrl) params.cover_url = coverUrl;

        const { data: container } = await axios.post(`${GRAPH_API}/${IG_ACCOUNT_ID}/media`, params);
        if (!container.id) throw new Error('No container ID returned');

        // Wait for processing (reels take time)
        let status = 'IN_PROGRESS';
        let attempts = 0;
        while (status === 'IN_PROGRESS' && attempts < 30) {
            await new Promise(r => setTimeout(r, 5000));
            const { data: check } = await axios.get(`${GRAPH_API}/${container.id}`, {
                params: { fields: 'status_code', access_token: ACCESS_TOKEN },
            });
            status = check.status_code;
            attempts++;
        }

        if (status !== 'FINISHED') {
            logger.warn(`[Instagram API] Reel processing status: ${status}`);
            return null;
        }

        const { data: result } = await axios.post(`${GRAPH_API}/${IG_ACCOUNT_ID}/media_publish`, {
            creation_id: container.id,
            access_token: ACCESS_TOKEN,
        });

        logger.info(`[Instagram API] Published reel: ${result.id}`);
        return result.id;
    } catch (error) {
        logger.error(`[Instagram API] Error publishing reel:`, { message: error.message });
        return null;
    }
}

export { getInstagramUser, isStreamerLive, getStreamDetails, getRecentMedia, publishPhoto, publishReel };
