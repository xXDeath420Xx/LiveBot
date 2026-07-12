/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Ranch — passive currency income from pets on your active team. Uses the
 * same compute-on-claim pattern as autohunt. Income rate per pet depends
 * on the pet's rank.
 *
 * Storage reuses owo_timers with a new column-free fallback by storing
 * last claim in owo_cooldowns under command='ranch'. Lifetime totals are
 * tracked in owo_cowoncydrop (fits the "passive drop" semantics upstream
 * used for this feature).
 */

import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { addCowoncy } from './cowoncy.js';
import { getTeamDetails } from './teams-service.js';

// Per-pet, per-hour income by rank. Scales roughly with rank rarity but
// much lower than hunt rewards so it's steady idle income, not a bypass.
const RANCH_HOURLY = {
    common: 1, uncommon: 3, rare: 10, epic: 40,
    mythical: 300, legendary: 1000, fabled: 2500,
};
const TICK_MS = 60 * 60 * 1000; // 1 hour per tick
const MAX_HOURS = 24; // cap: 24 hours of accrual

export async function lastClaimAt(guildId, userId) {
    const [[row]] = await pool.execute(
        'SELECT used_at FROM owo_cooldowns WHERE guild_id = ? AND user_id = ? AND command = ?',
        [guildId, userId, 'ranch']
    );
    return row?.used_at ? new Date(row.used_at).getTime() : 0;
}

async function recordClaim(guildId, userId) {
    await pool.execute(
        `INSERT INTO owo_cooldowns (guild_id, user_id, command, used_at) VALUES (?, ?, 'ranch', NOW())
         ON DUPLICATE KEY UPDATE used_at = NOW()`,
        [guildId, userId]
    );
}

/**
 * Compute hourly income from the user's active team.
 */
function teamHourlyRate(team) {
    if (!team?.animals?.length) return 0;
    return team.animals.reduce((sum, a) => sum + (RANCH_HOURLY[a.rank] || 0), 0);
}

export async function status(guildId, userId) {
    const team = await getTeamDetails(guildId, userId);
    if (!team) return { hasTeam: false };
    const hourly = teamHourlyRate(team);
    const last = await lastClaimAt(guildId, userId);
    const elapsed = last ? Date.now() - last : 0;
    const hours = Math.min(MAX_HOURS, Math.floor(elapsed / TICK_MS));
    return {
        hasTeam: true,
        teamSize: team.animals.length,
        hourlyRate: hourly,
        hoursAccrued: hours,
        pendingPayout: hours * hourly,
        maxHours: MAX_HOURS,
        nextTickMinutes: Math.ceil((TICK_MS - (elapsed % TICK_MS)) / 60000),
    };
}

export async function claim(guildId, userId) {
    const team = await getTeamDetails(guildId, userId);
    if (!team || team.animals.length === 0) return { error: 'Add animals to your team first with `/owo team-add`.' };
    const last = await lastClaimAt(guildId, userId);
    const elapsed = last ? Date.now() - last : 0;
    const hours = last ? Math.min(MAX_HOURS, Math.floor(elapsed / TICK_MS)) : MAX_HOURS;
    if (hours <= 0) {
        const nextMin = Math.ceil((TICK_MS - (elapsed % TICK_MS)) / 60000);
        return { claimed: 0, nextInMinutes: nextMin };
    }
    const hourly = teamHourlyRate(team);
    const payout = hours * hourly;
    if (payout <= 0) {
        await recordClaim(guildId, userId);
        return { claimed: 0, hourly, hours, note: 'Team has no income-earning pets.' };
    }
    await addCowoncy(guildId, userId, payout, `Ranch claim: ${hours}h × ${hourly}`);
    await recordClaim(guildId, userId);

    // Bump lifetime drop total (non-fatal if table missing expected columns)
    try {
        await pool.execute(
            `INSERT INTO owo_cowoncydrop (guild_id, id, amount) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)`,
            [guildId, userId, payout]
        );
    } catch { /* ignore — schema may differ */ }

    return { claimed: payout, hourly, hours };
}
