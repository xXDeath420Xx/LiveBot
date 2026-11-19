// Greenhouse Tycoon (cfx v2): game sessions. A session is a short-lived HS256 JWT naming the identity the
// player signed in with (sub) and the account it pointed to (acc). Every request re-checks that the
// identity still points to that account, so a link or unlink invalidates older tokens at once
// (SESSION_STALE) without a token blocklist.
//
// Phase 2: sign-in routes (http/routes/auth.js) call issue(), which returns the session token plus a
// refresh token (store/sessions.js). Session times use the real clock; game time (store.now) is separate,
// so a fake game clock in tests never expires a token.
import jwt from 'jsonwebtoken';
import { gameError } from '../lib/errors.js';

export const ISSUER = 'cfx2';
export const AUDIENCE = 'cfx2-game';

const BEARER = /^Bearer ([A-Za-z0-9._-]{20,2048})$/;
const TOKEN = /^[A-Za-z0-9._-]{20,2048}$/;

export function createAuth({ secret, store, ttlSec = 3600, sessions = store?.sessions || null }) {
    if (typeof secret !== 'string' || secret.length < 32) throw new Error('CFX2_JWT_SECRET must be at least 32 characters');

    function sign({ accountId, identityId }) {
        return jwt.sign({ acc: accountId }, secret, {
            algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, subject: String(identityId), expiresIn: ttlSec
        });
    }

    /** Session token plus a new refresh-token family: what every sign-in route returns. */
    async function issue({ accountId, identityId }) {
        const token = sign({ accountId, identityId });
        const out = { token, expiresAt: Date.now() + ttlSec * 1000 };
        if (sessions) Object.assign(out, await sessions.issue({ accountId, identityId }));
        return out;
    }

    /** Verify a session token string. Returns { identityId, accountId, platform, stateVersion, exp }. */
    async function verifyToken(token) {
        if (typeof token !== 'string' || !TOKEN.test(token)) throw gameError('UNAUTHORIZED');
        let payload;
        try {
            payload = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
        } catch {
            throw gameError('UNAUTHORIZED');
        }
        const identityId = Number(payload.sub);
        const accountId = Number(payload.acc);
        if (!Number.isSafeInteger(identityId) || identityId < 1 || !Number.isSafeInteger(accountId) || accountId < 1) throw gameError('UNAUTHORIZED');
        const current = await store.accounts.resolveIdentity(identityId);
        if (!current || current.accountId !== accountId) throw gameError('SESSION_STALE');
        if (current.status !== 'active') throw gameError('ACCOUNT_INACTIVE');
        return { identityId, accountId, platform: current.platform, stateVersion: current.stateVersion, exp: payload.exp };
    }

    async function authenticate(req) {
        const header = req.get('authorization') || '';
        const m = header.match(BEARER);
        if (!m) throw gameError('UNAUTHORIZED');
        return verifyToken(m[1]);
    }

    function middleware() {
        return (req, res, next) => {
            authenticate(req).then(session => { req.session = session; next(); }, next);
        };
    }

    return { sign, issue, verifyToken, authenticate, middleware, ttlSec };
}
