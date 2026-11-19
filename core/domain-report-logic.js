/*
 * Domain reports and disputes — the pure parts (no Discord or DB access; unit-tested in tests/domain-reports.test.js).
 * The live side is core/domain-reports.js.
 *
 *   kinds        'phishing_url'   a member reports a link they think is phishing (not on the list yet)
 *                'domain_dispute' a member disputes a domain the phishing list blocks (a false positive)
 *                Stored as scam_reports.report_type (the existing reports table; migration 331 widens it).
 *   statuses     pending → blocked (report approved: the domain joins the bot's own block list)
 *                        → resolved (dispute approved: the domain joins the global allow list)
 *                        → rejected
 *   validate     the host must be a real domain; a report of a domain the bot never flags (Discord, YouTube…)
 *                or one already blocked is refused; a dispute of a domain that is not blocked is refused.
 *   history      a small JSON log on the row: who did what, when (capped).
 */
import { normalizeHost } from './safe-domains.js';

export const KINDS = Object.freeze({ report: 'phishing_url', dispute: 'domain_dispute' });
export const KIND_LABEL = Object.freeze({ phishing_url: 'Phishing report', domain_dispute: 'Block dispute' });
export const STATUSES = Object.freeze(['pending', 'blocked', 'resolved', 'rejected']);
export const STATUS_LABEL = Object.freeze({ pending: 'Pending', blocked: 'Blocked', resolved: 'Resolved', rejected: 'Rejected' });
export const MIN_REASON = 10;
export const MAX_REASON = 1000;
export const MAX_NOTE = 500;
export const MAX_HISTORY = 50;
export const PER_USER_PER_HOUR = 5;
export const PER_GUILD_PER_DAY = 50;

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

/** The host of a link or a bare domain, or '' when it is not one. */
export function hostOf(input) {
    const raw = String(input ?? '').trim().slice(0, 500);
    if (!raw) return '';
    const h = normalizeHost(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!h || !DOMAIN.test(h)) return '';
    return h;
}

/**
 * Check a submission before it is stored.
 * @param {object} p
 * @param {string} p.kind        'report' | 'dispute' (or the stored phishing_url / domain_dispute)
 * @param {string} p.url
 * @param {string} p.reason
 * @param {string|null} p.listedAs   the phishing-list entry the host falls under, or null
 * @param {string|null} p.safe       'builtin' | 'override' | null (core/safe-domains.js safeSource)
 * @returns {{ ok:true, kind:string, host:string, url:string, reason:string } | { ok:false, error:string }}
 */
export function validateSubmission({ kind, url, reason, listedAs = null, safe = null }) {
    const k = KINDS[kind] || (Object.values(KINDS).includes(kind) ? kind : null);
    if (!k) return { ok: false, error: 'Choose report (a phishing link) or dispute (a wrongly blocked domain).' };
    const host = hostOf(url);
    if (!host) return { ok: false, error: 'That does not look like a link or a domain.' };
    const why = String(reason ?? '').replace(/\s+/g, ' ').trim();
    if (why.length < MIN_REASON) return { ok: false, error: `Say why in at least ${MIN_REASON} characters.` };
    if (k === KINDS.report) {
        if (safe === 'builtin') return { ok: false, error: `${host} is a platform the bot never flags (bulk lists get it wrong); it cannot be reported here.` };
        if (listedAs) return { ok: false, error: `${host} is already blocked (listed as ${listedAs}). Nothing to report.` };
    } else {
        if (!listedAs) return { ok: false, error: `${host} is not on the phishing list, so there is no block to dispute.` };
    }
    return { ok: true, kind: k, host: k === KINDS.dispute ? listedAs : host, url: String(url).trim().slice(0, 255), reason: why.slice(0, MAX_REASON) };
}

/** What approving a row does: the override to add and the status it ends in. */
export function approvalPlan(kind) {
    return kind === KINDS.dispute ? { override: 'allow', status: 'resolved' } : { override: 'block', status: 'blocked' };
}

/** Append one entry to the JSON history (oldest dropped past MAX_HISTORY). */
export function historyAppend(json, entry) {
    let list = [];
    try { const parsed = JSON.parse(json || '[]'); if (Array.isArray(parsed)) list = parsed; } catch { list = []; }
    list.push({ at: entry.at ?? new Date().toISOString(), by: entry.by ?? null, action: String(entry.action || 'note').slice(0, 24),
        note: entry.note ? String(entry.note).slice(0, MAX_NOTE) : null });
    return JSON.stringify(list.slice(-MAX_HISTORY));
}

export function parseHistory(json) {
    try { const parsed = JSON.parse(json || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/** The DM a reporter gets when their report or dispute is decided. */
export function outcomeMessage({ id, kind, domain, status, note = null }) {
    const what = kind === KINDS.dispute ? `Your dispute of the block on **${domain}**` : `Your report of **${domain}** as phishing`;
    const result = {
        blocked: 'was approved: the domain is now blocked by the bot in every server it protects.',
        resolved: 'was approved: the block is lifted, and the domain will not be flagged again in any server the bot protects.',
        rejected: 'was reviewed and not approved.',
    }[status] || `is now ${STATUS_LABEL[status] || status}.`;
    return `${what} (#${id}) ${result}${note ? `\nNote from the reviewer: ${String(note).slice(0, MAX_NOTE)}` : ''}\nThank you for helping keep servers safe.`;
}

/** Per-user rate: at most PER_USER_PER_HOUR submissions in the last hour. */
export function rateAllows(times, now, perHour = PER_USER_PER_HOUR) {
    const recent = (times || []).filter(t => now - t < 3_600_000);
    return { ok: recent.length < perHour, times: recent };
}

export default {
    KINDS, KIND_LABEL, STATUSES, STATUS_LABEL, hostOf, validateSubmission, approvalPlan, historyAppend, parseHistory, outcomeMessage, rateAllows,
};
