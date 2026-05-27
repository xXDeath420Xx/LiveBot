import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import encryption from '../../../utils/encryption.js';
import { verifyHmac } from '../../../utils/fourthwall-api.js';
import botManager from '../../../core/bot-manager.js';

const router = express.Router();

router.post(
    '/:token',
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req, res) => {
        const { token } = req.params;
        const sigHeader = req.get('X-Fourthwall-Hmac-Sha256')
            || req.get('Fourthwall-Hmac-Sha256')
            || req.get('X-Webhook-Signature');

        if (!sigHeader) {
            logger.warn('[FW Webhook] missing signature header');
            return res.status(401).end();
        }

        let connRow;
        try {
            const [rows] = await pool.execute(
                `SELECT * FROM fourthwall_connections WHERE connection_token = ?`,
                [token]
            );
            connRow = rows[0];
        } catch (err) {
            logger.error('[FW Webhook] db lookup failed', { err: err.message });
            return res.status(500).end();
        }
        if (!connRow) return res.status(404).end();

        let secret;
        try {
            secret = encryption.decrypt(JSON.parse(connRow.webhook_secret));
        } catch (err) {
            logger.error('[FW Webhook] secret decrypt failed', { err: err.message, connectionId: connRow.id });
            return res.status(500).end();
        }

        if (!verifyHmac(req.body, sigHeader, secret)) {
            logger.warn('[FW Webhook] HMAC mismatch', { connectionId: connRow.id });
            return res.status(401).end();
        }

        let payload;
        try {
            payload = JSON.parse(req.body.toString('utf8'));
        } catch (err) {
            logger.warn('[FW Webhook] bad json', { err: err.message });
            return res.status(400).end();
        }

        const eventId = payload.id || payload.event_id || payload.eventId
            || (req.get('X-Fourthwall-Event-Id') || '')
            || `${connRow.id}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
        const eventType = payload.type || payload.event || payload.eventType
            || req.get('X-Fourthwall-Event-Type') || 'UNKNOWN';

        let inserted;
        try {
            [inserted] = await pool.execute(
                `INSERT IGNORE INTO fourthwall_seen_events (event_id, connection_id, event_type) VALUES (?, ?, ?)`,
                [String(eventId).slice(0, 100), connRow.id, String(eventType).slice(0, 100)]
            );
        } catch (err) {
            logger.error('[FW Webhook] dedupe insert failed', { err: err.message });
            return res.status(500).end();
        }
        if (inserted.affectedRows === 0) {
            return res.status(204).end();
        }

        res.status(204).end();

        setImmediate(async () => {
            const client = botManager.getClientForGuild(connRow.guild_id);
            if (!client?.fourthwallManager) {
                logger.warn('[FW Webhook] no client/manager for guild', { guildId: connRow.guild_id });
                await pool.execute(
                    `INSERT INTO fourthwall_undelivered_events (connection_id, event_id, event_type, payload) VALUES (?, ?, ?, ?)`,
                    [connRow.id, String(eventId).slice(0, 100), String(eventType).slice(0, 100), JSON.stringify(payload)]
                ).catch(e => logger.error('[FW Webhook] undelivered insert failed', { err: e.message }));
                return;
            }
            try {
                await client.fourthwallManager.handleEvent(eventType, payload, connRow);
            } catch (err) {
                logger.error('[FW Webhook] handleEvent threw', {
                    err: err.message, stack: err.stack, eventType, connectionId: connRow.id
                });
            }
        });
    }
);

export default router;
