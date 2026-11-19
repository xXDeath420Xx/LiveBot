/**
 * Role-based live channel routing.
 *
 * A guild can define an ordered ladder of rules — "subscribers go to #subs-live, team
 * members go to #teammates-live, everyone else falls through to the normal channel" —
 * and the highest-priority rule the streamer actually matches wins.
 *
 * Roles rotate constantly (subs lapse, resub, change tier; team members come and go), so
 * a rule is never baked into the subscription row. It is evaluated at post time, against
 * the member's roles read live from Discord.
 *
 * A rule with no roles configured auto-detects the Discord Twitch-integration subscriber
 * roles. Discord only grants "Twitch Subscriber: Tier 1/2/3" (and the broadcaster's base
 * subscriber role) once a member syncs their Twitch account, so holding one IS the proof
 * that their Discord and Twitch accounts are linked — no extra lookup needed.
 *
 * The server owner is skipped by default: the broadcaster gets announced in their own
 * channel rather than in a tier channel.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const RULES_TTL_MS = 5 * 60 * 1000;
const ROLE_TTL_MS = 10 * 60 * 1000;
// The member's roles are re-read from Discord at decision time rather than trusted from
// the gateway cache. This TTL only collapses the duplicate fetches inside a single check
// cycle — a streamer with several subscriptions in one guild is fetched once, not once
// per subscription row.
const MEMBER_TTL_MS = 45 * 1000;

const rulesCache = new Map();  // guildId -> { value: rule[], expiresAt }
const roleCache = new Map();   // guildId -> { value: Set<roleId>, expiresAt }
const memberCache = new Map(); // `${guildId}:${userId}` -> { value: string[]|null, expiresAt }

// "Twitch Subscriber: Tier 3", "FLiiQzy Twitch Subscriber", "Subscribers" …
const SUBSCRIBER_ROLE_NAME = /subscri/i;

function parseIdList(raw) {
    if (!raw) return null;
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed)) return null;
        const ids = parsed.map(String).filter(Boolean);
        return ids.length ? ids : null;
    } catch {
        return null;
    }
}

/** Drop the cached rules + resolved roles for a guild (call after a settings save). */
export function invalidateLiveRouting(guildId) {
    rulesCache.delete(guildId);
    roleCache.delete(guildId);
    for (const key of memberCache.keys()) {
        if (key.startsWith(`${guildId}:`)) memberCache.delete(key);
    }
}

/**
 * Enabled rules for a guild, highest priority first. Returns [] for the overwhelming
 * majority of guilds that have none, so callers bail cheaply.
 */
export async function getLiveRoutingRules(guildId) {
    const cached = rulesCache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value = [];
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM guild_live_channel_rules WHERE guild_id = ? AND enabled = 1 ORDER BY priority DESC, rule_id ASC',
            [guildId]
        );
        value = rows.map(row => ({
            ruleId: row.rule_id,
            label: row.label,
            channelId: row.channel_id,
            priority: row.priority,
            roleIds: parseIdList(row.role_ids),
            sourceChannelIds: parseIdList(row.source_channel_ids),
            excludeOwner: row.exclude_owner === 1,
            excludedUserIds: parseIdList(row.excluded_user_ids),
            includedUserIds: parseIdList(row.included_user_ids),
            applyToUnrouted: row.apply_to_unrouted === 1,
        }));
    } catch (error) {
        // Missing table (migration not run yet) must never break announcements.
        logger.warn(`[LiveRouting] Rule lookup failed for guild ${guildId}: ${error.message}`, {
            category: 'streams', guildId
        });
        return [];
    }

    rulesCache.set(guildId, { value, expiresAt: Date.now() + RULES_TTL_MS });
    return value;
}

/**
 * The roles a rule matches on: its configured list, or — when it has none — every
 * integration-managed role whose name reads as a subscriber role (auto-detect).
 *
 * Booster roles are managed too but carry `premiumSubscriberRole` instead of an
 * integration id, so they can never be mistaken for a Twitch sub role.
 */
export async function resolveRuleRoleIds(guild, rule) {
    if (rule.roleIds) return new Set(rule.roleIds);

    const cached = roleCache.get(guild.id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let roles = guild.roles?.cache;
    if (!roles || roles.size <= 1) {
        roles = await guild.roles.fetch().catch(() => null);
    }

    const detected = new Set();
    if (roles) {
        for (const role of roles.values()) {
            if (!role.managed) continue;
            if (role.tags?.premiumSubscriberRole) continue;
            if (!role.tags?.integrationId) continue;
            if (!SUBSCRIBER_ROLE_NAME.test(role.name)) continue;
            detected.add(role.id);
        }
    }

    roleCache.set(guild.id, { value: detected, expiresAt: Date.now() + ROLE_TTL_MS });
    return detected;
}

/**
 * The member's CURRENT role ids, straight from Discord.
 *
 * A subscription that lapsed an hour ago may still be in the gateway member cache, so
 * this forces a REST fetch — the announcement channel must reflect which roles they hold
 * right now, not which ones they held when they were last cached.
 *
 * @returns {Promise<string[]|null>} role ids, or null when the member is gone from the guild
 */
async function fetchCurrentRoleIds(guild, member) {
    const key = `${guild.id}:${member.id}`;
    const cached = memberCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let roleIds;
    try {
        const fresh = await guild.members.fetch({ user: member.id, force: true });
        roleIds = [...fresh.roles.cache.keys()];
    } catch (error) {
        // 10007 Unknown Member (left the guild) / 10013 Unknown User (account gone):
        // either way they hold no roles here.
        if (error?.code === 10007 || error?.code === 10013) {
            roleIds = null;
        } else {
            // Transient failure (rate limit, network): fall back to what we already have
            // and don't cache it, so the next cycle retries the live check.
            logger.warn(`[LiveRouting] Live role check failed for ${member.id} in ${guild.id}: ${error.message}`, {
                category: 'streams', guildId: guild.id
            });
            return [...member.roles.cache.keys()];
        }
    }

    memberCache.set(key, { value: roleIds, expiresAt: Date.now() + MEMBER_TTL_MS });
    return roleIds;
}

/**
 * Which channel this member's live announcement belongs in, or null to leave it wherever
 * the subscription/team/guild-default chain already put it.
 *
 * @param {object} args
 * @param {import('discord.js').Guild} args.guild
 * @param {import('discord.js').GuildMember|null} args.member  streamer's member object
 * @param {string|null} args.currentChannelId  channel the announcement resolved to, if any
 * @returns {Promise<{channelId: string, rule: object}|null>}
 */
export async function resolveRoutedChannel({ guild, member, currentChannelId }) {
    // No member = no linked Discord account (or they left) = no roles to read.
    if (!guild || !member) return null;

    const rules = await getLiveRoutingRules(guild.id);
    if (rules.length === 0) return null;

    const isOwner = member.id === guild.ownerId;

    // Narrow to the rules that could still fire for this member before spending a REST
    // call on their roles.
    const candidates = rules.filter(rule => {
        if (!rule.channelId) return false;
        if (!currentChannelId && !rule.applyToUnrouted) return false;
        if (currentChannelId && rule.sourceChannelIds && !rule.sourceChannelIds.includes(currentChannelId)) return false;
        if (rule.excludeOwner && isOwner) return false;
        if (rule.excludedUserIds?.includes(member.id)) return false;
        if (rule.includedUserIds?.length && !rule.includedUserIds.includes(member.id)) return false;
        return true;
    });
    if (candidates.length === 0) return null;

    // Confirmed against Discord at post time — never against a stored subscription.
    // A rule with includedUserIds already matches on identity; it bypasses the role check.
    // Walk candidates in priority order and let user-id matches short-circuit.
    const userIdMatch = candidates.find(r => r.includedUserIds?.includes(member.id));
    if (userIdMatch) {
        return userIdMatch.channelId === currentChannelId ? null : { channelId: userIdMatch.channelId, rule: userIdMatch };
    }

    const currentRoleIds = await fetchCurrentRoleIds(guild, member);
    if (!currentRoleIds || currentRoleIds.length === 0) return null;

    for (const rule of candidates) {
        // Role-based rules only below this line (user-id rules handled above).
        if (rule.includedUserIds?.length) continue;
        const ruleRoleIds = await resolveRuleRoleIds(guild, rule);
        if (ruleRoleIds.size === 0) continue;
        if (!currentRoleIds.some(id => ruleRoleIds.has(id))) continue;
        return rule.channelId === currentChannelId ? null : { channelId: rule.channelId, rule };
    }

    return null;
}

export default { getLiveRoutingRules, resolveRuleRoleIds, resolveRoutedChannel, invalidateLiveRouting };
