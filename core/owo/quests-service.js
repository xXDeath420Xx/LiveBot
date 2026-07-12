/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Quest system: every user holds up to MAX_ACTIVE_QUESTS active quests at a
 * time. Quests come from QUEST_DEFS (ported from upstream's quests.json).
 * Each action (hunt, battle, /owo call) nudges matching quests forward.
 * On completion the user claims the prize and a new quest auto-generates.
 *
 * Prize types: cowoncy (currency via economy bridge), crate, shards, lootbox.
 */

import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { addCowoncy } from './cowoncy.js';
import { adminGrantCrate } from './weapons-service.js';

export const MAX_ACTIVE_QUESTS = 3;

// Subset of upstream quest types that we can actually track right now.
// Adding a new type: define entry here + emit `progressQuest(type, n)` from
// the action site (see manager.js hunt() and battle handler).
export const QUEST_DEFS = {
    hunt: {
        label: 'Hunt',
        description: (target) => `Hunt ${target} animals`,
        count: [10, 50, 100, 500, 1000],
        chance: [0.4, 0.3, 0.24, 0.05, 0.01],
        rewards: {
            cowoncy: [100, 500, 1000, 20000, 50000],
            crate:   [1,   2,   3,    7,     10],
            shards:  [100, 200, 300, 700, 1000],
            lootbox: [1,   2,   3,    7,     10],
        },
    },
    battle: {
        label: 'Battle',
        description: (target) => `Win ${target} battles`,
        count: [5, 15, 30, 100, 250],
        chance: [0.4, 0.3, 0.24, 0.05, 0.01],
        rewards: {
            cowoncy: [150, 750, 1500, 25000, 60000],
            crate:   [1,   2,   3,    7,     10],
            shards:  [100, 200, 300, 700, 1000],
            lootbox: [1,   2,   3,    7,     10],
        },
    },
    owo: {
        label: 'OwO',
        description: (target) => `Run ${target} /owo commands`,
        count: [25, 100, 250, 1000, 2500],
        chance: [0.4, 0.3, 0.24, 0.05, 0.01],
        rewards: {
            cowoncy: [50, 250, 500, 10000, 25000],
            crate:   [1,  2,   3,   5,     7],
            shards:  [50, 150, 250, 500, 800],
            lootbox: [1,  2,   3,   5,     7],
        },
    },
};

const PRIZE_TYPES = ['cowoncy', 'crate', 'shards', 'lootbox'];

function weightedPick(entries) {
    const total = entries.reduce((s, e) => s + e.chance, 0);
    let r = Math.random() * total;
    for (const e of entries) { r -= e.chance; if (r <= 0) return e; }
    return entries[entries.length - 1];
}

// Produce a fresh quest descriptor: qname + level + prize + target.
function rollQuest() {
    const types = Object.keys(QUEST_DEFS);
    const qname = types[Math.floor(Math.random() * types.length)];
    const def = QUEST_DEFS[qname];
    const entries = def.count.map((target, i) => ({
        level: i, target, chance: def.chance[i],
        rewards: Object.fromEntries(PRIZE_TYPES.map(p => [p, def.rewards[p][i]])),
    }));
    const tier = weightedPick(entries);
    const prize = PRIZE_TYPES[Math.floor(Math.random() * PRIZE_TYPES.length)];
    return {
        qname,
        level: tier.level,
        prize,
        target: tier.target,
        reward: tier.rewards[prize],
    };
}

/**
 * Ensure the user has MAX_ACTIVE_QUESTS active (unclaimed, incomplete) quests.
 * Returns the full active list (max 3).
 */
export async function ensureQuests(guildId, userId) {
    // Read existing quests
    const [existing] = await pool.execute(
        `SELECT qid, qname, level, prize, count, claimed FROM owo_quest
         WHERE guild_id = ? AND uid = ? ORDER BY qid`,
        [guildId, userId]
    );

    // Count ACTIVE (unclaimed) quests. Claimed rows linger for history but
    // don't count toward the active cap.
    const active = existing.filter(q => !q.claimed);

    // Fill missing slots up to MAX_ACTIVE_QUESTS
    const takenSlots = new Set(active.map(q => q.qid));
    for (let slot = 1; slot <= MAX_ACTIVE_QUESTS; slot++) {
        if (takenSlots.has(slot)) continue;
        const q = rollQuest();
        // Remove any stale claimed row in this slot before inserting
        await pool.execute(
            'DELETE FROM owo_quest WHERE guild_id = ? AND uid = ? AND qid = ?',
            [guildId, userId, slot]
        );
        await pool.execute(
            `INSERT INTO owo_quest (guild_id, uid, qid, qname, level, prize, count, locked)
             VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
            [guildId, userId, slot, q.qname, q.level, q.prize]
        );
    }

    return listQuests(guildId, userId);
}

export async function listQuests(guildId, userId) {
    const [rows] = await pool.execute(
        `SELECT qid, qname, level, prize, count, claimed
         FROM owo_quest WHERE guild_id = ? AND uid = ? AND claimed IS NULL
         ORDER BY qid`,
        [guildId, userId]
    );
    return rows.map(q => {
        const def = QUEST_DEFS[q.qname];
        const target = def?.count[q.level] ?? 0;
        const reward = def?.rewards[q.prize]?.[q.level] ?? 0;
        return {
            qid: Number(q.qid),
            qname: q.qname,
            label: def?.label || q.qname,
            description: def?.description(target) || `${q.qname}: ${q.count}/${target}`,
            level: Number(q.level),
            prize: q.prize,
            count: Number(q.count),
            target,
            reward,
            progressPct: target > 0 ? Math.min(100, Math.floor((Number(q.count) / target) * 100)) : 0,
            complete: Number(q.count) >= target,
        };
    });
}

/**
 * Advance all active quests of the given type by `amount`.
 * Silent no-op if the user has no active quests of that type.
 */
export async function progressQuest(guildId, userId, qname, amount = 1) {
    if (!QUEST_DEFS[qname] || amount <= 0) return;
    try {
        await pool.execute(
            `UPDATE owo_quest SET count = count + ?
             WHERE guild_id = ? AND uid = ? AND qname = ? AND claimed IS NULL`,
            [amount, guildId, userId, qname]
        );
    } catch (e) {
        logger.warn('[OwO quests] progress failed (non-fatal)', { err: e.message, qname });
    }
}

/**
 * Claim a completed quest — credit reward, mark claimed, return what was
 * received. Does NOT auto-regenerate; caller should ensureQuests() afterward.
 */
export async function claimQuest(guildId, userId, qid) {
    const [[row]] = await pool.execute(
        `SELECT qname, level, prize, count, claimed FROM owo_quest
         WHERE guild_id = ? AND uid = ? AND qid = ?`,
        [guildId, userId, qid]
    );
    if (!row) return { error: `Quest slot ${qid} not found.` };
    if (row.claimed) return { error: 'Already claimed.' };
    const def = QUEST_DEFS[row.qname];
    if (!def) return { error: `Unknown quest type ${row.qname}.` };
    const target = def.count[row.level];
    if (Number(row.count) < target) {
        return { error: `Not complete yet (${row.count}/${target}).` };
    }
    const reward = def.rewards[row.prize]?.[row.level] ?? 0;
    const rewardType = row.prize;

    // Award the prize
    try {
        if (rewardType === 'cowoncy') {
            await addCowoncy(guildId, userId, reward, `OwO quest: ${row.qname} lvl ${row.level}`);
        } else if (rewardType === 'crate') {
            await adminGrantCrate(guildId, userId, reward);
        } else if (rewardType === 'shards') {
            await pool.execute(
                `INSERT INTO owo_shards (guild_id, uid, count) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE count = count + VALUES(count)`,
                [guildId, userId, reward]
            ).catch(() => {
                // Table may not yet have the (guild,uid,count) shape — upstream's
                // owo_shards has rank columns. Tolerate silently for now.
            });
        }
        // A lootbox prize adds real lootboxes. It used to hand out weapon crates instead, because
        // lootboxes did not exist yet — they do now, so the prize means what it says.
        else if (rewardType === 'lootbox') {
            await pool.execute(
                `INSERT INTO owo_lootbox (guild_id, id, boxcount) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE boxcount = boxcount + VALUES(boxcount)`,
                [guildId, userId, reward]
            );
        }
    } catch (e) {
        logger.warn('[OwO quests] reward grant partial failure', { err: e.message });
    }

    await pool.execute(
        `UPDATE owo_quest SET claimed = NOW() WHERE guild_id = ? AND uid = ? AND qid = ?`,
        [guildId, userId, qid]
    );

    return { qid: Number(qid), qname: row.qname, reward, rewardType };
}

/**
 * Claim all currently-completed quests. Returns an array of awarded results.
 */
export async function claimAllComplete(guildId, userId) {
    const active = await listQuests(guildId, userId);
    const claimed = [];
    for (const q of active) {
        if (q.complete) {
            const r = await claimQuest(guildId, userId, q.qid);
            if (!r.error) claimed.push(r);
        }
    }
    if (claimed.length > 0) {
        await ensureQuests(guildId, userId);
    }
    return claimed;
}
