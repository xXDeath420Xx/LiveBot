/*
 * Inactivity prune — the rules, with no Discord or database in them (the live side is
 * core/inactivity-prune.js; activity comes from core/member-activity.js).
 *
 * Two rules on top of auto-prune (core/auto-prune-logic.js, which handles "no real role yet"), both off
 * by default, each either log-only (report who would go, remove nobody) or kick:
 *
 *   never   joined, got through the gate, and has not sent a single message or joined a voice channel
 *           within N days of joining (7-180, default 30)
 *   quiet   rolling: the last message or voice join in this server is more than N days old
 *           (30-365, default 90)
 *
 * THE FAIRNESS RULE. Activity is only known from the moment tracking began (per server:
 * guilds.activity_tracked_since, back-dated by migration 332 to the oldest history the bot kept, never
 * earlier than the bot's own arrival). Nobody is measured from before that: a member's clock starts at
 * the latest of when they joined, when tracking began for the server and when the bot joined it. So
 * "no data" can never count against anyone until N days of real tracking have passed.
 *
 * Never touched: bots, the owner, Administrator / Manage Server, staff (moderation permissions, unless
 * switched off), boosters (unless switched off), the exempt roles, anyone in a voice channel right now,
 * anyone still in the hands of the gate (verification / auto-prune), and anyone younger in the server
 * than the minimum age. The live side also runs every kick through protectionHold (allowlist, bot
 * managers, the pause).
 *
 * The warning: with warnDays > 0 a kick only ever follows a warning DM sent at least warnDays earlier
 * and not followed by any activity — the member is told how to stay (post anything, or join a voice
 * channel). Activity after the warning cancels it.
 */

export const DAY_MS = 86_400_000;
export const INACTIVE_ACTIONS = ['log', 'kick'];
export const INACTIVE_LIMITS = Object.freeze({
    neverDays: [7, 180],
    quietDays: [30, 365],
    minMemberDays: [0, 365],
    warnDays: [0, 30],
    maxPerSweep: [1, 100],
    dailyCap: [1, 1000],
});
export const INACTIVE_DEFAULTS = Object.freeze({
    neverDays: 30, quietDays: 90, minMemberDays: 7, warnDays: 3, maxPerSweep: 25, dailyCap: 100,
});
export const MAX_EXEMPT_ROLES = 25;
export const MAX_EXEMPT_USERS = 50;
/** How often the automatic sweep runs per server. */
export const SWEEP_INTERVAL_MS = 6 * 3_600_000;
/** "Run now" from the dashboard: at most this often. */
export const MANUAL_RUN_COOLDOWN_MS = 10 * 60_000;
/** Warning DMs per sweep (Discord rate-limits DMs; the rest wait for the next sweep). */
export const MAX_WARNINGS_PER_SWEEP = 50;
/** A warning older than its window plus this much is stale (the settings moved the deadline). */
const STALE_WARNING_MS = 7 * DAY_MS;

const snowflake = (v) => (v != null && /^\d{15,25}$/.test(String(v)) ? String(v) : null);
const clampInt = (raw, [lo, hi], dflt) => {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const ms = (v) => {
    if (v == null || v === '') return null;
    const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(t) ? t : null;
};

/** A stored role list (JSON array or comma list) as unique ids. */
export function parseIdList(raw) {
    if (raw == null || raw === '') return [];
    let list;
    if (Array.isArray(raw)) list = raw;
    else {
        try { list = JSON.parse(raw); } catch { list = String(raw).split(','); }
        if (!Array.isArray(list)) list = [];
    }
    return [...new Set(list.map(v => snowflake(String(v).trim())).filter(Boolean))];
}

/** The join_gate_config row (or null) as inactivity settings. */
export function normaliseInactivityConfig(row) {
    const L = INACTIVE_LIMITS;
    const D = INACTIVE_DEFAULTS;
    let lastResult = null;
    if (row?.inactive_last_result) {
        try { lastResult = typeof row.inactive_last_result === 'string' ? JSON.parse(row.inactive_last_result) : row.inactive_last_result; } catch { lastResult = null; }
    }
    const never = {
        enabled: !!row?.inactive_never_enabled,
        days: clampInt(row?.inactive_never_days, L.neverDays, D.neverDays),
        action: INACTIVE_ACTIONS.includes(row?.inactive_never_action) ? row.inactive_never_action : 'log',
    };
    const quiet = {
        enabled: !!row?.inactive_quiet_enabled,
        days: clampInt(row?.inactive_quiet_days, L.quietDays, D.quietDays),
        action: INACTIVE_ACTIONS.includes(row?.inactive_quiet_action) ? row.inactive_quiet_action : 'log',
    };
    return {
        never,
        quiet,
        enabled: never.enabled || quiet.enabled,
        kicks: (never.enabled && never.action === 'kick') || (quiet.enabled && quiet.action === 'kick'),
        exemptRoleIds: parseIdList(row?.inactive_exempt_roles),
        exemptUserIds: parseIdList(row?.inactive_exempt_users),
        exemptBoosters: row?.inactive_exempt_boosters == null ? true : !!row.inactive_exempt_boosters,
        exemptStaff: row?.inactive_exempt_staff == null ? true : !!row.inactive_exempt_staff,
        minMemberDays: clampInt(row?.inactive_min_member_days, L.minMemberDays, D.minMemberDays),
        warnDays: clampInt(row?.inactive_warn_days, L.warnDays, D.warnDays),
        maxPerSweep: clampInt(row?.inactive_max_per_sweep, L.maxPerSweep, D.maxPerSweep),
        dailyCap: clampInt(row?.inactive_daily_cap, L.dailyCap, D.dailyCap),
        lastSweepAt: ms(row?.inactive_last_sweep_at),
        lastResult,
    };
}

/**
 * A settings change as join_gate_config columns. Every bad value is an error; nothing is half-saved.
 * @returns {{ patch: Record<string, any>, errors: string[] }}
 */
export function validateInactivitySettings(input = {}) {
    const patch = {};
    const errors = [];
    const L = INACTIVE_LIMITS;
    const intIn = (key, col, [lo, hi], label) => {
        if (input[key] === undefined || input[key] === null) return;
        const n = Number(input[key]);
        if (!Number.isInteger(n) || n < lo || n > hi) errors.push(`${label} must be a whole number from ${lo} to ${hi}.`);
        else patch[col] = n;
    };
    const bool = (key, col) => { if (input[key] !== undefined && input[key] !== null) patch[col] = input[key] ? 1 : 0; };
    const action = (key, col, label) => {
        if (input[key] === undefined || input[key] === null) return;
        if (!INACTIVE_ACTIONS.includes(input[key])) errors.push(`${label} must be "log" or "kick".`);
        else patch[col] = input[key];
    };
    bool('neverEnabled', 'inactive_never_enabled');
    intIn('neverDays', 'inactive_never_days', L.neverDays, 'Days to first activity');
    action('neverAction', 'inactive_never_action', 'The never-active action');
    bool('quietEnabled', 'inactive_quiet_enabled');
    intIn('quietDays', 'inactive_quiet_days', L.quietDays, 'Days since the last activity');
    action('quietAction', 'inactive_quiet_action', 'The gone-quiet action');
    bool('exemptBoosters', 'inactive_exempt_boosters');
    bool('exemptStaff', 'inactive_exempt_staff');
    intIn('minMemberDays', 'inactive_min_member_days', L.minMemberDays, 'Minimum days in the server');
    intIn('warnDays', 'inactive_warn_days', L.warnDays, 'Warning days');
    intIn('maxPerSweep', 'inactive_max_per_sweep', L.maxPerSweep, 'Kicks per sweep');
    intIn('dailyCap', 'inactive_daily_cap', L.dailyCap, 'Kicks per day');
    if (input.exemptRoleIds !== undefined && input.exemptRoleIds !== null) {
        const list = parseIdList(Array.isArray(input.exemptRoleIds) ? input.exemptRoleIds : []);
        if (list.length > MAX_EXEMPT_ROLES) errors.push(`Up to ${MAX_EXEMPT_ROLES} exempt roles.`);
        else patch.inactive_exempt_roles = JSON.stringify(list);
    }
    return { patch, errors };
}

/**
 * When this member's clock starts: the latest of joining, tracking starting for the server and the
 * bot joining the server. Null when the join time is unknown (then nobody is judged).
 */
export function baselineMs({ joinedAtMs, trackingSinceMs, botJoinedAtMs } = {}) {
    if (!Number.isFinite(joinedAtMs)) return null;
    return Math.max(joinedAtMs, Number.isFinite(trackingSinceMs) ? trackingSinceMs : joinedAtMs,
        Number.isFinite(botJoinedAtMs) ? botJoinedAtMs : joinedAtMs);
}

/** The latest message or voice join (ms), or null with neither. */
export function lastActiveMs({ lastMessageMs = null, lastVoiceMs = null } = {}) {
    const vals = [lastMessageMs, lastVoiceMs].filter(Number.isFinite);
    return vals.length ? Math.max(...vals) : null;
}

/** Why a member is never judged, or null. Order: the most meaningful reason first. */
export function exemptionFor(m = {}, cfg = {}, exemptRoleSet = new Set(), exemptUserSet = new Set()) {
    if (m.isBot) return 'bot';
    if (m.isOwner) return 'owner';
    if (m.isElevated) return 'admin';
    if (exemptUserSet.has(String(m.id))) return 'exempt user';
    if (cfg.exemptStaff && m.isStaff) return 'staff';
    if (cfg.exemptBoosters && m.isBooster) return 'booster';
    if ((m.roleIds || []).some(id => exemptRoleSet.has(String(id)))) return 'exempt role';
    return null;
}

/**
 * One member against the rules.
 * @param m        { isBot, isOwner, isElevated, isStaff, isBooster, roleIds, inVoice, gatePending, joinedAtMs }
 * @param activity { lastMessageMs, lastVoiceMs, warnedAtMs, loggedAtMs } (all may be null)
 * @param cfg      normaliseInactivityConfig()
 * @param ctx      { now, trackingSinceMs, botJoinedAtMs, exemptRoleSet }
 * @returns {{ status: 'exempt'|'gate'|'active'|'off'|'unknown'|'ok'|'warn'|'waiting'|'due',
 *             why: string|null, rule: 'never'|'quiet'|null, action: 'kick'|'log'|null,
 *             lastActiveMs: number|null, baselineMs: number|null, dueAtMs: number|null, kickAtMs: number|null,
 *             inactiveDays: number|null, alreadyLogged: boolean }}
 */
export function evaluateMember(m = {}, activity = {}, cfg = {}, ctx = {}) {
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    const last = lastActiveMs(activity);
    const base = baselineMs({ joinedAtMs: m.joinedAtMs, trackingSinceMs: ctx.trackingSinceMs, botJoinedAtMs: ctx.botJoinedAtMs });
    const out = (status, extra = {}) => ({
        status, why: null, rule: null, action: null, lastActiveMs: last, baselineMs: base, dueAtMs: null, kickAtMs: null,
        inactiveDays: base == null ? null : Math.max(0, Math.floor((now - Math.max(last ?? -Infinity, base)) / DAY_MS)),
        alreadyLogged: false, ...extra,
    });

    if (!cfg?.enabled) return out('off');
    const exempt = exemptionFor(m, cfg, ctx.exemptRoleSet || new Set(), ctx.exemptUserSet || new Set());
    if (exempt) return out('exempt', { why: exempt });
    if (m.gatePending) return out('gate', { why: 'still going through verification / auto-prune' });
    if (m.inVoice) return out('active', { why: 'in a voice channel now' });
    if (base == null) return out('unknown', { why: 'join time unknown' });

    const minAge = Number.isFinite(m.joinedAtMs) ? m.joinedAtMs + (cfg.minMemberDays || 0) * DAY_MS : base;
    const candidates = [];
    if (cfg.never?.enabled) {
        const activeSinceJoin = last != null && last >= m.joinedAtMs;
        if (!activeSinceJoin) {
            candidates.push({ rule: 'never', action: cfg.never.action, dueAtMs: Math.max(base + cfg.never.days * DAY_MS, minAge) });
        }
    }
    if (cfg.quiet?.enabled) {
        const from = Math.max(last ?? -Infinity, base);
        candidates.push({ rule: 'quiet', action: cfg.quiet.action, dueAtMs: Math.max(from + cfg.quiet.days * DAY_MS, minAge) });
    }
    if (!candidates.length) return out('ok', { why: 'active since joining' });

    const earliest = (list) => list.slice().sort((a, b) => a.dueAtMs - b.dueAtMs || (a.rule === 'never' ? -1 : 1))[0] || null;
    const kickC = earliest(candidates.filter(c => c.action === 'kick'));
    const logC = earliest(candidates.filter(c => c.action === 'log'));
    const warnMs = (cfg.warnDays || 0) * DAY_MS;

    if (kickC) {
        const c = kickC;
        const base2 = { rule: c.rule, action: 'kick', dueAtMs: c.dueAtMs };
        if (!warnMs) {
            if (now >= c.dueAtMs) return out('due', { ...base2, kickAtMs: c.dueAtMs });
        } else {
            const w = activity.warnedAtMs;
            const validWarn = Number.isFinite(w) && (last == null || w > last) && w >= c.dueAtMs - warnMs - STALE_WARNING_MS;
            if (validWarn) {
                const kickAt = Math.max(c.dueAtMs, w + warnMs);
                return out(now >= kickAt ? 'due' : 'waiting', { ...base2, kickAtMs: kickAt });
            }
            if (now >= c.dueAtMs - warnMs) return out('warn', { ...base2, kickAtMs: Math.max(c.dueAtMs, now + warnMs) });
        }
    }
    if (logC && now >= logC.dueAtMs) {
        const l = activity.loggedAtMs;
        const alreadyLogged = Number.isFinite(l) && (last == null || l > last) && l >= base;
        return out('due', { rule: logC.rule, action: 'log', dueAtMs: logC.dueAtMs, alreadyLogged });
    }
    const next = earliest(candidates);
    return out('ok', { rule: next.rule, action: next.action, dueAtMs: next.dueAtMs,
        kickAtMs: next.action === 'kick' ? (warnMs ? Math.max(next.dueAtMs, now + warnMs) : next.dueAtMs) : null });
}

/**
 * What one sweep does with the evaluations: who is kicked (oldest due first, capped per sweep and by
 * what is left of the daily cap), who is warned (capped), who is newly logged. Everyone else waits.
 * @param evals [{ userId, ...evaluateMember() }]
 */
export function planSweep(evals = [], { maxPerSweep = INACTIVE_DEFAULTS.maxPerSweep, kickedToday = 0, dailyCap = INACTIVE_DEFAULTS.dailyCap,
    maxWarnings = MAX_WARNINGS_PER_SWEEP } = {}) {
    const byDue = (a, b) => (a.dueAtMs ?? 0) - (b.dueAtMs ?? 0);
    const kickable = evals.filter(e => e.status === 'due' && e.action === 'kick').sort(byDue);
    const budget = Math.max(0, Math.min(maxPerSweep, dailyCap - kickedToday));
    const warnable = evals.filter(e => e.status === 'warn').sort(byDue);
    return {
        kick: kickable.slice(0, budget),
        // Members the sweep may try in order: a held (allowlisted / paused) or vanished member does not use up
        // the budget, so the oldest exempt members can never starve everyone behind them. `maxAttempts`
        // bounds the tries (a paused server holds every one).
        kickQueue: kickable,
        budget,
        maxAttempts: budget ? budget * 4 + 10 : 0,
        warn: warnable.slice(0, Math.max(0, maxWarnings)),
        log: evals.filter(e => e.status === 'due' && e.action === 'log' && !e.alreadyLogged),
        deferredKicks: Math.max(0, kickable.length - budget),
        deferredWarnings: Math.max(0, warnable.length - Math.max(0, maxWarnings)),
        capReached: kickable.length > budget ? (dailyCap - kickedToday <= maxPerSweep ? 'daily' : 'sweep') : null,
    };
}

/** Counts for the dashboard / `/systems auto-prune inactive-preview`. `soonDays`: "due within". */
export function summarise(evals = [], { now = Date.now(), soonDays = 7 } = {}) {
    const s = {
        total: evals.length, due: 0, dueKick: 0, dueLog: 0, warn: 0, waiting: 0, soon: 0,
        never: 0, quiet: 0, exempt: 0, gate: 0, active: 0,
    };
    for (const e of evals) {
        if (e.status === 'due') { s.due++; if (e.action === 'kick') s.dueKick++; else s.dueLog++; }
        if (e.status === 'warn') s.warn++;
        if (e.status === 'waiting') s.waiting++;
        if (['due', 'warn', 'waiting'].includes(e.status) && e.rule) s[e.rule]++;
        if (e.status === 'ok' && e.dueAtMs != null && e.dueAtMs - now <= soonDays * DAY_MS) s.soon++;
        if (e.status === 'exempt') s.exempt++;
        if (e.status === 'gate') s.gate++;
        if (e.status === 'active') s.active++;
    }
    return s;
}

/** The preview list: who a rule would remove (or warn) now, then who is coming up, oldest activity first. */
export function previewRows(evals = [], { includeSoon = true, now = Date.now(), soonDays = 7 } = {}) {
    const rank = { due: 0, waiting: 1, warn: 2, ok: 3 };
    return evals
        .filter(e => ['due', 'waiting', 'warn'].includes(e.status)
            || (includeSoon && e.status === 'ok' && e.dueAtMs != null && e.dueAtMs - now <= soonDays * DAY_MS))
        .sort((a, b) => rank[a.status] - rank[b.status] || (a.dueAtMs ?? 0) - (b.dueAtMs ?? 0));
}

/** Plain-ASCII audit-log reason. */
export function kickReason(rule, days) {
    const why = rule === 'never'
        ? `no message or voice activity within ${days} days of joining`
        : `no message or voice activity for ${days}+ days`;
    return `Inactivity prune: ${why}`.replace(/[^\x20-\x7E]/g, '').slice(0, 400);
}

/** What a rule means, in a sentence. */
export function ruleText(rule, days) {
    return rule === 'never'
        ? `no message or voice channel join within ${days} days of joining`
        : `no message or voice channel join for ${days} days`;
}

/** The warning DM. */
export function warningText(guildName, { rule, days, kickAtMs, now = Date.now() }) {
    const inDays = Math.max(1, Math.round((kickAtMs - now) / DAY_MS));
    return `Hi! You're a member of **${guildName}**, but there has been ${ruleText(rule, days)}. `
        + `To keep the member list tidy, inactive members are removed — you'll be removed in about ${inDays} day${inDays === 1 ? '' : 's'} `
        + 'unless you show up.\n\nTo stay, just **send a message in any channel** or **join a voice channel** there. That\'s all it takes.';
}

/** The DM sent with the kick. */
export function kickDmText(guildName, { rule, days }) {
    return `You were removed from **${guildName}** because there was ${ruleText(rule, days)}. You're welcome to join again any time.`;
}

/** Discord timestamp markup: the reader sees it in their own time zone. */
const discordTime = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;

/**
 * The warning DM as a message payload: an embed with the exact removal time and how to stay, and a
 * link button that opens the server. `guild` is { id, name, iconUrl }.
 */
export function warningPayload(guild, { rule, days, kickAtMs }) {
    return {
        embeds: [{
            color: 0xE2A63F,
            author: { name: guild.name, ...(guild.iconUrl ? { icon_url: guild.iconUrl } : {}) },
            title: `You'll be removed from ${guild.name} soon`,
            description: `There has been ${ruleText(rule, days)}. Inactive members are removed to keep the member list tidy.`,
            fields: [
                { name: 'Removal', value: `${discordTime(kickAtMs, 'F')} (${discordTime(kickAtMs, 'R')})` },
                { name: 'How to stay', value: 'Send a message in any channel, or join a voice channel. Any activity before then cancels the removal.' },
            ],
            ...(guild.iconUrl ? { thumbnail: { url: guild.iconUrl } } : {}),
            footer: { text: `Automatic message from ${guild.name}` },
        }],
        components: [{ type: 1, components: [
            { type: 2, style: 5, label: 'Go to server', url: `https://discord.com/channels/${guild.id}` },
        ] }],
    };
}

/** The DM sent with the kick, with a rejoin button when the bot could make an invite. */
export function kickPayload(guild, { rule, days, inviteUrl = null }) {
    return {
        embeds: [{
            color: 0x8A8C95,
            author: { name: guild.name, ...(guild.iconUrl ? { icon_url: guild.iconUrl } : {}) },
            title: `You were removed from ${guild.name}`,
            description: `There was ${ruleText(rule, days)}. You're welcome to join again any time.`,
            footer: { text: `Automatic message from ${guild.name}` },
        }],
        components: inviteUrl ? [{ type: 1, components: [
            { type: 2, style: 5, label: 'Rejoin', url: inviteUrl },
        ] }] : [],
    };
}

/** One line for status embeds and the dashboard badge. */
export function describeInactivity(cfg) {
    if (!cfg?.enabled) return 'Inactivity prune is off.';
    const parts = [];
    const what = (a) => (a === 'kick' ? 'kick' : 'log only');
    if (cfg.never.enabled) parts.push(`never active within ${cfg.never.days} d of joining (${what(cfg.never.action)})`);
    if (cfg.quiet.enabled) parts.push(`no activity for ${cfg.quiet.days} d (${what(cfg.quiet.action)})`);
    const warn = cfg.kicks ? (cfg.warnDays ? `, warned ${cfg.warnDays} d before` : ', no warning') : '';
    return `Inactivity prune: ${parts.join('; ')}${warn}.`;
}

export default {
    DAY_MS, INACTIVE_ACTIONS, INACTIVE_LIMITS, INACTIVE_DEFAULTS, MAX_EXEMPT_ROLES, SWEEP_INTERVAL_MS, MANUAL_RUN_COOLDOWN_MS,
    MAX_WARNINGS_PER_SWEEP, parseIdList, normaliseInactivityConfig, validateInactivitySettings, baselineMs, lastActiveMs,
    exemptionFor, evaluateMember, planSweep, summarise, previewRows, kickReason, ruleText, warningText, kickDmText, warningPayload, kickPayload, describeInactivity,
};
