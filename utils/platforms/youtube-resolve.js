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

// Only ever fetch these exact hosts (SSRF guard — the fetch target must be a real
// YouTube host, never inferred from an unanchored substring of attacker input).
const ALLOWED_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

// Decide what to do with the raw input: return {uc} if we already have the id, else {url} to fetch.
function plan(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  if (UC_RE.test(s)) return { uc: s };

  // Normalise a scheme-less YouTube URL (e.g. "youtube.com/@x") so it parses as a URL.
  if (/^(?:www\.|m\.|music\.)?youtube\.com\//i.test(s) || /^youtu\.be\//i.test(s)) s = 'https://' + s;

  if (/^https?:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { throw new Error("That doesn't look like a valid URL."); }
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!ALLOWED_HOSTS.has(host)) throw new Error('Only youtube.com / youtu.be links are allowed.');
    const ch = u.pathname.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/); // /channel/UC… → use id, no fetch
    if (ch) return { uc: ch[1] };
    // Rebuild a clean https URL from the validated host + path only (drops query/fragment/credentials).
    return { url: `https://${host}${u.pathname}` };
  }

  // Not a URL: a bare @handle / handle / name → fixed-host handle URL (host can't be attacker-controlled).
  const handle = s.replace(/^@/, '').split(/[/?#\s]/)[0];
  if (!handle) throw new Error('Enter a YouTube channel URL, @handle, or UC… ID.');
  return { url: `https://www.youtube.com/@${encodeURIComponent(handle)}` };
}

// Fetch with manual redirect handling — every hop's host is re-validated against the
// allowlist so a youtube.com URL can't bounce the server to an internal/attacker host
// (defense-in-depth on top of the initial-host check in plan()).
async function safeFetch(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(current, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('Got an unexpected redirect from YouTube.');
      const next = new URL(loc, current);
      const host = next.hostname.toLowerCase().replace(/\.$/, '');
      if (next.protocol !== 'https:' || !ALLOWED_HOSTS.has(host)) {
        throw new Error('Only youtube.com / youtu.be links are allowed.');
      }
      current = next.toString();
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects looking that up.');
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
    res = await safeFetch(p.url);
  } catch (err) {
    if (/only youtube|too many redirects|unexpected redirect/i.test(err.message)) throw err;
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
