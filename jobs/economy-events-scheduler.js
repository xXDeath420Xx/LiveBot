/**
 * Timed economy work that must survive restarts — everything it needs is in the database:
 *
 *   heists  every 15s: resolve heists whose join window (heists.starts_at) has closed, resume
 *           heists claimed but not finished before a restart, finish refunds of cancelled heists
 *           (core/heist-manager.js — settlement is idempotent per crew member).
 *   trades  every 60s: expire pending trade offers past trades.expires_at and update their messages
 *           (core/trade-manager.js — nothing is escrowed, so expiry never has to give anything back).
 *
 * The first pass runs 20s after start (custom bots may still be logging in; settlement itself does
 * not need Discord, only the result messages do).
 */
import logger from '../utils/logger.js';
import { runHeistSweep } from '../core/heist-manager.js';
import { expireDueTrades } from '../core/trade-manager.js';

const HEIST_INTERVAL_MS = 15_000;
const TRADE_INTERVAL_MS = 60_000;
const BOOT_DELAY_MS = 20_000;

let heistTimer = null;
let tradeTimer = null;
let bootTimer = null;
let heistRunning = false;
let tradeRunning = false;

async function heistTick() {
    if (heistRunning) return;
    heistRunning = true;
    try {
        await runHeistSweep();
    } catch (error) {
        logger.error('[EconomyEvents] heist sweep failed', { error: error.message });
    } finally {
        heistRunning = false;
    }
}

async function tradeTick() {
    if (tradeRunning) return;
    tradeRunning = true;
    try {
        await expireDueTrades();
    } catch (error) {
        logger.error('[EconomyEvents] trade expiry failed', { error: error.message });
    } finally {
        tradeRunning = false;
    }
}

export function startEconomyEventsScheduler() {
    if (heistTimer) return;
    bootTimer = setTimeout(() => { heistTick(); tradeTick(); }, BOOT_DELAY_MS);
    bootTimer.unref?.();
    heistTimer = setInterval(heistTick, HEIST_INTERVAL_MS);
    heistTimer.unref?.();
    tradeTimer = setInterval(tradeTick, TRADE_INTERVAL_MS);
    tradeTimer.unref?.();
    logger.info('[EconomyEvents] scheduler started (heists every 15s, trade expiry every 60s)');
}

export function stopEconomyEventsScheduler() {
    if (bootTimer) clearTimeout(bootTimer);
    if (heistTimer) clearInterval(heistTimer);
    if (tradeTimer) clearInterval(tradeTimer);
    bootTimer = heistTimer = tradeTimer = null;
}

export default { startEconomyEventsScheduler, stopEconomyEventsScheduler };
