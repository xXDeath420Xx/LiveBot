/*
 * Background jobs. Each has a plain sweep function (runX(client)) and idempotent start/stop wrappers.
 *   lottery draw     every minute, plus once 20 s after start
 *   escrow sweeper   every minute, plus once 25 s after start
 *   boss reaper      every 2 minutes (also prunes old hourly catch totals)
 * Guild lookups search the main client and every custom-bot client (global.botManager.clients).
 */
import { dueLotteryGuilds, drawLottery } from './lottery.js';
import { sweepExpiredDuels } from './battle.js';
import { reapBosses } from './boss.js';
import { pruneCatchHours } from './zoo.js';
import { getConfig } from './config.js';
import { bossMessage, lotteryWinMessage, lotteryRolloverMessage, challengeExpiredMessage } from './views.js';
import logger from '../../utils/logger.js';

function allClients(client) {
    const out = [];
    if (client) out.push(client);
    const extra = globalThis.botManager?.clients;
    const list = extra instanceof Map ? [...extra.values()] : Array.isArray(extra) ? extra : extra && typeof extra === 'object' ? Object.values(extra) : [];
    for (const c of list) {
        const cl = c?.client || c;
        if (cl && cl.guilds && !out.includes(cl)) out.push(cl);
    }
    return out;
}

export async function findChannel(client, guildId, channelId) {
    if (!channelId) return null;
    for (const c of allClients(client)) {
        const guild = c.guilds?.cache?.get(String(guildId));
        if (!guild) continue;
        const ch = guild.channels?.cache?.get(String(channelId)) || await guild.channels?.fetch?.(String(channelId)).catch(() => null);
        if (ch) return ch;
    }
    return null;
}

async function editMessage(client, guildId, channelId, messageId, payload) {
    if (!channelId || !messageId) return false;
    const ch = await findChannel(client, guildId, channelId);
    if (!ch?.messages) return false;
    const msg = await ch.messages.fetch(String(messageId)).catch(() => null);
    if (!msg || !msg.editable) return false;
    await msg.edit(payload).catch(() => null);
    return true;
}

/** Draw every due lottery round (up to 50). Messages only where the module is enabled. Returns the draw results. */
export async function runLotteryDraws(client, { now = new Date() } = {}) {
    const results = [];
    for (const guildId of await dueLotteryGuilds({ limit: 50, now })) {
        try {
            const draw = await drawLottery(guildId, { now });
            if (!draw) continue;
            results.push({ guildId, ...draw });
            if (draw.kind === 'empty') continue;
            const cfg = await getConfig(guildId);
            if (!cfg.enabled) continue; // paid, but silently
            const ch = await findChannel(client, guildId, draw.channelId);
            if (!ch?.send) continue;
            const payload = draw.kind === 'won' ? lotteryWinMessage(draw) : lotteryRolloverMessage(draw);
            await ch.send(payload).catch(() => null);
        } catch (err) {
            logger.warn('[critters] lottery draw failed', { guildId, error: err.message });
        }
    }
    return results;
}

/** Refund expired duels and edit their challenge messages. Returns the refunded rows. */
export async function runEscrowSweep(client, { now = new Date() } = {}) {
    const rows = await sweepExpiredDuels({ limit: 100, now });
    for (const r of rows) {
        try { await editMessage(client, r.guildId, r.channelId, r.messageId, challengeExpiredMessage(r)); } catch { /* best effort */ }
    }
    return rows;
}

/** Mark expired bosses fled and edit their announcements. Returns the number reaped. */
export async function runBossReaper(client, { now = new Date() } = {}) {
    const fled = await reapBosses({ now });
    for (const b of fled) {
        try { await editMessage(client, b.guildId, b.channelId, b.messageId, bossMessage(b, { now })); } catch { /* best effort */ }
    }
    try { await pruneCatchHours({ now }); } catch { /* best effort */ }
    if (fled.length) logger.info(`[critters] boss reaper: ${fled.length} boss(es) fled`);
    return fled.length;
}

function makeJob(name, fn, { everyMs, firstAfterMs = null }) {
    let timer = null;
    let first = null;
    let running = false;
    const tick = async (client) => {
        if (running) return; // re-entrancy guard
        running = true;
        try { await fn(client); } catch (err) { logger.warn(`[critters] ${name} failed`, { error: err.message }); } finally { running = false; }
    };
    const handle = {
        name,
        start(client) {
            if (timer) return handle; // idempotent
            timer = setInterval(() => tick(client), everyMs);
            timer.unref?.();
            if (firstAfterMs != null) { first = setTimeout(() => tick(client), firstAfterMs); first.unref?.(); }
            return handle;
        },
        stop() {
            if (timer) clearInterval(timer);
            if (first) clearTimeout(first);
            timer = null; first = null;
        },
        get running() { return !!timer; },
    };
    return handle;
}

const lotteryJob = makeJob('lottery draw', runLotteryDraws, { everyMs: 60 * 1000, firstAfterMs: 20 * 1000 });
const sweeperJob = makeJob('escrow sweeper', runEscrowSweep, { everyMs: 60 * 1000, firstAfterMs: 25 * 1000 });
const reaperJob = makeJob('boss reaper', runBossReaper, { everyMs: 2 * 60 * 1000 });

export const startLotteryDraw = (client) => lotteryJob.start(client);
export const stopLotteryDraw = () => lotteryJob.stop();
export const startEscrowSweeper = (client) => sweeperJob.start(client);
export const stopEscrowSweeper = () => sweeperJob.stop();
export const startBossReaper = (client) => reaperJob.start(client);
export const stopBossReaper = () => reaperJob.stop();

/** Start / stop all three. */
export function startCritterJobs(client) {
    return { lottery: startLotteryDraw(client), sweeper: startEscrowSweeper(client), reaper: startBossReaper(client) };
}
export function stopCritterJobs() {
    stopLotteryDraw(); stopEscrowSweeper(); stopBossReaper();
}
