/**
 * Auto-Backup Scheduler
 * Creates v5 backups for all guilds on a weekly schedule (Sunday 4:00 AM UTC)
 * Keeps the last 4 weekly backups per guild (rolling 1-month window)
 */

import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { createSnapshot, saveBackup } from '../utils/backup-utils.js';

let schedulerTask = null;
let isRunning = false;

const MAX_AUTO_BACKUPS = 4; // Keep last 4 weekly backups per guild

export function startBackupScheduler(client) {
    if (schedulerTask) {
        logger.info('[BackupScheduler] Already running');
        return;
    }

    // Weekly: Sunday at 4:00 AM UTC
    schedulerTask = cron.schedule('0 4 * * 0', async () => {
        if (isRunning) {
            logger.warn('[BackupScheduler] Previous backup cycle still running, skipping');
            return;
        }
        isRunning = true;
        logger.info('[BackupScheduler] Starting weekly auto-backup cycle');

        try {
            await runBackupCycle(client);
        } catch (error) {
            logger.error('[BackupScheduler] Error in backup cycle:', { error: error.message });
        }

        isRunning = false;
    });

    schedulerTask.start();
    logger.info('[BackupScheduler] Started — weekly backups every Sunday 4:00 AM UTC');
}

export function stopBackupScheduler() {
    if (schedulerTask) {
        schedulerTask.stop();
        schedulerTask = null;
        logger.info('[BackupScheduler] Stopped');
    }
}

async function runBackupCycle(client) {
    const botManager = global.botManager;
    if (!botManager) {
        logger.warn('[BackupScheduler] No botManager available');
        return;
    }

    const date = new Date().toISOString().split('T')[0];
    const snapshotName = `Auto Weekly — ${date}`;
    let success = 0;
    let failed = 0;
    let skipped = 0;

    // Collect all guilds from all bot clients
    const guildMap = new Map(); // guildId -> guild object
    for (const [, botClient] of botManager.clients) {
        if (!botClient.isReady()) continue;
        for (const [guildId, guild] of botClient.guilds.cache) {
            if (!guildMap.has(guildId)) guildMap.set(guildId, guild);
        }
    }

    logger.info(`[BackupScheduler] Backing up ${guildMap.size} guilds`);

    for (const [guildId, guild] of guildMap) {
        try {
            const snapshot = await createSnapshot(guild);
            await saveBackup(guildId, snapshotName, snapshot, 'auto-scheduler');
            success++;

            // Prune old auto-backups beyond MAX_AUTO_BACKUPS
            try {
                const [autoBackups] = await pool.execute(
                    "SELECT id FROM server_backups WHERE guild_id = ? AND snapshot_name LIKE 'Auto Weekly%' ORDER BY created_at DESC",
                    [guildId]
                );
                if (autoBackups.length > MAX_AUTO_BACKUPS) {
                    const toDelete = autoBackups.slice(MAX_AUTO_BACKUPS).map(b => b.id);
                    await pool.execute(
                        `DELETE FROM server_backups WHERE id IN (${toDelete.map(() => '?').join(',')})`,
                        toDelete
                    );
                    logger.info(`[BackupScheduler] Pruned ${toDelete.length} old auto-backups for ${guild.name}`);
                }
            } catch { /* prune is best-effort */ }

            // Small delay between guilds to avoid hammering Discord API
            await new Promise(r => setTimeout(r, 2000));
        } catch (error) {
            failed++;
            logger.error(`[BackupScheduler] Failed backup for ${guild.name} (${guildId}):`, { error: error.message });
        }
    }

    logger.info(`[BackupScheduler] Cycle complete — ${success} success, ${failed} failed, ${skipped} skipped out of ${guildMap.size} guilds`);
}

// Export for manual trigger
export { runBackupCycle };
