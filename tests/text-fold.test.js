import test from 'node:test';
import assert from 'node:assert/strict';
import { foldConfusables, foldLeet, skeleton, collapse, textForms } from '../utils/text-fold.js';

/*
 * utils/text-fold.js — the one lookalike folder. What has to stay true:
 *   - every disguise scammers use for a word folds back to the plain word
 *   - ordinary text, digits-only runs and non-Latin text that has no lookalike survive
 *   - skeleton() is only ever compared with skeleton()
 */

const SUPPORT = [
    'ѕuррогt',                // Cyrillic
    'Ꮪupport',                // Cherokee
    'ꜱᴜᴘᴘᴏʀᴛ',                // small capitals
    '🅢🅤🅟🅟🅞🅡🅣',            // negative circled
    '🆂🆄🅿🅿🅾🆁🆃',            // negative squared
    '🇸🇺🇵🇵🇴🇷🇹',            // regional indicators
    '⒮⒰⒫⒫⒪⒭⒯',                // parenthesised
    'ⓢⓤⓟⓟⓞⓡⓣ',                // circled (NFKC)
    '𝐬𝐮𝐩𝐩𝐨𝐫𝐭',                // maths bold (NFKC)
    '𝓈𝓊𝓅𝓅𝑜𝓇𝓉',                // maths script (NFKC)
    'ＳＵＰＰＯＲＴ',          // fullwidth (NFKC)
    's̷̢u̵p̴p̶o̸r̷t̶',          // zalgo
    'sup​p‍ort',    // zero-width
    'su‮pport',          // bidi override
    'SUPPORT',
    'ᔕᑌᑭᑭOᖇT',                // Canadian syllabics
];

test('every disguise of "support" folds to "support"', () => {
    for (const s of SUPPORT) assert.equal(foldConfusables(s), 'support', JSON.stringify(s));
});

test('Greek capitals, Armenian and CJK-stroke fonts', () => {
    assert.equal(foldConfusables('ΜΟDΕRΑΤΟR'), 'moderator');
    assert.equal(foldConfusables('Ꭺdmin'), 'admin');
    assert.equal(foldConfusables('卂刀爪丨几'), 'admin');
    assert.equal(foldConfusables('ᗩᗪᗰᓰᑎ'), 'admin');
    assert.equal(foldConfusables('սօ'), 'uo', 'Armenian u and o');
});

test('accents go, case is kept on request, whitespace collapses', () => {
    assert.equal(foldConfusables('  Café   Crème '), 'cafe creme');
    assert.equal(foldConfusables('İstanbul'), 'istanbul');
    assert.equal(foldConfusables('ЅUРРОRТ Team', { keepCase: true }), 'SUPPORT Team');
    assert.equal(foldConfusables('ㅤㅤ'), '', 'Hangul filler "blank names" fold to nothing');
    assert.equal(foldConfusables(null), '');
});

test('leetspeak folds inside words only', () => {
    assert.equal(foldLeet('m0d3rat0r'), 'moderator');
    assert.equal(foldLeet('$upp0rt t3am'), 'support team');
    assert.equal(foldLeet('4dm1n'), 'admin');
    assert.equal(foldLeet('4dm1n', { one: 'l' }), 'admln');
    assert.equal(foldLeet('user 2024'), 'user 2024', 'a plain number is left alone');
    assert.equal(foldLeet('@dmin'), 'admin');
});

test('skeletons make lookalike shapes equal on both sides', () => {
    assert.equal(skeleton('Official'), skeleton('0ff1c1al'));
    assert.equal(skeleton('modern'), skeleton('modem'), 'rn reads as m');
    assert.equal(skeleton('vvallet'), skeleton('wallet'));
    assert.equal(skeleton('Paypal'), skeleton('PayPa1'));
    assert.notEqual(skeleton('support'), skeleton('suppose'));
});

test('collapse removes separators and repeats', () => {
    assert.equal(collapse('s.u.p.p.o.r.t'), 'suport');
    assert.equal(collapse('suuuppoort'), 'suport');
    assert.equal(collapse('s u p p o r t'), collapse('support'));
});

test('textForms: every form, deduplicated, capped', () => {
    const f = textForms('Off1c1al Supp0rt', { collapseRepeats: true });
    assert.equal(f.raw, 'Off1c1al Supp0rt');
    assert.equal(f.folded, 'off1c1al supp0rt');
    assert.equal(f.leet, 'official support');
    assert.equal(f.leetL, 'offlclal support');
    assert.equal(f.skeleton, skeleton('official support'));
    assert.equal(f.collapsed, collapse(f.skeleton));
    assert.equal(textForms('plain').leetL, null, 'no second leet form when there is no 1');
    assert.equal(textForms('x'.repeat(500)).raw.length, 128);
});

test('the older call sites still behave', async () => {
    const { normalise } = await import('../core/commission-spam-match.js');
    assert.equal(normalise('Commissions OPEN!!'), 'commissions open');
    assert.equal(normalise('сommissions ореn'), 'commissions open', 'Cyrillic lookalikes are now caught');
});
