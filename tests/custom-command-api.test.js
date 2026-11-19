import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
    parse, validateTemplate, renderTemplate, runApiCall, cleanApiText, pickJson, allowedMentionsFor,
    mentionTokensUsed, createApiLimiter, normaliseArgs, touserOf, TEMPLATE_VARIABLES, MAX_API_CALLS,
    API_ERROR_TEXT, API_BUSY_TEXT, API_BLOCKED_TEXT,
} from '../core/custom-command-vars.js';
import { safeFetch, checkUrl, resolvePublic, isBlockedAddress, SafeFetchError, USER_AGENT } from '../utils/safe-fetch.js';

/*
 * Custom-command templates (core/custom-command-vars.js) and the SSRF guard behind {api:} tokens
 * (utils/safe-fetch.js). No network: the resolver and transport are injected.
 */

const VALUES = {
    'user.name': 'kestrel', 'user.mention': '<@111111111111111111>', 'user.id': '111111111111111111', 'user.tag': 'kestrel',
    sender: 'Death', 'sender.mention': '<@222222222222222222>', touser: 'Kes', 'channel.name': 'general',
    'channel.mention': '<#333333333333333333>', 'channel.id': '333333333333333333', 'server.name': 'Northwind', 'server.id': '444444444444444444',
};
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };
const fakeApi = (texts, extra = {}) => {
    const seen = [];
    return {
        seen,
        deps: { limiter: createApiLimiter(), fetcher: async (url) => { seen.push(url); return { text: typeof texts === 'function' ? texts(url) : texts }; }, ...extra },
    };
};
const render = async (tpl, args = [], api = fakeApi('OK')) =>
    (await renderTemplate(tpl, { values: VALUES, args, rng: seq(0) }, { guildId: 'g', commandKey: 'c', deps: api.deps })).text;

test('plain variables, arguments and {query}', async () => {
    assert.equal(await render('{user.name} {user.mention} {sender} {touser} {server.name} {channel.mention}'),
        'kestrel <@111111111111111111> Death Kes Northwind <#333333333333333333>');
    assert.equal(await render('[{args}] [{arg1}] [{arg2}] [{arg9}] [{query}]', ['big hug', 'a&b']), '[big hug a&b] [big hug] [a&b] [] [big%20hug%20a%26b]');
    assert.equal(await render('{random:5-5} {choice:only}'), '5 only');
    assert.equal(await render('{urlencode:{sender} & co}'), 'Death%20%26%20co');
    assert.equal(await render('{USER.NAME}'), 'kestrel', 'case-insensitive names');
});

test('unknown tokens and stray braces stay literal', async () => {
    assert.equal(await render('{lol} {"json": 1} { not } {count} a :( b'), '{lol} {"json": 1} { not } {count} a :( b');
    assert.equal(await render('{choice:yes|no :(}'), 'yes', 'an unbalanced ( inside a choice does not swallow the split');
});

test('argument values are never re-parsed as tokens', async () => {
    const api = fakeApi('X');
    assert.equal(await render('{args}', ['{api:http://169.254.169.254/}', '{user.id}'], api), '{api:http://169.254.169.254/} {user.id}');
    assert.equal(api.seen.length, 0);
});

test('{api:} fetches with arguments URL-encoded inside the URL', async () => {
    const api = fakeApi((u) => `got ${u}`);
    const out = await render('Weather: {api:https://wttr.in/{query}?format=3&who={sender}&w={arg2}}', ['New York', 'x/../y?z'], api);
    assert.equal(api.seen[0], 'https://wttr.in/New%20York%20x%2F..%2Fy%3Fz?format=3&who=Death&w=x%2F..%2Fy%3Fz');
    assert.equal(out, `Weather: got ${api.seen[0]}`);
});

test('{api.json:url|path} picks a field; bad JSON or a missing field is an API error', async () => {
    const body = JSON.stringify({ data: { items: [{ name: 'Alpha' }, { name: 'Beta' }] }, n: 5, ok: true, obj: { a: 1 } });
    assert.equal(await render('{api.json:https://x.dev/a|data.items[1].name}', [], fakeApi(body)), 'Beta');
    assert.equal(await render('{api.json:https://x.dev/a|data.items.0.name}', [], fakeApi(body)), 'Alpha');
    assert.equal(await render('{api.json:https://x.dev/a|obj}', [], fakeApi(body)), '{"a":1}');
    assert.equal(await render('{api.json:https://x.dev/a|nope.deeper}', [], fakeApi(body)), API_ERROR_TEXT);
    assert.equal(await render('{api.json:https://x.dev/a|n}', [], fakeApi('<html>')), API_ERROR_TEXT);
    assert.equal(pickJson({ a: [1, 2] }, 'a[1]'), '2');
    assert.equal(pickJson({ a: null }, 'a'), 'null');
    assert.equal(pickJson({}, '__proto__'), undefined, 'prototype keys are not walked');
});

test('StreamElements and Nightbot spellings work unchanged', async () => {
    // A fresh limiter per render: one command re-run within 3 s is (correctly) refused.
    const R = (u) => `R(${u})`;
    let api = fakeApi(R);
    assert.equal(await render('${customapi.https://x.dev/${queryescape ${1:}}}', ['a b', 'c'], api), 'R(https://x.dev/a%20b%20c)');
    api = fakeApi(R);
    assert.equal(await render('$(urlfetch https://x.dev/?q=$(querystring)) by $(user) to $(touser)', ['hi there'], api), 'R(https://x.dev/?q=hi%20there) by Death to Kes');
    api = fakeApi(R);
    assert.equal(await render('$(customapi https://x.dev/n) $(1) $(query)', ['one', 'two'], api), 'R(https://x.dev/n) one one two');
    assert.equal(await render('${user} ${sender} ${touser} ${1} ${2:} ${channel} ${random.3-3}', ['a', 'b', 'c'], api), 'Death Death Kes a b c general 3');
    assert.equal(await render('${count} $(eval 1)', [], api), '${count} $(eval 1)', 'unsupported aliases stay literal');
});

test('at most MAX_API_CALLS calls per reply; API tokens in choices or URLs are not run', async () => {
    const api = fakeApi('Z');
    const tpl = '{api:https://a.dev/1}{api:https://a.dev/2}{api:https://a.dev/3}{api:https://a.dev/4}';
    const out = await render(tpl, [], api);
    assert.equal(api.seen.length, MAX_API_CALLS);
    assert.equal(out, `ZZZ${API_ERROR_TEXT}`);
    const api2 = fakeApi('Z');
    await render('{choice:{api:https://a.dev/x}|b} {api:https://a.dev/{api:https://b.dev}}', [], api2);
    assert.deepEqual(api2.seen, ['https://a.dev/'], 'nested API token inside a URL is dropped, choice API never runs');
});

test('validation: unknown tokens, unsupported aliases, bad URLs, too many calls', () => {
    assert.deepEqual(validateTemplate('Hi {user.mention} {args} {api:https://x.dev} ${customapi.https://y.dev}').warnings, []);
    const w = validateTemplate('{usr.name} {count} ${count} $(eval 1) {api:ftp://x} {api.json:https://x|bad path!}').warnings;
    assert.ok(w.some(m => /Unknown variable \{usr\.name\}/.test(m)));
    assert.ok(w.some(m => /\{count\}/.test(m)));
    assert.ok(w.some(m => /Nightbot variable \$\(eval 1\)/.test(m)));
    assert.ok(w.some(m => /must start with https:\/\//.test(m)));
    assert.ok(w.some(m => /not a valid JSON field path/.test(m)));
    assert.ok(validateTemplate('{api:https://a}'.repeat(4)).warnings.some(m => /first 3 API calls/.test(m)));
    assert.deepEqual(validateTemplate('{"a": 1} :) {}').warnings, [], 'JSON-ish text is not flagged');
});

test('every documented variable parses to something other than text', () => {
    for (const v of TEMPLATE_VARIABLES) {
        const sample = v.token.replace('https://…', 'https://x.dev').replace('|field', '|a');
        const nodes = parse(sample);
        assert.ok(nodes.length === 1 && nodes[0].t !== 'text', `${v.token} parses`);
        assert.ok(v.description && v.example && v.group, `${v.token} is documented`);
    }
});

test('API text is cleaned: control and bidi characters, @everyone, length', () => {
    assert.equal(cleanApiText('a\u0000b‮c\r\nd\te'), 'abc\nd e');
    assert.equal(cleanApiText('hi @everyone and @here'), 'hi @​everyone and @​here');
    const long = cleanApiText('x'.repeat(1000));
    assert.equal(long.length, 400);
    assert.ok(long.endsWith('…'));
});

test('limiter: per-guild window, per-command gap, short cache', () => {
    let now = 1_000_000;
    const lim = createApiLimiter({ perGuild: 3, windowMs: 60_000, perCommandMs: 3_000, cacheMs: 3_000, now: () => now });
    assert.deepEqual(lim.take('g', 'a', 'u1', 1), { ok: true });
    assert.deepEqual(lim.take('g', 'a', 'u2', 1), { ok: true }, 'same invocation may make several calls');
    lim.store('g', 'a', 'u1', 'cached text');
    assert.deepEqual(lim.take('g', 'a', 'u1', 2), { cached: 'cached text' }, 'repeat within 3 s reuses the reply');
    assert.deepEqual(lim.take('g', 'a', 'u3', 2), { denied: 'command' }, 'a new run within 3 s with no cache is refused');
    assert.deepEqual(lim.take('g', 'b', 'u1', 3), { ok: true });
    assert.deepEqual(lim.take('g', 'c', 'u1', 4), { denied: 'guild' }, '4th call in the minute');
    assert.deepEqual(lim.take('other', 'c', 'u1', 4), { ok: true }, 'guilds are separate');
    now += 61_000;
    assert.deepEqual(lim.take('g', 'c', 'u1', 5), { ok: true }, 'window slides');
});

test('runApiCall: busy, errors and blocked text become short inserts', async () => {
    const errs = [];
    const deps = (fetcher, extra = {}) => ({ limiter: createApiLimiter(), fetcher, onError: (c) => errs.push(c), ...extra });
    const ctx = { guildId: 'g', commandKey: 'c', invocation: 1 };
    assert.equal((await runApiCall({ url: 'u' }, ctx, deps(async () => { throw new SafeFetchError('blocked_address'); }))).text, API_ERROR_TEXT);
    assert.equal((await runApiCall({ url: 'u' }, ctx, deps(async () => ({ text: 'bad words' }), { isBlockedText: (t) => /bad/.test(t) }))).text, API_BLOCKED_TEXT);
    const lim = createApiLimiter({ perGuild: 0 });
    assert.equal((await runApiCall({ url: 'u' }, ctx, { limiter: lim, fetcher: async () => ({ text: 'x' }), onError: (c) => errs.push(c) })).text, API_BUSY_TEXT);
    assert.deepEqual(errs, ['blocked_address', 'blocked_text', 'rate_guild']);
});

test('mentions: only our own tokens and what the admin typed may ping', () => {
    const tpl = 'Hey {user.mention}, {args} <@555555555555555555> <@&666666666666666666>';
    const used = mentionTokensUsed(tpl);
    assert.deepEqual([...used], ['user.mention']);
    const am = allowedMentionsFor(tpl, ['111111111111111111', null]);
    assert.deepEqual(am.parse, []);
    assert.deepEqual(am.users.sort(), ['111111111111111111', '555555555555555555']);
    assert.deepEqual(am.roles, ['666666666666666666']);
    assert.equal(am.repliedUser, false);
    assert.deepEqual(allowedMentionsFor('{args}', []).parse, [], 'an argument saying @everyone pings nobody');
    assert.deepEqual(allowedMentionsFor('@everyone {args}', []).parse, ['everyone'], 'unless the admin wrote it');
});

test('argument helpers', () => {
    assert.deepEqual(normaliseArgs(['<@111111111111111111>', 'pizza', ''], (id) => (id === '111111111111111111' ? 'Kestrel' : null)), ['@Kestrel', 'pizza']);
    assert.equal(touserOf({ mentionedName: 'Kes', args: ['x'], senderName: 'D' }), 'Kes');
    assert.equal(touserOf({ args: ['@@bob'], senderName: 'D' }), 'bob');
    assert.equal(touserOf({ args: [], senderName: 'D' }), 'D');
});

// ── SSRF guard ──────────────────────────────────────────────────────────────

test('blocked addresses: private, loopback, link-local, CGNAT, metadata, IPv6 local and IPv4-in-IPv6', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255',
        '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
        '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
        '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:c0a8:0101::1', '[::1]', 'not-an-ip']) {
        assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2002:0808:0808::1']) {
        assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
    }
});

test('URL shape: scheme, port, credentials, local names, IP literals', () => {
    const code = (u) => { try { checkUrl(u); return 'ok'; } catch (e) { return e.code; } };
    assert.equal(code('https://example.com/x?y=1'), 'ok');
    assert.equal(code('http://example.com:80/'), 'ok');
    assert.equal(code('https://example.com:443/'), 'ok');
    assert.equal(code('ftp://example.com/'), 'protocol');
    assert.equal(code('file:///etc/passwd'), 'protocol');
    assert.equal(code('gopher://example.com/'), 'protocol');
    assert.equal(code('https://example.com:8443/'), 'port');
    assert.equal(code('http://example.com:22/'), 'port');
    assert.equal(code('https://user:pw@example.com/'), 'credentials');
    assert.equal(code('http://localhost/'), 'blocked_host');
    assert.equal(code('http://printer.local/'), 'blocked_host');
    assert.equal(code('http://metadata.google.internal/'), 'blocked_host');
    assert.equal(code('http://169.254.169.254/latest/meta-data/'), 'blocked_address');
    assert.equal(code('http://2130706433/'), 'blocked_address', 'decimal IPv4 is normalised by the URL parser first');
    assert.equal(code('http://0x7f.1/'), 'blocked_address');
    assert.equal(code('http://[::ffff:127.0.0.1]/'), 'blocked_address');
    assert.equal(code('not a url'), 'bad_url');
});

test('DNS: every resolved address must be public', async () => {
    const r = (list) => async () => list;
    assert.deepEqual(await resolvePublic('ok.dev', r([{ address: '93.184.216.34', family: 4 }])), { address: '93.184.216.34', family: 4 });
    await assert.rejects(resolvePublic('evil.dev', r([{ address: '10.0.0.5', family: 4 }])), { code: 'blocked_address' });
    await assert.rejects(resolvePublic('mixed.dev', r([{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }])), { code: 'blocked_address' });
    await assert.rejects(resolvePublic('none.dev', r([])), { code: 'dns' });
    await assert.rejects(resolvePublic('fail.dev', async () => { throw new Error('ENOTFOUND'); }), { code: 'dns' });
});

/** A transport that answers from a table keyed by URL, recording what it was asked to connect to. */
function fakeTransport(table, log = []) {
    return async ({ url, address, headers }) => {
        log.push({ url: url.href, address, headers });
        const r = table[url.href];
        if (!r) return { status: 404, headers: {}, body: Readable.from([]) };
        return { status: r.status || 200, headers: r.headers || {}, body: Readable.from(r.chunks || [Buffer.from(r.body || '')]) };
    };
}
const publicDns = async (host) => [{ address: host === 'inside.dev' ? '192.168.0.10' : '93.184.216.34', family: 4 }];

test('fetch: connects to the checked address and sends no credentials', async () => {
    const log = [];
    const res = await safeFetch('https://api.dev/joke', { resolver: publicDns, transport: fakeTransport({ 'https://api.dev/joke': { body: 'ha' } }, log) });
    assert.equal(res.text, 'ha');
    assert.equal(log[0].address, '93.184.216.34');
    assert.equal(log[0].headers['User-Agent'], USER_AGENT);
    assert.ok(!('Cookie' in log[0].headers) && !('Authorization' in log[0].headers));
});

test('fetch: every redirect is re-checked, at most 3', async () => {
    const t = {
        'https://a.dev/': { status: 302, headers: { location: 'https://b.dev/' } },
        'https://b.dev/': { status: 301, headers: { location: '/c' } },
        'https://b.dev/c': { body: 'done' },
        'https://to-meta.dev/': { status: 302, headers: { location: 'http://169.254.169.254/latest' } },
        'https://to-inside.dev/': { status: 307, headers: { location: 'https://inside.dev/' } },
        'https://to-ftp.dev/': { status: 302, headers: { location: 'ftp://x.dev/' } },
        'https://loop.dev/': { status: 302, headers: { location: 'https://loop.dev/' } },
    };
    assert.equal((await safeFetch('https://a.dev/', { resolver: publicDns, transport: fakeTransport(t) })).text, 'done');
    await assert.rejects(safeFetch('https://to-meta.dev/', { resolver: publicDns, transport: fakeTransport(t) }), { code: 'blocked_address' });
    await assert.rejects(safeFetch('https://to-inside.dev/', { resolver: publicDns, transport: fakeTransport(t) }), { code: 'blocked_address' });
    await assert.rejects(safeFetch('https://to-ftp.dev/', { resolver: publicDns, transport: fakeTransport(t) }), { code: 'protocol' });
    const log = [];
    await assert.rejects(safeFetch('https://loop.dev/', { resolver: publicDns, transport: fakeTransport(t, log) }), { code: 'too_many_redirects' });
    assert.equal(log.length, 4, 'the first request plus 3 redirects');
});

test('fetch: size cap, HTTP errors and the timeout', async () => {
    const big = { 'https://big.dev/': { chunks: [Buffer.alloc(40_000, 97), Buffer.alloc(40_000, 98)] } };
    const res = await safeFetch('https://big.dev/', { resolver: publicDns, transport: fakeTransport(big) });
    assert.equal(res.text.length, 64 * 1024);
    assert.equal(res.truncated, true);
    await assert.rejects(safeFetch('https://nothing.dev/', { resolver: publicDns, transport: fakeTransport({}) }), { code: 'http_status' });
    const hang = () => new Promise(() => {});
    await assert.rejects(safeFetch('https://slow.dev/', { resolver: publicDns, transport: hang, timeoutMs: 50 }), { code: 'timeout' });
    await assert.rejects(safeFetch('https://slow.dev/', { resolver: hang, transport: hang, timeoutMs: 50 }), { code: 'timeout' }, 'a hanging DNS lookup times out too');
});
