// Greenhouse Tycoon (cfx v2): Twitch panel extension tokens. The panel gets a JWT from
// Twitch.ext.onAuthorized; Twitch signs it (HS256) with the extension secret, which the console shows
// base64-encoded (config/env.js decodes it). Verified here:
//   - signature, HS256 only, not expired (30 s clock tolerance), exp present
//   - opaque_user_id: "U..." is a logged-in viewer (allowed: Twitch permits keeping state on it);
//     "A..." is a logged-out viewer and is refused with TWITCH_SIGNED_OUT (nothing is stored for them)
//   - user_id: present once the viewer shared their identity; then the real Twitch sign-in is used
//     (store/accounts.js signInTwitchPanel joins it with the panel id)
//   - the broadcaster on their own channel: the channel id IS their user id, so they play under their
//     real Twitch id without the identity prompt
import jwt from 'jsonwebtoken';
import { gameError } from '../lib/errors.js';

const ROLES = new Set(['broadcaster', 'moderator', 'viewer', 'external']);
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function createTwitchExtVerifier({ secret, now = () => Date.now() }) {
    return function verify(token) {
        if (!secret) throw gameError('SIGNIN_UNAVAILABLE', { platform: 'twitch_panel' });
        if (typeof token !== 'string' || token.length > 4096 || !TOKEN.test(token)) throw gameError('UNAUTHORIZED');
        let p;
        try {
            p = jwt.verify(token, secret, { algorithms: ['HS256'], clockTolerance: 30, clockTimestamp: Math.floor(now() / 1000) });
        } catch {
            throw gameError('UNAUTHORIZED');
        }
        if (!p || typeof p !== 'object' || typeof p.exp !== 'number') throw gameError('UNAUTHORIZED');
        const opaque = p.opaque_user_id;
        const channel = p.channel_id;
        if (typeof opaque !== 'string' || typeof channel !== 'string' || !/^\d{1,20}$/.test(channel) || !ROLES.has(p.role)) {
            throw gameError('UNAUTHORIZED');
        }
        if (/^A/.test(opaque)) throw gameError('TWITCH_SIGNED_OUT');
        if (!/^U[A-Za-z0-9]{1,40}$/.test(opaque)) throw gameError('UNAUTHORIZED');
        let userId = typeof p.user_id === 'string' && /^\d{1,20}$/.test(p.user_id) ? p.user_id : null;
        if (!userId && p.role === 'broadcaster') userId = channel;
        return { opaqueId: opaque, userId, channelId: channel, role: p.role };
    };
}
