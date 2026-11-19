import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { postWebhook, checkWebhookUrl, normaliseAllowList, WEBHOOK_LIMITS } from '../core/stream-bot/webhook-out.js';

/*
 * The stream bot's webhook action (core/stream-bot/webhook-out.js, design §2.5) is SSRF-safe: https and port 443
 * only, allow-listed host names only, every resolved address public (no loopback, private, CGNAT, link-local,
 * metadata, IPv6 private or IPv4-in-IPv6), the socket pinned to the checked address, no redirects, size and time
 * limits. No network: resolver and transport are fakes.
 */

const ALLOW = ['hooks.example.org'];
const resolver = (map) => async (host) => {
    if (!(host in map)) throw new Error('ENOTFOUND');
    return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const okTransport = (calls) => async (req) => {
    calls.push({ address: req.address, host: req.url.hostname, method: 'POST', body: req.body.toString(), headers: req.headers });
    return { status: 200, body: 'ok' };
};
const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code; } };

test('allowed host with a public address: POSTs to the address it checked', async () => {
    const calls = [];
    const r = await postWebhook('https://hooks.example.org/stream?x=1', '{"a":1}', { allowHosts: ALLOW, resolver: resolver({ 'hooks.example.org': ['93.184.215.14'] }), transport: okTransport(calls) });
    assert.equal(r.status, 200);
    assert.equal(calls[0].address, '93.184.215.14');
    assert.equal(calls[0].host, 'hooks.example.org');
    assert.equal(calls[0].body, '{"a":1}');
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
    assert.match(calls[0].headers['User-Agent'], /CertiFried-StreamBot/);
});

test('URL rules: https, port 443, no credentials, host names only, allow-list', async () => {
    const t = { allowHosts: ALLOW, resolver: resolver({ 'hooks.example.org': ['93.184.215.14'] }), transport: okTransport([]) };
    assert.equal(await code(postWebhook('http://hooks.example.org/', '', t)), 'protocol');
    assert.equal(await code(postWebhook('https://hooks.example.org:8443/', '', t)), 'port');
    assert.equal(await code(postWebhook('https://user:pw@hooks.example.org/', '', t)), 'credentials');
    assert.equal(await code(postWebhook('https://other.example.org/', '', t)), 'not_allowed');
    assert.equal(await code(postWebhook('https://93.184.215.14/', '', { ...t, allowHosts: ['93.184.215.14'] })), 'ip_host');
    assert.equal(await code(postWebhook('https://[2606:2800:220:1::1]/', '', t)), 'ip_host');
    assert.equal(await code(postWebhook('ftp://hooks.example.org/', '', t)), 'protocol');
    assert.equal(await code(postWebhook('not a url', '', t)), 'bad_url');
    assert.equal(await code(postWebhook('https://localhost/', '', { ...t, allowHosts: ['localhost'] })), 'blocked_host');
    assert.equal(await code(postWebhook('https://metadata.google.internal/', '', { ...t, allowHosts: ['metadata.google.internal'] })), 'blocked_host');
    assert.ok(checkWebhookUrl('https://HOOKS.example.org./a', ALLOW), 'case and trailing dot');
});

test('every private, reserved and smuggled address is refused, even when only one answer is private', async () => {
    const bad = ['127.0.0.1', '10.1.2.3', '172.16.0.5', '192.168.1.1', '100.64.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1',
        '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::1'];
    for (const ip of bad) {
        const calls = [];
        const c = await code(postWebhook('https://hooks.example.org/', '', { allowHosts: ALLOW, resolver: resolver({ 'hooks.example.org': [ip] }), transport: okTransport(calls) }));
        assert.equal(c, 'blocked_address', `${ip} refused`);
        assert.equal(calls.length, 0, `${ip}: no request made`);
    }
    // DNS rebinding style answer: one public, one private → refused
    assert.equal(await code(postWebhook('https://hooks.example.org/', '', { allowHosts: ALLOW, resolver: resolver({ 'hooks.example.org': ['93.184.215.14', '10.0.0.1'] }), transport: okTransport([]) })), 'blocked_address');
    assert.equal(await code(postWebhook('https://hooks.example.org/', '', { allowHosts: ALLOW, resolver: resolver({}), transport: okTransport([]) })), 'dns');
});

test('no redirects, non-2xx fails, size and time limits', async () => {
    const t = (status) => ({ allowHosts: ALLOW, resolver: resolver({ 'hooks.example.org': ['93.184.215.14'] }), transport: async () => ({ status, body: '' }) });
    assert.equal(await code(postWebhook('https://hooks.example.org/', '', t(302))), 'redirect');
    assert.equal(await code(postWebhook('https://hooks.example.org/', '', t(500))), 'http_status');
    assert.equal(await code(postWebhook('https://hooks.example.org/', 'x'.repeat(WEBHOOK_LIMITS.maxBody + 1), t(200))), 'too_large');
    const slow = { allowHosts: ALLOW, resolver: resolver({ 'hooks.example.org': ['93.184.215.14'] }), transport: () => new Promise(() => {}), timeoutMs: 50 };
    assert.equal(await code(postWebhook('https://hooks.example.org/', '', slow)), 'timeout');
    const broken = { allowHosts: ALLOW, resolver: resolver({ 'hooks.example.org': ['93.184.215.14'] }), transport: async () => { throw new Error('ECONNRESET'); } };
    assert.equal(await code(postWebhook('https://hooks.example.org/', '', broken)), 'network');
});

test('allow-list input is cleaned: host names only, no IPs, ports or paths, at most 20', () => {
    const r = normaliseAllowList('https://Hooks.Example.org/path, discord.com\n10.0.0.1 bad_host! localhost hooks.example.org');
    assert.deepEqual(r.hosts, ['hooks.example.org', 'discord.com']);
    assert.equal(r.errors.length, 3);
    const many = normaliseAllowList(Array.from({ length: 25 }, (_, i) => `h${i}.example.org`));
    assert.equal(many.hosts.length, 20);
    assert.match(many.errors[0], /At most 20/);
});
