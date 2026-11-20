/**
 * Server Backup Routes — create, delete, restore (preview, run, resume, progress), and "what changed".
 *
 * The default export is mounted by dashboard/server.js at '/manage/:guildId' (with checkAuth and
 * checkGuildAdmin), so its paths are relative to that: POST /manage/:guildId/create-backup etc.
 * `backupApiRouter` serves GET /api/guilds/:guildId/backup-diff/:backupId and is mounted by
 * dashboard/routes/api/index.js under '/guilds/:guildId' (behind apiCheckGuildAdmin).
 *
 * Until 2026-11-18 every route here declared its full path while being mounted under
 * /manage/:guildId, so the real URLs were /manage/:id/manage/:id/... and all four page actions
 * returned 404 (register H-302).
 */

import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { createSnapshot, saveBackup } from '../../../utils/backup-utils.js';
import { loadBackupRow, previewRestore, startRestore, runStatus, activeRun } from '../../../core/backup-restore.js';
import { logFeatureEvent, userLabel } from '../../../core/feature-log.js';
import { isRestoreDisabled, RESTORE_UNAVAILABLE_MESSAGE } from '../../../utils/backup-restore-guard.js';

const router = express.Router({ mergeParams: true });
export const backupApiRouter = express.Router({ mergeParams: true });

const liveGuild = (guildId) => global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);

// Create backup
router.post('/create-backup', async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const snapshotName = String(req.body.snapshot_name || '').trim().slice(0, 100);
        if (!snapshotName) return res.redirect(`/manage/${guildId}?page=backups&error=name_required`);

        const botClient = global.botManager?.getClientForGuild(guildId) || req.app.locals.client;
        const guild = botClient?.guilds?.cache?.get(guildId);
        if (!guild) return res.redirect(`/manage/${guildId}?page=backups&error=guild_not_found`);

        const snapshot = await createSnapshot(guild);
        await saveBackup(guildId, snapshotName, snapshot, req.user.id);

        const m = snapshot.meta;
        logger.info(`[Backup] Created v5 backup "${snapshotName}" for ${guild.name} (${guildId}) — ${m.roleCount} roles, ${m.channelCount} channels, ${m.emojiCount} emojis, ${m.stickerCount} stickers, ${snapshot.discord.members.length} members, ${m.webhookCount} webhooks, ${m.banCount} bans, ${m.configTablesCount} config tables (${m.configRowsCount} rows)`);
        void logFeatureEvent(() => (guild), 'backup.created', () => ({
            title: '💾 Backup Created',
            description: `Server backup **${snapshotName}** was saved from the dashboard.`,
            fields: [
                ['Name', snapshotName],
                ['By', userLabel(req.user)],
                ['Roles', m.roleCount],
                ['Channels', m.channelCount],
                ['Emojis', m.emojiCount],
                ['Members', snapshot.discord?.members?.length],
                ['Bot settings', `${m.configTablesCount} tables (${m.configRowsCount} rows)`],
            ],
        }));
        res.redirect(`/manage/${guildId}?page=backups&success=created`);
    } catch (error) {
        logger.error('[Backup] Error creating backup:', { error: error.message, stack: error.stack, guildId });
        res.redirect(`/manage/${guildId}?page=backups&error=create_failed`);
    }
});

// Delete backup
router.post('/delete-backup', async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const backupId = req.body.backupId;
        if (!backupId) return res.redirect(`/manage/${guildId}?page=backups&error=no_id`);
        // Name read first so the server log can say what was deleted (best-effort).
        const [[doomed]] = await pool.execute('SELECT snapshot_name FROM server_backups WHERE id = ? AND guild_id = ?', [backupId, guildId])
            .catch(() => [[null]]);
        const [deleted] = await pool.execute('DELETE FROM server_backups WHERE id = ? AND guild_id = ?', [backupId, guildId]);
        logger.info(`[Backup] Deleted backup ${backupId} for guild ${guildId} by ${req.user.username}`);
        if (deleted?.affectedRows > 0) {
            void logFeatureEvent(() => (liveGuild(guildId)), 'backup.deleted', () => ({
                title: '🗑️ Backup Deleted',
                description: `Server backup **${doomed?.snapshot_name || `#${backupId}`}** was deleted from the dashboard.`,
                fields: [['Name', doomed?.snapshot_name], ['Backup ID', String(backupId)], ['By', userLabel(req.user)]],
            }));
        }
        res.redirect(`/manage/${guildId}?page=backups&success=deleted`);
    } catch (error) {
        logger.error('[Backup] Error deleting backup:', { error: error.message, guildId });
        res.redirect(`/manage/${guildId}?page=backups&error=delete_failed`);
    }
});

// Restore backup (register H-801, rebuilt 2026-11-20). core/backup-restore.js does the work:
//   GET  /api/guilds/:guildId/backup-restore-preview/:backupId   dry run (what is created, changed, deleted)
//   POST /manage/:guildId/restore-backup                         starts the run the admin confirmed (planHash)
//   POST /manage/:guildId/restore-backup/resume                  continues an interrupted or failed run
//   GET  /api/guilds/:guildId/backup-restore-status              progress for the page
// Nothing is deleted unless removeExtras is ticked, and deletes run last.
const wantsJson = (req) => req.xhr || /json/i.test(req.get('accept') || '');
const flag = (v) => v === true || v === 'true' || v === '1' || v === 'on';
function restoreOptions(src) {
    return { removeExtras: flag(src.removeExtras), restoreBotConfig: src.restoreBotConfig === undefined ? true : flag(src.restoreBotConfig), restoreBans: flag(src.restoreBans) };
}
function botGuild(req, guildId) {
    const botClient = global.botManager?.getClientForGuild?.(guildId) || req.app?.locals?.client;
    return botClient?.guilds?.cache?.get(guildId) || null;
}
function publicRun(run) {
    if (!run) return null;
    const { runId, backupId, backupName, by, source, options, status, startedAt, updatedAt, finishedAt, total, error } = run;
    return { runId, backupId, backupName, by: by?.name || null, source, options, status, startedAt, updatedAt, finishedAt, total,
        done: run.completed?.length || 0, failed: (run.failed || []).slice(-20), failedCount: (run.failed || []).length, error: error || null, log: (run.log || []).slice(-15) };
}
function restoreHooks(guild, req) {
    return {
        onStart: (run, summary) => void logFeatureEvent(() => (guild), 'backup.restoreStarted', () => ({
            title: '⏳ Backup Restore Started',
            description: `Restoring server backup **${run.backupName}** from the dashboard. ${run.options.removeExtras ? 'Channels and roles that are not in the backup are removed at the end.' : 'Nothing that is not in the backup is removed.'}`,
            fields: [['Name', run.backupName], ['By', userLabel(req.user)], ['Create', `${summary.counts.createRoles} roles, ${summary.counts.createCategories} categories, ${summary.counts.createChannels} channels`],
                ['Change', summary.counts.updates], ['Delete', summary.counts.deletes]],
        })),
        onFinish: (run) => {
            const fields = [['Steps done', `${run.completed.length}/${run.total}`], ['Failed', run.failed.length], ['By', userLabel(req.user)]];
            if (run.status === 'failed') {
                void logFeatureEvent(() => (guild), 'backup.failed', () => ({
                    title: '❌ Backup Restore Stopped',
                    description: `The restore of **${run.backupName}** stopped: ${run.error || 'unknown error'}. It can be resumed from the Backups page.`,
                    fields,
                }));
            } else {
                void logFeatureEvent(() => (guild), 'backup.restored', () => ({
                    title: '♻️ Backup Restored',
                    description: `Server backup **${run.backupName}** was restored from the dashboard.`,
                    fields,
                }));
            }
        },
    };
}

router.post('/restore-backup', async (req, res) => {
    const guildId = req.params.guildId;
    const fail = (error, code = 'restore_failed', extra = {}) => (wantsJson(req)
        ? res.json({ success: false, error, ...extra })
        : res.redirect(`/manage/${guildId}?page=backups&error=${encodeURIComponent(code)}`));
    // H-801 kill switch: refuse before reading the backup or touching the server.
    if (isRestoreDisabled()) {
        logger.warn(`[Backup Restore] Refused (restore disabled, H-801) for ${guildId} by ${req.user?.username || '?'}`);
        return fail(RESTORE_UNAVAILABLE_MESSAGE, RESTORE_UNAVAILABLE_MESSAGE);
    }
    try {
        const backupId = parseInt(req.body.backupId, 10);
        if (!backupId) return fail('No backup chosen.', 'no_id');
        // Only a previewed plan runs: the page sends the hash of the preview the admin saw.
        if (!req.body.planHash) return fail('Open the preview and confirm it first.', 'preview_required');
        const backupRow = await loadBackupRow(pool, guildId, backupId);
        if (!backupRow) return fail('That backup was not found.', 'not_found');
        const guild = botGuild(req, guildId);
        if (!guild) return fail('The bot cannot see this server.', 'guild_not_found');
        // 0 = "Off" on the page; only a missing or unreadable value falls back to 30 days.
        const graceRaw = parseInt(req.body.gracePeriod, 10);
        const graceDays = Number.isFinite(graceRaw) ? Math.min(Math.max(graceRaw, 0), 365) : 30;
        const r = await startRestore({ guild, backupRow, options: restoreOptions(req.body), by: req.user, source: 'dashboard',
            expectedHash: String(req.body.planHash), graceDays, deps: restoreHooks(guild, req) });
        if (!r.ok) return fail(r.error, 'restore_not_started', r.summary ? { summary: r.summary } : {});
        r.done.catch(() => {});
        if (wantsJson(req)) return res.json({ success: true, message: 'Restore started. Progress shows on this page.', run: publicRun(r.run) });
        res.redirect(`/manage/${guildId}?page=backups&success=restore_started`);
    } catch (error) {
        logger.error('[Backup Restore] Error:', { error: error.message, stack: error.stack, guildId });
        fail('The restore could not start. Nothing was changed.');
    }
});

router.post('/restore-backup/resume', async (req, res) => {
    const guildId = req.params.guildId;
    if (isRestoreDisabled()) return res.json({ success: false, error: RESTORE_UNAVAILABLE_MESSAGE });
    try {
        const prior = runStatus(guildId);
        if (!prior || !['interrupted', 'failed', 'done_with_errors'].includes(prior.status)) return res.json({ success: false, error: 'There is no unfinished restore to resume.' });
        const backupRow = await loadBackupRow(pool, guildId, prior.backupId);
        if (!backupRow) return res.json({ success: false, error: 'The backup of that restore no longer exists.' });
        const guild = botGuild(req, guildId);
        if (!guild) return res.json({ success: false, error: 'The bot cannot see this server.' });
        const r = await startRestore({ guild, backupRow, resume: true, by: req.user, source: 'dashboard', graceDays: prior.graceDays || 0, deps: restoreHooks(guild, req) });
        if (!r.ok) return res.json({ success: false, error: r.error });
        r.done.catch(() => {});
        res.json({ success: true, message: 'Restore resumed.', run: publicRun(r.run) });
    } catch (error) {
        logger.error('[Backup Restore] Resume error:', { error: error.message, stack: error.stack, guildId });
        res.json({ success: false, error: 'The restore could not be resumed.' });
    }
});

backupApiRouter.get('/backup-restore-preview/:backupId', async (req, res) => {
    const { guildId } = req.params;
    try {
        if (isRestoreDisabled()) return res.json({ success: false, error: RESTORE_UNAVAILABLE_MESSAGE });
        const backupRow = await loadBackupRow(pool, guildId, parseInt(req.params.backupId, 10) || 0);
        if (!backupRow) return res.status(404).json({ success: false, error: 'Backup not found' });
        const guild = botGuild(req, guildId);
        if (!guild) return res.status(404).json({ success: false, error: 'The bot cannot see this server.' });
        const pv = await previewRestore({ guild, backupRow, options: restoreOptions(req.query) });
        if (!pv.ok) return res.json({ success: false, error: pv.error });
        res.json({ success: true, backupName: backupRow.snapshot_name, summary: pv.summary, running: !!activeRun(guildId) });
    } catch (error) {
        logger.error('[Backup Restore] Preview error:', { error: error.message, stack: error.stack, guildId });
        res.status(500).json({ success: false, error: 'Could not build the preview.' });
    }
});

backupApiRouter.get('/backup-restore-status', (req, res) => {
    res.json({ success: true, run: publicRun(runStatus(req.params.guildId)) });
});

// Backup diff — compare a backup against current server state
backupApiRouter.get('/backup-diff/:backupId', async (req, res) => {
    try {
        const { guildId, backupId } = req.params;
        const [rows] = await pool.execute('SELECT snapshot_name, snapshot_json FROM server_backups WHERE id = ? AND guild_id = ?', [backupId, guildId]);
        if (!rows.length) return res.status(404).json({ error: 'Backup not found' });

        const snapshot = JSON.parse(rows[0].snapshot_json);
        const disc = snapshot.discord || snapshot;

        const botClient = global.botManager?.getClientForGuild(guildId) || req.app?.locals?.client;
        const guild = botClient?.guilds?.cache?.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Guild not accessible' });

        const diff = { roles: { added: [], removed: [], changed: [] }, categories: { added: [], removed: [] }, channels: { added: [], removed: [] }, settings: [], bans: { added: 0, removed: 0 }, emojis: { added: 0, removed: 0 }, summary: {} };

        // Role diff
        const currentRoles = guild.roles.cache.filter(r => !r.managed && r.name !== '@everyone');
        const backupRoleNames = new Set((disc.roles || []).map(r => r.name));
        const currentRoleNames = new Set(currentRoles.map(r => r.name));

        for (const r of disc.roles || []) {
            if (!currentRoleNames.has(r.name)) {
                diff.roles.removed.push(r.name);
            } else {
                const current = currentRoles.find(cr => cr.name === r.name);
                if (current) {
                    const changes = [];
                    if (current.hexColor !== r.color) changes.push(`color: ${r.color} → ${current.hexColor}`);
                    if (current.permissions.bitfield.toString() !== r.permissions) changes.push('permissions changed');
                    if (current.hoist !== r.hoist) changes.push(`hoist: ${r.hoist} → ${current.hoist}`);
                    if (changes.length) diff.roles.changed.push({ name: r.name, changes });
                }
            }
        }
        for (const [, r] of currentRoles) {
            if (!backupRoleNames.has(r.name)) diff.roles.added.push(r.name);
        }

        // Category diff
        const currentCats = guild.channels.cache.filter(c => c.type === 4);
        const backupCatNames = new Set((disc.categories || []).map(c => c.name));
        const currentCatNames = new Set(currentCats.map(c => c.name));
        for (const c of disc.categories || []) { if (!currentCatNames.has(c.name)) diff.categories.removed.push(c.name); }
        for (const [, c] of currentCats) { if (!backupCatNames.has(c.name)) diff.categories.added.push(c.name); }

        // Channel diff
        const currentChannels = guild.channels.cache.filter(c => c.type !== 4);
        const backupChNames = new Set((disc.channels || []).map(c => c.name));
        const currentChNames = new Set(currentChannels.map(c => c.name));
        for (const c of disc.channels || []) { if (!currentChNames.has(c.name)) diff.channels.removed.push(c.name); }
        for (const [, c] of currentChannels) { if (!backupChNames.has(c.name)) diff.channels.added.push(c.name); } // the page adds the # (H-809)

        // Settings diff
        if (disc.settings) {
            const s = disc.settings;
            if (s.verificationLevel !== undefined && s.verificationLevel !== guild.verificationLevel) diff.settings.push(`Verification level: ${s.verificationLevel} → ${guild.verificationLevel}`);
            if (s.explicitContentFilter !== undefined && s.explicitContentFilter !== guild.explicitContentFilter) diff.settings.push(`Content filter: ${s.explicitContentFilter} → ${guild.explicitContentFilter}`);
            if (s.name && s.name !== guild.name) diff.settings.push(`Server name: ${s.name} → ${guild.name}`);
        }

        // Emoji diff
        const backupEmojiNames = new Set((disc.emojis || []).map(e => e.name));
        const currentEmojiNames = new Set(guild.emojis.cache.filter(e => !e.managed).map(e => e.name));
        diff.emojis.removed = [...backupEmojiNames].filter(n => !currentEmojiNames.has(n)).length;
        diff.emojis.added = [...currentEmojiNames].filter(n => !backupEmojiNames.has(n)).length;

        // Summary
        const totalChanges = diff.roles.added.length + diff.roles.removed.length + diff.roles.changed.length +
            diff.categories.added.length + diff.categories.removed.length +
            diff.channels.added.length + diff.channels.removed.length +
            diff.settings.length + diff.emojis.added + diff.emojis.removed;

        diff.summary = {
            totalChanges,
            identical: totalChanges === 0,
            backupName: rows[0].snapshot_name,
            backupVersion: snapshot.version || '?',
            backupDate: snapshot.meta?.createdAt
        };

        res.json({ success: true, diff });
    } catch (error) {
        logger.error('[Backup Diff] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to generate diff' });
    }
});

export default router;
