/*
 * Dashboard / admin services. All guild-scoped; the API layer checks the caller is a guild admin.
 * Every read comes from the real critter tables (inventory, catalog, game wallet).
 */
import { q, T, withTx, CritterError } from './db.js';
import { CURRENCY } from './constants.js';
import { TIERS, TIER_KEYS, tierByKey } from './data/tiers.js';
import { speciesInTier, resolveSpecies, speciesByKey } from './data/species.js';
import { readWallet } from './store.js';
import { getZoo, addCatches } from './zoo.js';
import { listWeapons } from './weapons.js';
import { listTeams, getTeam } from './teams.js';
import { autohuntStatus } from './passive.js';
import { getLuck } from './social.js';
import { ranchRate, ranchHours } from './rules/game-rules.js';
import { readCooldown } from './store.js';

export { grantCurrency } from './wallet.js';
export { grantShards, grantCrates } from './weapons.js';
export { grantLootboxes } from './gems.js';

const ID = /^\d{15,25}$/;
export function assertUserId(id) {
    if (!ID.test(String(id || ''))) throw new CritterError('BAD_USER_ID', 'That is not a valid user id.');
    return String(id);
}

/** KPIs: { hunters, uniqueCatches, totalCatches, last24hCatches, byRank: [{ rank, uniqueAnimals, total }], topHunters: [{ userId, total, uniqueAnimals }] } */
export async function dashboardStats(guildId, { now = new Date() } = {}) {
    const g = String(guildId);
    const sum = [...TIER_KEYS, 'other'].map(k => k).join(' + ');
    const [h] = await q(`SELECT COUNT(*) AS hunters, COALESCE(SUM(${sum}), 0) AS total FROM ${T('tier_counts')} WHERE guild_id = ?`, [g]);
    const [u] = await q(`SELECT COUNT(DISTINCT species) AS n FROM ${T('owned')} WHERE guild_id = ? AND total_caught > 0`, [g]);
    const since = new Date(now.getTime() - 24 * 3600 * 1000);
    const [l] = await q(`SELECT COALESCE(SUM(catches), 0) AS n FROM ${T('catch_hours')} WHERE guild_id = ? AND hour_at > ?`, [g, since]);
    const totals = await q(`SELECT ${TIER_KEYS.map(k => `COALESCE(SUM(${k}), 0) AS ${k}`).join(', ')} FROM ${T('tier_counts')} WHERE guild_id = ?`, [g]);
    const owned = await q(`SELECT species FROM ${T('owned')} WHERE guild_id = ? AND total_caught > 0 GROUP BY species`, [g]);
    const byRank = TIERS.map(t => ({
        rank: t.key, total: Number(totals[0]?.[t.key]) || 0,
        uniqueAnimals: owned.filter(r => speciesByKey(r.species)?.tier === t.key).length,
    }));
    const top = await q(`SELECT tc.user_id, (${[...TIER_KEYS, 'other'].map(k => `tc.${k}`).join(' + ')}) AS total,
        (SELECT COUNT(*) FROM ${T('owned')} o WHERE o.guild_id = tc.guild_id AND o.user_id = tc.user_id AND o.total_caught > 0) AS uniq
        FROM ${T('tier_counts')} tc WHERE tc.guild_id = ? ORDER BY total DESC LIMIT 10`, [g]);
    return {
        hunters: Number(h.hunters), uniqueCatches: Number(u.n), totalCatches: Number(h.total), last24hCatches: Number(l.n), byRank,
        topHunters: top.map(r => ({ userId: r.user_id, total: Number(r.total), uniqueAnimals: Number(r.uniq) })),
    };
}

/** Catalog for the dashboard: per tier { rank, name, rarity (%), order, price, points, essence, xp, ranch, emoji, color, animals }. */
export function dashboardCatalog() {
    const total = TIERS.reduce((s, t) => s + t.weight, 0);
    return TIERS.map(t => ({
        rank: t.key, name: t.name, rarity: Math.round((t.weight / total) * 1e5) / 1e3, order: t.order, price: t.sell, points: t.points,
        essence: t.essence, xp: t.xp, ranch: t.ranch, emoji: t.icon, color: `#${t.color.toString(16).padStart(6, '0')}`,
        animals: speciesInTier(t.key).map(s => ({ name: s.name, key: s.key, emoji: s.emoji, rank: s.tier, stats: s.stats, description: s.description })),
    }));
}

/** Reward per tier after the server's currency multiplier (for the dashboard's live table). */
export function rewardTable(multiplier = 1) {
    const total = TIERS.reduce((s, t) => s + t.weight, 0);
    return TIERS.map(t => ({ rank: t.key, name: t.name, chancePct: Math.round((t.weight / total) * 1e5) / 1e3, reward: Math.max(1, Math.floor(t.points * multiplier)), currency: CURRENCY.name }));
}

export async function userZoo(guildId, userId) {
    return getZoo(String(guildId), assertUserId(userId));
}

async function resetWhere(conn, g, u) {
    const userClause = u ? ' AND user_id = ?' : '';
    const params = u ? [g, u] : [g];
    const pids = (await q(`SELECT pid FROM ${T('owned')} WHERE guild_id = ?${userClause}`, params, conn)).map(r => Number(r.pid));
    if (pids.length) {
        await q(`DELETE FROM ${T('team_slots')} WHERE pid IN (?)`, [pids], conn);
        await q(`UPDATE ${T('weapons')} SET pet_pid = NULL WHERE pet_pid IN (?)`, [pids], conn);
    }
    const a = await q(`DELETE FROM ${T('owned')} WHERE guild_id = ?${userClause}`, params, conn);
    const b = await q(`DELETE FROM ${T('tier_counts')} WHERE guild_id = ?${userClause}`, params, conn);
    const c = await q(`DELETE FROM ${T('cooldowns')} WHERE guild_id = ?${userClause}`, params, conn);
    return { zooRowsRemoved: a.affectedRows, countRowsRemoved: b.affectedRows, cooldownsRemoved: c.affectedRows };
}

/** Delete one member's critters, tier counters and every cooldown in this guild. */
export async function resetUser(guildId, userId) {
    const u = assertUserId(userId);
    return withTx(conn => resetWhere(conn, String(guildId), u));
}

/** Same for every member of the guild. Requires { confirm: true }. Errors: CONFIRM_REQUIRED. */
export async function resetGuild(guildId, { confirm = false } = {}) {
    if (confirm !== true) throw new CritterError('CONFIRM_REQUIRED', 'Send confirm: true to reset every zoo on this server.');
    return withTx(conn => resetWhere(conn, String(guildId), null));
}

/**
 * Grant (count > 0) or remove (count < 0, floored at 0) a species. Removal also lowers the tier counter by the
 * number actually removed. Errors: BAD_USER_ID, UNKNOWN_SPECIES, BAD_AMOUNT. Returns { animalName, rank, newCount }.
 */
export async function grantAnimal(guildId, userId, animalKey, count) {
    const g = String(guildId); const u = assertUserId(userId);
    const species = resolveSpecies(animalKey);
    if (!species) throw new CritterError('UNKNOWN_SPECIES', 'There is no critter by that name.');
    const n = Math.trunc(Number(count));
    if (!Number.isSafeInteger(n) || n === 0) throw new CritterError('BAD_AMOUNT', 'The count must be a non-zero whole number.');
    return withTx(async (conn) => {
        if (n > 0) {
            await addCatches(conn, g, u, [{ species, count: n }]);
        } else {
            const [r] = await q(`SELECT count FROM ${T('owned')} WHERE guild_id = ? AND user_id = ? AND species = ? FOR UPDATE`, [g, u, species.key], conn);
            const removed = Math.min(Number(r?.count) || 0, -n);
            if (removed > 0) {
                await q(`UPDATE ${T('owned')} SET count = count - ? WHERE guild_id = ? AND user_id = ? AND species = ?`, [removed, g, u, species.key], conn);
                await q(`UPDATE ${T('tier_counts')} SET ${species.tier} = IF(${species.tier} >= ?, ${species.tier} - ?, 0) WHERE guild_id = ? AND user_id = ?`, [removed, removed, g, u], conn);
            }
        }
        const [after] = await q(`SELECT count FROM ${T('owned')} WHERE guild_id = ? AND user_id = ? AND species = ?`, [g, u, species.key], conn);
        return { animalName: species.name, animalKey: species.key, rank: species.tier, newCount: Number(after?.count) || 0 };
    });
}

/** Everything about one member, each part degrading to an empty default on error. */
export async function userFull(guildId, userId, { now = new Date() } = {}) {
    const g = String(guildId); const u = assertUserId(userId);
    const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
    const wallet = await safe(() => readWallet(null, g, u), { balance: 0, essence: 0, shards: 0 });
    const zoo = await safe(() => getZoo(g, u), { groups: [], uniqueAnimals: 0, totalCatches: 0 });
    const weapons = await safe(async () => { const l = await listWeapons(g, u, { limit: 10 }); return { total: l.total, top: l.weapons }; }, { total: 0, top: [] });
    const teams = await safe(() => listTeams(g, u), []);
    const activeTeam = await safe(() => getTeam(g, u), null);
    const autohunt = await safe(() => autohuntStatus(g, u, { now }), null);
    const quests = await safe(async () => (await q(`SELECT * FROM ${T('quests')} WHERE guild_id = ? AND user_id = ? ORDER BY slot`, [g, u])).map(r => ({
        slot: Number(r.slot), kind: r.kind, level: Number(r.level), prize: r.prize, prizeAmount: Number(r.prize_amount), progress: Number(r.progress), target: Number(r.target), claimed: r.claimed_at != null,
    })), []);
    const ranch = await safe(async () => {
        const last = await readCooldown(null, g, u, 'ranch');
        const rate = ranchRate(activeTeam ? activeTeam.slots.map(s => s.species.tier) : []);
        const h = last ? ranchHours(last, now) : { hours: 0 };
        return { ratePerHour: rate, lastClaimAt: last, hours: h.hours, pending: h.hours * rate };
    }, null);
    const luck = await safe(() => getLuck(g, u), null);
    return { wallet, shards: wallet.shards, zoo, weapons, teams, activeTeam, autohunt, quests, ranch, luck };
}

/**
 * Leaderboards: kind 'battle' (top 15 teams by wins then best streak), 'wealth' (top 15 game wallets),
 * 'hunters' (top 15 by catches, with per-tier counts). Errors: BAD_KIND.
 */
export async function leaderboard(guildId, kind) {
    const g = String(guildId);
    if (kind === 'battle') {
        const rows = await q(`SELECT user_id, name, wins, losses, streak, best_streak FROM ${T('teams')} WHERE guild_id = ? AND (wins > 0 OR losses > 0) ORDER BY wins DESC, best_streak DESC LIMIT 15`, [g]);
        return rows.map(r => ({ userId: r.user_id, teamName: r.name, wins: Number(r.wins), losses: Number(r.losses), streak: Number(r.streak), highestStreak: Number(r.best_streak) }));
    }
    if (kind === 'wealth') {
        const rows = await q(`SELECT user_id, balance FROM ${T('wallet')} WHERE guild_id = ? ORDER BY balance DESC LIMIT 15`, [g]);
        return rows.map(r => ({ userId: r.user_id, wallet: Number(r.balance) }));
    }
    if (kind === 'hunters') {
        const rows = await q(`SELECT * FROM ${T('tier_counts')} WHERE guild_id = ? ORDER BY (${[...TIER_KEYS, 'other'].join(' + ')}) DESC LIMIT 15`, [g]);
        return rows.map(r => ({ userId: r.user_id, total: [...TIER_KEYS, 'other'].reduce((s, k) => s + Number(r[k] || 0), 0), ...Object.fromEntries(TIER_KEYS.map(k => [k, Number(r[k]) || 0])) }));
    }
    throw new CritterError('BAD_KIND', 'Pick battle, wealth or hunters.');
}

/** Engagement tiles; each count is 0 on error. */
export async function moduleSnapshot(guildId) {
    const g = String(guildId);
    const one = async (sql) => { try { const [r] = await q(sql, [g]); return Number(r?.n) || 0; } catch { return 0; } };
    return {
        hunters: await one(`SELECT COUNT(*) AS n FROM ${T('tier_counts')} WHERE guild_id = ?`),
        weaponOwners: await one(`SELECT COUNT(DISTINCT user_id) AS n FROM ${T('weapons')} WHERE guild_id = ?`),
        teamOwners: await one(`SELECT COUNT(DISTINCT user_id) AS n FROM ${T('teams')} WHERE guild_id = ?`),
        battlesFought: await one(`SELECT COALESCE(SUM(wins + losses), 0) AS n FROM ${T('teams')} WHERE guild_id = ?`),
        autohuntActive: await one(`SELECT COUNT(*) AS n FROM ${T('autohunt')} WHERE guild_id = ?`),
        questHolders: await one(`SELECT COUNT(DISTINCT user_id) AS n FROM ${T('quests')} WHERE guild_id = ?`),
        ranchClaims: await one(`SELECT COUNT(*) AS n FROM ${T('cooldowns')} WHERE guild_id = ? AND action = 'ranch'`),
        luckRolls: await one(`SELECT COALESCE(SUM(rolls), 0) AS n FROM ${T('luck')} WHERE guild_id = ?`),
        cratesUnopened: await one(`SELECT COALESCE(SUM(crates), 0) AS n FROM ${T('boxes')} WHERE guild_id = ?`),
        totalShards: await one(`SELECT COALESCE(SUM(shards), 0) AS n FROM ${T('wallet')} WHERE guild_id = ?`),
    };
}

/** The ten core commands the dashboard lists with switches. enabled = not in disabled_subcommands. */
export const CORE_COMMANDS = Object.freeze([
    { name: 'hunt', slash: '/owo hunt', prefix: 'owo hunt', aliases: ['owoh', 'owo catch'], category: 'Actions', description: 'Go looking for critters.' },
    { name: 'sell', slash: '/owo sell', prefix: 'owo sell', aliases: [], category: 'Actions', description: 'Sell spare critters of one tier.' },
    { name: 'sacrifice', slash: '/owo sacrifice', prefix: 'owo sacrifice', aliases: ['owo sac'], category: 'Actions', description: 'Turn spare critters into essence.' },
    { name: 'daily', slash: '/owo daily', prefix: 'owo daily', aliases: [], category: 'Economy', description: 'Collect daily acorns.' },
    { name: 'balance', slash: '/owo balance', prefix: 'owo balance', aliases: ['owo bal', 'owo cash'], category: 'Economy', description: 'Check your acorns.' },
    { name: 'give', slash: '/owo give', prefix: 'owo give', aliases: ['owo send'], category: 'Economy', description: 'Give acorns to another member.' },
    { name: 'zoo', slash: '/owo zoo', prefix: 'owo zoo', aliases: ['owoz'], category: 'Viewers', description: 'See the critters you have.' },
    { name: 'leaderboard', slash: '/owo leaderboard', prefix: 'owo top', aliases: ['owo leaderboard'], category: 'Viewers', description: 'Top hunters on this server.' },
    { name: 'catalog', slash: '/owo catalog', prefix: 'owo catalog', aliases: ['owo dex'], category: 'Viewers', description: 'Every critter there is to find.' },
    { name: 'stats', slash: '/owo stats', prefix: 'owo stats', aliases: ['owo me'], category: 'Viewers', description: 'Your hunting numbers.' },
]);

export function commandSwitches(config) {
    const off = new Set(config?.disabled_subcommands || []);
    return CORE_COMMANDS.map(c => ({ ...c, enabled: !off.has(c.name) }));
}

export { tierByKey };
