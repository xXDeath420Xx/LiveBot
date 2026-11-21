/*
 * Link intelligence — the live side (name checks are pure, in core/link-intel-logic.js).
 *
 *   domain age   RDAP, the registries' own JSON service. The registry for a TLD comes from IANA's bootstrap
 *                file (data.iana.org/rdap/dns.json, refreshed daily); we then ask THAT registry about the
 *                domain NAME. No redirect is followed and no member URL is ever requested: the only hosts we
 *                talk to are IANA and the registry servers IANA lists. Answers are cached in
 *                ai_mod_domain_intel (60 days, data_retention_policy). Lookups run in the background with a
 *                small queue, so a message never waits on a registry unless the caller asks for a short wait.
 *   invites      Discord's own invite endpoint (client.fetchInvite), cached 6 hours: which server an invite
 *                leads to, its name and age. Not SSRF: the request goes to Discord with the invite code.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { isSafeDomain } from './safe-domains.js';
import { classifyHost, registrable } from './link-policy.js';
import { isRealBrandHost } from './link-intel-logic.js';

const LOG = '[LinkIntel]';
const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL_MS = 24 * 3600_000;
const RDAP_TIMEOUT_MS = 4000;
const MEM_TTL_MS = 6 * 3600_000;
const RECHECK_DAYS = { ok: 60, not_found: 3, no_rdap: 30, error: 1 };
const MAX_QUEUE = 200;
const PER_MINUTE = 30;
const DISCORD_EPOCH = 1420070400000n;

let bootstrap = null;          // { at, map: Map<tld, baseUrl> }
let bootstrapLoading = null;
const memo = new Map();        // domain -> { at, days|null, status }
const queue = new Set();
let running = 0;
let minuteWindow = [];

async function loadBootstrap() {
    if (bootstrap && Date.now() - bootstrap.at < BOOTSTRAP_TTL_MS) return bootstrap.map;
    if (bootstrapLoading) return bootstrapLoading;
    bootstrapLoading = (async () => {
        try {
            const res = await fetch(BOOTSTRAP_URL, { signal: AbortSignal.timeout(8000), redirect: 'error' });
            const json = await res.json();
            const map = new Map();
            for (const [tlds, urls] of json.services || []) {
                const base = (urls || []).find(u => u.startsWith('https://')) || urls?.[0];
                if (!base) continue;
                for (const t of tlds) map.set(String(t).toLowerCase(), base.endsWith('/') ? base : `${base}/`);
            }
            bootstrap = { at: Date.now(), map };
            return map;
        } catch (err) {
            logger.warn(`${LOG} RDAP bootstrap failed: ${err.message}`);
            bootstrap = { at: Date.now() - BOOTSTRAP_TTL_MS + 600_000, map: bootstrap?.map || new Map() };   // retry in 10 min
            return bootstrap.map;
        } finally { bootstrapLoading = null; }
    })();
    return bootstrapLoading;
}

/** Hosts worth an age lookup: unknown sites only (not platforms, media hosts, brands, shorteners). */
export function wantsAge(host) {
    const h = String(host || '').toLowerCase();
    if (!h || /^\d+(?:\.\d+){3}$/.test(h)) return false;
    if (isSafeDomain(h) || isRealBrandHost(h)) return false;
    const c = classifyHost(h);
    return c.category === 'unknown';
}

const daysSince = (d) => (d ? (Date.now() - new Date(d).getTime()) / 86_400_000 : null);

/** RDAP registration date of a registrable domain → { status, registeredAt|null }. Never throws. */
export async function rdapLookup(domain) {
    const tld = domain.slice(domain.lastIndexOf('.') + 1);
    const map = await loadBootstrap();
    const base = map.get(tld);
    if (!base) return { status: 'no_rdap', registeredAt: null };
    try {
        const res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
            headers: { Accept: 'application/rdap+json' }, redirect: 'error', signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
        });
        if (res.status === 404) return { status: 'not_found', registeredAt: null };
        if (!res.ok) return { status: 'error', registeredAt: null };
        const json = await res.json();
        const ev = (json.events || []).find(e => /registration/i.test(e.eventAction || ''));
        const when = ev?.eventDate ? new Date(ev.eventDate) : null;
        return { status: 'ok', registeredAt: when && !Number.isNaN(when.getTime()) ? when : null };
    } catch {
        return { status: 'error', registeredAt: null };
    }
}

async function lookupAndStore(domain) {
    const r = await rdapLookup(domain);
    memo.set(domain, { at: Date.now(), days: daysSince(r.registeredAt), status: r.status });
    await pool.execute(
        `INSERT INTO ai_mod_domain_intel (domain, registered_at, status) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE registered_at = VALUES(registered_at), status = VALUES(status), checked_at = NOW()`,
        [domain, r.registeredAt, r.status]).catch(err => logger.debug(`${LOG} store failed for ${domain}: ${err.message}`));
    return memo.get(domain);
}

function pump() {
    while (running < 2 && queue.size) {
        const now = Date.now();
        minuteWindow = minuteWindow.filter(t => now - t < 60_000);
        if (minuteWindow.length >= PER_MINUTE) { setTimeout(pump, 5000).unref?.(); return; }
        const domain = queue.values().next().value;
        queue.delete(domain);
        minuteWindow.push(now);
        running++;
        lookupAndStore(domain).catch(() => {}).finally(() => { running--; pump(); });
    }
}

async function fromDb(domain) {
    try {
        const [[row]] = await pool.execute('SELECT registered_at, status, checked_at FROM ai_mod_domain_intel WHERE domain = ?', [domain]);
        if (!row) return null;
        const ageDays = daysSince(row.checked_at);
        if (ageDays > (RECHECK_DAYS[row.status] ?? 7)) return null;
        const hit = { at: Date.now(), days: daysSince(row.registered_at), status: row.status };
        memo.set(domain, hit);
        return hit;
    } catch { return null; }
}

/**
 * Age in days of the domain behind a host, or null when unknown. With waitMs > 0 an uncached domain is looked
 * up for at most that long; otherwise the lookup is queued and the answer is there next time.
 */
export async function domainAgeDays(host, { waitMs = 0 } = {}) {
    if (!wantsAge(host)) return null;
    const domain = registrable(String(host).toLowerCase());
    const m = memo.get(domain);
    if (m && Date.now() - m.at < MEM_TTL_MS) return m.days;
    const db = await fromDb(domain);
    if (db) return db.days;
    if (waitMs > 0) {
        const r = await Promise.race([lookupAndStore(domain), new Promise(res => setTimeout(() => res(null), waitMs).unref?.())]);
        return r?.days ?? null;
    }
    if (queue.size < MAX_QUEUE) { queue.add(domain); pump(); }
    return null;
}

// ── Discord invites ──────────────────────────────────────────────────────────

const inviteMemo = new Map();   // code -> { at, info|null }
const INVITE_TTL_MS = 6 * 3600_000;
let inviteWindow = [];

/** { guildId, name, createdDays } for an invite code, or null (expired, invalid, or not resolvable now). */
export async function resolveInvite(client, code) {
    const hit = inviteMemo.get(code);
    if (hit && Date.now() - hit.at < INVITE_TTL_MS) return hit.info;
    const now = Date.now();
    inviteWindow = inviteWindow.filter(t => now - t < 60_000);
    if (inviteWindow.length >= 20 || !client?.fetchInvite) return null;
    inviteWindow.push(now);
    let info = null;
    try {
        const inv = await Promise.race([client.fetchInvite(code), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000).unref?.())]);
        const g = inv?.guild;
        if (g?.id) {
            let createdDays = null;
            try { createdDays = (now - Number((BigInt(g.id) >> 22n) + DISCORD_EPOCH)) / 86_400_000; } catch { /* not a snowflake */ }
            info = { guildId: String(g.id), name: String(g.name || '').slice(0, 100), createdDays };
        }
    } catch { info = null; }
    inviteMemo.set(code, { at: now, info });
    if (inviteMemo.size > 2000) inviteMemo.delete(inviteMemo.keys().next().value);
    return info;
}

export default { wantsAge, rdapLookup, domainAgeDays, resolveInvite };
