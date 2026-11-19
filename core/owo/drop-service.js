/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 * Port of upstream OwO Bot's `drop` / `pickup` (src/commands/commandList/gamble/drop.js,
 * Copyright (C) Christopher Thai), per server.
 *
 * owo_cowoncydrop (guild_id, channel) is each channel's "floor": `owo drop 500` moves 500 of your
 * cowoncy onto it, `owo pickup 300` takes 300 off it if at least that much is lying there
 * (upstream's current pickup — the old "pick up too much and you drop it instead" trap is gone).
 * The floor amount is never shown; people guess.
 *
 * Both directions count against the daily give caps (core/owo/give-limits.js) and are written to
 * the owo_transaction audit log with the floor as account 0 — otherwise a drop would be an
 * uncapped, unlogged way to hand cowoncy to someone.
 */
import pool from '../../utils/db.js';
import { withTx, claimCooldownTx, OwoUserError, formatWait } from './tx.js';
import { lockBalancesTx, debitTx, creditTx } from './cowoncy.js';
import { bookAllowanceTx, logTransferTx, FLOOR_ID } from './give-limits.js';

/** Upstream drop/pickup share one 30-second cooldown. */
export const DROP_COOLDOWN_MS = 30_000;
/** owo_cowoncydrop.amount is INT UNSIGNED; stop well short of it. */
const FLOOR_MAX = 4_000_000_000;

function checkAmount(amount, verb) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new OwoUserError(`Please specify how much cowoncy to ${verb}!`);
    }
}

async function cooldown(conn, guildId, userId) {
    const wait = await claimCooldownTx(conn, guildId, userId, 'drop', DROP_COOLDOWN_MS);
    if (wait > 0) throw new OwoUserError(`Slow down~ try again in **${formatWait(wait)}**.`, 'cooldown');
}

/** Drop cowoncy on this channel's floor. */
export async function dropCowoncy(guildId, userId, channelId, amount) {
    checkAmount(amount, 'drop');
    return withTx(async (conn) => {
        await cooldown(conn, guildId, userId);
        const balances = await lockBalancesTx(conn, guildId, [userId]);
        if ((balances.get(String(userId)) ?? 0) < amount) throw new OwoUserError("You don't have enough cowoncy! >:c");
        const [[floor]] = await conn.execute(
            'SELECT amount FROM owo_cowoncydrop WHERE guild_id = ? AND channel = ? FOR UPDATE',
            [guildId, String(channelId)]
        );
        if ((Number(floor?.amount) || 0) + amount > FLOOR_MAX) throw new OwoUserError('There is too much cowoncy on this floor already!');
        await bookAllowanceTx(conn, guildId, userId, 'send', amount);
        await debitTx(conn, guildId, userId, amount);
        await conn.execute(
            `INSERT INTO owo_cowoncydrop (guild_id, channel, amount) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)`,
            [guildId, String(channelId), amount]
        );
        await logTransferTx(conn, guildId, userId, FLOOR_ID, amount);
        return { dropped: amount };
    }, { label: 'drop' });
}

/**
 * Pick cowoncy up from this channel's floor. A failed guess still uses the cooldown (claimed in
 * its own transaction first) so the floor can't be binary-searched in seconds.
 */
export async function pickupCowoncy(guildId, userId, channelId, amount) {
    checkAmount(amount, 'pick up');
    await withTx(conn => cooldown(conn, guildId, userId), { label: 'pickup-cooldown' });
    return withTx(async (conn) => {
        const [taken] = await conn.execute(
            'UPDATE owo_cowoncydrop SET amount = amount - ? WHERE guild_id = ? AND channel = ? AND amount >= ?',
            [amount, guildId, String(channelId), amount]
        );
        if (taken.affectedRows !== 1) throw new OwoUserError("There isn't enough cowoncy on the floor!", 'floor_short');
        await bookAllowanceTx(conn, guildId, userId, 'receive', amount);
        await creditTx(conn, guildId, userId, amount);
        await logTransferTx(conn, guildId, FLOOR_ID, userId, amount);
        return { picked: amount };
    }, { label: 'pickup' });
}

/** Total cowoncy lying on floors in a server (for admins / the dashboard). */
export async function floorTotal(guildId) {
    const [[row]] = await pool.execute('SELECT COALESCE(SUM(amount), 0) AS n FROM owo_cowoncydrop WHERE guild_id = ?', [guildId]);
    return Number(row?.n) || 0;
}
