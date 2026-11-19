// Staged config changes, applied during a stop → write → start window.
//
// ServerDescription.json, WorldDescription.json and windrose_plus.json are all
// rewritten by the server as it shuts down, so an edit made while it runs is
// silently reverted — the user sees a success message and nothing changes.
// The agent refuses those writes outright for exactly that reason.
//
// Refusing is correct but not sufficient: "stop the server, edit settings,
// start it again" is three manual steps that people get halfway through. This
// service lets edits be staged at any time and applied atomically during the
// one window where they stick.
//
// Multipliers additionally need a PAK rebuild at launch, so they were never
// going to apply hot regardless.

import { query } from '../../utils/db.js';
import logger from '../../utils/logger.js';
import windroseAgent from './windrose-client.js';

const TARGETS = { multipliers: 'windrose_plus.json', world: 'WorldDescription.json' };

export async function stage(target, patch, stagedBy, { db = { query } } = {}) {
    const file = TARGETS[target];
    if (!file) throw new Error(`unknown config target ${target}`);
    if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) {
        throw new Error('nothing to stage');
    }

    const rows = await db.query(
        'SELECT id, patch FROM windrose_pending_config WHERE target_file = ? AND applied_at IS NULL ORDER BY id DESC LIMIT 1',
        [file],
    );

    if (rows.length) {
        // Merge into the existing unapplied row rather than queueing another.
        // Two rows for the same file would apply in an order nobody chose, and
        // the later one would silently win.
        const existing = typeof rows[0].patch === 'string' ? JSON.parse(rows[0].patch) : rows[0].patch;
        const merged = { ...existing, ...patch };
        await db.query(
            'UPDATE windrose_pending_config SET patch = ?, staged_by = ? WHERE id = ?',
            [JSON.stringify(merged), stagedBy, rows[0].id],
        );
        return { target, file, patch: merged, merged: true };
    }

    await db.query(
        'INSERT INTO windrose_pending_config (target_file, patch, staged_by) VALUES (?, ?, ?)',
        [file, JSON.stringify(patch), stagedBy],
    );
    return { target, file, patch, merged: false };
}

export async function listPending({ db = { query } } = {}) {
    const rows = await db.query(
        'SELECT id, target_file, patch, staged_by, created_at FROM windrose_pending_config WHERE applied_at IS NULL ORDER BY id ASC',
    );
    return rows.map((r) => ({
        ...r,
        patch: typeof r.patch === 'string' ? JSON.parse(r.patch) : r.patch,
    }));
}

export async function discard(id, { db = { query } } = {}) {
    await db.query('DELETE FROM windrose_pending_config WHERE id = ? AND applied_at IS NULL', [id]);
    return { discarded: id };
}

/**
 * Apply everything staged: stop → write → start.
 *
 * Ordering is the whole design. The writes only stick while stopped, so a
 * failure partway through must not leave the server down with settings
 * half-applied and nobody watching — hence the server is restarted in a finally
 * block even when a write fails.
 *
 * DISRUPTIVE: everyone is disconnected. The caller warns players first.
 */
export async function applyPending(appliedBy, { db = { query } } = {}) {
    const pending = await listPending({ db });
    if (!pending.length) return { applied: [], note: 'Nothing staged.' };

    const wasRunning = await windroseAgent.status();
    const shouldRestart = wasRunning.ok ? Boolean(wasRunning.data?.container?.running) : false;

    // Snapshot before changing world settings. Cheap (it copies an engine zip)
    // and it is the only undo available if a multiplier turns out to be a
    // mistake — xp in particular cannot be lowered again.
    const snapshot = await windroseAgent.snapshot({ kind: 'manual', createdBy: appliedBy, label: 'preconfig' });
    if (!snapshot.ok) logger.warn(`windrose: pre-config snapshot failed: ${snapshot.error}`);

    if (shouldRestart) {
        const stopped = await windroseAgent.stop();
        if (!stopped.ok) throw new Error(`could not stop the server: ${stopped.error}`);
    }

    const applied = [];
    const failed = [];
    try {
        for (const row of pending) {
            const result = row.target_file === 'windrose_plus.json'
                ? await windroseAgent.setMultipliers(row.patch)
                : await windroseAgent.setWorldSettings(row.patch);

            if (result.ok) {
                await db.query('UPDATE windrose_pending_config SET applied_at = NOW() WHERE id = ?', [row.id]);
                applied.push({ id: row.id, file: row.target_file, patch: row.patch, warnings: result.data?.warnings ?? [] });
            } else {
                // Leave the row unapplied so the change is not lost, and keep
                // going: one bad multiplier should not block a valid world edit.
                failed.push({ id: row.id, file: row.target_file, error: result.error });
                logger.warn(`windrose: staged config ${row.id} failed: ${result.error}`);
            }
        }
    } finally {
        if (shouldRestart) {
            const started = await windroseAgent.start();
            if (!started.ok) logger.error(`windrose: FAILED TO RESTART after config apply: ${started.error}`);
        }
    }

    return { applied, failed, snapshot: snapshot.ok ? snapshot.data : null, restarted: shouldRestart };
}
