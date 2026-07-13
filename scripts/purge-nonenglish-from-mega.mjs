#!/usr/bin/env node
/**
 * One-shot: scan every card in the Mega Pack and delete the non-English ones.
 *
 * Detection layers (most → least confident, applied in order):
 *  1. Any non-Latin character (Cyrillic, CJK, Arabic, Greek, Devanagari) → drop
 *  2. > 2 Latin-accented characters (à é ñ ç ß etc) → drop
 *  3. Contains a known non-English short word AND no English signal → drop
 *  4. Contains 3+ chars from a non-English-typical character class → drop
 *
 * Leaves the deck row itself + every card not flagged untouched.
 */

import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';

const NON_LATIN = /[Ѐ-ӿͰ-Ͽ؀-ۿ一-鿿぀-ヿ가-힯ऀ-ॿ]/;
const ACCENTED = /[àáâãäåèéêëìíîïòóôõöùúûüñçßẞœæğşİťłżźńĳõūīāēōÿøåœ]/gi;
const NON_EN = new RegExp(
    '\\b(' + [
        // Italian
        'che','della','degli','gli','nella','sulla','però','sono','questo','questa','questi','queste',
        'niente','grazie','prego','sempre','mai','quando','dove','perché','come','molto','poco','tutto','tutta',
        'cosa','adesso','allora','anche','ancora','solo','poi','già','così','bene','male',
        // Spanish / Portuguese
        'que','esta','este','estos','estas','todo','todos','toda','nada','siempre','nunca','cuando','dónde','cómo',
        'porque','gracias','hola','los','las','del','con','sin','para','por','sobre','dónde','están','mucho',
        'también','algo','alguno','alguna','aquí','allí','ahora','después','antes','aunque','obrigado',
        // French
        'une','deux','trois','quelque','quoi','comme','dans','avec','pour','sur','sous','aussi','très','peu','bien',
        'comment','pourquoi','quand','merci','bonjour','aujourd','hui','déjà','alors','jamais','toujours',
        // German
        'kein','keine','keinen','aber','noch','schon','sehr','nur','viel','gut','schlecht','danke','bitte','wenn',
        'oder','wie','wo','warum','wann','wer','jedoch','außer','während','gegen',
        // Polish
        'jest','być','tak','nie','tylko','jeszcze','wszystko','nigdy','zawsze','kiedy','gdzie','dlaczego','jak',
        'jaki','jaka','dziękuję','proszę','dzień','dobry','przepraszam',
        // Dutch
        'het','maar','niet','wel','wat','wie','hoe','waarom','wanneer','waar','altijd','nooit','dank',
        // Swedish/Norwegian/Finnish/Hungarian/Romanian/etc.
        'och','inte','var','hur','när','varför','tack','hej','gjør','fortelle','hvor','hvordan','hvorfor','hvem',
        'onko','kun','jossa','että','jos','joka','jotka','tämä','tuo','niin','missä','miksi','miten','kiitos',
        'és','nem','igen','hogy','aki','ami','amely','olyan','csak','sehol','sosem','köszönöm',
        'sunt','este','sunt','este','dar','dacă','când','unde','cum','de','ce','foarte','mulțumesc'
    ].join('|') + ')\\b', 'i'
);
const EN_HINT = /\b(the|and|of|to|in|that|is|was|with|for|on|you|are|this|have|but|not|or|by|from|as|at|be|been|has|had|will|would|do|did|so|if|out|up|all|any|just|like|what|who|how|why|when|where|here|there|some|more|most|other|now|then|than|very|too|much|many|few|even|because|while|after|before)\b/i;

function looksNonEnglish(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    if (NON_LATIN.test(t)) return true;
    const accents = (t.match(ACCENTED) || []).length;
    if (accents > 2) return true;
    // Tally signals
    const nonEnHit = NON_EN.test(t);
    const enHit = EN_HINT.test(t);
    if (nonEnHit && !enHit) return true;
    // Edge case: a single accent + non-English word = drop
    if (accents > 0 && nonEnHit) return true;
    return false;
}

async function main() {
    const [[mega]] = await pool.execute(
        `SELECT id, name FROM cah_decks WHERE source = 'builtin' AND name LIKE '%Mega Pack%' LIMIT 1`
    );
    if (!mega) { console.error('No Mega Pack found.'); process.exit(1); }
    console.log(`Found Mega Pack: #${mega.id} (${mega.name})`);

    // White cards
    const [whites] = await pool.execute(`SELECT id, text FROM cah_white_cards WHERE deck_id = ?`, [mega.id]);
    console.log(`Scanning ${whites.length.toLocaleString()} white cards…`);
    const whiteToDelete = whites.filter(c => looksNonEnglish(c.text));
    console.log(`  → ${whiteToDelete.length} non-English white cards detected`);
    if (whiteToDelete.length > 0) {
        // Sample
        console.log('  Sample (first 5):');
        whiteToDelete.slice(0, 5).forEach(c => console.log(`    #${c.id}: ${c.text.slice(0, 80)}`));
    }

    // Black cards
    const [blacks] = await pool.execute(`SELECT id, text FROM cah_black_cards WHERE deck_id = ?`, [mega.id]);
    console.log(`Scanning ${blacks.length.toLocaleString()} black cards…`);
    const blackToDelete = blacks.filter(c => looksNonEnglish(c.text));
    console.log(`  → ${blackToDelete.length} non-English black cards detected`);
    if (blackToDelete.length > 0) {
        console.log('  Sample (first 5):');
        blackToDelete.slice(0, 5).forEach(c => console.log(`    #${c.id}: ${c.text.slice(0, 80)}`));
    }

    if (whiteToDelete.length === 0 && blackToDelete.length === 0) {
        console.log('Nothing to delete. Mega Pack is already clean by these heuristics.');
        await pool.end(); return;
    }

    // Bulk delete in chunks (MySQL packet size limit on IN lists with many params)
    const CHUNK = 1000;
    let wDel = 0, bDel = 0;
    for (let i = 0; i < whiteToDelete.length; i += CHUNK) {
        const ids = whiteToDelete.slice(i, i + CHUNK).map(c => c.id);
        const [r] = await pool.execute(
            `DELETE FROM cah_white_cards WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids
        );
        wDel += r.affectedRows;
    }
    for (let i = 0; i < blackToDelete.length; i += CHUNK) {
        const ids = blackToDelete.slice(i, i + CHUNK).map(c => c.id);
        const [r] = await pool.execute(
            `DELETE FROM cah_black_cards WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids
        );
        bDel += r.affectedRows;
    }

    console.log(`\n✅ Deleted ${wDel.toLocaleString()} white + ${bDel.toLocaleString()} black non-English cards`);
    const [[after]] = await pool.execute(
        `SELECT (SELECT COUNT(*) FROM cah_white_cards WHERE deck_id = ?) AS w,
                (SELECT COUNT(*) FROM cah_black_cards WHERE deck_id = ?) AS b`,
        [mega.id, mega.id]
    );
    console.log(`Mega Pack now: ${after.w.toLocaleString()} white · ${after.b.toLocaleString()} black`);
    await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
