// Windrose+ HTTP client.
//
// AUTH CONTRACT — verified against v1.3.17 on 2026-08-08. The upstream
// docs/commands.md is WRONG about this and will cost you an hour if trusted:
// it shows POST /api/rcon taking {"password": ..., "command": ...} in the JSON
// body. A body password is not accepted; that returns "Authentication required".
//
// The real sequence:
//   1. POST /login  FORM-ENCODED  (password=...)  → 302 + Set-Cookie: wp_session
//   2. POST /api/rcon  with that cookie, body {"command": "..."}
//
// The trap: posting JSON to /login returns 200 with NO cookie — it silently
// serves the login page rather than erroring. Any "login succeeded but every
// call 401s" symptom is this.
//
// Session properties, read from server/windrose_plus_server.ps1:
//   - wp_session is an HMAC token, HttpOnly, valid 24h.
//   - The token embeds a password epoch (SHA256(password)[0..4]), so rotating
//     the RCON password invalidates every outstanding session. 401 therefore
//     means "log in again", never "give up".
//   - The signing secret persists to windrose_plus_data/dashboard_session.key,
//     so a Windrose+ restart does NOT invalidate sessions.

// Two timeouts, deliberately far apart. GETs are served straight from the
// PowerShell web layer and answer in milliseconds. RCON does NOT: the web layer
// writes cmd_<id>.json to the spool, the Lua module inside the game process
// picks it up on its poll tick (1s when active, 5s when idle), executes, and
// writes res_<id>.json back. A single command therefore costs seconds, and a
// GET-sized timeout kills it just as the answer is being written. Measured
// against v1.3.17: wp.status takes ~5-7s from cold.
export function createWplusClient({
    baseUrl,
    password,
    fetchImpl = globalThis.fetch,
    timeoutMs = 5_000,
    rconTimeoutMs = 25_000,
} = {}) {
    let cookie = null;
    let loginFlight = null;

    async function login() {
        // Collapse concurrent logins — on a cold start every queued call would
        // otherwise race to authenticate and throw away all but one cookie.
        if (loginFlight) return loginFlight;

        loginFlight = (async () => {
            const body = new URLSearchParams({ password }); // form-encoded, NOT JSON
            const res = await fetchImpl(`${baseUrl}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                redirect: 'manual', // success is a 302; following it discards nothing but wastes a hop
                signal: AbortSignal.timeout(timeoutMs),
            });

            const setCookie = res.headers.get('set-cookie') || '';
            const match = setCookie.match(/wp_session=([^;]+)/);
            if (!match) {
                // Covers both a wrong password and the JSON-to-/login trap.
                throw new Error(`wplus: login did not return a wp_session cookie (status ${res.status})`);
            }
            cookie = `wp_session=${match[1]}`;
            return cookie;
        })().finally(() => { loginFlight = null; });

        return loginFlight;
    }

    async function request(path, { method = 'GET', json, timeout = timeoutMs } = {}) {
        if (!cookie) await login();

        const send = () => fetchImpl(`${baseUrl}${path}`, {
            method,
            headers: {
                Cookie: cookie,
                ...(json ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(json ? { body: JSON.stringify(json) } : {}),
            signal: AbortSignal.timeout(timeout),
        });

        let res = await send();
        if (res.status === 401) {
            // Password rotated, or the 24h token aged out. Re-auth once.
            cookie = null;
            await login();
            res = await send();
        }
        return res;
    }

    return {
        /** Public, unauthenticated — the cheapest liveness probe Windrose+ offers. */
        async health() {
            const res = await fetchImpl(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
            if (!res.ok) throw new Error(`wplus: health ${res.status}`);
            return res.json();
        },

        /** Authenticated GET returning parsed JSON. */
        async get(path) {
            const res = await request(path);
            if (!res.ok) throw new Error(`wplus: GET ${path} → ${res.status}`);
            return res.json();
        },

        /**
         * Execute one RCON command. Caller is responsible for going through the
         * queue — this deliberately does not rate limit itself, so that the
         * queue remains the single place where ordering and budget are decided.
         */
        async rcon(command) {
            const res = await request('/api/rcon', { method: 'POST', json: { command }, timeout: rconTimeoutMs });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(`wplus: rcon "${command}" → ${res.status} ${body.error || ''}`.trim());
            }
            return body; // { status, message, timestamp, id }
        },

        /** Test seam — lets a test assert re-auth happened. */
        _hasCookie() { return Boolean(cookie); },
        _clearCookie() { cookie = null; },
    };
}
