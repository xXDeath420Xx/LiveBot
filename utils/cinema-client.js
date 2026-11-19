// utils/cinema-client.js
// Main-bot side client for the cinema loopback control API.
const PORT = Number(process.env.CINEMA_PORT || 8099);
const SECRET = process.env.CINEMA_API_SECRET || '';
const BASE = `http://127.0.0.1:${PORT}`;

// Per-call timeout so a wedged service call (e.g. a hung joinVoice) fails fast
// with a clean error instead of undici's multi-minute HeadersTimeout hang.
async function call(path, method = 'POST', body, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-cinema-secret': SECRET },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    // Normalize aborts/network errors into a structured failure the callers
    // already handle (they check `.ok`), instead of throwing "fetch failed".
    return { ok: false, status: 0, data: { error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch failed') } };
  } finally {
    clearTimeout(t);
  }
}

export const cinema = {
  play: (b) => call('/play', 'POST', b, 20000), // join + pipe setup can take a few s
  pause: () => call('/pause'),
  resume: () => call('/resume'),
  stop: () => call('/stop'),
  next: () => call('/next', 'POST', undefined, 20000),
  seek: (secs) => call('/seek', 'POST', { secs }),
  status: () => call('/status', 'GET', undefined, 5000),
  /** true if the service is reachable */
  async healthy() {
    try { return (await this.status()).ok; } catch { return false; }
  },
};
