/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Transaction plumbing for OwO money/inventory moves (give, lottery, drops, rings, wallpapers,
 * battle bets, marriage). Every multi-row change runs inside withTx() so a crash or a failed check
 * part-way through rolls back instead of leaving cowoncy debited with nothing to show for it.
 *
 * OwoUserError carries a message meant for the player ("not enough cowoncy"); anything else is a
 * real failure and is logged by the caller.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export class OwoUserError extends Error {
    constructor(message, code = 'owo_user_error') {
        super(message);
        this.name = 'OwoUserError';
        this.code = code;
    }
}

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/**
 * Run `fn(conn)` in a transaction. Commits on success, rolls back on any throw, retries a
 * deadlock / lock-wait timeout up to `retries` times (two members giving to each other at the same
 * instant lock the same two rows in opposite order).
 */
export async function withTx(fn, { retries = 3, label = 'owo-tx' } = {}) {
    for (let attempt = 1; ; attempt++) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const out = await fn(conn);
            await conn.commit();
            return out;
        } catch (err) {
            await conn.rollback().catch(rb => logger.warn(`[OwO] ${label} rollback failed`, { err: rb.message }));
            if (RETRYABLE.has(err?.code) && attempt < retries) {
                logger.warn(`[OwO] ${label} lock conflict, retrying`, { attempt, code: err.code });
                await new Promise(r => setTimeout(r, 40 * attempt));
                continue;
            }
            throw err;
        } finally {
            conn.release();
        }
    }
}

/**
 * Claim a per-command cooldown inside a transaction (owo_cooldowns). Returns the milliseconds still
 * to wait (0 = claimed, the stamp is now NOW()). Because it rides the caller's transaction, a
 * command that fails later rolls the cooldown back too.
 */
export async function claimCooldownTx(conn, guildId, userId, command, cooldownMs) {
    const [[row]] = await conn.execute(
        'SELECT used_at FROM owo_cooldowns WHERE guild_id = ? AND user_id = ? AND command = ? FOR UPDATE',
        [guildId, userId, command]
    );
    if (row?.used_at) {
        const wait = cooldownMs - (Date.now() - new Date(row.used_at).getTime());
        if (wait > 0) return wait;
    }
    await conn.execute(
        `INSERT INTO owo_cooldowns (guild_id, user_id, command, used_at) VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE used_at = NOW()`,
        [guildId, userId, command]
    );
    return 0;
}

/** "4m 12s" / "37s" for cooldown messages. */
export function formatWait(ms) {
    const s = Math.max(1, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    return m ? `${m}m ${s % 60}s` : `${s}s`;
}

/** Turn any thrown error into a reply line; logs the ones that are not the player's fault. */
export function userMessage(err, context = {}) {
    if (err instanceof OwoUserError) return err.message;
    logger.error('[OwO] action failed', { ...context, err: err?.message, code: err?.code });
    return 'Something went wrong — nothing was changed. Please try again in a moment.';
}
