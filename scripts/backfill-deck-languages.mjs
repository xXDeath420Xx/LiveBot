#!/usr/bin/env node
/**
 * Backfill language column for every cah_decks row.
 *
 * Strategy:
 *  1. Many Decks: parse from description text ("Many Decks · en-US · …")
 *  2. CrCast: stopword heuristic — sample 30 white cards, count tokens matching
 *     English common-word list. If ≥30% match → "en", else look for clear
 *     non-English markers (accented chars, common non-English stopwords).
 *  3. builtin/custom: assume "en" unless they have clear non-English text.
 *
 * The heuristic is deliberately conservative. Cards that mix English+other
 * (the realistic case for community packs) lean English. Pure-Italian/Polish/etc
 * packs miss the English threshold easily because their cards have NO English
 * stopwords at all.
 */
import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';

const EN_STOPWORDS = new Set([
    'the','a','an','and','or','but','if','of','to','in','on','at','by','for','with','about','from',
    'is','are','was','were','be','been','being','have','has','had','do','does','did','will','would',
    'could','should','may','might','must','shall','can','this','that','these','those','i','you',
    'he','she','it','we','they','my','your','his','her','its','our','their','me','him','us','them',
    'what','which','who','how','when','where','why','all','any','some','no','not','only','own','so',
    'than','too','very','just','also','as','up','down','out','over','under','again','more','most',
    'about','into','through','during','before','after','above','below','between','because','while'
]);

// Markers that strongly suggest a non-English language
const NON_EN_MARKERS = [
    { lang: 'it', regex: /\b(che|della|degli|della|gli|del|nella|sulla|però|cosa|sono|questo|questa|quello|quella|tutto|tutta|niente|mai|sempre|adesso|quando|come|dove|perché|grazie|prego)\b/i },
    { lang: 'es', regex: /\b(que|los|las|del|por|con|para|sin|sobre|esta|este|estos|estas|todo|nada|siempre|nunca|cuando|cómo|dónde|por qué|gracias|hola)\b/i },
    { lang: 'fr', regex: /\b(le|la|les|des|du|de|au|aux|une|un|qui|que|quoi|où|quand|pourquoi|comment|sans|avec|chez|sur|sous|dans|merci|bonjour)\b/i },
    { lang: 'de', regex: /\b(der|die|das|den|dem|des|ein|eine|einen|einem|einer|und|oder|aber|wenn|als|für|mit|von|zu|aus|bei|nach|über|unter|durch|gegen|danke)\b/i },
    { lang: 'pl', regex: /\b(jest|są|byli|być|który|która|które|nie|tak|tylko|już|jeszcze|wszystko|nic|kiedy|gdzie|dlaczego|jak|dziękuję)\b/i },
    { lang: 'pt', regex: /\b(que|não|com|para|por|os|as|do|da|dos|das|um|uma|isso|isto|aquilo|quando|onde|porque|como|obrigado|olá)\b/i },
    { lang: 'nl', regex: /\b(het|de|een|en|of|maar|ook|niet|wel|naar|met|voor|over|onder|tegen|tussen|altijd|nooit|wanneer|waar|waarom|hoe|dank)\b/i },
    { lang: 'sv', regex: /\b(och|eller|men|det|den|de|den|att|som|inte|jag|du|han|hon|vi|ni|tack|hej)\b/i },
    { lang: 'fi', regex: /\b(ja|tai|mutta|että|jos|joka|jotka|tämä|tuo|tällä|tällöin|niin|kun|missä|miksi|miten|kiitos)\b/i },
    { lang: 'hu', regex: /\b(és|vagy|de|hogy|aki|amely|ez|az|csak|már|még|mindig|soha|mikor|hol|miért|hogyan|köszönöm)\b/i }
];

function detectLanguage(sampleTexts) {
    const blob = sampleTexts.join(' ').toLowerCase();
    if (!blob.trim()) return null;

    // Non-EN markers first (more decisive than EN stopwords)
    let bestNonEn = null, bestNonEnHits = 0;
    for (const m of NON_EN_MARKERS) {
        const hits = (blob.match(new RegExp(m.regex.source, 'gi')) || []).length;
        if (hits > bestNonEnHits) { bestNonEnHits = hits; bestNonEn = m.lang; }
    }

    // EN stopword count
    const tokens = blob.match(/\b[a-z']+\b/gi) || [];
    if (tokens.length === 0) return bestNonEn;
    let enHits = 0;
    for (const t of tokens) if (EN_STOPWORDS.has(t.toLowerCase())) enHits++;
    const enRatio = enHits / tokens.length;

    // Decision: if a non-EN marker has 3+ hits AND EN ratio < 20%, it's non-EN.
    // Otherwise default to EN if there's any English signal at all.
    if (bestNonEn && bestNonEnHits >= 3 && enRatio < 0.2) return bestNonEn;
    if (enRatio >= 0.05) return 'en';
    return bestNonEn || 'und';   // und = undetermined
}

async function backfill() {
    const [decks] = await pool.execute(`SELECT id, source, name, description FROM cah_decks WHERE language IS NULL`);
    console.log(`Backfilling ${decks.length} decks…`);
    let counts = { en: 0, other: 0, und: 0 };

    for (const d of decks) {
        let lang = null;
        // Phase 1: try description parse (Many Decks stores it)
        if (d.source === 'manydecks' && d.description) {
            const m = d.description.match(/\b(en[-_][A-Za-z]{2}|en|es[-_][A-Za-z]{2}|es|it[-_][A-Za-z]{2}|it|fr[-_][A-Za-z]{2}|fr|de[-_][A-Za-z]{2}|de|pl[-_][A-Za-z]{2}|pl|pt[-_][A-Za-z]{2}|pt|nl|sv|fi|hu|ro|cs|ru|zh|ja|ko)\b/i);
            if (m) lang = m[1].toLowerCase().split(/[-_]/)[0];
        }
        if (d.source === 'builtin') lang = 'en';

        // Phase 2: heuristic on actual card text
        if (!lang) {
            const [sample] = await pool.execute(
                `(SELECT text FROM cah_white_cards WHERE deck_id = ? LIMIT 20)
                 UNION ALL
                 (SELECT text FROM cah_black_cards WHERE deck_id = ? LIMIT 10)`,
                [d.id, d.id]
            );
            lang = detectLanguage(sample.map(r => r.text));
        }

        if (!lang) lang = 'und';
        await pool.execute(`UPDATE cah_decks SET language = ? WHERE id = ?`, [lang, d.id]);
        if (lang === 'en') counts.en++;
        else if (lang === 'und') counts.und++;
        else counts.other++;
    }

    console.log('\nBackfill complete:');
    console.log(`  English: ${counts.en}`);
    console.log(`  Other languages: ${counts.other}`);
    console.log(`  Undetermined: ${counts.und}`);
    const [byLang] = await pool.execute(`SELECT language, COUNT(*) as n FROM cah_decks GROUP BY language ORDER BY n DESC LIMIT 20`);
    console.log('\nTop languages:');
    byLang.forEach(r => console.log(`  ${r.language}: ${r.n}`));
}

backfill().catch(console.error).finally(() => pool.end());
