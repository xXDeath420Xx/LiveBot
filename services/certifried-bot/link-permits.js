/**
 * !permit for links (stream bot W2.17; StreamElements and Streamlabs "permit"). A moderator or the broadcaster types
 * `!permit @name` (or `!permit name`) and that viewer may post links for the next 60 seconds, past the link filter.
 * In memory only, per channel; a restart forgets permits (they last a minute anyway).
 *
 *   parsePermit(message)                 → the viewer name, or null when the message is not a !permit command
 *   grantPermit(channelKey, name, ms?)   / hasPermit(channelKey, name)
 *   permitReply(name, seconds)           the chat line
 *
 * Used by services/certifried-bot/kick-automod.js and automod.js (Twitch). Tested in tests/stream-bot-control.test.js.
 */

export const PERMIT_MS = 60_000;
const permits = new Map();   // 'channel:name' -> expiry ms

const norm = (s) => String(s || '').replace(/^@/, '').trim().toLowerCase();

export function parsePermit(message) {
    const m = String(message || '').trim().match(/^!permit\s+@?([A-Za-z0-9_.-]{1,40})\s*$/i);
    return m ? norm(m[1]) : null;
}

export function grantPermit(channelKey, name, ms = PERMIT_MS, now = Date.now()) {
    if (permits.size > 10_000) for (const [k, at] of permits) if (at < now) permits.delete(k);
    permits.set(`${channelKey}:${norm(name)}`, now + ms);
}

export function hasPermit(channelKey, name, now = Date.now()) {
    const k = `${channelKey}:${norm(name)}`;
    const at = permits.get(k);
    if (at == null) return false;
    if (at < now) { permits.delete(k); return false; }
    return true;
}

export const permitReply = (name, seconds = PERMIT_MS / 1000) => `@${name} can post a link in the next ${seconds} seconds.`;
export const _clearPermits = () => permits.clear();

export default { parsePermit, grantPermit, hasPermit, permitReply, PERMIT_MS };
