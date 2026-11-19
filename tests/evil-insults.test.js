import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    createEvilInsults, evilInsults, parseEvilInsultUrl, fillName, apiRecord, LANGUAGES, CORPUS_PATH, RECENT_WINDOW,
} from '../core/evil-insults.js';
import { rejectReason, findHateTerm } from '../core/hate-terms.js';
import { NOTHING_PASSED } from '../core/insult-generator.js';
import {
    renderTemplate, validateTemplate, createApiLimiter, MAX_API_CALLS, API_ERROR_TEXT,
} from '../core/custom-command-vars.js';

/*
 * Evil Insult served locally (core/evil-insults.js): the corpus, "[Name]", the per-server no-repeat
 * window, filtering with re-roll and built-in fallback, and the generate_insult.php compatibility
 * shim inside custom-command templates. No network anywhere: the fetcher used for Evil Insult URLs
 * throws, so a test that reached it would fail.
 */

let seed = 11;
const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const ROWS = [
    ...Array.from({ length: 12 }, (_, i) => ({ n: i + 1, lang: 'en', text: `English insult number ${i + 1}.`, created: '2020-01-01 00:00:00', shown: 5, createdby: 'Marvin', comment: null })),
    { n: 100, lang: 'en', text: '[Name] ... you have aged.', created: '2021-02-02 00:00:00', shown: 1, createdby: null, comment: 'src' },
    { n: 200, lang: 'de', text: 'Du Sackratte!', created: null, shown: 0, createdby: null, comment: null },
    { n: 201, lang: 'de', text: 'Du Lauch!', created: null, shown: 0, createdby: null, comment: null },
    { n: 300, lang: 'xx', text: 'inactive row', active: false },
];

const NO_NETWORK = async (url) => { throw Object.assign(new Error(`network call to ${url}`), { code: 'network_used' }); };

test('the real corpus loads: active rows only, English and the offered languages present', () => {
    const rows = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
    assert.ok(rows.length > 2500, `${rows.length} rows`);
    assert.ok(rows.every(r => r.active !== false && typeof r.text === 'string' && r.text.trim() && Number.isInteger(r.n)));
    assert.equal(new Set(rows.map(r => r.n)).size, rows.length, 'row numbers are unique');
    const counts = evilInsults.counts();
    assert.ok(counts.en >= 700, `${counts.en} English lines`);
    for (const { code } of LANGUAGES) assert.ok(counts[code] >= 20, `${code}: ${counts[code]} lines`);
    assert.equal(LANGUAGES.length <= 25, true, 'fits a Discord choice list');
});

test('most English lines pass the bot-wide slur floor', () => {
    const rows = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')).filter(r => r.lang === 'en');
    const pass = rows.filter(r => !findHateTerm(fillName(r.text))).length;
    assert.ok(pass / rows.length > 0.9, `${pass} of ${rows.length} pass`);
});

test('"[Name]" becomes the name, or "you" (capitalised at the start)', async () => {
    assert.equal(fillName('[Name] ... you have aged.'), 'You ... you have aged.');
    assert.equal(fillName('Hey [name], and [NAME].', 'Kes'), 'Hey Kes, and Kes.');
    assert.equal(fillName('No placeholder.', 'Kes'), 'No placeholder.');
    const src = createEvilInsults({ rows: [ROWS[12]] });
    const named = await src.random('en', { name: '<@1>', rng });
    assert.equal(named.line, '<@1> ... you have aged.');
    assert.equal(named.named, true);
    const plain = await src.random('en', { rng });
    assert.equal(plain.line, 'You ... you have aged.');
    assert.equal(plain.named, false);
});

test('unknown or empty language falls back to English; inactive rows are never served', async () => {
    const src = createEvilInsults({ rows: ROWS });
    assert.equal((await src.random('zz', { rng })).lang, 'en');
    assert.equal((await src.random('', { rng })).lang, 'en');
    assert.equal((await src.random('DE', { rng })).lang, 'de');
    assert.equal(src.resolveLang('xx'), 'en', 'a language whose only row is inactive has nothing to serve');
    assert.equal(src.counts().xx, undefined);
});

test('no repeat within the window, per server; a tiny language still alternates', async () => {
    const window = 6;
    const src = createEvilInsults({ rows: ROWS, window });
    const seen = [];
    for (let i = 0; i < 200; i++) {
        const r = await src.random('en', { guildId: 'g1', rng });
        assert.ok(!seen.slice(-window).includes(r.row.n), `line ${r.row.n} repeated within ${window} (pick ${i})`);
        seen.push(r.row.n);
    }
    assert.ok(new Set(seen).size === 13, 'every English line still comes up');
    // Another server has its own window.
    const other = await src.random('en', { guildId: 'g2', rng });
    assert.ok(other.row);
    const de = [];
    for (let i = 0; i < 10; i++) de.push((await src.random('de', { guildId: 'g1', rng })).row.n);
    for (let i = 1; i < de.length; i++) assert.notEqual(de[i], de[i - 1], 'two-line language alternates');
    assert.equal(RECENT_WINDOW, 50);
});

test('filtered lines are re-rolled; after the tries run out the built-in generator answers', async () => {
    const src = createEvilInsults({ rows: ROWS, tries: 4 });
    // Reject every Evil Insult line except number 7 (built-in lines pass).
    let r = await src.random('en', { rng, reject: (t) => (/insult number (?!7\.)|aged/.test(t) ? 'server filter (word: x)' : null) });
    if (r.source === 'evilinsult') assert.equal(r.row.n, 7);
    else assert.equal(r.source, 'builtin');
    assert.ok(r.filtered.every(f => f.source === 'evilinsult' || f.source === 'builtin'));

    r = await src.random('en', { rng, reject: (t) => (/insult number|aged/.test(t) ? 'built-in slur list' : null) });
    assert.equal(r.source, 'builtin');
    assert.equal(r.row, null);
    assert.equal(r.filtered.filter(f => f.source === 'evilinsult').length, 4, 'K evil tries before falling back');
    assert.ok(!/insult number/.test(r.line));

    r = await src.random('en', { rng, reject: () => 'everything' });
    assert.deepEqual([r.line, r.source], [NOTHING_PASSED, 'none']);

    // The filter sees the line as posted (placeholder filled with "you").
    const seen = [];
    await createEvilInsults({ rows: [ROWS[12]] }).random('en', { name: 'Kes', rng, reject: (t) => { seen.push(t); return null; } });
    assert.deepEqual(seen, ['You ... you have aged.']);
});

test('parseEvilInsultUrl: every spelling of the real API, nothing else', () => {
    const P = parseEvilInsultUrl;
    assert.deepEqual(P('https://evilinsult.com/generate_insult.php?lang=en&type=text'), { lang: 'en', type: 'text' });
    assert.deepEqual(P('https://evilinsult.com/generate_insult.php'), { lang: 'en', type: 'text' }, 'no params');
    assert.deepEqual(P('https://evilinsult.com/generate_insult.php/?lang=de&type=json'), { lang: 'de', type: 'json' }, 'trailing slash');
    assert.deepEqual(P('HTTPS://EvilInsult.COM/Generate_Insult.PHP?LANG=ES&Type=XML'), { lang: 'es', type: 'xml' }, 'any case');
    assert.deepEqual(P('http://www.evilinsult.com/generate_insult.php?type=json'), { lang: 'en', type: 'json' });
    assert.deepEqual(P('https://evilinsult.com./generate_insult.php?type=bogus'), { lang: 'en', type: 'text' });
    for (const u of ['https://evilinsult.com/', 'https://evilinsult.com/other.php', 'https://evilinsult.com.evil.dev/generate_insult.php',
        'https://notevilinsult.com/generate_insult.php', 'ftp://evilinsult.com/generate_insult.php', 'not a url', '']) {
        assert.equal(P(u), null, u);
    }
});

/** Render a template with the shim wired the way core/custom-command-handler.js wires it. */
function shimApi(src, { reject = () => null } = {}) {
    const fetched = [];
    const deps = {
        limiter: createApiLimiter(),
        localAnswer: (url) => src.answerApi(url, { guildId: 'g', reject, rng }),
        fetcher: async (url) => {
            fetched.push(url);
            if (/evilinsult/i.test(url)) return NO_NETWORK(url);
            return { text: `net(${url})` };
        },
    };
    const render = async (tpl, args = []) => renderTemplate(tpl, { values: { touser: 'Kes', sender: 'Death' }, args, rng }, { guildId: 'g', commandKey: 'c', deps });
    return { fetched, render };
}

test('shim: text, json and xml answers, every URL form, without a network call', async () => {
    const src = createEvilInsults({ rows: ROWS });
    const { fetched, render } = shimApi(src);
    const texts = [];
    for (const tpl of [
        '{api:https://evilinsult.com/generate_insult.php?lang=en&type=text}',
        '{api:https://evilinsult.com/generate_insult.php}',
        '{api:HTTPS://EVILINSULT.COM/GENERATE_INSULT.PHP/?Lang=EN}',
        '${customapi.https://evilinsult.com/generate_insult.php?lang=en&type=text}',
        '$(urlfetch https://evilinsult.com/generate_insult.php?lang=en&type=text)',
        '$(customapi https://evilinsult.com/generate_insult.php)',
    ]) {
        const { text, calls } = await render(tpl);
        assert.match(text, /^(English insult number \d+\.|You \.\.\. you have aged\.)$/, tpl);
        assert.deepEqual(calls.map(c => [c.ok, c.local]), [[true, true]], tpl);
        texts.push(text);
    }
    assert.equal(new Set(texts).size, texts.length, 'no repeats, nothing served from the 3-second cache');

    const de = await render('{api:https://evilinsult.com/generate_insult.php?lang=de&type=text}');
    assert.match(de.text, /^Du (Sackratte|Lauch)!$/);

    const json = await render('{api:https://evilinsult.com/generate_insult.php?lang=de&type=json}');
    const rec = JSON.parse(json.text);
    assert.deepEqual(Object.keys(rec), ['number', 'language', 'insult', 'created', 'shown', 'createdby', 'active', 'comment']);
    assert.ok(Object.values(rec).every(v => typeof v === 'string'), 'every value a string, like the real API');
    assert.equal(rec.language, 'de');
    assert.ok(['200', '201'].includes(rec.number));

    const field = await render('{touser}: {api.json:https://evilinsult.com/generate_insult.php?lang=de&type=json|insult}');
    assert.match(field.text, /^Kes: Du (Sackratte|Lauch)!$/);

    const xml = await render('{api:https://evilinsult.com/generate_insult.php?type=xml&lang=en}');
    assert.match(xml.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<evilinsult><number>\d+<\/number><language>en<\/language><insult>[^<]+<\/insult>/);

    assert.deepEqual(fetched, [], 'the network fetcher was never called');
});

test('shim: lines go through the filter; other hosts still go through the fetcher', async () => {
    const src = createEvilInsults({ rows: ROWS, tries: 3 });
    const { fetched, render } = shimApi(src, { reject: () => 'server filter (word: insult)' });
    const r = await render('{api.json:https://evilinsult.com/generate_insult.php?type=json|insult} and {api:https://icanhazdadjoke.com/}');
    assert.ok(!/insult number|aged/.test(r.text), 'filtered lines never posted');
    assert.equal(r.text, `${NOTHING_PASSED} and net(https://icanhazdadjoke.com/)`);
    assert.deepEqual(fetched, ['https://icanhazdadjoke.com/'], 'only the other host reached the fetcher');
    assert.deepEqual(r.calls.map(c => c.local), [true, false]);
});

test('{evilinsult} and {evilinsult:de} tokens: local, filtered, outside the API call limit', async () => {
    const src = createEvilInsults({ rows: ROWS });
    const { fetched, render } = shimApi(src);
    const r = await render('{touser}, {evilinsult} / {evilinsult:de} / {evilinsult:zz}');
    assert.match(r.text, /^Kes, (English insult number \d+\.|You \.\.\. you have aged\.) \/ Du (Sackratte|Lauch)! \/ (English insult number \d+\.|You \.\.\. you have aged\.)$/);
    assert.deepEqual(fetched, []);

    // Three network calls plus two local ones: all five run.
    const many = await render('{api:https://a.dev/1}{api:https://a.dev/2}{api:https://a.dev/3}{evilinsult}{evilinsult:de}');
    assert.equal(many.calls.length, MAX_API_CALLS + 2);
    assert.ok(!many.text.includes(API_ERROR_TEXT));

    assert.deepEqual(validateTemplate('{evilinsult} {evilinsult:de} {EvilInsult:ES}').warnings, []);
    assert.ok(validateTemplate('{evilinsult:zz}').warnings.some(w => /English is used/.test(w)));
    assert.ok(validateTemplate('{choice:{evilinsult}|b}').warnings.some(w => /not run/.test(w)));
    assert.ok(validateTemplate('{evilinsult}'.repeat(6)).warnings.some(w => /first 5/.test(w)));
});

test('apiRecord for a built-in fallback line', () => {
    const rec = apiRecord({ line: 'You are a soggy potato.', lang: 'en', row: null });
    assert.equal(rec.number, '');
    assert.equal(rec.insult, 'You are a soggy potato.');
    assert.match(rec.comment, /built-in/);
});

test('the live wiring (custom-command-handler apiDepsFor) answers Evil Insult URLs locally', async () => {
    const { apiDepsFor } = await import('../core/custom-command-handler.js');
    const deps = apiDepsFor(null, 'test', { log: false });
    assert.equal(await deps.localAnswer('https://icanhazdadjoke.com/'), null, 'other URLs are not answered locally');
    const res = await deps.localAnswer('https://evilinsult.com/generate_insult.php?lang=en&type=json');
    assert.equal(res.local, true);
    const rec = JSON.parse(res.text);
    assert.equal(rec.language, 'en');
    assert.equal(rejectReason(rec.insult), null, 'what it serves passes the slur floor');
});
