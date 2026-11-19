/*
 * Member risk insight — the pure rules (no Discord or DB access; unit-tested in
 * tests/insight-network.test.js). The live side is core/member-insight.js, which gathers the signals;
 * core/log-manager.js logMemberJoin shows the result on the join log and the dashboard shows it on the
 * Users page and the Roles page Members tab.
 *
 * Signals, all already known to the bot (nothing is fetched just for this except a missing flags field):
 *   account age            under the server's threshold (default 7 days) is highlighted
 *   default avatar         never set one
 *   Discord spammer flag   public flag 1 << 20 (core/spammer-flag.js)
 *   global ban network     listed / confidence, or signals from other servers (core/global-ban-confidence.js)
 *   rejoins                how often they have joined this server (core/join-history.js)
 *   earlier protection hits  name / avatar / spammer / verification events here (join_gate_events)
 *   badges                 public flags; trust-building ones (Staff, Partner, Bug Hunter...) lower the risk
 *
 * The level is low / medium / high: a Discord spammer flag or a confident network listing is high on
 * its own; otherwise points add up (25 medium, 60 high).
 */

export const DEFAULT_NEW_ACCOUNT_DAYS = 7;
export const MAX_NEW_ACCOUNT_DAYS = 90;
const DAY = 86_400_000;

/** Public flag bits a member's profile shows as badges. `trusted` ones lower the risk. */
export const BADGES = Object.freeze([
    { bit: 1 << 0, key: 'staff', label: 'Discord Staff', trusted: true },
    { bit: 1 << 1, key: 'partner', label: 'Partnered Server Owner', trusted: true },
    { bit: 1 << 2, key: 'hypesquad', label: 'HypeSquad Events', trusted: true },
    { bit: 1 << 3, key: 'bughunter', label: 'Bug Hunter', trusted: true },
    { bit: 1 << 6, key: 'bravery', label: 'HypeSquad Bravery', trusted: false },
    { bit: 1 << 7, key: 'brilliance', label: 'HypeSquad Brilliance', trusted: false },
    { bit: 1 << 8, key: 'balance', label: 'HypeSquad Balance', trusted: false },
    { bit: 1 << 9, key: 'earlysupporter', label: 'Early Supporter', trusted: true },
    { bit: 1 << 14, key: 'bughunter2', label: 'Bug Hunter (gold)', trusted: true },
    { bit: 1 << 16, key: 'verifiedbot', label: 'Verified Bot', trusted: true },
    { bit: 1 << 17, key: 'earlydev', label: 'Early Verified Bot Developer', trusted: true },
    { bit: 1 << 18, key: 'moderator', label: 'Moderator Programs Alumni', trusted: true },
    { bit: 1 << 22, key: 'activedev', label: 'Active Developer', trusted: true },
]);

/** Badges from a public-flags bitfield (number, bigint or discord.js BitField). */
export function badgesFromFlags(flags) {
    if (flags == null) return [];
    const bits = typeof flags === 'object' ? flags.bitfield : flags;
    if (bits == null) return [];
    const n = BigInt(bits);
    return BADGES.filter(b => (n & BigInt(b.bit)) !== 0n).map(({ key, label, trusted }) => ({ key, label, trusted }));
}

export function normaliseNewAccountDays(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_NEW_ACCOUNT_DAYS;
    return Math.min(MAX_NEW_ACCOUNT_DAYS, n);
}

/**
 * @param {object} i
 * @param {number|null} i.accountAgeMs
 * @param {number} [i.newAccountDays]
 * @param {boolean} [i.defaultAvatar]
 * @param {boolean|null} [i.spammer]
 * @param {{ listed:boolean, confidence:number, independentServers:number }|null} [i.network]
 * @param {number} [i.joins]       joins to this server including this one
 * @param {number} [i.priorHits]   earlier protection events about them here
 * @param {Array<{trusted:boolean}>} [i.badges]
 * @param {boolean} [i.bot]
 * @returns {{ level:'low'|'medium'|'high', score:number, reasons:Array<{key:string,label:string,points:number,severe?:boolean}> }}
 */
export function scoreJoinRisk(i = {}) {
    if (i.bot) return { level: 'low', score: 0, reasons: [{ key: 'bot', label: 'Bot account', points: 0 }] };
    const reasons = [];
    const add = (key, label, points, severe = false) => reasons.push({ key, label, points, ...(severe ? { severe } : {}) });
    const threshold = normaliseNewAccountDays(i.newAccountDays ?? DEFAULT_NEW_ACCOUNT_DAYS);

    if (i.spammer === true) add('spammer', 'Flagged as a spammer by Discord', 60, true);

    const net = i.network;
    if (net?.listed) {
        const c = Math.max(0, Math.min(100, Number(net.confidence) || 0));
        // Listed at all is at least medium; a confident listing is high on its own.
        add('network', `Listed in the global ban network (confidence ${c})`, Math.max(25, Math.round(c * 0.6)), c >= 75);
    } else if (net && net.independentServers > 0) {
        const n = Number(net.independentServers);
        add('network_signals', `Banned in ${n} other server${n === 1 ? '' : 's'} on the network`, Math.min(20, 10 * n));
    }

    if (i.accountAgeMs != null && Number.isFinite(i.accountAgeMs)) {
        const days = i.accountAgeMs / DAY;
        if (days < 1) add('age', 'Account created less than a day ago', 30);
        else if (days < threshold) add('age', `Account younger than ${threshold} days`, 20);
        else if (days < 30) add('age', 'Account younger than 30 days', 5);
    }

    if (i.defaultAvatar) add('avatar', 'Default avatar', 10);

    const prior = Math.max(0, (Number(i.joins) || 0) - 1);
    if (prior >= 4) add('rejoins', `Joined ${prior} times before`, 20);
    else if (prior >= 2) add('rejoins', `Joined ${prior} times before`, 10);

    if ((Number(i.priorHits) || 0) > 0) add('prior_hits', `Caught by a protection here before (${i.priorHits})`, 15);

    const trusted = (i.badges || []).filter(b => b.trusted);
    if (trusted.length) add('badges', `Trusted badge: ${trusted.map(b => b.label).join(', ')}`, -15);

    const score = Math.max(0, reasons.reduce((n, r) => n + r.points, 0));
    const severe = reasons.some(r => r.severe);
    const level = severe || score >= 60 ? 'high' : score >= 25 ? 'medium' : 'low';
    return { level, score, reasons };
}

const LEVEL_TEXT = { low: 'Low', medium: 'Medium', high: 'High' };
const LEVEL_ICON = { low: '🟢', medium: '🟡', high: '🔴' };

// `name_blocked` → `name blocked`. New join_gate actions read fine without a hand-curated map,
// which also means the Risk field never silently hides a protection it doesn't recognise.
function humaniseAction(action) {
    return String(action || '').replace(/_/g, ' ').trim();
}

/**
 * The join log's insight field: a title and up to ~1000 characters of lines.
 * @param risk   scoreJoinRisk() output
 * @param i      the same input, for the facts shown (age, rejoins, badges)
 */
export function formatRiskField(risk, i = {}) {
    const lines = [];
    const threshold = normaliseNewAccountDays(i.newAccountDays ?? DEFAULT_NEW_ACCOUNT_DAYS);
    if (i.accountAgeMs != null) {
        const days = Math.floor(i.accountAgeMs / DAY);
        const young = i.accountAgeMs < threshold * DAY;
        lines.push(`${young ? '⚠️ **' : ''}Account age: ${days < 1 ? 'under a day' : `${days} day${days === 1 ? '' : 's'}`}${young ? '**' : ''}`);
    }
    if (i.spammer === true) lines.push('🚫 **Discord spammer flag**');
    if (i.network?.listed) lines.push(`🌐 **Global ban network: listed, confidence ${i.network.confidence}/100**`);
    else if (i.network?.independentServers > 0) lines.push(`🌐 Banned in ${i.network.independentServers} other server(s) on the network (not listed)`);
    if (i.defaultAvatar) lines.push('🖼️ Default avatar');
    const prior = Math.max(0, (Number(i.joins) || 0) - 1);
    if (prior > 0) lines.push(`🔁 Joined ${prior} time${prior === 1 ? '' : 's'} before`);
    if ((Number(i.priorHits) || 0) > 0) {
        const actions = Array.isArray(i.priorHitActions) ? i.priorHitActions.slice(0, 3).map(humaniseAction) : [];
        const which = actions.length ? `: ${actions.join(', ')}` : '';
        lines.push(`🛡️ Caught by a protection here before (${i.priorHits})${which}`);
    }
    if (i.badges?.length) lines.push(`🏅 ${i.badges.map(b => b.label).join(', ')}`);
    if (!lines.length) lines.push('Nothing notable');
    let value = lines.join('\n');
    if (value.length > 1000) value = `${value.slice(0, 997)}...`;
    return { name: `${LEVEL_ICON[risk.level]} Risk: ${LEVEL_TEXT[risk.level]} (${risk.score})`, value };
}
