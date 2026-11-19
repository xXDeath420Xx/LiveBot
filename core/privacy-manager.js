/*
 * Privacy self-service: the logic behind /privacy (commands/tools/privacy.js).
 *
 *   export   every row the bot holds about the member, as JSON (core/privacy-tables.js says which)
 *   delete   the member's own data from the DELETE_PLAN tables, identity stripped from
 *            ANONYMISE_PLAN rows; moderation records and the other KEPT categories stay
 *   opt-out / opt-in   message logging (no copies of their messages, see utils/message-cache.js)
 *            and leaderboards (excluded from public leaderboard queries)
 *
 * Game data (phase 5 of the game rewrite, register H-631): export and delete also cover the member's Greenhouse
 * Tycoon save (gh_* tables; the save linked to their Discord sign-in, with the Twitch and Kick sign-ins linked to
 * it) and, while the old game's tables still exist, their CertiFried Tycoon rows (cfx_*), through
 * services/cfx/privacy. Neither has a Discord-id column, so the table discovery below does not see them.
 *
 * Stream bot (core/stream-bot, register of the 2026-11-19 design): export and delete also cover the member's stream
 * bot profile (stream_bot_* tables, keyed by owner_discord_id, which the discovery below does not see) and, as a
 * viewer, events and {db:} values tied to their linked Twitch / Kick accounts, through core/stream-bot/privacy.js.
 *
 * Every action is recorded in privacy_actions_log (export / delete / view / update) and every
 * opt-in/out in user_consents (consent_type 'message_logging' | 'leaderboards').
 * All of it is bot-wide: it covers the member in every server the bot is in.
 */

import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getPrivacySettings, setPrivacySettings } from './privacy-settings.js';
import { purgeUserEvidenceCache } from './evidence-capture.js';
import { purgeCachedMessagesForUser } from '../utils/message-cache.js';
import {
    USER_ID_COLUMNS, classifyTable, redactRow, DELETE_PLAN, ANONYMISE_PLAN, KEPT_CATEGORIES, plannedTables,
    fitExportToBudget,
} from './privacy-tables.js';
import { createPersonPrivacy } from '../services/cfx/privacy/index.js';
import { createStreamBotPrivacy } from './stream-bot/privacy.js';
import { createStore as createStreamBotStore } from './stream-bot/store.js';

export const EXPORT_COOLDOWN_SECONDS = 24 * 60 * 60;
export const DELETE_COOLDOWN_SECONDS = 60 * 60;
const EXPORT_ROWS_PER_TABLE = 1000;
const EXPORT_MAX_BYTES = Math.floor(7.5 * 1024 * 1024); // under Discord's 10 MB attachment limit
const SAFE_IDENTIFIER = /^[A-Za-z0-9_]+$/;

// Greenhouse Tycoon (and the old game) privacy, created on first use; tests point it at throwaway tables.
let gamePrivacyInstance = null;
function gamePrivacy() {
    if (!gamePrivacyInstance) gamePrivacyInstance = createPersonPrivacy({ db: pool, rowLimit: EXPORT_ROWS_PER_TABLE });
    return gamePrivacyInstance;
}
/** Tests only: use this game privacy object (createPersonPrivacy with ghtest_ prefixes); null restores the default. */
export function setGamePrivacyForTests(instance) {
    gamePrivacyInstance = instance;
}

// Stream bot privacy, created on first use; tests point it at throwaway tables (createStore with a prefix).
let streamBotPrivacyInstance = null;
function streamBotPrivacy() {
    if (!streamBotPrivacyInstance) {
        streamBotPrivacyInstance = createStreamBotPrivacy({ store: createStreamBotStore({ db: pool }), db: pool, rowLimit: EXPORT_ROWS_PER_TABLE });
    }
    return streamBotPrivacyInstance;
}
/** Tests only: use this stream bot privacy object; null restores the default. */
export function setStreamBotPrivacyForTests(instance) {
    streamBotPrivacyInstance = instance;
}

export const OPT_TARGETS = Object.freeze({
    'message-logging': { setting: 'opt_out_message_logging', consent: 'message_logging', label: 'message logging' },
    leaderboards: { setting: 'opt_out_leaderboards', consent: 'leaderboards', label: 'leaderboards' },
});

// ─── Audit trail ───────────────────────────────────────────────────────────────────────────

export async function recordPrivacyAction(userId, actionType, details = {}) {
    try {
        await pool.execute(
            'INSERT INTO privacy_actions_log (user_id, action_type, details) VALUES (?, ?, ?)',
            [userId, actionType, JSON.stringify(details)]
        );
    } catch (error) {
        logger.error('[Privacy] Failed to record privacy action', { userId, actionType, error: error.message });
    }
}

async function recordConsent(userId, consentType, consented) {
    try {
        await pool.execute(
            `INSERT INTO user_consents (user_id, consent_type, consented) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE consented = VALUES(consented), timestamp = CURRENT_TIMESTAMP`,
            [userId, consentType, consented ? 1 : 0]
        );
    } catch (error) {
        logger.error('[Privacy] Failed to record consent', { userId, consentType, error: error.message });
    }
}

/** Seconds since the member last completed this action, or null if never. */
export async function secondsSinceLast(userId, actionType) {
    const [[row]] = await pool.execute(
        `SELECT TIMESTAMPDIFF(SECOND, MAX(\`timestamp\`), NOW()) AS ago
           FROM privacy_actions_log WHERE user_id = ? AND action_type = ?`,
        [userId, actionType]
    );
    return row?.ago === null || row?.ago === undefined ? null : Number(row.ago);
}

// ─── Opt-out / opt-in ──────────────────────────────────────────────────────────────────────

/**
 * @param {string} userId
 * @param {'message-logging'|'leaderboards'|'all'} what
 * @param {boolean} optOut true = opt out, false = opt back in
 */
export async function setOptOut(userId, what, optOut) {
    const targets = what === 'all' ? Object.keys(OPT_TARGETS) : [what];
    const patch = {};
    for (const t of targets) {
        if (!OPT_TARGETS[t]) throw new Error(`Unknown privacy option "${t}"`);
        patch[OPT_TARGETS[t].setting] = optOut;
    }
    const settings = await setPrivacySettings(userId, patch);
    for (const t of targets) await recordConsent(userId, OPT_TARGETS[t].consent, !optOut);

    // Opting out of message logging also removes what was already cached (not deleted-message
    // evidence — see utils/message-cache.js).
    let purgedMessages = 0;
    let purgedImages = 0;
    if (optOut && targets.includes('message-logging')) {
        try {
            purgedImages = await purgeUserEvidenceCache(userId);
            purgedMessages = await purgeCachedMessagesForUser(userId);
        } catch (error) {
            logger.error('[Privacy] Opt-out purge failed', { userId, error: error.message });
        }
    }

    await recordPrivacyAction(userId, 'update', { what: targets, opted_out: optOut, purged_messages: purgedMessages, purged_images: purgedImages });
    logger.info('[Privacy] Opt-out changed', { userId, what: targets, optOut, purgedMessages });
    return { settings, purgedMessages, purgedImages, targets };
}

// ─── Status ────────────────────────────────────────────────────────────────────────────────

export async function getStatus(userId) {
    const settings = await getPrivacySettings(userId);
    const [lastExport, lastDelete] = await Promise.all([
        secondsSinceLast(userId, 'export'),
        secondsSinceLast(userId, 'delete'),
    ]);
    await recordPrivacyAction(userId, 'view', { what: 'status' });
    return { settings, lastExport, lastDelete };
}

// ─── Export ────────────────────────────────────────────────────────────────────────────────

let exportChain = Promise.resolve();

/** Tables with a member-id column, from the live schema: Map<table, columns[]>. */
async function discoverUserTables() {
    const placeholders = USER_ID_COLUMNS.map(() => '?').join(',');
    const [rows] = await pool.execute(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN (${placeholders})
            AND DATA_TYPE IN ('varchar', 'char')
          ORDER BY TABLE_NAME, COLUMN_NAME`,
        USER_ID_COLUMNS
    );
    const tables = new Map();
    for (const { t, c } of rows) {
        if (!SAFE_IDENTIFIER.test(t) || !SAFE_IDENTIFIER.test(c)) continue;
        if (!tables.has(t)) tables.set(t, []);
        tables.get(t).push(c);
    }
    return tables;
}

/**
 * Build the member's export. Runs one at a time across the process — it reads ~200 tables.
 * @returns {Promise<{ buffer: Buffer, summary: { tables: number, rows: number, withheld: number, truncated: string[], errors: number } }>}
 */
export function buildExport(userId) {
    const job = exportChain.then(() => buildExportNow(userId));
    exportChain = job.catch(() => {});
    return job;
}

async function buildExportNow(userId) {
    const tables = await discoverUserTables();
    const sections = {};
    const withheld = {};
    const errors = [];

    for (const [table, columns] of tables) {
        const kind = classifyTable(table);
        if (kind === 'secret') continue;
        const where = columns.map(c => `\`${c}\` = ?`).join(' OR ');
        const params = columns.map(() => userId);
        try {
            if (kind === 'safety') {
                const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where}`, params);
                if (Number(n) > 0) withheld[table] = Number(n);
                continue;
            }
            const [rows] = await pool.query(`SELECT * FROM \`${table}\` WHERE ${where} LIMIT ?`, [...params, EXPORT_ROWS_PER_TABLE + 1]);
            if (!rows.length) continue;
            let total = rows.length;
            if (rows.length > EXPORT_ROWS_PER_TABLE) {
                const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where}`, params);
                total = Number(n);
            }
            sections[table] = {
                total,
                truncated: total > EXPORT_ROWS_PER_TABLE,
                rows: rows.slice(0, EXPORT_ROWS_PER_TABLE).map(redactRow),
            };
        } catch (error) {
            errors.push(table);
            logger.warn('[Privacy] Export skipped a table', { table, error: error.message });
        }
    }

    // Game data, keyed by the Discord sign-in rather than a Discord-id column (see the header).
    let games = null;
    try {
        const g = await gamePrivacy().exportFor({ platform: 'discord', platformUserId: userId });
        for (const [table, sec] of Object.entries(g.tables)) {
            if (!sec.rows.length) continue;
            sections[table] = { total: sec.total, truncated: sec.total > sec.rows.length, rows: sec.rows.map(redactRow) };
        }
        if (g.accountId || g.oldGamePlayers) {
            games = {
                note: 'Greenhouse Tycoon tables start with gh_. Its save covers every sign-in linked to it. '
                    + 'Tables starting with cfx_ are the old CertiFried Tycoon game, kept until it is removed.',
                greenhouse_account_id: g.accountId,
                greenhouse_sign_ins: g.signIns,
                old_game_players: g.oldGamePlayers,
            };
        }
    } catch (error) {
        errors.push('greenhouse_tycoon');
        logger.warn('[Privacy] Export skipped the game data', { error: error.message });
    }

    // Stream bot: the member's streamer profile (no secrets) and events about them as a viewer.
    let streamBot = null;
    try {
        const s = await streamBotPrivacy().exportFor(userId);
        if (s) {
            for (const [table, sec] of Object.entries(s.tables)) {
                if (!sec.rows.length) continue;
                sections[table] = { total: sec.total, truncated: false, rows: sec.rows.map(redactRow) };
            }
            streamBot = { note: s.note };
        }
    } catch (error) {
        errors.push('stream_bot');
        logger.warn('[Privacy] Export skipped the stream bot data', { error: error.message });
    }

    const settings = await getPrivacySettings(userId).catch(() => null);
    const serialise = (value) => JSON.stringify(value, null, 1);
    const { truncated } = fitExportToBudget(sections, EXPORT_MAX_BYTES - 64 * 1024, serialise);

    const payload = {
        generated_at: new Date().toISOString(),
        user_id: userId,
        about: 'Data the CertiFried bot holds about your Discord account, across every server it is in. '
            + 'Columns holding credentials are shown as [redacted] and staff identities as [staff member]. '
            + 'Tables marked truncated were cut to fit Discord\'s file size limit; "total" is the full row count.',
        privacy_settings: settings && { opt_out_message_logging: settings.opt_out_message_logging, opt_out_leaderboards: settings.opt_out_leaderboards },
        games,
        stream_bot: streamBot,
        tables: sections,
        moderation_records_withheld: {
            note: 'Moderation and safety records are not included. These are the counts; ask the staff of the server concerned about them.',
            counts: withheld,
        },
        tables_not_readable: errors,
    };

    const buffer = Buffer.from(serialise(payload), 'utf8');
    const rowCount = Object.values(sections).reduce((s, sec) => s + sec.rows.length, 0);
    const summary = {
        tables: Object.keys(sections).length,
        rows: rowCount,
        withheld: Object.values(withheld).reduce((s, n) => s + n, 0),
        truncated,
        errors: errors.length,
        bytes: buffer.length,
    };
    await recordPrivacyAction(userId, 'export', summary);
    logger.info('[Privacy] Export built', { userId, ...summary });
    return { buffer, summary };
}

// ─── Delete ────────────────────────────────────────────────────────────────────────────────

async function existingColumns(tables) {
    if (!tables.length) return new Set();
    const [rows] = await pool.execute(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`,
        tables
    );
    return new Set(rows.map(r => `${r.t}.${r.c}`));
}

/**
 * Delete / anonymise the member's rows. Each table is its own statement so one failure does
 * not undo the rest; a table refused by a foreign key is retried once after the others (its
 * children are usually later in the plan).
 * @returns {Promise<{ deleted: Record<string, number>, anonymised: Record<string, number>, failed: string[], rows: number }>}
 */
export async function deleteUserData(userId) {
    const columns = await existingColumns(plannedTables());
    const deleted = {};
    const anonymised = {};

    // Cached image copies first: their rows disappear with message_logs (ON DELETE CASCADE).
    try {
        await purgeUserEvidenceCache(userId);
    } catch (error) {
        logger.error('[Privacy] Evidence cache purge failed during delete', { userId, error: error.message });
    }

    const runStep = async (step) => {
        try {
            let n;
            if (step.table === 'message_logs') {
                n = await purgeCachedMessagesForUser(userId);
            } else {
                const extra = step.where ? ` AND ${step.where}` : '';
                const [result] = await pool.execute(`DELETE FROM \`${step.table}\` WHERE \`${step.column}\` = ?${extra}`, [userId]);
                n = result.affectedRows;
            }
            if (n) deleted[step.table] = (deleted[step.table] || 0) + n;
            return 'ok';
        } catch (error) {
            if (/foreign key|ER_ROW_IS_REFERENCED/i.test(`${error.code} ${error.message}`)) return 'fk';
            logger.error('[Privacy] Delete step failed', { userId, table: step.table, error: error.message });
            return 'error';
        }
    };

    const failed = [];
    const retry = [];
    for (const step of DELETE_PLAN) {
        if (!columns.has(`${step.table}.${step.column}`)) continue;   // not in this database
        const outcome = await runStep(step);
        if (outcome === 'fk') retry.push(step);
        else if (outcome === 'error') failed.push(step.table);
    }
    for (const step of retry) {
        const outcome = await runStep(step);
        if (outcome !== 'ok') {
            failed.push(step.table);
            if (outcome === 'fk') logger.error('[Privacy] Delete blocked by a foreign key', { userId, table: step.table });
        }
    }

    for (const step of ANONYMISE_PLAN) {
        if (!step.set.every(c => columns.has(`${step.table}.${c}`))) continue;
        try {
            const [result] = await pool.execute(
                `UPDATE \`${step.table}\` SET ${step.set.map(c => `\`${c}\` = NULL`).join(', ')} WHERE \`${step.column}\` = ?`,
                [userId]
            );
            if (result.affectedRows) anonymised[step.table] = (anonymised[step.table] || 0) + result.affectedRows;
        } catch (error) {
            failed.push(step.table);
            logger.error('[Privacy] Anonymise step failed', { userId, table: step.table, error: error.message });
        }
    }

    // Greenhouse Tycoon: the save linked to this Discord sign-in, with every sign-in on it, in one transaction;
    // then the old game's rows while its tables exist (services/cfx/privacy).
    try {
        const g = await gamePrivacy().deleteFor({ platform: 'discord', platformUserId: userId });
        for (const [table, n] of Object.entries(g.deleted)) deleted[table] = (deleted[table] || 0) + n;
        for (const [table, n] of Object.entries(g.anonymised)) anonymised[table] = (anonymised[table] || 0) + n;
    } catch (error) {
        failed.push('greenhouse_tycoon');
        logger.error('[Privacy] Game data delete failed', { userId, error: error.message });
    }

    // Stream bot: the member's profile and everything under it, and events / {db:} values about them as a viewer.
    try {
        const s = await streamBotPrivacy().deleteFor(userId);
        for (const [table, n] of Object.entries(s.deleted)) deleted[table] = (deleted[table] || 0) + n;
    } catch (error) {
        failed.push('stream_bot');
        logger.error('[Privacy] Stream bot data delete failed', { userId, error: error.message });
    }

    const rows = Object.values(deleted).reduce((s, n) => s + n, 0) + Object.values(anonymised).reduce((s, n) => s + n, 0);
    await recordPrivacyAction(userId, 'delete', { deleted, anonymised, failed, rows });
    logger.info('[Privacy] Data deleted on request', { userId, rows, failedTables: failed.length });
    return { deleted, anonymised, failed, rows };
}

export { KEPT_CATEGORIES };

export default {
    setOptOut, getStatus, buildExport, deleteUserData, recordPrivacyAction, secondsSinceLast,
    OPT_TARGETS, KEPT_CATEGORIES, EXPORT_COOLDOWN_SECONDS, DELETE_COOLDOWN_SECONDS,
};
