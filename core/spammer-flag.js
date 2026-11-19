/*
 * Discord-flagged spammers — the pure rules (no Discord or DB access, unit-tested in
 * tests/spammer-flag.test.js). The live side is core/spammer-guard.js.
 *
 * Discord marks accounts its own platform-wide spam system has caught with bit 1 << 20 of the
 * user's `public_flags` (discord.js: UserFlags.Spammer). Every user object a bot receives carries
 * it — the join event and member-list chunks included — so checking costs nothing. Discord sets
 * and clears it; an account that wins an appeal loses the flag.
 */

export const SPAMMER_BIT = 1 << 20; // 1048576

export const SPAMMER_ACTIONS = Object.freeze(['flag', 'kick', 'ban', 'none']);

/** 'flag' | 'kick' | 'ban' | 'none'; anything unknown is the default, kick. */
export function normaliseSpammerAction(value) {
    const v = String(value ?? '').toLowerCase();
    return SPAMMER_ACTIONS.includes(v) ? v : 'kick';
}

/**
 * Is this user flagged? true / false, or null when their flags were never received (the caller
 * fetches them). Accepts a discord.js User, a raw API user, or the flags number itself.
 */
export function isFlaggedSpammer(userOrFlags) {
    if (userOrFlags == null) return null;
    if (typeof userOrFlags === 'number' || typeof userOrFlags === 'bigint') {
        return (BigInt(userOrFlags) & BigInt(SPAMMER_BIT)) !== 0n;
    }
    const flags = userOrFlags.flags ?? userOrFlags.public_flags;
    if (flags == null) return null;
    const bits = typeof flags === 'object' ? flags.bitfield : flags;
    if (bits == null) return null;
    return (BigInt(bits) & BigInt(SPAMMER_BIT)) !== 0n;
}

/**
 * Who a member scan would act on, and why everyone else is left alone.
 *
 * @param {Array<{id:string, bot?:boolean, spammer:boolean|null, owner?:boolean, staff?:boolean,
 *                allowlisted?:boolean, actionable?:boolean, hasFlagRole?:boolean}>} members
 *        `actionable` — the bot can carry out the action on them (role hierarchy, permission).
 * @param {string} action  normalised spammer action
 * @returns {{ targets: string[], skipped: { allowlisted: string[], staff: string[], unremovable: string[],
 *            already: string[] }, unknown: string[] }}
 */
export function planSpammerScan(members, action) {
    const out = { targets: [], skipped: { allowlisted: [], staff: [], unremovable: [], already: [] }, unknown: [] };
    for (const m of members || []) {
        if (m.bot) continue;
        if (m.spammer === null || m.spammer === undefined) { out.unknown.push(m.id); continue; }
        if (!m.spammer) continue;
        if (m.allowlisted) out.skipped.allowlisted.push(m.id);
        else if (m.owner || m.staff) out.skipped.staff.push(m.id);
        else if (action === 'flag' && m.hasFlagRole) out.skipped.already.push(m.id);
        else if (!m.actionable) out.skipped.unremovable.push(m.id);
        else out.targets.push(m.id);
    }
    return out;
}

/** X-Audit-Log-Reason must be plain ASCII. */
export function spammerReason(source) {
    return source === 'scan'
        ? 'Spammer scan: account flagged as a spammer by Discord'
        : 'Join gate: account flagged as a spammer by Discord';
}

/** join_gate_events.action for each outcome. */
export function spammerEventAction(action) {
    return { ban: 'spammer_banned', kick: 'spammer_kicked', flag: 'spammer_flagged', none: 'spammer_observed' }[action];
}
