/*
 * Auto-prune — the rules, with no Discord or database in them (the live side is core/auto-prune.js).
 *
 * A member who still has no "real" role N minutes after joining is removed. A real role is any role
 * that is not a bypass role. Bypass roles are the ones members get without anybody choosing them:
 * the server's own list, plus the roles this bot hands out automatically (the verification gate's
 * Unverified role, the temporary-access guest role, autoroles). @everyone never counts. Managed roles
 * (Nitro booster, a synced Twitch sub) DO count: a booster is not an idle bot account.
 *
 * Only joins after the feature was switched on are tracked, and switching it off clears the queue.
 */

export const PRUNE_ACTIONS = ['kick', 'log'];
// 10 minutes to 14 days (it was 24 hours: too short to give people a week to accept the rules).
export const PRUNE_LIMITS = Object.freeze({ minutes: [10, 20160] });
export const PRUNE_DEFAULT_MINUTES = 240;
export const MAX_BYPASS_ROLES = 25;

const snowflake = (v) => (v != null && /^\d{15,25}$/.test(String(v)) ? String(v) : null);

/** A stored role list: JSON array, or a hand-edited comma list. Ids only, deduplicated. */
export function parseRoleList(raw) {
    if (raw == null || raw === '') return [];
    let list;
    if (Array.isArray(raw)) list = raw;
    else {
        try { list = JSON.parse(raw); } catch { list = String(raw).split(','); }
        if (!Array.isArray(list)) list = [];
    }
    return [...new Set(list.map(v => snowflake(String(v).trim())).filter(Boolean))];
}

/** The join_gate_config row (or null) as auto-prune settings. */
export function normalisePruneConfig(row) {
    const minutes = Number.parseInt(row?.prune_minutes, 10);
    const enabledAt = row?.prune_enabled_at ? new Date(row.prune_enabled_at).getTime() : null;
    return {
        enabled: !!row?.prune_enabled,
        minutes: Number.isFinite(minutes)
            ? Math.min(PRUNE_LIMITS.minutes[1], Math.max(PRUNE_LIMITS.minutes[0], minutes))
            : PRUNE_DEFAULT_MINUTES,
        action: PRUNE_ACTIONS.includes(row?.prune_action) ? row.prune_action : 'kick',
        dm: row?.prune_dm == null ? true : !!row.prune_dm,
        bypassRoleIds: parseRoleList(row?.prune_bypass_roles),
        enabledAt: Number.isFinite(enabledAt) ? enabledAt : null,
    };
}

/**
 * A settings change as join_gate_config columns. `wasEnabled` decides whether switching on starts a
 * new tracking period (prune_enabled_at) — re-saving an enabled config must not move it.
 * @returns {{ patch: Record<string, any>, errors: string[], turnedOn: boolean, turnedOff: boolean }}
 */
export function validatePruneSettings(input = {}, { wasEnabled = false } = {}) {
    const patch = {};
    const errors = [];
    if (input.minutes !== undefined) {
        const n = Number(input.minutes);
        const [lo, hi] = PRUNE_LIMITS.minutes;
        if (!Number.isInteger(n) || n < lo || n > hi) errors.push(`The time limit must be ${lo} minutes to ${hi / 1440} days.`);
        else patch.prune_minutes = n;
    }
    if (input.action !== undefined) {
        if (!PRUNE_ACTIONS.includes(input.action)) errors.push('The action must be "kick" or "log".');
        else patch.prune_action = input.action;
    }
    if (input.dm !== undefined) patch.prune_dm = input.dm ? 1 : 0;
    if (input.bypassRoleIds !== undefined) {
        const list = parseRoleList(Array.isArray(input.bypassRoleIds) ? input.bypassRoleIds : []);
        if (list.length > MAX_BYPASS_ROLES) errors.push(`Up to ${MAX_BYPASS_ROLES} bypass roles.`);
        else patch.prune_bypass_roles = JSON.stringify(list);
    }
    let turnedOn = false;
    let turnedOff = false;
    if (input.enabled !== undefined) {
        patch.prune_enabled = input.enabled ? 1 : 0;
        turnedOn = !!input.enabled && !wasEnabled;
        turnedOff = !input.enabled && !!wasEnabled;
    }
    return { patch, errors, turnedOn, turnedOff };
}

/** Every role id that does not count as "real" for this server. */
export function bypassSet({ bypassRoleIds = [], systemRoleIds = [], everyoneId = null } = {}) {
    return new Set([...bypassRoleIds, ...systemRoleIds, everyoneId].filter(Boolean).map(String));
}

/** Does the member hold a role that counts? */
export function hasRealRole(memberRoleIds, bypass) {
    return (memberRoleIds || []).some(id => !bypass.has(String(id)));
}

/** The first role in `addedRoleIds` that counts, or null. */
export function firstRealRole(addedRoleIds, bypass) {
    return (addedRoleIds || []).find(id => !bypass.has(String(id))) ?? null;
}

/**
 * Should this join go on the queue?
 * @returns {{ track: boolean, why: 'off'|'bot'|'before-enabled'|'has-role'|'tracked' }}
 */
export function shouldTrack({ cfg, isBot, joinedAtMs, memberRoleIds, bypass }) {
    if (!cfg?.enabled) return { track: false, why: 'off' };
    if (isBot) return { track: false, why: 'bot' };
    if (cfg.enabledAt != null && Number.isFinite(joinedAtMs) && joinedAtMs < cfg.enabledAt) return { track: false, why: 'before-enabled' };
    if (hasRealRole(memberRoleIds, bypass)) return { track: false, why: 'has-role' };
    return { track: true, why: 'tracked' };
}

/**
 * What happens to a queued member at their deadline.
 * @returns {'cancelled'|'left'|'passed'|'exempt'|'kick'|'log'}
 */
export function pruneVerdict({ cfg, inGuild, memberRoleIds, bypass, elevated }) {
    if (!cfg?.enabled) return 'cancelled';
    if (!inGuild) return 'left';
    if (hasRealRole(memberRoleIds, bypass)) return 'passed';
    if (elevated) return 'exempt';
    return cfg.action === 'log' ? 'log' : 'kick';
}

/** "4 h", "90 min" -> "1 h 30 min", "24 h", "7 d", "2 d 6 h" (a whole number of days from 2 days up). */
export function formatMinutes(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m >= 2880) {
        const d = Math.floor(m / 1440);
        const h = Math.round((m % 1440) / 60);
        return h ? `${d} d ${h} h` : `${d} d`;
    }
    const h = Math.floor(m / 60);
    const rest = m % 60;
    if (!h) return `${rest} min`;
    return rest ? `${h} h ${rest} min` : `${h} h`;
}

export default {
    PRUNE_ACTIONS, PRUNE_LIMITS, PRUNE_DEFAULT_MINUTES, MAX_BYPASS_ROLES, parseRoleList, normalisePruneConfig,
    validatePruneSettings, bypassSet, hasRealRole, firstRealRole, shouldTrack, pruneVerdict, formatMinutes,
};
