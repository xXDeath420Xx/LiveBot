/*
 * Outbound HTTP for URLs a server admin (or a member, through command arguments) gets to choose:
 * custom-command `{api:…}` tokens and the Evil Insult source of `/fun insult`.
 *
 * A URL typed into a dashboard is an SSRF hole unless every hop is checked, so this module only
 * ever fetches:
 *   - http: or https: on port 80 or 443, with no user:password@ in the URL
 *   - a host whose EVERY resolved address is public — loopback, RFC 1918, CGNAT (100.64/10),
 *     link-local and the cloud metadata address (169.254.169.254), multicast/reserved, and the IPv6
 *     loopback/ULA/link-local ranges are refused, as are IPv4 addresses smuggled inside IPv6
 *     (::ffff:a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16)
 *   - the address it checked: the socket connects to that address through `lookup`, so a DNS
 *     answer that changes between the check and the connect (rebinding) cannot redirect it
 *   - again on every redirect (at most 3), since a public URL can 302 to http://127.0.0.1
 * It reads at most 64 KB, gives up after 5 s overall, sends no cookies or credentials and names the
 * bot in its User-Agent.
 *
 * `resolver` and `transport` are injectable so the guard is unit-tested without the network
 * (tests/custom-command-api.test.js). Throws SafeFetchError with a `code`; callers turn that into
 * a short "(API error)" for members and log the code at debug.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

export const SAFE_FETCH_LIMITS = Object.freeze({ timeoutMs: 5000, maxBytes: 64 * 1024, maxRedirects: 3 });
export const USER_AGENT = 'CertiFriedUtility-DiscordBot/1.0 (custom command API fetch; +https://certifriedmultitool.com)';

const ALLOWED_PORTS = new Set(['', '80', '443']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BLOCKED_NAMES = /^(?:localhost|localhost\.localdomain|ip6-localhost|ip6-loopback|metadata|metadata\.google\.internal)$|\.(?:localhost|local|internal|intranet|lan|home\.arpa|corp)$/i;

export class SafeFetchError extends Error {
    constructor(code, message = code) {
        super(message);
        this.name = 'SafeFetchError';
        this.code = code;
    }
}

const BLOCK_V4 = new net.BlockList();
for (const [ip, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCK_V4.addSubnet(ip, bits, 'ipv4');

const BLOCK_V6 = new net.BlockList();
for (const [ip, bits] of [
    ['::', 128], ['::1', 128], ['::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
    ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCK_V6.addSubnet(ip, bits, 'ipv6');

/** Eight 16-bit groups of an IPv6 address (embedded dotted IPv4 tail allowed); null if malformed. */
function v6Groups(addr) {
    let s = String(addr).toLowerCase();
    const tail = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (tail) {
        const o = tail[1].split('.').map(Number);
        if (o.some(n => n > 255)) return null;
        s = s.slice(0, -tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
    const fill = rest ? 8 - head.length - rest.length : 0;
    if (fill < 0 || (!rest && head.length !== 8)) return null;
    const groups = [...head, ...Array(fill).fill('0'), ...(rest || [])].map(g => parseInt(g, 16));
    return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4Of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True when an IP literal is one this module must never connect to. Non-IPs count as blocked. */
export function isBlockedAddress(address) {
    const ip = String(address || '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const family = net.isIP(ip);
    if (family === 4) return BLOCK_V4.check(ip, 'ipv4');
    if (family !== 6) return true;
    const g = v6Groups(ip);
    if (!g) return true;
    // IPv4 inside IPv6: mapped ::ffff:a.b.c.d, NAT64 64:ff9b::a.b.c.d, 6to4 2002:aabb:ccdd::
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return isBlockedAddress(v4Of(g[6], g[7]));
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isBlockedAddress(v4Of(g[6], g[7]));
    if (g[0] === 0x2002) return isBlockedAddress(v4Of(g[1], g[2])) || BLOCK_V6.check(ip, 'ipv6');
    return BLOCK_V6.check(ip, 'ipv6');
}

/** Parse and check a URL's shape (scheme, port, credentials, host name). Returns the URL object. */
export function checkUrl(raw) {
    let url;
    try { url = new URL(String(raw || '').trim()); } catch { throw new SafeFetchError('bad_url', 'Not a valid URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError('protocol', 'Only http and https URLs are allowed');
    if (url.username || url.password) throw new SafeFetchError('credentials', 'URLs with a username or password are not allowed');
    if (!ALLOWED_PORTS.has(url.port)) throw new SafeFetchError('port', 'Only ports 80 and 443 are allowed');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host || BLOCKED_NAMES.test(host.replace(/\.$/, ''))) throw new SafeFetchError('blocked_host', 'That host is not allowed');
    if (net.isIP(host) && isBlockedAddress(host)) throw new SafeFetchError('blocked_address', 'That address is private or reserved');
    return url;
}

const defaultResolver = (host) => dns.lookup(host, { all: true, verbatim: true });

/** Resolve a host and insist every address is public; returns the one to connect to. */
export async function resolvePublic(hostname, resolver = defaultResolver) {
    const host = String(hostname).replace(/^\[|\]$/g, '');
    if (net.isIP(host)) {
        if (isBlockedAddress(host)) throw new SafeFetchError('blocked_address', 'That address is private or reserved');
        return { address: host, family: net.isIP(host) };
    }
    let answers;
    try { answers = await resolver(host); } catch { throw new SafeFetchError('dns', 'Could not resolve that host'); }
    const list = (Array.isArray(answers) ? answers : [answers]).filter(a => a && a.address);
    if (!list.length) throw new SafeFetchError('dns', 'Could not resolve that host');
    if (list.some(a => isBlockedAddress(a.address))) throw new SafeFetchError('blocked_address', 'That host resolves to a private or reserved address');
    const first = list[0];
    return { address: first.address, family: first.family || net.isIP(first.address) };
}

/** Real network transport: connects to the pre-checked address while keeping Host/SNI/cert checks on the name. */
function defaultTransport({ url, address, family, headers, signal }) {
    return new Promise((resolve, reject) => {
        const secure = url.protocol === 'https:';
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const req = (secure ? https : http).request({
            protocol: url.protocol,
            hostname: host,
            port: url.port || (secure ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            headers,
            signal,
            agent: false,
            servername: net.isIP(host) ? undefined : host,
            lookup: (_name, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
        }, (res) => resolve({ status: res.statusCode, headers: res.headers, body: res }));
        req.on('error', reject);
        req.end();
    });
}

function abortable(promise, signal) {
    if (signal.aborted) return Promise.reject(new SafeFetchError('timeout', 'The API took too long to answer'));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new SafeFetchError('timeout', 'The API took too long to answer'));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

async function readCapped(body, maxBytes, signal) {
    const chunks = [];
    let size = 0, truncated = false;
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
        const buf = Buffer.from(body);
        return { buf: buf.subarray(0, maxBytes), truncated: buf.length > maxBytes };
    }
    const read = (async () => {
        for await (const chunk of body) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (size + buf.length >= maxBytes) {
                chunks.push(buf.subarray(0, maxBytes - size));
                size = maxBytes;
                truncated = true;
                break;
            }
            chunks.push(buf);
            size += buf.length;
        }
    })();
    try {
        await abortable(read, signal);
    } finally {
        if (truncated || signal.aborted) body.destroy?.();
    }
    return { buf: Buffer.concat(chunks), truncated };
}

/**
 * GET a URL under every rule above.
 * @returns {Promise<{ status:number, url:string, contentType:string, text:string, truncated:boolean, redirects:number }>}
 */
export async function safeFetch(rawUrl, {
    resolver = defaultResolver, transport = defaultTransport, timeoutMs = SAFE_FETCH_LIMITS.timeoutMs,
    maxBytes = SAFE_FETCH_LIMITS.maxBytes, maxRedirects = SAFE_FETCH_LIMITS.maxRedirects,
    accept = 'text/plain, application/json;q=0.9, */*;q=0.5',
} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Encoding': 'identity' };
    try {
        let url = checkUrl(rawUrl);
        for (let hop = 0; ; hop++) {
            const { address, family } = await abortable(resolvePublic(url.hostname, resolver), controller.signal);
            let res;
            try {
                res = await abortable(transport({ url, address, family, headers, signal: controller.signal }), controller.signal);
            } catch (err) {
                if (err instanceof SafeFetchError) throw err;
                throw new SafeFetchError(controller.signal.aborted ? 'timeout' : 'network', 'Could not reach the API');
            }
            const status = Number(res.status) || 0;
            if (REDIRECTS.has(status) && res.headers?.location) {
                res.body?.destroy?.();
                if (hop >= maxRedirects) throw new SafeFetchError('too_many_redirects', 'The API redirected too many times');
                url = checkUrl(new URL(String(res.headers.location), url).href);
                continue;
            }
            if (status < 200 || status >= 300) {
                res.body?.destroy?.();
                throw new SafeFetchError('http_status', `The API answered HTTP ${status}`);
            }
            const { buf, truncated } = await readCapped(res.body, maxBytes, controller.signal);
            return {
                status,
                url: url.href,
                contentType: String(res.headers?.['content-type'] || ''),
                text: new TextDecoder('utf-8').decode(buf),
                truncated,
                redirects: hop,
            };
        }
    } finally {
        clearTimeout(timer);
    }
}

export default { safeFetch, checkUrl, resolvePublic, isBlockedAddress, SafeFetchError, SAFE_FETCH_LIMITS, USER_AGENT };
