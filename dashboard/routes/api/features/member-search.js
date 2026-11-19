/**
 * Member Search API — wraps Discord's 2026 POST /guilds/{id}/members-search
 * endpoint via discord.js's `guild.members.search()` for simple name queries
 * and the raw REST call for the richer filter shape.
 *
 * Discord's new search accepts an `and_query` of filter blocks: `role_ids`,
 * `user_id`, `guild_joined_at`, `source_invite_code`, `join_source_type`,
 * `safety_signals`, and more. Returns `members[]` with their flags, roles,
 * join timestamps, and more — the exact data admins need for raid forensics
 * without the "fetch every member and filter in memory" cost.
 *
 * All routes gated by `apiCheckGuildAdmin` at the parent router.
 */
import express from 'express';
import { Routes, PermissionFlagsBits } from 'discord.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;

function requireViewMembers(req, res) {
    const me = req.guildObject?.members?.me;
    if (!me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) {
        // The underlying endpoint requires the bot to be able to see members;
        // audit-log view is the minimum sane proxy without demanding Administrator.
        res.status(403).json({ error: 'The bot needs View Audit Log to run advanced member searches.' });
        return false;
    }
    return true;
}

/**
 * POST / — search members with Discord's new filter grammar.
 *
 * Body shape:
 *   {
 *     limit?: number (1-250, default 25)
 *     after?: string (snowflake)   // paginate past this member id
 *     query?: {                     // all optional — combined with AND
 *       userName?: string          // starts-with on display name/username/nickname
 *       userIds?: string[]
 *       roleIds?: string[]         // member must have all listed roles
 *       joinedBefore?: ISO date
 *       joinedAfter?: ISO date
 *       didRejoin?: boolean        // GuildMemberFlags DidRejoin
 *       usedPublicInvite?: boolean // join_source_type usage
 *     }
 *   }
 */
router.post('/', async (req, res) => {
    try {
        if (!requireViewMembers(req, res)) return;
        const b = req.body || {};
        const limit = Math.min(Math.max(Number(b.limit) || 25, 1), 250);
        const query = b.query || {};

        // Build Discord's and_query payload. Each filter is a single-element array
        // with an `and_query` object pairing a field with its predicate.
        const andQuery = [];

        if (query.userName && typeof query.userName === 'string') {
            andQuery.push({ or_query: { usernames: query.userName.slice(0, 32) } });
        }
        if (Array.isArray(query.userIds) && query.userIds.length) {
            const ids = query.userIds.filter(id => SNOWFLAKE.test(String(id))).slice(0, 100);
            if (ids.length) andQuery.push({ user_id: { or_query: ids.map(id => String(id)) } });
        }
        if (Array.isArray(query.roleIds) && query.roleIds.length) {
            const ids = query.roleIds.filter(id => SNOWFLAKE.test(String(id))).slice(0, 10);
            if (ids.length) andQuery.push({ role_ids: { and_query: ids.map(id => String(id)) } });
        }
        if (query.joinedBefore || query.joinedAfter) {
            const range = {};
            if (query.joinedAfter) {
                const t = new Date(query.joinedAfter).getTime();
                if (!Number.isNaN(t)) range.gte = t;
            }
            if (query.joinedBefore) {
                const t = new Date(query.joinedBefore).getTime();
                if (!Number.isNaN(t)) range.lte = t;
            }
            if (Object.keys(range).length) andQuery.push({ guild_joined_at: { range } });
        }
        if (query.didRejoin !== undefined) {
            // GuildMemberFlags.DidRejoin = 1 << 3 (bit 8)
            andQuery.push({ safety_signals: { has: !!query.didRejoin ? { did_rejoin: !!query.didRejoin } : undefined } });
        }

        const payload = {
            limit,
            ...(andQuery.length ? { and_query: andQuery } : {}),
            ...(b.after && SNOWFLAKE.test(String(b.after)) ? { after: { user_id: String(b.after) } } : {}),
        };

        const result = await req.guildObject.client.rest.post(
            Routes.guildMembersSearch(req.params.guildId),
            { body: payload }
        );

        const members = (result?.members || result || []).map(m => ({
            userId: m?.member?.user?.id ?? m?.user?.id ?? m?.id,
            username: m?.member?.user?.username ?? m?.user?.username,
            globalName: m?.member?.user?.global_name ?? m?.user?.global_name,
            nickname: m?.member?.nick ?? null,
            joinedAt: m?.member?.joined_at ?? m?.joined_at ?? null,
            flags: m?.member?.flags ?? m?.flags ?? 0,
            roles: m?.member?.roles ?? m?.roles ?? [],
            communicationDisabledUntil: m?.member?.communication_disabled_until ?? null,
            inviteCode: m?.source_invite_code ?? null,
            joinSourceType: m?.join_source_type ?? null,
        }));

        logger.info('[API member-search POST]', {
            guildId: req.params.guildId, by: req.user?.id, filters: Object.keys(query), count: members.length,
        });
        res.json({ members, count: members.length, hasMore: result?.has_more ?? false });
    } catch (err) {
        if (err?.code === 50001) return res.status(403).json({ error: 'Discord refused — the bot cannot see this guild\'s members.' });
        if (err?.code === 10007) return res.status(404).json({ error: 'No members match.' });
        logger.error('[API member-search POST] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Search failed' });
    }
});

export default router;
