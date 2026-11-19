/*
 * Permanent command usage tracking (migration 433).
 *
 * recordCommandUse() is called once per dispatch path:
 *   events/interactionCreate.js     slash commands and context menus
 *   core/universal-commands.js      chat commands through the slash bridge (! ? $ . @mention and "/")
 *   core/prefix-command-manager.js  the hand-written prefix registry (!play, !ban ...)
 *
 * It never touches the database on the command's path: rows are buffered and written in one
 * multi-row INSERT every FLUSH_MS, or sooner once FLUSH_ROWS are waiting. It never throws. If the
 * buffer is full (database down for a long time) new rows are dropped and counted, and the count
 * is logged with the next successful flush.
 *
 * jobs/command-usage-rollup.js turns these rows into command_usage_daily, which has no user ids and
 * is kept forever; command_usage itself is kept 400 days (data_retention_policy).
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const FLUSH_MS = 5000;
const FLUSH_ROWS = 200;
const MAX_BUFFER = 5000;
const TABLE_RETRY_MS = 10 * 60 * 1000;   // migration not run yet: try again later, quietly

export const KINDS = Object.freeze(['slash', 'prefix', 'slash_text', 'context']);

let buffer = [];
let timer = null;
let flushing = null;
let dropped = 0;
let disabledUntil = 0;
let warnedMissing = false;

const SNOWFLAKE = /^\d{5,25}$/;
const id = (v) => (v != null && SNOWFLAKE.test(String(v)) ? String(v) : null);
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * The chat path of a slash interaction, after core/command-mounts.js applyMount() has turned a moved
 * command back into the child: "music play", "owoify", "engage birthday set". Never throws.
 */
export function interactionPath(interaction) {
    const name = interaction?.commandName ?? '';
    try {
        const group = interaction.options?.getSubcommandGroup?.(false) ?? null;
        const sub = interaction.options?.getSubcommand?.(false) ?? null;
        return [name, group, sub].filter(Boolean).join(' ');
    } catch {
        return name;
    }
}

/** A short, stable label for an error: its Discord/API code, or its class name. */
export function errorCodeOf(err) {
    if (!err) return null;
    const code = err.code ?? err.status ?? null;
    return clip(code != null ? `${err.name && err.name !== 'Error' ? err.name + ':' : ''}${code}` : (err.name || 'Error'), 64);
}

/**
 * Queue one command run. Fire-and-forget; safe to call from any handler.
 * @param {object} u
 * @param {string} [u.guildId]   '' / null for DMs
 * @param {string} [u.channelId]
 * @param {string} [u.userId]
 * @param {string} [u.appId]     the bot application that handled it
 * @param {string} u.path        full chat path, e.g. "music play"
 * @param {string} [u.command]   top-level name (defaults to the path's first word)
 * @param {'slash'|'prefix'|'slash_text'|'context'} u.kind
 * @param {string} [u.prefix]
 * @param {boolean} [u.success]
 * @param {string} [u.errorCode]
 * @param {number} [u.latencyMs]
 */
export function recordCommandUse(u) {
    try {
        if (!u || !u.path || !KINDS.includes(u.kind)) return;
        const path = String(u.path).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
        if (!path) return;
        if (buffer.length >= MAX_BUFFER) { dropped++; return; }
        const latency = Number.isFinite(u.latencyMs) ? Math.max(0, Math.min(2147483647, Math.round(u.latencyMs))) : null;
        buffer.push([
            id(u.guildId) ?? '',
            id(u.channelId),
            id(u.userId),
            id(u.appId),
            clip((u.command || path.split(' ')[0]).toLowerCase(), 64),
            path,
            u.kind,
            u.prefix ? clip(u.prefix, 4) : null,
            u.success === false ? 0 : 1,
            u.success === false ? clip(u.errorCode || 'error', 64) : null,
            latency,
            new Date(),
        ]);
        if (buffer.length >= FLUSH_ROWS) void flush();
        else schedule();
    } catch {
        // Tracking must never break a command.
    }
}

function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; void flush(); }, FLUSH_MS);
    timer.unref?.();
}

/** Write everything buffered. Resolves when done; never rejects. */
export function flush() {
    if (flushing) return flushing;
    if (!buffer.length) return Promise.resolve(0);
    if (Date.now() < disabledUntil) { schedule(); return Promise.resolve(0); }
    const rows = buffer;
    buffer = [];
    flushing = (async () => {
        try {
            await pool.query(
                `INSERT INTO command_usage
                    (guild_id, channel_id, user_id, app_id, command, path, kind, prefix, success, error_code, latency_ms, created_at)
                 VALUES ?`, [rows]);
            if (dropped) {
                logger.warn(`[CommandUsage] ${dropped} earlier command use(s) were not recorded (buffer full or table missing)`);
                dropped = 0;
            }
            warnedMissing = false;
            return rows.length;
        } catch (err) {
            if (err?.code === 'ER_NO_SUCH_TABLE') {
                // Migration 433 has not run: keep nothing, check again in a while.
                disabledUntil = Date.now() + TABLE_RETRY_MS;
                if (!warnedMissing) logger.warn('[CommandUsage] command_usage table is missing (run migration 433); usage is not being recorded');
                warnedMissing = true;
                dropped += rows.length;
                return 0;
            }
            // Transient failure: put the rows back (oldest first) as far as the cap allows.
            const room = Math.max(0, MAX_BUFFER - buffer.length);
            dropped += Math.max(0, rows.length - room);
            buffer = rows.slice(0, room).concat(buffer);
            logger.warn(`[CommandUsage] flush failed, will retry: ${err?.message}`);
            schedule();
            return 0;
        } finally {
            flushing = null;
            if (buffer.length) schedule();
        }
    })();
    return flushing;
}

/** For tests and the shutdown path. */
export function _state() {
    return { buffered: buffer.length, dropped, disabledUntil };
}
export function _reset() {
    buffer = []; dropped = 0; disabledUntil = 0; warnedMissing = false;
    if (timer) { clearTimeout(timer); timer = null; }
}
