/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Daily luck roll. Once every 24 hours per user: roll a weighted prize
 * (currency tiers + rare chance at a crate).
 *
 * owo_luck holds two different numbers:
 *   lcount — LUCK POINTS, upstream's meaning: moved by `owo pray` / `owo curse`
 *            (core/owo/social-service.js), ranked by `owo top luck|curse`, shown on profiles.
 *   rolls  — how many daily /luck rolls this member has made (migration 310 moved the old
 *            roll counts out of lcount, which this file used to misuse as a roll counter).
 *
 * The draw itself is in core/owo/lottery-service.js (owo lottery).
 */

import pool from '../../utils/db.js';
import { addCowoncy } from './cowoncy.js';
import { adminGrantCrate } from './weapons-service.js';

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // once per day

const PRIZE_TABLE = [
    { kind: 'cowoncy', amount: 100,   weight: 40,  label: '100 coins' },
    { kind: 'cowoncy', amount: 500,   weight: 25,  label: '500 coins' },
    { kind: 'cowoncy', amount: 1000,  weight: 15,  label: '1,000 coins' },
    { kind: 'cowoncy', amount: 5000,  weight: 8,   label: '5,000 coins' },
    { kind: 'cowoncy', amount: 25000, weight: 3,   label: '25,000 coins' },
    { kind: 'crate',   amount: 1,     weight: 6,   label: '1 weapon crate 📦' },
    { kind: 'crate',   amount: 3,     weight: 2,   label: '3 weapon crates 📦📦📦' },
    { kind: 'jackpot', amount: 100000, weight: 1,  label: '🎰 JACKPOT — 100,000 coins' },
];

function pickPrize() {
    const total = PRIZE_TABLE.reduce((s, p) => s + p.weight, 0);
    let r = Math.random() * total;
    for (const p of PRIZE_TABLE) { r -= p.weight; if (r <= 0) return p; }
    return PRIZE_TABLE[0];
}

export async function lastRollAt(guildId, userId) {
    // owo_cooldowns is already our per-command cooldown store (migration 087).
    const [[row]] = await pool.execute(
        'SELECT used_at FROM owo_cooldowns WHERE guild_id = ? AND user_id = ? AND command = ?',
        [guildId, userId, 'luck']
    );
    return row?.used_at ? new Date(row.used_at).getTime() : 0;
}

async function recordRoll(guildId, userId) {
    await pool.execute(
        `INSERT INTO owo_cooldowns (guild_id, user_id, command, used_at) VALUES (?, ?, 'luck', NOW())
         ON DUPLICATE KEY UPDATE used_at = NOW()`,
        [guildId, userId]
    );
}

async function bumpLifetime(guildId, userId) {
    await pool.execute(
        `INSERT INTO owo_luck (guild_id, id, lcount, rolls) VALUES (?, ?, 0, 1)
         ON DUPLICATE KEY UPDATE rolls = rolls + 1`,
        [guildId, userId]
    );
}

export async function rollDailyLuck(guildId, userId) {
    const last = await lastRollAt(guildId, userId);
    const now = Date.now();
    const wait = COOLDOWN_MS - (now - last);
    if (last > 0 && wait > 0) {
        return { cooldown: true, availableAt: last + COOLDOWN_MS, waitMinutes: Math.ceil(wait / 60000) };
    }

    const prize = pickPrize();
    if (prize.kind === 'cowoncy' || prize.kind === 'jackpot') {
        await addCowoncy(guildId, userId, prize.amount, `Daily luck: ${prize.label}`);
    } else if (prize.kind === 'crate') {
        await adminGrantCrate(guildId, userId, prize.amount);
    }

    await recordRoll(guildId, userId);
    await bumpLifetime(guildId, userId);

    return { cooldown: false, prize };
}

/** lifetimeRolls = daily /luck rolls made; luckPoints = pray/curse luck (can be negative). */
export async function getLuckStats(guildId, userId) {
    const [[row]] = await pool.execute(
        'SELECT lcount, rolls FROM owo_luck WHERE guild_id = ? AND id = ?',
        [guildId, userId]
    );
    return { lifetimeRolls: Number(row?.rolls) || 0, luckPoints: Number(row?.lcount) || 0 };
}
