/*
 * Stream bot, YouTube: the YouTube Data API v3 calls the stream bot makes (documented endpoints only), each priced and
 * counted by the quota guard before it is sent. Tokens are the streamer's own (auth.js) and never reach an error or a log.
 *
 *   createYouTubeApi({ fetchImpl, quota, timeoutMs })
 *     .activeBroadcasts(token, profileId)                    liveBroadcasts.list broadcastStatus=active (the token's channel)   1 unit
 *     .video(token, videoId, profileId)                      videos.list liveStreamingDetails,snippet                           1 unit
 *     .listChat(token, chatId, pageToken, profileId)         liveChatMessages.list                                              5 units
 *     .streamChat(token, chatId, pageToken, { profileId, onResponse, signal })   liveChatMessages.streamList                5 units
 *     .sendMessage(token, chatId, text, profileId)           liveChatMessages.insert                                           20 units
 *     .deleteMessage(token, messageId, profileId)            liveChatMessages.delete                                           20 units
 *     .ban(token, chatId, userChannelId, seconds|null, profileId)   liveChatBans.insert (temporary or permanent)            200 units
 *
 * streamList is HTTP server streaming: GET /youtube/v3/liveChat/messages/stream answers with a JSON array whose elements
 * (liveChatMessageListResponse) arrive as they happen. Checked against the live API on 2026-11-20 with a public chat and the
 * server's API key: YouTube closes each connection after about 10.5 seconds; the last response's nextPageToken resumes it.
 *
 * Errors are YouTubeError { status, reason } with Google's reason (quotaExceeded, rateLimitExceeded, liveChatEnded,
 * liveChatDisabled, liveChatNotFound, forbidden, pageTokenInvalid, authError …).
 */
import { CHAT_MAX } from './config.js';

export const API_BASE = 'https://www.googleapis.com/youtube/v3';

export class YouTubeError extends Error {
    constructor(status, reason, message = '') {
        super(message || `YouTube answered ${status}${reason ? ` (${reason})` : ''}`);
        this.status = status;
        this.reason = reason || null;
    }
}

/** The reason Google gives in an error body ({ error: { errors: [{ reason }] } }). */
export function errorReason(body) {
    const e = Array.isArray(body) ? body[0]?.error : body?.error;
    if (!e) return null;
    return e.errors?.[0]?.reason || e.status || null;
}

/**
 * Splits a streamed JSON array ("[{…},{…}]" arriving in pieces) into its elements as each one completes.
 * push(text) → array of parsed elements (parse failures are skipped and counted in .bad).
 */
export function createArrayStreamParser({ maxBuffered = 8 * 1024 * 1024 } = {}) {
    let buf = '';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;
    let scanned = 0;
    const out = { bad: 0 };
    out.push = (text) => {
        buf += text;
        const found = [];
        for (let i = scanned; i < buf.length; i++) {
            const ch = buf[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === '[' || ch === '{') {
                depth++;
                if (depth === 2 && start < 0) start = i;
            } else if (ch === ']' || ch === '}') {
                depth--;
                if (depth === 1 && start >= 0) {
                    try { found.push(JSON.parse(buf.slice(start, i + 1))); } catch { out.bad++; }
                    start = -1;
                }
            }
        }
        // Drop what is complete: keep from the open element (or nothing).
        if (start >= 0) {
            buf = buf.slice(start);
            start = 0;
        } else {
            buf = '';
        }
        scanned = buf.length;
        if (buf.length > maxBuffered) { buf = ''; scanned = 0; start = -1; depth = 1; out.bad++; }
        return found;
    };
    return out;
}

export function createYouTubeApi({ fetchImpl = (...a) => globalThis.fetch(...a), quota = null, timeoutMs = 15_000, base = API_BASE } = {}) {
    function charge(method, profileId) {
        if (!quota) return;
        const r = quota.spend(method, profileId);
        if (!r.ok) throw new YouTubeError(429, r.reason === 'critical' ? 'quotaGuardCritical' : 'quotaGuardExhausted', r.reason === 'critical'
            ? 'Paused to save today\'s YouTube allowance (over 85% used)' : 'Today\'s YouTube allowance is used up');
    }
    async function call(method, { token, path, query = {}, httpMethod = 'GET', body = null, profileId = 0 }) {
        charge(method, profileId);
        const url = new URL(`${base}${path}`);
        for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, String(v));
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        if (body) headers['Content-Type'] = 'application/json';
        let res;
        try {
            res = await fetchImpl(url.toString(), { method: httpMethod, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            throw new YouTubeError(0, 'network', `Could not reach YouTube (${err?.name === 'TimeoutError' ? 'timed out' : 'network error'})`);
        }
        if (res.status === 204) return null;
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        if (!res.ok) {
            const reason = errorReason(data);
            if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') quota?.markExhausted?.();
            throw new YouTubeError(res.status, reason);
        }
        return data;
    }

    async function activeBroadcasts(token, profileId) {
        const data = await call('liveBroadcasts.list', { token, profileId, path: '/liveBroadcasts',
            query: { part: 'id,snippet,status', broadcastStatus: 'active', broadcastType: 'all', maxResults: 5 } });
        return (data?.items || []).map((b) => ({
            id: String(b.id || ''), title: b.snippet?.title || '', chatId: b.snippet?.liveChatId || null,
            channelId: b.snippet?.channelId || null, startedAt: b.snippet?.actualStartTime || null, endedAt: b.snippet?.actualEndTime || null,
            lifeCycle: b.status?.lifeCycleStatus || null, privacy: b.status?.privacyStatus || null,
        })).filter((b) => b.id);
    }

    async function video(token, videoId, profileId) {
        const data = await call('videos.list', { token, profileId, path: '/videos', query: { part: 'liveStreamingDetails,snippet', id: videoId } });
        const v = data?.items?.[0];
        if (!v) return null;
        const d = v.liveStreamingDetails || {};
        return {
            id: v.id, title: v.snippet?.title || '', live: v.snippet?.liveBroadcastContent === 'live' && !d.actualEndTime,
            chatId: d.activeLiveChatId || null, viewers: d.concurrentViewers != null ? Number(d.concurrentViewers) : null,
            startedAt: d.actualStartTime || null, endedAt: d.actualEndTime || null,
        };
    }

    async function listChat(token, chatId, pageToken, profileId) {
        return call('liveChatMessages.list', { token, profileId, path: '/liveChat/messages',
            query: { liveChatId: chatId, part: 'id,snippet,authorDetails', maxResults: 500, profileImageSize: 16, pageToken } });
    }

    /**
     * One streamList connection. Calls onResponse(response) for every element as it arrives; resolves when YouTube closes the
     * connection: { responses, nextPageToken, offlineAt }. Throws YouTubeError for an error status or an error element.
     */
    async function streamChat(token, chatId, pageToken, { profileId = 0, onResponse = () => {}, signal = null, maxMs = 120_000 } = {}) {
        charge('liveChatMessages.streamList', profileId);
        const url = new URL(`${base}/liveChat/messages/stream`);
        url.searchParams.set('liveChatId', chatId);
        url.searchParams.set('part', 'id,snippet,authorDetails');
        url.searchParams.set('maxResults', '500');
        url.searchParams.set('profileImageSize', '16');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const ctrl = new AbortController();
        const stop = () => ctrl.abort();
        signal?.addEventListener?.('abort', stop, { once: true });
        const cap = setTimeout(stop, maxMs);
        let res;
        try {
            res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: ctrl.signal });
        } catch (err) {
            clearTimeout(cap);
            signal?.removeEventListener?.('abort', stop);
            if (signal?.aborted) throw new YouTubeError(0, 'stopped', 'stopped');
            throw new YouTubeError(0, 'network', `Could not reach YouTube (${err?.name === 'AbortError' ? 'timed out' : 'network error'})`);
        }
        const parser = createArrayStreamParser();
        const out = { responses: 0, nextPageToken: pageToken || null, offlineAt: null, pollingIntervalMillis: null };
        let failure = null;
        try {
            if (!res.ok) {
                let body = null;
                try { body = await res.json(); } catch { body = null; }
                failure = new YouTubeError(res.status, errorReason(body));
            } else {
                const dec = new TextDecoder();
                for await (const chunk of res.body) {
                    for (const el of parser.push(typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true }))) {
                        if (el?.error) { failure = new YouTubeError(Number(el.error.code) || 500, errorReason(el)); break; }
                        out.responses++;
                        if (el.nextPageToken) out.nextPageToken = el.nextPageToken;
                        if (el.offlineAt) out.offlineAt = el.offlineAt;
                        if (el.pollingIntervalMillis != null) out.pollingIntervalMillis = Number(el.pollingIntervalMillis);
                        await onResponse(el);
                    }
                    if (failure) break;
                }
            }
        } catch (err) {
            if (!failure) failure = signal?.aborted ? new YouTubeError(0, 'stopped', 'stopped')
                : ctrl.signal.aborted ? null   // our own time cap: a normal end
                    : new YouTubeError(0, 'network', 'The YouTube chat connection dropped');
        } finally {
            clearTimeout(cap);
            signal?.removeEventListener?.('abort', stop);
        }
        if (failure) {
            if (failure.reason === 'quotaExceeded' || failure.reason === 'dailyLimitExceeded') quota?.markExhausted?.();
            failure.partial = out;
            throw failure;
        }
        return out;
    }

    async function sendMessage(token, chatId, text, profileId) {
        const messageText = String(text ?? '').slice(0, CHAT_MAX);
        return call('liveChatMessages.insert', { token, profileId, path: '/liveChat/messages', httpMethod: 'POST', query: { part: 'snippet' },
            body: { snippet: { liveChatId: chatId, type: 'textMessageEvent', textMessageDetails: { messageText } } } });
    }

    async function deleteMessage(token, messageId, profileId) {
        await call('liveChatMessages.delete', { token, profileId, path: '/liveChat/messages', httpMethod: 'DELETE', query: { id: messageId } });
        return true;
    }

    async function ban(token, chatId, userChannelId, seconds, profileId) {
        const snippet = { liveChatId: chatId, type: seconds ? 'temporary' : 'permanent', bannedUserDetails: { channelId: userChannelId } };
        if (seconds) snippet.banDurationSeconds = Math.max(1, Math.min(86_400, Math.round(Number(seconds))));
        return call('liveChatBans.insert', { token, profileId, path: '/liveChat/bans', httpMethod: 'POST', query: { part: 'snippet' }, body: { snippet } });
    }

    return { activeBroadcasts, video, listChat, streamChat, sendMessage, deleteMessage, ban };
}

export default { createYouTubeApi, createArrayStreamParser, YouTubeError, errorReason, API_BASE };
