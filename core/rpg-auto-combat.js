/**
 * RPG Auto-Combat Resolver
 * ------------------------------------------------------------------
 * Shared, deterministic-enough multi-round combat resolution reused by
 * BOTH the dungeon engine (player vs room enemies) and the PvP engine
 * (player vs player duel).
 *
 * This intentionally mirrors the damage/HP/defense math already used by
 * core/rpg-combat-manager.js (80-120% damage roll, defense subtraction,
 * minimum 1 damage) so behaviour stays consistent with the verified PvE
 * combat engine — it does NOT re-implement a new ruleset.
 *
 * No DB access here: callers pass in plain combatant snapshots and apply
 * rewards/ELO themselves. Keeps this layer pure + easy to test.
 */

import { RPGDiceEngine } from './rpg-dice-engine.js';

const MAX_ROUNDS = 30;

/**
 * Roll a single attack's damage using the verified combat-manager formula:
 *   floor(baseDamage * (0.8..1.2)), reduced by target defense, min 1.
 * d20 vs AC is rolled for flavour/hit-or-miss; on a miss damage is 0.
 *
 * @param {object} attacker - { name, attackBonus, damage, ... }
 * @param {object} defender - { name, ac, defense }
 * @returns {object} { hit, roll, damage, crit }
 */
function resolveAttack(attacker, defender) {
    const d20 = RPGDiceEngine.rollD20('normal');
    const attackTotal = d20.roll + (attacker.attackBonus || 0);
    const ac = defender.ac || 10;

    // Nat 1 always misses, nat 20 always hits, else compare to AC.
    let hit;
    if (d20.isFumble) hit = false;
    else if (d20.isCritical) hit = true;
    else hit = attackTotal >= ac;

    if (!hit) {
        return { hit: false, roll: attackTotal, damage: 0, crit: false };
    }

    // Same randomness band the verified combat manager uses (80%-120%).
    const mult = 0.8 + Math.random() * 0.4;
    let dmg = Math.floor((attacker.damage || 1) * mult);
    if (d20.isCritical) dmg = Math.floor(dmg * 1.5);
    // Defense subtraction, minimum 1 (matches rpg-combat-manager.attack()).
    dmg = Math.max(1, dmg - (defender.defense || 0));

    return { hit: true, roll: attackTotal, damage: dmg, crit: d20.isCritical };
}

/**
 * Resolve a full auto-duel between two combatants.
 *
 * Combatant snapshot shape:
 *   { name, hp, maxHp, ac, defense, damage, attackBonus, initiative }
 *
 * @param {object} a - side A
 * @param {object} b - side B
 * @param {object} [opts]
 * @returns {object} {
 *   winner: 'a'|'b'|null (null = draw on round limit + equal HP),
 *   rounds: [{ round, attacker, defender, hit, roll, damage, crit, attackerHp, defenderHp }],
 *   aHp, bHp, totalRounds
 * }
 */
export function resolveDuel(a, b, opts = {}) {
    const maxRounds = opts.maxRounds || MAX_ROUNDS;

    // Clone so we don't mutate caller state.
    const sideA = { ...a, hp: a.hp };
    const sideB = { ...b, hp: b.hp };

    // Initiative: higher goes first (DEX-based / level fallback already folded
    // into .initiative by the caller). Tie -> A first.
    const aFirst = (sideA.initiative || 0) >= (sideB.initiative || 0);
    const first = aFirst ? sideA : sideB;
    const second = aFirst ? sideB : sideA;
    const firstKey = aFirst ? 'a' : 'b';
    const secondKey = aFirst ? 'b' : 'a';

    const rounds = [];

    const doSwing = (atk, def, atkKey, defKey, roundNo) => {
        const res = resolveAttack(atk, def);
        def.hp = Math.max(0, def.hp - res.damage);
        rounds.push({
            round: roundNo,
            attacker: atk.name,
            defender: def.name,
            attackerKey: atkKey,
            defenderKey: defKey,
            hit: res.hit,
            roll: res.roll,
            damage: res.damage,
            crit: res.crit,
            attackerHp: atk.hp,
            defenderHp: def.hp,
        });
        return def.hp <= 0;
    };

    let winner = null;
    for (let round = 1; round <= maxRounds; round++) {
        if (doSwing(first, second, firstKey, secondKey, round)) { winner = firstKey; break; }
        if (doSwing(second, first, secondKey, firstKey, round)) { winner = secondKey; break; }
    }

    // Round-limit reached with both alive: higher remaining HP wins, else draw.
    if (!winner) {
        if (sideA.hp > sideB.hp) winner = 'a';
        else if (sideB.hp > sideA.hp) winner = 'b';
        else winner = null;
    }

    return {
        winner,
        rounds,
        aHp: sideA.hp,
        bHp: sideB.hp,
        totalRounds: rounds.length,
    };
}

/**
 * Resolve a player against a SEQUENCE of enemies (a room encounter).
 * The player's HP carries across enemies; enemies are fought one at a time.
 *
 * @param {object} player - { name, hp, maxHp, ac, defense, damage, attackBonus, initiative }
 * @param {object[]} enemies - array of enemy snapshots (same shape, plus xp/gold)
 * @param {object} [opts]
 * @returns {object} {
 *   victory: bool,
 *   playerHp: number,
 *   log: [{ enemy, rounds:[...], defeated:bool }],
 *   totalRounds,
 *   enemiesDefeated: number,
 *   xpEarned, goldEarned
 * }
 */
export function resolveEncounter(player, enemies, opts = {}) {
    const maxRoundsPerEnemy = opts.maxRoundsPerEnemy || MAX_ROUNDS;
    const p = { ...player, hp: player.hp };

    const log = [];
    let totalRounds = 0;
    let enemiesDefeated = 0;
    let xpEarned = 0;
    let goldEarned = 0;
    let victory = true;

    for (const enemy of enemies) {
        // Player initiative vs this enemy: higher initiative strikes first.
        const duel = resolveDuel(
            { ...p, hp: p.hp },
            enemy,
            { maxRounds: maxRoundsPerEnemy }
        );

        p.hp = duel.aHp; // player is side 'a'
        totalRounds += duel.totalRounds;

        const defeated = duel.winner === 'a';
        log.push({ enemy: enemy.name, rounds: duel.rounds, defeated, playerHp: p.hp, enemyHp: duel.bHp });

        if (defeated) {
            enemiesDefeated++;
            xpEarned += enemy.xp || 0;
            goldEarned += enemy.gold || 0;
        } else {
            // Player fell (or draw with player not winning) — encounter lost.
            victory = false;
            break;
        }

        if (p.hp <= 0) { victory = false; break; }
    }

    return {
        victory,
        playerHp: p.hp,
        log,
        totalRounds,
        enemiesDefeated,
        xpEarned,
        goldEarned,
    };
}

export default { resolveDuel, resolveEncounter, resolveAttack };
