// Meta Graph API wrapper (Instagram Graph + Facebook Pages).
// Credentials live in env only:
//   META_APP_ID, META_APP_SECRET, META_APP_TOKEN,
//   META_ACCESS_TOKEN, META_INSTAGRAM_ACCOUNT_ID,
//   META_FACEBOOK_PAGE_ID, META_FACEBOOK_PAGE_TOKEN.
import axios from 'axios';
import logger from '../logger.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const TIMEOUT = 15000;

function userAccessToken() {
    return process.env.META_ACCESS_TOKEN;
}
function pageAccessToken() {
    return process.env.META_FACEBOOK_PAGE_TOKEN || process.env.META_ACCESS_TOKEN;
}

// ─────────── Instagram (via business account) ───────────

// The connected IG account can discover a public IG profile by username via the
// business_discovery field. Works only for business/creator profiles.
// Docs: https://developers.facebook.com/docs/instagram-api/reference/ig-user/business_discovery
export async function igBusinessDiscovery(username, { mediaLimit = 5 } = {}) {
    const igAccountId = process.env.META_INSTAGRAM_ACCOUNT_ID;
    const token = userAccessToken();
    if (!igAccountId || !token) {
        logger.warn('[MetaAPI] Instagram not configured (META_INSTAGRAM_ACCOUNT_ID / META_ACCESS_TOKEN missing)');
        return null;
    }
    const fields =
        `business_discovery.username(${username})` +
        `{id,username,name,profile_picture_url,followers_count,media_count,` +
        `media.limit(${mediaLimit}){id,caption,media_type,media_url,permalink,thumbnail_url,timestamp}}`;
    try {
        const r = await axios.get(`${GRAPH}/${igAccountId}`, {
            params: { fields, access_token: token },
            timeout: TIMEOUT,
        });
        return r.data?.business_discovery || null;
    } catch (err) {
        const errBody = err.response?.data?.error;
        if (errBody?.code === 110 || errBody?.code === 24 || /does not exist/i.test(errBody?.message || '')) {
            logger.warn(`[MetaAPI] Instagram profile not discoverable: ${username} — must be a Business/Creator account`);
            return null;
        }
        logger.error(`[MetaAPI] igBusinessDiscovery error for ${username}: ${err.message}`, { err: errBody });
        return null;
    }
}

// ─────────── Facebook Page ───────────

export async function fbPageInfo(pageId) {
    const token = pageAccessToken();
    try {
        const r = await axios.get(`${GRAPH}/${pageId}`, {
            params: { fields: 'id,name,username,picture,fan_count', access_token: token },
            timeout: TIMEOUT,
        });
        return r.data || null;
    } catch (err) {
        logger.error(`[MetaAPI] fbPageInfo error for ${pageId}: ${err.response?.data?.error?.message || err.message}`);
        return null;
    }
}

export async function fbPageRecentPosts(pageId, { limit = 5 } = {}) {
    const token = pageAccessToken();
    try {
        const r = await axios.get(`${GRAPH}/${pageId}/posts`, {
            params: {
                fields: 'id,message,created_time,permalink_url,full_picture,attachments{media,type,title,description,url}',
                limit,
                access_token: token,
            },
            timeout: TIMEOUT,
        });
        return Array.isArray(r.data?.data) ? r.data.data : [];
    } catch (err) {
        logger.error(`[MetaAPI] fbPageRecentPosts error for ${pageId}: ${err.response?.data?.error?.message || err.message}`);
        return [];
    }
}
