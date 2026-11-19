// Keeping the state fresh.
//   Polling   GET /state?v=<etag> every 15 s while the game is visible, every 60 s while hidden; 304 when
//             nothing changed. Every action answer already carries the new state, so clicks never wait.
//   Hints     a WebSocket to /gh-api/ws. The session token goes in the FIRST message (never in the URL);
//             the server then says {"type":"state","v":N} when something changed elsewhere and the client
//             fetches. If the socket cannot connect, nothing breaks: polling carries on.
//   Clock     the client keeps the offset to serverTimeMs, so every countdown runs on the server's clock.
import { WS_URL, POLL_VISIBLE_MS, POLL_HIDDEN_MS } from '../config.js';

export function createSync({ api, session, onState, onStatus, onError }) {
    let state = null;
    let offset = 0;
    let timer = null;
    let visible = document.visibilityState !== 'hidden';
    let panelVisible = true;
    let running = false;
    let inFlight = null;
    let ws = null;
    let wsRetry = 0;
    let wsTimer = null;
    let wsLive = false;
    let online = navigator.onLine !== false;

    const now = () => Date.now() + offset;
    const status = () => ({ online, live: wsLive });

    function accept(next) {
        if (!next) return;
        offset = Number(next.serverTimeMs) - Date.now();
        state = next;
        onState(next);
    }

    function schedule(ms) {
        clearTimeout(timer);
        if (!running) return;
        timer = setTimeout(poll, ms ?? (visible && panelVisible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS));
    }

    /** Fetch now (single flight). Returns when the state is current. */
    function poll() {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            try {
                const q = state ? `?v=${encodeURIComponent(state.etag)}` : '';
                const res = await api.call('GET', `/state${q}`);
                if (res.status !== 304 && res.data) accept(res.data.state);
                if (!online) { online = true; onStatus(status()); }
            } catch (err) {
                if (onError) onError(err);
            } finally {
                inFlight = null;
                schedule();
            }
        })();
        return inFlight;
    }

    // ---------------------------------------------------------------- WebSocket hints

    function closeSocket() {
        clearTimeout(wsTimer);
        if (ws) {
            ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
            try { ws.close(1000); } catch { /* already closed */ }
        }
        ws = null;
        if (wsLive) { wsLive = false; onStatus(status()); }
    }

    function reconnectLater() {
        clearTimeout(wsTimer);
        if (!running) return;
        wsRetry = Math.min(wsRetry + 1, 6);
        wsTimer = setTimeout(connect, Math.min(60_000, 2000 * 2 ** (wsRetry - 1)));
    }

    async function connect() {
        closeSocket();
        if (!running || typeof WebSocket !== 'function') return;
        let token;
        try { token = await session.token(); } catch { return; }
        let sock;
        try { sock = new WebSocket(WS_URL); } catch { reconnectLater(); return; }
        ws = sock;
        sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', token }));
        sock.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            if (msg.type === 'ready') {
                wsRetry = 0;
                if (!wsLive) { wsLive = true; onStatus(status()); }
                if (state && msg.v !== state.version) poll();
            } else if (msg.type === 'state' && (!state || msg.v !== state.version)) {
                poll();
            }
        };
        sock.onclose = async (e) => {
            if (ws !== sock) return;
            ws = null;
            if (wsLive) { wsLive = false; onStatus(status()); }
            if (e.code === 4001) {
                // The session ran out or went stale: renew it, then reconnect straight away.
                try { await session.renew('ws'); wsRetry = 0; connect(); } catch { /* the app shows sign-in */ }
                return;
            }
            if (e.code === 4003) { wsRetry = 6; } // refused: keep polling, try again much later
            reconnectLater();
        };
        sock.onerror = () => { /* onclose follows */ };
    }

    // ---------------------------------------------------------------- visibility and connectivity

    function setVisible(v) {
        const was = visible && panelVisible;
        visible = v;
        if (!was && visible && panelVisible) poll();
        else schedule();
    }

    document.addEventListener('visibilitychange', () => setVisible(document.visibilityState !== 'hidden'));
    window.addEventListener('online', () => { online = true; onStatus(status()); poll(); connect(); });
    window.addEventListener('offline', () => { online = false; onStatus(status()); closeSocket(); });

    return {
        get state() { return state; },
        now,
        accept,
        poll,
        status,
        start(initial) {
            running = true;
            if (initial) accept(initial);
            schedule();
            connect();
        },
        stop() {
            running = false;
            clearTimeout(timer);
            closeSocket();
            state = null;
        },
        /** Twitch.ext.onVisibilityChanged: the panel scrolled out of view or back. */
        setPanelVisible(v) {
            const was = visible && panelVisible;
            panelVisible = v;
            if (!was && visible && panelVisible) poll();
            else schedule();
        },
        /** After a new session (link, refresh): reconnect the hint socket with the new token. */
        reconnect() { if (running) { wsRetry = 0; connect(); } },
        markOffline() { if (online) { online = false; onStatus(status()); } }
    };
}
