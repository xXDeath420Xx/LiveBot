/*
 * Stream bot: the `webhook.post` action (design §2.5). An SSRF-safe HTTPS POST.
 *
 *   - https only, port 443, no user:password@ (checkUrl from utils/safe-fetch.js, then stricter)
 *   - the host must be on the profile's allow-list (exact, case-insensitive host names)
 *   - every resolved address must be public (resolvePublic: loopback, RFC 1918, CGNAT, link-local and
 *     cloud metadata, IPv6 private ranges, IPv4 inside IPv6 are refused)
 *   - the socket connects to the address that was checked (pinned `lookup`), so DNS rebinding between
 *     the check and the connect cannot redirect it
 *   - no redirects (a 3xx is a failure), 5 s overall, body at most 16 KB, response read up to 4 KB
 *
 * `resolver` and `transport` are injectable for tests (tests/stream-bot-webhook.test.js).
 */
import https from 'node:https';
import net from 'node:net';
import { checkUrl, resolvePublic, SafeFetchError } from '../../utils/safe-fetch.js';

export const WEBHOOK_LIMITS = Object.freeze({ timeoutMs: 5000, maxBody: 16 * 1024, maxResponse: 4096, maxHosts: 20 });
export const WEBHOOK_UA = 'CertiFried-StreamBot/1.0 (+https://certifriedmultitool.com/docs/guides/stream-bot)';
const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export class WebhookError extends Error {
    constructor(code, message = code) { super(message); this.name = 'WebhookError'; this.code = code; }
}

/** Clean an allow-list from the dashboard: lower-case DNS names only (no IPs, ports, paths), at most 20. */
export function normaliseAllowList(list) {
    const out = [];
    const errors = [];
    for (const raw of Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)) {
        let h = String(raw || '').trim().toLowerCase();
        if (!h) continue;
        h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
        if (net.isIP(h) || !HOST_RE.test(h)) { errors.push(`"${String(raw).slice(0, 60)}" is not a host name`); continue; }
        if (!out.includes(h)) out.push(h);
    }
    if (out.length > WEBHOOK_LIMITS.maxHosts) errors.push(`At most ${WEBHOOK_LIMITS.maxHosts} hosts.`);
    return { hosts: out.slice(0, WEBHOOK_LIMITS.maxHosts), errors };
}

/** The checks that need no network: URL shape, https, port, allow-list. Returns the URL. */
export function checkWebhookUrl(raw, allowHosts = []) {
    let url;
    try { url = checkUrl(raw); } catch (e) { throw new WebhookError(e.code || 'bad_url', e.message); }
    if (url.protocol !== 'https:') throw new WebhookError('protocol', 'Webhooks must use https://');
    if (url.port && url.port !== '443') throw new WebhookError('port', 'Webhooks must use port 443');
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (net.isIP(host.replace(/^\[|\]$/g, ''))) throw new WebhookError('ip_host', 'Use a host name, not an IP address');
    const allowed = (allowHosts || []).map((h) => String(h).toLowerCase());
    if (!allowed.includes(host)) throw new WebhookError('not_allowed', `${host} is not on your webhook allow-list`);
    return url;
}

function defaultTransport({ url, address, family, headers, body, signal }) {
    return new Promise((resolve, reject) => {
        const host = url.hostname;
        const req = https.request({
            protocol: 'https:', hostname: host, port: 443, path: `${url.pathname}${url.search}`, method: 'POST',
            headers, signal, agent: false, servername: host,
            lookup: (_n, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                if (size < WEBHOOK_LIMITS.maxResponse) { chunks.push(c); size += c.length; }
                if (size >= WEBHOOK_LIMITS.maxResponse) res.destroy();
            });
            const done = () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, WEBHOOK_LIMITS.maxResponse) });
            res.on('end', done);
            res.on('close', done);
            res.on('error', done);
        });
        req.on('error', reject);
        req.end(body);
    });
}

/**
 * POST `body` (a string; JSON by default) to `rawUrl`.
 * @returns {Promise<{ status:number, ms:number, host:string }>}
 */
export async function postWebhook(rawUrl, body, { allowHosts = [], resolver, transport = defaultTransport, timeoutMs = WEBHOOK_LIMITS.timeoutMs, contentType = 'application/json' } = {}) {
    const url = checkWebhookUrl(rawUrl, allowHosts);
    const payload = Buffer.from(String(body ?? ''), 'utf8');
    if (payload.length > WEBHOOK_LIMITS.maxBody) throw new WebhookError('too_large', `The body is over ${WEBHOOK_LIMITS.maxBody / 1024} KB`);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let resolved;
        try { resolved = await resolvePublic(url.hostname, ...(resolver ? [resolver] : [])); } catch (e) {
            throw new WebhookError(e instanceof SafeFetchError ? e.code : 'dns', e.message);
        }
        const headers = { 'User-Agent': WEBHOOK_UA, 'Content-Type': contentType, 'Content-Length': String(payload.length), Accept: '*/*' };
        let res;
        try {
            res = await Promise.race([
                transport({ url, address: resolved.address, family: resolved.family, headers, body: payload, signal: controller.signal }),
                new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new WebhookError('timeout', 'The webhook took too long to answer')), { once: true })),
            ]);
        } catch (e) {
            if (e instanceof WebhookError) throw e;
            throw new WebhookError(controller.signal.aborted ? 'timeout' : 'network', 'Could not reach the webhook');
        }
        const status = Number(res?.status) || 0;
        if (status >= 300 && status < 400) throw new WebhookError('redirect', `The webhook answered with a redirect (HTTP ${status}); redirects are not followed`);
        if (status < 200 || status >= 300) throw new WebhookError('http_status', `The webhook answered HTTP ${status}`);
        return { status, ms: Date.now() - started, host: url.hostname };
    } finally {
        clearTimeout(timer);
    }
}

export default { postWebhook, checkWebhookUrl, normaliseAllowList, WebhookError, WEBHOOK_LIMITS };
