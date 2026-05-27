import cron from 'node-cron';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import encryption from '../utils/encryption.js';
import { platformClient } from '../utils/fourthwall-api.js';

let task = null;

async function runOnce() {
    const [orphans] = await pool.execute(
        `SELECT id, webhook_id, api_username, api_password, attempts
         FROM fourthwall_orphan_webhooks WHERE attempts < 10 ORDER BY id LIMIT 50`
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
            if (o.attempts + 1 >= 10) {
                logger.error('[FW Cleanup] giving up on orphan', { webhook_id: o.webhook_id, attempts: o.attempts + 1 });
            }
        }
    }

    await pool.execute(`DELETE FROM fourthwall_seen_events WHERE received_at < (NOW() - INTERVAL 30 DAY)`);
}

export function startFourthwallCleanup() {
    if (task) return;
    task = cron.schedule('0 4 * * *', () => {
        runOnce().catch(err => logger.error('[FW Cleanup] failed', { err: err.message }));
    });
    logger.info('[FW Cleanup] scheduled daily at 04:00');
}

export function stopFourthwallCleanup() {
    if (task) { task.stop(); task = null; }
}
