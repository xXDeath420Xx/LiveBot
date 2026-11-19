/*
 * Custom-command response templates: the variables, the parser, API calls and the limits on them.
 * Pure apart from the shared rate limiter instance; the Discord side lives in
 * core/custom-command-handler.js and the network side in utils/safe-fetch.js.
 * Unit-tested in tests/custom-command-api.test.js.
 *
 * Syntax (our own, shown on the dashboard):
 *   {user.name} {user.mention} {user.id} {user.tag}   mentioned person, else whoever ran it
 *   {sender} {sender.mention}                         always whoever ran it
 *   {touser}                                          first mention, else the first word typed, else the sender
 *   {args} {arg1}..{arg9} {query}                     what was typed after the command; {query} is URL-encoded
 *   {channel.*} {server.*} {random:1-100} {choice:a|b|c} {urlencode:text}
 *   {api:https://…}  {api.json:https://…|path.to.field}
 *   {evilinsult} {evilinsult:de}                      an Evil Insult line (core/evil-insults.js), served locally
 *
 * Commands pasted from StreamElements and Nightbot work unchanged, because their spellings are read
 * as aliases of the above:
 *   ${customapi.URL} ${user} ${sender} ${touser} ${1} ${1:} ${channel} ${queryescape …} ${random.1-10}
 *   $(customapi URL) $(urlfetch URL) $(user) $(touser) $(query) $(querystring) $(1) $(channel)
 *
 * Inside an API URL every argument value is URL-encoded, so `{api:https://x.dev/?q={args}}` cannot be
 * bent into a different URL by what a member types. Values are never re-parsed: a member typing
 * "{api:…}" as an argument gets that text back, not a fetch.
 *
 * Rendering is two passes: parse → collect API nodes → fetch them (at most MAX_API_CALLS, in order)
 * → evaluate synchronously with the results. API tokens inside {choice:} are not supported.
 *
 * Local answers: deps.localAnswer(url) may answer a URL without the network (evilinsult.com's
 * generate_insult.php, whose real API blocks servers, is answered from core/evil-insults.js). A local
 * answer skips the rate limiter and its cache (every call is a fresh line) but is cleaned and
 * content-checked like any reply. {evilinsult} is an API node on that URL marked `local`, so it does
 * not use up one of the MAX_API_CALLS network calls (at most MAX_LOCAL_CALLS of them per reply).
 *
 * Storage (register H-648; YAGPDB's dbGet/dbSet), backed by custom_commands_kv through a store object
 * (core/custom-command-store.js):
 *   {db:get:key} {db:set:key:value} {db:incr:key} {db:incr:key:n} {db:del:key}   whoever ran the command
 *   {sdb:get:key} …                                                               the whole server
 *   {{db:…}} / {{sdb:…}} (the doubled braces of migration 352's header) are read the same way.
 * Keys are fixed text, 1–64 of [a-z0-9_.-] (stored lower case). A set value may hold other tokens
 * (not storage tokens), evaluated when the op runs. Storage nodes run after the API calls and before
 * the final evaluation, in template order, at most MAX_DB_OPS per reply. Values read back are cleaned
 * like API text (no @everyone/@here, no control characters), and allowedMentionsFor only looks at the
 * template, so a stored value can never ping anyone the template itself would not.
 */
import { LANGUAGES as EVIL_INSULT_LANGUAGES, isKnownLanguage } from './evil-insults.js';

/** Storage limits ({db:…} / {sdb:…}). */
export const MAX_DB_OPS = 10;
export const DB_KEY_MAX = 64;
export const DB_VALUE_MAX = 1000;
export const DB_INCR_MAX = 1000;
export const DB_USER_KEYS = 100;
export const DB_SERVER_KEYS = 1000;
/** user_id of the server-wide ({sdb:…}) rows; never a Discord id, so /privacy never matches it. */
export const DB_SERVER_USER = 'server';
export const DB_FULL_TEXT = '(storage full)';
export const DB_TOO_LONG_TEXT = '(value too long)';
export const DB_ERROR_TEXT = '(storage error)';
const DB_KEY = /^[a-z0-9_.-]{1,64}$/;

export const MAX_API_CALLS = 3;
export const MAX_LOCAL_CALLS = 5;
export const EVIL_INSULT_API = 'https://evilinsult.com/generate_insult.php';
export const API_OUTPUT_MAX = 400;
export const MESSAGE_MAX = 2000;
export const API_ERROR_TEXT = '(API error)';
export const API_BUSY_TEXT = '(API busy, try again in a moment)';
export const API_BLOCKED_TEXT = '(API response blocked)';
export const RATE_LIMITS = Object.freeze({ perGuild: 20, windowMs: 60_000, perCommandMs: 3_000, cacheMs: 3_000 });

const EVERYTHING = '…';

/** Every variable, grouped for the dashboard reference panel. `insert` is what a click puts in the box. */
export const TEMPLATE_VARIABLES = Object.freeze([
    { group: 'Who ran it', token: '{user.name}', description: 'Username of the person mentioned, or of whoever ran the command', example: 'deathdealer' },
    { group: 'Who ran it', token: '{user.mention}', description: 'Pings that same person', example: '@deathdealer' },
    { group: 'Who ran it', token: '{user.id}', description: "That person's user ID", example: '311298654338383873' },
    { group: 'Who ran it', token: '{user.tag}', description: 'Their tag (username, or username#0000 for old accounts)', example: 'deathdealer' },
    { group: 'Who ran it', token: '{sender}', description: 'Display name of whoever ran the command, even when someone is mentioned', example: 'Death' },
    { group: 'Who ran it', token: '{sender.mention}', description: 'Pings whoever ran the command', example: '@Death' },
    { group: 'Who ran it', token: '{touser}', description: 'First person mentioned, else the first word typed after the command, else whoever ran it', example: '!hug @Kestrel → Kestrel' },
    { group: 'What they typed', token: '{args}', description: 'Everything typed after the command name', example: '!say hello there → hello there' },
    { group: 'What they typed', token: '{arg1}', description: 'One word: {arg1} is the first, up to {arg9}', example: '!rate pizza → pizza' },
    { group: 'What they typed', token: '{query}', description: 'Everything typed, URL-encoded, for use inside links and API URLs', example: 'hello there → hello%20there' },
    { group: 'What they typed', token: '{urlencode:text}', insert: '{urlencode:}', description: 'URL-encodes any text, including other variables', example: '{urlencode:{sender}}' },
    { group: 'Channel and server', token: '{channel.name}', description: 'Current channel name', example: 'general' },
    { group: 'Channel and server', token: '{channel.mention}', description: 'Links the current channel', example: '#general' },
    { group: 'Channel and server', token: '{channel.id}', description: 'Current channel ID', example: '1121971570763759001' },
    { group: 'Channel and server', token: '{server.name}', description: "This server's name", example: 'Northwind Gaming' },
    { group: 'Channel and server', token: '{server.id}', description: "This server's ID", example: '1121971570763759999' },
    { group: 'Random', token: '{random:1-100}', description: 'A random whole number in that range', example: '42' },
    { group: 'Random', token: '{choice:a|b|c}', insert: '{choice:|}', description: 'Picks one of the options at random', example: '{choice:heads|tails} → tails' },
    { group: 'API calls', token: '{api:https://…}', insert: '{api:https://}', description: 'Fetches the URL and inserts the reply text (max 400 characters)', example: '{api:https://icanhazdadjoke.com/}' },
    { group: 'API calls', token: '{api.json:https://…|field}', insert: '{api.json:https://|}', description: 'Fetches JSON and inserts one field; use dots and [0] for nested fields', example: '{api.json:https://api.kanye.rest|quote}' },
    { group: 'Insults', token: '{evilinsult}', description: "A random crude insult from Evil Insult's open database (English), filtered like /insult. Includes sexual jokes", example: '{touser}, {evilinsult}' },
    { group: 'Insults', token: '{evilinsult:de}', insert: '{evilinsult:}', description: `The same in another language: ${EVIL_INSULT_LANGUAGES.slice(1, 9).map(l => l.code).join(', ')} and more`, example: '{evilinsult:es}' },
    { group: 'Storage', token: '{db:get:key}', insert: '{db:get:}', description: 'The value saved under that key for whoever ran the command; empty if none', example: 'Your quote: {db:get:quote}' },
    { group: 'Storage', token: '{db:set:key:value}', insert: '{db:set::}', description: 'Saves a value for whoever ran the command and shows nothing. The value can use other variables', example: '{db:set:quote:{args}}Saved!' },
    { group: 'Storage', token: '{db:incr:key}', insert: '{db:incr:}', description: 'Adds 1 to a saved number and shows the new total. {db:incr:key:5} adds 5 (any whole number from -1000 to 1000)', example: '!cookie → {sender} has {db:incr:cookies} cookies' },
    { group: 'Storage', token: '{db:del:key}', insert: '{db:del:}', description: 'Deletes a saved value and shows nothing', example: '{db:del:quote}Quote cleared.' },
    { group: 'Storage', token: '{sdb:incr:key}', insert: '{sdb:incr:}', description: 'Server-wide storage: every db: token also works as sdb: ({sdb:get:key}, {sdb:set:key:value}, …), with one value shared by the whole server', example: '{sdb:incr:deaths} deaths so far' },
]);

/** StreamElements / Nightbot spellings, for the "API calls" help and validation. */
export const ALIAS_VARIABLES = Object.freeze([
    { token: '${customapi.https://…}', from: 'StreamElements', same: '{api:https://…}' },
    { token: '$(customapi https://…)', from: 'Nightbot', same: '{api:https://…}' },
    { token: '$(urlfetch https://…)', from: 'Nightbot', same: '{api:https://…}' },
    { token: '${user} / $(user)', from: 'Both', same: '{sender}' },
    { token: '${touser} / $(touser)', from: 'Both', same: '{touser}' },
    { token: '${1} / $(1)', from: 'Both', same: '{arg1}' },
    { token: '${1:} / $(query)', from: 'Both', same: '{args}' },
    { token: '${queryescape ${1:}} / $(querystring)', from: 'Both', same: '{query}' },
]);

const SIMPLE_VARS = new Set([
    'user.name', 'user.mention', 'user.id', 'user.tag', 'sender', 'sender.mention', 'touser',
    'channel.name', 'channel.mention', 'channel.id', 'server.name', 'server.id', 'args', 'query',
]);
const UNSUPPORTED = new Map([
    ['count', '{count} (a use counter) is not available yet'],
]);
const TOKENISH = /^[a-z][a-z0-9_.]*(?::[\s\S]*)?$/i;
const JSON_PATH = /^[\w$.\[\]-]{0,200}$/;

/** Index of the bracket closing the one at `open`, counting nesting; -1 when unbalanced. */
function matchClose(text, open, oc, cc) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === oc) depth++;
        else if (text[i] === cc && --depth === 0) return i;
    }
    return -1;
}

/** Split on `sep` where it is not inside {…}, ${…} or $(…). */
function splitTop(text, sep) {
    const parts = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        // Skip over a balanced token so a | inside it does not split; an unbalanced ( or { (":(") is just text.
        const end = ch === '{' ? matchClose(text, i, '{', '}')
            : (ch === '$' && text[i + 1] === '(') ? matchClose(text, i + 1, '(', ')') : -1;
        if (end > 0) { i = end; continue; }
        if (ch === sep) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    parts.push(text.slice(start));
    return parts;
}

function apiNode(rawUrl, json, path, state, ctx) {
    const url = parse(rawUrl.trim(), { ...state, inUrl: true, noApi: true }, ctx);
    const lead = url.find(n => n.t === 'text');
    if (!lead || !/^https?:\/\//i.test(lead.v)) ctx.warn(`API URLs must start with https:// or http:// (${rawUrl.slice(0, 60) || 'empty'})`);
    if (state.noApi) {
        ctx.warn('API calls inside {choice:} or another API URL are not run');
        return { t: 'text', v: '' };
    }
    if (json && path != null && !JSON_PATH.test(path)) ctx.warn(`"${path}" is not a valid JSON field path`);
    return { t: 'api', url, json, path: json ? String(path || '').trim() : '' };
}

/** {evilinsult[:lang]} → a local API node on the Evil Insult URL (type=text). */
function evilInsultNode(lang, state, ctx) {
    const code = String(lang || 'en').trim().toLowerCase();
    if (lang != null && !isKnownLanguage(code)) ctx.warn(`{evilinsult:${code.slice(0, 10)}}: no insults in that language, English is used`);
    if (state.noApi) {
        ctx.warn('{evilinsult} inside {choice:} or an API URL is not run');
        return { t: 'text', v: '' };
    }
    const url = `${EVIL_INSULT_API}?lang=${encodeURIComponent(isKnownLanguage(code) ? code : 'en')}&type=text`;
    return { t: 'api', url: [{ t: 'text', v: url }], json: false, path: '', local: true };
}

/**
 * {db:op:…} / {sdb:op:…} body → a storage node { t: 'db', scope, op, key, value?, by? }.
 * Invalid ones warn and become empty text, like an empty {choice:}.
 */
function dbToken(body, state, ctx) {
    const m = body.match(/^(s?db):([a-z]*)(?::([\s\S]*))?$/i);
    const label = `{${body.length > 40 ? body.slice(0, 40) + EVERYTHING : body}}`;
    const scope = m[1].toLowerCase() === 'sdb' ? 'server' : 'user';
    const op = m[2].toLowerCase();
    const rest = m[3] ?? '';
    if (state.noApi || state.noDb) {
        ctx.warn(state.noDb
            ? `Storage tokens inside a {db:set:} value are not run (${label})`
            : `Storage tokens inside {choice:} or an API URL are not run (${label})`);
        return { t: 'text', v: '' };
    }
    if (!['get', 'set', 'incr', 'del'].includes(op)) {
        ctx.warn(`Unknown storage operation ${label}: use get, set, incr or del`);
        return { t: 'text', v: '' };
    }
    const cut = rest.indexOf(':');
    const rawKey = op === 'get' || op === 'del' || cut < 0 ? rest : rest.slice(0, cut);
    const key = rawKey.trim().toLowerCase();
    if (!DB_KEY.test(key)) {
        ctx.warn(`Storage key "${rawKey.slice(0, 70)}" in ${label} must be 1–${DB_KEY_MAX} characters: letters, numbers, _ . or -`);
        return { t: 'text', v: '' };
    }
    const node = { t: 'db', scope, op, key };
    if (op === 'set') {
        if (cut < 0) { ctx.warn(`${label} needs a value: {${m[1].toLowerCase()}:set:${key}:value}`); return { t: 'text', v: '' }; }
        const raw = rest.slice(cut + 1);
        node.value = parse(raw, { ...state, noDb: true }, ctx);
        if (node.value.every(n => n.t === 'text') && raw.trim().length > DB_VALUE_MAX) {
            ctx.warn(`${label}: a stored value can be at most ${DB_VALUE_MAX} characters`);
        }
    } else if (op === 'incr') {
        node.by = 1;
        if (cut >= 0) {
            const n = rest.slice(cut + 1).trim();
            if (!/^[+-]?\d{1,4}$/.test(n) || Math.abs(Number(n)) > DB_INCR_MAX) {
                ctx.warn(`${label}: the amount must be a whole number from -${DB_INCR_MAX} to ${DB_INCR_MAX}`);
                return { t: 'text', v: '' };
            }
            node.by = Number(n);
        }
    }
    return node;
}

/** Our own `{…}` token body → node, or null to leave it as literal text. */
function ourToken(body, state, ctx) {
    const lower = body.toLowerCase();
    if (SIMPLE_VARS.has(lower)) return { t: 'var', name: lower };
    // Callers may add plain variables of their own (the stream bot's {amount}, {event.type}, …), read from vars.values.
    if (state.extraVars && state.extraVars.has(lower)) return { t: 'var', name: lower };
    if (/^s?db:/.test(lower)) return dbToken(body, state, ctx);
    // {{db:…}}: the doubled braces of migration 352's header (and YAGPDB habits) mean the same thing.
    if (/^\{s?db:/.test(lower) && matchClose(body, 0, '{', '}') === body.length - 1) return dbToken(body.slice(1, -1), state, ctx);
    if (lower === 'evilinsult') return evilInsultNode(null, state, ctx);
    if (/^evilinsult:/.test(lower)) return evilInsultNode(body.slice(11), state, ctx);
    let m = lower.match(/^arg([1-9])$/);
    if (m) return { t: 'arg', n: Number(m[1]), rest: false };
    m = body.match(/^random:(-?\d{1,9})-(-?\d{1,9})$/i);
    if (m) return { t: 'random', lo: Number(m[1]), hi: Number(m[2]) };
    if (/^choice:/i.test(body)) {
        const opts = splitTop(body.slice(7), '|').map(s => s.trim()).filter(Boolean);
        if (!opts.length) { ctx.warn('{choice:} needs options separated by |'); return { t: 'text', v: '' }; }
        return { t: 'choice', options: opts.map(o => parse(o, { ...state, noApi: true }, ctx)) };
    }
    if (/^urlencode:/i.test(body)) return { t: 'enc', body: parse(body.slice(10), state, ctx) };
    if (/^api\.json:/i.test(body)) {
        const parts = splitTop(body.slice(9), '|');
        const path = parts.length > 1 ? parts.pop() : '';
        return apiNode(parts.join('|'), true, path, state, ctx);
    }
    if (/^api:/i.test(body)) return apiNode(body.slice(4), false, null, state, ctx);
    if (UNSUPPORTED.has(lower)) { ctx.warn(UNSUPPORTED.get(lower)); return null; }
    if (TOKENISH.test(body) && body.length <= 60) ctx.warn(`Unknown variable {${body.length > 40 ? body.slice(0, 40) + EVERYTHING : body}}`);
    return null;
}

/** StreamElements `${…}` body → node. */
function seToken(body, state, ctx) {
    const b = body.trim();
    const lower = b.toLowerCase();
    if (lower === 'user' || lower === 'sender' || lower === 'user.name' || lower === 'sender.name') return { t: 'var', name: 'sender' };
    if (lower === 'touser') return { t: 'var', name: 'touser' };
    if (lower === 'channel') return { t: 'var', name: 'channel.name' };
    let m = b.match(/^([1-9])$/);
    if (m) return { t: 'arg', n: Number(m[1]), rest: false };
    m = b.match(/^([1-9]):$/);
    if (m) return { t: 'arg', n: Number(m[1]), rest: true };
    m = b.match(/^random\.(-?\d{1,9})-(-?\d{1,9})$/i);
    if (m) return { t: 'random', lo: Number(m[1]), hi: Number(m[2]) };
    m = b.match(/^(?:queryescape|pathescape)\s+([\s\S]+)$/i);
    if (m) return { t: 'enc', body: parse(m[1], state, ctx) };
    if (/^customapi\./i.test(b)) return apiNode(b.slice(10), false, null, state, ctx);
    if (lower === 'count') { ctx.warn(UNSUPPORTED.get('count').replace('{count}', '${count}')); return null; }
    if (/^[a-z][\w.]*(?:\s[\s\S]*)?$/i.test(b) && b.length <= 60) ctx.warn(`Unsupported StreamElements variable \${${b}}`);
    return null;
}

/** Nightbot `$(…)` body → node. */
function nbToken(body, state, ctx) {
    const b = body.trim();
    const lower = b.toLowerCase();
    if (lower === 'user' || lower === 'sender') return { t: 'var', name: 'sender' };
    if (lower === 'touser') return { t: 'var', name: 'touser' };
    if (lower === 'query') return { t: 'var', name: 'args' };
    if (lower === 'querystring') return { t: 'var', name: 'query' };
    if (lower === 'channel') return { t: 'var', name: 'channel.name' };
    const m = b.match(/^([1-9])$/);
    if (m) return { t: 'arg', n: Number(m[1]), rest: false };
    const api = b.match(/^(?:urlfetch|customapi)\s+(?:json\s+)?(\S[\s\S]*)$/i);
    if (api) return apiNode(api[1], false, null, state, ctx);
    if (lower === 'count') { ctx.warn(UNSUPPORTED.get('count').replace('{count}', '$(count)')); return null; }
    if (/^[a-z][\w.]*(?:\s[\s\S]*)?$/i.test(b) && b.length <= 60) ctx.warn(`Unsupported Nightbot variable $(${b})`);
    return null;
}

/**
 * Parse a template into nodes. Never throws; malformed or unknown tokens stay literal text.
 * @param {object} state  { inUrl, noApi, depth }
 * @param {object} ctx    { warn(msg) } collects validation messages
 */
export function parse(text, state = {}, ctx = { warn() {} }) {
    const src = String(text ?? '');
    const depth = (state.depth || 0) + 1;
    const nodes = [];
    let buf = '';
    const flush = () => { if (buf) { nodes.push({ t: 'text', v: buf }); buf = ''; } };
    if (depth > 6) return [{ t: 'text', v: src }];
    const inner = { ...state, depth };
    for (let i = 0; i < src.length;) {
        const ch = src[i];
        let node = null, end = -1;
        if (ch === '$' && (src[i + 1] === '{' || src[i + 1] === '(')) {
            const [oc, cc] = src[i + 1] === '{' ? ['{', '}'] : ['(', ')'];
            end = matchClose(src, i + 1, oc, cc);
            if (end > 0) node = (oc === '{' ? seToken : nbToken)(src.slice(i + 2, end), inner, ctx);
        } else if (ch === '{') {
            end = matchClose(src, i, '{', '}');
            if (end > 0) node = ourToken(src.slice(i + 1, end), inner, ctx);
        }
        if (node) {
            flush();
            nodes.push(node);
            i = end + 1;
        } else {
            buf += ch;
            i++;
        }
    }
    flush();
    return nodes;
}

/** Every API node in evaluation order (not inside choices — those are text by construction). */
function apiNodes(nodes, out = []) {
    for (const n of nodes) {
        if (n.t === 'api') out.push(n);
        else if (n.t === 'enc') apiNodes(n.body, out);
        else if (n.t === 'db' && n.value) apiNodes(n.value, out);
    }
    return out;
}

/** Every storage node in template order (never inside choices, URLs or set values — those are text by construction). */
function dbNodes(nodes, out = []) {
    for (const n of nodes) {
        if (n.t === 'db') out.push(n);
        else if (n.t === 'enc') dbNodes(n.body, out);
    }
    return out;
}

/** Check a template before saving: unknown tokens, bad API URLs, too many API calls or storage operations. */
export function validateTemplate(text, opts = {}) {
    const warnings = [];
    const ctx = { warn: (m) => { if (!warnings.includes(m)) warnings.push(m); } };
    const nodes = parse(text, opts.extraVars ? { extraVars: opts.extraVars } : {}, ctx);
    const all = apiNodes(nodes);
    const apis = all.filter(n => !n.local);
    const locals = all.length - apis.length;
    const dbs = dbNodes(nodes).length;
    if (apis.length > MAX_API_CALLS) ctx.warn(`Only the first ${MAX_API_CALLS} API calls in a response are run (this one has ${apis.length})`);
    if (locals > MAX_LOCAL_CALLS) ctx.warn(`Only the first ${MAX_LOCAL_CALLS} {evilinsult} tokens in a response are filled in (this one has ${locals})`);
    if (dbs > MAX_DB_OPS) ctx.warn(`Only the first ${MAX_DB_OPS} storage operations in a response are run (this one has ${dbs})`);
    return { warnings, apiCalls: Math.min(apis.length, MAX_API_CALLS), storageOps: Math.min(dbs, MAX_DB_OPS) };
}

/**
 * Evaluate nodes synchronously.
 * @param {object} vars  { values: {name: string}, args: string[], rng, results: Map<node,string> }
 */
function evaluate(nodes, vars, enc = false) {
    const encode = (s) => (enc ? encodeURIComponent(s) : s);
    let out = '';
    for (const n of nodes) {
        switch (n.t) {
            case 'text': out += n.v; break;
            case 'var': {
                const v = n.name === 'args' ? vars.args.join(' ')
                    : n.name === 'query' ? encodeURIComponent(vars.args.join(' '))
                        : String(vars.values[n.name] ?? '');
                out += n.name === 'query' ? v : encode(v);
                break;
            }
            case 'arg': out += encode(n.rest ? vars.args.slice(n.n - 1).join(' ') : (vars.args[n.n - 1] ?? '')); break;
            case 'random': {
                let [a, b] = [n.lo, n.hi];
                if (a > b) [a, b] = [b, a];
                out += String(a + Math.floor(vars.rng() * (b - a + 1)));
                break;
            }
            case 'choice': out += evaluate(n.options[Math.floor(vars.rng() * n.options.length)], vars, enc); break;
            case 'enc': out += encodeURIComponent(evaluate(n.body, vars, false)); break;
            case 'api': out += vars.results.get(n) ?? API_ERROR_TEXT; break;
            case 'db': out += encode(vars.dbResults?.get(n) ?? ''); break;
            default: break;
        }
    }
    return out;
}

/** The URL an API node will fetch, with arguments encoded. */
export function apiUrlOf(node, vars) {
    return evaluate(node.url, { results: new Map(), rng: Math.random, ...vars }, true).trim();
}

/** Strip control/bidi characters, defuse @everyone/@here, cap the length. */
export function cleanApiText(text, max = API_OUTPUT_MAX) {
    let s = String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\t/g, ' ')
        .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/@(everyone|here)/gi, '@​$1')
        .trim();
    if (s.length > max) s = s.slice(0, max - 1).trimEnd() + EVERYTHING;
    return s;
}

/** Field at a dotted / [index] path in parsed JSON, as text. '' path = the whole value. */
export function pickJson(value, path) {
    const steps = String(path || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = value;
    for (const step of steps) {
        if (cur == null || typeof cur !== 'object') return undefined;
        if (!Object.prototype.hasOwnProperty.call(cur, step)) return undefined;
        cur = cur[step];
    }
    if (cur === undefined) return undefined;
    if (cur === null) return 'null';
    return typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
}

/**
 * Who a reply may ping: users our own tokens produced, plus mentions the admin typed literally
 * into the template. Text from arguments or API replies never pings anyone.
 */
export function allowedMentionsFor(template, tokenUserIds = []) {
    const src = String(template || '');
    const users = new Set(tokenUserIds.filter(Boolean).map(String));
    for (const m of src.matchAll(/<@!?(\d{17,20})>/g)) users.add(m[1]);
    const roles = [...new Set([...src.matchAll(/<@&(\d{17,20})>/g)].map(m => m[1]))];
    const parse = /@(everyone|here)\b/.test(src) ? ['everyone'] : [];
    return { parse, users: [...users].slice(0, 100), roles: roles.slice(0, 100), repliedUser: false };
}

/** Which of our tokens ping someone: decides which user ids allowedMentionsFor lets through. */
export function mentionTokensUsed(template) {
    const nodes = parse(template);
    const used = new Set();
    const walk = (list) => {
        for (const n of list) {
            if (n.t === 'var' && (n.name === 'user.mention' || n.name === 'sender.mention')) used.add(n.name);
            else if (n.t === 'choice') n.options.forEach(walk);
            else if (n.t === 'enc') walk(n.body);
        }
    };
    walk(nodes);
    return used;
}

/**
 * Per-guild and per-command limits on API calls, with a short result cache.
 *   take(): { cached: text } | { ok: true } | { denied: 'guild' | 'command' }
 * A single invocation may make several calls; the per-command gap is between invocations.
 */
export function createApiLimiter({ perGuild = RATE_LIMITS.perGuild, windowMs = RATE_LIMITS.windowMs, perCommandMs = RATE_LIMITS.perCommandMs, cacheMs = RATE_LIMITS.cacheMs, now = Date.now } = {}) {
    const guildHits = new Map();   // guildId -> [timestamps]
    const lastRun = new Map();     // guild|command -> { at, invocation }
    const cache = new Map();       // guild|command|url -> { at, text }
    const prune = (t) => {
        if (cache.size > 2000) for (const [k, v] of cache) if (t - v.at > cacheMs) cache.delete(k);
        if (lastRun.size > 5000) for (const [k, v] of lastRun) if (t - v.at > perCommandMs) lastRun.delete(k);
    };
    return {
        take(guildId, commandKey, url, invocation) {
            const t = now();
            const hit = cache.get(`${guildId}|${commandKey}|${url}`);
            if (hit && t - hit.at < cacheMs) return { cached: hit.text };
            const key = `${guildId}|${commandKey}`;
            const last = lastRun.get(key);
            if (last && last.invocation !== invocation && t - last.at < perCommandMs) return { denied: 'command' };
            const hits = (guildHits.get(guildId) || []).filter(at => t - at < windowMs);
            if (hits.length >= perGuild) { guildHits.set(guildId, hits); return { denied: 'guild' }; }
            hits.push(t);
            guildHits.set(guildId, hits);
            lastRun.set(key, { at: t, invocation });
            prune(t);
            return { ok: true };
        },
        store(guildId, commandKey, url, text) {
            cache.set(`${guildId}|${commandKey}|${url}`, { at: now(), text });
        },
        reset() { guildHits.clear(); lastRun.clear(); cache.clear(); },
    };
}

/** The one limiter every API call in this process goes through (commands, dashboard Test, /fun insult). */
export const apiLimiter = createApiLimiter();

let invocationSeq = 0;
export const nextInvocation = () => ++invocationSeq;

/**
 * Turn one API node into text: local answer or (limiter → fetch) → JSON pick → clean → content check.
 * @param {object} deps { fetcher(url) → {text, contentType}, localAnswer?(url) → same shape | null,
 *                        limiter, isBlockedText?(text) → bool, onError?(code, url) }
 */
export async function runApiCall({ url, json, path }, { guildId, commandKey, invocation }, deps) {
    const { fetcher, localAnswer = null, limiter = apiLimiter, isBlockedText = () => false, onError = () => {} } = deps;
    let local = null;
    if (localAnswer) {
        try {
            local = await localAnswer(url);
        } catch (err) {
            onError(err.code || 'error', url, err);
            return { text: API_ERROR_TEXT, error: err.code || 'error', local: true };
        }
    }
    if (!local) {
        const gate = limiter.take(guildId, commandKey, url, invocation);
        if (gate.cached !== undefined) return { text: gate.cached, cached: true };
        if (gate.denied) { onError(`rate_${gate.denied}`, url); return { text: API_BUSY_TEXT, error: `rate_${gate.denied}` }; }
    }
    const tag = local ? { local: true } : {};
    let text;
    try {
        const res = local || await fetcher(url);
        let raw = res.text;
        if (json) {
            let parsed;
            try { parsed = JSON.parse(raw); } catch { throw Object.assign(new Error('not JSON'), { code: 'not_json' }); }
            raw = pickJson(parsed, path);
            if (raw === undefined) throw Object.assign(new Error('no such field'), { code: 'no_field' });
        }
        text = cleanApiText(raw);
    } catch (err) {
        onError(err.code || 'error', url, err);
        return { text: API_ERROR_TEXT, error: err.code || 'error', ...tag };
    }
    if (isBlockedText(text)) { onError('blocked_text', url); return { text: API_BLOCKED_TEXT, error: 'blocked_text', ...tag }; }
    if (local) return { text, local: true }; // never cached: each call is a fresh line
    limiter.store(guildId, commandKey, url, text);
    return { text };
}

/** Stored text as it may appear in a reply: cleaned like API text (no @everyone/@here, no control characters). */
export const cleanDbText = (text) => cleanApiText(text, DB_VALUE_MAX);

/**
 * Run one storage node against the store.
 * @param {object} node     a { t: 'db' } node from parse()
 * @param {object} vars     the render variables (a set value is evaluated with them)
 * @param {object} storage  { store, guildId, userId, onError?(err, node) }; store implements
 *                          get(g, u, key) → string|null, set(g, u, key, value, maxKeys) → { ok } | { full },
 *                          incr(g, u, key, by, maxKeys) → { value } | { full }, del(g, u, key) → { deleted }
 * @returns {Promise<{ text: string, op, scope, key, ok: boolean, error?: string }>}
 */
export async function runDbOp(node, vars, storage) {
    const info = { op: node.op, scope: node.scope, key: node.key };
    const owner = node.scope === 'server' ? DB_SERVER_USER : storage?.userId;
    if (!storage?.store || !storage.guildId || !owner) return { ...info, text: '', ok: false, error: 'disabled' };
    const { store, guildId } = storage;
    const maxKeys = node.scope === 'server' ? DB_SERVER_KEYS : DB_USER_KEYS;
    try {
        switch (node.op) {
            case 'get': {
                const v = await store.get(guildId, owner, node.key);
                return { ...info, text: v == null ? '' : cleanDbText(v), ok: true };
            }
            case 'set': {
                const value = evaluate(node.value || [], vars).trim();
                if (value.length > DB_VALUE_MAX) return { ...info, text: DB_TOO_LONG_TEXT, ok: false, error: 'too_long' };
                const r = await store.set(guildId, owner, node.key, value, maxKeys);
                return r?.full ? { ...info, text: DB_FULL_TEXT, ok: false, error: 'full' } : { ...info, text: '', ok: true };
            }
            case 'incr': {
                const r = await store.incr(guildId, owner, node.key, node.by ?? 1, maxKeys);
                return r?.full ? { ...info, text: DB_FULL_TEXT, ok: false, error: 'full' } : { ...info, text: String(r.value), ok: true };
            }
            case 'del':
                await store.del(guildId, owner, node.key);
                return { ...info, text: '', ok: true };
            default:
                return { ...info, text: '', ok: false, error: 'unknown_op' };
        }
    } catch (err) {
        try { storage.onError?.(err, node); } catch { /* logging must not break the reply */ }
        return { ...info, text: DB_ERROR_TEXT, ok: false, error: 'error' };
    }
}

/**
 * Render a template.
 * @param {string} template
 * @param {object} vars     { values, args, rng }
 * @param {object} api      { guildId, commandKey, deps } — omit to render API tokens as API_ERROR_TEXT
 * @param {object} storage  { store, guildId, userId, onError? } — omit and storage tokens render empty
 * @param {object} opts     { extraVars: Set<string> } — extra plain variable names (lower case), values from vars.values
 * @returns {Promise<{ text: string, calls: Array<{url, ok, error?, cached?, local?}>, storage: Array<{op, scope, key, ok, error?}> }>}
 */
export async function renderTemplate(template, vars, api = null, storage = null, opts = {}) {
    const full = { values: {}, args: [], rng: Math.random, ...vars, results: new Map(), dbResults: new Map() };
    const nodes = parse(template, opts.extraVars ? { extraVars: opts.extraVars } : {});
    const calls = [];
    const invocation = nextInvocation();
    const all = apiNodes(nodes);
    const run = new Set([...all.filter(n => !n.local).slice(0, MAX_API_CALLS), ...all.filter(n => n.local).slice(0, MAX_LOCAL_CALLS)]);
    for (const node of all.filter(n => run.has(n))) {
        const url = apiUrlOf(node, full);
        if (!api) { calls.push({ url, ok: false, error: 'disabled' }); continue; }
        const r = await runApiCall({ url, json: node.json, path: node.path }, { guildId: api.guildId, commandKey: api.commandKey, invocation }, api.deps);
        full.results.set(node, r.text);
        calls.push({ url, ok: !r.error, error: r.error, cached: !!r.cached, local: !!r.local });
    }
    // Storage after the API calls (a set value may hold an API reply), in template order, one at a time.
    const ops = [];
    for (const node of dbNodes(nodes).slice(0, MAX_DB_OPS)) {
        const { text: out, ...op } = await runDbOp(node, full, storage);
        full.dbResults.set(node, out);
        ops.push(op);
    }
    let text = evaluate(nodes, full);
    if (text.length > MESSAGE_MAX) text = text.slice(0, MESSAGE_MAX - 1) + EVERYTHING;
    return { text, calls, storage: ops };
}

/**
 * Argument helpers. Mentions in the typed text become @names so {args} and {query} read naturally.
 * @param {string[]} tokens  words after the command name
 * @param {(id: string) => string|null} nameOf  display name for a mentioned user id
 */
export function normaliseArgs(tokens, nameOf = () => null) {
    return (tokens || []).filter(Boolean).slice(0, 50).map(t => String(t).replace(/<@!?(\d{17,20})>/g, (m, id) => {
        const name = nameOf(id);
        return name ? `@${name}` : m;
    }).slice(0, 200));
}

/** {touser}: first mention, else first word typed (without a leading @), else the sender. */
export function touserOf({ mentionedName = null, args = [], senderName = '' }) {
    if (mentionedName) return mentionedName;
    if (args[0]) return String(args[0]).replace(/^@+/, '');
    return senderName;
}

export default {
    TEMPLATE_VARIABLES, ALIAS_VARIABLES, MAX_API_CALLS, MAX_LOCAL_CALLS, EVIL_INSULT_API, API_OUTPUT_MAX, RATE_LIMITS, parse, validateTemplate,
    renderTemplate, runApiCall, cleanApiText, pickJson, allowedMentionsFor, mentionTokensUsed, createApiLimiter,
    apiLimiter, normaliseArgs, touserOf, runDbOp, cleanDbText, MAX_DB_OPS,
};
