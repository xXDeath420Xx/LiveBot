/**
 * !so / !shoutout <username>
 * Mod-only hype command: shouts out another streamer with a link to their
 * channel. On Kick the target is resolved via the official API so the link
 * uses their canonical slug (and renames don't break it); on Twitch we link
 * directly. Falls back to a plain shoutout if the lookup fails.
 */
import { resolveKickUser } from '../defender/resolve-kick-user.js';
import logger from '../../../utils/logger.js';

export async function shoutoutCommand(ctx) {
    const { args, reply, platform } = ctx;
    const target = String(args[0] || '').replace(/^@/, '').trim();
    if (!target) {
        return reply('Usage: !so <username>');
    }
    // Keep it strictly alphanumeric-ish — it goes straight back into chat.
    if (!/^[a-z0-9_-]{1,30}$/i.test(target)) {
        return reply('That doesn\'t look like a valid username.');
    }

    let name = target;
    let url = null;
    try {
        if (platform === 'kick') {
            const r = await resolveKickUser(target);
            if (r) { name = r.slug; url = `https://kick.com/${r.slug}`; }
        } else if (platform === 'twitch') {
            url = `https://twitch.tv/${target.toLowerCase()}`;
        }
    } catch (err) {
        logger.warn('[Shoutout] lookup failed', { target, error: err.message });
    }

    reply(url
        ? `📣 Big shoutout to @${name} — go show them some love at ${url} !`
        : `📣 Big shoutout to @${name}!`);
}
