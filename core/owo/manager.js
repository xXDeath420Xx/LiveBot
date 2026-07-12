/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Core manager for the OwO-style module. Uses upstream-style tables
 * (owo_animal, owo_animal_count) with our DB-backed catalog (owo_animals,
 * owo_animals_rank) and bridges currency through core/owo/cowoncy.js →
 * economy-manager. Per-guild isolation is maintained via guild_id on every
 * user-scoped table.
 */

import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { safeJsonArray } from '../../utils/safeJson.js';
import {
    rollHunt as catalogRollHunt,
    getAnimal,
    getAnimalsByRank,
    getCatalog,
    invalidateCatalog,
    RANK_META,
    RANK_COLORS,
    listAllRanks,
} from './catalog.js';
import {
    getCowoncy, addCowoncy, removeCowoncy, trySpendCowoncy,
    transferCowoncy, claimDailyCowoncy, getCurrencyMeta,
} from './cowoncy.js';
import { progressQuest } from './quests-service.js';

// ── Config (per-guild tuning — migrations 087 + 088) ─────────────────

const CONFIG_CACHE_TTL_MS = 30 * 1000;
const configCache = new Map();

const DEFAULT_CONFIG = {
    enabled: 0,
    hunt_cooldown_seconds: 15,
    reward_currency_multiplier: 1.0,
    reward_xp_multiplier: 1.0,
    sell_multiplier: 0.5,
    sacrifice_xp_multiplier: 1.0,
    disabled_subcommands: [],
    allowed_channel_ids: [],
    blocked_role_ids: [],
    announce_rare_catches: 1,
};

function applyDefaults(row) {
    if (!row) return { ...DEFAULT_CONFIG };
    return {
        enabled: row.enabled ? 1 : 0,
        hunt_cooldown_seconds: Number(row.hunt_cooldown_seconds ?? 15),
        reward_currency_multiplier: Number(row.reward_currency_multiplier ?? 1.0),
        reward_xp_multiplier: Number(row.reward_xp_multiplier ?? 1.0),
        sell_multiplier: Number(row.sell_multiplier ?? 0.5),
        sacrifice_xp_multiplier: Number(row.sacrifice_xp_multiplier ?? 1.0),
        disabled_subcommands: safeJsonArray(row.disabled_subcommands, 'owo disabled_subcommands'),
        allowed_channel_ids: safeJsonArray(row.allowed_channel_ids, 'owo allowed_channel_ids'),
        blocked_role_ids: safeJsonArray(row.blocked_role_ids, 'owo blocked_role_ids'),
        announce_rare_catches: row.announce_rare_catches == null ? 1 : (row.announce_rare_catches ? 1 : 0),
    };
}

export async function getConfig(guildId) {
    const cached = configCache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
        const [rows] = await pool.execute('SELECT * FROM owo_config WHERE guild_id = ?', [guildId]);
        const value = applyDefaults(rows[0]);
        configCache.set(guildId, { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
        return value;
    } catch (e) {
        logger.warn('[OwO] getConfig failed, returning defaults', { err: e.message, guildId });
        return { ...DEFAULT_CONFIG };
    }
}

export function invalidateConfigCache(guildId) {
    if (guildId) configCache.delete(guildId);
    else configCache.clear();
}

export async function isEnabled(guildId) {
    const cfg = await getConfig(guildId);
    return cfg.enabled === 1;
}

export async function setEnabled(guildId, enabled) {
    await pool.execute(
        `INSERT INTO owo_config (guild_id, enabled) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
        [guildId, enabled ? 1 : 0]
    );
    invalidateConfigCache(guildId);
}

// ── Gates ─────────────────────────────────────────────────────────────

export class OwoGateError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'OwoGateError';
        this.code = code;
    }
}

export async function assertSubcommandAllowed(guildId, subcommand) {
    const cfg = await getConfig(guildId);
    if (cfg.disabled_subcommands.includes(subcommand)) {
        throw new OwoGateError(
            `🚫 The \`/owo ${subcommand}\` subcommand is disabled in this server.`,
            'subcommand_disabled'
        );
    }
}

export async function assertChannelAllowed(guildId, channelId) {
    const cfg = await getConfig(guildId);
    if (cfg.allowed_channel_ids.length === 0) return;
    if (!cfg.allowed_channel_ids.includes(channelId)) {
        const list = cfg.allowed_channel_ids.slice(0, 3).map(id => `<#${id}>`).join(', ');
        throw new OwoGateError(
            `🚫 OwO is restricted to ${list}${cfg.allowed_channel_ids.length > 3 ? ' …' : ''} in this server.`,
            'channel_not_allowed'
        );
    }
}

export async function assertRolesAllowed(guildId, memberRoleIds) {
    const cfg = await getConfig(guildId);
    if (cfg.blocked_role_ids.length === 0) return;
    const ids = Array.isArray(memberRoleIds) ? memberRoleIds : Array.from(memberRoleIds ?? []);
    if (ids.some(id => cfg.blocked_role_ids.includes(id))) {
        throw new OwoGateError('🚫 Your role prevents using the OwO module here.', 'role_blocked');
    }
}

// ── Hunt ─────────────────────────────────────────────────────────────

/**
 * Perform a hunt. Cooldown from owo_config, reward multipliers applied.
 * Writes to owo_animal (inventory), owo_animal_count (leaderboard aggregate),
 * credits cowoncy via economy-manager.
 *
 * Deliberately does NOT touch the server leveling system. Hunting is a game loop with its own
 * currency; wiring it into `user_levels` meant a member could out-rank everyone by spamming
 * `owoh` without ever talking, and the bot this replaces never granted server XP either.
 */
export async function hunt(guildId, userId) {
    const cfg = await getConfig(guildId);
    const cooldownMs = Math.max(1, cfg.hunt_cooldown_seconds) * 1000;

    // Cooldown check — keep using owo_cooldowns which still exists from mig 087
    const [cds] = await pool.execute(
        'SELECT used_at FROM owo_cooldowns WHERE guild_id = ? AND user_id = ? AND command = ?',
        [guildId, userId, 'hunt']
    );
    if (cds[0]) {
        const elapsed = Date.now() - new Date(cds[0].used_at).getTime();
        if (elapsed < cooldownMs) {
            return { cooldown: true, remainingMs: cooldownMs - elapsed };
        }
    }

    const result = await catalogRollHunt();
    if (!result.animal) {
        return { cooldown: false, error: 'No animal rolled — catalog empty for rank ' + result.rank };
    }

    const points = Math.max(1, Math.floor(result.points * cfg.reward_currency_multiplier));
    const currency = await getCurrencyMeta(guildId);

    await addCowoncy(guildId, userId, points, `OwO hunt: caught ${result.animal.name}`);

    // Inventory + count + cooldown in one transaction
    const conn = await pool.getConnection();
    let newCount = 1;
    try {
        await conn.beginTransaction();

        await conn.execute(
            `INSERT INTO owo_cooldowns (guild_id, user_id, command, used_at) VALUES (?, ?, 'hunt', NOW())
             ON DUPLICATE KEY UPDATE used_at = NOW()`,
            [guildId, userId]
        );

        // Upsert into owo_animal (inventory)
        await conn.execute(
            `INSERT INTO owo_animal (guild_id, id, name, count, totalcount) VALUES (?, ?, ?, 1, 1)
             ON DUPLICATE KEY UPDATE count = count + 1, totalcount = totalcount + 1`,
            [guildId, userId, result.animal.name]
        );

        const [[row]] = await conn.execute(
            'SELECT count FROM owo_animal WHERE guild_id = ? AND id = ? AND name = ?',
            [guildId, userId, result.animal.name]
        );
        newCount = row?.count ?? 1;

        // Upsert into owo_animal_count (aggregate)
        const rankCol = result.rank;
        // Dynamic column — validate against known ranks to prevent injection
        if (!listAllRanks().includes(rankCol)) {
            throw new Error(`Unknown rank: ${rankCol}`);
        }
        await conn.execute(
            `INSERT INTO owo_animal_count (guild_id, id, \`${rankCol}\`) VALUES (?, ?, 1)
             ON DUPLICATE KEY UPDATE \`${rankCol}\` = \`${rankCol}\` + 1`,
            [guildId, userId]
        );

        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }

    // Quest progress: bump the 'hunt' quest. The 'owo' quest is bumped by
    // the top-level slash dispatcher / prefix router so it fires for every
    // /owo subcommand (not just hunt) — don't double-count it here.
    progressQuest(guildId, userId, 'hunt', 1).catch(() => { /* swallow */ });

    return {
        cooldown: false,
        rank: result.rank,
        animal: result.animal,
        points,
        color: result.color,
        newCount,
        isFirstCatch: newCount === 1,
        currencyName: currency.name,
        currencyEmoji: currency.emoji,
        announceRare: cfg.announce_rare_catches === 1,
    };
}

// ── Zoo ──────────────────────────────────────────────────────────────

export async function getZoo(guildId, userId) {
    const [rows] = await pool.execute(
        `SELECT a.name, a.count, a.totalcount, a.xp, an.rank
         FROM owo_animal a
         LEFT JOIN owo_animals an ON an.name = a.name
         WHERE a.guild_id = ? AND a.id = ? AND a.count > 0
         ORDER BY FIELD(an.rank, ${listAllRanks().map(r => `'${r}'`).join(',')}), a.count DESC`,
        [guildId, userId]
    );

    const cat = await getCatalog();
    const grouped = {};
    for (const row of rows) {
        const meta = cat.byName[row.name];
        const rank = row.rank || meta?.rank || 'unknown';
        if (!grouped[rank]) grouped[rank] = [];
        grouped[rank].push({
            name: row.name,
            emoji: meta?.emoji || row.name,
            count: Number(row.count),
            totalcount: Number(row.totalcount),
            xp: Number(row.xp || 0),
        });
    }

    const [[totals]] = await pool.execute(
        `SELECT COUNT(*) AS unique_animals, COALESCE(SUM(count), 0) AS total_catches
         FROM owo_animal WHERE guild_id = ? AND id = ? AND count > 0`,
        [guildId, userId]
    );

    const catalogSize = Object.keys(cat.byName).length;
    return {
        grouped,
        uniqueAnimals: Number(totals?.unique_animals) || 0,
        totalCatches: Number(totals?.total_catches) || 0,
        catalogSize,
        completionPct: catalogSize ? (Number(totals?.unique_animals) / catalogSize * 100) : 0,
    };
}

// ── Leaderboard ──────────────────────────────────────────────────────

export async function getLeaderboard(guildId, limit = 10) {
    const [rows] = await pool.execute(
        `SELECT id AS user_id, total, common, uncommon, rare, epic, mythical, legendary, fabled, hidden
         FROM owo_animal_count
         WHERE guild_id = ?
         ORDER BY total DESC LIMIT ?`,
        [guildId, limit]
    );
    return rows.map(r => ({
        user_id: r.user_id,
        total: Number(r.total),
        unique_animals: ['common','uncommon','rare','epic','mythical','legendary','fabled','hidden']
            .reduce((sum, k) => sum + (Number(r[k]) > 0 ? 1 : 0), 0),
        byRank: {
            common: Number(r.common), uncommon: Number(r.uncommon), rare: Number(r.rare),
            epic: Number(r.epic), mythical: Number(r.mythical), legendary: Number(r.legendary),
        },
    }));
}

// ── Sell / Sacrifice (keep-1-of-each, upstream pattern) ──────────────

function sellPriceFor(rank, cfg) {
    const base = RANK_META[rank]?.price || 1;
    return Math.max(1, Math.floor(base * (cfg?.sell_multiplier ?? 0.5)));
}
function sacrificeXpFor(rank, cfg) {
    const base = RANK_META[rank]?.xp || 1;
    return Math.max(1, Math.floor(base * (cfg?.sacrifice_xp_multiplier ?? 1.0)));
}

export async function sellRank(guildId, userId, rank) {
    if (!RANK_META[rank]) return { error: `Unknown rank: ${rank}` };
    const cfg = await getConfig(guildId);

    const [rows] = await pool.execute(
        `SELECT a.name, a.count
         FROM owo_animal a
         JOIN owo_animals an ON an.name = a.name
         WHERE a.guild_id = ? AND a.id = ? AND an.rank = ? AND a.count > 1`,
        [guildId, userId, rank]
    );
    if (!rows.length) return { sold: 0, currency: 0, kept: 0, pricePer: sellPriceFor(rank, cfg) };

    let totalSold = 0;
    const pricePer = sellPriceFor(rank, cfg);

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        for (const row of rows) {
            const excess = row.count - 1;
            await conn.execute(
                `UPDATE owo_animal SET count = 1, sellcount = sellcount + ?
                 WHERE guild_id = ? AND id = ? AND name = ?`,
                [excess, guildId, userId, row.name]
            );
            totalSold += excess;
        }
        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }

    const totalCurrency = totalSold * pricePer;
    if (totalCurrency > 0) {
        await addCowoncy(guildId, userId, totalCurrency, `OwO sell: ${totalSold} ${rank} dupes`);
    }
    return { sold: totalSold, currency: totalCurrency, pricePer };
}

/**
 * Sacrifice every duplicate of a rank. Yields essence (the `xp` field), which is OwO's own
 * currency — it is NOT server XP and never touches the leveling system. See `hunt()`.
 */
export async function sacrificeRank(guildId, userId, rank) {
    if (!RANK_META[rank]) return { error: `Unknown rank: ${rank}` };
    const cfg = await getConfig(guildId);

    const [rows] = await pool.execute(
        `SELECT a.name, a.count
         FROM owo_animal a
         JOIN owo_animals an ON an.name = a.name
         WHERE a.guild_id = ? AND a.id = ? AND an.rank = ? AND a.count > 1`,
        [guildId, userId, rank]
    );
    if (!rows.length) return { sacrificed: 0, xp: 0, xpPer: sacrificeXpFor(rank, cfg) };

    const xpPer = sacrificeXpFor(rank, cfg);
    let totalSac = 0;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        for (const row of rows) {
            const excess = row.count - 1;
            await conn.execute(
                `UPDATE owo_animal SET count = 1, saccount = saccount + ?
                 WHERE guild_id = ? AND id = ? AND name = ?`,
                [excess, guildId, userId, row.name]
            );
            totalSac += excess;
        }
        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }

    return { sacrificed: totalSac, xp: totalSac * xpPer, xpPer };
}

// ── Stats ────────────────────────────────────────────────────────────

export async function getStats(guildId, userId) {
    const [[totals]] = await pool.execute(
        `SELECT COUNT(*) AS unique_animals, COALESCE(SUM(count), 0) AS total_catches
         FROM owo_animal WHERE guild_id = ? AND id = ? AND count > 0`,
        [guildId, userId]
    );

    const [[agg]] = await pool.execute(
        `SELECT * FROM owo_animal_count WHERE guild_id = ? AND id = ?`,
        [guildId, userId]
    );

    const byRank = {};
    if (agg) {
        for (const rank of listAllRanks()) {
            const count = Number(agg[rank]) || 0;
            if (count > 0) byRank[rank] = { total: count };
        }
    }

    // Rarest find — pick the animal in the rarest owned rank. listAllRanks
    // is ordered common→distorted; FIELD() treats not-found as 0 so reversing
    // makes the rarest rank sort highest.
    const rarestOrder = [...listAllRanks()].reverse();
    const [[rarest]] = await pool.execute(
        `SELECT a.name, an.rank
         FROM owo_animal a
         JOIN owo_animals an ON an.name = a.name
         WHERE a.guild_id = ? AND a.id = ? AND a.count > 0
         ORDER BY FIELD(an.rank, ${rarestOrder.map(r => `'${r}'`).join(',')}) DESC
         LIMIT 1`,
        [guildId, userId]
    );

    const cat = await getCatalog();
    const rarestMeta = rarest ? cat.byName[rarest.name] : null;

    const wallet = await getCowoncy(guildId, userId);

    return {
        uniqueAnimals: Number(totals?.unique_animals) || 0,
        totalCatches: Number(totals?.total_catches) || 0,
        byRank,
        rarest: rarestMeta ? { ...rarestMeta } : null,
        wallet,
    };
}

// ── Admin ops ────────────────────────────────────────────────────────

export async function resetUserZoo(guildId, userId) {
    const [a] = await pool.execute('DELETE FROM owo_animal WHERE guild_id = ? AND id = ?', [guildId, userId]);
    const [c] = await pool.execute('DELETE FROM owo_animal_count WHERE guild_id = ? AND id = ?', [guildId, userId]);
    const [cd] = await pool.execute('DELETE FROM owo_cooldowns WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    return {
        zooRowsRemoved: a.affectedRows,
        countRowsRemoved: c.affectedRows,
        cooldownsRemoved: cd.affectedRows,
    };
}

export async function resetGuildZoo(guildId) {
    const [a] = await pool.execute('DELETE FROM owo_animal WHERE guild_id = ?', [guildId]);
    const [c] = await pool.execute('DELETE FROM owo_animal_count WHERE guild_id = ?', [guildId]);
    const [cd] = await pool.execute('DELETE FROM owo_cooldowns WHERE guild_id = ?', [guildId]);
    return {
        zooRowsRemoved: a.affectedRows,
        countRowsRemoved: c.affectedRows,
        cooldownsRemoved: cd.affectedRows,
    };
}

export async function grantAnimal(guildId, userId, animalName, count = 1) {
    const animal = await getAnimal(animalName);
    if (!animal) return { error: `Unknown animal: ${animalName}` };
    const n = Math.trunc(Number(count) || 0);
    if (n === 0) return { error: 'count must be non-zero' };

    if (n > 0) {
        await pool.execute(
            `INSERT INTO owo_animal (guild_id, id, name, count, totalcount) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE count = count + VALUES(count), totalcount = totalcount + VALUES(totalcount)`,
            [guildId, userId, animalName, n, n]
        );
        if (listAllRanks().includes(animal.rank)) {
            await pool.execute(
                `INSERT INTO owo_animal_count (guild_id, id, \`${animal.rank}\`) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE \`${animal.rank}\` = \`${animal.rank}\` + VALUES(\`${animal.rank}\`)`,
                [guildId, userId, n]
            );
        }
    } else {
        await pool.execute(
            `UPDATE owo_animal SET count = GREATEST(0, count + ?)
             WHERE guild_id = ? AND id = ? AND name = ?`,
            [n, guildId, userId, animalName]
        );
    }

    const [[row]] = await pool.execute(
        'SELECT count FROM owo_animal WHERE guild_id = ? AND id = ? AND name = ?',
        [guildId, userId, animalName]
    );
    return { animalName, rank: animal.rank, newCount: Number(row?.count) || 0 };
}

// ── Catalog passthroughs + legacy aliases ────────────────────────────

export { RANK_META as RANKS, RANK_COLORS, invalidateCatalog, getCatalog, getAnimal, getAnimalsByRank };

// Legacy API surface kept for existing commands/dashboard during transition.
// Returns the full catalog grouped by rank (legacy `ANIMALS` object).
export async function listCatalog() {
    const cat = await getCatalog();
    return Object.keys(RANK_META)
        .sort((a, b) => RANK_META[a].order - RANK_META[b].order)
        .map(rank => ({
            rank,
            ...RANK_META[rank],
            emoji: RANK_META[rank].placeholder?.[0] || '',
            color: RANK_COLORS[rank],
            animals: (cat.byRank[rank] || []).map(a => ({
                name: a.name,
                key: a.name.replace(/^:|:$/g, ''),
                emoji: a.emoji,
                rank,
            })),
        }));
}

// Legacy ANIMALS/RANKS accessors — some older UI code may reference these.
export const ANIMALS = new Proxy({}, {
    get(_, rank) {
        // Synchronous lookup — returns empty array if catalog not loaded yet.
        // For UI use listCatalog() instead.
        return [];
    },
});

// Re-exports so old command files that imported these names keep working.
export {
    getCowoncy as getBalance,
    addCowoncy,
    removeCowoncy,
    transferCowoncy as transferCurrency,
    claimDailyCowoncy as claimDaily,
};
