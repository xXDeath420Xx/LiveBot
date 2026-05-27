import cron from 'node-cron';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import encryption from '../utils/encryption.js';
import { platformClient } from '../utils/fourthwall-api.js';
import botManager from '../core/bot-manager.js';

let dailyTask = null;
let drainTask = null;

const ORPHAN_MAX_ATTEMPTS = 10;
const UNDELIVERED_MAX_AGE_DAYS = 7;

// Daily 04:00 — retry orphan webhook deletes, prune old dedupe rows.
async function runDaily() {
    const [orphans] = await pool.execute(
        `SELECT id, webhook_id, api_username, api_password, attempts
         FROM fourthwall_orphan_webhooks WHERE attempts < ? ORDER BY id LIMIT 50`,
        [ORPHAN_MAX_ATTEMPTS]
    );
    for (const o of orphans) {
        try {
            const user = encryption.decrypt(JSON.parse(o.api_username));
            const pass = encryption.decrypt(JSON.parse(o.api_password));
            await platformClient(user, pass).deleteWebhook(o.webhook_id);
            await pool.execute(`DELETE FROM fourthwall_orphan_webhooks WHERE id = ?`, [o.id]);
            logger.info('[FW Cleanup] orphan webhook deleted', { webhook_id: o.webhook_id });
        } catch (err) {
            await pool.execute(
                `UPDATE fourthwall_orphan_webhooks SET attempts = attempts + 1, last_attempt_at = NOW() WHERE id = ?`,
                [o.id]
            );
            if (o.attempts + 1 >= ORPHAN_MAX_ATTEMPTS) {
                logger.error('[FW Cleanup] giving up on orphan', { webhook_id: o.webhook_id, attempts: o.attempts + 1 });
            }
        }
    }

    await pool.execute(`DELETE FROM fourthwall_seen_events WHERE received_at < (NOW() - INTERVAL 30 DAY)`);
    await pool.execute(
        `DELETE FROM fourthwall_undelivered_events WHERE received_at < (NOW() - INTERVAL ? DAY)`,
        [UNDELIVERED_MAX_AGE_DAYS]
    );
}

// Every 5 minutes — drain fourthwall_undelivered_events when target bot is now online.
// Webhook receiver stashes here when getClientForGuild returned null/no manager.
async function drainUndelivered() {
    const [rows] = await pool.execute(
        `SELECT u.id, u.connection_id, u.event_id, u.event_type, u.payload,
                c.guild_id
         FROM fourthwall_undelivered_events u
         JOIN fourthwall_connections c ON c.id = u.connection_id
         ORDER BY u.id LIMIT 25`
    );
    if (rows.length === 0) return;

    for (const row of rows) {
        const client = botManager.getClientForGuild(row.guild_id);
        if (!client?.fourthwallManager) continue; // still offline; try again next cycle

        try {
            const conn = await client.fourthwallManager.getConnectionById(row.connection_id);
            if (!conn) {
                // Parent connection deleted in the meantime — discard the queued event.
                await pool.execute(`DELETE FROM fourthwall_undelivered_events WHERE id = ?`, [row.id]);
                continue;
            }
            const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
            await client.fourthwallManager.handleEvent(row.event_type, payload, conn);
            await pool.execute(`DELETE FROM fourthwall_undelivered_events WHERE id = ?`, [row.id]);
            logger.info('[FW Cleanup] undelivered event drained', {
                connectionId: row.connection_id, eventType: row.event_type
            });
        } catch (err) {
            logger.warn('[FW Cleanup] drain attempt failed; will retry', {
                id: row.id, err: err.message
            });
            // Leave the row in place — next cycle will retry.
        }
    }
}

export function startFourthwallCleanup() {
    if (!dailyTask) {
        dailyTask = cron.schedule('0 4 * * *', () => {
            runDaily().catch(err => logger.error('[FW Cleanup] daily failed', { err: err.message }));
        });
        logger.info('[FW Cleanup] daily scheduled at 04:00');
    }
    if (!drainTask) {
        drainTask = cron.schedule('*/5 * * * *', () => {
            drainUndelivered().catch(err => logger.error('[FW Cleanup] drain failed', { err: err.message }));
        });
        logger.info('[FW Cleanup] undelivered drain scheduled every 5 min');
    }
}

export function stopFourthwallCleanup() {
    if (dailyTask) { dailyTask.stop(); dailyTask = null; }
    if (drainTask) { drainTask.stop(); drainTask = null; }
}
