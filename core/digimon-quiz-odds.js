/*
 * Odds of every /digimon today result, for the dashboard's Quiz odds page.
 *
 * For each quiz day in the window, every combination of answers (4^5 = 1,024) is scored with the real
 * scoreAnswers, and the result's best matches (bestMatches, the same list pickDigimon chooses from) share it
 * equally, because members are spread over them by a hash of their id. It assumes every answer is picked
 * equally often, which real players will not do exactly, so the page calls the numbers a guide.
 *
 * Pure (no Discord, DB or network) so a worker thread can run it: a year takes about 2.5 seconds, and bot and
 * dashboard share one process. The worker and the day-long cache live in dashboard/routes/api/features/digimon.js.
 */
import { POWER_LEVELS, questionsForDay, scoreAnswers, bestMatches, quizDay, weightsFor, QUESTION_BANK } from './digimon-quiz.js';

export const ODDS_DAYS = 365;

/** Rarity tiers of a quiz result by its chance per quiz. Checked in order; the first that fits wins. */
export const QUIZ_TIERS = [
    { name: 'Common',    min: 1 / 300,   band: '1 in 300 or better' },
    { name: 'Uncommon',  min: 1 / 3000,  band: '1 in 300 to 1 in 3,000' },
    { name: 'Rare',      min: 1 / 30000, band: '1 in 3,000 to 1 in 30,000' },
    { name: 'Legendary', min: Number.MIN_VALUE, band: 'Rarer than 1 in 30,000' },
    { name: 'Never',     min: 0,         band: 'Cannot come up' },
];
export const quizTier = p => QUIZ_TIERS.find(t => p >= t.min).name;

/**
 * Pure: the odds for `digimon` ([{ id, name, level, attributes, fields, types }]) over `days` quiz days from
 * `startMs`, with a server's question `bank` (buildBank). Returns
 * { takes, from, to, stageShare: { stage: share }, list: [{ id, name, stage, attribute, p, tier }] }.
 */
export function computeQuizOdds(digimon, { startMs = Date.now(), days = ODDS_DAYS, bank = QUESTION_BANK } = {}) {
    const weight = weightsFor(bank);
    // Same answers can give the same result; count each distinct result once and share it out at the end.
    const results = new Map();
    let takes = 0;
    for (let i = 0; i < days; i++) {
        const questions = questionsForDay(quizDay(startMs + i * 86400000), bank);
        const walk = (k, picked) => {
            if (k === questions.length) {
                const r = scoreAnswers(picked, weight);
                const key = `${r.level}|${r.attribute}|${r.field}|${r.family}`;
                const hit = results.get(key);
                if (hit) hit.n++; else results.set(key, { r, n: 1 });
                takes++;
                return;
            }
            for (const option of questions[k].options) walk(k + 1, [...picked, option]);
        };
        walk(0, []);
    }
    const share = new Map(), stageCount = {};
    for (const { r, n } of results.values()) {
        const ties = bestMatches(r, digimon);
        stageCount[r.level] = (stageCount[r.level] ?? 0) + n;
        for (const d of ties) share.set(d.id, (share.get(d.id) ?? 0) + n / ties.length);
    }
    const list = digimon
        .map(d => {
            const p = takes ? (share.get(d.id) ?? 0) / takes : 0;
            return { id: d.id, name: d.name, stage: d.level, attribute: d.attributes.join('/') || 'Unknown', p, tier: quizTier(p) };
        })
        .sort((a, b) => b.p - a.p || a.name.localeCompare(b.name));
    return {
        takes,
        from: quizDay(startMs),
        to: quizDay(startMs + (days - 1) * 86400000),
        stageShare: Object.fromEntries(POWER_LEVELS.map(s => [s, takes ? (stageCount[s] ?? 0) / takes : 0])),
        list,
    };
}
