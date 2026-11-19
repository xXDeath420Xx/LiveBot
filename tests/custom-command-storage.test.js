import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parse, validateTemplate, renderTemplate, runDbOp, allowedMentionsFor, mentionTokensUsed, createApiLimiter, TEMPLATE_VARIABLES,
    MAX_DB_OPS, DB_VALUE_MAX, DB_USER_KEYS, DB_SERVER_KEYS, DB_SERVER_USER, DB_FULL_TEXT, DB_TOO_LONG_TEXT, DB_ERROR_TEXT,
} from '../core/custom-command-vars.js';
import { createMemoryStore, createPreviewStore, storedNumber, NUMBER_MAX } from '../core/custom-command-store.js';
import { DELETE_PLAN, USER_ID_COLUMNS, classifyTable } from '../core/privacy-tables.js';

/*
 * Custom-command storage tokens ({db:…} / {sdb:…}, register H-648): parsing, validation, rendering
 * against an in-memory store with the SQL store's semantics, the limits and mention safety.
 * The SQL store itself is tested against the live table in custom-command-storage-db.test.js.
 */

const G = 'guild-1';
const U = 'user-1';
const VALUES = { sender: 'Death', 'sender.mention': '<@222222222222222222>', 'user.name': 'kestrel' };
const run = async (tpl, { store = createMemoryStore(), args = [], userId = U, api = null } = {}) => {
    const r = await renderTemplate(tpl, { values: VALUES, args, rng: () => 0 }, api, { store, guildId: G, userId });
    return { ...r, store };
};
const warningsOf = (tpl) => validateTemplate(tpl).warnings;

// ── Parsing and validation ──────────────────────────────────────────────────

test('storage tokens parse into db nodes, keys lower-cased', () => {
    assert.deepEqual(parse('{db:get:Cookies}'), [{ t: 'db', scope: 'user', op: 'get', key: 'cookies' }]);
    assert.deepEqual(parse('{sdb:del:a.b-c_1}'), [{ t: 'db', scope: 'server', op: 'del', key: 'a.b-c_1' }]);
    assert.deepEqual(parse('{db:incr:cookies}'), [{ t: 'db', scope: 'user', op: 'incr', key: 'cookies', by: 1 }]);
    assert.deepEqual(parse('{DB:INCR:cookies:-5}'), [{ t: 'db', scope: 'user', op: 'incr', key: 'cookies', by: -5 }]);
    const [set] = parse('{db:set:quote:{args} at 12:30}');
    assert.equal(set.op, 'set');
    assert.equal(set.key, 'quote');
    assert.deepEqual(set.value, [{ t: 'var', name: 'args' }, { t: 'text', v: ' at 12:30' }]);
});

test('the doubled-brace spelling {{db:…}} means the same', () => {
    assert.deepEqual(parse('{{db:incr:cookies}}'), parse('{db:incr:cookies}'));
    assert.deepEqual(parse('{{sdb:get:x}}'), parse('{sdb:get:x}'));
    assert.deepEqual(validateTemplate('{sender} has {{db:incr:cookies}} cookies').warnings, []);
});

test('valid templates have no warnings and count their storage operations', () => {
    const tpl = '{sender} has {db:incr:cookies} cookies {db:set:last:{args}} {sdb:get:motd} {db:del:old} {db:incr:x:1000} {db:incr:y:-1000}';
    const v = validateTemplate(tpl);
    assert.deepEqual(v.warnings, []);
    assert.equal(v.storageOps, 6);
});

test('validation catches bad keys, ops, amounts, values and placement', () => {
    assert.match(warningsOf('{db:get:}').join(), /Storage key "" .* must be 1–64 characters/);
    assert.match(warningsOf('{db:get:has space}').join(), /must be 1–64 characters/);
    assert.match(warningsOf(`{db:get:${'k'.repeat(65)}}`).join(), /must be 1–64 characters/);
    assert.deepEqual(warningsOf(`{db:get:${'k'.repeat(64)}}`), []);
    assert.match(warningsOf('{db:get:a:b}').join(), /must be 1–64/);
    assert.match(warningsOf('{db:get:{args}}').join(), /must be 1–64/, 'keys are fixed text');
    assert.match(warningsOf('{db:fetch:x}').join(), /Unknown storage operation/);
    assert.match(warningsOf('{db:set:x}').join(), /needs a value/);
    assert.match(warningsOf('{db:incr:x:1001}').join(), /-1000 to 1000/);
    assert.match(warningsOf('{db:incr:x:-1001}').join(), /-1000 to 1000/);
    assert.match(warningsOf('{db:incr:x:1.5}').join(), /whole number/);
    assert.match(warningsOf('{db:incr:x:abc}').join(), /whole number/);
    assert.match(warningsOf(`{db:set:x:${'v'.repeat(DB_VALUE_MAX + 1)}}`).join(), /at most 1000 characters/);
    assert.deepEqual(warningsOf(`{db:set:x:${'v'.repeat(DB_VALUE_MAX)}}`), []);
    assert.match(warningsOf('{choice:{db:incr:x}|b}').join(), /inside \{choice:\} or an API URL are not run/);
    assert.match(warningsOf('{api:https://x.dev/{db:get:x}}').join(), /not run/);
    assert.match(warningsOf('{db:set:a:{db:get:b}}').join(), /inside a \{db:set:\} value are not run/);
    const many = Array.from({ length: MAX_DB_OPS + 2 }, (_, i) => `{db:get:k${i}}`).join(' ');
    assert.match(warningsOf(many).join(), /Only the first 10 storage operations/);
    assert.equal(validateTemplate(many).storageOps, MAX_DB_OPS);
});

test('the editor reference lists every storage token with an example', () => {
    const storage = TEMPLATE_VARIABLES.filter(v => v.group === 'Storage');
    for (const t of ['{db:get:key}', '{db:set:key:value}', '{db:incr:key}', '{db:del:key}', '{sdb:incr:key}']) {
        const v = storage.find(s => s.token === t);
        assert.ok(v, t);
        assert.ok(v.description && v.example, `${t} has a description and an example`);
        assert.deepEqual(validateTemplate(v.example.replace(/^!cookie → /, '')).warnings, [], `${t} example is valid`);
    }
});

// ── Rendering ───────────────────────────────────────────────────────────────

test('!cookie: incr counts per member and shows the new total', async () => {
    const store = createMemoryStore();
    const tpl = '{sender} has {db:incr:cookies} cookies';
    assert.equal((await run(tpl, { store })).text, 'Death has 1 cookies');
    assert.equal((await run(tpl, { store })).text, 'Death has 2 cookies');
    assert.equal((await run('{db:incr:cookies:10} then {db:incr:cookies:-3}', { store })).text, '12 then 9');
    assert.equal((await run(tpl, { store, userId: 'user-2' })).text, 'Death has 1 cookies', 'another member has their own');
    assert.equal(await store.get(G, U, 'cookies'), '9');
});

test('set stores rendered text and shows nothing; get reads it back; del removes it', async () => {
    const store = createMemoryStore();
    const r = await run('{db:set:quote:{args}}Saved, {sender}.', { store, args: ['to', 'be'] });
    assert.equal(r.text, 'Saved, Death.');
    assert.deepEqual(r.storage, [{ op: 'set', scope: 'user', key: 'quote', ok: true }]);
    assert.equal((await run('Quote: {db:get:QUOTE}', { store })).text, 'Quote: to be');
    assert.equal((await run('[{db:get:missing}]', { store })).text, '[]', 'missing key is empty');
    assert.equal((await run('{db:del:quote}[{db:get:quote}]', { store })).text, '[]', 'ops run in template order');
});

test('ops run in template order, before the reply is built', async () => {
    const store = createMemoryStore();
    assert.equal((await run('{db:get:n}|{db:set:n:5}|{db:get:n}|{db:incr:n}|{db:get:n}', { store })).text, '||5|6|6');
});

test('sdb: is one value for the whole server, stored under the sentinel owner', async () => {
    const store = createMemoryStore();
    await run('{sdb:incr:deaths}', { store, userId: 'a' });
    const r = await run('{sdb:incr:deaths} deaths, mine {db:get:deaths}', { store, userId: 'b' });
    assert.equal(r.text, '2 deaths, mine ');
    assert.equal(await store.get(G, DB_SERVER_USER, 'deaths'), '2');
    assert.equal(await store.get(G, 'a', 'deaths'), null);
});

test('incr on a value that is not a number counts it as 0', async () => {
    const store = createMemoryStore();
    await run('{db:set:n:hello}', { store });
    assert.equal((await run('{db:incr:n}', { store })).text, '1');
    await run('{db:set:n: 41 }', { store });
    assert.equal((await run('{db:incr:n}', { store })).text, '42', 'surrounding spaces are trimmed on save');
    await run('{db:set:n:2.5}', { store });
    assert.equal((await run('{db:incr:n:3}', { store })).text, '3');
    assert.equal(storedNumber('-7'), -7);
    assert.equal(storedNumber('1234567890123456'), 0, 'more than 15 digits is not a number');
    await store.set(G, U, 'big', String(NUMBER_MAX), 100);
    assert.equal((await run('{db:incr:big:1000}', { store })).text, String(NUMBER_MAX), 'clamped');
});

test('set values may hold other tokens, encoded inside {urlencode:} like any variable', async () => {
    const store = createMemoryStore();
    await run('{db:set:who:{sender} & {user.name}}', { store });
    assert.equal((await run('{db:get:who}|{urlencode:{db:get:who}}', { store })).text, 'Death & kestrel|Death%20%26%20kestrel');
});

test('a set value can hold an API reply (API calls run first)', async () => {
    const store = createMemoryStore();
    const api = { guildId: G, commandKey: 'c', deps: { limiter: createApiLimiter(), fetcher: async () => ({ text: 'joke!' }) } };
    const r = await run('{db:set:last:{api:https://x.dev/}}saved {db:get:last}', { store, api });
    assert.equal(r.text, 'saved joke!');
});

test('a member typing a token as an argument stores the text, it is never re-parsed', async () => {
    const store = createMemoryStore();
    await run('{db:set:q:{args}}', { store, args: ['{db:del:cookies}', '{sdb:incr:x}'] });
    assert.equal((await run('{db:get:q}', { store })).text, '{db:del:cookies} {sdb:incr:x}');
    assert.equal(await store.get(G, DB_SERVER_USER, 'x'), null);
});

test('without a store, storage tokens render empty', async () => {
    const r = await renderTemplate('a{db:incr:x}b{db:get:x}c', { values: {}, args: [] });
    assert.equal(r.text, 'abc');
    assert.ok(r.storage.every(o => o.error === 'disabled'));
});

// ── Limits ──────────────────────────────────────────────────────────────────

test('at most 10 storage operations run per reply', async () => {
    const store = createMemoryStore();
    const tpl = Array.from({ length: 12 }, () => '{db:incr:n}').join(',');
    const r = await run(tpl, { store });
    assert.equal(r.text, '1,2,3,4,5,6,7,8,9,10,,');
    assert.equal(r.storage.length, MAX_DB_OPS);
    assert.equal(await store.get(G, U, 'n'), '10');
});

test('a value over 1,000 characters is refused softly', async () => {
    const store = createMemoryStore();
    const r = await run('{db:set:long:{args}}', { store, args: ['x'.repeat(DB_VALUE_MAX + 1)] });
    assert.equal(r.text, DB_TOO_LONG_TEXT);
    assert.equal(await store.get(G, U, 'long'), null);
    assert.equal((await run('{db:set:ok:{args}}', { store, args: ['x'.repeat(DB_VALUE_MAX)] })).text, '');
    assert.equal((await store.get(G, U, 'ok')).length, DB_VALUE_MAX);
});

test('100 keys per member, 1,000 per server: a new key past the limit fails softly, existing keys still update', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < DB_USER_KEYS; i++) await store.set(G, U, `k${i}`, 'v', DB_USER_KEYS);
    assert.equal((await run('{db:set:new:v}', { store })).text, DB_FULL_TEXT);
    assert.equal((await run('{db:incr:new2}', { store })).text, DB_FULL_TEXT);
    assert.equal((await run('{db:set:k5:changed}{db:get:k5}', { store })).text, 'changed');
    assert.equal((await run('{db:set:new:v}', { store, userId: 'other' })).text, '', 'the limit is per member');
    for (let i = 0; i < DB_SERVER_KEYS; i++) await store.set(G, DB_SERVER_USER, `s${i}`, 'v', DB_SERVER_KEYS);
    assert.equal((await run('{sdb:set:one-more:v}', { store })).text, DB_FULL_TEXT);
    assert.equal((await run('{sdb:incr:s1}', { store })).text, '1');
});

test('a store error shows a short marker and is reported, the rest of the reply still renders', async () => {
    const broken = { get: async () => { throw new Error('db down'); } };
    const seen = [];
    const r = await renderTemplate('a {db:get:x} b', { values: {}, args: [] }, null,
        { store: broken, guildId: G, userId: U, onError: (err, node) => seen.push(`${node.op}:${err.message}`) });
    assert.equal(r.text, `a ${DB_ERROR_TEXT} b`);
    assert.deepEqual(seen, ['get:db down']);
});

test('runDbOp needs a guild and an owner', async () => {
    const [node] = parse('{db:get:x}');
    assert.equal((await runDbOp(node, {}, { store: createMemoryStore(), guildId: G, userId: null })).error, 'disabled');
    const [snode] = parse('{sdb:get:x}');
    assert.equal((await runDbOp(snode, {}, { store: createMemoryStore(), guildId: G, userId: null })).ok, true, 'server scope needs no member');
});

// ── Mention safety ──────────────────────────────────────────────────────────

test('a stored value cannot ping @everyone, @here, roles or other members', async () => {
    const store = createMemoryStore();
    const evil = '@everyone @here <@&555555555555555555> <@666666666666666666>';
    await run('{db:set:x:{args}}', { store, args: evil.split(' ') });
    assert.equal(await store.get(G, U, 'x'), evil, 'stored as typed (export shows the real value)');
    const tpl = 'Saved: {db:get:x}';
    const r = await run(tpl, { store });
    assert.doesNotMatch(r.text, /@everyone|@here/, '@everyone/@here are defused in the output');
    assert.match(r.text, /@​everyone/);
    const am = allowedMentionsFor(tpl, [...mentionTokensUsed(tpl)].map(() => null));
    assert.deepEqual(am, { parse: [], users: [], roles: [], repliedUser: false }, 'nothing in the stored text may ping');
});

test('server-wide values are defused too, and control characters are stripped', async () => {
    const store = createMemoryStore();
    await store.set(G, DB_SERVER_USER, 'motd', 'hi\u0000 @here‮', DB_SERVER_KEYS);
    assert.equal((await run('{sdb:get:motd}', { store })).text, 'hi @​here');
});

// ── Privacy wiring ──────────────────────────────────────────────────────────

test('/privacy delete covers the member\'s storage rows; export finds them by user_id', () => {
    const step = DELETE_PLAN.find(p => p.table === 'custom_commands_kv');
    assert.ok(step, 'custom_commands_kv is in DELETE_PLAN');
    assert.equal(step.column, 'user_id');
    assert.equal(step.where, undefined);
    assert.ok(USER_ID_COLUMNS.includes('user_id'));
    assert.equal(classifyTable('custom_commands_kv'), 'export');
    assert.doesNotMatch(DB_SERVER_USER, /^\d{17,20}$/, 'the server sentinel can never be a member id');
});

// ── Dashboard Test (preview store) ──────────────────────────────────────────

test('the preview store reads real values but never writes them', async () => {
    const base = createMemoryStore();
    await base.set(G, U, 'cookies', '41', DB_USER_KEYS);
    const preview = createPreviewStore(base);
    const r = await run('{db:incr:cookies} {db:set:q:hi}{db:get:q} {db:del:cookies}[{db:get:cookies}]', { store: preview });
    assert.equal(r.text, '42 hi []');
    assert.equal(await base.get(G, U, 'cookies'), '41');
    assert.equal(await base.get(G, U, 'q'), null);
});
