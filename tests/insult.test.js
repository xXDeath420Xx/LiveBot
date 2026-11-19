import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    ADJECTIVES, NOUNS, COMPARISONS, LINES, TEMPLATES, PART_COUNT, generateInsult, pickInsult, NOTHING_PASSED,
} from '../core/insult-generator.js';
import { findHateTerm, containsHateTerm, serverFilterHit, rejectReason } from '../core/hate-terms.js';
import { FEATURE_SPECS } from '../core/feature-config-spec.js';

/*
 * /fun insult: the built-in generator (core/insult-generator.js), the slur floor and server filter
 * (core/hate-terms.js), and the opt-in setting on the `fun` feature spec.
 */

const rot13 = (s) => s.replace(/[a-z]/g, c => String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97));
let seed = 7;
const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test('several hundred curated parts, and results vary', () => {
    assert.ok(PART_COUNT >= 300, `only ${PART_COUNT} parts`);
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(generateInsult(rng));
    assert.ok(seen.size > 1000, `only ${seen.size} distinct insults in 2000`);
});

test('every built-in part and template is clean and filled in', () => {
    // Swearing is not hateful but has no place in the built-in list either.
    const profanity = /\b(?:fuck|shit|bitch|cunt|dick|cock|pussy|whore|slut|bastard|damn|ass|asshole|piss)\w*/i;
    for (const part of [...ADJECTIVES, ...NOUNS, ...COMPARISONS, ...LINES, ...TEMPLATES]) {
        assert.equal(findHateTerm(part), null, `hate term in "${part}"`);
        assert.ok(!profanity.test(part), `profanity in "${part}"`);
    }
    for (let i = 0; i < 3000; i++) {
        const s = generateInsult(rng);
        assert.ok(!/[{}]/.test(s), `unfilled slot: ${s}`);
        assert.ok(/^[A-Z"]/.test(s) && /[.!?"]$/.test(s), `sentence shape: ${s}`);
        assert.ok(!/\ban (?:USB|one-)/.test(s) && !/\ba [aeio]/i.test(s.replace(/\ba (?:one|USB|use|uni)/g, '')), `article: ${s}`);
    }
});

test('slur floor catches slurs through leet and lookalikes, not innocent words', () => {
    const t = (plain) => rot13(plain); // the test spells terms the same way the module stores them
    for (const s of [`you ${t('avttre')}`, `what a ${t('e3gneq')}`, `${t('snttbgf')} everywhere`, `go ${t('xvyy')} your self`,
        `${t('erg4eqrq')}`, `п${t('vttn')}`, `such a ${t('fcvp')}`, `${t('encvfg')}`]) {
        assert.ok(containsHateTerm(s), `should catch: ${s}`);
    }
    for (const s of ['grapes and raccoons in Japan', 'a spicy cocoon', 'therapist', 'scrapes', 'Scunthorpe', 'homogenised milk', 'cocktail']) {
        assert.equal(findHateTerm(s), null, `false positive: ${s}`);
    }
});

test("server filter: automod banned words (contains / word) and message patterns, leet-folded", () => {
    const filter = {
        words: [{ word: 'potato', byWord: false }, { word: 'cone', byWord: true }],
        patterns: [{ id: 9, pattern_type: 'regex', pattern: 'loading\\s+screen' }, { id: 10, pattern_type: 'contains', pattern: 'kazoo' }, { id: 11, pattern_type: 'domain', pattern: 'x.dev' }],
    };
    assert.match(serverFilterHit('You are a soggy potatoes fan', filter), /potato/);
    assert.match(serverFilterHit('You are a p0tat0', filter), /potato/, 'leet-folded');
    assert.equal(serverFilterHit('a pinecone', filter), null, 'word-mode needs a boundary');
    assert.match(serverFilterHit('a traffic cone.', filter), /cone/);
    assert.match(serverFilterHit('You make loading  screens feel productive', filter), /#9/);
    assert.match(serverFilterHit('a KAZOO', filter), /#10/);
    assert.equal(serverFilterHit('visit x.dev', filter), null, 'domain patterns are about links, not words');
    assert.equal(rejectReason('fine text', filter), null);
    assert.equal(rejectReason(`a ${rot13('ergneq')}`, filter), 'built-in slur list');
});

test('pickInsult: built-in only, re-rolled until a line passes', async () => {
    let r = await pickInsult({ rng });
    assert.equal(r.source, 'builtin');
    assert.ok(r.line.length > 5);

    let n = 0;
    r = await pickInsult({ reject: () => (n++ < 2 ? 'server filter' : null), rng });
    assert.equal(r.source, 'builtin');
    assert.deepEqual(r.filtered.map(f => f.source), ['builtin', 'builtin']);

    r = await pickInsult({ reject: () => 'everything', rng, builtinTries: 3 });
    assert.deepEqual([r.line, r.source, r.filtered.length], [NOTHING_PASSED, 'none', 3]);
});

test('the fun spec: opt-in default off; source built-in by default, Evil Insult offered with a warning', () => {
    const fields = Object.fromEntries(FEATURE_SPECS.fun.fields.map(f => [f.key, f]));
    assert.equal(fields.insults_enabled.type, 'toggle');
    assert.equal(fields.insults_enabled.default, false);
    assert.equal(fields.insult_source.type, 'select');
    assert.equal(fields.insult_source.default, 'builtin');
    assert.deepEqual(fields.insult_source.options.map(o => o.value), ['builtin', 'evilinsult']);
    assert.match(fields.insult_source.hint, /crude/i);
    assert.match(fields.insult_source.hint, /sexual/i);
    assert.equal(fields.insult_language.default, 'en');
    assert.ok(fields.insult_language.options.some(o => o.value === 'de'));
});

test('/fun insult is registered as a flat subcommand within Discord limits', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'commands', 'fun', 'fun.js'), 'utf8');
    const m = src.match(/setName\('insult'\)\.setDescription\('([^']+)'\)/);
    assert.ok(m, 'insult subcommand present');
    assert.ok(m[1].length <= 100);
    assert.match(src, /subcommand === 'insult'/);
    assert.match(src, /setName\('language'\)/, 'language option');
});
