/*
 * Stat roles: grant a role when a member reaches a milestone (statrole_configs), and — only where
 * a rule opts in with remove_below — take it back when they no longer meet it.
 *
 * Three ways a member gets evaluated:
 *   noteMemberActivity(member, 'message')  from events/messageCreate.js, at most once per member per
 *                                          5 minutes; checks message/level/time-based rules
 *   noteMemberActivity(member, 'voice')    from events/voiceStateUpdate.js when a voice session ends
 *   noteMemberActivity(member, 'join')     from events/guildMemberAdd.js; everything (a returning
 *                                          member gets their earned roles back straight away)
 * plus sweepAllGuilds() every 15 minutes (jobs/statrole-scheduler.js), which finds qualifying members
 * with one aggregate query per stat type — so members who earned a role while the bot was down, or
 * who never trigger an event (invites, account age), are caught too.
 *
 * Guilds without rules cost one cached lookup per minute and nothing else. Rules come from the
 * dashboard (?page=stat-roles); replaceGuildRules() is the save path.
 */
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { reportRoleAssignmentFailure } from './role-hierarchy-notifier.js';
import {
    STAT_TYPES, DB_STAT_TYPES, MEMBER_STAT_TYPES, normaliseRuleRows, memberTimeStats, minimumByType,
    evaluateMember, describeRule,
} from './statrole-rules.js';

const RULE_CACHE_MS = 60_000;
const EMPTY_RULE_CACHE_MS = 5 * 60_000;
const MESSAGE_DEBOUNCE_MS = 5 * 60_000;
const FULL_SCAN_INTERVAL_MS = 6 * 60 * 60_000;
const FULL_SCAN_MAX_MEMBERS = 25_000;
const MAX_CHANGES_PER_GUILD_SWEEP = 100;
const UNMANAGEABLE_WARN_MS = 60 * 60_000;

const TRIGGER_TYPES = {
    message: ['messages', 'level', 'account_age_days', 'server_days'],
    voice: ['voice_minutes'],
    join: Object.keys(STAT_TYPES),
};

const ruleCache = new Map();      // guildId -> { rules, expires }
const lastEval = new Map();       // `${guildId}:${userId}` -> ms
const inFlight = new Set();       // `${guildId}:${userId}`
const lastFullScan = new Map();   // guildId -> ms
const unmanageableWarned = new Map(); // `${guildId}:${roleId}` -> ms

// ── Rules ───────────────────────────────────────────────────────────────────────────────────

export async function getRules(guildId) {
    const hit = ruleCache.get(guildId);
    if (hit && hit.expires > Date.now()) return hit.rules;
    const [rows] = await pool.execute(
        'SELECT id, role_id, stat_type, required_amount, remove_below FROM statrole_configs WHERE guild_id = ?',
        [guildId]
    );
    const rules = rows.filter((r) => STAT_TYPES[r.stat_type]);
    ruleCache.set(guildId, { rules, expires: Date.now() + (rules.length ? RULE_CACHE_MS : EMPTY_RULE_CACHE_MS) });
    return rules;
}

export function invalidateRules(guildId) {
    ruleCache.delete(guildId);
}

/**
 * Dashboard save: validate, then replace the guild's rules in one transaction. Returns
 * { saved, errors }; nothing is written if any row is invalid. A sweep of the guild is started in
 * the background so new rules take effect without waiting for the next 15-minute run.
 */
export async function replaceGuildRules(guildId, input, { guild = null } = {}) {
    const validRoleIds = guild?.roles?.cache ? new Set(guild.roles.cache.keys()) : null;
    const { rules, errors } = normaliseRuleRows(input, { validRoleIds });
    if (errors.length) return { saved: 0, errors };

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute('DELETE FROM statrole_configs WHERE guild_id = ?', [guildId]);
        for (const r of rules) {
            await conn.execute(
                'INSERT INTO statrole_configs (guild_id, role_id, stat_type, required_amount, remove_below) VALUES (?, ?, ?, ?, ?)',
                [guildId, r.role_id, r.stat_type, r.required_amount, r.remove_below]
            );
        }
        // Grants for roles that no longer have any rule are forgotten (the roles themselves stay).
        if (rules.length) {
            await conn.query(
                'DELETE FROM statrole_grants WHERE guild_id = ? AND role_id NOT IN (?)',
                [guildId, [...new Set(rules.map((r) => r.role_id))]]
            );
        } else {
            await conn.execute('DELETE FROM statrole_grants WHERE guild_id = ?', [guildId]);
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }

    invalidateRules(guildId);
    lastFullScan.delete(guildId);
    if (rules.length) {
        const client = globalThis.botManager?.getClientForGuild?.(guildId);
        const g = guild || client?.guilds?.cache?.get(guildId);
        if (g) {
            sweepGuild(g).catch((err) => logger.error(`[StatRoles] Post-save sweep failed: ${err.message}`, { guildId }));
        }
    }
    logger.info(`[StatRoles] Saved ${rules.length} rule(s)`, { guildId });
    return { saved: rules.length, errors: [] };
}

// ── Stats ───────────────────────────────────────────────────────────────────────────────────

const MEMBER_QUERIES = {
    messages: 'SELECT COALESCE(SUM(message_count), 0) AS v FROM message_stats WHERE guild_id = ? AND user_id = ?',
    voice_minutes: 'SELECT COALESCE(FLOOR(SUM(duration) / 60), 0) AS v FROM voice_activity WHERE guild_id = ? AND user_id = ?',
    level: 'SELECT COALESCE(MAX(level), 0) AS v FROM user_levels WHERE guild_id = ? AND user_id = ?',
    invites: "SELECT COUNT(*) AS v FROM invite_tracker_logs WHERE guild_id = ? AND inviter_id = ? AND event_type = 'join'",
};

/** Members at or above `min` for a DB-backed stat, with their value. */
const SWEEP_QUERIES = {
    messages: `SELECT user_id, SUM(message_count) AS v FROM message_stats
                WHERE guild_id = ? GROUP BY user_id HAVING v >= ?`,
    voice_minutes: `SELECT user_id, FLOOR(SUM(duration) / 60) AS v FROM voice_activity
                     WHERE guild_id = ? AND user_id IS NOT NULL GROUP BY user_id HAVING v >= ?`,
    level: `SELECT user_id, MAX(level) AS v FROM user_levels
             WHERE guild_id = ? AND level >= ? GROUP BY user_id`,
    invites: `SELECT inviter_id AS user_id, COUNT(*) AS v FROM invite_tracker_logs
               WHERE guild_id = ? AND event_type = 'join' GROUP BY inviter_id HAVING v >= ?`,
};

async function loadMemberStats(member, types) {
    const stats = memberTimeStats({ createdTimestamp: member.user?.createdTimestamp, joinedTimestamp: member.joinedTimestamp }, Date.now());
    for (const t of MEMBER_STAT_TYPES) if (!types.includes(t)) delete stats[t];
    for (const t of types) {
        if (!MEMBER_QUERIES[t]) continue;
        const [[row]] = await pool.execute(MEMBER_QUERIES[t], [member.guild.id, member.id]);
        stats[t] = Number(row?.v) || 0;
    }
    return stats;
}

async function grantedRolesFor(guildId, userId) {
    const [rows] = await pool.execute('SELECT role_id FROM statrole_grants WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    return new Set(rows.map((r) => r.role_id));
}

// ── Applying changes ────────────────────────────────────────────────────────────────────────

function unmanageableReason(guild, role) {
    const me = guild.members.me;
    if (!me) return 'bot member not cached';
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'bot lacks Manage Roles';
    if (role.managed) return 'role is managed by an integration';
    if (role.id === guild.id) return 'cannot assign @everyone';
    if (role.comparePositionTo(me.roles.highest) >= 0) return "role is above the bot's highest role";
    return null;
}

function warnUnmanageable(guild, role, reason) {
    const key = `${guild.id}:${role.id}`;
    const last = unmanageableWarned.get(key) || 0;
    if (Date.now() - last < UNMANAGEABLE_WARN_MS) return;
    unmanageableWarned.set(key, Date.now());
    logger.warn(`[StatRoles] Cannot manage role ${role.name} (${role.id}): ${reason}`, { guildId: guild.id });
}

/** Apply one member's decided changes. Returns how many role writes were made. */
async function applyChanges(member, { add, remove }) {
    const guild = member.guild;
    let writes = 0;

    for (const { roleId, rule, value } of add) {
        const role = guild.roles.cache.get(roleId);
        if (!role) continue;
        const reason = unmanageableReason(guild, role);
        if (reason) {
            warnUnmanageable(guild, role, reason);
            continue;
        }
        try {
            await member.roles.add(role, `Stat role: reached ${describeRule(rule)}`);
            writes++;
            await pool.execute(
                `INSERT INTO statrole_grants (guild_id, user_id, role_id, stat_type, stat_value)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE stat_type = VALUES(stat_type), stat_value = VALUES(stat_value), granted_at = CURRENT_TIMESTAMP`,
                [guild.id, member.id, roleId, rule.stat_type, Math.round(value)]
            );
            logger.info(`[StatRoles] Granted ${role.name} to ${member.user?.tag || member.id} (${describeRule(rule)})`, { guildId: guild.id, userId: member.id });
        } catch (err) {
            logger.error(`[StatRoles] Failed to grant ${role.name}: ${err.message}`, { guildId: guild.id, userId: member.id, code: err.code });
            await reportRoleAssignmentFailure({ guild, role, error: err, action: 'add' });
        }
    }

    for (const roleId of remove) {
        const role = guild.roles.cache.get(roleId);
        if (!role) {
            await pool.execute('DELETE FROM statrole_grants WHERE guild_id = ? AND user_id = ? AND role_id = ?', [guild.id, member.id, roleId]);
            continue;
        }
        const reason = unmanageableReason(guild, role);
        if (reason) {
            warnUnmanageable(guild, role, reason);
            continue;
        }
        try {
            await member.roles.remove(role, 'Stat role: requirement no longer met');
            writes++;
            await pool.execute('DELETE FROM statrole_grants WHERE guild_id = ? AND user_id = ? AND role_id = ?', [guild.id, member.id, roleId]);
            logger.info(`[StatRoles] Removed ${role.name} from ${member.user?.tag || member.id}`, { guildId: guild.id, userId: member.id });
        } catch (err) {
            logger.error(`[StatRoles] Failed to remove ${role.name}: ${err.message}`, { guildId: guild.id, userId: member.id, code: err.code });
            await reportRoleAssignmentFailure({ guild, role, error: err, action: 'remove' });
        }
    }
    return writes;
}

/** Evaluate one member against the guild's rules, limited to the given stat types. */
export async function evaluateGuildMember(member, types = Object.keys(STAT_TYPES)) {
    if (!member?.guild || member.user?.bot) return 0;
    const rules = await getRules(member.guild.id);
    const relevant = rules.filter((r) => types.includes(r.stat_type));
    if (!relevant.length) return 0;

    const needed = [...new Set(relevant.map((r) => r.stat_type))];
    const stats = await loadMemberStats(member, needed);
    const granted = await grantedRolesFor(member.guild.id, member.id);
    // Rules of types not loaded stay unknown, so their roles are never removed on a partial check.
    const decision = evaluateMember({ rules, stats, heldRoles: new Set(member.roles.cache.keys()), grantedRoles: granted });
    if (!decision.add.length && !decision.remove.length) return 0;
    return applyChanges(member, decision);
}

/**
 * Cheap hook for gateway events. Never throws and never blocks the caller; guilds with no rules
 * return on a cached lookup.
 */
export function noteMemberActivity(member, trigger = 'message') {
    try {
        if (!member?.guild || member.user?.bot) return;
        const guildId = member.guild.id;
        const cached = ruleCache.get(guildId);
        if (cached && cached.expires > Date.now() && !cached.rules.length) return;

        const key = `${guildId}:${member.id}`;
        const now = Date.now();
        if (trigger === 'message') {
            const last = lastEval.get(key);
            if (last && now - last < MESSAGE_DEBOUNCE_MS) return;
        }
        if (inFlight.has(key)) return;
        lastEval.set(key, now);
        if (lastEval.size > 50_000) {
            for (const [k, t] of lastEval) if (now - t > MESSAGE_DEBOUNCE_MS) lastEval.delete(k);
        }

        inFlight.add(key);
        evaluateGuildMember(member, TRIGGER_TYPES[trigger] || TRIGGER_TYPES.join)
            .catch((err) => logger.warn(`[StatRoles] Evaluation failed: ${err.message}`, { guildId, userId: member.id, trigger }))
            .finally(() => inFlight.delete(key));
    } catch (err) {
        logger.warn(`[StatRoles] noteMemberActivity failed: ${err.message}`);
    }
}

// ── Sweep ───────────────────────────────────────────────────────────────────────────────────

/** Fetch members by id in chunks. `complete` is false if any chunk failed (absence then means nothing). */
async function fetchMembers(guild, ids) {
    const members = new Map();
    let complete = true;
    for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        try {
            const fetched = await guild.members.fetch({ user: chunk, time: 20_000 });
            for (const [id, m] of fetched) members.set(id, m);
        } catch (err) {
            complete = false;
            logger.warn(`[StatRoles] Member fetch failed: ${err.message}`, { guildId: guild.id, count: chunk.length });
        }
    }
    return { members, complete };
}

/** Full evaluation of one guild. Returns the number of role writes. */
export async function sweepGuild(guild) {
    const rules = await getRules(guild.id);
    if (!rules.length) return 0;

    const types = new Set(rules.map((r) => r.stat_type));
    const mins = minimumByType(rules);
    const dbValues = new Map(); // userId -> { type: value }

    for (const t of DB_STAT_TYPES) {
        if (!types.has(t)) continue;
        const [rows] = await pool.execute(SWEEP_QUERIES[t], [guild.id, mins[t]]);
        for (const row of rows) {
            const id = String(row.user_id);
            if (!dbValues.has(id)) dbValues.set(id, {});
            dbValues.get(id)[t] = Number(row.v) || 0;
        }
    }

    const [grantRows] = await pool.execute('SELECT user_id, role_id FROM statrole_grants WHERE guild_id = ?', [guild.id]);
    const grants = new Map();
    for (const g of grantRows) {
        if (!grants.has(g.user_id)) grants.set(g.user_id, new Set());
        grants.get(g.user_id).add(g.role_id);
    }

    let members;
    let membersComplete = false;
    const hasTimeRules = MEMBER_STAT_TYPES.some((t) => types.has(t));
    const fullScanDue = hasTimeRules
        && Date.now() - (lastFullScan.get(guild.id) || 0) >= FULL_SCAN_INTERVAL_MS
        && (guild.memberCount || 0) <= FULL_SCAN_MAX_MEMBERS;
    if (fullScanDue) {
        try {
            members = new Map(await guild.members.fetch({ time: 120_000 }));
            membersComplete = true;
            lastFullScan.set(guild.id, Date.now());
        } catch (err) {
            logger.warn(`[StatRoles] Full member fetch failed: ${err.message}`, { guildId: guild.id });
        }
    }
    if (!members) {
        const ids = [...new Set([...dbValues.keys(), ...grants.keys()])];
        const fetched = await fetchMembers(guild, ids);
        members = fetched.members;
        membersComplete = fetched.complete;
    }

    const now = Date.now();
    let writes = 0;
    for (const [userId, member] of members) {
        if (writes >= MAX_CHANGES_PER_GUILD_SWEEP) break;
        if (member.user?.bot) continue;
        // A member missing from an aggregate is below the smallest requirement for that type:
        // a known 0 for decision purposes, not "unknown".
        const stats = { ...memberTimeStats({ createdTimestamp: member.user?.createdTimestamp, joinedTimestamp: member.joinedTimestamp }, now) };
        for (const t of DB_STAT_TYPES) if (types.has(t)) stats[t] = dbValues.get(userId)?.[t] ?? 0;

        const decision = evaluateMember({
            rules, stats, heldRoles: new Set(member.roles.cache.keys()), grantedRoles: grants.get(userId) || new Set(),
        });
        if (!decision.add.length && !decision.remove.length) continue;
        try {
            writes += await applyChanges(member, decision);
        } catch (err) {
            logger.error(`[StatRoles] Applying changes failed: ${err.message}`, { guildId: guild.id, userId });
        }
    }

    // Grants for members who have left: forget them (their roles left with them). Absence only
    // counts when every member fetch succeeded — a failed chunk must not look like a departure.
    const goneIds = [...grants.keys()].filter((id) => !members.has(id));
    if (goneIds.length && membersComplete) {
        await pool.query('DELETE FROM statrole_grants WHERE guild_id = ? AND user_id IN (?)', [guild.id, goneIds]);
    }

    if (writes) logger.info(`[StatRoles] Sweep made ${writes} role change(s)`, { guildId: guild.id });
    return writes;
}

export async function sweepAllGuilds(fallbackClient = null) {
    const [rows] = await pool.execute('SELECT DISTINCT guild_id FROM statrole_configs');
    let total = 0;
    for (const { guild_id: guildId } of rows) {
        const client = globalThis.botManager?.getClientForGuild?.(guildId) || fallbackClient;
        const guild = client?.guilds?.cache?.get(guildId);
        if (!guild) continue;
        try {
            total += await sweepGuild(guild);
        } catch (err) {
            logger.error(`[StatRoles] Sweep failed: ${err.message}`, { guildId });
        }
    }
    return total;
}

export default {
    getRules, invalidateRules, replaceGuildRules, evaluateGuildMember, noteMemberActivity,
    sweepGuild, sweepAllGuilds,
};
