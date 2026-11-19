// Game sessions. A sign-in answers { token, expiresAt, refreshToken, refreshExpiresAt, accountId, identityId,
// platform, notice }. The session token lives in memory only.
//
// Website: the refresh token is kept in localStorage (key gh.refresh.v1) so a reload stays signed in. A
//   refresh rotates it. Two tabs refreshing at the same moment get REFRESH_RACE for the slower one; that
//   tab re-reads the newer token the faster tab stored and tries again.
// Panel: nothing is stored. When the token runs out, the newest Twitch extension JWT is exchanged again
//   (Twitch.ext.onAuthorized keeps it fresh).
import { ApiError } from './api.js';
import { UI } from '../copy.js';

const STORE_KEY = 'gh.refresh.v1';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function readStored() {
    try { return localStorage.getItem(STORE_KEY) || null; } catch { return null; }
}
function writeStored(value) {
    try {
        if (value) localStorage.setItem(STORE_KEY, value);
        else localStorage.removeItem(STORE_KEY);
    } catch { /* storage blocked: the session lasts until the tab closes */ }
}

export class SignedOutError extends Error {
    constructor(message, code = 'SIGNED_OUT') {
        super(message);
        this.name = 'SignedOutError';
        this.code = code;
    }
}

/**
 * persist   true on the website (keep the refresh token), false in the panel
 * reauth    panel only: async () => sign-in answer from the newest Twitch JWT
 */
export function createSession({ api, persist, reauth = null, onSignedIn = null, onSignedOut = null }) {
    let current = null;
    let renewing = null;

    function set(answer) {
        if (!answer || !answer.token) return;
        const prevAccount = current ? current.accountId : null;
        current = {
            token: answer.token,
            expiresAt: Number(answer.expiresAt) || Date.now() + 3_600_000,
            refreshToken: answer.refreshToken || (current && current.refreshToken) || null,
            accountId: answer.accountId ?? (current && current.accountId),
            identityId: answer.identityId ?? (current && current.identityId),
            platform: answer.platform || (current && current.platform) || null
        };
        if (persist && current.refreshToken) writeStored(current.refreshToken);
        if (onSignedIn) onSignedIn(current, prevAccount !== current.accountId);
    }

    function clear(reason = null) {
        current = null;
        if (persist) writeStored(null);
        if (onSignedOut) onSignedOut(reason);
    }

    async function refreshFromStore() {
        let lastErr = null;
        for (let attempt = 0; attempt < 4; attempt++) {
            const refreshToken = readStored() || (current && current.refreshToken);
            if (!refreshToken) throw new SignedOutError(UI.signIn.expired);
            try {
                const { data } = await api.raw('POST', '/auth/refresh', { body: { refreshToken } });
                set(data);
                return current.token;
            } catch (err) {
                lastErr = err;
                if (err.code === 'REFRESH_RACE') {
                    // Another tab rotated this token a moment ago and stored the next one: use that.
                    await sleep(300 + attempt * 300);
                    continue;
                }
                if (err.code === 'UNAUTHORIZED' || err.code === 'SESSION_STALE' || err.code === 'ACCOUNT_INACTIVE') {
                    if (readStored() === refreshToken) writeStored(null);
                    throw new SignedOutError(err.code === 'SESSION_STALE' ? UI.signIn.stale : UI.signIn.expired, err.code);
                }
                throw err;
            }
        }
        throw lastErr || new SignedOutError(UI.signIn.expired);
    }

    /** A new session token (single flight). Throws SignedOutError when the player must sign in again. */
    function renew(reason = null) {
        if (!renewing) {
            renewing = (async () => {
                try {
                    if (!persist) {
                        if (!reauth) throw new SignedOutError(UI.signIn.expired);
                        set(await reauth(reason));
                        return current.token;
                    }
                    return await refreshFromStore();
                } catch (err) {
                    if (err instanceof SignedOutError) clear(err.message);
                    throw err;
                } finally {
                    renewing = null;
                }
            })();
        }
        return renewing;
    }

    /** The session token, renewed first when it has less than a minute left. */
    async function token() {
        if (!current) throw new SignedOutError(UI.signIn.expired);
        if (current.expiresAt - Date.now() < 60_000) return renew('expiring');
        return current.token;
    }

    async function signOut() {
        const refreshToken = (current && current.refreshToken) || readStored();
        if (refreshToken) {
            try { await api.raw('POST', '/auth/logout', { body: { refreshToken } }); } catch { /* signed out locally anyway */ }
        }
        clear(UI.profile.signedOut);
    }

    // Another tab signed in, refreshed or signed out: follow it.
    if (persist) {
        window.addEventListener('storage', (e) => {
            if (e.key !== STORE_KEY) return;
            if (current && e.newValue) current.refreshToken = e.newValue;
        });
    }

    return {
        set,
        clear,
        renew,
        token,
        signOut,
        hasStoredRefresh: () => !!readStored(),
        get current() { return current; },
        isApiError: (err) => err instanceof ApiError
    };
}
