// utils/cinema-client.js
// Main-bot side client for the cinema loopback control API.
const PORT = Number(process.env.CINEMA_PORT || 8099);
const SECRET = process.env.CINEMA_API_SECRET || '';
const BASE = `http://127.0.0.1:${PORT}`;

async function call(path, method = 'POST', body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-cinema-secret': SECRET },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export const cinema = {
  play: (b) => call('/play', 'POST', b),
  pause: () => call('/pause'),
  resume: () => call('/resume'),
  stop: () => call('/stop'),
  seek: (secs) => call('/seek', 'POST', { secs }),
  status: () => call('/status', 'GET'),
  /** true if the service is reachable */
  async healthy() {
    try { return (await this.status()).ok; } catch { return false; }
  },
};
