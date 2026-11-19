/*
 * Stat-role rules: what can be tracked, how dashboard input is validated, and which roles a member
 * should gain or lose. Pure (no discord.js, no database) so tests/statrole-rules.test.js can run it
 * directly; core/statrole-manager.js loads the stats and applies the result.
 *
 * Only statistics the bot actually records are offered:
 *   messages          SUM(message_stats.message_count)     — every guild, every message
 *   voice_minutes     SUM(voice_activity.duration) / 60    — every guild, every finished voice session
 *   level             user_levels.level                    — guilds with leveling enabled
 *   invites           joins attributed to the member's invites (invite_tracker_logs, kept 180 days)
 *   account_age_days  days since the Discord account was created
 *   server_days       days since the member (last) joined this server
 */

export const STAT_TYPES = Object.freeze({
    messages: { label: 'Messages sent', unit: 'messages', source: 'db', max: 100_000_000 },
    voice_minutes: { label: 'Minutes in voice', unit: 'minutes', source: 'db', max: 100_000_000 },
    level: { label: 'Level (leveling system)', unit: 'level', source: 'db', max: 10_000 },
    invites: { label: 'Members invited', unit: 'invites', source: 'db', max: 1_000_000 },
    account_age_days: { label: 'Account age (days)', unit: 'days', source: 'member', max: 36_500 },
    server_days: { label: 'Days in this server', unit: 'days', source: 'member', max: 36_500 },
});

export const STAT_TYPE_KEYS = Object.freeze(Object.keys(STAT_TYPES));
export const DB_STAT_TYPES = Object.freeze(STAT_TYPE_KEYS.filter((k) => STAT_TYPES[k].source === 'db'));
export const MEMBER_STAT_TYPES = Object.freeze(STAT_TYPE_KEYS.filter((k) => STAT_TYPES[k].source === 'member'));
export const MAX_RULES_PER_GUILD = 50;

const DAY_MS = 86_400_000;

function truthy(v) {
    return v === true || v === 1 || v === '1' || v === 'on' || v === 'true';
}

/**
 * Validate the dashboard form. `input` is whatever express' urlencoded parser produced for
 * `configs[i][field]` — an array for small indexes, an object once qs passes its array limit.
 * Returns { rules, errors }. Unknown stat types, bad role ids and non-positive amounts are
 * reported rather than silently saved; duplicate role+stat pairs keep the last one (matching
 * the table's UNIQUE key).
 */
export function normaliseRuleRows(input, { validRoleIds = null } = {}) {
    const rows = Array.isArray(input) ? input : (input && typeof input === 'object' ? Object.values(input) : []);
    const errors = [];
    const byKey = new Map();

    rows.forEach((row, i) => {
        if (!row || typeof row !== 'object') return;
        const roleId = String(row.role_id ?? row.roleId ?? '').trim();
        const statType = String(row.stat_type ?? row.stat ?? '').trim();
        const amountRaw = row.required_amount ?? row.requiredValue ?? row.threshold;
        if (!roleId && !statType && (amountRaw === undefined || amountRaw === '')) return; // blank card

        if (!/^\d{15,25}$/.test(roleId)) {
            errors.push(`Rule ${i + 1}: pick a role.`);
            return;
        }
        if (validRoleIds && !validRoleIds.has(roleId)) {
            errors.push(`Rule ${i + 1}: that role no longer exists.`);
            return;
        }
        const spec = STAT_TYPES[statType];
        if (!spec) {
            errors.push(`Rule ${i + 1}: unknown statistic "${statType}".`);
            return;
        }
        const amount = Number(amountRaw);
        if (!Number.isInteger(amount) || amount < 1 || amount > spec.max) {
            errors.push(`Rule ${i + 1}: the required ${spec.unit} must be a whole number from 1 to ${spec.max.toLocaleString('en-US')}.`);
            return;
        }
        byKey.set(`${roleId}:${statType}`, {
            role_id: roleId,
            stat_type: statType,
            required_amount: amount,
            remove_below: truthy(row.remove_below) ? 1 : 0,
        });
    });

    const rules = [...byKey.values()];
    if (rules.length > MAX_RULES_PER_GUILD) {
        errors.push(`At most ${MAX_RULES_PER_GUILD} stat roles per server.`);
        return { rules: rules.slice(0, MAX_RULES_PER_GUILD), errors };
    }
    return { rules, errors };
}

/** Account age and days-in-server from timestamps (ms). Missing timestamps -> undefined. */
export function memberTimeStats({ createdTimestamp, joinedTimestamp }, nowMs) {
    const out = {};
    if (Number.isFinite(createdTimestamp)) out.account_age_days = Math.floor((nowMs - createdTimestamp) / DAY_MS);
    if (Number.isFinite(joinedTimestamp)) out.server_days = Math.floor((nowMs - joinedTimestamp) / DAY_MS);
    return out;
}

/** Smallest requirement per stat type — the cut-off for the sweep's aggregate queries. */
export function minimumByType(rules) {
    const min = {};
    for (const r of rules) {
        const t = r.stat_type;
        min[t] = min[t] === undefined ? Number(r.required_amount) : Math.min(min[t], Number(r.required_amount));
    }
    return min;
}

/**
 * Decide role changes for one member.
 *
 * @param {object} args
 * @param {Array}  args.rules        statrole_configs rows for the guild
 * @param {object} args.stats        { statType: number } — a type that is absent is UNKNOWN
 * @param {Set}    args.heldRoles    role ids the member currently has
 * @param {Set}    args.grantedRoles role ids the bot granted this member (statrole_grants)
 * @returns {{ add: Array<{roleId, rule, value}>, remove: string[] }}
 *
 * A role is earned when ANY of its rules is met. It is removed only when the bot granted it, at
 * least one of its rules opts into removal, every one of its rules has a known value, and none is
 * met — an unknown stat must never cost anyone a role.
 */
export function evaluateMember({ rules, stats, heldRoles, grantedRoles = new Set() }) {
    const byRole = new Map();
    for (const rule of rules) {
        if (!STAT_TYPES[rule.stat_type]) continue;
        if (!byRole.has(rule.role_id)) byRole.set(rule.role_id, []);
        byRole.get(rule.role_id).push(rule);
    }

    const add = [];
    const remove = [];
    for (const [roleId, roleRules] of byRole) {
        let met = null;
        let allKnown = true;
        for (const rule of roleRules) {
            const value = stats[rule.stat_type];
            if (value === undefined || value === null || Number.isNaN(Number(value))) {
                allKnown = false;
                continue;
            }
            if (Number(value) >= Number(rule.required_amount) && !met) met = { rule, value: Number(value) };
        }

        if (met) {
            if (!heldRoles.has(roleId)) add.push({ roleId, rule: met.rule, value: met.value });
        } else if (
            allKnown
            && heldRoles.has(roleId)
            && grantedRoles.has(roleId)
            && roleRules.some((r) => Number(r.remove_below) === 1)
        ) {
            remove.push(roleId);
        }
    }
    return { add, remove };
}

export function describeRule(rule) {
    const spec = STAT_TYPES[rule.stat_type];
    if (!spec) return `${rule.required_amount} ${rule.stat_type}`;
    if (rule.stat_type === 'level') return `level ${rule.required_amount}`;
    return `${Number(rule.required_amount).toLocaleString('en-US')} ${spec.unit}${rule.stat_type.endsWith('_days') ? (rule.stat_type === 'server_days' ? ' in the server' : ' account age') : ''}`;
}

export default {
    STAT_TYPES, STAT_TYPE_KEYS, DB_STAT_TYPES, MEMBER_STAT_TYPES, MAX_RULES_PER_GUILD,
    normaliseRuleRows, memberTimeStats, minimumByType, evaluateMember, describeRule,
};
