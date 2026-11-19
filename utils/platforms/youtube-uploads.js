/*
 * A YouTube channel's newest uploads, for core/youtube-feed.js.
 *
 * Sources, in order:
 *   1. YouTube Data API, the channel's uploads playlist (UU…): videos and Shorts with upload times, 1 quota
 *      unit per check (search.list would be 100). Needs YOUTUBE_API_KEY.
 *   2. The RSS feed (feeds/videos.xml). Since at least 2026-11-05 it answers 404 or 500 for every channel.
 *   3. The channel's public Videos and Shorts tabs, the pages the go-live check (utils/platforms/youtube.js)
 *      already loads. Tab items carry no upload time.
 * Callers track which ids they have seen rather than "the newest one", which works for all three.
 *
 * Returns newest-first [{ id, title, url, thumbnail, description, published, short }] plus the channel name.
 */
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PER_TAB = 8;

async function fromApi(channelId) {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key || !/^UC[\w-]{22}$/.test(channelId)) return null;
    const res = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
        params: { part: 'snippet,contentDetails', playlistId: `UU${channelId.slice(2)}`, maxResults: 10, key },
        timeout: 15000, validateStatus: () => true,
    });
    if (res.status === 404) throw new Error(`channel ${channelId} not found`);
    if (res.status !== 200) return null; // quota or key trouble: let RSS / the pages answer instead
    const items = res.data?.items ?? [];
    return {
        channelName: items[0]?.snippet?.channelTitle ?? null,
        uploads: items
            .filter(i => i.snippet?.title !== 'Private video' && i.snippet?.title !== 'Deleted video')
            .map(i => {
                const id = i.contentDetails?.videoId;
                const thumbs = i.snippet?.thumbnails ?? {};
                return {
                    id,
                    title: i.snippet?.title ?? 'New upload',
                    url: `https://www.youtube.com/watch?v=${id}`,
                    thumbnail: (thumbs.maxres ?? thumbs.high ?? thumbs.medium ?? thumbs.default)?.url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                    description: i.snippet?.description ?? null,
                    published: i.contentDetails?.videoPublishedAt ?? i.snippet?.publishedAt ?? null,
                    short: false,
                };
            })
            .filter(u => u.id)
            // The playlist is ordered by when items were added, which is upload order; sort to be sure.
            .sort((a, b) => String(b.published).localeCompare(String(a.published))),
    };
}

async function fromRss(channelId) {
    const res = await axios.get(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
        headers: { 'User-Agent': 'CertiFriedUtility/1.0' }, timeout: 15000, validateStatus: () => true,
    });
    if (res.status !== 200) return null;
    const feed = new XMLParser({ ignoreAttributes: false }).parse(res.data)?.feed;
    const entries = feed?.entry ? (Array.isArray(feed.entry) ? feed.entry : [feed.entry]) : [];
    return {
        channelName: feed?.title ?? null,
        uploads: entries.map(e => ({
            id: e['yt:videoId'],
            title: e.title,
            url: e.link?.['@_href'] ?? `https://www.youtube.com/watch?v=${e['yt:videoId']}`,
            thumbnail: e['media:group']?.['media:thumbnail']?.['@_url'] ?? `https://i.ytimg.com/vi/${e['yt:videoId']}/hqdefault.jpg`,
            description: e['media:group']?.['media:description'] ?? null,
            published: e.published ?? null,
            short: /\/shorts\//.test(e.link?.['@_href'] ?? ''),
        })).filter(u => u.id),
    };
}

/** The ytInitialData object embedded in a channel page, or null. */
export function initialData(html) {
    const m = String(html).match(/var ytInitialData = (\{.*?\});<\/script>/s);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
}

/**
 * Uploads listed on a Videos or Shorts tab, in page order (newest first on both). Handles the current
 * lockupViewModel / shortsLockupViewModel layouts and the older videoRenderer / reelItemRenderer ones.
 */
export function uploadsFromTab(data, { short = false, limit = PER_TAB } = {}) {
    const out = [];
    const seen = new Set();
    const add = (id, title) => {
        if (!id || seen.has(id) || out.length >= limit) return;
        seen.add(id);
        out.push({
            id, title: title || 'New upload',
            url: short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
            thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            description: null, published: null, short,
        });
    };
    (function walk(o) {
        if (!o || typeof o !== 'object' || out.length >= limit) return;
        if (o.lockupViewModel?.contentId && o.lockupViewModel.contentType !== 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
            add(o.lockupViewModel.contentId, o.lockupViewModel.metadata?.lockupMetadataViewModel?.title?.content);
        } else if (o.videoRenderer?.videoId) {
            add(o.videoRenderer.videoId, o.videoRenderer.title?.runs?.[0]?.text ?? o.videoRenderer.title?.simpleText);
        } else if (o.shortsLockupViewModel) {
            const vm = o.shortsLockupViewModel;
            add(vm.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ?? vm.entityId?.replace(/^shorts-shelf-item-/, ''), vm.overlayMetadata?.primaryText?.content);
        } else if (o.reelItemRenderer?.videoId) {
            add(o.reelItemRenderer.videoId, o.reelItemRenderer.headline?.simpleText);
        }
        for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
    })(data?.contents ?? data);
    return out;
}

async function tab(channelId, name) {
    const res = await axios.get(`https://www.youtube.com/channel/${channelId}/${name}`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' },
        timeout: 20000, validateStatus: () => true, responseType: 'text',
    });
    if (res.status === 404) throw new Error(`channel ${channelId} not found`);
    if (res.status !== 200) throw new Error(`YouTube ${name} tab answered ${res.status}`);
    const data = initialData(res.data);
    if (!data) throw new Error(`YouTube ${name} tab had no page data`);
    return { data, channelName: data.metadata?.channelMetadataRenderer?.title ?? null };
}

/**
 * Which uploads are Shorts and which are live streams or premieres (live now, upcoming or finished).
 * Used by core/youtube-feed.js only when a feed turns one of those types off.
 *   Short: youtube.com/shorts/<id> answers 200 for a Short and redirects a regular video to /watch.
 *   Live or premiere: the Data API's liveStreamingDetails (one quota unit for the whole batch) when
 *   YOUTUBE_API_KEY works, otherwise the watch page's isLiveContent / liveBroadcastDetails markers.
 * A check that fails leaves the upload as given (short from its source, live false).
 * @returns {Promise<Map<string, {short:boolean, live:boolean}>>}
 */
export async function classifyUploads(uploads) {
    const out = new Map(uploads.map(u => [u.id, { short: !!u.short, live: false }]));
    const headers = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' };
    await Promise.all(uploads.filter(u => !u.short).map(async u => {
        try {
            const res = await axios.head(`https://www.youtube.com/shorts/${encodeURIComponent(u.id)}`, {
                headers, maxRedirects: 0, timeout: 10000, validateStatus: () => true,
            });
            if (res.status === 200) out.get(u.id).short = true;
        } catch { /* unknown: leave as a regular upload */ }
    }));
    const ids = uploads.map(u => u.id);
    let fromApi = false;
    const key = process.env.YOUTUBE_API_KEY;
    if (key && ids.length) {
        try {
            const res = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
                params: { part: 'snippet,liveStreamingDetails', id: ids.join(','), key },
                timeout: 15000, validateStatus: () => true,
            });
            if (res.status === 200) {
                fromApi = true;
                for (const item of res.data?.items ?? []) {
                    const c = out.get(item.id);
                    if (!c) continue;
                    const broadcast = item.snippet?.liveBroadcastContent;
                    c.live = !!item.liveStreamingDetails || (!!broadcast && broadcast !== 'none');
                }
            }
        } catch { /* fall through to the watch pages */ }
    }
    if (!fromApi) {
        await Promise.all(uploads.filter(u => !out.get(u.id).short).map(async u => {
            try {
                const res = await axios.get(`https://www.youtube.com/watch?v=${encodeURIComponent(u.id)}`, {
                    headers, timeout: 20000, validateStatus: () => true, responseType: 'text',
                });
                if (res.status === 200 && /"isLiveContent":true|"liveBroadcastDetails"|"isUpcoming":true/.test(String(res.data))) {
                    out.get(u.id).live = true;
                }
            } catch { /* unknown: not live */ }
        }));
    }
    return out;
}

/** Newest uploads for a channel id (UC…): the Data API, then RSS, then the Videos and Shorts tabs. */
export async function latestUploads(channelId) {
    const api = await fromApi(channelId);
    if (api?.uploads.length) return { ...api, source: 'api' };
    const rss = await fromRss(channelId).catch(() => null);
    if (rss?.uploads.length) return { ...rss, source: 'rss' };
    const videos = await tab(channelId, 'videos');
    // A channel with no Shorts has no Shorts tab worth failing over.
    const shorts = await tab(channelId, 'shorts').catch(() => null);
    return {
        channelName: videos.channelName,
        uploads: [...uploadsFromTab(videos.data), ...(shorts ? uploadsFromTab(shorts.data, { short: true }) : [])],
        source: 'page',
    };
}
