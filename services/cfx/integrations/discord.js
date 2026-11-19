// Greenhouse Tycoon (cfx v2): Discord sign-in through the dashboard. The game has no Discord OAuth of its
// own: the dashboard already knows the logged-in Discord user (passport). It signs a short assertion with
// the shared secret CFX2_DASHBOARD_SECRET; the browser posts it to POST /api/v2/auth/discord, which checks
//   - HS256 with the shared secret, issuer 'certifried-dashboard', audience 'cfx2-discord'
//   - issued at most 120 s ago and expiring within 120 s
//   - sub is a Discord snowflake; jti is random and used once (kept in memory until it expires)
// The dashboard side is one route; see services/cfx/README.md "Discord sign-in" (signDiscordAssertion
// below is the reference implementation, also used by the tests).
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { gameError } from '../lib/errors.js';

export const DISCORD_ASSERTION = Object.freeze({ issuer: 'certifried-dashboard', audience: 'cfx2-discord', maxAgeSec: 120 });

export function signDiscordAssertion({ secret, discordId, displayName = null, nowMs = Date.now() }) {
    const iat = Math.floor(nowMs / 1000);
    return jwt.sign({ name: displayName || undefined, iat, exp: iat + 60, jti: crypto.randomBytes(18).toString('base64url') }, secret, {
        algorithm: 'HS256', issuer: DISCORD_ASSERTION.issuer, audience: DISCORD_ASSERTION.audience, subject: String(discordId)
    });
}

export function createDiscordVerifier({ secret, now = () => Date.now(), maxRemembered = 20_000 }) {
    const used = new Map(); // jti -> expires (ms)

    function remember(jti, expMs) {
        const t = now();
        if (used.size >= maxRemembered) for (const [k, e] of used) if (e <= t) used.delete(k);
        if (used.size >= maxRemembered) throw gameError('RATE_LIMITED');
        used.set(jti, expMs);
    }

    return function verify(assertion) {
        if (!secret) throw gameError('SIGNIN_UNAVAILABLE', { platform: 'discord' });
        if (typeof assertion !== 'string' || assertion.length > 2048) throw gameError('UNAUTHORIZED');
        let p;
        try {
            p = jwt.verify(assertion, secret, {
                algorithms: ['HS256'], issuer: DISCORD_ASSERTION.issuer, audience: DISCORD_ASSERTION.audience,
                maxAge: DISCORD_ASSERTION.maxAgeSec, clockTolerance: 5, clockTimestamp: Math.floor(now() / 1000)
            });
        } catch {
            throw gameError('UNAUTHORIZED');
        }
        if (typeof p.exp !== 'number' || typeof p.iat !== 'number' || p.exp - p.iat > DISCORD_ASSERTION.maxAgeSec) throw gameError('UNAUTHORIZED');
        if (typeof p.sub !== 'string' || !/^\d{17,20}$/.test(p.sub)) throw gameError('UNAUTHORIZED');
        if (typeof p.jti !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(p.jti)) throw gameError('UNAUTHORIZED');
        if (used.has(p.jti)) throw gameError('UNAUTHORIZED', { reason: 'assertion already used' });
        remember(p.jti, p.exp * 1000 + 10_000);
        return { platformUserId: p.sub, displayName: typeof p.name === 'string' ? p.name : null };
    };
}
