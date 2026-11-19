/*
 * Rolls command_usage (raw, 400 days) up into command_usage_daily (no user ids, kept forever).
 *
 *   nightly 00:15   the previous day, plus every earlier day that has raw rows but no live daily rows
 *                   (catch-up after downtime, bounded to the 400 days the raw table keeps)
 *   every hour      today so far, so the dashboard's "uses in 30 days" is never more than an hour old
 *
 * Each day is written with INSERT ... SELECT ... ON DUPLICATE KEY UPDATE, so re-running a day gives the
 * same numbers (idempotent). Only source = 'live' rows are written here; backfilled rows have their own
 * source value and are never touched.
 */
import cron from 'node-cron';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const LOG = '[CommandUsageRollup]';
const MAX_CATCHUP_DAYS = 400;
let nightly = null;
let hourly = null;
let bootTimer = null;
let running = null;

/** Roll one day (YYYY-MM-DD, in the database's time zone). Returns the number of daily rows written. */
export async function rollupDay(day, db = pool) {
    const [res] = await db.query(
        `INSERT INTO command_usage_daily (day, guild_id, path, kind, source, uses, unique_users, errors)
         SELECT DATE(created_at), guild_id, path, kind, 'live', COUNT(*), COUNT(DISTINCT user_id), SUM(success = 0)
           FROM command_usage
          WHERE created_at >= ? AND created_at < ? + INTERVAL 1 DAY
          GROUP BY DATE(created_at), guild_id, path, kind
         ON DUPLICATE KEY UPDATE uses = VALUES(uses), unique_users = VALUES(unique_users), errors = VALUES(errors)`,
        [day, day]);
    return res?.affectedRows ?? 0;
}

/**
 * Days before today that have raw rows but no live daily rows yet, plus yesterday (always re-rolled,
 * because the hourly pass may have run before its last hour ended).
 */
export async function daysToRoll(db = pool) {
    const [raw] = await db.query(
        `SELECT DISTINCT DATE_FORMAT(DATE(created_at), '%Y-%m-%d') AS d
           FROM command_usage
          WHERE created_at >= CURDATE() - INTERVAL ? DAY AND created_at < CURDATE()`, [MAX_CATCHUP_DAYS]);
    const [done] = await db.query(
        `SELECT DISTINCT DATE_FORMAT(day, '%Y-%m-%d') AS d FROM command_usage_daily
          WHERE source = 'live' AND day >= CURDATE() - INTERVAL ? DAY`, [MAX_CATCHUP_DAYS]);
    const have = new Set(done.map(r => r.d));
    const [[{ y }]] = await db.query("SELECT DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d') AS y");
    const out = new Set(raw.map(r => r.d).filter(d => !have.has(d)));
    out.add(y);
    return [...out].sort();
}

/** Nightly pass: yesterday plus catch-up. */
export async function runNightlyRollup() {
    if (running) return running;
    running = (async () => {
        try {
            const days = await daysToRoll();
            let rows = 0;
            for (const d of days) rows += await rollupDay(d);
            logger.info(`${LOG} rolled ${days.length} day(s) (${rows} row change(s))`);
            return days.length;
        } catch (err) {
            if (err?.code !== 'ER_NO_SUCH_TABLE') logger.warn(`${LOG} nightly rollup failed: ${err.message}`);
            return 0;
        } finally {
            running = null;
        }
    })();
    return running;
}

/** Hourly pass: today so far. */
export async function runTodayRollup() {
    try {
        const [[{ t }]] = await pool.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS t");
        return await rollupDay(t);
    } catch (err) {
        if (err?.code !== 'ER_NO_SUCH_TABLE') logger.warn(`${LOG} today rollup failed: ${err.message}`);
        return 0;
    }
}

export function startCommandUsageRollup() {
    if (nightly) return;
    nightly = cron.schedule('15 0 * * *', () => { void runNightlyRollup(); }, { scheduled: true });
    hourly = cron.schedule('7 * * * *', () => { void runTodayRollup(); }, { scheduled: true });
    // Catch up shortly after boot (downtime across midnight), off the startup path.
    bootTimer = setTimeout(async () => { await runNightlyRollup(); await runTodayRollup(); }, 3 * 60 * 1000);
    bootTimer.unref?.();
    logger.info(`${LOG} scheduled (nightly 00:15, today hourly)`);
}

export function stopCommandUsageRollup() {
    nightly?.stop(); hourly?.stop();
    nightly = null; hourly = null;
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
}
