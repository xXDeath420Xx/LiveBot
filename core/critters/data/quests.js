/*
 * Critters quests (original data, 2026-11-19). Three slots, each holding one quest.
 *
 * kinds: hunt (critters caught, autohunt included), battle (battles won), command (game commands run that
 * passed their gates). Each kind has 5 levels (0..4): a target and a roll weight. The prize kind is drawn
 * uniformly from PRIZE_KINDS and its amount comes from the level.
 */

export const QUEST_SLOTS = 3;

export const QUEST_KINDS = Object.freeze({
    hunt: { key: 'hunt', label: 'Catch {n} critters', targets: [25, 60, 120, 250, 500] },
    battle: { key: 'battle', label: 'Win {n} battles', targets: [3, 8, 15, 30, 60] },
    command: { key: 'command', label: 'Use {n} game commands', targets: [20, 50, 100, 200, 400] },
});

export const LEVEL_WEIGHTS = Object.freeze([45, 28, 15, 8, 4]);

export const PRIZE_KINDS = Object.freeze(['currency', 'crate', 'shards', 'lootbox']);

export const PRIZE_AMOUNTS = Object.freeze({
    currency: [400, 1000, 2500, 6000, 15000],
    crate: [1, 1, 2, 3, 5],
    shards: [10, 25, 60, 150, 400],
    lootbox: [1, 2, 3, 5, 8],
});

export function questTarget(kind, level) {
    const k = QUEST_KINDS[kind];
    if (!k) return 0;
    return k.targets[Math.max(0, Math.min(4, Number(level) || 0))];
}

export function prizeAmount(prize, level) {
    const p = PRIZE_AMOUNTS[prize];
    if (!p) return 0;
    return p[Math.max(0, Math.min(4, Number(level) || 0))];
}

export function questLabel(kind, level) {
    const k = QUEST_KINDS[kind];
    return k ? k.label.replace('{n}', String(questTarget(kind, level))) : kind;
}

/** Roll a fresh quest: uniform kind, weighted level, uniform prize kind. */
export function rollQuest(rng = Math.random) {
    const kinds = Object.keys(QUEST_KINDS);
    const kind = kinds[Math.floor(rng() * kinds.length)];
    const total = LEVEL_WEIGHTS.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    let level = 0;
    for (let i = 0; i < LEVEL_WEIGHTS.length; i++) {
        if (r < LEVEL_WEIGHTS[i]) { level = i; break; }
        r -= LEVEL_WEIGHTS[i];
        level = i;
    }
    const prize = PRIZE_KINDS[Math.floor(rng() * PRIZE_KINDS.length)];
    return { kind, level, prize, target: questTarget(kind, level), prizeAmount: prizeAmount(prize, level) };
}
