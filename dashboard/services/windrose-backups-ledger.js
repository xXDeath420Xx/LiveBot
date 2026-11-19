// Windrose backup ledger (windrose_backups — migration 199).
//
// The filesystem is the source of truth for WHICH backups exist; this table records WHO took each
// snapshot (created_by) and of what kind. Rows are written when the panel takes a snapshot, and
// reconciled from the agent's list (which carries the agent's own ledger sidecar) whenever the
// backup list is shown — so snapshots taken by the scheduler, auto-update or the friend panel get
// a row too. Rows for files that were pruned are dropped.
//
// Like windrose-perms' audit(), nothing here throws into the request path: a ledger write failing
// must not fail the snapshot that already happened.

import { query } from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { parseBackupFilename, normaliseKind, backupReason } from './windrose-backup-meta.js';

const SNOWFLAKE = /^\d{15,25}$/;

function cleanUserId(id) {
    return id && SNOWFLAKE.test(String(id)) ? String(id) : null;
}

/** Record a snapshot the panel just took (or learned about). Keeps an existing author. */
export async function recordBackup({ filename, sizeBytes = 0, kind = null, createdBy = null } = {}, { db = { query } } = {}) {
    if (!filename) return;
    const k = normaliseKind(kind) || parseBackupFilename(filename).kind || 'manual';
    try {
        await db.query(
            `INSERT INTO windrose_backups (filename, size_bytes, kind, created_by)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE size_bytes = VALUES(size_bytes), kind = VALUES(kind),
                                     created_by = COALESCE(created_by, VALUES(created_by))`,
            [String(filename).slice(0, 255), Number(sizeBytes) || 0, k, cleanUserId(createdBy)]
        );
    } catch (err) {
        logger.error(`windrose backup ledger write failed (${filename}): ${err.message}`);
    }
}

/** Forget ledger rows for files that no longer exist (after a prune). */
export async function forgetBackups(filenames = [], { db = { query } } = {}) {
    const list = filenames.filter(Boolean);
    if (!list.length) return;
    try {
        await db.query(
            `DELETE FROM windrose_backups WHERE filename IN (${list.map(() => '?').join(', ')})`,
            list
        );
    } catch (err) {
        logger.error(`windrose backup ledger prune failed: ${err.message}`);
    }
}

function displayNameFor(userId, usersById) {
    if (!userId) return null;
    const u = usersById.get(userId);
    if (u?.display_name) return u.display_name;
    const discordUser = globalThis.botManager?.getUserFromAnyClient?.(userId);
    return discordUser ? (discordUser.globalName || discordUser.username) : null;
}

/**
 * The agent's backup list, each entry extended with kind, label, reason, createdBy and
 * createdByName. Missing ledger rows are created from what the agent reports.
 */
export async function annotateBackups(list = [], { db = { query } } = {}) {
    if (!Array.isArray(list) || !list.length) return Array.isArray(list) ? list : [];

    let rows = [];
    let users = [];
    try {
        const names = list.map((b) => b.filename).filter(Boolean);
        rows = await db.query(
            `SELECT filename, kind, created_by, created_at FROM windrose_backups WHERE filename IN (${names.map(() => '?').join(', ')})`,
            names
        );
        const authorIds = [...new Set([
            ...rows.map((r) => r.created_by),
            ...list.map((b) => cleanUserId(b.createdBy)),
        ].filter(Boolean))];
        if (authorIds.length) {
            users = await db.query(
                `SELECT discord_id, display_name FROM windrose_users WHERE discord_id IN (${authorIds.map(() => '?').join(', ')})`,
                authorIds
            );
        }
    } catch (err) {
        logger.error(`windrose backup ledger read failed: ${err.message}`);
    }

    const byFile = new Map(rows.map((r) => [r.filename, r]));
    const usersById = new Map(users.map((u) => [u.discord_id, u]));

    const out = [];
    for (const b of list) {
        const fromName = parseBackupFilename(b.filename);
        const row = byFile.get(b.filename);
        const kind = normaliseKind(row?.kind) || normaliseKind(b.kind) || fromName.kind || 'manual';
        const label = b.label || fromName.label || null;
        const createdBy = row?.created_by || cleanUserId(b.createdBy);

        // Reconcile: a backup the ledger has never seen, or one whose author only the agent knew.
        if (!row || (!row.created_by && createdBy)) {
            await recordBackup({ filename: b.filename, sizeBytes: b.sizeBytes, kind, createdBy }, { db });
        }

        out.push({
            ...b,
            kind,
            label,
            reason: backupReason({ kind, label }),
            createdBy: createdBy || null,
            createdByName: displayNameFor(createdBy, usersById),
        });
    }
    return out;
}

export default { recordBackup, forgetBackups, annotateBackups };
