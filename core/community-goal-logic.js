/*
 * Community goal rules — pure, dependency-free (tests/bgames-logic.test.js).
 *
 * A goal is a server-wide target with a deadline. Progress comes from data the bot already keeps
 * (core/community-goals-manager.js reads it):
 *   messages       activity_stats.messages_sent since the goal started (cumulative)
 *   voice_minutes  voice_activity durations since the goal started (cumulative)
 *   members        the server's member count (absolute: "reach 1,000 members")
 *   boosts         the server's boost count (absolute)
 *   custom         a counter staff move by hand (/arcade goals add)
 */

export const GOAL_TYPES = Object.freeze({
    messages: { label: 'Messages sent', unit: 'messages', emoji: '💬', cumulative: true },
    voice_minutes: { label: 'Voice minutes', unit: 'minutes', emoji: '🎙️', cumulative: true },
    members: { label: 'Members', unit: 'members', emoji: '👥', cumulative: false },
    boosts: { label: 'Server boosts', unit: 'boosts', emoji: '🚀', cumulative: false },
    custom: { label: 'Custom', unit: 'points', emoji: '🎯', cumulative: false },
});

export const MILESTONES = Object.freeze([25, 50, 75]);

export function percent(current, target) {
    const t = Number(target);
    if (!(t > 0)) return 0;
    return Math.max(0, Math.min(100, Math.floor((Number(current) / t) * 100)));
}

/**
 * The highest milestone newly reached since `lastMilestone`, or null. 100% is completion and is
 * handled separately, so it is never returned here.
 */
export function newMilestone(lastMilestone, current, target, milestones = MILESTONES) {
    const pct = percent(current, target);
    let hit = null;
    for (const m of milestones) {
        if (m > (Number(lastMilestone) || 0) && pct >= m && m < 100) hit = m;
    }
    return hit;
}

/** 'completed' once the target is met, 'failed' once the deadline passes first, else 'active'. */
export function outcome({ current, target, endsAtMs, nowMs }) {
    if (Number(current) >= Number(target)) return 'completed';
    if (endsAtMs && nowMs >= endsAtMs) return 'failed';
    return 'active';
}

/** Text progress bar: ▰▰▰▱▱▱▱▱▱▱ 30% */
export function progressBar(current, target, width = 16) {
    const pct = percent(current, target);
    const filled = Math.round((pct / 100) * width);
    return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)} ${pct}%`;
}

/** reward_json → { coins, xp, role_id } with junk removed. */
export function parseReward(raw) {
    let r = raw;
    if (typeof raw === 'string') {
        try { r = JSON.parse(raw); } catch { r = null; }
    }
    if (!r || typeof r !== 'object') return { coins: 0, xp: 0, role_id: null };
    const n = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
    const role = r.role_id && /^\d{15,25}$/.test(String(r.role_id)) ? String(r.role_id) : null;
    return { coins: n(r.coins), xp: n(r.xp), role_id: role };
}

export function hasReward(r) {
    return !!(r && (r.coins > 0 || r.xp > 0 || r.role_id));
}

/** Progress as the goal reports it: cumulative types subtract the value at creation. */
export function progressFrom(type, rawValue, startValue) {
    const def = GOAL_TYPES[type];
    const v = Math.max(0, Math.floor(Number(rawValue) || 0));
    if (def?.cumulative) return Math.max(0, v - Math.max(0, Math.floor(Number(startValue) || 0)));
    return v;
}
