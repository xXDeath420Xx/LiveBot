/*
 * Protection exemptions, bot managers and the global pause — the pure rules (no Discord or DB access,
 * unit-tested in tests/protection-exempt.test.js). The live side is core/protection-exempt.js.
 *
 * Every automated protection (join gate, spammer check, raid, global ban, phishing, self-bot,
 * anti-nuke, automod, adaptive spam, commission and link filters) asks one question before it acts:
 * "should I hold this?" Two things make the answer yes:
 *
 *   exempt   the member is a bot, the server owner, holds a bot-manager role, is on the server's
 *            protection allowlist (as a user, or through an allowlisted role), or once held an
 *            allowlisted role. That last one is deliberate (Hashbot does the same): taking the role
 *            off someone — an attacker's first move after compromising a staff account is often to
 *            shuffle roles — must not suddenly expose them to automatic bans. Staff clear it
 *            explicitly once the member no longer holds the role.
 *   paused   the server has paused enforcement. Protections still detect and log ("paused — would
 *            have banned"); they take no action at all, message removals included, until resumed
 *            or the optional auto-resume time passes.
 *
 * The per-feature lists (automod whitelist, anti-nuke whitelist, self-bot exempt roles, commission
 * exemptions, spammer allowlist…) are untouched; this is checked in addition to them.
 */

export const EXEMPT_REASONS = Object.freeze({
    bot: 'a bot',
    owner: 'the server owner',
    manager: 'holds a bot-manager role',
    'allowlist-user': 'on the protection allowlist',
    'allowlist-role': 'holds an allowlisted role',
    'once-held-role': 'once held an allowlisted role',
});

/** Human text for an exemption reason. */
export function whyText(why) {
    return EXEMPT_REASONS[why] ?? 'exempt';
}

const asSet = (v) => (v instanceof Set ? v : new Set(v || []));
const asMap = (v) => (v instanceof Map ? v : new Map(Object.entries(v || {})));

/**
 * Is this member exempt from automated protections?
 * @param {{ id:string, bot?:boolean, owner?:boolean, roleIds?:string[] }} subject
 * @param {{ users?:Set|string[], roles?:Set|string[], managers?:Set|string[], seen?:Map|object }} lists
 *        seen: userId -> the allowlisted role they were recorded holding
 * @param {{ exemptBots?: boolean }} [opts] anti-nuke passes exemptBots:false — a rogue bot deleting
 *        channels is the classic nuke, so bots must stay in scope there.
 * @returns {{ exempt:boolean, why:string|null, roleId:string|null, record:string|null }}
 *        record: an allowlisted role the caller should remember them holding (once-held rule).
 */
export function decideExempt(subject, lists = {}, { exemptBots = true } = {}) {
    const none = { exempt: false, why: null, roleId: null, record: null };
    if (!subject?.id) return none;
    const users = asSet(lists.users);
    const roles = asSet(lists.roles);
    const managers = asSet(lists.managers);
    const seen = asMap(lists.seen);
    const roleIds = subject.roleIds || [];

    if (subject.bot && exemptBots) return { ...none, exempt: true, why: 'bot' };
    if (subject.owner) return { ...none, exempt: true, why: 'owner' };
    const managerRole = roleIds.find(r => managers.has(r));
    if (managerRole) return { ...none, exempt: true, why: 'manager', roleId: managerRole };
    if (users.has(subject.id)) return { ...none, exempt: true, why: 'allowlist-user' };
    const allowRole = roleIds.find(r => roles.has(r));
    if (allowRole) {
        return { exempt: true, why: 'allowlist-role', roleId: allowRole, record: seen.has(subject.id) ? null : allowRole };
    }
    // Only while that role is still allowlisted: removing a role from the allowlist withdraws it.
    const heldRole = seen.get(subject.id);
    if (heldRole && roles.has(heldRole)) return { ...none, exempt: true, why: 'once-held-role', roleId: heldRole };
    return none;
}

/** Holds a bot-manager role? */
export function isManagerRoles(roleIds, managers) {
    const set = asSet(managers);
    return (roleIds || []).some(r => set.has(r));
}

/**
 * Where a server's pause stands at `now`.
 * @param {{ enforcement_paused?:number|boolean, paused_until?:Date|string|null }|null} settings
 * @returns {{ paused:boolean, until:Date|null, expired:boolean }}
 *          expired: it was paused with an auto-resume time that has passed (the caller clears it).
 */
export function pauseState(settings, now = Date.now()) {
    if (!settings || !Number(settings.enforcement_paused)) return { paused: false, until: null, expired: false };
    const until = settings.paused_until ? new Date(settings.paused_until) : null;
    const valid = until && !Number.isNaN(until.getTime());
    if (valid && until.getTime() <= now) return { paused: false, until, expired: true };
    return { paused: true, until: valid ? until : null, expired: false };
}

export const MIN_PAUSE_MS = 60_000;
export const MAX_PAUSE_MS = 30 * 24 * 3600_000;
const UNIT_MS = { m: 60_000, h: 3600_000, d: 86_400_000, w: 604_800_000 };
const PART = /(\d+)(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)/g;

/**
 * '30m', '2h', '1d', '1w', '1h30m', '90' (minutes). Empty = no end (paused until resumed).
 * @returns {{ ok:true, ms:number|null } | { ok:false, error:string }}
 */
export function parseDuration(text) {
    const s = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return { ok: true, ms: null };
    let ms = 0;
    if (/^\d+$/.test(s)) {
        ms = Number(s) * UNIT_MS.m;
    } else {
        const parts = [...s.matchAll(PART)];
        const consumed = parts.reduce((n, p) => n + p[0].length, 0);
        if (!parts.length || consumed !== s.length) {
            return { ok: false, error: 'Use a length like 30m, 2h, 1d or 1h30m.' };
        }
        for (const p of parts) ms += Number(p[1]) * UNIT_MS[p[2][0]];
    }
    if (ms < MIN_PAUSE_MS) return { ok: false, error: 'The shortest pause is 1 minute.' };
    if (ms > MAX_PAUSE_MS) return { ok: false, error: 'The longest timed pause is 30 days. Leave the length empty to pause until resumed.' };
    return { ok: true, ms };
}

/** 5400000 -> '1h 30m'. */
export function formatDuration(ms) {
    let rest = Math.max(0, Math.round(Number(ms) / 60_000));
    const parts = [];
    for (const [unit, size] of [['d', 1440], ['h', 60], ['m', 1]]) {
        const n = Math.floor(rest / size);
        if (n) parts.push(`${n}${unit}`);
        rest -= n * size;
    }
    return parts.join(' ') || '0m';
}

const PAST = {
    ban: 'banned them', kick: 'kicked them', timeout: 'timed them out', mute: 'timed them out',
    lockdown: 'timed them out', strip: 'removed their roles', flag: 'given them the flag role',
    warn: 'warned them', delete: 'deleted the message', purge: 'purged their recent messages',
    remove: 'removed them',
};

/** 'ban' -> 'banned them'. */
export function pastTense(action) {
    return PAST[action] ?? `done '${action}'`;
}

/**
 * The decision every protection asks for. null = go ahead.
 * @param {{ exempt?: { exempt:boolean, why:string|null }, paused?: boolean, action:string, source:string }} p
 * @returns {null | { why:'exempt'|'paused', reason:string|null, text:string }}
 */
export function holdDecision({ exempt, paused, action, source }) {
    if (exempt?.exempt) {
        return { why: 'exempt', reason: exempt.why, text: `${source}: skipped (${whyText(exempt.why)}) — would have ${pastTense(action)}` };
    }
    if (paused) {
        return { why: 'paused', reason: null, text: `${source}: protections are paused — would have ${pastTense(action)}` };
    }
    return null;
}

/**
 * Can this allowlisted user be taken off the list? Not while they hold an allowlisted role — they
 * would stay exempt anyway and the list would lie about it.
 * @returns {{ ok:boolean, roleId:string|null }}
 */
export function allowUserRemoval(roleIds, allowRoles) {
    const roles = asSet(allowRoles);
    const roleId = (roleIds || []).find(r => roles.has(r)) ?? null;
    return { ok: !roleId, roleId };
}

/** Only the server owner or an Administrator (or a site super-admin) may add or remove manager roles. */
export function canEditManagers({ isOwner = false, isAdmin = false, isSuperAdmin = false } = {}) {
    return !!(isOwner || isAdmin || isSuperAdmin);
}

/**
 * May this person configure the bot for the server (dashboard, /protection)? Manage Server, the
 * owner, an Administrator, or a bot-manager role. Super-admins are decided elsewhere.
 */
export function canConfigure({ isOwner = false, isAdmin = false, hasManageGuild = false, roleIds = [], managers = [] } = {}) {
    return !!(isOwner || isAdmin || hasManageGuild || isManagerRoles(roleIds, managers));
}

export const MAX_ALLOWLIST = 500;
export const MAX_MANAGER_ROLES = 25;

export default {
    EXEMPT_REASONS, whyText, decideExempt, isManagerRoles, pauseState, parseDuration, formatDuration,
    pastTense, holdDecision, allowUserRemoval, canEditManagers, canConfigure, MIN_PAUSE_MS, MAX_PAUSE_MS,
    MAX_ALLOWLIST, MAX_MANAGER_ROLES,
};
