/*
 * Automated-ban log — the pure assembly (no Discord or DB access; unit-tested in
 * tests/insight-network.test.js). The live side is core/ban-log.js.
 *
 * There is no separate "ban log" table: every ban Discord reports is already a GUILD_BAN_ADD row in
 * audit_logs (core/log-manager.js logGuildBanAdd), and since migration 329's wave the row's metadata
 * says which protection made it (core/global-ban-manager.js ingestBan). Older rows are classified from
 * the executor (one of our bots) and the audit-log reason our protections write. The evidence comes from
 * each protection's own store, matched by member and time:
 *
 *   join_gate_events       spammer / name / avatar / verification / rejoin bans (detail)
 *   phishing_detections    message threats (the message link, the matched domain)
 *   global_ban_action_log  global ban enforcement (the network entry)
 *
 * A ban our bot made for a person (/ban, the dashboard) is not automated: it has a human `Ban`
 * infraction within a few minutes, or ingestBan recorded it as a moderator's.
 */
import { contextFromReason } from './global-ban-confidence.js';

/** Every protection that can ban, with the dashboard page that configures it. */
export const PROTECTIONS = Object.freeze({
    spammer: { label: 'Spammer check', page: 'security' },
    name: { label: 'Name filter', page: 'name-filters' },
    avatar: { label: 'Avatar protection', page: 'avatar-protection' },
    nsfw: { label: 'NSFW protection', page: 'nsfw-protection' },
    raid: { label: 'Raid detection', page: 'advanced-protection' },
    lockdown: { label: 'Raid lockdown', page: 'advanced-protection' },
    message_threat: { label: 'Message threats', page: 'message-threats' },
    phishing: { label: 'Phishing', page: 'phishing' },
    scam_image: { label: 'Scam images', page: 'phishing' },
    global_ban: { label: 'Global ban', page: 'global-ban' },
    join_gate: { label: 'Join gate (account age)', page: 'security' },
    rejoin: { label: 'Rejoin limit', page: 'rejoin' },
    verification: { label: 'Verification', page: 'verification' },
    selfbot: { label: 'Self-bot detection', page: 'advanced-protection' },
    spam: { label: 'Spam filter', page: 'advanced-protection' },
    automod: { label: 'Automod', page: 'automod' },
    escalation: { label: 'Auto escalation', page: 'moderation' },
    anti_nuke: { label: 'Anti-nuke', page: 'security' },
    other: { label: 'Automatic (other)', page: 'moderation' },
});

const HUMAN_MATCH_MS = 5 * 60_000;
const EVIDENCE_BEFORE_MS = 10 * 60_000;
const EVIDENCE_AFTER_MS = 2 * 60_000;
const DUPLICATE_MS = 60_000;

/** join_gate_events.action -> protection key, for the ban outcomes. */
export const EVENT_PROTECTION = Object.freeze({
    spammer_banned: 'spammer', name_banned: 'name', avatar_banned: 'avatar', verify_banned: 'verification',
    rejoin_banned: 'rejoin', nsfw_banned: 'nsfw',
});

export function parseMeta(meta) {
    if (!meta) return {};
    if (typeof meta === 'object') return meta;
    try { return JSON.parse(meta) || {}; } catch { return {}; }
}

const ms = (t) => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : new Date(t).getTime());

/**
 * Was this ban automated, and by which protection?
 * @param row        audit_logs GUILD_BAN_ADD row { user_id, moderator_id, reason, metadata, timestamp }
 * @param fleetIds   Set of our bots' user ids
 * @param humanBans  [{ user_id, moderator_id, created_at }] Ban infractions (any moderator)
 * @returns {{ automated: boolean, protection: string|null, candidate?: boolean }}
 */
export function classifyBanRow(row, { fleetIds = new Set(), humanBans = [] } = {}) {
    const meta = parseMeta(row.metadata);
    if (meta.source) {
        if (meta.source !== 'protection') return { automated: false, protection: null };
        return { automated: true, protection: PROTECTIONS[meta.protection] ? meta.protection : 'other' };
    }
    if (!row.moderator_id || !fleetIds.has(String(row.moderator_id))) return { automated: false, protection: null };
    const ctx = contextFromReason(row.reason);
    if (ctx) return { automated: true, protection: PROTECTIONS[ctx] ? ctx : 'other' };
    const at = ms(row.timestamp);
    const byPerson = humanBans.some(b => String(b.user_id) === String(row.user_id)
        && !fleetIds.has(String(b.moderator_id)) && Math.abs(ms(b.created_at) - at) <= HUMAN_MATCH_MS);
    if (byPerson) return { automated: false, protection: null };
    // Our bot, a reason none of our protections writes, no person on record: probably a command that
    // keeps no infraction (prefix commands, older dashboards). Only counted when a protection's own
    // evidence backs it (assembleBanLog); classification at ban time (metadata) settles new bans.
    return { automated: false, protection: 'other', candidate: true };
}

/**
 * The evidence row nearest the ban for the same member (and, when it says, the same protection).
 * @param ban       { userId, at, protection }
 * @param evidence  [{ userId, at, protection, text, url, page }]
 */
export function matchEvidence(ban, evidence) {
    let best = null;
    let bestGap = Infinity;
    for (const e of evidence || []) {
        if (String(e.userId) !== String(ban.userId)) continue;
        const gap = ms(e.at) - ban.at;
        if (gap < -EVIDENCE_BEFORE_MS || gap > EVIDENCE_AFTER_MS) continue;
        const sameKind = !e.protection || !ban.protection || ban.protection === 'other' || e.protection === ban.protection;
        if (!sameKind) continue;
        if (Math.abs(gap) < bestGap) { best = e; bestGap = Math.abs(gap); }
    }
    return best;
}

/**
 * The ban log: automated bans newest first, one per ban, with evidence and whether they were lifted.
 * @returns {Array<{ userId, username, at, protection, label, page, reason, evidence, unbanned, unbannedAt }>}
 */
export function assembleBanLog({ bans = [], unbans = [], humanBans = [], evidence = [], fleetIds = new Set(), limit = 200 } = {}) {
    const out = [];
    const sorted = [...bans].sort((a, b) => ms(b.timestamp) - ms(a.timestamp));
    for (const row of sorted) {
        const cls = classifyBanRow(row, { fleetIds, humanBans });
        if (!cls.automated && !cls.candidate) continue;
        const at = ms(row.timestamp);
        const userId = String(row.user_id);
        const dup = out.find(r => r.userId === userId && Math.abs(r.at - at) <= DUPLICATE_MS);
        if (dup) { if (!dup.username) dup.username = parseMeta(row.metadata).username || null; continue; }
        // Matched evidence can name the protection when the ban itself could not (an 'other').
        const ev = matchEvidence({ userId, at, protection: cls.protection }, evidence);
        if (cls.candidate && !ev?.protection) continue;
        const protection = cls.protection === 'other' && ev?.protection ? ev.protection : cls.protection;
        const lifted = unbans
            .filter(u => String(u.user_id) === userId && ms(u.timestamp) > at)
            .sort((a, b) => ms(a.timestamp) - ms(b.timestamp))[0];
        const meta = parseMeta(row.metadata);
        out.push({
            userId,
            username: meta.username || null,
            at,
            protection,
            label: PROTECTIONS[protection]?.label || PROTECTIONS.other.label,
            page: PROTECTIONS[protection]?.page || 'moderation',
            reason: row.reason || null,
            evidence: ev ? { text: ev.text || null, url: ev.url || null, page: ev.page || PROTECTIONS[protection]?.page || null } : null,
            unbanned: !!lifted,
            unbannedAt: lifted ? ms(lifted.timestamp) : null,
        });
        if (out.length >= limit) break;
    }
    return out;
}

/** Ban-log rows split by protection, for the overview's "top" list. */
export function countByProtection(rows) {
    const counts = {};
    for (const r of rows || []) counts[r.protection] = (counts[r.protection] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
        .map(([key, n]) => ({ key, label: PROTECTIONS[key]?.label || key, n }));
}
