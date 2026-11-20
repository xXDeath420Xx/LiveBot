/*
 * The zoo: hunting, selling and sacrificing duplicates, essence feeding, zoo / stats / catalog views and the hunt
 * leaderboard.
 */
import { q, T, withTx, CritterError } from './db.js';
import { TIERS, TIER_KEYS, tierByKey, tierIndex, AUDITABLE_TIERS } from './data/tiers.js';
import { SPECIES, speciesByKey, speciesInTier, resolveSpecies, CATALOG_SIZE } from './data/species.js';
import { ESSENCE_FEED_XP, petLevel } from './data/economy.js';
import {
    huntCount, luckTierOf, rollCatches, huntCurrency, huntXp, groupCatches, burnGems, tierWeights,
} from './rules/game-rules.js';
import { claimCooldown, credit, readWallet, spendWalletField, addWalletField } from './store.js';
import { getConfig } from './config.js';
import { readActiveGems, writeGemBurns, rollLootboxDrop } from './gems.js';
import { giveTeamXp } from './teams.js';
import { bumpQuest } from './quests.js';
import { maybeSpawnBoss } from './boss.js';
import logger from '../../utils/logger.js';

const tierCols = TIER_KEYS.join(', ');

/** Add catches to the inventory and the per-tier counters (inside a transaction). */
export async function addCatches(conn, g, u, grouped) {
    for (const { species, count } of grouped) {
        await q(`INSERT INTO ${T('owned')} (guild_id, user_id, species, count, total_caught, first_caught_at) VALUES (?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE count = count + VALUES(count), total_caught = total_caught + VALUES(total_caught)`,
            [g, u, species.key, count, count], conn);
    }
    const perTier = Object.fromEntries(TIER_KEYS.map(k => [k, 0]));
    for (const { species, count } of grouped) perTier[species.tier] += count;
    await q(`INSERT INTO ${T('tier_counts')} (guild_id, user_id, ${tierCols}) VALUES (?, ?, ${TIER_KEYS.map(() => '?').join(', ')})
             ON DUPLICATE KEY UPDATE ${TIER_KEYS.map(k => `${k} = ${k} + VALUES(${k})`).join(', ')}`,
        [g, u, ...TIER_KEYS.map(k => perTier[k])], conn);
    // Hourly guild totals (no member ids) for the dashboard's "last 24 h" figure; pruned by the boss reaper job.
    const hour = new Date();
    hour.setMinutes(0, 0, 0);
    const n = grouped.reduce((s, x) => s + x.count, 0);
    await q(`INSERT INTO ${T('catch_hours')} (guild_id, hour_at, catches) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE catches = catches + VALUES(catches)`, [g, hour, n], conn);
}

/** Drop hourly catch totals older than 8 days. */
export async function pruneCatchHours({ now = new Date() } = {}) {
    const r = await q(`DELETE FROM ${T('catch_hours')} WHERE hour_at < ?`, [new Date(now.getTime() - 8 * 24 * 3600 * 1000)]);
    return r.affectedRows;
}

/**
 * Hunt.
 * Errors: COOLDOWN (data.msLeft, data.readyAt).
 * @returns {{ catches: {species, count, owned, totalCaught}[], total, currency, balance, xp, gems: {gem, before, after, length}[],
 *   teamXp: object|null, lootbox: object, rarest: {species, tier, owned, firstCatch}, announceRare: boolean,
 *   rollChancePct: number, boss: object|null, currency_meta }}
 */
export async function hunt(guildId, userId, { channelId = null, rng = Math.random, now = new Date(), allowBossSpawn = true } = {}) {
    const g = String(guildId);
    const u = String(userId);
    const cfg = await getConfig(g);
    const cooldownMs = Math.max(1, cfg.hunt_cooldown_seconds) * 1000;
    const res = await withTx(async (conn) => {
        const cd = await claimCooldown(conn, g, u, 'hunt', cooldownMs, now);
        if (!cd.ok) throw new CritterError('COOLDOWN', `You can hunt again in ${Math.ceil(cd.msLeft / 1000)}s.`, cd);
        const active = await readActiveGems(conn, g, u, { lock: true });
        const n = huntCount(active);
        const luck = luckTierOf(active);
        const caught = rollCatches(n, luck, rng);
        const grouped = groupCatches(caught);
        await addCatches(conn, g, u, grouped);
        const currency = huntCurrency(caught, cfg.reward_currency_multiplier);
        const balance = await credit(conn, g, u, currency);
        const burns = burnGems(active, n);
        await writeGemBurns(conn, g, u, burns);
        const keys = grouped.map(x => x.species.key);
        const rows = await q(`SELECT species, count, total_caught FROM ${T('owned')} WHERE guild_id = ? AND user_id = ? AND species IN (?)`, [g, u, keys], conn);
        const byKey = new Map(rows.map(r => [r.species, r]));
        return { caught, grouped, currency, balance, burns, luck, byKey };
    });
    const catches = res.grouped.map(({ species, count }) => ({
        species, count, owned: Number(res.byKey.get(species.key)?.count) || count, totalCaught: Number(res.byKey.get(species.key)?.total_caught) || count,
    }));
    const rarestEntry = catches[catches.length - 1];
    const rarestTier = tierByKey(rarestEntry.species.tier);
    const weights = tierWeights(res.luck);
    const wTotal = weights.reduce((s, w) => s + w.weight, 0);
    const tierChance = weights.find(w => w.tier.key === rarestTier.key).weight / wTotal;
    const out = {
        catches,
        total: res.caught.length,
        currency: res.currency,
        balance: res.balance,
        xp: huntXp(res.caught, cfg.reward_xp_multiplier),
        gems: res.burns.map(b => ({ gemId: b.gemId, before: b.before, after: b.after })),
        teamXp: null,
        lootbox: null,
        rarest: { species: rarestEntry.species, tier: rarestTier, owned: rarestEntry.owned, firstCatch: rarestEntry.totalCaught === rarestEntry.count },
        announceRare: cfg.announce_rare_catches && AUDITABLE_TIERS.includes(rarestTier.key),
        rollChancePct: Math.round((tierChance / Math.max(1, speciesInTier(rarestTier.key).length)) * 1e6) / 1e4,
        boss: null,
    };
    // After the commit: none of these may cost the member their hunt.
    try { out.teamXp = await giveTeamXp(g, u, out.xp); } catch (e) { logger.warn('[critters] team xp failed', { error: e.message }); }
    try { out.lootbox = await rollLootboxDrop(g, u, { rng, now }); } catch (e) { logger.warn('[critters] lootbox drop failed', { error: e.message }); }
    try { await bumpQuest(g, u, 'hunt', out.total); } catch (e) { logger.warn('[critters] quest bump failed', { error: e.message }); }
    if (allowBossSpawn && channelId) {
        try { out.boss = await maybeSpawnBoss(g, channelId, { rng, now }); } catch (e) { logger.warn('[critters] boss spawn failed', { error: e.message }); }
    }
    return out;
}

function tierOrThrow(rank) {
    const t = tierByKey(rank);
    if (!t) throw new CritterError('BAD_TIER', `Pick a tier: ${TIER_KEYS.join(', ')}.`);
    return t;
}

/** Sell every duplicate of a tier (keeps one of each). Returns { tier, sold, price, currency, balance }; sold 0 = nothing to sell. */
export async function sellDuplicates(guildId, userId, rank) {
    const g = String(guildId); const u = String(userId);
    const tier = tierOrThrow(rank);
    const cfg = await getConfig(g);
    const price = Math.max(1, Math.floor(tier.sell * cfg.sell_multiplier));
    const keys = speciesInTier(tier.key).map(s => s.key);
    return withTx(async (conn) => {
        const rows = await q(`SELECT species, count FROM ${T('owned')} WHERE guild_id = ? AND user_id = ? AND species IN (?) AND count > 1 FOR UPDATE`, [g, u, keys], conn);
        let sold = 0;
        for (const r of rows) {
            const extra = Number(r.count) - 1;
            sold += extra;
            await q(`UPDATE ${T('owned')} SET count = 1, sold = sold + ? WHERE guild_id = ? AND user_id = ? AND species = ?`, [extra, g, u, r.species], conn);
        }
        const currency = sold * price;
        const balance = sold > 0 ? await credit(conn, g, u, currency) : (await readWallet(conn, g, u)).balance;
        return { tier, sold, price, currency, balance };
    });
}

/**
 * Sacrifice every duplicate of a tier for essence (persisted in the wallet). Essence is spent with feedEssence.
 * Returns { tier, sacrificed, essencePer, essence, essenceTotal }.
 */
export async function sacrificeDuplicates(guildId, userId, rank) {
    const g = String(guildId); const u = String(userId);
    const tier = tierOrThrow(rank);
    const cfg = await getConfig(g);
    const per = Math.max(1, Math.floor(tier.essence * cfg.sacrifice_xp_multiplier));
    const keys = speciesInTier(tier.key).map(s => s.key);
    return withTx(async (conn) => {
        const rows = await q(`SELECT species, count FROM ${T('owned')} WHERE guild_id = ? AND user_id = ? AND species IN (?) AND count > 1 FOR UPDATE`, [g, u, keys], conn);
        let n = 0;
        for (const r of rows) {
            const extra = Number(r.count) - 1;
            n += extra;
            await q(`UPDATE ${T('owned')} SET count = 1, sacrificed = sacrificed + ? WHERE guild_id = ? AND user_id = ? AND species = ?`, [extra, g, u, r.species], conn);
        }
        const essence = n * per;
        const essenceTotal = n > 0 ? await addWalletField(conn, g, u, 'essence', essence) : (await readWallet(conn, g, u)).essence;
        return { tier, sacrificed: n, essencePer: per, essence, essenceTotal };
    });
}

/**
 * Feed essence to an owned critter: each essence gives it ESSENCE_FEED_XP pet XP.
 * Errors: UNKNOWN_SPECIES, NOT_OWNED, BAD_AMOUNT, NOT_ENOUGH_ESSENCE.
 */
export async function feedEssence(guildId, userId, speciesQuery, amount) {
    const g = String(guildId); const u = String(userId);
    const species = resolveSpecies(speciesQuery);
    if (!species) throw new CritterError('UNKNOWN_SPECIES', 'There is no critter by that name.');
    const a = Math.floor(Number(amount));
    if (!Number.isSafeInteger(a) || a < 1) throw new CritterError('BAD_AMOUNT', 'Feed at least 1 essence.');
    return withTx(async (conn) => {
        const [row] = await q(`SELECT xp, count FROM ${T('owned')} WHERE guild_id = ? AND user_id = ? AND species = ? FOR UPDATE`, [g, u, species.key], conn);
        if (!row || Number(row.count) < 1) throw new CritterError('NOT_OWNED', `You do not have a ${species.name}.`);
        if (!(await spendWalletField(conn, g, u, 'essence', a))) throw new CritterError('NOT_ENOUGH_ESSENCE', 'You do not have that much essence.');
        const before = Number(row.xp);
        const after = before + a * ESSENCE_FEED_XP;
        await q(`UPDATE ${T('owned')} SET xp = ? WHERE guild_id = ? AND user_id = ? AND species = ?`, [after, g, u, species.key], conn);
        const w = await readWallet(conn, g, u);
        return { species, xpGained: after - before, xp: after, levelBefore: petLevel(before), level: petLevel(after), essenceLeft: w.essence };
    });
}

/** Zoo view: owned critters grouped by tier (rarest first), plus unique / catalog / total / completion. */
export async function getZoo(guildId, userId) {
    const rows = await q(`SELECT species, count, total_caught FROM ${T('owned')} WHERE guild_id = ? AND user_id = ?`, [String(guildId), String(userId)]);
    const groups = [];
    for (const tier of [...TIERS].reverse()) {
        const list = [];
        for (const r of rows) {
            const s = speciesByKey(r.species);
            if (s && s.tier === tier.key && Number(r.count) > 0) list.push({ species: s, count: Number(r.count) });
        }
        if (list.length) groups.push({ tier, species: list.sort((a, b) => a.species.key.localeCompare(b.species.key)) });
    }
    const unique = rows.filter(r => Number(r.total_caught) > 0 && speciesByKey(r.species)).length;
    const totalCatches = rows.reduce((s, r) => s + Number(r.total_caught || 0), 0);
    return { groups, uniqueAnimals: unique, totalCatches, catalogSize: CATALOG_SIZE, completionPct: Math.round((unique / CATALOG_SIZE) * 1000) / 10 };
}

/** Stats: per-tier catch totals, unique species, total catches, wallet and rarest owned species. */
export async function getStats(guildId, userId) {
    const g = String(guildId); const u = String(userId);
    const [tc] = await q(`SELECT * FROM ${T('tier_counts')} WHERE guild_id = ? AND user_id = ?`, [g, u]);
    const perTier = TIERS.map(t => ({ tier: t, count: Number(tc?.[t.key]) || 0 }));
    const other = Number(tc?.other) || 0;
    const zoo = await getZoo(g, u);
    const wallet = await readWallet(null, g, u);
    const rarest = zoo.groups.length ? zoo.groups[0].species[0].species : null;
    return {
        perTier, otherCatches: other, totalCatches: perTier.reduce((s, x) => s + x.count, 0) + other,
        uniqueAnimals: zoo.uniqueAnimals, catalogSize: CATALOG_SIZE, wallet, rarest,
    };
}

/** Catalog: every species per tier with the tier's roll chance (%). */
export function getCatalog() {
    const total = TIERS.reduce((s, t) => s + t.weight, 0);
    return TIERS.map(t => ({
        tier: t, chancePct: Math.round((t.weight / total) * 1e5) / 1e3,
        species: speciesInTier(t.key),
    }));
}

/**
 * Hunt leaderboard: top members by real catch count (sum of tier counters), with real unique-species counts.
 * Rows: { userId, total, unique }.
 */
export async function huntLeaderboard(guildId, limit = 10) {
    const n = Math.max(1, Math.min(25, Math.floor(Number(limit) || 10)));
    const sum = [...TIER_KEYS, 'other'].map(k => `tc.${k}`).join(' + ');
    const rows = await q(`SELECT tc.user_id, (${sum}) AS total,
            (SELECT COUNT(*) FROM ${T('owned')} o WHERE o.guild_id = tc.guild_id AND o.user_id = tc.user_id AND o.total_caught > 0) AS uniq
        FROM ${T('tier_counts')} tc WHERE tc.guild_id = ? HAVING total > 0 ORDER BY total DESC, uniq DESC LIMIT ?`, [String(guildId), n]);
    return rows.map(r => ({ userId: r.user_id, total: Number(r.total), unique: Number(r.uniq) }));
}

export { SPECIES };
