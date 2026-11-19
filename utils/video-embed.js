/**
 * Parsing for user-supplied video links on birthday cards.
 *
 * Card signatures store a thumbnail in `gif_url` (so every existing <img> renderer
 * keeps working) plus the original link in `video_url`. Renderers that know about
 * video show a click-to-play embed; the rest still show the thumbnail.
 */

const YOUTUBE_ID = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/;
const VIMEO_ID = /vimeo\.com\/(?:video\/)?(\d{6,12})/;

/**
 * @param {string} url a YouTube or Vimeo link
 * @returns {{provider: string, id: string, watchUrl: string, embedUrl: string, thumbnailUrl: string|null}|null}
 */
export function parseVideoUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (trimmed.length > 512) return null;

    const yt = trimmed.match(YOUTUBE_ID);
    if (yt) {
        return {
            provider: 'youtube',
            id: yt[1],
            watchUrl: `https://www.youtube.com/watch?v=${yt[1]}`,
            // nocookie host so an unplayed embed doesn't set tracking cookies on the card
            embedUrl: `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1&rel=0`,
            thumbnailUrl: `https://img.youtube.com/vi/${yt[1]}/hqdefault.jpg`,
        };
    }

    const vimeo = trimmed.match(VIMEO_ID);
    if (vimeo) {
        return {
            provider: 'vimeo',
            id: vimeo[1],
            watchUrl: `https://vimeo.com/${vimeo[1]}`,
            embedUrl: `https://player.vimeo.com/video/${vimeo[1]}?autoplay=1`,
            // Vimeo thumbnails need an API round-trip; the poster falls back to gif_url
            thumbnailUrl: null,
        };
    }

    return null;
}

export default { parseVideoUrl };
