/**
 * Defender decision core. Pure logic + injected collaborators so it is
 * unit-testable without network or DB.
 *
 * deps:
 *   isOnBanlist(platform, userId, username) -> bool
 *   isOnUnbanlist(platform, userId, username) -> bool
 *   resolveChannel(channelId) -> { broadcasterId, token, scopes:string[] } | null
 *   banUser(broadcasterId, userId, {reason}, token) -> { ok }
 *   deleteMessage(messageId, token) -> { ok }
 *   log(entry) -> void
 *   findPhishingDomain(content) -> string|null   (optional; enables link scan)
 *   recordOffense(platform, userId, username, domain) -> number  (cumulative count)
 *
 * event: { platform, channelId, userId, username, messageId, content, isMod, isBroadcaster, reply? }
 */

const BAN_SCOPE = 'moderation:ban';
const MANAGE_SCOPE = 'moderation:chat_message:manage';

export function createEnforcer(deps) {
    async function check(event) {
        const { platform, userId, username, isMod, isBroadcaster } = event;

        if (platform !== 'kick') return { acted: false };
        if (isBroadcaster || isMod) return { acted: false };

        // Unbanlist (false-positive protection) exempts a user from ALL action.
        if (await deps.isOnUnbanlist(platform, userId, username)) return { acted: false };

        // 1) Banlisted user → ban/delete/dormant.
        if (await deps.isOnBanlist(platform, userId, username)) {
            return handleBanlisted(event);
        }

        // 2) Otherwise, scan for a known phishing/scam link (if enabled).
        if (deps.findPhishingDomain) {
            const domain = deps.findPhishingDomain(event.content);
            if (domain) return handlePhishingLink(event, domain);
        }

        return { acted: false };
    }

    async function handleBanlisted(event) {
        const { channelId, userId, username, messageId } = event;
        const channel = await deps.resolveChannel(channelId);
        if (!channel || !channel.token || !channel.broadcasterId) return { acted: false };
        const scopes = channel.scopes || [];
        const reason = 'KBD banlist';

        if (scopes.includes(BAN_SCOPE)) {
            return act(() => deps.banUser(channel.broadcasterId, userId, { reason }, channel.token),
                { channelId, targetUserId: userId, targetUsername: username, action: 'ban', reason });
        }
        if (scopes.includes(MANAGE_SCOPE) && messageId) {
            return act(() => deps.deleteMessage(messageId, channel.token),
                { channelId, targetUserId: userId, targetUsername: username, action: 'delete', reason });
        }
        await deps.log({ channelId, targetUserId: userId, targetUsername: username, action: 'detected_no_scope', reason, success: false });
        return { acted: false };
    }

    // Phishing link: delete + warn on first offense, ban on repeat.
    async function handlePhishingLink(event, domain) {
        const { channelId, userId, username, messageId, reply } = event;
        const channel = await deps.resolveChannel(channelId);
        if (!channel || !channel.token || !channel.broadcasterId) return { acted: false };
        const scopes = channel.scopes || [];
        const reason = `phishing:${domain}`;

        const count = deps.recordOffense ? await deps.recordOffense(event.platform, userId, username, domain) : 1;
        const repeat = count >= 2;

        if (repeat && scopes.includes(BAN_SCOPE)) {
            // Best-effort delete the offending message too, then ban.
            if (scopes.includes(MANAGE_SCOPE) && messageId) {
                try { await deps.deleteMessage(messageId, channel.token); } catch { /* best effort */ }
            }
            return act(() => deps.banUser(channel.broadcasterId, userId, { reason }, channel.token),
                { channelId, targetUserId: userId, targetUsername: username, action: 'ban', reason });
        }

        // First offense (or repeat without ban scope): delete the message.
        if (scopes.includes(MANAGE_SCOPE) && messageId) {
            const r = await act(() => deps.deleteMessage(messageId, channel.token),
                { channelId, targetUserId: userId, targetUsername: username, action: 'delete', reason });
            // Warn the user once (best effort; never throws into the pipeline).
            if (!repeat && typeof reply === 'function') {
                try { reply(`@${username} posted a known scam link and it was removed. Repeat offenses = ban.`); } catch { /* ignore */ }
            }
            return r;
        }

        // No usable scope → dormant detection only.
        await deps.log({ channelId, targetUserId: userId, targetUsername: username, action: 'detected_no_scope', reason, success: false });
        return { acted: false };
    }

    // Run a moderation call and ALWAYS log the outcome, even if it throws, so a
    // failed ban/delete still produces an audit record.
    async function act(fn, logBase) {
        let ok = false;
        try {
            const res = await fn();
            ok = !!res?.ok;
        } catch {
            ok = false;
        }
        await deps.log({ ...logBase, success: ok });
        return { acted: ok };
    }

    return { check };
}
