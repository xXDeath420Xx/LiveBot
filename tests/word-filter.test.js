import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFilter, findEntry, matchForms, nativeRuleSpec, parseEntries } from '../core/word-filter-logic.js';

/*
 * Filtered words: the matching rules. Slurs are stored ROT13, as in core/hate-terms.js, so this file is not
 * itself a list of them. Each `hit` line is an evasion that has to be caught; each `miss` line an ordinary
 * sentence that must never be deleted, because a filter that eats normal chat gets switched off.
 */
const rot = (s) => s.replace(/[a-z]/g, c => String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97));
const NWORD = rot('avttre');
const STEM = rot('avtt*');
const filter = compileFilter(
    [STEM, rot('snttbg*'), rot('snt'), rot('fcvp'), rot('pbba'), rot('jrgonpx*'), rot('gbjryurnq*'), rot('puvax')],
    [rot('avtty*'), rot('avttneq*'), rot('puvax va')],
);
const hit = (text, entry = STEM) => assert.equal(findEntry(text, filter), entry, text);
const miss = (text) => assert.equal(findEntry(text, filter), null, text);

test('plain and capitalised', () => {
    hit(NWORD);
    hit(NWORD.toUpperCase());
    hit(`you ${NWORD}.`);
    hit(`${NWORD}!`);
});

test('leetspeak', () => {
    hit(NWORD.replace('i', '1'));
    hit(NWORD.replace('i', '1').replace('e', '3'));
    hit(NWORD.replace('i', '!'));
    hit(NWORD.replace('i', '|'));
    hit(NWORD.replace('i', 'l'));
});

test('lookalike letters, zalgo and invisible characters', () => {
    hit(NWORD.replace('i', 'і'));                             // Cyrillic i
    hit(NWORD.replace('e', 'е'));                             // Cyrillic e
    hit([...NWORD].join('​'));                           // zero-width spaces
    hit([...NWORD].map(c => `${c}́`).join(''));          // combining marks
    hit([...NWORD].map(c => String.fromCodePoint(c.charCodeAt(0) + 0xFEE0)).join(''));   // full width
});

test('spaced out and punctuated', () => {
    hit([...NWORD].join(' '));
    hit([...NWORD].join('.'));
    hit([...NWORD].join('-'));
    hit([...NWORD.replace('i', '1').replace('e', '3')].join(' '));
});

test('Discord markdown', () => {
    hit(`${NWORD[0]}**${NWORD.slice(1, 3)}**${NWORD.slice(3)}`);
    hit(`${NWORD.slice(0, 2)}||${NWORD.slice(2)}||`);
    hit(`${NWORD[0]}_${NWORD.slice(1)}_`);
    hit(`${NWORD.slice(0, 3)}~~${NWORD.slice(3)}~~`);
});

test('stretched letters', () => {
    hit(NWORD.replace('i', 'iiii'));
    hit(NWORD.replace('gg', 'ggggg'));
    hit(NWORD.replace('n', 'nnn'));
});

test('endings on a prefix entry', () => {
    hit(`${NWORD}s`);
    hit(rot('avttnf'));
});

test('whole-word entries stay whole words', () => {
    hit(rot('fcvp'), rot('fcvp'));
    hit(rot('pbba'), rot('pbba'));
    hit(rot('snt'), rot('snt'));
    miss('this curry is really spicy');
    miss('a raccoon got in the bin');
    miss('the cocoon opened');
    miss('flag the post');
    miss('snigger at the back');
});

test('words that only look close', () => {
    miss('Nigeria won the match');
    miss('Niger is a country');
    miss('a small niggle in my knee');
    miss('that niggling feeling');
    miss('a chink in the armor');
});

test('two ordinary words are not joined', () => {
    miss('my wet back hurts');
    miss('wrapped a towel head to toe');
    miss('the FA got fined');
    miss('that\'s pic of me');
});

test('ordinary chat', () => {
    for (const line of ['gg wp everyone', 'good game, nice one!', 'i.e. a b c', 'score was 1 1 3 7', 'grinding the big boss', 'wow!!! ok!', '']) miss(line);
});

test('stretching is one letter at a time, not a free pass for a shorter word', () => {
    miss(NWORD.replace('gg', 'g'));
});

test('an exception only covers what it names', () => {
    hit(`small niggle but you are a ${NWORD}`);
    hit(`a chink in the armor you ${rot('puvax')}`, rot('puvax'));
});

test('an empty list matches nothing', () => {
    assert.equal(findEntry(NWORD, compileFilter([], [])), null);
    assert.equal(findEntry(NWORD, null), null);
});

test('parseEntries takes lines or commas and drops what Discord would refuse', () => {
    assert.deepEqual(parseEntries('Foo,  bar*\n\n*baz*, foo'), ['foo', 'bar*', '*baz*']);
    assert.deepEqual(parseEntries('two  words'), ['two words']);
    assert.deepEqual(parseEntries('*, **, ' + 'x'.repeat(61)), []);
    assert.equal(parseEntries(Array.from({ length: 5 }, (_, i) => `w${i}`), 3).length, 3);
});

test('matchForms closes up single letters only', () => {
    assert.ok(matchForms('c a t sat').leet.includes('cat sat'));
    assert.ok(matchForms('to be or').leet.includes('to be or'));
});

test('the native rule only blocks, and carries a regex only for words in the list', () => {
    const spec = nativeRuleSpec({ words: [STEM, 'other'], exceptions: ['x'], flagChannelId: '123', enabled: true });
    assert.deepEqual(spec.actions.map(a => a.type), [1]);
    assert.deepEqual(spec.exemptChannels, ['123']);
    assert.equal(spec.triggerMetadata.regexPatterns.length, 1);
    assert.equal(nativeRuleSpec({ words: ['other'], exceptions: [], flagChannelId: null, enabled: true }).triggerMetadata.regexPatterns.length, 0);
});
