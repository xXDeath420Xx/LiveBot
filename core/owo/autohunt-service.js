/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Autohunt — passive hunting that accumulates animals while the user is
 * away. Design: no scheduler required. When the user claims, we compute
 * (now - start) / hunt_interval to figure out how many hunts "should have"
 * happened since last claim, capped by max_queued. Each computed hunt then
 * runs the catalog rollHunt(), writes to owo_animal + owo_animal_count,
 * and credits currency in one batch. Grants no server XP — see manager.js `hunt()`.
 *
 * Per-guild isolation via owo_autohunt(guild_id, id). Enabled users are
 * tracked by presence of a row.
 */

import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { rollHunt, RANK_META, listAllRanks } from './catalog.js';
import { addCowoncy } from './cowoncy.js';
import { progressQuest } from './quests-service.js';

const HUNT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes per auto-hunt
const MAX_QUEUED = 24; // 12 hours of queued hunts max

export async function isEnabled(guildId, userId) {
    const [[row]] = await pool.execute(
        'SELECT id FROM owo_autohunt WHERE guild_id = ? AND id = ?',
        [guildId, userId]
    );
    return !!row;
}

export async function enable(guildId, userId) {
    await pool.execute(
        `INSERT INTO owo_autohunt (guild_id, id, start, huntcount, huntmin, total)
         VALUES (?, ?, NOW(), 0, 0, 0)
         ON DUPLICATE KEY UPDATE start = NOW(), huntcount = 0`,
        [guildId, userId]
    );
    return { enabled: true, intervalMs: HUNT_INTERVAL_MS };
}

export async function disable(guildId, userId) {
    const [r] = await pool.execute(
        'DELETE FROM owo_autohunt WHERE guild_id = ? AND id = ?',
        [guildId, userId]
    );
    return { disabled: r.affectedRows > 0 };
}

/**
 * Compute + commit accumulated hunts since last claim (or since enable).
 * Advances `start` to NOW() so the next claim begins counting from here.
 */
export async function claim(guildId, userId) {
    const [[row]] = await pool.execute(
        'SELECT start FROM owo_autohunt WHERE guild_id = ? AND id = ?',
        [guildId, userId]
    );
    if (!row) return { error: 'Autohunt is not enabled. Use `/autohunt enable` first.' };

    const startedAt = new Date(row.start).getTime();
    const elapsed = Date.now() - startedAt;
    const queued = Math.min(MAX_QUEUED, Math.floor(elapsed / HUNT_INTERVAL_MS));
    if (queued <= 0) {
        const nextMs = HUNT_INTERVAL_MS - (elapsed % HUNT_INTERVAL_MS);
        const nextMin = Math.ceil(nextMs / 60000);
        return { claimed: 0, nextInMinutes: nextMin };
    }

    const results = { claimed: queued, animals: {}, totalPoints: 0, byRank: {} };

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        for (let i = 0; i < queued; i++) {
            const r = await rollHunt();
            if (!r.animal) continue;
            const name = r.animal.name;

            await conn.execute(
                `INSERT INTO owo_animal (guild_id, id, name, count, totalcount) VALUES (?, ?, ?, 1, 1)
                 ON DUPLICATE KEY UPDATE count = count + 1, totalcount = totalcount + 1`,
                [guildId, userId, name]
            );

            if (listAllRanks().includes(r.rank)) {
                await conn.execute(
                    `INSERT INTO owo_animal_count (guild_id, id, \`${r.rank}\`) VALUES (?, ?, 1)
                     ON DUPLICATE KEY UPDATE \`${r.rank}\` = \`${r.rank}\` + 1`,
                    [guildId, userId]
                );
            }

            results.animals[name] = (results.animals[name] || 0) + 1;
            results.totalPoints += r.points;
            results.byRank[r.rank] = (results.byRank[r.rank] || 0) + 1;
        }

        // Advance start to "consume" those intervals cleanly (remainder carries forward)
        const consumed = queued * HUNT_INTERVAL_MS;
        await conn.execute(
            `UPDATE owo_autohunt SET start = FROM_UNIXTIME(? / 1000), huntcount = huntcount + ?, total = total + ?
             WHERE guild_id = ? AND id = ?`,
            [startedAt + consumed, queued, queued, guildId, userId]
        );

        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }

    // Currency (outside transaction — economy-manager has its own)
    if (results.totalPoints > 0) {
        await addCowoncy(guildId, userId, results.totalPoints, `Autohunt claim: ${queued} hunts`);
    }
    // Quest progress: autohunt counts as hunt for quests
    progressQuest(guildId, userId, 'hunt', queued).catch(() => { /* swallow */ });

    return results;
}

/**
 * Status snapshot — how many hunts are queued right now, how long until
 * next hunt fires, whether autohunt is enabled.
 */
export async function status(guildId, userId) {
    const [[row]] = await pool.execute(
        'SELECT start, huntcount, total FROM owo_autohunt WHERE guild_id = ? AND id = ?',
        [guildId, userId]
    );
    if (!row) return { enabled: false };
    const startedAt = new Date(row.start).getTime();
    const elapsed = Date.now() - startedAt;
    const queued = Math.min(MAX_QUEUED, Math.floor(elapsed / HUNT_INTERVAL_MS));
    const nextMs = HUNT_INTERVAL_MS - (elapsed % HUNT_INTERVAL_MS);
    return {
        enabled: true,
        queued,
        queuedCap: MAX_QUEUED,
        nextInMinutes: Math.ceil(nextMs / 60000),
        totalLifetime: Number(row.total) || 0,
        intervalMinutes: Math.round(HUNT_INTERVAL_MS / 60000),
    };
}
