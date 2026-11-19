/**
 * Twitch EventSub webhook receiver — the push endpoint that replaces minute-cron polling.
 *
 * Mounted BEFORE the global body parser (same as the Fourthwall/Kick webhooks) because Twitch signs
 * the RAW request bytes — HMAC-SHA256 over `messageId + timestamp + rawBody` — and a re-serialized
 * JSON body would not be byte-faithful. Being mounted before csrfProtection also exempts it from
 * CSRF; webhooks authenticate by signature, not session.
 *
 * Three message types arrive (Twitch-Eventsub-Message-Type header):
 *   • webhook_callback_verification — Twitch's handshake; we MUST echo back `challenge` as text/plain
 *   • notification                  — an actual event (stream.online / stream.offline)
 *   • revocation                    — Twitch dropped our subscription (auth lost, user gone, etc.)
 *
 * We verify the signature on ALL of them, then ACK 2xx fast and process async — Twitch retries slow
 * or non-2xx deliveries and disables subscriptions that fail too often.
 */
import express from 'express';
import crypto from 'crypto';
import logger from '../../../utils/logger.js';
import { verifySignature, handleNotification, markStatus } from '../../../core/twitch-eventsub-manager.js';

const router = express.Router();

// Twitch retries a message id on delivery failure; skip ones we've already processed.
const seen = new Map(); // messageId -> timestamp(ms)
const DEDUP_TTL = 10 * 60 * 1000;
function alreadySeen(id) {
  const now = Date.now();
  for (const [k, t] of seen) { if (now - t > DEDUP_TTL) seen.delete(k); else break; }
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

router.post('/', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  try {
    const messageId = req.get('Twitch-Eventsub-Message-Id');
    const timestamp = req.get('Twitch-Eventsub-Message-Timestamp');
    const signature = req.get('Twitch-Eventsub-Message-Signature');
    const messageType = req.get('Twitch-Eventsub-Message-Type');
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8')
      : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

    if (!verifySignature({ messageId, timestamp, rawBody, signature })) {
      logger.warn('[TwitchEventSub] Rejected message with invalid signature', { messageType, messageId });
      return res.status(403).send('invalid signature');
    }

    // Reject replayed messages older than 10 minutes (Twitch's own recommendation against replay).
    if (timestamp && Date.now() - new Date(timestamp).getTime() > DEDUP_TTL) {
      return res.status(403).send('stale');
    }

    let payload;
    try { payload = JSON.parse(rawBody); } catch { return res.status(400).send('bad json'); }

    // 1. Handshake — echo the challenge as raw text so Twitch enables the subscription.
    if (messageType === 'webhook_callback_verification') {
      const subId = payload?.subscription?.id;
      if (subId) markStatus(subId, 'enabled').catch(() => {});
      logger.info('[TwitchEventSub] Verified callback challenge', { subId, type: payload?.subscription?.type });
      res.set('Content-Type', 'text/plain');
      return res.status(200).send(payload.challenge);
    }

    // 2. Revocation — Twitch dropped the sub; record it so reconcile() recreates it.
    if (messageType === 'revocation') {
      const subId = payload?.subscription?.id;
      logger.warn('[TwitchEventSub] Subscription revoked', { subId, status: payload?.subscription?.status, type: payload?.subscription?.type });
      if (subId) markStatus(subId, payload?.subscription?.status || 'revoked').catch(() => {});
      return res.status(204).end();
    }

    // 3. Notification — the actual live/offline event.
    if (messageType === 'notification') {
      // ACK immediately; the announcement work happens async.
      res.status(204).end();
      if (messageId && alreadySeen(messageId)) return;
      const subType = payload?.subscription?.type;
      const eventHash = crypto.createHash('sha1').update(`${subType}|${JSON.stringify(payload?.event || {})}`).digest('hex');
      if (alreadySeen(`event:${eventHash}`)) {
        // Same subscription id + message id again: Twitch redelivers when an acknowledgement is slow
        // (at-least-once delivery). Checked 2026-11-18: no duplicate subscriptions in the ledger.
        logger.info('[TwitchEventSub] Twitch redelivered an event already handled; dropped repeat', { subType, subId: payload?.subscription?.id });
        return;
      }
      handleNotification(subType, payload?.event || {}, payload?.subscription || null)
        .then(action => logger.info('[TwitchEventSub] Notification handled', { subType, action }))
        .catch(err => logger.error('[TwitchEventSub] Notification handler error', { subType, error: err.message }));
      return;
    }

    // Unknown type — ACK so Twitch doesn't retry forever.
    return res.status(204).end();
  } catch (error) {
    logger.error('[TwitchEventSub] Receive error', { error: error.message });
    if (!res.headersSent) res.status(500).send('internal');
  }
});

// Liveness probe (curl-verify the mount without a signed payload).
router.get('/health', (req, res) => res.json({ ok: true, endpoint: 'twitch-eventsub' }));

export default router;
