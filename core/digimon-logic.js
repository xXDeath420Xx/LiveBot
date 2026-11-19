/*
 * Digimon game rules — the pure parts (no Discord, DB or network; unit-tested in tests/digimon-logic.test.js).
 * The live side is commands/games/digimon.js.
 *
 *   stages      Baby I → Baby II → Child → Adult → Perfect → Ultimate, the main line of the V-Pets. Armor,
 *               Hybrid and Unknown are real levels in the data but sit outside that line, so nobody raises
 *               into them and they never spawn.
 *   rarity      wild spawns are Common (Child), Uncommon (Adult), Rare (Perfect) or Legendary (Ultimate).
 *   team        a tamer raises up to TEAM_SIZE partners at once, as in Digimon World and Digimon Story; the
 *               rest wait in the DigiBank, where nothing decays and nobody ages.
 *   care        hunger and strength of every team partner run down while nobody looks, and time spent
 *               starving counts as care mistakes. Decay is worked out from timestamps when a partner is next
 *               read, so there is no timer per Digimon.
 *   lifespan    as on the V-Pets, a partner ages while on the team. When its life is over it returns to a
 *               Digi-Egg of its own line and starts again as the next generation, a little stronger. Care
 *               mistakes over its whole life shorten it.
 *   forms       every form a Digimon reached is remembered. Champion and up de-digivolve to their Rookie
 *               form when worn out (no strength left, or starving), as in the anime, and digivolve straight
 *               back into the forms they already reached once rested and fed.
 *   DNA         two team partners at the same stage fuse into the form the Digimon data names for that pair
 *               (XV-mon + Stingmon → Paildramon; digimon_dna, from digi-api's evolution conditions), and split
 *               apart again when it de-digivolves below that.
 *   evolution   Digimon branch: Agumon has dozens of next forms. How it was raised picks the branch.
 *               Few mistakes and more training than fighting lean Vaccine, a balanced life leans Data,
 *               neglect leans Virus. Forms sharing a field with the current one rank higher, and the
 *               last tie goes to a hash of the Digimon and the candidate, so the same care always gives
 *               the same result and retrying cannot reroll it. Care is counted per stage, as on the
 *               V-Pets: evolving clears care mistakes, trainings and stage battles (stageReset), so a bad
 *               week as a Child does not decide its Mega. Total battles and wins carry over for the gates.
 *   battle      the Digimon Card Game's rules: DP, security stacks and card keywords ("Battles" below).
 */

export const STAGES = ['Baby I', 'Baby II', 'Child', 'Adult', 'Perfect', 'Ultimate'];

// Partner level needed to evolve out of each stage, and what else the stage asks for.
export const EVOLVE_RULES = {
    'Baby I':  { level: 3 },
    'Baby II': { level: 6 },
    'Child':   { level: 15 },
    'Adult':   { level: 30, battles: 5 },
    'Perfect': { level: 50, wins: 10 },
};

export const HEARTS_MAX = 4;
export const HUNGER_MS = 4 * 60 * 60 * 1000;      // one hunger heart every 4 hours: full to starving in 16
export const STRENGTH_MS = 4 * 60 * 60 * 1000;    // one strength heart every 4 hours
export const MISTAKES_PER_ABSENCE = 2;            // a weekend away should hurt, not ruin a partner
export const XP_PER_LEVEL = 100;
export const TEAM_SIZE = 3;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const AGE_TICK_MS = 60 * 60 * 1000;          // age moves in whole hours, so reading a partner rarely writes
export const DEFAULT_LIFESPAN_DAYS = 30;
const REVERT_FROM = ['Adult', 'Perfect', 'Ultimate']; // Champion and up de-digivolve when worn out
export const DNA_STAGES = ['Adult', 'Perfect'];      // two Champions make an Ultimate, two Ultimates a Mega


/*
 * Wild spawn rarity. A spawn rolls its tier first, then any species of that stage at random, so every Digimon
 * in a tier is equally likely. Chances are percent of spawns and add up to 100. `tame` is the level range a
 * tamed one starts at. Baby, Armor, Hybrid and Unknown are not in any tier and never spawn.
 */
export const RARITY = [
    { name: 'Common',    stage: 'Child',    chance: 75,  tame: [5, 10],  color: 0x5b7083 },
    { name: 'Uncommon',  stage: 'Adult',    chance: 22,  tame: [15, 20], color: 0x2f855a },
    { name: 'Rare',      stage: 'Perfect',  chance: 2.5, tame: [30, 35], color: 0x6b46c1 },
    { name: 'Legendary', stage: 'Ultimate', chance: 0.5, tame: [50, 55], color: 0xb7791f },
];

/** The tier a spawn gets for a roll in [0, 1). Works in tenths of a percent so 0.5% stays exact. */
export function rollRarity(roll = Math.random()) {
    const at = Math.floor(roll * 1000);
    let edge = 0;
    for (const tier of RARITY) {
        edge += Math.round(tier.chance * 10);
        if (at < edge) return tier;
    }
    return RARITY[0];
}

export const rarityOfStage = stage => RARITY.find(t => t.stage === stage) ?? null;

/*
 * Starters for /digimon start. Each is a Digi-Egg that always grows along its classic line up to Child
 * (Botamon → Koromon → Agumon); from Child on, care picks the branch as for any partner. Names are the ones in
 * the data, which follows the Japanese names, so `also` carries the dub name players know. Every line was
 * checked against digimon_evolutions on 2026-11-05.
 */
export const STARTERS = [
    { key: 'agumon',     name: 'Agumon',     also: null,       line: ['Botamon', 'Koromon', 'Agumon'] },
    { key: 'gabumon',    name: 'Gabumon',    also: null,       line: ['Punimon', 'Tunomon', 'Gabumon'] },
    { key: 'piyomon',    name: 'Piyomon',    also: 'Biyomon',  line: ['Nyokimon', 'Pyocomon', 'Piyomon'] },
    { key: 'tentomon',   name: 'Tentomon',   also: null,       line: ['Bubbmon', 'Mochimon', 'Tentomon'] },
    { key: 'palmon',     name: 'Palmon',     also: null,       line: ['Yuramon', 'Tanemon', 'Palmon'] },
    { key: 'gomamon',    name: 'Gomamon',    also: null,       line: ['Pitchmon', 'Pukamon', 'Gomamon'] },
    { key: 'patamon',    name: 'Patamon',    also: null,       line: ['Poyomon', 'Tokomon', 'Patamon'] },
    { key: 'plotmon',    name: 'Plotmon',    also: 'Salamon',  line: ['Yukimi Botamon', 'Nyaromon', 'Plotmon'] },
    { key: 'vmon',       name: 'V-mon',      also: 'Veemon',   line: ['Chicomon', 'Chibimon', 'V-mon'] },
    { key: 'guilmon',    name: 'Guilmon',    also: null,       line: ['Jyarimon', 'Gigimon', 'Guilmon'] },
    { key: 'terriermon', name: 'Terriermon', also: null,       line: ['Zerimon', 'Gummymon', 'Terriermon'] },
    { key: 'renamon',    name: 'Renamon',    also: null,       line: ['Relemon', 'Pokomon', 'Renamon'] },
    // Added 2026-11-05 from Crispy's list. Her Gekkomon and Chiropmon (Ghost Game) are not in the data or on
    // digi-api.com, so they have no egg yet.
    { key: 'hawkmon',    name: 'Hawkmon',    also: null,       line: ['Pururumon', 'Poromon', 'Hawkmon'] },
    { key: 'gammamon',   name: 'Gammamon',   also: null,       line: ['Curimon', 'Gurimon', 'Gammamon'] },
    { key: 'gumdramon',  name: 'Gumdramon',  also: null,       line: ['Petitmon', 'Babydmon', 'Gumdramon'] },
];
const STARTER_STAGES = ['Baby I', 'Baby II', 'Child'];

/** The form a starter's line takes at `stage`, or null once it is past Child (or for no starter). */
export function starterForm(key, stage) {
    const s = STARTERS.find(x => x.key === key);
    const i = STARTER_STAGES.indexOf(stage);
    return s && i >= 0 ? s.line[i] : null;
}

export function nextStage(level) {
    const i = STAGES.indexOf(level);
    return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
}

/** FNV-1a, so tie-breaks are stable across restarts and machines. */
export function stableHash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

/**
 * The partner's care as of `now`. `care` holds hunger, strength, care_mistakes and the time (ms) each
 * clock last ticked: hunger_at and strength_at. Returns a new object; the caller saves it.
 *
 * Each clock moves forward only by whole periods, keeping the part of a period that has not finished,
 * or a partner checked every hour would never get hungry.
 */
export function applyDecay(care, now) {
    const hungerAt = care.hunger_at ?? now;
    const strengthAt = care.strength_at ?? now;
    const hungerDrops = Math.floor(Math.max(0, now - hungerAt) / HUNGER_MS);
    const strengthDrops = Math.floor(Math.max(0, now - strengthAt) / STRENGTH_MS);
    const starvedPeriods = Math.max(0, hungerDrops - care.hunger);
    const mistakes = Math.min(starvedPeriods, MISTAKES_PER_ABSENCE);
    // Age, like the hearts, only moves by whole ticks and keeps the unfinished part of one.
    const agedAt = care.aged_at ?? now;
    const ageTicks = Math.floor(Math.max(0, now - agedAt) / AGE_TICK_MS);
    return {
        ...care,
        hunger: Math.max(0, care.hunger - hungerDrops),
        strength: Math.max(0, care.strength - strengthDrops),
        care_mistakes: care.care_mistakes + mistakes,
        total_mistakes: (care.total_mistakes ?? 0) + mistakes,
        hunger_at: hungerAt + hungerDrops * HUNGER_MS,
        strength_at: strengthAt + strengthDrops * STRENGTH_MS,
        age_ms: (care.age_ms ?? 0) + ageTicks * AGE_TICK_MS,
        aged_at: agedAt + ageTicks * AGE_TICK_MS,
    };
}

/**
 * How long this partner lives on the team, in ms (Infinity when the server turned lifespans off). Every care
 * mistake of its life takes a day off, down to a third of the full span, so neglect shortens a life without
 * ending one in a weekend.
 */
export function lifespanMs(row, days = DEFAULT_LIFESPAN_DAYS) {
    if (!(days > 0)) return Infinity;
    return Math.max(Math.ceil(days / 3), days - (row.total_mistakes ?? 0)) * DAY_MS;
}

export const lifeOver = (row, days) => (row.age_ms ?? 0) >= lifespanMs(row, days);

/** A reborn Digimon inherits its data: each stat spread point +2, up to the 15 cap. */
export function rebirthIvs(row) {
    const up = v => Math.min(15, (v ?? 0) + 2);
    return { iv_hp: up(row.iv_hp), iv_atk: up(row.iv_atk), iv_def: up(row.iv_def), iv_spd: up(row.iv_spd) };
}

/** forms as an object {stage: digimon_id}; older rows without it know only their current form. */
export function formsOf(row) {
    let f = row.forms;
    if (typeof f === 'string') { try { f = JSON.parse(f); } catch { f = null; } }
    if (!f || typeof f !== 'object' || Array.isArray(f)) f = {};
    if (row.stage && row.digimon_id && !f[row.stage]) f = { ...f, [row.stage]: row.digimon_id };
    return f;
}

/** The stage below this one that it can de-digivolve to (a form it actually was), or null. */
export function previousForm(row) {
    const forms = formsOf(row);
    for (let i = STAGES.indexOf(row.stage) - 1; i >= 0; i--) {
        if (forms[STAGES[i]]) return { stage: STAGES[i], id: forms[STAGES[i]] };
    }
    return null;
}

/**
 * After a battle: a Champion or higher that has no strength left, or is starving, falls back to its Rookie
 * (Child) form. Returns that form's { stage, id } or null when it holds its form. One that never was a Rookie
 * (tamed as a Champion, say) has nowhere to fall back to and stays.
 */
export function wornOutRevert(row) {
    if (!REVERT_FROM.includes(row.stage)) return null;
    if (row.strength > 0 && row.hunger > 0) return null;
    const child = formsOf(row).Child;
    return child ? { stage: 'Child', id: child } : null;
}

/** forms with every stage at or above `stage` removed: what a DNA partner keeps after the fusion splits. */
export function formsBelow(forms, stage) {
    const cut = STAGES.indexOf(stage);
    return Object.fromEntries(Object.entries(forms).filter(([s]) => STAGES.indexOf(s) < cut));
}

/** What stops these two team partners from DNA Digivolving, or [] when they can. */
export function dnaBlockers(a, b) {
    const out = [];
    if (!a || !b || a.id === b.id) return ['Pick two different partners from your team.'];
    if (a.stage !== b.stage) out.push(`Both must be at the same stage (${a.stage} and ${b.stage}).`);
    else if (!DNA_STAGES.includes(a.stage)) out.push('Only two Champions (Adult) or two Ultimates (Perfect) can DNA Digivolve.');
    else {
        const need = EVOLVE_RULES[a.stage].level;
        for (const d of [a, b]) if (d.level < need) out.push(`${d.name} must reach level ${need} (now ${d.level}).`);
    }
    for (const d of [a, b]) {
        if (d.dna_partner_id) out.push(`${d.name} is already DNA-fused.`);
        if (d.hunger === 0) out.push(`${d.name} is starving. Feed it first.`);
        if (d.strength === 0) out.push(`${d.name} has no strength left. Train it first.`);
    }
    return out;
}

/** The attribute this partner's upbringing at its current stage points at. */
export function careAttribute({ care_mistakes = 0, trainings = 0, stage_battles, battles = 0 }) {
    const fought = stage_battles ?? battles;
    if (care_mistakes >= 3) return 'Virus';
    if (care_mistakes <= 1 && trainings >= fought) return 'Vaccine';
    return 'Data';
}

/** Columns cleared when a Digimon evolves: its next stage starts with a clean care record. */
export const stageReset = () => ({ care_mistakes: 0, trainings: 0, stage_battles: 0 });

/** Bits the seller receives after the server's market fee (rounded down, never below 0). */
export function marketPayout(price, feePercent = 0) {
    const fee = Math.floor(price * Math.min(50, Math.max(0, feePercent)) / 100);
    return { fee, payout: price - fee };
}

/**
 * Why a Digimon cannot leave its owner right now (trade or sale), or null.
 * row { user_id, is_partner, locked, dna_partner_id } and the user trying to move it. is_partner means it
 * is on its owner's team.
 */
export function cannotMove(row, userId, { allowListed = false } = {}) {
    if (!row || row.user_id !== userId) return 'not-owned';
    if (row.is_partner) return 'partner';
    if (row.dna_partner_id || row.locked === 'dna') return 'dna';
    if (row.locked && !(allowListed && row.locked === 'market')) return 'locked';
    return null;
}

/** Plain words for the partner screen, so players can see where their care is heading. */
export function careLeaning(care) {
    const attr = careAttribute(care);
    if (attr === 'Virus') return { attribute: attr, text: 'Virus: too many care mistakes' };
    if (attr === 'Vaccine') return { attribute: attr, text: 'Vaccine: well cared for and well trained' };
    return { attribute: attr, text: 'Data: a balance of training and battles' };
}

/** What still stands between this partner and its next stage, or [] when it can evolve. */
export function evolveBlockers(partner) {
    const rule = EVOLVE_RULES[partner.stage];
    if (!rule) return ['This Digimon is already at its final stage.'];
    const out = [];
    if (partner.level < rule.level) out.push(`Reach level ${rule.level} (now ${partner.level}).`);
    if (rule.battles && partner.battles < rule.battles) out.push(`Fight ${rule.battles} battles (now ${partner.battles}).`);
    if (rule.wins && partner.wins < rule.wins) out.push(`Win ${rule.wins} battles (now ${partner.wins}).`);
    if (partner.hunger === 0) out.push('Feed it first, it is starving.');
    return out;
}

/**
 * Pick the form the partner evolves into.
 * partner     { id, stage, fields: [..], care_mistakes, trainings, battles }
 * candidates  [{ id, name, level, attributes: [..], fields: [..] }]: the next forms from the data
 * Returns the chosen candidate or null when the line ends here.
 */
export function chooseEvolution(partner, candidates) {
    const stage = nextStage(partner.stage);
    const pool = candidates.filter(c => c.level === stage);
    if (!pool.length) return null;
    const want = careAttribute(partner);
    const ownFields = new Set(partner.fields ?? []);
    const score = c => {
        let s = 0;
        if (c.attributes.includes(want)) s += 3;
        else if (c.attributes.includes('Free')) s += 1.5;
        s += Math.min(2, (c.fields ?? []).filter(f => ownFields.has(f)).length);
        return s;
    };
    return pool
        .map(c => ({ c, s: score(c), h: stableHash(`${partner.id}:${c.id}`) }))
        .sort((a, b) => b.s - a.s || a.h - b.h)[0].c;
}

/** Level and leftover XP after gaining `amount`. */
export function addXp(level, xp, amount) {
    let total = xp + amount;
    let lvl = level;
    while (total >= XP_PER_LEVEL) { total -= XP_PER_LEVEL; lvl++; }
    return { level: lvl, xp: total, leveled: lvl > level };
}

/*
 * ── Battles: the Digimon Card Game's rules (Comprehensive Rules v4.1, en.digimoncard.com) ────────────────
 *
 *   levels      Lv.3 Rookie (Child), Lv.4 Champion (Adult), Lv.5 Ultimate (Perfect), Lv.6 Mega (Ultimate).
 *               Lv.1-2 babies have no DP and stay in the breeding area, so they never battle (rule 4-17-2).
 *   DP          a battle compares DP: the higher one wins, a tie loses for both (14-2). A partner's DP is its
 *               card DP (median over its printings; LEVEL_DP when it has no card) plus what raising it adds:
 *               levels, strength hearts and its stat spread, rounded to 100.
 *   matches     each tamer has their team in the battle area and a security stack of SECURITY_SIZE cards,
 *               drawn from their own DigiBank (their deck). Turns alternate; each turn the turn player's
 *               unsuspended partners attack the other tamer (11). A <Blocker> may block (12). Otherwise the
 *               attacker checks security (13): the flipped Security Digimon battles it, is never deleted itself
 *               (14-2-3), and deletes the attacker when it has as much DP or more. Attacking a tamer with no
 *               security left wins (11-5-1-2).
 *   keywords    Blocker, Security A. +1, Jamming, Piercing, Retaliation and Reboot, as in rule 16. A partner
 *               also has the inherited keywords of the forms it digivolved from (4-3-3).
 * There is no Vaccine/Virus/Data triangle in the card game, so attributes steer evolution only.
 */
export const CARD_KEYWORDS = ['Blocker', 'Security A.', 'Jamming', 'Piercing', 'Retaliation', 'Reboot'];
export const CARD_LEVEL = { 'Baby I': 1, 'Baby II': 2, Child: 3, Adult: 4, Perfect: 5, Ultimate: 6 };
export const DUB_STAGE = { 'Baby I': 'Fresh', 'Baby II': 'In-Training', Child: 'Rookie', Adult: 'Champion', Perfect: 'Ultimate', Ultimate: 'Mega' };
// The card game's median DP per level, measured over 3,383 Digimon cards on 2026-11-06.
export const LEVEL_DP = { 3: 2000, 4: 5000, 5: 7000, 6: 12000, 7: 15000 };
export const SECURITY_SIZE = 3;
export const MAX_TURNS = 12;

/**
 * Keywords a card has outright, from its effect text: ones that open the text or a sentence ("＜Blocker＞ (This
 * Digimon can block…)"). A keyword gained under a condition ("While you have X, this Digimon gains ＜Blocker＞")
 * does not count, and only a positive <Security A.> does.
 */
export function cardKeywords(text) {
    const out = new Set();
    // Split where a sentence ends and a keyword or [timing] starts. Not at every full stop ("＜Security A. +1＞"
    // has one inside) and not before every keyword ("this Digimon gains ＜Blocker＞" is conditional).
    for (const part of String(text ?? '').split(/\n|(?<=[.)])\s+(?=[<＜[])/)) {
        const m = part.trim().match(/^[<＜]([A-Za-z][A-Za-z\-. ]*?)(?:\s*([+-]?\d+))?[>＞]/);
        if (!m) continue;
        const name = m[1].trim() === 'Security Attack' ? 'Security A.' : m[1].trim();
        if (!CARD_KEYWORDS.includes(name)) continue;
        if (name === 'Security A.' && !(Number(m[2]) > 0)) continue;
        out.add(name);
    }
    return CARD_KEYWORDS.filter(k => out.has(k));
}

/**
 * One Digimon's card facts from all its printings [{ dp, level, color, main_effect, source_effect }]. Printings
 * differ (Agumon has 1,000 to 4,000 DP, and one of twelve has <Blocker>), so it takes the most common DP (the
 * higher on a tie), level and colour, and a keyword only when at least half the printings have it. `dps` keeps
 * every distinct DP for wild Digimon.
 */
export function summariseCards(cards) {
    const mode = (xs, tieHigh = false) => {
        const n = new Map();
        for (const x of xs) if (x != null && x !== '') n.set(x, (n.get(x) ?? 0) + 1);
        return [...n].sort((a, b) => b[1] - a[1] || (tieHigh ? b[0] - a[0] : 0))[0]?.[0] ?? null;
    };
    const dpList = cards.map(c => Number(c.dp)).filter(n => n >= 1000);
    const half = list => CARD_KEYWORDS.filter(k => list.filter(l => l.includes(k)).length * 2 >= cards.length);
    return {
        dp: mode(dpList, true),
        level: mode(cards.map(c => Number(c.level) || null)),
        color: mode(cards.map(c => c.color)),
        keywords: cards.length ? half(cards.map(c => cardKeywords(c.main_effect))) : [],
        inherited: cards.length ? half(cards.map(c => cardKeywords(c.source_effect))) : [],
        dps: [...new Set(dpList)].sort((a, b) => a - b),
    };
}

export const cardLevel = d => Number(d.card_level) || CARD_LEVEL[d.stage] || 0;
/** "Lv.4 Champion": the card level and the dub stage name players know. */
export const levelLabel = d => `Lv.${cardLevel(d)} ${DUB_STAGE[d.stage] ?? d.stage}`;
export const canBattle = d => cardLevel(d) >= 3;

/** A Digimon's DP: its card DP plus 20 per level, 250 per strength heart and 10 per stat-spread point. */
export function dpOf(d) {
    if (!canBattle(d)) return 0;
    const base = Number(d.card_dp) || LEVEL_DP[cardLevel(d)] || LEVEL_DP[3];
    const spread = (d.iv_hp ?? 0) + (d.iv_atk ?? 0) + (d.iv_def ?? 0) + (d.iv_spd ?? 0);
    const growth = (d.level ?? 1) * 20 + (d.strength ?? 0) * 250 + spread * 10;
    return Math.round((base + growth) / 100) * 100;
}

/** A wild Digimon's DP: one of its real printings, picked by `roll`, else its level's usual DP. */
export function wildDp(d, roll = Math.random()) {
    const dps = Array.isArray(d.card_dps) ? d.card_dps : [];
    if (dps.length) return dps[Math.min(dps.length - 1, Math.floor(roll * dps.length))];
    return Number(d.card_dp) || LEVEL_DP[cardLevel(d)] || LEVEL_DP[3];
}

/** Rule 14-2: higher DP wins; the same DP and both lose. Returns the loser: 'a', 'b' or 'both'. */
export function battleLoser(dpA, dpB) {
    if (dpA === dpB) return 'both';
    return dpA > dpB ? 'b' : 'a';
}

/**
 * Play out a match. Each side: { name, partners: [{ id, name, dp, keywords: [..] }], security: [{ name, dp }] }
 * (the top of the stack is the last item). Returns { winner: 'a' | 'b' | 'draw', log, turns, first, survivors }.
 *
 * Simple play for both tamers: every unsuspended partner attacks the other tamer, except one <Blocker> kept back
 * while there is someone to block; a blocker only blocks an attacker it can beat or tie. A turn ends once every
 * partner has acted (the memory gauge has no counterpart here). After `maxTurns` the side with more security
 * left wins, then the one with more partners left; otherwise it is a draw.
 */
export function runMatch(A, B, rng = Math.random, maxTurns = MAX_TURNS) {
    const prep = s => ({ name: s.name, field: s.partners.map(p => ({ ...p, suspended: false, deleted: false })), security: [...s.security] });
    const S = { a: prep(A), b: prep(B) };
    const log = [];
    const has = (d, k) => (d.keywords ?? []).includes(k);
    const alive = side => S[side].field.filter(d => !d.deleted);
    const remove = (d, line) => { d.deleted = true; log.push(line); };
    const done = (winner, turns) => ({ winner, log, turns, first, survivors: { a: alive('a'), b: alive('b') } });

    // Two Digimon on the field (a block): the loser is deleted; <Retaliation> takes the winner along (16-13).
    const clash = (atk, def) => {
        const lost = battleLoser(atk.dp, def.dp);
        if (lost === 'both') { atk.deleted = def.deleted = true; log.push(`${atk.name} and ${def.name} (${atk.dp} DP each) delete each other.`); return; }
        const [loser, winner] = lost === 'a' ? [atk, def] : [def, atk];
        remove(loser, `${winner.name} (${winner.dp} DP) deletes ${loser.name} (${loser.dp} DP).`);
        if (has(loser, 'Retaliation')) remove(winner, `${loser.name}'s Retaliation deletes ${winner.name} too.`);
    };

    // Rule 13: flip the top card; the Security Digimon battles the attacker and is never deleted itself.
    const securityCheck = (atk, foe) => {
        const checks = 1 + (has(atk, 'Security A.') ? 1 : 0);
        for (let i = 0; i < checks && !atk.deleted && S[foe].security.length; i++) {
            const card = S[foe].security.pop();
            const left = S[foe].security.length;
            if (battleLoser(atk.dp, card.dp) === 'b') { log.push(`${atk.name} checks security: beats ${card.name} (${card.dp} DP). ${left} left.`); continue; }
            if (has(atk, 'Jamming')) { log.push(`${atk.name} checks security: ${card.name} (${card.dp} DP), but Jamming keeps it safe. ${left} left.`); continue; }
            remove(atk, `${atk.name} checks security: ${card.name} (${card.dp} DP) deletes it. ${left} left.`);
        }
    };

    const first = rng() < 0.5 ? 'a' : 'b';
    let turn = first;
    for (let t = 1; t <= maxTurns; t++) {
        const me = turn, foe = me === 'a' ? 'b' : 'a';
        // Unsuspend phase (6-2); the other side's <Reboot> partners unsuspend too (16-11).
        for (const d of alive(me)) d.suspended = false;
        for (const d of alive(foe)) if (has(d, 'Reboot')) d.suspended = false;
        const guard = alive(me).length > 1 && alive(foe).length ? alive(me).find(d => has(d, 'Blocker')) : null;
        for (const atk of alive(me)) {
            if (atk === guard || atk.deleted || atk.suspended) continue;
            atk.suspended = true;
            const blocker = alive(foe).filter(d => !d.suspended && has(d, 'Blocker') && d.dp >= atk.dp).sort((x, y) => y.dp - x.dp)[0];
            if (blocker) {
                blocker.suspended = true;
                log.push(`${atk.name} attacks; ${blocker.name} blocks.`);
                clash(atk, blocker);
                if (blocker.deleted && !atk.deleted && has(atk, 'Piercing')) securityCheck(atk, foe);
                continue;
            }
            if (!S[foe].security.length) {
                log.push(`${atk.name} attacks ${S[foe].name} with no security left!`);
                return done(me, t);
            }
            securityCheck(atk, foe);
        }
        if (!alive('a').length && !alive('b').length) break;
        turn = foe;
    }
    const sec = { a: S.a.security.length, b: S.b.security.length };
    const left = { a: alive('a').length, b: alive('b').length };
    const winner = sec.a !== sec.b ? (sec.a > sec.b ? 'a' : 'b') : left.a !== left.b ? (left.a > left.b ? 'a' : 'b') : 'draw';
    log.push(winner === 'draw' ? 'No winner: a draw.' : `No more attacks: ${S[winner].name} has more ${sec.a !== sec.b ? 'security' : 'partners'} left.`);
    return done(winner, maxTurns);
}

/** Lowercase, no accents, punctuation or spaces: "Agumon (X-Antibody)" → "agumonxantibody". */
export function normaliseName(text) {
    return String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * DNA partners named in a digi-api evolution condition, as normalised names: "with V-dramon or V-dramon Black"
 * → ['vdramon', 'vdramonblack']. "with or without X" counts (DNA is one way there). Vague partners ("a Data
 * Attribute Adult Digimon from the Vital Bracelet…") and conditions with no "with" give nothing. The data writes
 * variants without brackets ("Garurumon X-Antibody"), and normaliseName drops brackets too, so they match.
 */
export function parseDnaPartners(condition) {
    const text = String(condition ?? '');
    if (!/\bwith\b/i.test(text)) return [];
    const after = text.replace(/^.*?\bwith\b/i, '').replace(/^\s*or without\b/i, '');
    return [...new Set(after.split(/,|\bor\b|\band\b/i)
        .map(s => s.trim())
        .filter(s => s && !/^(an?|the)\s/i.test(s) && !/attribute|digimon from/i.test(s))
        .map(normaliseName)
        .filter(n => n.length > 1))];
}

/** A guess is right on the full name or the name without its bracketed variant: "Agumon" for "Agumon (Black)". */
export function nameMatches(guess, name) {
    const g = normaliseName(guess);
    if (!g) return false;
    return g === normaliseName(name) || g === normaliseName(String(name).replace(/\(.*?\)/g, ''));
}
