/**
 * Daily health digest for the owner.
 *
 * Every warning and error the bot logs is counted in memory by a normalised signature (numbers, ids and
 * usernames blanked, so "timeout for jamesxcaliber" and "timeout for mineycart" are one line). Counts are
 * flushed to health_log_signatures every 15 minutes (migration 416). At 09:00 UTC the owner
 * (BOT_OWNER_ID) gets a DM with what is NEW yesterday or grew at least 3x on the day before. Quiet days
 * send nothing.
 *
 * Built after the 2026-11-18 audit: Kick chat had failed ~6,000 times a day for 4+ days and a custom bot
 * stalled overnight without anyone being told.
 */
import cron from 'node-cron';
import pool from '../utils/db.js';
import logger, { onWarnError } from '../utils/logger.js';
import { SUPER_ADMIN_ID } from '../utils/constants.js';

const LOG = '[HealthDigest]';
const counts = new Map(); // `${level}\t${signature}` -> { n, sample }
const MIN_NEW = 5;        // a new signature must occur this often to be reported
const GROWTH = 3;         // ...or grow by this factor
const MIN_GROWN = 50;     // ...to at least this many
let started = false;

/** Same message shape -> same signature. Exported for tests. */
export function signatureOf(message) {
    return String(message || '')
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/https?:\/\/\S+/g, 'URL')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID')
        .replace(/\d{3,}/g, 'N')
        .replace(/\b(for|in|to|from|of|user|channel|guild|streamer)\s+[@#]?[A-Za-z0-9_.-]{2,}/gi, '$1 X')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

function record(level, message) {
    if (level !== 'warn' && level !== 'error') return;
    const sig = signatureOf(message);
    if (!sig) return;
    const k = `${level}\t${sig}`;
    const e = counts.get(k);
    if (e) e.n++;
    else if (counts.size < 5000) counts.set(k, { n: 1, sample: String(message).slice(0, 400) });
}

async function flush() {
    if (!counts.size) return;
    const rows = [];
    for (const [k, v] of counts) { const [level, sig] = k.split('\t'); rows.push([level, sig, v.n, v.sample]); }
    counts.clear();
    try {
        await pool.query(
            `INSERT INTO health_log_signatures (day, level, signature, count, sample)
             VALUES ${rows.map(() => '(UTC_DATE(), ?, ?, ?, ?)').join(', ')}
             ON DUPLICATE KEY UPDATE count = count + VALUES(count)`,
            rows.flat());
    } catch (e) {
        // Avoid logger.warn here: it would count itself.
        console.error(`${LOG} flush failed: ${e.message}`);
    }
}

/** What to tell the owner about one day, compared with the day before. Exported for the dashboard/tests. */
export async function digestFor(dayIso) {
    const [rows] = await pool.query(
        `SELECT t.level, t.signature, t.count, t.sample, COALESCE(p.count, 0) prev
           FROM health_log_signatures t
           LEFT JOIN health_log_signatures p
             ON p.level = t.level AND p.signature = t.signature AND p.day = DATE_SUB(t.day, INTERVAL 1 DAY)
          WHERE t.day = ?
          ORDER BY t.count DESC`, [dayIso]);
    const flagged = rows.filter(r => (r.prev === 0 && r.count >= MIN_NEW)
        || (r.prev > 0 && r.count >= MIN_GROWN && r.count >= r.prev * GROWTH));
    const totals = rows.reduce((a, r) => { a[r.level] += Number(r.count); return a; }, { warn: 0, error: 0 });
    return { day: dayIso, flagged, totals, signatures: rows.length };
}

async function sendDigest() {
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    try {
        await flush();
        const d = await digestFor(day);
        if (!d.flagged.length) { logger.info(`${LOG} ${day}: nothing new or growing (${d.totals.error} errors, ${d.totals.warn} warnings) - no DM`); return; }
        if (!SUPER_ADMIN_ID) { logger.info(`${LOG} BOT_OWNER_ID not set - digest not sent`); return; }
        const client = global.botManager?.getDefaultClient?.();
        const owner = client ? await client.users.fetch(SUPER_ADMIN_ID).catch(() => null) : null;
        if (!owner) { logger.info(`${LOG} owner could not be resolved - digest not sent`); return; }
        const lines = d.flagged.slice(0, 12).map(r => {
            const tag = r.prev === 0 ? 'new' : `${Math.round(r.count / Math.max(1, r.prev))}x`;
            return `${r.level === 'error' ? 'ERR ' : 'WARN'} ${String(r.count).padStart(6)}  ${tag.padEnd(4)}  ${r.signature.slice(0, 120)}`;
        });
        const more = d.flagged.length > 12 ? `\n…and ${d.flagged.length - 12} more.` : '';
        await owner.send(
            `**CertiFried health, ${day} (UTC)**\n` +
            `${d.totals.error.toLocaleString()} errors and ${d.totals.warn.toLocaleString()} warnings in ${d.signatures} kinds. ` +
            `These are new, or at least ${GROWTH}x the day before:\n` +
            '```\n' + lines.join('\n') + '\n```' + more);
        logger.info(`${LOG} ${day}: sent ${d.flagged.length} item(s)`);
    } catch (e) {
        console.error(`${LOG} digest failed: ${e.message}`);
    }
}

export function startHealthDigest() {
    if (started) return;
    started = true;
    onWarnError(record);
    setInterval(flush, 15 * 60_000).unref?.();
    cron.schedule('0 9 * * *', sendDigest, { timezone: 'UTC' });
    logger.info(`${LOG} counting warnings/errors; digest DM daily 09:00 UTC`);
}

export const _test = { record, counts, flush, sendDigest };
