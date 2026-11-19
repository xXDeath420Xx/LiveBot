import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { isFrozen as cfxFrozen } from '../services/certifried-extension/freeze.js';
import { planGuildSweeps, GUILD_RETENTION_EVENT_TYPE } from '../core/guild-log-retention.js';
import { pruneEvidenceCache } from '../core/evidence-capture.js';
import { pruneServerImageFiles } from '../core/server-image-uploads.js';

/**
 * Enforce the retention windows in `data_retention_policy`.
 *
 * The database reached 1.41 GB with no retention at all. A third of it was
 * `cfx_worker_logs`: 2.97 million rows and 469 MB of debug output for a minigame
 * with five active players.
 *
 * ## Why deletion is batched
 *
 * `DELETE FROM cfx_worker_logs WHERE performed_at < ?` on a first run would
 * match roughly 2.9 million rows in a single statement. InnoDB holds row locks
 * for the whole transaction and builds an undo log the same size, so that one
 * statement can stall every writer to the table for minutes and balloon the
 * undo tablespace. Since this shares a database with 41 live bots, that is a
 * self-inflicted outage.
 *
 * So it deletes in bounded batches with a pause between them, and stops after a
 * per-table cap. The backlog drains over several nights instead of one long
 * lock. Steady state is far below the cap, so after the first few runs each
 * table finishes in one batch.
 *
 * ## Why it never derives the SQL from user input
 *
 * Table and column names cannot be parameterised, so they are validated against
 * information_schema before being interpolated. The policy table is only
 * writable by a migration today, but "only an admin can write it" is not a
 * reason to build a SQL-injection sink and hope.
 *
 * ## Per-guild windows (log_retention_policy)
 *
 * After the bot-wide pass, servers that chose a SHORTER window for their own message or
 * moderation logs (dashboard "Log retention" card, migration 288) get a second, guild-scoped
 * pass. core/guild-log-retention.js decides what applies: a guild value at or above the
 * bot-wide cap changes nothing, so a server can never keep data longer than the cap. These
 * deletes use the (guild_id, timestamp) indexes from migration 288 and the same batching.
 *
 * Finally the private image cache behind deleted-image evidence is pruned
 * (core/evidence-capture.js).
 */

const BATCH_SIZE = 5000;
const MAX_BATCHES_PER_TABLE = 40;   // 200k rows/table/night
const MAX_BATCHES_PER_GUILD_TABLE = 20;   // 100k rows/guild/table/night
const PAUSE_BETWEEN_BATCHES_MS = 250;

const SAFE_IDENTIFIER = /^[A-Za-z0-9_]+$/;

/**
 * Extra conditions for a table's bot-wide sweep, on top of `<column> < cutoff`. Fixed SQL, never from
 * the policy table. H-687: a modmail thread is only deleted once it is closed (its closed_at is NULL
 * while open, so the date test already skips it; this keeps a reopened or half-written row safe too).
 */
const SWEEP_GUARDS = Object.freeze({
    modmail_threads: "`status` = 'closed'",
});

/** The extra WHERE condition for a table's sweep, or null. */
export function sweepGuard(tableName) {
    return SWEEP_GUARDS[tableName] ?? null;
}

// HTML ticket transcripts written by core/ticket-manager.js (transcript-<ticket id>-<guild id>.html).
const TRANSCRIPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'transcripts');
const TRANSCRIPT_FILE = /^transcript-\d+-\d+\.html$/;

// Greeting-card media in dashboard/public/uploads: voice notes (/card/upload-audio), AI covers
// (utils/image-generation.js persistImage, prefix ai_cover_*) and PDF-import pages (card_<id>_page_<n>.png).
const CARD_UPLOAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'public', 'uploads');
const CARD_MEDIA_FILE = /^(audio_\d+_[a-z0-9]+\.webm|ai_cover_[a-z0-9_]+_\d+_[a-z0-9]+\.(?:png|jpe?g|webp|gif))$/;
const CARD_PAGE_FILE = /^card_(\d+)_page_\d+\.png$/;
const CARD_MEDIA_GRACE_MS = 24 * 60 * 60 * 1000;   // a recording or cover made for a card not saved yet

let task = null;

async function loadPolicies() {
    const [rows] = await pool.execute(
        `SELECT table_name, timestamp_column, retain_days
           FROM data_retention_policy
          WHERE enabled = 1 AND retain_days > 0`
    );
    return sweepable(rows);
}

/**
 * The policy rows the sweep acts on. CertiFried Tycoon is frozen until v2 (H-636): its tables are archived as they
 * are (overhaul phase 5), so retention leaves cfx_* alone meanwhile. Everything else is swept, Greenhouse Tycoon's
 * gh_* rows (services/cfx/config/retention.js) included.
 */
export function sweepable(rows) {
    return cfxFrozen() ? rows.filter(r => !String(r.table_name).startsWith('cfx_')) : rows;
}

/**
 * Confirm the table and column exist before interpolating either into SQL.
 * A policy row that has gone stale (table dropped, column renamed) is skipped
 * with a warning rather than throwing and aborting the rest of the sweep.
 */
async function validate(schema, tableName, column) {
    if (!SAFE_IDENTIFIER.test(tableName) || !SAFE_IDENTIFIER.test(column)) return false;

    const [rows] = await pool.execute(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
        [schema, tableName, column]
    );
    return rows.length > 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sweep one policy row (exported for tests: tests/cfx/v2/retention.test.js runs it on throwaway tables).
 * `guard` overrides the table's SWEEP_GUARDS condition (tests/modmail-retention-h687.test.js).
 */
export async function sweepTable(schema, { table_name: tableName, timestamp_column: column, retain_days: retainDays, guard }) {
    const extra = guard === undefined ? sweepGuard(tableName) : guard;
    if (!(await validate(schema, tableName, column))) {
        logger.warn(`[Retention] Skipping ${tableName}.${column} — no such table/column (stale policy row?)`);
        return { table: tableName, deleted: 0, skipped: true };
    }

    let deleted = 0;
    let batches = 0;

    while (batches < MAX_BATCHES_PER_TABLE) {
        const [result] = await pool.query(
            `DELETE FROM \`${tableName}\`
              WHERE \`${column}\` < DATE_SUB(NOW(), INTERVAL ? DAY)${extra ? ` AND ${extra}` : ''}
              LIMIT ?`,
            [retainDays, BATCH_SIZE]
        );

        deleted += result.affectedRows;
        batches++;

        if (result.affectedRows < BATCH_SIZE) break;   // caught up
        await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }

    const cappedOut = batches >= MAX_BATCHES_PER_TABLE;

    await pool.execute(
        `UPDATE data_retention_policy
            SET last_swept_at = NOW(), last_deleted = ?
          WHERE table_name = ?`,
        [deleted, tableName]
    );

    return { table: tableName, deleted, cappedOut };
}

export async function runRetentionSweep() {
    await sweepBotWide();

    // Independent of the bot-wide pass: one failing (or having nothing to do) must not skip the others.
    await sweepGuildOverrides();

    try {
        await pruneEvidenceCache();
    } catch (error) {
        logger.error(`[Retention] Evidence cache prune failed: ${error.message}`);
    }

    try {
        const files = await pruneTranscriptFiles();
        if (files.deleted) logger.info(`[Retention] transcripts/: removed ${files.deleted} HTML transcript(s) older than ${files.days}d`);
    } catch (error) {
        logger.error(`[Retention] Transcript file prune failed: ${error.message}`);
    }

    try {
        const media = await pruneCardMediaFiles();
        if (media.deleted) logger.info(`[Retention] uploads/: removed ${media.deleted} greeting-card file(s) no card or signature uses`);
    } catch (error) {
        logger.error(`[Retention] Card media prune failed: ${error.message}`);
    }

    // H-706: replaced bot avatars, welcome banners and schedule images that nothing links to any more.
    try {
        const images = await pruneServerImageFiles();
        if (images.deleted) logger.info(`[Retention] uploads/: removed ${images.deleted} replaced server image(s) nothing links to`);
    } catch (error) {
        logger.error(`[Retention] Server image prune failed: ${error.message}`);
    }
}

/** The /uploads/ file names a set of URL values point at. */
export function uploadNamesIn(values) {
    const names = new Set();
    for (const v of values) {
        const m = String(v ?? '').match(/\/uploads\/([^?#\s"'<>]+)/);
        if (m) names.add(m[1]);
    }
    return names;
}

/**
 * The privacy policy says voice notes, AI covers and imported pages go with their signature or card. Deleting
 * the row left the file behind (publicly reachable), and recordings or covers never saved to a card stayed for
 * good. A voice note or AI cover that no card or signature points at, older than a day, is deleted; an
 * imported page goes once its card no longer exists. `dir`, `refs` and `cardIds` are for tests.
 * @returns {Promise<{deleted: number}>}
 */
export async function pruneCardMediaFiles({ dir = CARD_UPLOAD_DIR, refs, cardIds, now = Date.now() } = {}) {
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return { deleted: 0 }; }
    const candidates = names.filter(n => CARD_MEDIA_FILE.test(n) || CARD_PAGE_FILE.test(n));
    if (!candidates.length) return { deleted: 0 };

    if (!refs || !cardIds) {
        const [cards] = await pool.query(
            'SELECT id, card_background_url, ai_cover_url, board_bg_image_url, cover_image_url, custom_logo_url FROM birthday_cards');
        const [sigs] = await pool.query('SELECT audio_url, gif_url, video_url FROM birthday_card_signatures');
        refs = uploadNamesIn([
            ...cards.flatMap(c => [c.card_background_url, c.ai_cover_url, c.board_bg_image_url, c.cover_image_url, c.custom_logo_url]),
            ...sigs.flatMap(s => [s.audio_url, s.gif_url, s.video_url]),
        ]);
        cardIds = new Set(cards.map(c => String(c.id)));
    }

    let deleted = 0;
    for (const name of candidates) {
        const page = name.match(CARD_PAGE_FILE);
        if (page ? cardIds.has(page[1]) : refs.has(name)) continue;
        const file = path.join(dir, name);
        try {
            const st = await fs.promises.stat(file);
            if (st.isFile() && now - st.mtimeMs > CARD_MEDIA_GRACE_MS) { await fs.promises.unlink(file); deleted++; }
        } catch { /* gone already, or unreadable: leave it */ }
    }
    return { deleted };
}

/**
 * H-673: the HTML ticket transcripts follow the `tickets` policy row. A file older than that row's retain_days
 * (by modification time, which is when the ticket closed) is deleted. Nothing is deleted while the row is
 * missing or disabled. `dir` and `retainDays` are for tests.
 * @returns {Promise<{deleted: number, days: number|null}>}
 */
export async function pruneTranscriptFiles({ dir = TRANSCRIPT_DIR, retainDays } = {}) {
    let days = retainDays;
    if (days === undefined) {
        const [rows] = await pool.execute(
            "SELECT retain_days FROM data_retention_policy WHERE table_name = 'tickets' AND enabled = 1 AND retain_days > 0");
        days = rows.length ? Number(rows[0].retain_days) : null;
    }
    if (!(days > 0)) return { deleted: 0, days: null };

    let names;
    try { names = await fs.promises.readdir(dir); } catch { return { deleted: 0, days }; }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (const name of names) {
        if (!TRANSCRIPT_FILE.test(name)) continue;
        const file = path.join(dir, name);
        try {
            const st = await fs.promises.stat(file);
            if (st.isFile() && st.mtimeMs < cutoff) { await fs.promises.unlink(file); deleted++; }
        } catch { /* gone already, or unreadable: leave it */ }
    }
    return { deleted, days };
}

async function sweepBotWide() {
    const started = Date.now();

    try {
        const [[{ schema }]] = await pool.execute('SELECT DATABASE() AS `schema`');
        const policies = await loadPolicies();

        if (!policies.length) {
            logger.debug('[Retention] No enabled policies — nothing to sweep');
            return;
        }

        let total = 0;
        const backlog = [];

        // Sequential, not parallel: the point is to be gentle on a database
        // shared with 41 live bots. Running 13 batched deletes at once would
        // undo the reason for batching in the first place.
        for (const policy of policies) {
            try {
                const result = await sweepTable(schema, policy);
                total += result.deleted;
                if (result.deleted) {
                    logger.info(`[Retention] ${result.table}: removed ${result.deleted} row(s) older than ${policy.retain_days}d`);
                }
                if (result.cappedOut) backlog.push(result.table);
            } catch (error) {
                logger.error(`[Retention] Sweep failed for ${policy.table_name}: ${error.message}`);
            }
        }

        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        if (total) logger.info(`[Retention] Swept ${total} row(s) across ${policies.length} table(s) in ${seconds}s`);

        // Say so rather than let a permanently-capped table look like a clean run.
        if (backlog.length) {
            logger.info(`[Retention] Hit the per-run cap on: ${backlog.join(', ')} — backlog continues next run`);
        }
    } catch (error) {
        logger.error(`[Retention] Sweep aborted: ${error.message}`, { stack: error.stack });
    }
}

/**
 * Guild-scoped deletes for servers that set a shorter window than the bot-wide cap.
 * The cap is read from ALL enabled bot-wide policies (not only those with retain_days > 0), so
 * a disabled bot-wide policy means "no cap" and the guild's own window (≤ 365 days) applies.
 */
export async function sweepGuildOverrides() {
    try {
        const [[{ schema }]] = await pool.execute('SELECT DATABASE() AS `schema`');
        const [overrides] = await pool.execute(
            `SELECT guild_id, message_logs_days, audit_logs_days
               FROM log_retention_policy
              WHERE event_type = ? AND (message_logs_days IS NOT NULL OR audit_logs_days IS NOT NULL)`,
            [GUILD_RETENTION_EVENT_TYPE]
        );
        if (!overrides.length) return;

        const [caps] = await pool.execute(
            'SELECT table_name, retain_days FROM data_retention_policy WHERE enabled = 1 AND retain_days > 0'
        );
        const plan = planGuildSweeps(overrides, caps);
        if (!plan.length) return;

        const validated = new Map();
        const perGuild = new Map();
        let total = 0;

        for (const step of plan) {
            const key = `${step.table}.${step.column}`;
            if (!validated.has(key)) validated.set(key, await validate(schema, step.table, step.column));
            if (!validated.get(key)) {
                logger.warn(`[Retention] Guild override skipped: ${key} does not exist`);
                continue;
            }
            try {
                let deleted = 0;
                for (let batch = 0; batch < MAX_BATCHES_PER_GUILD_TABLE; batch++) {
                    const [result] = await pool.query(
                        `DELETE FROM \`${step.table}\`
                          WHERE guild_id = ? AND \`${step.column}\` < DATE_SUB(NOW(), INTERVAL ? DAY)
                          LIMIT ?`,
                        [step.guildId, step.days, BATCH_SIZE]
                    );
                    deleted += result.affectedRows;
                    if (result.affectedRows < BATCH_SIZE) break;
                    await sleep(PAUSE_BETWEEN_BATCHES_MS);
                }
                total += deleted;
                perGuild.set(step.guildId, (perGuild.get(step.guildId) || 0) + deleted);
                if (deleted) {
                    logger.info(`[Retention] Guild ${step.guildId}: removed ${deleted} ${step.table} row(s) older than ${step.days}d (server setting)`);
                }
            } catch (error) {
                logger.error(`[Retention] Guild sweep failed for ${step.guildId} ${step.table}: ${error.message}`);
            }
        }

        for (const [guildId, deleted] of perGuild) {
            await pool.execute(
                `UPDATE log_retention_policy SET last_swept_at = NOW(), last_deleted = ?
                  WHERE guild_id = ? AND event_type = ?`,
                [deleted, guildId, GUILD_RETENTION_EVENT_TYPE]
            ).catch(error => logger.warn(`[Retention] Could not stamp guild sweep for ${guildId}: ${error.message}`));
        }

        if (total) logger.info(`[Retention] Guild overrides removed ${total} row(s) across ${perGuild.size} server(s)`);
    } catch (error) {
        logger.error(`[Retention] Guild override sweep aborted: ${error.message}`, { stack: error.stack });
    }
}

/**
 * 04:20 daily — after the 03:00 backup window, so a sweep never races the
 * dump and the backup always captures the pre-deletion state.
 */
export function startRetentionSweeper() {
    if (task) return task;
    task = cron.schedule('20 4 * * *', runRetentionSweep, { scheduled: true });
    logger.info('[Retention] Sweeper scheduled (daily 04:20)');
    return task;
}

export function stopRetentionSweeper() {
    if (task) { task.stop(); task = null; }
}

export default { startRetentionSweeper, stopRetentionSweeper, runRetentionSweep, sweepGuildOverrides };
