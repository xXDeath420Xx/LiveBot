// Bluesky public AppView XRPC wrappers. No auth required for these endpoints.
// Docs: https://docs.bsky.app/docs/api/app-bsky-feed-get-author-feed
import axios from 'axios';
import logger from '../logger.js';

const APPVIEW = 'https://public.api.bsky.app/xrpc';
const TIMEOUT = 15000;

// Strip leading `@` and whitespace. Accept `handle.bsky.social`, `user.example.com`,
// or a plain DID.
export function normalizeActor(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim().replace(/^@/, '').replace(/^https?:\/\/bsky\.app\/profile\//, '');
    if (!s) return null;
    return s;
}

export async function getProfile(handle) {
    const actor = normalizeActor(handle);
    if (!actor) return null;
    try {
        const r = await axios.get(APPVIEW + '/app.bsky.actor.getProfile', {
            params: { actor },
            timeout: TIMEOUT,
        });
        return r.data || null;
    } catch (err) {
        if (err.response?.status === 400 || err.response?.status === 404) {
            logger.warn(`[BlueskyAPI] profile not found: ${actor}`);
            return null;
        }
        logger.error(`[BlueskyAPI] getProfile error for ${actor}: ${err.message}`);
        return null;
    }
}

// Returns array of post-objects from newest to oldest. `filter` follows Bluesky's enum:
// posts_with_replies | posts_no_replies | posts_with_media | posts_and_author_threads
export async function getAuthorFeed(handle, { limit = 20, filter = 'posts_no_replies' } = {}) {
    const actor = normalizeActor(handle);
    if (!actor) return [];
    try {
        const r = await axios.get(APPVIEW + '/app.bsky.feed.getAuthorFeed', {
            params: { actor, limit, filter },
            timeout: TIMEOUT,
        });
        return Array.isArray(r.data?.feed) ? r.data.feed : [];
    } catch (err) {
        if (err.response?.status === 404) return [];
        logger.error(`[BlueskyAPI] getAuthorFeed error for ${actor}: ${err.message}`);
        return [];
    }
}

// Given an AT URI like at://did:plc:xxx/app.bsky.feed.post/abc123, return a
// shareable https://bsky.app/profile/{handle}/post/{rkey} link.
export function postUrlFor(post) {
    const uri = post?.uri || post?.post?.uri;
    const handle = post?.author?.handle || post?.post?.author?.handle;
    if (!uri || !handle) return null;
    const rkey = uri.split('/').pop();
    return `https://bsky.app/profile/${handle}/post/${rkey}`;
}
