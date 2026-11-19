/*
 * Pure helpers for sticky roles (core/sticky-roles-manager.js). Unit-tested in
 * tests/sticky-roles.test.js. Roles are passed in as plain objects so no discord.js is needed:
 *   { id, managed, editable }   — `editable` is discord.js Role#editable (below the bot's top role)
 */

export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 365;

/** guilds.sticky_roles_retention_days → a usable number of days (NULL/garbage → default). */
export function retentionDays(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_RETENTION_DAYS;
    return Math.min(n, MAX_RETENTION_DAYS);
}

/** A JSON array (or legacy comma list) of role ids → array of snowflake strings. */
export function parseRoleIdList(raw) {
    if (!raw) return [];
    let list = raw;
    if (typeof raw === 'string') {
        const t = raw.trim();
        if (t.startsWith('[')) {
            try { list = JSON.parse(t); } catch { return []; }
        } else {
            list = t.split(',');
        }
    }
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map(v => String(v).trim()).filter(v => /^\d{15,25}$/.test(v)))];
}

/**
 * The role ids worth saving when a member leaves: everything except @everyone (id === guild id),
 * managed roles (boosts, bots, integrations — Discord assigns those itself) and excluded roles.
 * Roles above the bot ARE saved; whether they can be given back is decided at restore time,
 * because the hierarchy may have changed by then.
 */
export function rolesToSave(roles, guildId, excludeIds = []) {
    const exclude = new Set(excludeIds);
    return (roles || [])
        .filter(r => r && r.id && r.id !== guildId && !r.managed && !exclude.has(r.id))
        .map(r => r.id);
}

/**
 * Split saved role ids into the ones to give back and the ones skipped, with the reason.
 * @param {string[]} savedIds
 * @param {{guildId:string, roles:Map<string,{id,managed,editable}>, memberRoleIds:Set<string>, excludeIds:string[]}} ctx
 */
export function partitionRestorable(savedIds, { guildId, roles, memberRoleIds = new Set(), excludeIds = [] }) {
    const exclude = new Set(excludeIds);
    const restore = [];
    const skipped = { missing: [], managed: [], excluded: [], tooHigh: [], already: [] };
    for (const id of [...new Set(savedIds || [])]) {
        if (id === guildId) continue;
        const role = roles.get(id);
        if (!role) { skipped.missing.push(id); continue; }
        if (role.managed) { skipped.managed.push(id); continue; }
        if (exclude.has(id)) { skipped.excluded.push(id); continue; }
        if (!role.editable) { skipped.tooHigh.push(id); continue; }
        if (memberRoleIds.has(id)) { skipped.already.push(id); continue; }
        restore.push(id);
    }
    return { restore, skipped };
}

/** Human summary of the skipped roles for the log embed. */
export function describeSkipped(skipped) {
    const parts = [];
    if (skipped.tooHigh.length) parts.push(`${skipped.tooHigh.length} above the bot's highest role`);
    if (skipped.excluded.length) parts.push(`${skipped.excluded.length} on the exclude list`);
    if (skipped.missing.length) parts.push(`${skipped.missing.length} deleted since`);
    if (skipped.managed.length) parts.push(`${skipped.managed.length} managed by an integration`);
    return parts.join(', ');
}
