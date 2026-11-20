/*
 * Critters battle engine. Pure: give it two teams and an rng, get back the result.
 *
 * Live CertiFried rules (kept exactly):
 *   attack  = 2*atk + 1; with a weapon: floor((attack + rankBonus + floor(quality/4)) * wearMult) + sum floor(perkQuality/2)
 *   defence = pr + mr (+ wp when the weapon is magic)
 *   hp      = 50*hp + 100 (+ floor(rankBonus/2) with a weapon)
 *   up to 3 a side, at most 20 turns. Each turn every living A critter (slot order) hits a random living B
 *   critter, then B does the same to A. damage = max(1, atk + randInt(0..floor(atk/2)) - floor(def/2)).
 *   HP floors at 0; a hit to 0 is a kill credited to the attacker's weapon (only when uwid > 0).
 *   Winner: one side wiped, else more survivors, else more remaining HP, else a draw. An empty side loses at once.
 *
 * Original additions: each weapon type has one small effect (data/weapons.js `effect`); the Acorn Charm's
 * statBoost scales attack and HP. Effects never break the rules above: damage stays >= 1, HP stays in [0, max].
 */
import { weaponTypeById, rankById, wearById } from '../data/weapons.js';
import { tierIndex } from '../data/tiers.js';
import { SPECIES } from '../data/species.js';
import { CPU_TEAM_NAMES } from '../data/text.js';
import { BATTLE_TURN_CAP } from '../constants.js';
import { randInt, pickOne } from './rng.js';
import { generateWeapon } from './weapon-rules.js';

/** Build a combatant from a species, an optional weapon ({uwid,typeId,rankId,quality,wear,perks}) and display bits. */
export function deriveCombatant({ species, weapon = null, nickname = null, level = 1, pid = 0 }) {
    const st = species.stats;
    let atk = 2 * st.atk + 1;
    let hp = 50 * st.hp + 100;
    let def = st.pr + st.mr;
    let type = null;
    if (weapon) {
        type = weaponTypeById(weapon.typeId);
        const rank = rankById(weapon.rankId);
        const wear = wearById(weapon.wear);
        const bonus = rank ? rank.bonus : 0;
        atk = Math.floor((atk + bonus + Math.floor((Number(weapon.quality) || 0) / 4)) * wear.mult);
        for (const p of weapon.perks || []) atk += Math.floor((Number(p.quality) || 0) / 2);
        hp += Math.floor(bonus / 2);
        if (type?.magic) def += st.wp;
        if (type?.statBoost) {
            atk = Math.floor(atk * (1 + type.statBoost));
            hp = Math.floor(hp * (1 + type.statBoost));
        }
    }
    return {
        pid, speciesKey: species.key, tier: species.tier, emoji: species.emoji,
        name: nickname || species.name, level,
        atk, def, maxHp: hp,
        uwid: weapon ? Number(weapon.uwid) || 0 : 0,
        effect: type ? type.effect : 'none',
        weaponName: type ? type.name : null,
    };
}

const EFFECT = Object.freeze({
    splashShare: 0.4, chimeShare: 0.2, mendShare: 0.3, bloomShare: 0.12, drainSelf: 0.2, drainTeam: 0.08,
    critChance: 0.25, critMult: 1.6, tauntChance: 0.5, tauntGuard: 0.2,
    bleedPct: 0.08, bleedRounds: 2, burnPctPerStack: 0.04, burnMaxStacks: 3, burnRounds: 3,
    focusBonus: 0.25, reviveHp: 0.3, stunChance: 0.2, rallyStep: 0.04, rallyCap: 0.32, leechShare: 0.25,
    weakenCut: 0.2, weakenRounds: 2, flurryShare: 0.55,
});
export const EFFECT_TUNING = EFFECT;

function makeUnit(c, side, slot) {
    return {
        ...c, side, slot, hp: c.maxHp,
        stun: false, bleed: null, burn: null, weaken: 0, focus: 0, reviveUsed: false,
    };
}

const alive = (team) => team.filter(u => u.hp > 0);
const label = (u) => `${u.emoji} ${u.name}`;

/** Split a battle log into frames ending at turn boundaries (speed 1 = one intermediate frame, 2 = up to four). */
export function splitLogFrames(log, speed) {
    const s = Number(speed) || 0;
    if (s <= 0) return [];
    const turnStarts = [];
    log.forEach((line, i) => { if (/^Turn \d+$/.test(line)) turnStarts.push(i); });
    if (turnStarts.length < 2) return [];
    const parts = s === 1 ? 2 : 5;
    const frames = [];
    for (let k = 1; k < parts; k++) {
        const t = Math.floor((turnStarts.length * k) / parts);
        if (t <= 0 || t >= turnStarts.length) continue;
        const cut = turnStarts[t];
        const slice = log.slice(0, cut);
        if (!frames.length || frames[frames.length - 1].length !== slice.length) frames.push(slice);
    }
    return frames.slice(0, s === 1 ? 1 : 4);
}

/**
 * Simulate a battle. teamA / teamB are arrays of combatants from deriveCombatant (max 3 each).
 * @returns {{ winner:'team1'|'team2'|'draw', turns:number, onMargin:boolean, log:string[],
 *             kills:{side:'team1'|'team2', uwid:number, kills:number}[],
 *             final:{team1:object[], team2:object[]} }}
 */
export function simulateBattle(teamA, teamB, { rng = Math.random, turnCap = BATTLE_TURN_CAP, nameA = 'Team 1', nameB = 'Team 2' } = {}) {
    const A = (teamA || []).slice(0, 3).map((c, i) => makeUnit(c, 'team1', i + 1));
    const B = (teamB || []).slice(0, 3).map((c, i) => makeUnit(c, 'team2', i + 1));
    const log = [];
    const kills = new Map();
    const rally = { team1: 0, team2: 0 };

    const roster = (name, team) => {
        log.push(`${name}:`);
        for (const u of team) log.push(`  ${label(u)} (Lv ${u.level}) ${u.hp}/${u.maxHp} HP`);
    };
    roster(nameA, A);
    roster(nameB, B);

    const final = () => ({
        team1: A.map(u => ({ pid: u.pid, name: u.name, emoji: u.emoji, speciesKey: u.speciesKey, level: u.level, hp: u.hp, maxHp: u.maxHp, alive: u.hp > 0, uwid: u.uwid })),
        team2: B.map(u => ({ pid: u.pid, name: u.name, emoji: u.emoji, speciesKey: u.speciesKey, level: u.level, hp: u.hp, maxHp: u.maxHp, alive: u.hp > 0, uwid: u.uwid })),
    });
    const killsOut = () => [...kills.entries()].map(([k, n]) => { const [side, uwid] = k.split(':'); return { side, uwid: Number(uwid), kills: n }; });

    if (A.length === 0 || B.length === 0) {
        const winner = A.length === 0 && B.length === 0 ? 'draw' : A.length === 0 ? 'team2' : 'team1';
        log.push('One side had nobody to send out.');
        return { winner, turns: 0, onMargin: false, log, kills: killsOut(), final: final() };
    }

    const creditKill = (attacker) => {
        if (attacker && attacker.uwid > 0) {
            const key = `${attacker.side}:${attacker.uwid}`;
            kills.set(key, (kills.get(key) || 0) + 1);
        }
    };
    const heal = (u, amount) => {
        if (u.hp <= 0) return 0;
        const before = u.hp;
        u.hp = Math.min(u.maxHp, u.hp + Math.max(0, Math.floor(amount)));
        return u.hp - before;
    };
    const hurt = (attacker, target, amount) => {
        const dmg = Math.max(1, Math.floor(amount));
        const before = target.hp;
        target.hp = Math.max(0, target.hp - dmg);
        if (before > 0 && target.hp === 0) creditKill(attacker);
        return dmg;
    };
    const pickTarget = (foes) => {
        const living = alive(foes);
        const taunters = living.filter(u => u.effect === 'taunt');
        if (taunters.length && rng() < EFFECT.tauntChance) return pickOne(rng, taunters);
        return pickOne(rng, living);
    };
    const rollDamage = (u, target, share = 1) => {
        let a = u.atk * (1 + rally[u.side] + u.focus);
        if (u.weaken > 0) a *= (1 - EFFECT.weakenCut);
        a = Math.max(1, Math.floor(a * share));
        let dmg = Math.max(1, a + randInt(rng, 0, Math.floor(a / 2)) - Math.floor(target.def / 2));
        if (target.effect === 'taunt') dmg = Math.max(1, Math.floor(dmg * (1 - EFFECT.tauntGuard)));
        return dmg;
    };

    const act = (u, allies, foes) => {
        if (u.hp <= 0 || alive(foes).length === 0) return;
        if (u.stun) {
            u.stun = false;
            log.push(`${label(u)} is frozen and loses its turn.`);
            return;
        }
        if (u.effect === 'revive' && !u.reviveUsed) {
            const fallen = allies.find(x => x !== u && x.hp <= 0);
            if (fallen) {
                u.reviveUsed = true;
                fallen.hp = Math.max(1, Math.floor(fallen.maxHp * EFFECT.reviveHp));
                fallen.stun = false; fallen.bleed = null; fallen.burn = null; fallen.weaken = 0;
                log.push(`${label(u)} sounds the horn: ${label(fallen)} gets back up with ${fallen.hp} HP.`);
            }
        }
        const target = pickTarget(foes);
        const hits = u.effect === 'flurry' ? randInt(rng, 1, 3) : 1;
        let total = 0;
        for (let h = 0; h < hits && target.hp > 0; h++) {
            let dmg = rollDamage(u, target, u.effect === 'flurry' ? EFFECT.flurryShare : 1);
            let crit = false;
            if (u.effect === 'crit' && rng() < EFFECT.critChance) { dmg = Math.max(1, Math.floor(dmg * EFFECT.critMult)); crit = true; }
            dmg = hurt(u, target, dmg);
            total += dmg;
            log.push(`${label(u)} hits ${label(target)} for ${dmg}${crit ? ' (crushing blow)' : ''}${hits > 1 ? ` [die ${h + 1}/${hits}]` : ''}. ${target.name}: ${target.hp}/${target.maxHp}${target.hp === 0 ? ', down!' : ''}`);
        }
        u.focus = 0;
        // Effects after the hit.
        const otherFoes = alive(foes).filter(x => x !== target);
        switch (u.effect) {
            case 'splash': {
                const second = pickOne(rng, otherFoes);
                if (second) {
                    const d = hurt(u, second, total * EFFECT.splashShare);
                    log.push(`  thorns catch ${label(second)} for ${d}. ${second.name}: ${second.hp}/${second.maxHp}${second.hp === 0 ? ', down!' : ''}`);
                }
                break;
            }
            case 'chime': {
                for (const f of otherFoes) {
                    const d = hurt(u, f, total * EFFECT.chimeShare);
                    log.push(`  the bell rattles ${label(f)} for ${d}. ${f.name}: ${f.hp}/${f.maxHp}${f.hp === 0 ? ', down!' : ''}`);
                }
                break;
            }
            case 'mend': {
                const hurtAllies = alive(allies).filter(x => x.hp < x.maxHp).sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp);
                if (hurtAllies[0]) {
                    const h = heal(hurtAllies[0], total * EFFECT.mendShare);
                    if (h > 0) log.push(`  dew mends ${label(hurtAllies[0])} for ${h}.`);
                }
                break;
            }
            case 'bloom': {
                let healed = 0;
                for (const x of alive(allies)) healed += heal(x, total * EFFECT.bloomShare);
                if (healed > 0) log.push(`  petals mend the team for ${healed} in total.`);
                break;
            }
            case 'drain': {
                let healed = heal(u, total * EFFECT.drainSelf);
                for (const x of alive(allies)) if (x !== u) healed += heal(x, total * EFFECT.drainTeam);
                if (healed > 0) log.push(`  the siphon shares ${healed} HP with the team.`);
                break;
            }
            case 'leech': {
                const h = heal(u, total * EFFECT.leechShare);
                if (h > 0) log.push(`  ${u.name} drinks back ${h} HP.`);
                break;
            }
            case 'bleed':
                if (target.hp > 0) { target.bleed = { rounds: EFFECT.bleedRounds, from: u }; log.push(`  ${target.name} is stung and will keep hurting.`); }
                break;
            case 'burn':
                if (target.hp > 0) {
                    const stacks = Math.min(EFFECT.burnMaxStacks, (target.burn?.stacks || 0) + 1);
                    target.burn = { stacks, rounds: EFFECT.burnRounds, from: u };
                    log.push(`  embers settle on ${target.name} (${stacks} stack${stacks > 1 ? 's' : ''}).`);
                }
                break;
            case 'stun':
                if (target.hp > 0 && rng() < EFFECT.stunChance) { target.stun = true; log.push(`  ${target.name} freezes solid.`); }
                break;
            case 'weaken':
                if (target.hp > 0) { target.weaken = EFFECT.weakenRounds; log.push(`  vines sap ${target.name}'s strength.`); }
                break;
            case 'focus': {
                const mates = alive(allies).filter(x => x !== u);
                const m = pickOne(rng, mates.length ? mates : [u]);
                m.focus = EFFECT.focusBonus;
                log.push(`  ${m.name} sharpens up for the next strike.`);
                break;
            }
            case 'rally':
                if (rally[u.side] < EFFECT.rallyCap) {
                    rally[u.side] = Math.min(EFFECT.rallyCap, rally[u.side] + EFFECT.rallyStep);
                    log.push(`  the banner lifts the team (+${Math.round(rally[u.side] * 100)}% attack).`);
                }
                break;
            default:
                break;
        }
    };

    const tick = (team) => {
        for (const u of team) {
            if (u.hp <= 0) { u.bleed = null; u.burn = null; continue; }
            if (u.bleed) {
                const d = hurt(u.bleed.from, u, u.maxHp * EFFECT.bleedPct);
                log.push(`${label(u)} bleeds for ${d}. ${u.name}: ${u.hp}/${u.maxHp}${u.hp === 0 ? ', down!' : ''}`);
                u.bleed.rounds -= 1;
                if (u.bleed.rounds <= 0) u.bleed = null;
            }
            if (u.hp > 0 && u.burn) {
                const d = hurt(u.burn.from, u, u.maxHp * EFFECT.burnPctPerStack * u.burn.stacks);
                log.push(`${label(u)} burns for ${d}. ${u.name}: ${u.hp}/${u.maxHp}${u.hp === 0 ? ', down!' : ''}`);
                u.burn.rounds -= 1;
                if (u.burn.rounds <= 0) u.burn = null;
            }
            if (u.weaken > 0) u.weaken -= 1;
        }
    };

    let turns = 0;
    let wiped = false;
    for (let t = 1; t <= turnCap; t++) {
        turns = t;
        log.push(`Turn ${t}`);
        for (const u of A) act(u, A, B);
        if (alive(B).length === 0) { wiped = true; break; }
        for (const u of B) act(u, B, A);
        if (alive(A).length === 0) { wiped = true; break; }
        tick(A);
        tick(B);
        if (alive(A).length === 0 || alive(B).length === 0) { wiped = true; break; }
    }

    const aAlive = alive(A).length;
    const bAlive = alive(B).length;
    let winner;
    if (aAlive !== bAlive) winner = aAlive > bAlive ? 'team1' : 'team2';
    else {
        const aHp = A.reduce((s, u) => s + u.hp, 0);
        const bHp = B.reduce((s, u) => s + u.hp, 0);
        winner = aHp === bHp ? 'draw' : aHp > bHp ? 'team1' : 'team2';
    }
    const onMargin = !wiped && winner !== 'draw';
    return { winner, turns, onMargin, log, kills: killsOut(), final: final() };
}

/** Win/loss bookkeeping for one team. outcome: 'win' | 'loss' | 'draw' (draws change nothing). */
export function applyRecord(team, outcome) {
    const t = { wins: Number(team.wins) || 0, losses: Number(team.losses) || 0, streak: Number(team.streak) || 0, bestStreak: Number(team.bestStreak) || 0 };
    if (outcome === 'win') {
        t.wins += 1;
        t.streak += 1;
        t.bestStreak = Math.max(t.bestStreak, t.streak);
    } else if (outcome === 'loss') {
        t.losses += 1;
        t.streak = 0;
    }
    return t;
}

/**
 * A CPU team for a solo battle: the same size as the player's team (1..3), species from tiers at most one above
 * the player's average tier (never above epic), each with a 50% chance of a freshly made, unsaved weapon (uwid 0).
 */
export function generateCpuTeam(playerTeam, rng) {
    const size = Math.max(1, Math.min(3, (playerTeam || []).length || 1));
    const idx = (playerTeam || []).map(c => Math.max(0, tierIndex(c.tier)));
    const avg = idx.length ? Math.round(idx.reduce((a, b) => a + b, 0) / idx.length) : 0;
    const maxTier = Math.min(avg + 1, tierIndex('epic'));
    const pool = SPECIES.filter(s => tierIndex(s.tier) <= maxTier);
    const avgLevel = playerTeam && playerTeam.length ? Math.max(1, Math.round(playerTeam.reduce((a, c) => a + (c.level || 1), 0) / playerTeam.length)) : 1;
    const members = [];
    for (let i = 0; i < size; i++) {
        const species = pickOne(rng, pool);
        const weapon = rng() < 0.5 ? { ...generateWeapon(rng), uwid: 0 } : null;
        members.push(deriveCombatant({ species, weapon, level: avgLevel }));
    }
    return { name: pickOne(rng, CPU_TEAM_NAMES), members, maxTier };
}

/* ------------------------------------------------------------------------------------------- battle settings */

export const BATTLE_SETTINGS_DEFAULTS = Object.freeze({ display: 'text', speed: 0, logs: false });
export const SPEED_NAMES = Object.freeze(['instant', 'short', 'lengthy']);

export class SettingsError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

export function parseSettingValue(name, value) {
    const n = String(name || '').trim().toLowerCase();
    const v = String(value ?? '').trim().toLowerCase();
    if (n === 'display') {
        if (v === 'image') throw new SettingsError('UNAVAILABLE', 'Picture battles are not available. Use text or compact.');
        if (v === 'text' || v === 'compact') return { display: v };
        throw new SettingsError('BAD_VALUE', 'display can be text or compact.');
    }
    if (n === 'speed') {
        const i = /^\d+$/.test(v) ? Number(v) : SPEED_NAMES.indexOf(v);
        if (i >= 0 && i <= 2) return { speed: i };
        throw new SettingsError('BAD_VALUE', 'speed can be instant (0), short (1) or lengthy (2).');
    }
    if (n === 'logs') {
        if (['true', 'on', '1', 'yes'].includes(v)) return { logs: true };
        if (['false', 'off', '0', 'no'].includes(v)) return { logs: false };
        throw new SettingsError('BAD_VALUE', 'logs can be on or off.');
    }
    throw new SettingsError('BAD_NAME', 'The settings are display, speed and logs.');
}

/** Parse "display=compact speed:short logs=on" into a patch. Empty text gives {}. */
export function parseSettingsText(text) {
    const patch = {};
    const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
        const m = tok.match(/^([a-z]+)[=:](.+)$/i);
        if (!m) throw new SettingsError('BAD_SYNTAX', 'Write settings as name=value, for example display=compact speed=short logs=on.');
        Object.assign(patch, parseSettingValue(m[1], m[2]));
    }
    return patch;
}
