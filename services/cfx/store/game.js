// Greenhouse Tycoon (cfx v2): gameplay (phase 2). Every action runs in ONE transaction that locks the
// account row first (ledger.lockAccount), so all writes for one account are serialised; every cash and item
// change goes through ledger.applyInTx; inputs were validated by the HTTP schemas and are re-checked here.
//
// Paying exactly once:
//   Actions with a natural identity use it as the ledger key, so a double click, a retry or a race can only
//   pay once whatever Idempotency-Key the client sent:
//     harvest:<slot>:<plant_seq>   the plot is cleared with UPDATE ... WHERE plant_seq = ? AND variety_id IS NOT NULL
//     order-fill:<id>              UPDATE ... WHERE status = 'open'
//     daily:<YYYY-MM-DD>           plus gh_daily_claims UNIQUE (account, day) and (identity, day)
//     breedclaim:<id>, upgrade:r<replants>:<code>:<level>, boost:<slot>:<seq>:<boost id>, staff:<hash of the clocks>
//   Free-form actions (plant, sell, buy, hire, breed) use the client's Idempotency-Key, prefixed with the
//   action: a retry replays the stored result; the same key for a different change is IDEMPOTENCY_MISMATCH.
//
// Time comes from store.now (injectable), never from Date.now() here, so tests run on a fake clock.
import crypto from 'node:crypto';
import { gameError, isGameError } from '../lib/errors.js';
import { withTx } from './tx.js';
import { normalizeOp } from './ledger.js';
import { BASE_VARIETIES, STAFF_TYPES, UPGRADE_NODES, BOOSTS, baseVariety, staffType, upgradeNode, boostById, isHybridId } from '../config/catalog.js';
import { TUNING, QUALITY_BANDS, DAY_MS, OFFLINE_CAP_MS, FIRST_HYBRID_ID, LIMITS, GROWTH, STARTER_KIT, SEASON_LENGTH_DAYS, NAMES, REPLANT, DECORATIONS_RULES, SEASON, SEASON_SCORE, QUESTS } from '../config/game.js';
import { BUYER_NAMES, QUALITY_NAMES, GAME_TITLE, BRAND, DECORATION_NAMES, REVIEW_NOTE } from '../config/copy.js';
import { DECORATIONS, decoration as decorationDef } from '../config/catalog.js';
import { withPrestige, replantBonus, canReplant, boostedXp, clearingOps, salePoints } from '../domain/meta.js';
import { pointsFor } from '../domain/season-score.js';
import { createMeta } from './meta.js';
import { readyAt, harvestYield, qualityBand } from '../domain/growth.js';
import { saleTotal, levelForXp, xpForLevel, QUALITY_PRICE_PCT } from '../domain/economy.js';
import { offlineClaim } from '../domain/staff.js';
import { crossVarieties, parentPair } from '../domain/breeding.js';
import { demandPct, demandChangePct, dayIndex, dayString, MAX_DAILY_SWING } from '../domain/market.js';
import { createRng, hashSeed } from '../domain/rng.js';
import * as R from '../domain/rules.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Ledger key for a free-form action: '<action>:<client key>', hashed if it would pass 64 characters. */
export function actionKey(action, clientKey) {
    const k = `${action}:${clientKey}`;
    return k.length <= 64 ? k : `${action}:${sha(clientKey).slice(0, 40)}`;
}

function publicVariety(v) {
    return {
        id: v.id,
        code: v.code || null,
        name: v.name,
        rarity: v.rarity,
        growMs: v.growMs,
        baseYield: v.baseYield,
        basePrice: v.basePrice,
        seedPrice: R.seedPrice(v),
        unlockLevel: v.hybrid ? null : v.unlockLevel,
        hybrid: !!v.hybrid,
        parents: v.hybrid ? [v.parentA, v.parentB] : null,
        harvestXp: R.harvestXp(v)
    };
}

/** Static catalogue for clients (GET /catalog). */
export function catalogView() {
    return {
        title: GAME_TITLE,
        brand: BRAND,
        varieties: BASE_VARIETIES.map(publicVariety),
        boosts: BOOSTS.map(b => ({ id: b.id, code: b.code, name: b.name, price: b.price, unlockLevel: b.unlockLevel, effect: b.effect })),
        staff: STAFF_TYPES.map(s => ({ code: s.code, name: s.name, output: s.output, itemId: s.itemId, perHour: s.perHour, hireCost: s.hireCost, maxCount: s.maxCount, unlockLevel: s.unlockLevel })),
        upgrades: UPGRADE_NODES.map(n => ({ code: n.code, name: n.name, branch: n.branch, maxLevel: n.maxLevel, effect: n.effect, requires: n.requires })),
        quality: QUALITY_NAMES.map((name, band) => ({ band, name, pricePct: QUALITY_PRICE_PCT[band] })),
        rules: {
            starterPlots: STARTER_KIT.plots,
            maxPlots: LIMITS.MAX_PLOTS,
            offlineCapMs: OFFLINE_CAP_MS,
            minGrowMs: GROWTH.MIN_GROW_MS,
            maxSpeedPct: GROWTH.MAX_SPEED_PCT,
            waterMinProgressPct: TUNING.WATER_MIN_PROGRESS_PCT,
            waterCutPct: TUNING.WATER_CUT_PCT,
            breeding: {
                minLevel: TUNING.BREEDING.MIN_LEVEL, slots: TUNING.BREEDING.SLOTS, seedsOut: TUNING.BREEDING.SEEDS_OUT,
                // domain/rules.js breedingPlan(): fee and time of a cross, so the client can show them before it starts
                feePct: TUNING.BREEDING.FEE_PCT, timeFactorPct: TUNING.BREEDING.TIME_FACTOR_PCT,
                minMs: TUNING.BREEDING.MIN_MS, maxMs: TUNING.BREEDING.MAX_MS
            },
            names: { minLength: NAMES.MIN_LENGTH, maxLength: NAMES.MAX_LENGTH, renameCooldownMs: NAMES.RENAME_COOLDOWN_MS },
            // phase 4
            replant: { minLevel: REPLANT.MIN_LEVEL, pricePct: REPLANT.PRICE_PCT, xpPct: REPLANT.XP_PCT, maxCounted: REPLANT.MAX_COUNTED },
            quests: { daily: QUESTS.DAILY_COUNT, weekly: QUESTS.WEEKLY_COUNT },
            season: { dailyCap: SEASON_SCORE.DAILY_CAP, challengeWeeks: SEASON.CHALLENGE_WEEKS, minActivePlayers: SEASON.MIN_ACTIVE_PLAYERS },
            maxPlacedDecorations: DECORATIONS_RULES.MAX_PLACED,
            ordersPerDay: TUNING.ORDERS.PER_DAY,
            marketMaxDailySwing: MAX_DAILY_SWING,
            seasonLengthDays: SEASON_LENGTH_DAYS,
            firstHybridId: FIRST_HYBRID_ID
        },
        decorations: DECORATIONS.map(d => ({ code: d.code, name: DECORATION_NAMES[d.code] || d.code, price: d.price, unlockLevel: d.unlockLevel, sold: d.price != null }))
    };
}

// A plot slot that is (re)created after a Replant starts its planting counter here, so harvest and boost
// ledger keys (harvest:<slot>:<seq>) never repeat for the same slot.
const PLANT_SEQ_PER_REPLANT = 1_000_000;

export function createGame({ store, onChange = null, randomInt = (n) => crypto.randomInt(n), logger = null }) {
    const { db, t, ledger } = store;
    const meta = store.meta || createMeta({ db, t, ledger, now: () => store.now(), flags: store.flags, logger });
    const now = () => store.now();
    const date = (ms = now()) => new Date(ms);
    const hybridCache = new Map();
    const market = { day: -1, at: 0, rows: new Map() };

    // ------------------------------------------------------------------ helpers

    function hybridFromRow(r) {
        return {
            id: Number(r.id), code: null, name: r.name, rarity: Number(r.rarity), growMs: Number(r.grow_ms),
            baseYield: Number(r.base_yield), basePrice: Number(r.base_price), unlockLevel: 1, hybrid: true,
            parentA: Number(r.parent_a), parentB: Number(r.parent_b)
        };
    }

    async function variety(conn, id) {
        const base = baseVariety(id);
        if (base) return base;
        if (!isHybridId(id)) return null;
        const hit = hybridCache.get(id);
        if (hit) return hit;
        const [rows] = await conn.query(`SELECT * FROM ${t.varieties} WHERE id = ?`, [id]);
        if (!rows.length) return null;
        const h = hybridFromRow(rows[0]);
        if (hybridCache.size < 5000) hybridCache.set(id, h);
        return h;
    }

    async function mustVariety(conn, id) {
        const v = await variety(conn, id);
        if (!v) throw gameError('UNKNOWN_VARIETY', { varietyId: id });
        return v;
    }

    async function upgradeLevels(conn, accountId) {
        const [rows] = await conn.query(`SELECT node_code, level FROM ${t.account_upgrades} WHERE account_id = ?`, [accountId]);
        const out = {};
        for (const r of rows) if (upgradeNode(r.node_code)) out[r.node_code] = Number(r.level);
        return out;
    }

    async function isDiscovered(conn, accountId, varietyId) {
        const [rows] = await conn.query(`SELECT 1 FROM ${t.account_varieties} WHERE account_id = ? AND variety_id = ?`, [accountId, varietyId]);
        return rows.length > 0;
    }

    async function discover(conn, accountId, varietyId) {
        const [r] = await conn.query(
            `INSERT IGNORE INTO ${t.account_varieties} (account_id, variety_id, discovered_at) VALUES (?, ?, ?)`, [accountId, varietyId, date()]);
        return r.affectedRows === 1;
    }

    async function bump(conn, accountId) {
        await conn.query(`UPDATE ${t.accounts} SET state_version = state_version + 1 WHERE id = ?`, [accountId]);
    }

    /** Add XP (with the Replant bonus). Returns the XP actually added. */
    async function addXp(ctx, amount) {
        if (!amount) return 0;
        const gained = boostedXp(amount, replantBonus(ctx.account.prestige).xpPct);
        ctx.account.xp = Math.min(Number.MAX_SAFE_INTEGER, ctx.account.xp + gained);
        const level = levelForXp(ctx.account.xp);
        if (level > ctx.account.level) ctx.levelUps = (ctx.levelUps || 0) + (level - ctx.account.level);
        ctx.account.level = level;
        await ctx.conn.query(`UPDATE ${t.accounts} SET xp = ?, level = ? WHERE id = ?`, [ctx.account.xp, level, ctx.accountId]);
        await ctx.conn.query(`INSERT IGNORE INTO ${t.account_stats} (account_id) VALUES (?)`, [ctx.accountId]);
        await ctx.conn.query(`UPDATE ${t.account_stats} SET xp_earned = xp_earned + ?, best_level = GREATEST(best_level, ?) WHERE account_id = ?`,
            [gained, level, ctx.accountId]);
        ctx.dirty = true;
        return gained;
    }

    /** Add to the lifetime counters (gh_account_stats); marks the action for an achievement check. */
    async function addStats(ctx, fields) {
        const entries = Object.entries(fields).filter(([, n]) => n);
        if (!entries.length) return;
        await ctx.conn.query(`INSERT IGNORE INTO ${t.account_stats} (account_id) VALUES (?)`, [ctx.accountId]);
        await ctx.conn.query(`UPDATE ${t.account_stats} SET ${entries.map(([k]) => `${k} = ${k} + ?`).join(', ')} WHERE account_id = ?`,
            [...entries.map(([, n]) => n), ctx.accountId]);
        ctx.dirty = true;
    }

    /** Quest, challenge and season-score bookkeeping for an action (phase 4). */
    async function track(ctx, amounts, points = 0) {
        await meta.progress(ctx, amounts);
        if (points) await meta.seasonPoints(ctx, points);
    }

    /** Today's demand for a variety: a stored gh_market_days row wins (an admin override), else the formula. */
    async function demandFor(conn, varietyId, day) {
        if (market.day !== day || now() - market.at > 60_000 || market.at > now()) {
            const [rows] = await conn.query(`SELECT variety_id, demand_pct FROM ${t.market_days} WHERE day = ?`, [dayString(day)]);
            market.day = day;
            market.at = now();
            market.rows = new Map(rows.map(r => [Number(r.variety_id), Number(r.demand_pct)]));
        }
        return market.rows.get(varietyId) ?? demandPct(varietyId, day);
    }

    /**
     * Run one mutating action. fn(ctx) gets { conn, accountId, account: {cash, xp, level, ...}, levels(),
     * effects() }. The account row is locked before fn runs. Clients are told about a new state version
     * (hints) after commit.
     */
    async function action(accountId, fn) {
        const out = await withTx(db, async (conn) => {
            const acc = await ledger.lockAccount(conn, accountId);
            if (acc.status !== 'active') throw gameError('ACCOUNT_INACTIVE');
            const [[row]] = await conn.query(`SELECT xp, level, prestige, review FROM ${t.accounts} WHERE id = ?`, [accountId]);
            let levelsCache = null;
            const ctx = {
                conn,
                accountId,
                account: { ...acc, xp: Number(row.xp), level: Number(row.level), prestige: Number(row.prestige), review: !!Number(row.review) },
                levels: async () => (levelsCache ||= await upgradeLevels(conn, accountId)),
                effects: async () => withPrestige(R.effectsFor(await ctx.levels()), ctx.account.prestige),
                resetLevels: () => { levelsCache = null; },
                dirty: false
            };
            ctx.addXp = (amount) => addXp(ctx, amount);
            ctx.addStats = (fields) => addStats(ctx, fields);
            const result = await fn(ctx);
            // Phase 4: unlock the achievements the action earned (same transaction).
            if (ctx.dirty) await meta.checkAchievements(ctx);
            const [[v]] = await conn.query(`SELECT state_version FROM ${t.accounts} WHERE id = ?`, [accountId]);
            return { result: { ...result, levelUps: ctx.levelUps || 0 }, version: Number(v.state_version), startVersion: acc.stateVersion };
        });
        if (out.version !== out.startVersion && onChange) {
            try { onChange(accountId, out.version); } catch { /* a listener must never undo a committed write */ }
        }
        return out.result;
    }

    /**
     * Replay check for free-form keys: if `key` was already used, return { replayed: true } when the stored
     * change equals `op`, else IDEMPOTENCY_MISMATCH. Returns null for a new key.
     */
    async function replayOf(conn, accountId, op) {
        const prior = await ledger.findEntry(conn, accountId, op.key, { lock: true });
        if (!prior) return null;
        if (prior.request_hash !== normalizeOp(op).hash) throw gameError('IDEMPOTENCY_MISMATCH', { key: op.key });
        return { replayed: true, entryId: Number(prior.id), cashDelta: Number(prior.cash_delta) };
    }

    async function lockPlot(conn, accountId, slot) {
        const [rows] = await conn.query(`SELECT * FROM ${t.plots} WHERE account_id = ? AND slot = ? FOR UPDATE`, [accountId, slot]);
        if (!rows.length) throw gameError('PLOT_LOCKED', { slot });
        const r = rows[0];
        return {
            slot: Number(r.slot),
            varietyId: r.variety_id == null ? null : Number(r.variety_id),
            plantedAtMs: r.planted_at_ms == null ? null : Number(r.planted_at_ms),
            readyAtMs: r.ready_at_ms == null ? null : Number(r.ready_at_ms),
            wateredAtMs: r.watered_at_ms == null ? null : Number(r.watered_at_ms),
            qualityRoll: r.quality_roll == null ? null : Number(r.quality_roll),
            plantSeq: Number(r.plant_seq)
        };
    }

    function checkSeq(plot, plantSeq) {
        if (plantSeq !== undefined && plantSeq !== null && plot.plantSeq !== plantSeq) throw gameError('PLOT_CHANGED', { slot: plot.slot, plantSeq: plot.plantSeq });
    }

    // ------------------------------------------------------------------ plots

    async function plant(accountId, { slot, varietyId, key }) {
        return action(accountId, async (ctx) => {
            const op = { accountId, key: actionKey('plant', key), reason: 'plant', ref: `p${slot}`, items: [{ kind: 'seed', itemId: varietyId, delta: -1 }] };
            const replay = await replayOf(ctx.conn, accountId, op);
            if (replay) return replay;
            const plot = await lockPlot(ctx.conn, accountId, slot);
            if (plot.varietyId != null) throw gameError('PLOT_OCCUPIED', { slot });
            const v = await mustVariety(ctx.conn, varietyId);
            const effects = await ctx.effects();
            const plantedAtMs = now();
            const ready = readyAt({ plantedAtMs, growMs: v.growMs, speedPct: effects.speed_pct });
            await ledger.applyInTx(ctx.conn, op);
            const roll = randomInt(1000);
            await ctx.conn.query(
                `UPDATE ${t.plots} SET variety_id = ?, planted_at_ms = ?, ready_at_ms = ?, quality_roll = ?, watered_at_ms = NULL,
                        plant_seq = plant_seq + 1 WHERE account_id = ? AND slot = ? AND variety_id IS NULL`,
                [varietyId, plantedAtMs, ready, roll, accountId, slot]);
            await discover(ctx.conn, accountId, varietyId);
            await track(ctx, { plant: 1 });
            return { replayed: false, slot, varietyId, plantSeq: plot.plantSeq + 1, readyAtMs: ready };
        });
    }

    async function water(accountId, { slot, plantSeq }) {
        return action(accountId, async (ctx) => {
            const plot = await lockPlot(ctx.conn, accountId, slot);
            if (plot.varietyId == null) throw gameError('PLOT_EMPTY', { slot });
            checkSeq(plot, plantSeq);
            const t0 = now();
            if (plot.wateredAtMs != null) throw gameError('ALREADY_WATERED', { slot });
            if (t0 >= plot.readyAtMs) throw gameError('PLOT_NOT_GROWING', { slot });
            if (!R.canWater({ ...plot, nowMs: t0 })) throw gameError('WATER_TOO_EARLY', { slot, waterableAtMs: R.waterableAt(plot) });
            const ready = R.cutRemaining({ nowMs: t0, readyAtMs: plot.readyAtMs, pct: TUNING.WATER_CUT_PCT });
            const [r] = await ctx.conn.query(
                `UPDATE ${t.plots} SET ready_at_ms = ?, watered_at_ms = ? WHERE account_id = ? AND slot = ? AND plant_seq = ? AND watered_at_ms IS NULL`,
                [ready, t0, accountId, slot, plot.plantSeq]);
            if (r.affectedRows !== 1) throw gameError('ALREADY_WATERED', { slot });
            await bump(ctx.conn, accountId);
            await track(ctx, { water: 1 });
            return { slot, plantSeq: plot.plantSeq, readyAtMs: ready, savedMs: plot.readyAtMs - ready };
        });
    }

    /** Harvest one locked, ready plot. Returns what was paid. */
    async function harvestPlot(ctx, plot) {
        const { conn, accountId } = ctx;
        const v = await mustVariety(conn, plot.varietyId);
        const effects = await ctx.effects();
        const rng = createRng(hashSeed('yield', accountId, plot.slot, plot.plantSeq));
        const units = Math.min(LIMITS.MAX_ITEM_DELTA, harvestYield({ baseYield: v.baseYield, yieldPct: effects.yield_pct, rng }));
        const quality = qualityBand({ roll: plot.qualityRoll ?? 0, qualityPct: effects.quality_pct });
        const [r] = await conn.query(
            `UPDATE ${t.plots} SET variety_id = NULL, planted_at_ms = NULL, ready_at_ms = NULL, quality_roll = NULL, watered_at_ms = NULL
              WHERE account_id = ? AND slot = ? AND plant_seq = ? AND variety_id IS NOT NULL`,
            [accountId, plot.slot, plot.plantSeq]);
        if (r.affectedRows !== 1) throw gameError('PLOT_EMPTY', { slot: plot.slot });
        await ledger.applyInTx(conn, {
            accountId, key: `harvest:${plot.slot}:${plot.plantSeq}`, reason: 'harvest', ref: `p${plot.slot}`,
            items: [{ kind: 'produce', itemId: v.id, quality, delta: units }]
        });
        const xp = await addXp(ctx, R.harvestXp(v));
        await addStats(ctx, { harvests: 1 });
        await conn.query(
            `INSERT INTO ${t.account_varieties} (account_id, variety_id, discovered_at, harvested) VALUES (?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE harvested = harvested + 1`, [accountId, v.id, date()]);
        await track(ctx, { harvest: 1 }, pointsFor('harvest'));
        return { slot: plot.slot, plantSeq: plot.plantSeq, varietyId: v.id, quality, units, xp };
    }

    async function harvestReplay(conn, accountId, slot, plantSeq) {
        if (plantSeq === undefined || plantSeq === null) return null;
        const prior = await ledger.findEntry(conn, accountId, `harvest:${slot}:${plantSeq}`, { lock: true });
        if (!prior) return null;
        const line = JSON.parse(typeof prior.item_lines === 'string' ? prior.item_lines : JSON.stringify(prior.item_lines || []))[0] || {};
        return { replayed: true, harvested: [{ slot, plantSeq, varietyId: line.itemId, quality: line.quality, units: line.delta, xp: 0 }] };
    }

    async function harvest(accountId, { slot, plantSeq }) {
        return action(accountId, async (ctx) => {
            const plot = await lockPlot(ctx.conn, accountId, slot);
            if (plot.varietyId == null || (plantSeq != null && plot.plantSeq !== plantSeq)) {
                const replay = await harvestReplay(ctx.conn, accountId, slot, plantSeq);
                if (replay) return replay;
                if (plot.varietyId == null) throw gameError('PLOT_EMPTY', { slot });
                checkSeq(plot, plantSeq);
            }
            if (now() < plot.readyAtMs) throw gameError('NOT_READY', { slot, readyAtMs: plot.readyAtMs });
            return { replayed: false, harvested: [await harvestPlot(ctx, plot)] };
        });
    }

    async function harvestAll(accountId) {
        return action(accountId, async (ctx) => {
            const [rows] = await ctx.conn.query(
                `SELECT slot FROM ${t.plots} WHERE account_id = ? AND variety_id IS NOT NULL AND ready_at_ms <= ? ORDER BY slot`,
                [accountId, now()]);
            if (!rows.length) throw gameError('NOTHING_READY');
            const harvested = [];
            for (const r of rows) {
                const plot = await lockPlot(ctx.conn, accountId, Number(r.slot));
                if (plot.varietyId == null || now() < plot.readyAtMs) continue;
                harvested.push(await harvestPlot(ctx, plot));
            }
            if (!harvested.length) throw gameError('NOTHING_READY');
            return { replayed: false, harvested };
        });
    }

    async function removePlant(accountId, { slot, plantSeq }) {
        return action(accountId, async (ctx) => {
            const plot = await lockPlot(ctx.conn, accountId, slot);
            if (plot.varietyId == null) throw gameError('PLOT_EMPTY', { slot });
            checkSeq(plot, plantSeq);
            await ctx.conn.query(
                `UPDATE ${t.plots} SET variety_id = NULL, planted_at_ms = NULL, ready_at_ms = NULL, quality_roll = NULL, watered_at_ms = NULL
                  WHERE account_id = ? AND slot = ? AND plant_seq = ?`, [accountId, slot, plot.plantSeq]);
            await bump(ctx.conn, accountId);
            return { slot, plantSeq: plot.plantSeq, removed: true };
        });
    }

    async function useBoost(accountId, { slot, boostId, plantSeq }) {
        return action(accountId, async (ctx) => {
            const boost = boostById(boostId);
            if (!boost) throw gameError('NOT_FOUND', { what: 'boost' });
            if (ctx.account.level < boost.unlockLevel) throw gameError('LEVEL_TOO_LOW', { needed: boost.unlockLevel });
            const plot = await lockPlot(ctx.conn, accountId, slot);
            if (plot.varietyId == null) throw gameError('PLOT_EMPTY', { slot });
            checkSeq(plot, plantSeq);
            const t0 = now();
            if (t0 >= plot.readyAtMs) throw gameError('PLOT_NOT_GROWING', { slot });
            const key = `boost:${slot}:${plot.plantSeq}:${boostId}`;
            if (await ledger.findEntry(ctx.conn, accountId, key, { lock: true })) throw gameError('BOOST_ALREADY_USED', { slot, boostId });
            await ledger.applyInTx(ctx.conn, { accountId, key, reason: 'boost', ref: `p${slot}`, items: [{ kind: 'boost', itemId: boostId, delta: -1 }] });
            if (boost.effect.kind === 'time_cut_pct') {
                const ready = R.cutRemaining({ nowMs: t0, readyAtMs: plot.readyAtMs, pct: boost.effect.amount });
                await ctx.conn.query(`UPDATE ${t.plots} SET ready_at_ms = ? WHERE account_id = ? AND slot = ? AND plant_seq = ?`, [ready, accountId, slot, plot.plantSeq]);
                await track(ctx, { boost: 1 });
                return { slot, plantSeq: plot.plantSeq, boostId, readyAtMs: ready };
            }
            const roll = R.boostedRoll(plot.qualityRoll ?? 0, boost.effect.amount);
            await ctx.conn.query(`UPDATE ${t.plots} SET quality_roll = ? WHERE account_id = ? AND slot = ? AND plant_seq = ?`, [roll, accountId, slot, plot.plantSeq]);
            await track(ctx, { boost: 1 });
            return { slot, plantSeq: plot.plantSeq, boostId };
        });
    }

    // ------------------------------------------------------------------ selling and the shop

    async function sell(accountId, { lines, key }) {
        const seen = new Set();
        for (const l of lines) {
            const k = `${l.varietyId}:${l.quality}`;
            if (seen.has(k)) throw gameError('VALIDATION', { field: 'lines', reason: 'lists the same item twice' });
            seen.add(k);
        }
        return action(accountId, async (ctx) => {
            const ledgerKey = actionKey('sell', key);
            const prior = await ledger.findEntry(ctx.conn, accountId, ledgerKey, { lock: true });
            if (prior) {
                // A retry: same lines (prices may have moved since), same answer.
                const stored = (typeof prior.item_lines === 'string' ? JSON.parse(prior.item_lines) : prior.item_lines) || [];
                const want = lines.map(l => `${l.varietyId}:${l.quality}:${-l.quantity}`).sort().join(',');
                const had = stored.map(l => `${l.itemId}:${l.quality}:${l.delta}`).sort().join(',');
                if (prior.reason !== 'sell' || want !== had) throw gameError('IDEMPOTENCY_MISMATCH', { key: ledgerKey });
                return { replayed: true, cash: Number(prior.cash_delta), units: lines.reduce((a, l) => a + l.quantity, 0) };
            }
            const day = dayIndex(now());
            const effects = await ctx.effects();
            let cash = 0;
            const sold = [];
            for (const l of lines) {
                const v = await mustVariety(ctx.conn, l.varietyId);
                const demand = await demandFor(ctx.conn, v.id, day);
                const unit = R.unitPrice({ variety: v, quality: l.quality, demand, effects });
                const total = saleTotal({ unitPrice: unit, quantity: l.quantity });
                cash += total;
                if (!Number.isSafeInteger(cash) || cash > LIMITS.MAX_CASH_DELTA) throw gameError('VALIDATION', { field: 'lines', reason: 'sale too large' });
                sold.push({ varietyId: v.id, quality: l.quality, quantity: l.quantity, unitPrice: unit, demandPct: demand, total });
            }
            await ledger.applyInTx(ctx.conn, {
                accountId, key: ledgerKey, reason: 'sell', cash,
                items: lines.map(l => ({ kind: 'produce', itemId: l.varietyId, quality: l.quality, delta: -l.quantity }))
            });
            const units = lines.reduce((a, l) => a + l.quantity, 0);
            await addXp(ctx, R.sellXp(cash));
            await addStats(ctx, { units_sold: units, cash_earned: cash });
            await track(ctx, { sell_units: units, earn_cash: cash }, salePoints(cash));
            return { replayed: false, cash, units, sold };
        }).then(async (out) => {
            if (!out.replayed) {
                // Market volume is a statistic: recorded after the sale commits, best effort, so the shared
                // per-variety row is never held inside a player's transaction.
                const day = dayString(dayIndex(now()));
                for (const s of out.sold) {
                    db.query(
                        `INSERT INTO ${t.market_days} (variety_id, day, demand_pct, units_sold) VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE units_sold = units_sold + VALUES(units_sold)`,
                        [s.varietyId, day, s.demandPct, s.quantity]).catch(err => logger?.warn?.('[cfx2] market volume not recorded', { error: err.message }));
                }
            }
            return out;
        });
    }

    async function buy(accountId, { kind, itemId, quantity, key }) {
        return action(accountId, async (ctx) => {
            let unit;
            if (kind === 'seed') {
                const v = await mustVariety(ctx.conn, itemId);
                const discovered = v.hybrid ? await isDiscovered(ctx.conn, accountId, v.id) : true;
                if (!R.seedUnlocked(v, ctx.account.level, discovered)) {
                    if (v.hybrid && !discovered) throw gameError('NOT_DISCOVERED', { varietyId: v.id });
                    throw gameError('VARIETY_LOCKED', { varietyId: v.id, needed: v.hybrid ? R.hybridUnlockLevel(v) : v.unlockLevel });
                }
                unit = R.seedPrice(v);
            } else {
                const b = boostById(itemId);
                if (!b) throw gameError('NOT_FOUND', { what: 'boost' });
                if (ctx.account.level < b.unlockLevel) throw gameError('LEVEL_TOO_LOW', { needed: b.unlockLevel });
                unit = b.price;
            }
            const cost = saleTotal({ unitPrice: unit, quantity });
            const op = { accountId, key: actionKey('buy', key), reason: 'buy', cash: -cost, items: [{ kind, itemId, delta: quantity }] };
            const replay = await replayOf(ctx.conn, accountId, op);
            if (replay) return replay;
            await ledger.applyInTx(ctx.conn, op);
            if (kind === 'seed') await discover(ctx.conn, accountId, itemId);
            return { replayed: false, kind, itemId, quantity, cost };
        });
    }

    // ------------------------------------------------------------------ staff

    /** Pay what staff earned since their clocks (12 h cap) and move the clocks. Runs inside an action. */
    async function settleStaff(ctx) {
        const { conn, accountId } = ctx;
        const [rows] = await conn.query(
            `SELECT staff_code, count, last_claim_at_ms FROM ${t.account_staff} WHERE account_id = ? ORDER BY staff_code FOR UPDATE`, [accountId]);
        const staff = rows.filter(r => staffType(r.staff_code)).map(r => {
            const type = staffType(r.staff_code);
            return { code: type.code, output: type.output, perHour: type.perHour, count: Number(r.count), lastClaimAtMs: Number(r.last_claim_at_ms) };
        });
        if (!staff.length) return { cash: 0, items: [], forfeitedMs: 0, paid: false };
        const effects = await ctx.effects();
        const out = offlineClaim({ staff, nowMs: now(), ratePct: effects.staff_rate_pct });
        let cash = 0;
        const items = new Map();
        let forfeitedMs = 0;
        for (const row of out.rows) {
            const type = staffType(row.code);
            if (staff.find(s => s.code === row.code).count > 0) forfeitedMs = Math.max(forfeitedMs, row.forfeitedMs);
            if (!row.units) continue;
            if (type.output === 'cash') cash += row.units;
            else {
                const k = `${type.output}:${type.itemId}`;
                const line = items.get(k) || { kind: type.output, itemId: type.itemId, quality: 0, delta: 0 };
                line.delta += Math.min(row.units, LIMITS.MAX_ITEM_DELTA);
                items.set(k, line);
            }
        }
        const paid = cash > 0 || items.size > 0;
        if (paid) {
            const key = `staff:${sha(staff.map(s => `${s.code}@${s.lastClaimAtMs}`).join(',')).slice(0, 40)}`;
            await ledger.applyInTx(conn, { accountId, key, reason: 'staff_claim', cash, items: [...items.values()] });
            await addStats(ctx, { staff_claims: 1 });
        }
        let moved = false;
        for (const row of out.rows) {
            const before = staff.find(s => s.code === row.code).lastClaimAtMs;
            if (row.newLastClaimAtMs === before) continue;
            moved = true;
            await conn.query(`UPDATE ${t.account_staff} SET last_claim_at_ms = ? WHERE account_id = ? AND staff_code = ?`,
                [row.newLastClaimAtMs, accountId, row.code]);
        }
        if (moved && !paid) await bump(conn, accountId);
        return { cash, items: [...items.values()], forfeitedMs, paid };
    }

    async function claimStaff(accountId) {
        return action(accountId, async (ctx) => {
            const settled = await settleStaff(ctx);
            if (settled.paid) await track(ctx, { staff_claim: 1 });
            return { ...settled, capMs: OFFLINE_CAP_MS };
        });
    }

    async function hireStaff(accountId, { code, count, key }) {
        return action(accountId, async (ctx) => {
            const type = staffType(code);
            if (!type) throw gameError('NOT_FOUND', { what: 'staff type' });
            if (ctx.account.level < type.unlockLevel) throw gameError('LEVEL_TOO_LOW', { needed: type.unlockLevel });
            const [rows] = await ctx.conn.query(`SELECT count FROM ${t.account_staff} WHERE account_id = ? AND staff_code = ? FOR UPDATE`, [accountId, code]);
            const have = rows.length ? Number(rows[0].count) : 0;
            const op = { accountId, key: actionKey('hire', key), reason: 'staff_hire', ref: `${code}:${have + 1}`, cash: -R.staffHireCost(type, have) };
            const prior = await ledger.findEntry(ctx.conn, accountId, op.key, { lock: true });
            if (prior) {
                if (prior.reason !== 'staff_hire' || !String(prior.ref || '').startsWith(`${code}:`)) throw gameError('IDEMPOTENCY_MISMATCH', { key: op.key });
                return { replayed: true, code, count: have };
            }
            if (count != null && count !== have + 1) throw gameError('COUNT_MISMATCH', { count: have });
            if (have >= R.staffMax(type, await ctx.effects())) throw gameError('STAFF_FULL', { max: R.staffMax(type, await ctx.effects()) });
            await settleStaff(ctx); // pay what the current staff earned before the rate changes
            await ledger.applyInTx(ctx.conn, op);
            await ctx.conn.query(
                `INSERT INTO ${t.account_staff} (account_id, staff_code, count, last_claim_at_ms, hired_at) VALUES (?, ?, 1, ?, ?)
                 ON DUPLICATE KEY UPDATE count = count + 1`, [accountId, code, now(), date()]);
            return { replayed: false, code, count: have + 1, cost: -op.cash };
        });
    }

    async function fireStaff(accountId, { code, count }) {
        return action(accountId, async (ctx) => {
            const type = staffType(code);
            if (!type) throw gameError('NOT_FOUND', { what: 'staff type' });
            const [rows] = await ctx.conn.query(`SELECT count FROM ${t.account_staff} WHERE account_id = ? AND staff_code = ? FOR UPDATE`, [accountId, code]);
            const have = rows.length ? Number(rows[0].count) : 0;
            if (count != null && count !== have - 1) throw gameError('COUNT_MISMATCH', { count: have });
            if (have < 1) throw gameError('STAFF_NONE');
            await settleStaff(ctx);
            await ctx.conn.query(`UPDATE ${t.account_staff} SET count = count - 1 WHERE account_id = ? AND staff_code = ? AND count >= 1`, [accountId, code]);
            await bump(ctx.conn, accountId);
            return { code, count: have - 1 };
        });
    }

    // ------------------------------------------------------------------ upgrades (and plot expansion)

    async function buyUpgrade(accountId, { code, level }) {
        return action(accountId, async (ctx) => {
            const node = upgradeNode(code);
            if (!node) throw gameError('NOT_FOUND', { what: 'upgrade' });
            const levels = await ctx.levels();
            const have = levels[code] || 0;
            // The Replant count is part of the key: a Replant sets every upgrade back to 0, and without it the
            // second purchase of a level would find the first one's row and be answered free as a replay (H-639).
            const upgradeKey = (lvl) => `upgrade:r${ctx.account.prestige}:${code}:${lvl}`;
            if (level != null && level <= have) {
                // Already bought (a double click or a retry): answer with what was bought, pay nothing.
                if (await ledger.findEntry(ctx.conn, accountId, upgradeKey(level), { lock: true })) return { replayed: true, code, level: have };
                throw gameError('LEVEL_MISMATCH', { level: have });
            }
            if (level != null && level !== have + 1) throw gameError('LEVEL_MISMATCH', { level: have });
            const next = R.nextUpgrade(node, have);
            if (!next) throw gameError('MAX_LEVEL', { level: have });
            if (!R.requirementsMet(node, levels)) throw gameError('REQUIREMENT_MISSING', { requires: node.requires });
            if (node.branch === 'staff') await settleStaff(ctx); // pay at the old rate before it changes
            await ledger.applyInTx(ctx.conn, { accountId, key: upgradeKey(next.level), reason: 'upgrade', ref: code, cash: -next.cost });
            await ctx.conn.query(
                `INSERT INTO ${t.account_upgrades} (account_id, node_code, level) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE level = VALUES(level)`, [accountId, code, next.level]);
            ctx.resetLevels();
            if (node.effect.stat === 'plots') {
                const owned = R.plotsOwned({ ...levels, [code]: next.level });
                const [cur] = await ctx.conn.query(`SELECT COUNT(*) AS n FROM ${t.plots} WHERE account_id = ?`, [accountId]);
                for (let slot = Number(cur[0].n) + 1; slot <= owned; slot++) {
                    await ctx.conn.query(`INSERT IGNORE INTO ${t.plots} (account_id, slot, plant_seq) VALUES (?, ?, ?)`,
                        [accountId, slot, ctx.account.prestige * PLANT_SEQ_PER_REPLANT]);
                }
            }
            await track(ctx, { upgrade: 1 });
            return { replayed: false, code, level: next.level, cost: next.cost };
        });
    }

    // ------------------------------------------------------------------ breeding

    async function startBreeding(accountId, { parentA, parentB, key }) {
        if (parentA === parentB || parentA >= FIRST_HYBRID_ID || parentB >= FIRST_HYBRID_ID) throw gameError('BREEDING_PARENTS');
        const [pa, pb] = parentPair(parentA, parentB);
        return action(accountId, async (ctx) => {
            const a = baseVariety(pa);
            const b = baseVariety(pb);
            if (!a || !b) throw gameError('UNKNOWN_VARIETY');
            const plan = R.breedingPlan(a, b);
            const op = {
                accountId, key: actionKey('breed', key), reason: 'breed', ref: `x${pa}-${pb}`, cash: -plan.feeCash,
                items: [{ kind: 'seed', itemId: pa, delta: -1 }, { kind: 'seed', itemId: pb, delta: -1 }]
            };
            const replay = await replayOf(ctx.conn, accountId, op);
            if (replay) return replay;
            if (ctx.account.level < TUNING.BREEDING.MIN_LEVEL) throw gameError('LEVEL_TOO_LOW', { needed: TUNING.BREEDING.MIN_LEVEL });
            for (const id of [pa, pb]) if (!(await isDiscovered(ctx.conn, accountId, id))) throw gameError('NOT_DISCOVERED', { varietyId: id });
            const [busy] = await ctx.conn.query(`SELECT COUNT(*) AS n FROM ${t.breeding} WHERE account_id = ? AND status = 'active'`, [accountId]);
            if (Number(busy[0].n) >= TUNING.BREEDING.SLOTS) throw gameError('BREEDING_BUSY');
            await ledger.applyInTx(ctx.conn, op);
            const startedAtMs = now();
            const [ins] = await ctx.conn.query(
                `INSERT INTO ${t.breeding} (account_id, parent_a, parent_b, started_at_ms, ready_at_ms, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
                [accountId, pa, pb, startedAtMs, startedAtMs + plan.durationMs, date()]);
            return { replayed: false, breedingId: Number(ins.insertId), parentA: pa, parentB: pb, readyAtMs: startedAtMs + plan.durationMs, fee: plan.feeCash };
        });
    }

    async function claimBreeding(accountId, { breedingId }) {
        return action(accountId, async (ctx) => {
            const [rows] = await ctx.conn.query(`SELECT * FROM ${t.breeding} WHERE id = ? AND account_id = ? FOR UPDATE`, [breedingId, accountId]);
            if (!rows.length) throw gameError('NOT_FOUND', { what: 'breeding' });
            const row = rows[0];
            if (row.status !== 'active') {
                if (row.status === 'claimed' && await ledger.findEntry(ctx.conn, accountId, `breedclaim:${breedingId}`, { lock: true })) {
                    return { replayed: true, breedingId, varietyId: Number(row.result_variety_id) };
                }
                throw gameError('BREEDING_NOT_ACTIVE');
            }
            if (now() < Number(row.ready_at_ms)) throw gameError('BREEDING_NOT_READY', { readyAtMs: Number(row.ready_at_ms) });
            const a = baseVariety(Number(row.parent_a));
            const b = baseVariety(Number(row.parent_b));
            const h = crossVarieties(a, b);
            await ctx.conn.query(
                `INSERT IGNORE INTO ${t.varieties} (parent_a, parent_b, name, rarity, grow_ms, base_yield, base_price, first_bred_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [h.parentA, h.parentB, h.name.slice(0, 120), h.rarity, h.growMs, h.baseYield, h.basePrice, accountId, date()]);
            const [vr] = await ctx.conn.query(`SELECT * FROM ${t.varieties} WHERE parent_a = ? AND parent_b = ?`, [h.parentA, h.parentB]);
            const hybrid = hybridFromRow(vr[0]);
            const isNew = await discover(ctx.conn, accountId, hybrid.id);
            await ledger.applyInTx(ctx.conn, {
                accountId, key: `breedclaim:${breedingId}`, reason: 'breed', ref: `h${hybrid.id}`,
                items: [{ kind: 'seed', itemId: hybrid.id, delta: TUNING.BREEDING.SEEDS_OUT }]
            });
            await ctx.conn.query(`UPDATE ${t.breeding} SET status = 'claimed', result_variety_id = ?, claimed_at = ? WHERE id = ?`, [hybrid.id, date(), breedingId]);
            await addXp(ctx, isNew ? TUNING.BREEDING.XP_NEW : TUNING.BREEDING.XP_REPEAT);
            if (isNew) await addStats(ctx, { hybrids_bred: 1 });
            await track(ctx, { cross: 1 }, isNew ? pointsFor('new_variety') : 0);
            return { replayed: false, breedingId, varietyId: hybrid.id, newDiscovery: isNew, variety: publicVariety(hybrid), seeds: TUNING.BREEDING.SEEDS_OUT };
        });
    }

    // ------------------------------------------------------------------ orders

    /** Create today's NPC orders the first time an account is seen on a day (once a day, under the lock). */
    async function ensureOrders(accountId) {
        const day = dayIndex(now());
        const since = date(day * DAY_MS);
        const [rows] = await db.query(`SELECT COUNT(*) AS n FROM ${t.orders} WHERE account_id = ? AND offered_at >= ?`, [accountId, since]);
        if (Number(rows[0].n) > 0) return false;
        return action(accountId, async (ctx) => {
            const [again] = await ctx.conn.query(`SELECT COUNT(*) AS n FROM ${t.orders} WHERE account_id = ? AND offered_at >= ?`, [accountId, since]);
            if (Number(again[0].n) > 0) return { created: 0 };
            await ctx.conn.query(`UPDATE ${t.orders} SET status = 'expired' WHERE account_id = ? AND status = 'open' AND expires_at_ms <= ?`, [accountId, now()]);
            const offers = R.orderOffers({ accountId, day, level: ctx.account.level });
            for (const o of offers) {
                await ctx.conn.query(
                    `INSERT INTO ${t.orders} (account_id, variety_id, min_quality, quantity, reward_cash, reward_xp, status, offered_at, expires_at_ms)
                     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
                    [accountId, o.varietyId, o.minQuality, o.quantity, o.rewardCash, o.rewardXp, date(), o.expiresAtMs]);
            }
            await bump(ctx.conn, accountId);
            return { created: offers.length };
        }).then(r => r.created > 0);
    }

    async function fillOrder(accountId, { orderId }) {
        return action(accountId, async (ctx) => {
            const [rows] = await ctx.conn.query(`SELECT * FROM ${t.orders} WHERE id = ? AND account_id = ? FOR UPDATE`, [orderId, accountId]);
            if (!rows.length) throw gameError('NOT_FOUND', { what: 'order' });
            const o = rows[0];
            if (o.status !== 'open') {
                if (o.status === 'filled' && await ledger.findEntry(ctx.conn, accountId, `order-fill:${orderId}`, { lock: true })) {
                    return { replayed: true, orderId };
                }
                throw gameError('ORDER_NOT_OPEN', { status: o.status });
            }
            if (now() >= Number(o.expires_at_ms)) {
                await ctx.conn.query(`UPDATE ${t.orders} SET status = 'expired' WHERE id = ?`, [orderId]);
                await bump(ctx.conn, accountId);
                return { expired: true };
            }
            const varietyId = Number(o.variety_id);
            const need = Number(o.quantity);
            const [inv] = await ctx.conn.query(
                `SELECT quality, quantity FROM ${t.inventory} WHERE account_id = ? AND kind = 'produce' AND item_id = ? AND quality >= ?
                  ORDER BY quality FOR UPDATE`, [accountId, varietyId, Number(o.min_quality)]);
            const items = [];
            let left = need;
            for (const r of inv) {
                if (!left) break;
                const take = Math.min(left, Number(r.quantity));
                if (take > 0) items.push({ kind: 'produce', itemId: varietyId, quality: Number(r.quality), delta: -take });
                left -= take;
            }
            if (left > 0) throw gameError('INSUFFICIENT_ITEMS', { kind: 'produce', itemId: varietyId, minQuality: Number(o.min_quality), needed: need, have: need - left });
            const effects = await ctx.effects();
            const cash = Math.floor((Number(o.reward_cash) * (100 + (effects.order_reward_pct || 0))) / 100);
            const [u] = await ctx.conn.query(`UPDATE ${t.orders} SET status = 'filled', filled_at = ? WHERE id = ? AND status = 'open'`, [date(), orderId]);
            if (u.affectedRows !== 1) throw gameError('ORDER_NOT_OPEN');
            await ledger.applyInTx(ctx.conn, { accountId, key: `order-fill:${orderId}`, reason: 'order', ref: `o${orderId}`, cash, items });
            await addXp(ctx, Number(o.reward_xp));
            await addStats(ctx, { orders_filled: 1, cash_earned: cash });
            await track(ctx, { fill_order: 1, earn_cash: cash }, pointsFor('order'));
            return { replayed: false, orderId, cash, xp: Number(o.reward_xp), delivered: items.map(i => ({ quality: i.quality, quantity: -i.delta })) };
        }).then(r => {
            if (r.expired) throw gameError('ORDER_EXPIRED');
            return r;
        });
    }

    async function declineOrder(accountId, { orderId }) {
        return action(accountId, async (ctx) => {
            const [u] = await ctx.conn.query(
                `UPDATE ${t.orders} SET status = 'declined' WHERE id = ? AND account_id = ? AND status = 'open'`, [orderId, accountId]);
            if (u.affectedRows !== 1) {
                const [rows] = await ctx.conn.query(`SELECT status FROM ${t.orders} WHERE id = ? AND account_id = ?`, [orderId, accountId]);
                if (!rows.length) throw gameError('NOT_FOUND', { what: 'order' });
                throw gameError('ORDER_NOT_OPEN', { status: rows[0].status });
            }
            await bump(ctx.conn, accountId);
            return { orderId, declined: true };
        });
    }

    // ------------------------------------------------------------------ daily reward

    async function claimDaily(accountId, { identityId }) {
        return action(accountId, async (ctx) => {
            const dayMs = now();
            const day = dayString(dayIndex(dayMs));
            const yesterday = dayString(dayIndex(dayMs) - 1);
            const [mine] = await ctx.conn.query(
                `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS d, identity_id, streak FROM ${t.daily_claims} WHERE account_id = ? AND day IN (?, ?) FOR UPDATE`,
                [accountId, day, yesterday]);
            if (mine.some(r => r.d === day)) throw gameError('DAILY_ALREADY_CLAIMED', { day });
            const [byIdentity] = await ctx.conn.query(`SELECT 1 FROM ${t.daily_claims} WHERE identity_id = ? AND day = ?`, [identityId, day]);
            if (byIdentity.length) throw gameError('DAILY_ALREADY_CLAIMED', { day, by: 'sign-in' });
            const prev = mine.find(r => r.d === yesterday);
            const streak = R.nextStreak(prev ? Number(prev.streak) : null);
            const reward = R.dailyReward({ streak, level: ctx.account.level });
            try {
                await ctx.conn.query(`INSERT INTO ${t.daily_claims} (account_id, day, identity_id, streak, created_at) VALUES (?, ?, ?, ?, ?)`,
                    [accountId, day, identityId, streak, date()]);
            } catch (err) {
                if (err?.code === 'ER_DUP_ENTRY') throw gameError('DAILY_ALREADY_CLAIMED', { day });
                throw err;
            }
            const entry = await ledger.applyInTx(ctx.conn, { accountId, key: `daily:${day}`, reason: 'daily', cash: reward.cash, items: reward.items });
            await ctx.conn.query(`UPDATE ${t.daily_claims} SET ledger_id = ? WHERE account_id = ? AND day = ?`, [entry.entryId, accountId, day]);
            await ctx.conn.query(`INSERT IGNORE INTO ${t.account_stats} (account_id) VALUES (?)`, [accountId]);
            await ctx.conn.query(`UPDATE ${t.account_stats} SET best_streak = GREATEST(best_streak, ?) WHERE account_id = ?`, [streak, accountId]);
            ctx.dirty = true;
            await track(ctx, { daily: 1 });
            return { day, streak, cash: reward.cash, items: reward.items.map(i => ({ kind: i.kind, itemId: i.itemId, quantity: i.delta })) };
        });
    }

    // ------------------------------------------------------------------ phase 4: quests, achievements, notifications

    async function claimQuest(accountId, { periodKey, code }) {
        return action(accountId, (ctx) => meta.claimQuest(ctx, { periodKey, code }));
    }

    async function claimAchievement(accountId, { code }) {
        return action(accountId, (ctx) => meta.claimAchievement(ctx, { code }));
    }

    async function readNotifications(accountId, { upToId = null } = {}) {
        return action(accountId, async (ctx) => {
            const read = await meta.markRead(ctx.conn, accountId, upToId);
            if (read) await bump(ctx.conn, accountId);
            return { read };
        });
    }

    // ------------------------------------------------------------------ phase 4: Replant (prestige)

    /**
     * Replant: reset the greenhouse for a permanent bonus (config/game.js REPLANT). `prestige` is the count the
     * client saw; a double click or retry with the same value answers the first result and changes nothing.
     */
    async function replant(accountId, { prestige }) {
        return action(accountId, async (ctx) => {
            const { conn } = ctx;
            if (ctx.account.review) throw gameError('REVIEW_ACCOUNT');
            const cur = ctx.account.prestige;
            if (prestige !== cur) {
                if (prestige === cur - 1) {
                    const [h] = await conn.query(`SELECT 1 FROM ${t.replants} WHERE account_id = ? AND number = ?`, [accountId, cur]);
                    if (h.length) return { replayed: true, prestige: cur, bonus: replantBonus(cur), next: replantBonus(cur + 1) };
                }
                throw gameError('PRESTIGE_MISMATCH', { prestige: cur });
            }
            if (!canReplant({ level: ctx.account.level })) throw gameError('REPLANT_LOCKED', { minLevel: REPLANT.MIN_LEVEL });
            const n = cur + 1;
            const levels = await ctx.levels();
            const acc = await ledger.lockAccount(conn, accountId);
            await conn.query(
                `INSERT INTO ${t.replants} (account_id, number, level_before, xp_before, cash_before, upgrade_levels, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [accountId, n, ctx.account.level, ctx.account.xp, acc.cash, Object.values(levels).reduce((x, y) => x + y, 0), date()]);
            // Cash and every item go through the ledger, in as many operations as the ledger's limits need.
            const [inv] = await conn.query(
                `SELECT kind, item_id, quality, quantity FROM ${t.inventory} WHERE account_id = ? AND quantity > 0 ORDER BY kind, item_id, quality FOR UPDATE`, [accountId]);
            const ops = clearingOps(inv.map(r => ({ kind: r.kind, itemId: Number(r.item_id), quality: Number(r.quality), quantity: Number(r.quantity) })));
            let cash = acc.cash;
            let part = 0;
            const takeCash = () => {
                const c = Math.min(cash, LIMITS.MAX_CASH_DELTA);
                cash -= c;
                return c ? -c : 0;
            };
            for (const items of ops) await ledger.applyInTx(conn, { accountId, key: `replant:${n}:${part++}`, reason: 'replant', ref: `r${n}`, cash: takeCash(), items });
            while (cash > 0) await ledger.applyInTx(conn, { accountId, key: `replant:${n}:${part++}`, reason: 'replant', ref: `r${n}`, cash: takeCash() });
            // A fresh start: the starter kit again.
            await ledger.applyInTx(conn, {
                accountId, key: `replant:${n}:kit`, reason: 'replant', ref: `r${n}`, cash: STARTER_KIT.cash,
                items: STARTER_KIT.seeds.map(x => ({ kind: 'seed', itemId: x.varietyId, delta: x.quantity }))
            });
            await conn.query(`DELETE FROM ${t.account_upgrades} WHERE account_id = ?`, [accountId]);
            await conn.query(`DELETE FROM ${t.account_staff} WHERE account_id = ?`, [accountId]);
            await conn.query(`DELETE FROM ${t.plots} WHERE account_id = ? AND slot > ?`, [accountId, STARTER_KIT.plots]);
            await conn.query(
                `UPDATE ${t.plots} SET variety_id = NULL, planted_at_ms = NULL, ready_at_ms = NULL, quality_roll = NULL, watered_at_ms = NULL WHERE account_id = ?`, [accountId]);
            await conn.query(`UPDATE ${t.breeding} SET status = 'cancelled' WHERE account_id = ? AND status = 'active'`, [accountId]);
            // Open orders were for the old level; today's are offered again for the new one.
            await conn.query(`DELETE FROM ${t.orders} WHERE account_id = ? AND status = 'open'`, [accountId]);
            await conn.query(`UPDATE ${t.accounts} SET xp = 0, level = 1, prestige = ?, state_version = state_version + 1 WHERE id = ?`, [n, accountId]);
            ctx.account.xp = 0;
            ctx.account.level = 1;
            ctx.account.prestige = n;
            ctx.resetLevels();
            ctx.dirty = true;
            const bonus = replantBonus(n);
            await meta.notify(conn, accountId, 'replant', { count: n, pricePct: bonus.pricePct, xpPct: bonus.xpPct });
            return { replayed: false, prestige: n, bonus, next: replantBonus(n + 1) };
        });
    }

    // ------------------------------------------------------------------ phase 4: decorations

    async function buyDecoration(accountId, { code }) {
        return action(accountId, async (ctx) => {
            const def = decorationDef(code);
            if (!def) throw gameError('NOT_FOUND', { what: 'decoration' });
            const key = `decoration:${code}`;
            const [own] = await ctx.conn.query(
                `SELECT placed FROM ${t.account_cosmetics} WHERE account_id = ? AND kind = 'decoration' AND code = ? FOR UPDATE`, [accountId, code]);
            if (own.length) {
                if (await ledger.findEntry(ctx.conn, accountId, key, { lock: true })) return { replayed: true, code };
                throw gameError('DECORATION_OWNED');
            }
            if (def.price == null) throw gameError('DECORATION_NOT_SOLD');
            if (ctx.account.level < def.unlockLevel) throw gameError('LEVEL_TOO_LOW', { needed: def.unlockLevel });
            await ledger.applyInTx(ctx.conn, { accountId, key, reason: 'decoration', ref: code, cash: -def.price });
            const [[p]] = await ctx.conn.query(
                `SELECT COUNT(*) AS n FROM ${t.account_cosmetics} WHERE account_id = ? AND kind = 'decoration' AND placed = 1`, [accountId]);
            const placed = Number(p.n) < DECORATIONS_RULES.MAX_PLACED;
            await meta.grantCosmetic(ctx.conn, accountId, 'decoration', code, 'shop', placed);
            ctx.dirty = true;
            return { replayed: false, code, cost: def.price, placed };
        });
    }

    async function placeDecoration(accountId, { code, placed }) {
        return action(accountId, async (ctx) => {
            const [own] = await ctx.conn.query(
                `SELECT placed FROM ${t.account_cosmetics} WHERE account_id = ? AND kind = 'decoration' AND code = ? FOR UPDATE`, [accountId, code]);
            if (!own.length) throw gameError('DECORATION_NOT_OWNED');
            if (!!Number(own[0].placed) === placed) return { code, placed, changed: false };
            if (placed) {
                const [[p]] = await ctx.conn.query(
                    `SELECT COUNT(*) AS n FROM ${t.account_cosmetics} WHERE account_id = ? AND kind = 'decoration' AND placed = 1`, [accountId]);
                if (Number(p.n) >= DECORATIONS_RULES.MAX_PLACED) throw gameError('DECORATION_LIMIT', { max: DECORATIONS_RULES.MAX_PLACED });
            }
            await ctx.conn.query(`UPDATE ${t.account_cosmetics} SET placed = ? WHERE account_id = ? AND kind = 'decoration' AND code = ?`, [placed ? 1 : 0, accountId, code]);
            await bump(ctx.conn, accountId);
            return { code, placed, changed: true };
        });
    }

    // ------------------------------------------------------------------ reads

    async function staffView(conn, accountId, effects, level) {
        const [rows] = await conn.query(`SELECT staff_code, count, last_claim_at_ms FROM ${t.account_staff} WHERE account_id = ?`, [accountId]);
        const byCode = new Map(rows.map(r => [r.staff_code, r]));
        const t0 = now();
        return STAFF_TYPES.map(type => {
            const r = byCode.get(type.code);
            const count = r ? Number(r.count) : 0;
            const clock = r ? Number(r.last_claim_at_ms) : null;
            const pending = r && count ? offlineClaim({ staff: [{ code: type.code, output: type.output, perHour: type.perHour, count, lastClaimAtMs: clock }], nowMs: t0, ratePct: effects.staff_rate_pct }).rows[0] : null;
            const max = R.staffMax(type, effects);
            return {
                code: type.code,
                count,
                max,
                unlocked: level >= type.unlockLevel,
                nextHireCost: count < max ? R.staffHireCost(type, count) : null,
                output: type.output,
                itemId: type.itemId,
                perHourEach: (type.perHour * (100 + effects.staff_rate_pct)) / 100,
                lastClaimAtMs: clock,
                pending: pending ? { units: pending.units, creditedMs: pending.creditedMs, forfeitedMs: pending.forfeitedMs } : null
            };
        });
    }

    /**
     * The whole state a client needs (GET /state and every action response). touch: false (the Discord status
     * command) does not mark the account as seen, so looking from Discord does not count as playing for the
     * weekly challenges' minimum-players rule.
     */
    async function state(accountId, { touch = true } = {}) {
        await ensureOrders(accountId);
        const t0 = now();
        const today = dayIndex(t0);
        const [[a]] = await db.query(
            `SELECT id, display_name, status, cash, xp, level, prestige, review, state_version, tutorial_step, name_changed_at, last_seen_at FROM ${t.accounts} WHERE id = ?`, [accountId]);
        if (!a) throw gameError('NOT_FOUND', { what: 'account' });
        const level = Number(a.level);
        const prestige = Number(a.prestige);
        const review = !!Number(a.review);
        const levels = await upgradeLevels(db, accountId);
        const effects = withPrestige(R.effectsFor(levels), prestige);
        // Activity for the weekly challenges' minimum-players rule: at most one write an hour per account.
        if (touch && (!a.last_seen_at || new Date(a.last_seen_at).getTime() < t0 - 3_600_000)) {
            await db.query(`UPDATE ${t.accounts} SET last_seen_at = ? WHERE id = ?`, [date(t0), accountId]);
        }
        const [quests, season, achievements, unread, decorations, badges, metaV] = await Promise.all([
            meta.questsView(accountId, level), meta.seasonView(accountId), meta.achievementSummary(accountId),
            meta.unreadCount(accountId), meta.decorations(accountId), meta.badges(accountId), meta.metaVersion()
        ]);
        const [plotRows] = await db.query(
            `SELECT slot, variety_id, planted_at_ms, ready_at_ms, watered_at_ms, plant_seq FROM ${t.plots} WHERE account_id = ? ORDER BY slot`, [accountId]);
        const inventory = await ledger.inventory(accountId);
        const [disc] = await db.query(`SELECT variety_id, harvested FROM ${t.account_varieties} WHERE account_id = ? ORDER BY variety_id`, [accountId]);
        const hybridIds = disc.map(r => Number(r.variety_id)).filter(id => id >= FIRST_HYBRID_ID);
        const hybrids = [];
        if (hybridIds.length) {
            const [hv] = await db.query(`SELECT * FROM ${t.varieties} WHERE id IN (?)`, [hybridIds]);
            for (const r of hv) hybrids.push(publicVariety(hybridFromRow(r)));
        }
        // Boosts already used on the current plantings (ledger keys boost:<slot>:<seq>:<id>).
        const boostKeys = [];
        for (const p of plotRows) if (p.variety_id != null) for (const b of BOOSTS) boostKeys.push(`boost:${p.slot}:${p.plant_seq}:${b.id}`);
        const used = new Set();
        if (boostKeys.length) {
            const [k] = await db.query(`SELECT idempotency_key FROM ${t.ledger} WHERE account_id = ? AND idempotency_key IN (?)`, [accountId, boostKeys]);
            for (const r of k) used.add(r.idempotency_key);
        }
        const plots = plotRows.map(p => {
            const slot = Number(p.slot);
            const seq = Number(p.plant_seq);
            if (p.variety_id == null) return { slot, plantSeq: seq, status: 'empty' };
            const plantedAtMs = Number(p.planted_at_ms);
            const readyAtMs = Number(p.ready_at_ms);
            const wateredAtMs = p.watered_at_ms == null ? null : Number(p.watered_at_ms);
            return {
                slot, plantSeq: seq, status: t0 >= readyAtMs ? 'ready' : 'growing', varietyId: Number(p.variety_id),
                plantedAtMs, readyAtMs, watered: wateredAtMs != null,
                waterableAtMs: wateredAtMs == null && t0 < readyAtMs ? R.waterableAt({ plantedAtMs, readyAtMs }) : null,
                boostsUsed: BOOSTS.filter(b => used.has(`boost:${slot}:${seq}:${b.id}`)).map(b => b.id)
            };
        });
        const [breedRows] = await db.query(
            `SELECT id, parent_a, parent_b, started_at_ms, ready_at_ms FROM ${t.breeding} WHERE account_id = ? AND status = 'active' ORDER BY id`, [accountId]);
        const [orderRows] = await db.query(
            `SELECT id, variety_id, min_quality, quantity, reward_cash, reward_xp, expires_at_ms FROM ${t.orders}
              WHERE account_id = ? AND status = 'open' AND expires_at_ms > ? ORDER BY expires_at_ms, id`, [accountId, t0]);
        const [daily] = await db.query(
            `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS d, streak FROM ${t.daily_claims} WHERE account_id = ? AND day IN (?, ?)`,
            [accountId, dayString(today), dayString(today - 1)]);
        const claimedToday = daily.find(r => r.d === dayString(today));
        const yesterday = daily.find(r => r.d === dayString(today - 1));
        const nextStreak = claimedToday ? Number(claimedToday.streak) : R.nextStreak(yesterday ? Number(yesterday.streak) : null);
        const marketIds = [...BASE_VARIETIES.filter(v => v.unlockLevel <= level).map(v => v.id), ...hybridIds];
        const [stored] = await db.query(`SELECT variety_id, demand_pct FROM ${t.market_days} WHERE day = ?`, [dayString(today)]);
        const override = new Map(stored.map(r => [Number(r.variety_id), Number(r.demand_pct)]));
        const xp = Number(a.xp);
        const stateVersion = Number(a.state_version);
        return {
            version: stateVersion,
            etag: etagFor(stateVersion, metaV),
            serverTimeMs: t0,
            day: dayString(today),
            account: {
                id: Number(a.id), displayName: a.display_name, status: a.status, cash: Number(a.cash), xp, level,
                levelStartXp: xpForLevel(level), nextLevelXp: level < LIMITS.MAX_LEVEL ? xpForLevel(level + 1) : null,
                prestige, tutorialStep: Number(a.tutorial_step), review,
                renameAvailableAtMs: store.accounts.renameAvailableAt(a.name_changed_at)
            },
            effects,
            plots,
            plotsOwned: plots.length,
            inventory: {
                seeds: inventory.filter(i => i.kind === 'seed').map(i => ({ varietyId: i.itemId, quantity: i.quantity })),
                produce: inventory.filter(i => i.kind === 'produce').map(i => ({ varietyId: i.itemId, quality: i.quality, quantity: i.quantity })),
                boosts: inventory.filter(i => i.kind === 'boost').map(i => ({ boostId: i.itemId, quantity: i.quantity }))
            },
            discovered: disc.map(r => ({ varietyId: Number(r.variety_id), harvested: Number(r.harvested) })),
            hybrids,
            upgrades: UPGRADE_NODES.map(n => {
                const lv = levels[n.code] || 0;
                return { code: n.code, level: lv, maxLevel: n.maxLevel, next: R.nextUpgrade(n, lv), requirementsMet: R.requirementsMet(n, levels) };
            }),
            staff: await staffView(db, accountId, effects, level),
            offlineCapMs: OFFLINE_CAP_MS,
            breeding: breedRows.map(b => ({ id: Number(b.id), parentA: Number(b.parent_a), parentB: Number(b.parent_b), startedAtMs: Number(b.started_at_ms), readyAtMs: Number(b.ready_at_ms) })),
            orders: orderRows.map(o => ({
                id: Number(o.id), buyer: BUYER_NAMES[Number(o.id) % BUYER_NAMES.length], varietyId: Number(o.variety_id), minQuality: Number(o.min_quality),
                quantity: Number(o.quantity), rewardCash: Math.floor((Number(o.reward_cash) * (100 + (effects.order_reward_pct || 0))) / 100),
                rewardXp: Number(o.reward_xp), expiresAtMs: Number(o.expires_at_ms)
            })),
            daily: { claimedToday: !!claimedToday, streak: nextStreak, nextReward: claimedToday ? null : R.dailyReward({ streak: nextStreak, level }), nextDayAtMs: (today + 1) * DAY_MS },
            market: marketIds.map(id => {
                const demand = override.get(id) ?? demandPct(id, today);
                return { varietyId: id, demandPct: demand, changePct: demandChangePct(id, today) };
            }),
            // phase 4
            quests,
            season,
            achievements,
            notifications: { unread: Math.min(unread, 99), more: unread > 99 },
            replant: {
                count: prestige, minLevel: REPLANT.MIN_LEVEL, available: canReplant({ level }) && !review,
                bonus: replantBonus(prestige), next: replantBonus(prestige + 1)
            },
            cosmetics: { decorations, badges, maxPlaced: DECORATIONS_RULES.MAX_PLACED },
            review: review ? { note: REVIEW_NOTE } : null
        };
    }

    /**
     * The polling etag: '<state version>.<day>.<meta version>'. The day refreshes clients at midnight (market,
     * quests); the meta version when the season job changes seasons or challenges.
     */
    function etagFor(stateVersion, metaV = 0) {
        return `${stateVersion}.${dayIndex(now())}.${metaV}`;
    }

    async function marketHistory(accountId, { days }) {
        const today = dayIndex(now());
        const [[a]] = await db.query(`SELECT level FROM ${t.accounts} WHERE id = ?`, [accountId]);
        const level = Number(a?.level || 1);
        const [disc] = await db.query(`SELECT variety_id FROM ${t.account_varieties} WHERE account_id = ? AND variety_id >= ?`, [accountId, FIRST_HYBRID_ID]);
        const ids = [...BASE_VARIETIES.filter(v => v.unlockLevel <= level).map(v => v.id), ...disc.map(r => Number(r.variety_id))];
        const out = [];
        for (const id of ids) {
            const series = [];
            for (let d = today - days + 1; d <= today; d++) series.push({ day: dayString(d), demandPct: demandPct(id, d) });
            out.push({ varietyId: id, series });
        }
        return { today: dayString(today), maxDailySwing: MAX_DAILY_SWING, varieties: out };
    }

    async function shop(accountId) {
        const [[a]] = await db.query(`SELECT level FROM ${t.accounts} WHERE id = ?`, [accountId]);
        const level = Number(a?.level || 1);
        const [disc] = await db.query(`SELECT variety_id FROM ${t.account_varieties} WHERE account_id = ? AND variety_id >= ?`, [accountId, FIRST_HYBRID_ID]);
        const seeds = BASE_VARIETIES.map(v => ({ varietyId: v.id, price: R.seedPrice(v), unlocked: v.unlockLevel <= level, unlockLevel: v.unlockLevel }));
        if (disc.length) {
            const [hv] = await db.query(`SELECT * FROM ${t.varieties} WHERE id IN (?)`, [disc.map(r => r.variety_id)]);
            for (const r of hv) {
                const h = hybridFromRow(r);
                seeds.push({ varietyId: h.id, price: R.seedPrice(h), unlocked: R.seedUnlocked(h, level, true), unlockLevel: R.hybridUnlockLevel(h) });
            }
        }
        const levels = await upgradeLevels(db, accountId);
        const bench = upgradeNode('extra_bench');
        const next = R.nextUpgrade(bench, levels.extra_bench || 0);
        return {
            seeds,
            boosts: BOOSTS.map(b => ({ boostId: b.id, price: b.price, unlocked: b.unlockLevel <= level, unlockLevel: b.unlockLevel })),
            plotExpansion: next ? { level: next.level, cost: next.cost, plotsAfter: R.plotsOwned({ ...levels, extra_bench: next.level }) } : null
        };
    }

    async function stats(accountId) {
        const [[s]] = await db.query(`SELECT * FROM ${t.account_stats} WHERE account_id = ?`, [accountId]);
        const [[a]] = await db.query(`SELECT cash, xp, level, created_at FROM ${t.accounts} WHERE id = ?`, [accountId]);
        const [[d]] = await db.query(`SELECT COUNT(*) AS n, SUM(variety_id >= ?) AS h FROM ${t.account_varieties} WHERE account_id = ?`, [FIRST_HYBRID_ID, accountId]);
        const [income] = await db.query(
            `SELECT reason, SUM(cash_delta) AS total FROM ${t.ledger} WHERE account_id = ? AND cash_delta > 0 GROUP BY reason`, [accountId]);
        const by = Object.fromEntries(income.map(r => [r.reason, Number(r.total)]));
        const active = (by.sell || 0) + (by.order || 0);
        const staffCash = by.staff_claim || 0;
        return {
            level: Number(a.level),
            xp: Number(a.xp),
            cash: Number(a.cash),
            harvests: Number(s?.harvests || 0),
            unitsSold: Number(s?.units_sold || 0),
            cashEarned: Number(s?.cash_earned || 0),
            ordersFilled: Number(s?.orders_filled || 0),
            hybridsBred: Number(s?.hybrids_bred || 0),
            staffClaims: Number(s?.staff_claims || 0),
            varietiesDiscovered: Number(d?.n || 0),
            hybridsDiscovered: Number(d?.h || 0),
            incomeByReason: by,
            // Staff produce is sold through 'sell', so this is the cash the staff paid directly.
            incomeShare: { activePlay: active, staffCash, daily: by.daily || 0 },
            playingSince: new Date(a.created_at).getTime()
        };
    }

    async function varieties(accountId) {
        const [disc] = await db.query(`SELECT variety_id, harvested, discovered_at FROM ${t.account_varieties} WHERE account_id = ?`, [accountId]);
        const known = new Map(disc.map(r => [Number(r.variety_id), r]));
        const out = BASE_VARIETIES.map(v => ({ ...publicVariety(v), discovered: known.has(v.id), harvested: Number(known.get(v.id)?.harvested || 0) }));
        const hybridIds = [...known.keys()].filter(id => id >= FIRST_HYBRID_ID);
        if (hybridIds.length) {
            const [hv] = await db.query(`SELECT * FROM ${t.varieties} WHERE id IN (?) ORDER BY id`, [hybridIds]);
            for (const r of hv) {
                const h = hybridFromRow(r);
                out.push({ ...publicVariety(h), discovered: true, harvested: Number(known.get(h.id)?.harvested || 0) });
            }
        }
        const baseCount = BASE_VARIETIES.length;
        return { varieties: out, possibleHybrids: (baseCount * (baseCount - 1)) / 2 };
    }

    // ------------------------------------------------------------------ jobs

    /** Store today's and tomorrow's demand rows (history; admin overrides edit these rows). */
    async function recordMarketDays() {
        const today = dayIndex(now());
        const [hv] = await db.query(`SELECT id FROM ${t.varieties}`);
        const ids = [...BASE_VARIETIES.map(v => v.id), ...hv.map(r => Number(r.id))];
        const rows = [];
        for (const d of [today, today + 1]) for (const id of ids) rows.push([id, dayString(d), demandPct(id, d)]);
        let inserted = 0;
        for (let i = 0; i < rows.length; i += 500) {
            const [r] = await db.query(`INSERT IGNORE INTO ${t.market_days} (variety_id, day, demand_pct) VALUES ?`, [rows.slice(i, i + 500)]);
            inserted += r.affectedRows;
        }
        return inserted;
    }

    /** Forget closed orders after KEEP_DAYS and mark expired open ones (the open list never shows them). */
    async function sweepOrders() {
        const t0 = now();
        const [e] = await db.query(`UPDATE ${t.orders} SET status = 'expired' WHERE status = 'open' AND expires_at_ms <= ? LIMIT 5000`, [t0]);
        const [d] = await db.query(
            `DELETE FROM ${t.orders} WHERE status <> 'open' AND offered_at < ? LIMIT 5000`, [date(t0 - TUNING.ORDERS.KEEP_DAYS * DAY_MS)]);
        return { expired: e.affectedRows, deleted: d.affectedRows };
    }

    return {
        plant, water, harvest, harvestAll, removePlant, useBoost,
        sell, buy,
        claimStaff, hireStaff, fireStaff,
        buyUpgrade,
        startBreeding, claimBreeding,
        ensureOrders, fillOrder, declineOrder,
        claimDaily,
        // phase 4
        claimQuest, claimAchievement, readNotifications, replant, buyDecoration, placeDecoration,
        achievements: (accountId) => meta.achievementsView(accountId),
        season: (accountId) => meta.seasonDetail(accountId),
        leaderboard: (opts) => meta.leaderboard(opts),
        notifications: (accountId, opts) => meta.listNotifications(accountId, opts),
        metaVersion: () => meta.metaVersion(),
        meta,
        state, etagFor, marketHistory, shop, stats, varieties,
        recordMarketDays, sweepOrders,
        isGameError
    };
}
