/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Simplified battle orchestrator. Runs a turn-based fight between two
 * teams using simple stat math — enough to determine a winner and produce
 * a readable combat log. Upstream's full engine is richer (weapon-specific
 * attack patterns, mana-gated abilities, chained passive triggers, buffs
 * with duration). Wiring all of that in requires adapting the tuple-based
 * stat shape that WeaponInterface.inflictDamage expects; doing that
 * faithfully is a separate follow-up. For now the engine is additive: it
 * respects weapon rank + stat + passive presence as visible bonuses, so
 * equipping weapons meaningfully changes outcomes.
 */

import { getAnimal } from './catalog.js';
import { generateWeapon } from './weapons-service.js';

const MAX_TURNS = 20;

const RANK_ATTACK_BONUS = {
    Common: 2, Uncommon: 5, Rare: 10, Epic: 20, Mythical: 40, Legendary: 80, Fabled: 160,
};

const WEAR_MULT = { 4: 1.25, 3: 1.15, 2: 1.05, 1: 1.00, 0: 1.00 };

function effectiveAttack(animal) {
    let base = animal.stats.att * 2 + 1;
    if (animal.weapon) {
        const rankBonus = RANK_ATTACK_BONUS[animal.weapon.rank] || 0;
        const wearMult = WEAR_MULT[animal.weapon.wearId] || 1.0;
        base = base + rankBonus + Math.floor(animal.weapon.stat / 4);
        base = Math.floor(base * wearMult);
        for (const p of (animal.weapon.passives || [])) base += Math.floor((p.quality || 0) / 2);
    }
    return base;
}

function effectiveDefense(animal) {
    let base = animal.stats.pr + animal.stats.mr;
    if (animal.weapon && /Staff|Wand|Rune|Orb/.test(animal.weapon.name || '')) {
        base += animal.stats.wp; // magic-focused weapons lean on willpower
    }
    return base;
}

function effectiveHP(animal) {
    const base = (animal.stats.hp || 0) * 50 + 100;
    const rankBump = animal.weapon ? Math.floor((RANK_ATTACK_BONUS[animal.weapon.rank] || 0) * 0.5) : 0;
    return base + rankBump;
}

/**
 * Snapshot a team details object into combat state the engine mutates.
 */
function toCombatState(team, labelPrefix = '') {
    return team.animals.map((a, idx) => ({
        pos: a.pos,
        name: a.name,
        display: a.nickname || a.name,
        nickname: a.nickname,
        rank: a.rank || 'common',
        emoji: a.name,
        stats: { ...a.stats },
        weapon: a.weapon || null,
        currentHp: effectiveHP(a),
        maxHp: effectiveHP(a),
        alive: true,
        label: `${labelPrefix}${idx + 1}`,
    }));
}

function pickAliveTarget(pool) {
    const alive = pool.filter(a => a.alive);
    if (!alive.length) return null;
    return alive[Math.floor(Math.random() * alive.length)];
}

function doAttack(log, attacker, target) {
    if (!attacker.alive || !target || !target.alive) return;
    const atk = effectiveAttack(attacker);
    const def = effectiveDefense(target);
    const roll = atk + Math.floor(Math.random() * (atk / 2)) - Math.floor(def / 2);
    const damage = Math.max(1, roll);
    target.currentHp = Math.max(0, target.currentHp - damage);
    const wepTag = attacker.weapon
        ? ` w/ ${attacker.weapon.emoji} ${attacker.weapon.rank} ${attacker.weapon.name}`
        : '';
    const stateTag = target.currentHp === 0 ? ' 💀' : '';
    log.push(`${attacker.display}${wepTag} → ${target.display}: **-${damage} HP** (${target.currentHp}/${target.maxHp})${stateTag}`);
    if (target.currentHp === 0) target.alive = false;
}

/**
 * Simulate a battle between two teams.
 * @param {object} team1 - team details from getTeamDetails()
 * @param {object} team2 - ditto
 * @returns {{ winner: 'team1'|'team2'|'draw', turns: number, log: string[], finalState: {team1, team2} }}
 */
export function simulateBattle(team1, team2) {
    if (!team1?.animals?.length) return { winner: 'team2', turns: 0, log: ['*Team 1 has no animals.*'], finalState: null };
    if (!team2?.animals?.length) return { winner: 'team1', turns: 0, log: ['*Team 2 has no animals.*'], finalState: null };

    const state1 = toCombatState(team1, 'A');
    const state2 = toCombatState(team2, 'B');
    const log = [];

    log.push(`⚔️  **${team1.tname}** vs **${team2.tname}**`);
    log.push(`Team A: ${state1.map(a => a.display + ' (' + a.maxHp + ' HP)').join(', ')}`);
    log.push(`Team B: ${state2.map(a => a.display + ' (' + a.maxHp + ' HP)').join(', ')}`);
    log.push('');

    let turn = 0;
    while (turn < MAX_TURNS) {
        turn += 1;
        log.push(`**Turn ${turn}**`);

        // Team A attacks Team B
        for (const a of state1) {
            if (!a.alive) continue;
            if (!state2.some(x => x.alive)) break;
            const target = pickAliveTarget(state2);
            doAttack(log, a, target);
        }

        // Check end
        if (!state2.some(x => x.alive)) { log.push(`\n🏆 **Team A wins** in ${turn} turn${turn === 1 ? '' : 's'}.`); break; }

        // Team B attacks Team A
        for (const b of state2) {
            if (!b.alive) continue;
            if (!state1.some(x => x.alive)) break;
            const target = pickAliveTarget(state1);
            doAttack(log, b, target);
        }

        if (!state1.some(x => x.alive)) { log.push(`\n🏆 **Team B wins** in ${turn} turn${turn === 1 ? '' : 's'}.`); break; }

        log.push('');
    }

    const aAlive = state1.filter(x => x.alive).length;
    const bAlive = state2.filter(x => x.alive).length;

    let winner;
    if (aAlive > bAlive) winner = 'team1';
    else if (bAlive > aAlive) winner = 'team2';
    else {
        // tie on count — compare remaining total HP
        const aHp = state1.reduce((s, x) => s + x.currentHp, 0);
        const bHp = state2.reduce((s, x) => s + x.currentHp, 0);
        winner = aHp === bHp ? 'draw' : (aHp > bHp ? 'team1' : 'team2');
    }

    if (turn === MAX_TURNS && winner !== 'draw') {
        log.push(`\n⏱️ **Turn limit reached — ${winner === 'team1' ? 'Team A' : 'Team B'} wins on HP margin.**`);
    } else if (winner === 'draw') {
        log.push('\n🤝 **Draw — evenly matched.**');
    }

    return {
        winner,
        turns: turn,
        log,
        finalState: {
            team1: state1.map(a => ({ name: a.name, display: a.display, alive: a.alive, hp: a.currentHp, max: a.maxHp })),
            team2: state2.map(a => ({ name: a.name, display: a.display, alive: a.alive, hp: a.currentHp, max: a.maxHp })),
        },
    };
}

// ── CPU opponent ──────────────────────────────────────────────────

const CPU_ANIMAL_POOL = [
    { name: ':bee:',       rank: 'common',   stats: { hp: 1, att: 5, pr: 2, wp: 3, mag: 3, mr: 1 } },
    { name: ':beetle:',    rank: 'common',   stats: { hp: 4, att: 2, pr: 2, wp: 3, mag: 2, mr: 2 } },
    { name: ':snail:',     rank: 'common',   stats: { hp: 8, att: 1, pr: 2, wp: 3, mag: 5, mr: 1 } },
    { name: ':baby_chick:',rank: 'uncommon', stats: { hp: 3, att: 2, pr: 3, wp: 3, mag: 3, mr: 2 } },
    { name: ':mouse2:',    rank: 'uncommon', stats: { hp: 3, att: 3, pr: 2, wp: 3, mag: 3, mr: 2 } },
    { name: ':rabbit2:',   rank: 'uncommon', stats: { hp: 3, att: 4, pr: 2, wp: 3, mag: 2, mr: 2 } },
    { name: ':cat2:',      rank: 'rare',     stats: { hp: 3, att: 1, pr: 1, wp: 6, mag: 3, mr: 3 } },
    { name: ':dog2:',      rank: 'rare',     stats: { hp: 4, att: 6, pr: 3, wp: 1, mag: 1, mr: 2 } },
    { name: ':sheep:',     rank: 'rare',     stats: { hp: 5, att: 2, pr: 2, wp: 3, mag: 1, mr: 4 } },
];

/**
 * Generate a random CPU team roughly matching the player's team tier.
 * The CPU animals get a random weapon each ~50% of the time.
 */
export async function generateCpuTeam(playerTeam) {
    const avgRank = averageRank(playerTeam?.animals || []);
    const pool = CPU_ANIMAL_POOL.filter(a => rankOrder(a.rank) <= avgRank + 1);
    const pickFrom = pool.length ? pool : CPU_ANIMAL_POOL;
    const size = Math.max(1, Math.min(3, playerTeam?.animals?.length || 3));

    const animals = [];
    for (let i = 0; i < size; i++) {
        const base = pickFrom[Math.floor(Math.random() * pickFrom.length)];
        const hydrated = await getAnimal(base.name).catch(() => null);
        const emoji = hydrated?.emoji || base.name;
        const weapon = Math.random() < 0.5 ? generateWeapon() : null;
        animals.push({
            pos: i + 1,
            name: base.name,
            nickname: null,
            emoji,
            rank: base.rank,
            count: 1,
            xp: 0,
            ispet: true,
            stats: { ...base.stats },
            weapon: weapon ? {
                uwid: 0,
                weaponId: weapon.weaponId,
                name: weapon.name,
                emoji: weapon.emoji,
                rank: weapon.rank,
                stat: weapon.stat,
                wearId: weapon.wearId,
                wearName: weapon.wear,
                passives: weapon.passives,
            } : null,
        });
    }
    return { pgid: -1, tname: 'CPU Ambush', win: 0, lose: 0, streak: 0, highestStreak: 0, animals };
}

function rankOrder(rank) {
    const r = String(rank || '').toLowerCase();
    return { common: 1, uncommon: 2, rare: 3, epic: 4, mythical: 5, legendary: 6 }[r] || 1;
}
function averageRank(animals) {
    if (!animals.length) return 1;
    const sum = animals.reduce((s, a) => s + rankOrder(a.rank), 0);
    return Math.round(sum / animals.length);
}
