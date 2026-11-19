/*
 * Security overview — the pure parts (no Discord or DB access; unit-tested in
 * tests/insight-network.test.js). The live side is core/security-overview.js; the dashboard overview
 * and the Security page's score read it.
 *
 * The protections grid lists every automated protection the bot has, each wave's included, from
 * core/protection-exempt.js protectionsOverview() (each feature's own config row) plus the global ban
 * mode and the join insight switch. The score weights the protections that stop the commonest attacks
 * (raids, nukes, spammers, scams, the network) double.
 */

/** key in protectionsOverview().protections (or an extra), label, dashboard page, weight. */
export const PROTECTION_GRID = Object.freeze([
    { key: 'raid', label: 'Raid detection', page: 'advanced-protection', weight: 2 },
    { key: 'raidLockdown', label: 'Auto lockdown', page: 'advanced-protection', weight: 1 },
    { key: 'antiNuke', label: 'Anti-nuke', page: 'security', weight: 2 },
    { key: 'spammer', label: 'Discord spammer check', page: 'security', weight: 2 },
    { key: 'ageGate', label: 'Account age gate', page: 'security', weight: 1 },
    { key: 'rejoinLimit', label: 'Rejoin limit', page: 'rejoin', weight: 1 },
    { key: 'nameFilters', label: 'Name filters', page: 'name-filters', weight: 1 },
    { key: 'avatarProtection', label: 'Avatar protection', page: 'avatar-protection', weight: 1 },
    { key: 'nsfwAvatars', label: 'NSFW avatars', page: 'nsfw-protection', weight: 1 },
    { key: 'nsfwImages', label: 'NSFW chat images', page: 'nsfw-protection', weight: 1 },
    { key: 'verification', label: 'Verification', page: 'verification', weight: 1 },
    { key: 'autoPrune', label: 'Auto-prune', page: 'verification', weight: 1 },
    { key: 'inactivityPrune', label: 'Inactivity prune', page: 'verification', weight: 1 },
    { key: 'phishing', label: 'Phishing links', page: 'phishing', weight: 2 },
    { key: 'messageThreats', label: 'Message threats', page: 'message-threats', weight: 1 },
    { key: 'aiJudge', label: 'AI second opinion', page: 'protection-settings', weight: 1 },
    { key: 'linkPolicy', label: 'Link policy', page: 'automod', weight: 1 },
    { key: 'commissionFilter', label: 'Commission-spam filter', page: 'automod', weight: 1 },
    { key: 'selfbot', label: 'Self-bot detection', page: 'advanced-protection', weight: 1 },
    { key: 'adaptiveSpam', label: 'Adaptive spam filter', page: 'advanced-protection', weight: 1 },
    { key: 'globalBan', label: 'Global ban network', page: 'global-ban', weight: 2 },
    { key: 'joinInsight', label: 'Join risk insight', page: 'logging', weight: 1 },
]);

/**
 * @param protections  protectionsOverview().protections, plus raidLockdown / joinInsight / globalBan.mode
 * @returns {Array<{ key, label, page, on: boolean|null, detail: string|null }>}  on null = unknown
 */
export function protectionsGrid(protections = {}) {
    const p = protections || {};
    // protectionsOverview(): an object when the feature has a row, false when it has none (never set
    // up = off), null when it could not be read (unknown).
    const f = (parent, prop = 'on') => (parent === false ? false : parent == null ? null : !!parent[prop]);
    const act = (parent) => (parent && parent.action) || null;
    const gb = p.globalBan;
    const value = {
        raid: [f(p.raid), act(p.raid)],
        raidLockdown: [f(p.raidLockdown), act(p.raidLockdown)],
        antiNuke: [f(p.antiNuke), act(p.antiNuke)],
        spammer: [f(p.joinGate, 'spammer'), null],
        ageGate: [f(p.joinGate, 'ageGate'), null],
        rejoinLimit: [f(p.joinGate, 'rejoinLimit'), null],
        nameFilters: [f(p.nameFilters), null],
        avatarProtection: [f(p.avatarProtection), act(p.avatarProtection)],
        nsfwAvatars: [f(p.nsfwAvatars), act(p.nsfwAvatars)],
        nsfwImages: [f(p.nsfwImages), act(p.nsfwImages)],
        verification: [f(p.verification), act(p.verification)],
        autoPrune: [f(p.autoPrune), act(p.autoPrune)],
        inactivityPrune: [f(p.inactivityPrune), act(p.inactivityPrune)],
        phishing: [f(p.phishing), act(p.phishing)],
        messageThreats: [f(p.messageThreats), null],
        aiJudge: [f(p.aiJudge), act(p.aiJudge)],
        linkPolicy: [f(p.linkPolicy), null],
        commissionFilter: [f(p.commissionFilter), null],
        selfbot: [f(p.selfbot), act(p.selfbot)],
        adaptiveSpam: [f(p.adaptiveSpam), act(p.adaptiveSpam)],
        globalBan: [f(gb), gb && gb.mode ? `${gb.mode}${gb.mode === 'protect' && gb.threshold != null ? ` at ${gb.threshold}` : ''}` : null],
        joinInsight: [f(p.joinInsight), null],
    };
    return PROTECTION_GRID.map(g => {
        const [state, detail] = value[g.key] || [null, null];
        return { key: g.key, label: g.label, page: g.page, on: state, detail: detail || null };
    });
}

/** 0-100 weighted share of protections that are on, and a word for it. */
export function securityScore(grid) {
    let have = 0;
    let total = 0;
    for (const g of grid || []) {
        const w = PROTECTION_GRID.find(x => x.key === g.key)?.weight ?? 1;
        total += w;
        if (g.on) have += w;
    }
    const percent = total ? Math.round((have / total) * 100) : 0;
    const level = percent >= 70 ? 'Strong' : percent >= 45 ? 'Good' : percent >= 20 ? 'Basic' : 'Weak';
    return { percent, level, on: (grid || []).filter(g => g.on).length, total: (grid || []).length };
}

/** YYYY-MM-DD in UTC. */
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Daily counts for the last `days` days (oldest first, today last), split by a key function.
 * @param items  [{ at, kind }]
 * @returns {Array<{ date: string, total: number, [kind]: number }>}
 */
export function dailyBuckets(items, { days = 30, now = Date.now(), kinds = [] } = {}) {
    const out = [];
    const index = new Map();
    for (let i = days - 1; i >= 0; i--) {
        const date = dayKey(now - i * 86_400_000);
        const row = { date, total: 0 };
        for (const k of kinds) row[k] = 0;
        index.set(date, row);
        out.push(row);
    }
    for (const it of items || []) {
        const row = index.get(dayKey(it.at instanceof Date ? it.at.getTime() : it.at));
        if (!row) continue;
        row.total++;
        if (it.kind) row[it.kind] = (row[it.kind] || 0) + 1;
    }
    return out;
}

/** Merge {label, n} counts from several stores, biggest first. */
export function topRules(lists, limit = 8) {
    const merged = new Map();
    for (const list of lists || []) {
        for (const r of list || []) {
            if (!r?.label || !Number(r.n)) continue;
            merged.set(r.label, (merged.get(r.label) || 0) + Number(r.n));
        }
    }
    return [...merged.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
        .map(([label, n]) => ({ label, n }));
}

/** join_gate_events actions that are a protection stopping someone (not a pass, not log-only). */
export const BLOCKING_EVENT_ACTIONS = Object.freeze([
    'kicked_new', 'kicked_apply', 'rejoin_banned', 'rejoin_kicked', 'rejoin_apply',
    'spammer_banned', 'spammer_kicked', 'spammer_flagged',
    'name_banned', 'name_kicked', 'name_timeout', 'name_flagged',
    'avatar_banned', 'avatar_kicked', 'avatar_timeout', 'avatar_flagged',
    'verify_kicked', 'verify_banned', 'verify_timedout', 'prune_kicked', 'prune_inactive_kicked',
    'nsfw_banned', 'nsfw_kicked', 'nsfw_flagged',
]);

const EVENT_GROUP = {
    kicked_new: 'Account age gate', kicked_apply: 'Account age gate', rejoin_banned: 'Rejoin limit', rejoin_kicked: 'Rejoin limit',
    rejoin_apply: 'Rejoin limit', spammer_banned: 'Discord spammer check', spammer_kicked: 'Discord spammer check',
    spammer_flagged: 'Discord spammer check', name_banned: 'Name filters', name_kicked: 'Name filters', name_timeout: 'Name filters',
    name_flagged: 'Name filters', avatar_banned: 'Avatar protection', avatar_kicked: 'Avatar protection',
    avatar_timeout: 'Avatar protection', avatar_flagged: 'Avatar protection', verify_kicked: 'Verification',
    verify_banned: 'Verification', verify_timedout: 'Verification', prune_kicked: 'Auto-prune', prune_inactive_kicked: 'Inactivity prune',
    nsfw_banned: 'NSFW avatars', nsfw_kicked: 'NSFW avatars', nsfw_flagged: 'NSFW avatars',
};
export const eventGroup = (action) => EVENT_GROUP[action] || action;
