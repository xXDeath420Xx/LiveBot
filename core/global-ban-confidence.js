/*
 * Global ban network — the pure rules (no Discord or DB access; unit-tested in
 * tests/insight-network.test.js). The live side is core/global-ban-manager.js.
 *
 * Every ban in every participating server is a SIGNAL (a row of global_ban_auto_aggregate): our own
 * moderation commands (core/moderation-manager.js) and, since migration 329, every ban Discord reports
 * through events/guildBanAdd.js — our protections, staff banning by hand, and other bots. This module
 * turns a user's signals into one 0-100 CONFIDENCE that they are a bad actor, extending the old
 * weighted score (ban 3 / kick 2 / mute 1 / warn 0.5) rather than replacing it:
 *
 *   strength of one signal  = action points / 3  x  who banned (source)  x  why (context)
 *                             x  how much we trust the server  x  (a mass-ban burst counts for little)
 *   independent groups      = servers grouped by OWNER: five servers one person owns are one voice
 *   confidence              = 1 - product(1 - 0.65 x strongest signal of each group), capped by how many
 *                             independent groups agree (1 -> 50, 2 -> 80, 3+ -> 100)
 *
 * Anti-poisoning, all here so the tests cover it: one server (or one owner) can never push anyone past
 * 50 alone; a server that bans dozens of people in minutes is a "burst" whose signals count a quarter;
 * new or tiny servers count less; bans our global-ban enforcement itself made are not signals at all
 * (they would feed back into themselves); unknown bots count less than people.
 *
 * Curated entries (a voted report, a system import) keep the confidence their severity implies
 * (critical 100, high 90, medium 75, low 60) unless the signals say more.
 *
 * Per-server modes (global_ban_config.mode): protect — act (the severity's configured action) at or above
 * the server's threshold, alert below it; alert — never act, always alert; feed — contribute signals,
 * never act, never alert.
 */

export const MODES = Object.freeze(['protect', 'alert', 'feed']);
export const DEFAULT_THRESHOLD = 75;

/** Points per action, as the original weighted score had them. */
export const ACTION_POINTS = Object.freeze({ ban: 3, kick: 2, mute: 1, warn: 0.5 });

/** Who did the ban. Our own protections are the most reliable, then people, then bots we know. */
export const SOURCE_WEIGHT = Object.freeze({ protection: 1.0, moderator: 0.8, trusted_bot: 0.6, unknown: 0.4, bot: 0.3 });
export const SOURCE_RANK = Object.freeze({ protection: 5, moderator: 4, trusted_bot: 3, unknown: 2, bot: 1 });

/** Why (for our own protections; anything else is 'other'). 0 = not a signal at all. */
export const CONTEXT_WEIGHT = Object.freeze({
    spammer: 1.0, phishing: 1.0, message_threat: 1.0, scam_image: 1.0,
    selfbot: 0.9, avatar: 0.9, name: 0.8, spam: 0.8, nsfw: 0.6,
    raid: 0.7, automod: 0.7, escalation: 0.7, anti_nuke: 0.6, other: 0.7,
    join_gate: 0.4, rejoin: 0.3, lockdown: 0.3, verification: 0.3,
    global_ban: 0, prune: 0, temp_access: 0,
});

/** The category a new automatic entry gets, from its strongest context. */
const CONTEXT_CATEGORY = {
    spammer: 'spam', spam: 'spam', automod: 'spam', phishing: 'phishing', message_threat: 'phishing',
    scam_image: 'scam', raid: 'raid', lockdown: 'raid', selfbot: 'selfbot', name: 'impersonation',
    avatar: 'impersonation',
};

/** Curated (voted / imported) entries: the confidence their severity stands for. */
export const SEVERITY_CONFIDENCE = Object.freeze({ critical: 100, high: 90, medium: 75, low: 60 });

/** Well-known moderation bots (user ids). Their bans count more than an unknown bot's. */
export const TRUSTED_BOT_IDS = Object.freeze(new Set([
    '235148962103951360', // Carl-bot
    '155149108183695360', // Dyno
    '159985870458322944', // MEE6
    '536991182035746816', // Wick
    '240254129333731328', // Vortex
    '678344927997853742', // Sapphire
    '703886990948565003', // Double Counter
]));
const TRUSTED_BOT_NAMES = /^(carl-?bot|dyno|mee6|wick|vortex|sapphire|double counter|zeppelin|beemo|hashbot|security|giselle|arcane|probot|yagpdb)/i;

const BURST_WINDOW_MS = 10 * 60_000;
const BURST_LIMIT = 10;
const PER_GROUP_P = 0.65;
const GROUP_CAP = [0, 50, 80, 100];

/**
 * The protection a `protectionHold(...)` source label belongs to (core/protection-exempt.js labels).
 * Unknown labels are 'other'.
 */
export function contextFromLabel(label) {
    const s = String(label ?? '').toLowerCase();
    if (!s) return null;
    if (s.includes('global ban')) return 'global_ban';
    if (s.includes('spammer')) return 'spammer';
    if (s.includes('scam-image') || s.includes('scam image')) return 'scam_image';
    if (s.includes('name filter')) return 'name';
    if (s.includes('nsfw')) return 'nsfw';
    if (s.includes('avatar')) return 'avatar';
    if (s.includes('lockdown')) return 'lockdown';
    if (s.includes('raid')) return 'raid';
    if (s.includes('self-bot') || s.includes('selfbot')) return 'selfbot';
    if (s.includes('phishing') || s.includes('scam') || s.includes('malicious') || s.includes('link') || s.includes('threat')
        || s.includes('qr') || s.includes('obfusc') || s.includes('everyone') || s.includes('image-text')) return 'message_threat';
    if (s.includes('rejoin')) return 'rejoin';
    if (s.includes('join gate')) return 'join_gate';
    if (s.includes('verification') || s.includes('unverified')) return 'verification';
    if (s.includes('prune')) return 'prune';
    if (s.includes('temporary access')) return 'temp_access';
    if (s.includes('escalation')) return 'escalation';
    if (s.includes('anti-nuke')) return 'anti_nuke';
    if (s.includes('spam')) return 'spam';
    if (s.includes('automod') || s.includes('heat') || s.includes('commission')) return 'automod';
    return 'other';
}

/**
 * The protection a ban's audit-log reason names, for bans our bots made before (or without) a recorded
 * context. Matches the reasons our protections write; null when it is not one of ours.
 */
export function contextFromReason(reason) {
    const s = String(reason ?? '');
    if (!s) return null;
    if (/^global ban\b/i.test(s)) return 'global_ban';
    if (/spammer/i.test(s)) return 'spammer';
    if (/^name filter|name (matches|filter)/i.test(s)) return 'name';
    if (/nsfw/i.test(s)) return 'nsfw';
    if (/avatar/i.test(s)) return 'avatar';
    if (/lockdown/i.test(s)) return 'lockdown';
    if (/raid/i.test(s)) return 'raid';
    if (/self-?bot/i.test(s)) return 'selfbot';
    if (/scam image|known scam/i.test(s)) return 'scam_image';
    if (/phish|malicious|scam link|message threat|qr code/i.test(s)) return 'message_threat';
    if (/rejoin/i.test(s)) return 'rejoin';
    if (/^join gate|account (is )?too new|account age/i.test(s)) return 'join_gate';
    if (/verif|captcha/i.test(s)) return 'verification';
    if (/auto-?prune/i.test(s)) return 'prune';
    if (/escalat/i.test(s)) return 'escalation';
    if (/anti-?nuke/i.test(s)) return 'anti_nuke';
    if (/automatic spam|spam filter|adaptive spam/i.test(s)) return 'spam';
    if (/automod|auto-ban/i.test(s)) return 'automod';
    return null;
}

/**
 * Who made a ban, from its audit-log entry.
 * @param {object} p
 * @param {string|null} p.executorId     audit-log executor (null when the log was unreadable)
 * @param {boolean} p.executorBot
 * @param {string|null} p.executorName
 * @param {boolean} p.ourBot             the executor is one of our own bots
 * @param {string|null} p.reason         audit-log reason
 * @param {string|null} p.pendingLabel   the protectionHold label noted just before our bot banned
 * @returns {{ source: string, context: string|null, excluded: boolean }}
 */
export function classifyBanSource({ executorId = null, executorBot = false, executorName = null, ourBot = false, reason = null, pendingLabel = null } = {}) {
    if (ourBot) {
        const context = contextFromLabel(pendingLabel) || contextFromReason(reason);
        // Our bot with no protection behind it: a moderator used one of our commands (already recorded
        // by core/moderation-manager.js; the store de-duplicates).
        if (!context) return { source: 'moderator', context: null, excluded: false };
        return { source: 'protection', context, excluded: (CONTEXT_WEIGHT[context] ?? 0.7) === 0 };
    }
    if (!executorId) return { source: 'unknown', context: null, excluded: false };
    if (!executorBot) return { source: 'moderator', context: null, excluded: false };
    const trusted = TRUSTED_BOT_IDS.has(String(executorId)) || TRUSTED_BOT_NAMES.test(String(executorName ?? ''));
    // "Banned by alice" / "alice: reason" — a moderation bot acting for a person is a person's decision.
    if (trusted && /^(banned by \S+|\S{2,32}#?\d{0,4}: )/i.test(String(reason ?? ''))) {
        return { source: 'moderator', context: null, excluded: false };
    }
    return { source: trusted ? 'trusted_bot' : 'bot', context: null, excluded: false };
}

/** Only the stronger of two sources is kept when the same ban is reported twice. */
export function strongerSource(a, b) {
    return (SOURCE_RANK[b] ?? 0) > (SOURCE_RANK[a] ?? 0) ? b : a;
}

/**
 * How much one server's word counts, 0.25-1: very new or very small servers can be spun up to poison
 * the network, so they count less.
 */
export function guildTrust({ createdAt = null, memberCount = null, now = Date.now() } = {}) {
    const ageDays = createdAt ? (now - Number(createdAt)) / 86_400_000 : null;
    const members = memberCount == null ? null : Number(memberCount);
    let t = 1;
    if (ageDays != null && ageDays < 7) t = Math.min(t, 0.25);
    else if (ageDays != null && ageDays < 30) t = Math.min(t, 0.5);
    if (members != null && members < 10) t = Math.min(t, 0.25);
    else if (members != null && members < 50) t = Math.min(t, 0.5);
    return t;
}

/** Is this ban part of a mass-ban burst (more than BURST_LIMIT in BURST_WINDOW_MS from one server)? */
export function isBurst(recentTimestamps, now = Date.now(), { windowMs = BURST_WINDOW_MS, limit = BURST_LIMIT } = {}) {
    const n = (recentTimestamps || []).filter(t => now - Number(t) <= windowMs).length;
    return n > limit;
}

/** One signal's strength, 0-1. */
export function signalStrength(sig) {
    const points = ACTION_POINTS[sig.action_type ?? sig.action] ?? 0;
    const source = SOURCE_WEIGHT[sig.source_kind ?? sig.source] ?? SOURCE_WEIGHT.moderator;
    const ctx = sig.context ? (CONTEXT_WEIGHT[sig.context] ?? CONTEXT_WEIGHT.other) : 1;
    const trust = sig.guild_trust == null ? 1 : Math.max(0, Math.min(1, Number(sig.guild_trust)));
    const burst = Number(sig.burst) ? 0.25 : 1;
    return Math.max(0, Math.min(1, (points / 3) * source * ctx * trust * burst));
}

/** Curated entry confidence from its stored value or its severity. */
export function entryConfidence({ confidence = null, severity = null } = {}) {
    if (confidence != null && Number.isFinite(Number(confidence))) return clamp(Number(confidence));
    return SEVERITY_CONFIDENCE[severity] ?? 50;
}

/** Severity an automatic entry gets for a confidence (null = not enough for an entry). */
export function severityForConfidence(confidence) {
    if (confidence >= 85) return 'high';
    if (confidence >= 65) return 'medium';
    if (confidence >= 40) return 'low';
    return null;
}

/**
 * A user's confidence from all their signals (and their curated entry, if any).
 * @param {Array<object>} signals  global_ban_auto_aggregate rows
 * @param {{ curated?: { severity: string, confidence?: number|null } | null }} opts
 * @returns {{ confidence: number, groups: number, guilds: number, computed: number,
 *             severity: string|null, category: string, bySource: object, contexts: string[] }}
 */
export function computeConfidence(signals, { curated = null } = {}) {
    const groups = new Map();      // independence key -> strongest signal
    const guilds = new Set();
    const bySource = {};
    const contextScore = {};
    for (const s of signals || []) {
        const strength = signalStrength(s);
        if (strength <= 0) continue;
        const key = s.guild_owner_id ? `o:${s.guild_owner_id}` : `g:${s.guild_id}`;
        groups.set(key, Math.max(groups.get(key) ?? 0, strength));
        guilds.add(String(s.guild_id));
        const src = s.source_kind ?? s.source ?? 'moderator';
        bySource[src] = (bySource[src] ?? 0) + 1;
        if (s.context) contextScore[s.context] = Math.max(contextScore[s.context] ?? 0, strength);
    }
    let miss = 1;
    for (const strength of groups.values()) miss *= 1 - PER_GROUP_P * strength;
    const cap = GROUP_CAP[Math.min(groups.size, 3)];
    const computed = Math.min(cap, Math.round((1 - miss) * 100));
    const confidence = curated ? Math.max(entryConfidence(curated), computed) : computed;
    const contexts = Object.entries(contextScore).sort((a, b) => b[1] - a[1]).map(([c]) => c);
    return {
        confidence,
        computed,
        groups: groups.size,
        guilds: guilds.size,
        severity: severityForConfidence(computed),
        category: CONTEXT_CATEGORY[contexts[0]] || 'other',
        bySource,
        contexts,
    };
}

/** Should an automatic entry be created? Needs two independent groups (never one server alone). */
export function shouldCreateEntry(result) {
    return !!result && result.groups >= 2 && !!result.severity;
}

export function normaliseMode(value) {
    const v = String(value ?? '').toLowerCase();
    return MODES.includes(v) ? v : 'protect';
}

export function normaliseThreshold(value) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? clamp(n) : DEFAULT_THRESHOLD;
}

/**
 * What to do about a network hit in one server.
 * @param {{ mode: string, threshold: number, confidence: number, severityAction: 'ban'|'kick'|'alert'|'none' }} p
 * @returns {{ action: 'ban'|'kick'|'alert'|'none', why: string }}
 */
export function decideEnforcement({ mode, threshold, confidence, severityAction }) {
    const m = normaliseMode(mode);
    const t = normaliseThreshold(threshold);
    if (m === 'feed') return { action: 'none', why: 'feed only: this server contributes but never acts' };
    if (severityAction === 'none') return { action: 'none', why: 'this severity is set to do nothing' };
    if (m === 'alert') return { action: 'alert', why: 'alert only' };
    if (confidence >= t) return { action: severityAction, why: `confidence ${confidence} is at or above ${t}` };
    return { action: 'alert', why: `confidence ${confidence} is below ${t}, so alert only` };
}

/** Message-time enforcement: only real actions in protect mode, never a stream of alerts. */
export function decideMessageEnforcement(p) {
    const d = decideEnforcement(p);
    return d.action === 'ban' || d.action === 'kick' ? d : { action: 'none', why: d.why };
}

const LABELS = {
    protection: 'our protections', moderator: 'staff', trusted_bot: 'known moderation bots', bot: 'other bots', unknown: 'unknown',
};
const CONTEXT_LABELS = {
    spammer: 'Discord spammer flag', phishing: 'phishing', message_threat: 'malicious messages', scam_image: 'scam images',
    selfbot: 'self-bot', avatar: 'impersonation avatar', name: 'impersonation name', spam: 'spam', raid: 'raid',
    automod: 'automod', escalation: 'repeat offences', anti_nuke: 'anti-nuke', join_gate: 'join gate', rejoin: 'rejoin limit',
    lockdown: 'lockdown', verification: 'failed verification', other: 'other',
};
export const sourceLabel = (s) => LABELS[s] || s;
export const contextLabel = (c) => CONTEXT_LABELS[c] || c;

/**
 * The privacy-safe summary `/globalban check` and the dashboard show: counts and kinds, never which
 * servers reported or who moderated.
 */
export function publicSummary(result, { entry = null, ownSignal = false, reports = 0 } = {}) {
    return {
        confidence: result.confidence,
        listed: !!entry,
        severity: entry?.severity ?? null,
        category: entry?.category ?? (result.groups ? result.category : null),
        independentServers: result.groups,
        reportedBy: Object.entries(result.bySource).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} by ${sourceLabel(s)}`),
        reasons: result.contexts.slice(0, 4).map(contextLabel),
        ownSignal,
        pendingReports: reports,
    };
}

function clamp(n) {
    return Math.max(0, Math.min(100, Math.round(n)));
}
