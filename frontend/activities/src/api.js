// The Activity's API client. Every address is relative ("api/..."): inside Discord the page is <app>.discordsays.com/
// and Discord's URL mapping sends "/" to /activity on the site. Our session goes as a bearer token (no cookies in
// Discord's frame).
import { sleep } from './dom.js';

export class ApiError extends Error {
    constructor(status, code, message) {
        super(message || 'Something went wrong.');
        this.status = status;
        this.code = code;
    }
}

export function createApi(getSession, { onSignedOut = null } = {}) {
    async function call(method, url, body) {
        let res;
        try {
            res = await fetch(url, {
                method,
                cache: 'no-store',
                headers: { Accept: 'application/json', Authorization: `Bearer ${getSession()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined,
            });
        } catch {
            throw new ApiError(0, 'NETWORK', 'Could not reach CertiFried. Check your connection.');
        }
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        if (res.status === 401 && onSignedOut) onSignedOut();
        if (!res.ok) throw new ApiError(res.status, data?.error?.code || 'HTTP', data?.error?.message || 'Something went wrong.');
        return data;
    }
    return {
        get: (url) => call('GET', url),
        post: (url, body = {}) => call('POST', url, body),
        /** A timed GET, for the clock offset: { data, rtt, at } (at = local time halfway through). */
        async timed(url) {
            const t0 = Date.now();
            const data = await call('GET', url);
            const t1 = Date.now();
            return { data, rtt: t1 - t0, at: (t0 + t1) / 2 };
        },
    };
}

/**
 * Server-Sent Events read with fetch (EventSource cannot send our bearer token). Calls onEvent(type, data) per event;
 * reconnects with a growing pause; stops when stop() is called. onStatus('live' | 'reconnecting').
 */
export function openEvents(url, getSession, { onEvent, onStatus = () => {}, onSignedOut = () => {} }) {
    let alive = true;
    let controller = null;
    (async () => {
        let pause = 1000;
        while (alive) {
            try {
                controller = new AbortController();
                const res = await fetch(url, { headers: { Authorization: `Bearer ${getSession()}`, Accept: 'text/event-stream' }, cache: 'no-store', signal: controller.signal });
                if (res.status === 401) { onSignedOut(); return; }
                if (!res.ok || !res.body) {
                    let msg = null;
                    try { msg = (await res.json())?.error; } catch { msg = null; }
                    onEvent('error', msg || { code: `HTTP_${res.status}`, message: 'The live connection was refused.' });
                    if (res.status === 403 || res.status === 429) { await sleep(10_000); continue; }
                    throw new Error('stream');
                }
                onStatus('live');
                pause = 1000;
                const reader = res.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    let i;
                    while ((i = buf.indexOf('\n\n')) >= 0) {
                        const chunk = buf.slice(0, i);
                        buf = buf.slice(i + 2);
                        let type = 'message';
                        const data = [];
                        for (const line of chunk.split('\n')) {
                            if (line.startsWith('event:')) type = line.slice(6).trim();
                            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
                        }
                        if (!data.length) continue;
                        let parsed = null;
                        try { parsed = JSON.parse(data.join('\n')); } catch { parsed = null; }
                        onEvent(type, parsed);
                    }
                }
            } catch { /* reconnect below */ }
            if (!alive) return;
            onStatus('reconnecting');
            await sleep(pause);
            pause = Math.min(15_000, pause * 2);
        }
    })();
    return { stop() { alive = false; try { controller?.abort(); } catch { /* done */ } } };
}
