/**
 * Daily check for the retired DM pause switch (register H-660).
 *
 * /lockdown dm-pause (guild_settings.dm_disable_enabled) had its own renewer beside the keep switches of
 * the raid lockdown (raid_detection_config.keep_dms_disabled, renewed hourly by
 * core/raid-lockdown.js renewIncidentActions). It is retired and migration 447 moved every server that had
 * it on to keep_dms_disabled. This job only catches a server that switched it on after that migration
 * (an old process still running): it moves that server to the keep switch too and applies it once, so
 * there is one DM pause and one renewer.
 *
 * Runs at 03:15 UTC (index.js starts it as before).
 */
import cron from 'node-cron';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import botManager from '../core/bot-manager.js';
import { saveSettings, syncIncidents } from '../core/raid-lockdown.js';

const LOG = '[DMDisableRenewer]';
let task = null;

async function runCycle() {
    const [rows] = await pool.execute('SELECT guild_id FROM guild_settings WHERE dm_disable_enabled = 1');
    let moved = 0;
    for (const r of rows) {
        const guildId = String(r.guild_id);
        try {
            await saveSettings(guildId, { keep_dms_disabled: 1 });
            await pool.execute('UPDATE guild_settings SET dm_disable_enabled = 0 WHERE guild_id = ?', [guildId]);
            moved++;
            const guild = botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
            if (guild) await syncIncidents(guild, { why: 'retired DM pause switch moved to the keep switch' });
        } catch (err) {
            logger.warn(`${LOG} move ${guildId}: ${err.message}`);
        }
    }
    if (rows.length) logger.info(`${LOG} ${moved} of ${rows.length} server(s) moved from the retired DM pause to keep_dms_disabled`);
    return { total: rows.length, moved };
}

export function startDMDisableRenewer() {
    if (task) { logger.warn(`${LOG} already running`); return; }
    task = cron.schedule('15 3 * * *', () => {
        runCycle().catch(err => logger.error(`${LOG} cycle error: ${err.message}`));
    });
    // Once at start-up too, so a server switched on by the old command is moved without waiting a day.
    setTimeout(() => runCycle().catch(err => logger.error(`${LOG} start-up check error: ${err.message}`)), 60_000).unref?.();
    logger.info(`${LOG} scheduled daily at 03:15 UTC (moves the retired DM pause switch to the raid lockdown keep switch)`);
}
export function stopDMDisableRenewer() {
    if (task) { task.stop(); task = null; }
    logger.info(`${LOG} stopped`);
}
