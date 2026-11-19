import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyDecay, careAttribute, chooseEvolution, evolveBlockers, addXp,
    nameMatches, nextStage, HUNGER_MS, STRENGTH_MS, MISTAKES_PER_ABSENCE,
    stageReset, marketPayout, cannotMove, normaliseName, RARITY, rollRarity, rarityOfStage, STAGES, STARTERS, starterForm,
    TEAM_SIZE, DAY_MS, AGE_TICK_MS, lifespanMs, lifeOver, rebirthIvs, formsOf, previousForm, wornOutRevert, formsBelow,
    dnaBlockers, parseDnaPartners, cardKeywords, cardLevel, levelLabel, canBattle, dpOf, wildDp, battleLoser,
    runMatch, LEVEL_DP, SECURITY_SIZE, summariseCards,
} from '../core/digimon-logic.js';
import {
    QUESTION_BANK, questionsForDay, scoreAnswers, pickDigimon, quizDay, POWER_LEVELS, CATEGORIES, CRESTS, FAMILIES,
    familyOf, signatureMove, bestMatches, buildBank, validateQuestion, bankBalance, weightsFor,
} from '../core/digimon-quiz.js';
import { computeQuizOdds } from '../core/digimon-quiz-odds.js';

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const care = (over = {}) => ({ hunger: 4, strength: 4, care_mistakes: 0, hunger_at: T0, strength_at: T0, ...over });

test('spawn rarity tiers add up to 100% and each is one real stage', () => {
    assert.equal(RARITY.reduce((s, t) => s + Math.round(t.chance * 10), 0), 1000);
    assert.equal(new Set(RARITY.map(t => t.stage)).size, RARITY.length);
    for (const t of RARITY) assert.ok(STAGES.includes(t.stage), t.stage);
    assert.equal(rarityOfStage('Baby I'), null, 'babies never spawn');
    assert.equal(rarityOfStage('Ultimate').name, 'Legendary');
});

test('rollRarity hits each tier exactly on its share', () => {
    assert.equal(rollRarity(0).name, 'Common');
    assert.equal(rollRarity(0.7499).name, 'Common');
    assert.equal(rollRarity(0.75).name, 'Uncommon');
    assert.equal(rollRarity(0.9699).name, 'Uncommon');
    assert.equal(rollRarity(0.97).name, 'Rare');
    assert.equal(rollRarity(0.9949).name, 'Rare');
    assert.equal(rollRarity(0.995).name, 'Legendary');
    assert.equal(rollRarity(0.99999).name, 'Legendary');
    const seen = {};
    for (let i = 0; i < 100000; i++) seen[rollRarity(i / 100000).name] = (seen[rollRarity(i / 100000).name] ?? 0) + 1;
    assert.deepEqual(seen, { Common: 75000, Uncommon: 22000, Rare: 2500, Legendary: 500 });
});

test('starters follow their line to Child, then care takes over', () => {
    assert.ok(STARTERS.length <= 24, 'a select menu holds 25 options, one is Surprise me');
    assert.equal(new Set(STARTERS.map(s => s.key)).size, STARTERS.length);
    for (const s of STARTERS) {
        assert.equal(s.line.length, 3, s.key);
        assert.ok(s.key.length <= 32, 'fits user_digimon.starter');
    }
    assert.equal(starterForm('agumon', 'Baby II'), 'Koromon');
    assert.equal(starterForm('vmon', 'Child'), 'V-mon');
    assert.equal(starterForm('agumon', 'Adult'), null);
    assert.equal(starterForm(null, 'Child'), null);
    assert.equal(starterForm('nobody', 'Child'), null);
});

test('quiz odds add up to every quiz run and match what pickDigimon picks', () => {
    const fake = POWER_LEVELS.flatMap((level, i) => ['Vaccine', 'Data', 'Virus', 'Free'].map((a, j) => ({
        id: i * 10 + j, name: `${level} ${a}`, level, attributes: [a], fields: j % 2 ? ['Metal Empire'] : ['Nature Spirits'], types: [],
    })));
    const odds = computeQuizOdds(fake, { startMs: T0, days: 2 });
    assert.equal(odds.takes, 2 * 4 ** 5);
    assert.ok(Math.abs(odds.list.reduce((s, d) => s + d.p, 0) - 1) < 1e-9, 'every run lands on someone');
    assert.ok(Math.abs(Object.values(odds.stageShare).reduce((s, v) => s + v, 0) - 1) < 1e-9);
    for (const d of odds.list) assert.equal(d.tier === 'Never', d.p === 0, d.name);
    const result = { level: 'Child', attribute: 'Data', field: 'Metal Empire', family: null };
    const ties = bestMatches(result, fake);
    assert.ok(ties.includes(pickDigimon(result, fake, 'user', '2026-11-05')));
});

test('a server with no changes gets the built-in quiz, drawn exactly as before', () => {
    const bank = buildBank([]);
    assert.equal(bank.length, QUESTION_BANK.length);
    for (const day of ['2026-11-05', '2026-12-25', '2027-03-01']) {
        assert.deepEqual(questionsForDay(day, bank).map(q => q.q), questionsForDay(day).map(q => q.q), day);
    }
});

test('server question changes: edit, turn off, add, and never an empty quiz', () => {
    const own = { cat: 'battle', q: 'Pick a move.', options: [
        { label: 'Charge', a: 'Vaccine', f: null, t: null, c: 'courage', p: 3 }, { label: 'Wait', a: 'Data', f: null, t: null, c: null, p: 0 }] };
    const rows = [
        { id: 1, builtin_index: 0, cat: 'daily', q: 'Edited alarm question', options: JSON.stringify(QUESTION_BANK[0].options), enabled: 1 },
        { id: 2, builtin_index: 1, cat: 'daily', q: QUESTION_BANK[1].q, options: JSON.stringify(QUESTION_BANK[1].options), enabled: 0 },
        { id: 3, builtin_index: null, ...own, options: JSON.stringify(own.options), enabled: 1 },
    ];
    const bank = buildBank(rows);
    assert.equal(bank.length, QUESTION_BANK.length, 'one off, one added');
    assert.equal(bank.find(q => q.key === 0).q, 'Edited alarm question');
    assert.ok(!bank.some(q => q.key === 1), 'turned off');
    assert.ok(bank.some(q => q.key === 'c3'), 'own question');
    const allOff = QUESTION_BANK.map((q, i) => ({ id: i + 10, builtin_index: i, cat: q.cat, q: q.q, options: '[]', enabled: 0 }));
    assert.equal(buildBank(allOff).length, QUESTION_BANK.length, 'all off falls back to the built-in quiz');
    // Answers to a two-answer question still score.
    assert.ok(scoreAnswers(own.options, weightsFor(bank)).level);
});

test('validateQuestion explains what is wrong in plain words', () => {
    const good = { cat: 'daily', q: '  Pick one  ', options: [{ label: 'A', a: 'Data', p: 1 }, { label: 'B', a: 'Virus', f: '', t: 'dragon', c: 'hope', p: 3 }] };
    const ok = validateQuestion(good);
    assert.equal(ok.value.q, 'Pick one');
    assert.equal(ok.value.options[0].f, null);
    assert.match(validateQuestion({ ...good, cat: 'nope' }).error, /category/);
    assert.match(validateQuestion({ ...good, options: [good.options[0]] }).error, /2 to 4/);
    assert.match(validateQuestion({ ...good, options: [good.options[0], { ...good.options[1], label: 'x'.repeat(81) }] }).error, /80/);
    assert.match(validateQuestion({ ...good, options: [good.options[0], { ...good.options[1], p: 4 }] }).error, /power/);
    assert.match(validateQuestion({ ...good, options: [good.options[0], { ...good.options[1], label: 'a' }] }).error, /same text/);
    assert.match(validateQuestion({ ...good, options: [good.options[0], { ...good.options[1], c: 'pizza' }] }).error, /Crest/);
});

test('bankBalance: the built-in quiz has no warnings, and a gap is named', () => {
    assert.deepEqual(bankBalance(buildBank([])).warnings, []);
    const noLight = buildBank([]).map(q => ({ ...q, options: q.options.map(o => (o.c === 'light' ? { ...o, c: 'hope' } : o)) }));
    assert.ok(bankBalance(noLight).warnings.some(w => w.includes('Light')));
});

test('hunger and strength run down on their own clocks', () => {
    const c = applyDecay(care(), T0 + STRENGTH_MS * 1.5);
    assert.equal(c.hunger, 3, 'one hunger heart per 4 hours');
    assert.equal(c.strength, 3);
    assert.equal(applyDecay(care(), T0 + HUNGER_MS * 4 - 1).hunger, 1, 'full to starving takes 16 hours');
    assert.equal(c.care_mistakes, 0);
});

test('checking in often still lets a partner get hungry and weaker', () => {
    let c = care();
    for (let t = T0; t <= T0 + STRENGTH_MS * 3; t += 60 * 60 * 1000) c = applyDecay(c, t);
    assert.equal(c.strength, 1, 'hourly reads must not reset the strength clock');
    assert.equal(c.hunger, 1, 'hourly reads must not reset the hunger clock');
});

test('starving counts care mistakes, capped per absence', () => {
    const c = applyDecay(care({ hunger: 1 }), T0 + HUNGER_MS * 20);
    assert.equal(c.hunger, 0);
    assert.equal(c.care_mistakes, MISTAKES_PER_ABSENCE);
});

test('upbringing picks the attribute', () => {
    assert.equal(careAttribute({ care_mistakes: 0, trainings: 5, battles: 2 }), 'Vaccine');
    assert.equal(careAttribute({ care_mistakes: 1, trainings: 1, battles: 6 }), 'Data');
    assert.equal(careAttribute({ care_mistakes: 4, trainings: 9, battles: 0 }), 'Virus');
});

const forms = [
    { id: 10, name: 'Greymon', level: 'Adult', attributes: ['Vaccine'], fields: ["Dragon's Roar"] },
    { id: 11, name: 'Tyranomon', level: 'Adult', attributes: ['Data'], fields: ["Dragon's Roar"] },
    { id: 12, name: 'DarkTyranomon', level: 'Adult', attributes: ['Virus'], fields: ['Nightmare Soldiers'] },
    { id: 13, name: 'MetalGreymon', level: 'Perfect', attributes: ['Vaccine'], fields: ["Dragon's Roar"] },
];

test('care-based evolution follows the attribute and stays on the next stage', () => {
    const base = { id: 1, stage: 'Child', fields: ["Dragon's Roar"], trainings: 0, battles: 0 };
    assert.equal(chooseEvolution({ ...base, care_mistakes: 0, trainings: 4 }, forms).name, 'Greymon');
    assert.equal(chooseEvolution({ ...base, care_mistakes: 1, battles: 5 }, forms).name, 'Tyranomon');
    assert.equal(chooseEvolution({ ...base, care_mistakes: 5 }, forms).name, 'DarkTyranomon');
    assert.equal(chooseEvolution({ ...base, stage: 'Ultimate' }, forms), null);
});

test('the same care always gives the same form', () => {
    const twins = [
        { id: 20, name: 'A', level: 'Adult', attributes: ['Data'], fields: [] },
        { id: 21, name: 'B', level: 'Adult', attributes: ['Data'], fields: [] },
    ];
    const p = { id: 7, stage: 'Child', fields: [], care_mistakes: 2, trainings: 0, battles: 0 };
    const first = chooseEvolution(p, twins).name;
    for (let i = 0; i < 5; i++) assert.equal(chooseEvolution(p, [...twins].reverse()).name, first);
});

test('evolution gates', () => {
    assert.deepEqual(evolveBlockers({ stage: 'Child', level: 15, battles: 0, wins: 0, hunger: 2 }), []);
    assert.equal(evolveBlockers({ stage: 'Adult', level: 30, battles: 2, wins: 0, hunger: 2 }).length, 1);
    assert.equal(evolveBlockers({ stage: 'Ultimate', level: 99, battles: 0, wins: 0, hunger: 2 }).length, 1);
    assert.equal(nextStage('Baby I'), 'Baby II');
    assert.equal(nextStage('Armor'), null);
});

test('xp rolls over levels', () => {
    assert.deepEqual(addXp(1, 90, 230), { level: 4, xp: 20, leveled: true });
});

test('name guesses ignore case, punctuation and the bracketed variant', () => {
    assert.ok(nameMatches('agumon', 'Agumon (Black)'));
    assert.ok(nameMatches('Agumon Black', 'Agumon (Black)'));
    assert.ok(nameMatches('wargreymon', 'WarGreymon'));
    assert.ok(!nameMatches('greymon', 'WarGreymon'));
    assert.ok(!nameMatches('', 'Agumon'));
});

test('quiz: same five questions for everyone on a day, different days differ', () => {
    const a = questionsForDay('2026-11-05').map(q => q.index);
    assert.equal(a.length, 5);
    assert.equal(new Set(a).size, 5);
    assert.deepEqual(questionsForDay('2026-11-05').map(q => q.index), a);
    const days = new Set(['2026-11-06', '2026-11-07', '2026-11-08'].map(d => questionsForDay(d).map(q => q.index).join()));
    assert.ok(days.size > 1);
    for (let d = 0; d < 60; d++) {
        const qs = questionsForDay(new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10));
        assert.equal(new Set(qs.map(q => q.cat)).size, 5, 'five different categories every day');
    }
    assert.equal(quizDay(T0), '2026-11-05');
});

test('quiz bank is well formed for Discord buttons', () => {
    for (const q of QUESTION_BANK) {
        assert.equal(q.options.length, 4, q.q);
        for (const o of q.options) {
            assert.ok(o.label.length <= 80, o.label);
            assert.ok(['Vaccine', 'Data', 'Virus', 'Free'].includes(o.a));
            assert.ok(o.p >= 0 && o.p <= 3);
            assert.ok(FAMILIES.some(([k]) => k === o.t), `${q.q}: unknown family ${o.t}`);
            assert.ok(o.c in CRESTS, `${q.q}: unknown crest ${o.c}`);
        }
    }
});

test('quiz scoring and a stable pick that always finds someone', () => {
    const r = scoreAnswers([
        { a: 'Vaccine', f: 'X', t: 'dragon', c: 'courage', p: 3 }, { a: 'Vaccine', f: 'X', t: 'dragon', c: 'courage', p: 3 },
        { a: 'Data', f: 'Y', t: 'machine', c: 'knowledge', p: 2 }]);
    assert.deepEqual(r, { attribute: 'Vaccine', field: 'X', family: 'dragon', crest: 'courage', level: 'Ultimate' });
    const dex = [
        { id: 1, name: 'A', level: 'Ultimate', attributes: ['Vaccine'], fields: ['X'], types: ['Cyborg'] },
        { id: 2, name: 'B', level: 'Ultimate', attributes: ['Vaccine'], fields: ['X'], types: ['Dragon Man'] },
        { id: 3, name: 'C', level: 'Child', attributes: ['Virus'], fields: ['Z'], types: [] },
    ];
    assert.equal(pickDigimon(r, dex, 'u1', '2026-11-05').id, 2, 'family breaks the tie: the dragon');
    for (let i = 0; i < 5; i++) assert.equal(pickDigimon(r, [...dex].reverse(), 'u1', '2026-11-05').id, 2);
    assert.equal(pickDigimon({ attribute: 'Data', field: 'Q', level: 'Adult' }, dex, 'u1', 'd').id > 0, true, 'always someone');
    assert.equal(pickDigimon({ attribute: 'Virus', field: 'Z', level: 'Child' }, dex, 'u1', 'd').id, 3, 'stays on the scored stage');
});

test('care is per stage: evolving clears mistakes and trainings, and stage battles drive the lean', () => {
    assert.deepEqual(stageReset(), { care_mistakes: 0, trainings: 0, stage_battles: 0 });
    // Lots of lifetime battles no longer outweigh training done at this stage.
    assert.equal(careAttribute({ care_mistakes: 0, trainings: 3, stage_battles: 1, battles: 40 }), 'Vaccine');
    assert.equal(careAttribute({ care_mistakes: 0, trainings: 1, stage_battles: 5, battles: 5 }), 'Data');
});

test('market payout takes the fee, rounded down and capped', () => {
    assert.deepEqual(marketPayout(1000, 5), { fee: 50, payout: 950 });
    assert.deepEqual(marketPayout(19, 5), { fee: 0, payout: 19 });
    assert.deepEqual(marketPayout(100, 0), { fee: 0, payout: 100 });
    assert.deepEqual(marketPayout(100, 90), { fee: 50, payout: 50 });
});

test('a partner, a listed Digimon or one owned by someone else cannot be moved', () => {
    const own = { user_id: 'u1', is_partner: 0, locked: null };
    assert.equal(cannotMove(own, 'u1'), null);
    assert.equal(cannotMove(own, 'u2'), 'not-owned');
    assert.equal(cannotMove({ ...own, is_partner: 1 }, 'u1'), 'partner');
    assert.equal(cannotMove({ ...own, locked: 'market' }, 'u1'), 'locked');
    assert.equal(cannotMove({ ...own, locked: 'market' }, 'u1', { allowListed: true }), null, 'the market itself may sell a listed one');
    assert.equal(cannotMove(null, 'u1'), 'not-owned');
});

test('quiz bank: 72 questions, 12 per category, every field, family and crest reachable', () => {
    const FIELDS = new Set(['Virus Busters', 'Nature Spirits', 'Metal Empire', 'Nightmare Soldiers', 'Jungle Troopers', 'Deep Savers', 'Wind Guardians', 'Dark Area', "Dragon's Roar"]);
    assert.equal(QUESTION_BANK.length, 72);
    assert.equal(new Set(QUESTION_BANK.map(q => q.q)).size, 72, 'no repeated question');
    for (const cat of Object.keys(CATEGORIES)) assert.equal(QUESTION_BANK.filter(q => q.cat === cat).length, 12, cat);
    const options = QUESTION_BANK.flatMap(q => q.options);
    for (const o of options) assert.ok(FIELDS.has(o.f), `unknown field ${o.f}`);
    for (const f of FIELDS) assert.ok(options.filter(o => o.f === f).length >= 10, `field ${f} is rarely reachable`);
    for (const [fam] of FAMILIES) assert.ok(options.filter(o => o.t === fam).length >= 10, `family ${fam} is rarely reachable`);
    for (const c of Object.keys(CRESTS)) assert.ok(options.filter(o => o.c === c).length >= 10, `crest ${c} is rarely reachable`);
});

test('families come from the Digimon types, first match wins', () => {
    assert.equal(familyOf(['Dragon Man']), 'dragon');
    assert.equal(familyOf(['Holy Beast']), 'holy');
    assert.equal(familyOf(['Demon Beast']), 'dark');
    assert.equal(familyOf(['Beast Man']), 'warrior');
    assert.equal(familyOf(['Aquatic Beast Man']), 'aquatic');
    assert.equal(familyOf(['Cyborg']), 'machine');
    assert.equal(familyOf(['Insect']), 'insect');
    assert.equal(familyOf(['Mutation']), 'mystic');
    assert.equal(familyOf([]), null);
    assert.equal(signatureMove({ skills: ['A', 'B', 'C'] }, 'u', 'd'), signatureMove({ skills: ['A', 'B', 'C'] }, 'u', 'd'));
    assert.equal(signatureMove({ skills: [] }, 'u', 'd'), null);
});

// Seeded so the checks are repeatable.
function seeded(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }
test('quiz power reaches all five stages', () => {
    const rng = seeded(3);
    const seen = {};
    for (let d = 0; d < 120; d++) {
        const qs = questionsForDay(new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10));
        for (let k = 0; k < 50; k++) {
            const lv = scoreAnswers(qs.map(qq => qq.options[Math.floor(rng() * 4)])).level;
            seen[lv] = (seen[lv] ?? 0) + 1;
        }
    }
    for (const lv of POWER_LEVELS) assert.ok((seen[lv] ?? 0) / 6000 > 0.08, `${lv}: ${seen[lv] ?? 0} of 6000`);
});

test('quiz results spread across every family and crest, none dominating', () => {
    const rng = seeded(5);
    const fam = {}, crest = {};
    let n = 0;
    for (let d = 0; d < 365; d++) {
        const qs = questionsForDay(new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10));
        for (let k = 0; k < 20; k++) {
            const r = scoreAnswers(qs.map(q => q.options[Math.floor(rng() * 4)]));
            n++;
            fam[r.family] = (fam[r.family] ?? 0) + 1;
            crest[r.crest] = (crest[r.crest] ?? 0) + 1;
        }
    }
    for (const [k] of FAMILIES) assert.ok((fam[k] ?? 0) / n > 0.025 && (fam[k] ?? 0) / n < 0.2, `family ${k}: ${((fam[k] ?? 0) / n * 100).toFixed(1)}%`);
    for (const k of Object.keys(CRESTS)) assert.ok((crest[k] ?? 0) / n > 0.025 && (crest[k] ?? 0) / n < 0.2, `crest ${k}: ${((crest[k] ?? 0) / n * 100).toFixed(1)}%`);
});

// ── Teams, lifespans, de-digivolving and DNA (2026-11-05) ──────────────────────────────────────────────────

test('age moves in whole hours while on the team and keeps the unfinished part', () => {
    const c = applyDecay({ ...care(), age_ms: 0, aged_at: T0 }, T0 + 2.5 * AGE_TICK_MS);
    assert.equal(c.age_ms, 2 * AGE_TICK_MS);
    assert.equal(c.aged_at, T0 + 2 * AGE_TICK_MS);
    const none = applyDecay({ ...care(), age_ms: 5 }, T0);
    assert.equal(none.age_ms, 5, 'no aged_at: starts its clock now, ages nothing');
});

test('starving counts toward lifetime mistakes as well as the stage ones', () => {
    const c = applyDecay({ ...care({ hunger: 0, care_mistakes: 1 }), total_mistakes: 4 }, T0 + 2 * HUNGER_MS);
    assert.equal(c.care_mistakes, 3);
    assert.equal(c.total_mistakes, 6);
});

test('lifespan: full span, a day off per mistake, never below a third, off at 0', () => {
    assert.equal(lifespanMs({ total_mistakes: 0 }, 30), 30 * DAY_MS);
    assert.equal(lifespanMs({ total_mistakes: 5 }, 30), 25 * DAY_MS);
    assert.equal(lifespanMs({ total_mistakes: 99 }, 30), 10 * DAY_MS);
    assert.equal(lifespanMs({ total_mistakes: 0 }, 0), Infinity);
    assert.equal(lifeOver({ age_ms: 30 * DAY_MS, total_mistakes: 0 }, 30), true);
    assert.equal(lifeOver({ age_ms: 29 * DAY_MS, total_mistakes: 0 }, 30), false);
    assert.equal(lifeOver({ age_ms: 999 * DAY_MS }, 0), false);
});

test('rebirth inherits a little: +2 per spread point, capped at 15', () => {
    assert.deepEqual(rebirthIvs({ iv_hp: 0, iv_atk: 14, iv_def: 15, iv_spd: 7 }), { iv_hp: 2, iv_atk: 15, iv_def: 15, iv_spd: 9 });
});

test('forms: older rows know their current form; previousForm steps back to a form it really was', () => {
    assert.deepEqual(formsOf({ forms: null, stage: 'Adult', digimon_id: 7 }), { Adult: 7 });
    assert.deepEqual(formsOf({ forms: '{"Child":3}', stage: 'Adult', digimon_id: 7 }), { Child: 3, Adult: 7 });
    const row = { forms: { 'Baby I': 1, Child: 3, Adult: 7 }, stage: 'Adult', digimon_id: 7 };
    assert.deepEqual(previousForm(row), { stage: 'Child', id: 3 });
    assert.equal(previousForm({ forms: { Adult: 7 }, stage: 'Adult', digimon_id: 7 }), null, 'a tamed Champion has nothing below');
    assert.deepEqual(formsBelow({ Child: 3, Adult: 7, Perfect: 9 }, 'Perfect'), { Child: 3, Adult: 7 });
});

test('worn out: Champion and up fall back to their Rookie; Rookies and tamed Champions hold', () => {
    const champ = { stage: 'Adult', digimon_id: 7, forms: { Child: 3, Adult: 7 }, hunger: 2, strength: 0 };
    assert.deepEqual(wornOutRevert(champ), { stage: 'Child', id: 3 });
    assert.deepEqual(wornOutRevert({ ...champ, strength: 2, hunger: 0 }), { stage: 'Child', id: 3 });
    assert.equal(wornOutRevert({ ...champ, strength: 1 }), null, 'still has strength');
    assert.equal(wornOutRevert({ ...champ, stage: 'Child', digimon_id: 3 }), null, 'a Rookie never reverts');
    assert.equal(wornOutRevert({ ...champ, forms: { Adult: 7 } }), null, 'never was a Rookie');
});

test('DNA blockers: same stage, Champion or Ultimate, levels, fed, rested, not already fused', () => {
    const d = (over = {}) => ({ id: 1, name: 'XV-mon', stage: 'Adult', level: 30, hunger: 3, strength: 2, ...over });
    assert.deepEqual(dnaBlockers(d(), d({ id: 2, name: 'Stingmon' })), []);
    assert.equal(dnaBlockers(d(), d()).length, 1, 'the same Digimon twice');
    assert.match(dnaBlockers(d(), d({ id: 2, stage: 'Perfect' }))[0], /same stage/);
    assert.match(dnaBlockers(d({ stage: 'Child' }), d({ id: 2, stage: 'Child' }))[0], /Champions/);
    assert.match(dnaBlockers(d(), d({ id: 2, level: 12 })).join(), /level 30/);
    assert.match(dnaBlockers(d(), d({ id: 2, dna_partner_id: 9 })).join(), /already DNA-fused/);
    assert.match(dnaBlockers(d(), d({ id: 2, strength: 0 })).join(), /no strength/);
});

test('a DNA-fused Digimon (either half) cannot be traded or sold', () => {
    assert.equal(cannotMove({ user_id: 'u', is_partner: 0, dna_partner_id: 5 }, 'u'), 'dna');
    assert.equal(cannotMove({ user_id: 'u', is_partner: 0, locked: 'dna' }, 'u', { allowListed: true }), 'dna');
    assert.equal(cannotMove({ user_id: 'u', is_partner: 1, dna_partner_id: 5 }, 'u'), 'partner');
});

test('parseDnaPartners reads digi-api conditions (real ones from Paildramon)', () => {
    assert.deepEqual(parseDnaPartners('with V-dramon or V-dramon Black'), ['vdramon', 'vdramonblack']);
    assert.deepEqual(parseDnaPartners('with or without Kabuterimon'), ['kabuterimon']);
    assert.deepEqual(parseDnaPartners('with Greymon, Greymon Black, Greymon X-Antibody, or Greymon 2010 Anime Version'),
        ['greymon', 'greymonblack', 'greymonxantibody', 'greymon2010animeversion']);
    assert.deepEqual(parseDnaPartners('with a Data Attribute Adult Digimon from the Vital Bracelet Digital Monster'), []);
    assert.deepEqual(parseDnaPartners('with Shadramon or a Virus Attribute Adult Digimon from the Vital Bracelet Digital Monster'), ['shadramon']);
    assert.deepEqual(parseDnaPartners('Warp Evolution'), []);
    assert.deepEqual(parseDnaPartners(''), []);
    assert.ok(parseDnaPartners('with or without XV-mon, or XV-mon and V-mon, or V-dramon').includes('vmon'));
    // The data names variants with brackets; the conditions without. Both normalise the same.
    assert.equal(parseDnaPartners('with Garurumon X-Antibody')[0], normaliseName('Garurumon (X-Antibody)'));
});

// ── Digimon Card Game rules (2026-11-06) ──────────────────────────────────────────────────────────────────

test('card keywords: only ones a card has outright, and only a positive Security A.', () => {
    assert.deepEqual(cardKeywords('＜Blocker＞ (This Digimon can block in the blocker timing.)'), ['Blocker']);
    assert.deepEqual(cardKeywords('＜Security A. +1＞ (This Digimon checks 1 additional security card.)\n＜Jamming＞ (This Digimon can\'t be deleted in battles against Security Digimon.)'), ['Security A.', 'Jamming']);
    assert.deepEqual(cardKeywords('[Opponent\'s Turn] While you have a [Mother D-Reaper] in play, this Digimon gains ＜Blocker＞.'), []);
    assert.deepEqual(cardKeywords('＜Security A. -1＞ (This Digimon checks 1 fewer security card.)'), []);
    assert.deepEqual(cardKeywords('[When Digivolving] ＜Draw 1＞.'), [], 'keywords outside the list are ignored');
    assert.deepEqual(cardKeywords(null), []);
});

test('levels: card level from the card, else the stage; babies never battle', () => {
    assert.equal(cardLevel({ stage: 'Adult' }), 4);
    assert.equal(cardLevel({ stage: 'Ultimate', card_level: 7 }), 7);
    assert.equal(levelLabel({ stage: 'Perfect' }), 'Lv.5 Ultimate');
    assert.equal(canBattle({ stage: 'Baby II' }), false);
    assert.equal(canBattle({ stage: 'Child' }), true);
    assert.equal(dpOf({ stage: 'Baby I', level: 5 }), 0);
});

test('DP: card DP, else the level usual; raising adds a little and stays a multiple of 100', () => {
    const rookie = { stage: 'Child', level: 10, strength: 2, iv_hp: 5, iv_atk: 5, iv_def: 5, iv_spd: 5 };
    assert.equal(dpOf({ ...rookie, card_dp: 3000 }), 3900); // 3000 + 200 + 500 + 200
    assert.equal(dpOf(rookie), LEVEL_DP[3] + 900);
    const maxed = dpOf({ stage: 'Child', level: 30, strength: 4, iv_hp: 15, iv_atk: 15, iv_def: 15, iv_spd: 15 });
    assert.ok(maxed < LEVEL_DP[4] + 500, `a raised Rookie (${maxed}) does not outclass a fresh Champion by much`);
    for (const lvl of [1, 7, 33]) assert.equal(dpOf({ ...rookie, level: lvl }) % 100, 0);
});

test('wild DP uses a real printing, else the card DP, else the level usual', () => {
    assert.equal(wildDp({ card_dps: [3000, 4000, 5000] }, 0), 3000);
    assert.equal(wildDp({ card_dps: [3000, 4000, 5000] }, 0.99), 5000);
    assert.equal(wildDp({ card_dps: [], card_dp: 6000, stage: 'Adult' }), 6000);
    assert.equal(wildDp({ stage: 'Perfect' }), LEVEL_DP[5]);
});

test('battles: higher DP wins, a tie loses for both (rule 14-2)', () => {
    assert.equal(battleLoser(5000, 4000), 'b');
    assert.equal(battleLoser(3000, 4000), 'a');
    assert.equal(battleLoser(4000, 4000), 'both');
});

const side = (name, partners, security) => ({
    name,
    partners: partners.map((p, i) => ({ id: i + 1, keywords: [], ...p })),
    security: security.map(dp => ({ name: `S${dp}`, dp })),
});
const firstA = () => 0.1, firstB = () => 0.9;

test('match: a strong partner breaks the security stack and wins with a direct attack', () => {
    const r = runMatch(side('Ann', [{ name: 'Greymon', dp: 6000 }], [3000, 3000, 3000]), side('Bo', [{ name: 'Agumon', dp: 2000 }], [2000, 2000, 2000]), firstA);
    assert.equal(r.winner, 'a');
    assert.match(r.log.at(-1), /no security left/);
});

test('match: a Security Digimon with as much DP deletes the attacker and is not deleted itself', () => {
    const r = runMatch(side('Ann', [{ name: 'Agumon', dp: 3000 }], [1000]), side('Bo', [], [3000, 9000, 9000]), firstA);
    assert.match(r.log[0], /deletes it/);
    assert.equal(r.survivors.a.length, 0);
});

test('match: Jamming survives security, Security A. checks two cards', () => {
    const jam = runMatch(side('Ann', [{ name: 'Gabu', dp: 1000, keywords: ['Jamming'] }], [1000]), side('Bo', [], [5000, 5000, 5000]), firstA, 1);
    assert.match(jam.log[0], /Jamming keeps it safe/);
    assert.equal(jam.survivors.a.length, 1);
    const sa = runMatch(side('Ann', [{ name: 'Leo', dp: 9000, keywords: ['Security A.'] }], [1000]), side('Bo', [], [1000, 1000, 1000]), firstA, 1);
    assert.equal(sa.log.filter(l => /checks security/.test(l)).length, 2);
});

test('match: a Blocker blocks an attacker it can beat, and Retaliation takes the winner along', () => {
    const blocked = runMatch(side('Ann', [{ name: 'Agu', dp: 2000 }], [1000]),
        side('Bo', [{ name: 'Wall', dp: 4000, keywords: ['Blocker'] }], [1000]), firstA, 1);
    assert.match(blocked.log[0], /Wall blocks/);
    assert.equal(blocked.survivors.a.length, 0);
    const ret = runMatch(side('Ann', [{ name: 'Agu', dp: 2000, keywords: ['Retaliation'] }], [1000]),
        side('Bo', [{ name: 'Wall', dp: 4000, keywords: ['Blocker'] }], [1000]), firstA, 1);
    assert.equal(ret.survivors.b.length, 0, 'Retaliation deleted the blocker');
});

test('match: a Blocker stays home to guard, and a suspended attacker cannot block on the next turn', () => {
    const r = runMatch(side('Ann', [{ name: 'Guard', dp: 5000, keywords: ['Blocker'] }, { name: 'Hit', dp: 5000 }], [1000, 1000, 1000]),
        side('Bo', [{ name: 'Foe', dp: 3000 }], [1000, 1000, 1000]), firstA, 2);
    assert.ok(!r.log.some(l => /^Guard checks/.test(l)), 'the guard did not attack');
    assert.ok(r.log.some(l => /Foe attacks; Guard blocks/.test(l)));
});

test('match: whoever goes first is random but fair, and a time-out goes to more security', () => {
    const even = () => runMatch(side('Ann', [{ name: 'A', dp: 3000 }], [1000]), side('Bo', [{ name: 'B', dp: 3000 }], [1000]), firstB, 1);
    assert.equal(even().first, 'b');
    const t = runMatch(side('Ann', [], [1000, 1000]), side('Bo', [], [1000]), firstA, 2);
    assert.equal(t.winner, 'a');
    assert.equal(SECURITY_SIZE, 3);
});

test('Security A. survives the full stop inside its name, followed by more text', () => {
    assert.deepEqual(cardKeywords('＜Security A. +1＞ (This Digimon checks 1 additional security card.) [When Digivolving] ＜Draw 1＞.'), ['Security A.']);
    assert.deepEqual(cardKeywords('[Your Turn] This Digimon gets +1000 DP. ＜Piercing＞ (When this Digimon attacks and deletes…)'), ['Piercing']);
});

test('summariseCards: common DP (higher on a tie), and keywords only when half the printings agree', () => {
    const agumon = [
        ...Array(8).fill({ dp: 2000, level: 3, color: 'Red', main_effect: '[On Play] Reveal the top 5 cards.' }),
        { dp: 1000, level: 3, color: 'Black', main_effect: '＜Blocker＞ (This Digimon can block.)' },
        { dp: 1000, level: 3, color: 'Black', main_effect: '' },
        { dp: 4000, level: 3, color: 'Red', main_effect: '', source_effect: '＜Retaliation＞ (When this Digimon is deleted…)' },
    ];
    const s = summariseCards(agumon);
    assert.equal(s.dp, 2000);
    assert.equal(s.color, 'Red');
    assert.equal(s.level, 3);
    assert.deepEqual(s.keywords, [], 'one Blocker printing of eleven does not make Agumon a Blocker');
    assert.deepEqual(s.inherited, []);
    assert.deepEqual(s.dps, [1000, 2000, 4000]);
    assert.equal(summariseCards([{ dp: 5000 }, { dp: 6000 }]).dp, 6000, 'tie goes to the higher DP');
    assert.deepEqual(summariseCards([{ dp: 5000, main_effect: '＜Blocker＞ (x)' }, { dp: 5000 }]).keywords, ['Blocker'], 'half is enough');
});
