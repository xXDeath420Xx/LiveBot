/*
 * Watch Together: everything it asks Jellyfin. Server side only.
 *
 * The API key travels in the Authorization header (MediaBrowser Token="..."), never in an address, so no URL we log,
 * build or rewrite contains it; Jellyfin still writes it into some playlist lines, which media-links.js removes.
 *
 * Playback: POST /Items/{id}/PlaybackInfo with a device profile that accepts exactly one thing, HLS in MPEG-TS with
 * H.264 video and AAC stereo audio. Jellyfin then copies the video when the file is already H.264 under the bitrate
 * ceiling (a cheap remux) and transcodes it otherwise (HEVC, AV1, too high a bitrate). Everyone in a session gets the
 * same stream, so it has to play everywhere: Discord on Windows, macOS, the web, iOS and Android.
 * Picture-based subtitles (PGS, DVD) are burned in when the host picks one; text subtitles go out as WebVTT files
 * each viewer can turn on for themselves.
 */
import { normId, stripKeyParams } from './media-links.js';

const ID_RE = /^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i;
const LIBRARY_TYPES = new Set(['movies', 'tvshows', 'homevideos', 'musicvideos', 'mixed', '']);

export class JellyfinError extends Error {
    constructor(code, status = 502, message = 'The film library is not answering right now. Try again in a minute.') {
        super(message);
        this.code = code;
        this.status = status;
    }
}

export const isJellyfinId = (id) => typeof id === 'string' && ID_RE.test(id);

export function createJellyfinMedia({ cfg, fetchImpl = fetch, now = () => Date.now() }) {
    const base = cfg.jellyfin.base;
    const auth = (deviceId = 'cf-watch') => `MediaBrowser Client="CertiFried Watch Together", Device="CertiFried", DeviceId="${deviceId}", Version="1.0", Token="${cfg.jellyfin.apiKey}"`;
    let adminUser = { id: cfg.jellyfin.userId || null, at: cfg.jellyfin.userId ? Infinity : 0 };
    let libraries = { list: null, at: 0 };

    async function call(path, { method = 'GET', body = null, deviceId, timeoutMs = 15_000, accept = 'application/json', raw = false, headers = {} } = {}) {
        if (!base || !cfg.jellyfin.apiKey) throw new JellyfinError('NOT_CONFIGURED', 503, 'The film library is not set up.');
        let res;
        try {
            res = await fetchImpl(base + path, {
                method,
                headers: { Authorization: auth(deviceId), Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeoutMs),
                redirect: 'manual',
            });
        } catch {
            throw new JellyfinError('UNREACHABLE');
        }
        if (raw) return res;
        if (res.status === 404) throw new JellyfinError('NOT_FOUND', 404, 'That title is not in the library any more.');
        if (!res.ok) throw new JellyfinError(`HTTP_${res.status}`);
        if (res.status === 204) return null;
        try { return await res.json(); } catch { throw new JellyfinError('BAD_ANSWER'); }
    }

    async function adminUserId() {
        if (adminUser.id && now() - adminUser.at < 3600_000) return adminUser.id;
        const users = await call('/Users');
        const admin = (Array.isArray(users) ? users : []).find((u) => u?.Policy?.IsAdministrator && !u?.Policy?.IsDisabled);
        if (!admin?.Id) throw new JellyfinError('NO_USER', 503, 'The film library has no user to play as.');
        adminUser = { id: admin.Id, at: now() };
        return admin.Id;
    }

    /** Video libraries: [{ id, name, type }]. Cached 5 minutes. */
    async function listLibraries({ fresh = false } = {}) {
        if (!fresh && libraries.list && now() - libraries.at < 300_000) return libraries.list;
        const data = await call('/Library/MediaFolders');
        const list = (data?.Items || [])
            .filter((i) => isJellyfinId(i.Id) && LIBRARY_TYPES.has(String(i.CollectionType || '').toLowerCase()))
            .map((i) => ({ id: i.Id, name: String(i.Name || 'Library').slice(0, 80), type: i.CollectionType || 'mixed' }));
        libraries = { list, at: now() };
        return list;
    }

    const parentParam = (libraryId) => (libraryId && isJellyfinId(libraryId) ? `&ParentId=${encodeURIComponent(libraryId)}` : '');

    const card = (i) => ({
        id: i.Id,
        type: i.Type,
        name: String(i.Name || '').slice(0, 200),
        year: i.ProductionYear || null,
        image: i.ImageTags?.Primary ? i.ImageTags.Primary : null,
        runtimeSec: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 1e7) : null,
    });

    /** Movies and shows in the library, A to Z, 30 a page; `search` narrows by title. */
    async function browse({ libraryId = null, kind = 'all', search = '', page = 0, limit = 30 }) {
        const types = kind === 'movies' ? 'Movie' : kind === 'shows' ? 'Series' : 'Movie,Series';
        const term = String(search || '').trim().slice(0, 80);
        const start = Math.max(0, Math.min(10_000, Number(page) || 0)) * limit;
        const data = await call(`/Items?IncludeItemTypes=${types}&Recursive=true&SortBy=SortName&SortOrder=Ascending`
            + `&Fields=ProductionYear&ImageTypeLimit=1&EnableImageTypes=Primary&StartIndex=${start}&Limit=${limit}`
            + `&EnableTotalRecordCount=true${parentParam(libraryId)}${term ? `&searchTerm=${encodeURIComponent(term)}` : ''}`);
        const total = Number(data?.TotalRecordCount) || 0;
        return { items: (data?.Items || []).filter((i) => isJellyfinId(i.Id)).map(card), total, page: start / limit, pages: Math.max(1, Math.ceil(total / limit)) };
    }

    /** One title with its tracks, or a JellyfinError NOT_FOUND when it is not in that library. */
    async function getItem(itemId, libraryId = null) {
        if (!isJellyfinId(itemId)) throw new JellyfinError('BAD_ID', 400, 'Pick a title from the list.');
        const data = await call(`/Items?ids=${encodeURIComponent(itemId)}&Recursive=true${parentParam(libraryId)}`
            + '&Fields=MediaSources,MediaStreams,Overview,ProductionYear,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,ChildCount');
        const i = (data?.Items || []).find((x) => normId(x.Id) === normId(itemId));
        if (!i) throw new JellyfinError('NOT_FOUND', 404, 'That title is not in this server\'s library.');
        const source = (i.MediaSources || [])[0] || null;
        const streams = source?.MediaStreams || i.MediaStreams || [];
        const track = (s) => ({ index: s.Index, label: String(s.DisplayTitle || s.Language || `Track ${s.Index}`).replace(/\s+/g, ' ').slice(0, 70), language: s.Language || null, isDefault: !!s.IsDefault });
        return {
            ...card(i),
            overview: String(i.Overview || '').slice(0, 600),
            seriesId: i.SeriesId || null,
            seriesName: i.SeriesName || null,
            season: i.ParentIndexNumber ?? null,
            episode: i.IndexNumber ?? null,
            mediaSourceId: source?.Id || null,
            videoCodec: String(streams.find((s) => s.Type === 'Video')?.Codec || '').toLowerCase() || null,
            bitrate: Number(source?.Bitrate) || null,
            audio: streams.filter((s) => s.Type === 'Audio').map(track),
            subtitles: streams.filter((s) => s.Type === 'Subtitle').map((s) => ({ ...track(s), text: !!s.IsTextSubtitleStream, forced: !!s.IsForced })),
        };
    }

    async function seasons(seriesId) {
        if (!isJellyfinId(seriesId)) throw new JellyfinError('BAD_ID', 400);
        const data = await call(`/Shows/${encodeURIComponent(seriesId)}/Seasons?Fields=ChildCount`);
        return (data?.Items || []).filter((s) => isJellyfinId(s.Id)).map((s) => ({ id: s.Id, name: String(s.Name || `Season ${s.IndexNumber ?? '?'}`), number: s.IndexNumber ?? 0 }));
    }

    async function episodes(seriesId, seasonId = null) {
        if (!isJellyfinId(seriesId) || (seasonId && !isJellyfinId(seasonId))) throw new JellyfinError('BAD_ID', 400);
        const data = await call(`/Shows/${encodeURIComponent(seriesId)}/Episodes?Fields=RunTimeTicks${seasonId ? `&SeasonId=${encodeURIComponent(seasonId)}` : ''}`);
        return (data?.Items || []).filter((e) => isJellyfinId(e.Id)).map((e) => ({
            id: e.Id, name: String(e.Name || `Episode ${e.IndexNumber ?? '?'}`), season: e.ParentIndexNumber ?? 0, episode: e.IndexNumber ?? 0,
            runtimeSec: e.RunTimeTicks ? Math.round(e.RunTimeTicks / 1e7) : null, image: e.ImageTags?.Primary || null,
        }));
    }

    /**
     * Ask Jellyfin to prepare an HLS stream. Returns { playSessionId, path (master playlist, no key), runtimeSec,
     * remux } — remux true when Jellyfin copies the video instead of transcoding it.
     */
    async function startPlayback({ item, deviceId, audioIndex = null, burnSubtitleIndex = null, maxBitrateKbps }) {
        const userId = await adminUserId();
        const bitrate = Math.round(maxBitrateKbps * 1000);
        const q = new URLSearchParams({
            UserId: userId, MaxStreamingBitrate: String(bitrate), MediaSourceId: item.mediaSourceId || item.id,
            EnableDirectPlay: 'false', EnableDirectStream: 'false', EnableTranscoding: 'true',
            AllowVideoStreamCopy: 'true', AllowAudioStreamCopy: 'true', AutoOpenLiveStream: 'false',
            SubtitleStreamIndex: String(Number.isInteger(burnSubtitleIndex) ? burnSubtitleIndex : -1),
        });
        if (Number.isInteger(audioIndex)) q.set('AudioStreamIndex', String(audioIndex));
        const profile = {
            MaxStreamingBitrate: bitrate,
            DirectPlayProfiles: [], CodecProfiles: [], ContainerProfiles: [],
            TranscodingProfiles: [{ Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Protocol: 'hls', Context: 'Streaming', MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: true }],
            // Text subtitles are separate files; picture subtitles can only be burned in.
            SubtitleProfiles: ['vtt', 'srt', 'subrip', 'ass', 'ssa'].map((f) => ({ Format: f, Method: 'External' }))
                .concat(['pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub'].map((f) => ({ Format: f, Method: 'Encode' }))),
        };
        const info = await call(`/Items/${encodeURIComponent(item.id)}/PlaybackInfo?${q}`, { method: 'POST', body: { DeviceProfile: profile }, deviceId, timeoutMs: 30_000 });
        const source = (info?.MediaSources || [])[0];
        if (!source?.TranscodingUrl || !info.PlaySessionId) throw new JellyfinError('NO_STREAM', 502, 'The library could not prepare that title for streaming.');
        const path = stripKeyParams(source.TranscodingUrl);
        // Jellyfin copies the video (a cheap remux) only when it already is H.264 under the ceiling and nothing is
        // burned in; its TranscodeReasons do not say so reliably with direct play turned off, so judge from the file.
        const remux = item.videoCodec === 'h264' && (!item.bitrate || item.bitrate <= bitrate) && !Number.isInteger(burnSubtitleIndex);
        return {
            playSessionId: String(info.PlaySessionId),
            path,
            runtimeSec: source.RunTimeTicks ? Math.round(source.RunTimeTicks / 1e7) : item.runtimeSec,
            remux,
        };
    }

    /** Stop Jellyfin's transcode for a session (frees the home PC). Never throws. */
    async function stopPlayback({ deviceId, playSessionId }) {
        if (!playSessionId) return;
        try {
            await call(`/Videos/ActiveEncodings?DeviceId=${encodeURIComponent(deviceId)}&PlaySessionId=${encodeURIComponent(playSessionId)}`, { method: 'DELETE', deviceId, raw: true, timeoutMs: 8000 });
        } catch { /* best effort: Jellyfin also kills idle transcodes itself */ }
    }

    /** GET an allowed upstream path (playlist, segment, subtitle). Returns the fetch Response. */
    async function fetchUpstream(rel, { deviceId, timeoutMs = 60_000 } = {}) {
        return call(rel, { deviceId, raw: true, accept: '*/*', timeoutMs });
    }

    /** A poster (Primary image) as { type, body } or null. */
    async function image(itemId, tag) {
        if (!isJellyfinId(itemId) || !/^[0-9a-f]{32}$/i.test(String(tag || ''))) return null;
        const res = await call(`/Items/${encodeURIComponent(itemId)}/Images/Primary?fillWidth=320&quality=82&tag=${encodeURIComponent(tag)}`, { raw: true, accept: 'image/*', timeoutMs: 15_000 });
        if (!res.ok) return null;
        const type = String(res.headers.get('content-type') || '');
        if (!/^image\/(jpeg|png|webp)$/.test(type)) return null;
        const body = Buffer.from(await res.arrayBuffer());
        return body.length <= 2 * 1024 * 1024 ? { type, body } : null;
    }

    const subtitlePath = (item, index) => `/Videos/${item.id}/${item.mediaSourceId || item.id}/Subtitles/${Number(index)}/0/Stream.vtt`;

    return { listLibraries, browse, getItem, seasons, episodes, startPlayback, stopPlayback, fetchUpstream, image, subtitlePath, adminUserId };
}
