/**
 * Resolve any YouTube channel reference to its canonical `UC…` channel id (the id the
 * RSS feed at /feeds/videos.xml?channel_id=UC… needs). Accepts: a bare UC id, a
 * /channel/UC… URL, an @handle (with or without @), a full handle/custom/user URL.
 *
 * No YouTube Data API key required — for handles/custom URLs it fetches the public
 * channel page and extracts the UC id from its canonical link / externalId (stable
 * fields YouTube has long exposed).
 */
const UC_RE = /^UC[A-Za-z0-9_-]{22}$/;
const UC_EXTRACT = [
  /"externalId":"(UC[A-Za-z0-9_-]{22})"/,
  /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/,
  /"channelId":"(UC[A-Za-z0-9_-]{22})"/,
  /<meta itemprop="(?:identifier|channelId)" content="(UC[A-Za-z0-9_-]{22})"/,
  /\/channel\/(UC[A-Za-z0-9_-]{22})/, // last-resort: any /channel/UC… anywhere in the page
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Decide what to do with the raw input: return {uc} if we already have the id, else {url} to fetch.
function plan(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (UC_RE.test(s)) return { uc: s };
  const direct = s.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/i);
  if (direct) return { uc: direct[1] };
  if (/^https?:\/\//i.test(s) && /youtube\.com|youtu\.be/i.test(s)) return { url: s.split(/[?#]/)[0] };
  // @handle, bare handle, or a plain name → treat as a handle URL
  const handle = s.replace(/^@/, '').split(/[/?#]/)[0];
  return { url: `https://www.youtube.com/@${encodeURIComponent(handle)}` };
}

/**
 * @returns {Promise<{ channelId: string }>}
 * @throws Error with a user-facing message if it can't be resolved.
 */
export async function resolveYouTubeChannelId(input) {
  const p = plan(input);
  if (!p) throw new Error('Enter a YouTube channel URL, @handle, or UC… ID.');
  if (p.uc) return { channelId: p.uc };

  let res;
  try {
    res = await fetch(p.url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(12000) });
  } catch {
    throw new Error("Couldn't reach YouTube to look that up — try again, or paste the channel's UC… ID.");
  }
  if (!res.ok) throw new Error(`Couldn't find that YouTube channel (HTTP ${res.status}). Double-check the URL or @handle.`);
  const html = await res.text();
  for (const re of UC_EXTRACT) {
    const m = html.match(re);
    if (m) return { channelId: m[1] };
  }
  throw new Error("Couldn't read that channel's ID — make sure the URL/@handle is correct and the channel is public.");
}

export default resolveYouTubeChannelId;
