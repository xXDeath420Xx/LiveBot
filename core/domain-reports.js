/*
 * Domain reports and disputes — the live side (rules in core/domain-report-logic.js). Hashbot's brand-protection
 * "report a phishing site / dispute a false flag" with an activity history (Pending / Blocked / Resolved /
 * Rejected), built on what we already have rather than beside it:
 *
 *   storage      the existing scam_reports table (the /engage report table, which already had a 'website'
 *                report type): report_type 'phishing_url' | 'domain_dispute', status widened with
 *                blocked | resolved | rejected, plus domain and a JSON history (migration 331). /engage report
 *                only ever reads its own report types, so the two never mix.
 *   from         /tools checkurl result buttons (a modal for the reason), the dashboard's Domain Reports page,
 *                and the Message Threats URL checker (which links there). Members and moderators alike.
 *   review       the bot owner / super-admins only (dashboard Domain Reports page, req.isSuperAdmin). Approving
 *                uses the overrides the phishing pipeline already honours:
 *                  report   → phishing_domains row with source 'manual' (the feeds' sync never prunes it and,
 *                             since migration 331's companion change, never re-labels it)
 *                  dispute  → the global allow list: link_policy_domains guild_id '0' kind 'allow', which
 *                             PhishingDetectionManager hands to core/safe-domains.js on every load; the feed row
 *                             is deleted too. Both take effect in memory at once.
 *                Every other pending entry for the same domain and kind is decided with it.
 *   outcome      the reporter gets a DM from the bot that serves the server they reported from (once), and the
 *                server log gets a line (automod.domainReport).
 *   overrides    the review page lists every manual block and global allow, each removable.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { safeSource, normalizeHost, setOverrideSafeDomains, overrideSafeDomains } from './safe-domains.js';
import {
    KINDS, KIND_LABEL, STATUS_LABEL, validateSubmission, approvalPlan, historyAppend, parseHistory, outcomeMessage, rateAllows,
    PER_GUILD_PER_DAY, MAX_NOTE, hostOf,
} from './domain-report-logic.js';

const pdm = () => import('./phishing-detection-manager.js');
const userTimes = new Map();   // userId -> [ms] submissions in the last hour
const TYPES_SQL = `'${KINDS.report}', '${KINDS.dispute}'`;

/** The phishing-list entry a host falls under (or null), and why it is never flagged (or null). */
export async function lookup(host) {
    const h = normalizeHost(host);
    let listedAs = null;
    try { listedAs = h ? (await pdm()).phishingLookup(h) : null; } catch { listedAs = null; }
    return { host: h, listedAs, safe: h ? safeSource(h) : null };
}

/**
 * File a report or a dispute.
 * @param {object} p
 * @param {import('discord.js').Guild} p.guild   where it was filed from (its log gets the line; its bot DMs the outcome)
 * @param {{ id:string, username?:string }} p.user
 * @param {'report'|'dispute'} p.kind
 * @param {string} p.url
 * @param {string} p.reason
 * @param {string} [p.source]  'command' | 'dashboard'
 * @returns {Promise<{ ok:true, id:number, host:string } | { ok:false, error:string }>}
 */
export async function submit({ guild, user, kind, url, reason, source = 'dashboard' }) {
    const now = Date.now();
    const rate = rateAllows(userTimes.get(user.id), now);
    if (!rate.ok) return { ok: false, error: 'You have sent several reports in the last hour. Try again later.' };
    const host = hostOf(url);
    const { listedAs, safe } = await lookup(host);
    const check = validateSubmission({ kind, url, reason, listedAs, safe });
    if (!check.ok) return check;
    const [[dup]] = await pool.execute(
        `SELECT id FROM scam_reports WHERE report_type = ? AND domain = ? AND reporter_id = ? AND status = 'pending' LIMIT 1`,
        [check.kind, check.host, user.id]);
    if (dup) return { ok: false, error: `You already have a pending ${check.kind === KINDS.dispute ? 'dispute' : 'report'} for ${check.host} (#${dup.id}).` };
    const [[day]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM scam_reports WHERE guild_id = ? AND report_type IN (${TYPES_SQL}) AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)`,
        [guild.id]);
    if (Number(day?.n ?? 0) >= PER_GUILD_PER_DAY) return { ok: false, error: 'This server has sent a lot of domain reports today. Try again tomorrow.' };

    const history = historyAppend(null, { by: user.id, action: 'submitted', note: `from ${source === 'command' ? '/tools checkurl' : 'the dashboard'}` });
    const [res] = await pool.execute(
        `INSERT INTO scam_reports (guild_id, reporter_id, reported_username, report_type, scam_type, entity_name, website, description, status, domain, history)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [guild.id, user.id, user.username ? String(user.username).slice(0, 100) : null, check.kind, source === 'command' ? 'checkurl' : 'dashboard',
            check.host, check.url, check.reason, check.host, history]);
    rate.times.push(now);
    userTimes.set(user.id, rate.times);
    if (userTimes.size > 5000) for (const [k, v] of userTimes) if (!v.some(t => now - t < 3_600_000)) userTimes.delete(k);
    logger.info(`[DomainReports] #${res.insertId} ${check.kind} ${check.host} from ${guild.id} by ${user.id}`);
    void logFeatureEvent(() => (guild), 'automod.domainReport', () => ({
        title: check.kind === KINDS.dispute ? '📨 Block Dispute Sent' : '📨 Phishing Report Sent',
        description: `**${check.host}** went to the bot's reviewers (#${res.insertId}). The outcome is sent to the reporter by DM.`,
        fields: [['By', userLabel(user.id)], ['Reason', check.reason.slice(0, 300), false]],
    }));
    return { ok: true, id: res.insertId, host: check.host };
}

const shape = (r) => ({
    id: r.id, guildId: r.guild_id, reporterId: r.reporter_id, reporterName: r.reported_username, kind: r.report_type,
    kindLabel: KIND_LABEL[r.report_type] || r.report_type, domain: r.domain || r.entity_name, url: r.website, reason: r.description,
    status: r.status, statusLabel: STATUS_LABEL[r.status] || r.status, note: r.staff_notes, decidedBy: r.resolved_by,
    createdAt: r.created_at, decidedAt: r.resolved_at, history: parseHistory(r.history), notified: !!Number(r.notified ?? 0),
});

/**
 * Reports, newest first. guildId null = every server (the reviewers' queue).
 * @param {{ guildId?:string|null, status?:string, limit?:number }} p
 */
export async function list({ guildId = null, status = 'all', limit = 200 } = {}) {
    const where = [`report_type IN (${TYPES_SQL})`];
    const args = [];
    if (guildId) { where.push('guild_id = ?'); args.push(guildId); }
    if (status && status !== 'all') { where.push('status = ?'); args.push(status); }
    const [rows] = await pool.execute(
        `SELECT id, guild_id, reporter_id, reported_username, report_type, entity_name, website, description, status, staff_notes,
                resolved_by, created_at, resolved_at, domain, history, notified
           FROM scam_reports WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${Math.min(500, Math.max(1, Number(limit) || 200))}`, args);
    return rows.map(shape);
}

export async function counts({ guildId = null } = {}) {
    const [rows] = await pool.execute(
        `SELECT status, COUNT(*) AS n FROM scam_reports WHERE report_type IN (${TYPES_SQL})${guildId ? ' AND guild_id = ?' : ''} GROUP BY status`,
        guildId ? [guildId] : []);
    return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
}

// ── the overrides ────────────────────────────────────────────────────────────

async function addBlock(domain, by) {
    await pool.execute(
        `INSERT INTO phishing_domains (domain, source, last_seen_at) VALUES (?, 'manual', NOW())
         ON DUPLICATE KEY UPDATE source = 'manual', last_seen_at = NOW()`, [domain]);
    await pool.execute("DELETE FROM link_policy_domains WHERE guild_id = '0' AND domain = ? AND kind = 'allow'", [domain]);
    setOverrideSafeDomains(overrideSafeDomains().filter(d => d !== domain));
    const m = await pdm();
    m.applyDomainDecision(domain, 'block');
    void m.reloadPhishingList().catch(err => logger.warn(`[DomainReports] reload after block failed: ${err.message}`));
    logger.info(`[DomainReports] ${domain} blocked by ${by}`);
}

async function addAllow(domain, by, note) {
    await pool.execute(
        `INSERT INTO link_policy_domains (guild_id, domain, kind, note, created_by) VALUES ('0', ?, 'allow', ?, ?)
         ON DUPLICATE KEY UPDATE kind = 'allow', note = VALUES(note), created_by = VALUES(created_by)`,
        [domain, String(note || 'approved dispute').slice(0, 255), by]);
    await pool.execute('DELETE FROM phishing_domains WHERE domain = ?', [domain]);
    setOverrideSafeDomains([...overrideSafeDomains(), domain]);
    const m = await pdm();
    m.applyDomainDecision(domain, 'allow');
    void m.reloadPhishingList().catch(err => logger.warn(`[DomainReports] reload after allow failed: ${err.message}`));
    logger.info(`[DomainReports] ${domain} allowed by ${by}`);
}

/** Every manual block and global allow, for the review page. */
export async function overrides() {
    const [blocks] = await pool.execute(
        "SELECT domain, added_at, last_seen_at FROM phishing_domains WHERE source = 'manual' ORDER BY added_at DESC LIMIT 1000");
    const [allows] = await pool.execute(
        "SELECT domain, note, created_by, created_at FROM link_policy_domains WHERE guild_id = '0' AND kind = 'allow' ORDER BY created_at DESC LIMIT 1000");
    return {
        blocks: blocks.map(r => ({ domain: r.domain, addedAt: r.added_at })),
        allows: allows.map(r => ({ domain: r.domain, note: r.note, by: r.created_by, addedAt: r.created_at })),
    };
}

/** Take an override off again ('block' | 'allow'). */
export async function removeOverride(kind, domain, by) {
    const d = normalizeHost(domain);
    if (!d) return { ok: false, error: 'No domain given.' };
    const m = await pdm();
    if (kind === 'block') {
        const [r] = await pool.execute("DELETE FROM phishing_domains WHERE domain = ? AND source = 'manual'", [d]);
        if (!r.affectedRows) return { ok: false, error: `${d} is not on the manual block list.` };
        m.applyDomainDecision(d, 'allow');
    } else if (kind === 'allow') {
        const [r] = await pool.execute("DELETE FROM link_policy_domains WHERE guild_id = '0' AND domain = ? AND kind = 'allow'", [d]);
        if (!r.affectedRows) return { ok: false, error: `${d} is not on the global allow list.` };
        setOverrideSafeDomains(overrideSafeDomains().filter(x => x !== d));
    } else {
        return { ok: false, error: 'Unknown list.' };
    }
    void m.reloadPhishingList().catch(() => {});
    logger.info(`[DomainReports] ${kind} override for ${d} removed by ${by}`);
    return { ok: true };
}

// ── deciding ─────────────────────────────────────────────────────────────────

function clientFor(guildId) {
    const bm = global.botManager;
    return bm?.getClientForGuild?.(guildId) || bm?.getDefaultClient?.() || null;
}

async function notifyReporter(row, status, note) {
    try {
        const client = clientFor(row.guild_id);
        if (!client) return false;
        const user = await client.users.fetch(row.reporter_id);
        await user.send({ content: outcomeMessage({ id: row.id, kind: row.report_type, domain: row.domain || row.entity_name, status, note }), allowedMentions: { parse: [] } });
        await pool.execute('UPDATE scam_reports SET notified = 1 WHERE id = ?', [row.id]);
        return true;
    } catch (err) {
        logger.debug(`[DomainReports] could not DM the reporter of #${row.id}: ${err.message}`);
        return false;
    }
}

/**
 * Approve or reject a report (bot owner / super-admin only: the route checks). Every other pending entry for
 * the same domain and kind is decided with it.
 * @returns {Promise<{ ok:true, status:string, decided:number, notified:number } | { ok:false, error:string }>}
 */
export async function decide(id, decision, { by, note = null } = {}) {
    if (!['approve', 'reject'].includes(decision)) return { ok: false, error: 'Approve or reject.' };
    const [[row]] = await pool.execute(`SELECT * FROM scam_reports WHERE id = ? AND report_type IN (${TYPES_SQL})`, [Number(id)]);
    if (!row) return { ok: false, error: 'No such report.' };
    if (row.status !== 'pending') return { ok: false, error: `#${row.id} was already decided (${STATUS_LABEL[row.status] || row.status}).` };
    const domain = row.domain || row.entity_name;
    const plan = approvalPlan(row.report_type);
    const status = decision === 'approve' ? plan.status : 'rejected';
    const cleanNote = note ? String(note).replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) : null;
    if (decision === 'approve') {
        if (plan.override === 'block') await addBlock(domain, by);
        else await addAllow(domain, by, `dispute #${row.id}${cleanNote ? `: ${cleanNote}` : ''}`);
    }
    const [same] = await pool.execute(
        "SELECT * FROM scam_reports WHERE report_type = ? AND domain = ? AND status = 'pending'", [row.report_type, domain]);
    let notified = 0;
    for (const r of same) {
        const history = historyAppend(r.history, { by, action: status, note: r.id === row.id ? cleanNote : `decided with #${row.id}` });
        const [u] = await pool.execute(
            "UPDATE scam_reports SET status = ?, staff_notes = ?, resolved_by = ?, resolved_at = NOW(), history = ? WHERE id = ? AND status = 'pending'",
            [status, cleanNote, by, history, r.id]);
        if (!u.affectedRows) continue;
        if (await notifyReporter(r, status, cleanNote)) notified++;
        const client = clientFor(r.guild_id);
        const guild = client?.guilds?.cache?.get(r.guild_id) ?? null;
        if (guild) {
            void logFeatureEvent(() => (guild), 'automod.domainReport', () => ({
                title: `📬 ${KIND_LABEL[r.report_type] || 'Domain report'} ${STATUS_LABEL[status]}`,
                description: `**${domain}** (#${r.id}): ${status === 'blocked' ? 'now blocked everywhere the bot protects' : status === 'resolved' ? 'the block is lifted everywhere' : 'not approved'}.`,
                fields: [['Reported by', userLabel(r.reporter_id)], ['Note', cleanNote, false]],
            }));
        }
    }
    logger.info(`[DomainReports] #${row.id} (${row.report_type} ${domain}) ${status} by ${by}: ${same.length} entr${same.length === 1 ? 'y' : 'ies'}, ${notified} told`);
    return { ok: true, status, decided: same.length, notified };
}

// ── /tools checkurl buttons: the host rides in a short-lived token ───────────

const checks = new Map();   // token -> { host, userId, at }
const CHECK_TTL = 30 * 60_000;

export function rememberCheck(host, userId) {
    const token = Math.random().toString(36).slice(2, 10);
    const now = Date.now();
    checks.set(token, { host, userId, at: now });
    for (const [k, v] of checks) if (now - v.at > CHECK_TTL) checks.delete(k);
    return token;
}

export function peekCheck(token) {
    const c = checks.get(token);
    return c && Date.now() - c.at <= CHECK_TTL ? c : null;
}

export default { lookup, submit, list, counts, decide, overrides, removeOverride, rememberCheck, peekCheck };
