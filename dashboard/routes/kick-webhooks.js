/**
 * Kick event webhook receiver (follows, subs, stream status).
 *
 * Mounted BEFORE the global body parser (same pattern as the Fourthwall
 * webhook) because Kick signs the raw request bytes — RSA-SHA256 over
 * `messageId.timestamp.rawBody` — and re-serialized JSON would not be
 * byte-faithful. Being mounted before csrfProtection also exempts it from
 * CSRF (webhooks authenticate via signature, not session).
 *
 * We verify, ACK 200 immediately, then process async — Kick retries slow or
 * non-2xx deliveries, and the thank-you path does DB + chat API work.
 */
import express from 'express';
import logger from '../../utils/logger.js';
import { verifyKickSignature, getKickPublicKey, handleKickEvent } from '../../services/certifried-bot/kick-events.js';

const router = express.Router();

router.post('/events', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    try {
        const messageId = req.get('Kick-Event-Message-Id');
        const timestamp = req.get('Kick-Event-Message-Timestamp');
        const signature = req.get('Kick-Event-Signature');
        const eventType = req.get('Kick-Event-Type') || 'unknown';
        const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8')
            : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

        const publicKeyPem = await getKickPublicKey();
        if (!verifyKickSignature({ messageId, timestamp, rawBody, signatureB64: signature, publicKeyPem })) {
            logger.warn('[KickWebhooks] Rejected event with invalid signature', { eventType, messageId });
            return res.status(401).json({ error: 'invalid signature' });
        }

        let event;
        try { event = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'bad json' }); }

        // ACK fast, process async.
        res.status(200).json({ ok: true });
        handleKickEvent(eventType, event)
            .then(action => logger.info('[KickWebhooks] Event processed', { eventType, action }))
            .catch(err => logger.error('[KickWebhooks] Handler error', { eventType, error: err.message }));
    } catch (error) {
        logger.error('[KickWebhooks] Receive error', { error: error.message });
        if (!res.headersSent) res.status(500).json({ error: 'internal' });
    }
});

// Liveness probe (lets us curl-verify the mount without a signed payload).
router.get('/health', (req, res) => res.json({ ok: true }));

export default router;
