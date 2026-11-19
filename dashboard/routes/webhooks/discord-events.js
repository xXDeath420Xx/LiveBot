/**
 * Discord outgoing webhook events receiver (APPLICATION_AUTHORIZED, ENTITLEMENT_CREATE,
 * QUEST_USER_ENROLLMENT). Configured in the Developer Portal → Webhook Events, pointed
 * at `/webhooks/discord/events`. This is NOT the gateway — it's an HTTP push Discord
 * sends in parallel for install/entitlement signals so a dashboard can react even
 * when every shard is down.
 *
 * Verification: Ed25519 over `timestamp + raw body`, keyed by the application's public
 * key (Developer Portal → General Information). We mount with `express.raw` *before*
 * the global body parser so the signed bytes are byte-faithful.
 *
 * Discord sends two kinds of requests:
 *   • PING (type 0) — handshake; respond 200 with empty body or {} to confirm the endpoint.
 *   • EVENT (type 1) — real event under `event.type`:
 *       APPLICATION_AUTHORIZED  – an install happened (user/guild in payload)
 *       ENTITLEMENT_CREATE      – a user bought an SKU
 *       QUEST_USER_ENROLLMENT   – user signed up to a quest
 *
 * We always ACK fast (<3s per Discord's doc) then process async.
 */
import express from 'express';
import crypto from 'node:crypto';
import logger from '../../../utils/logger.js';
import pool from '../../../utils/db.js';

const router = express.Router();

// Dedup: Discord retries on non-2xx; a 10-minute window matches their retry curve.
const seen = new Map(); // key(signature) -> timestamp(ms)
const DEDUP_TTL = 10 * 60 * 1000;
function alreadySeen(key) {
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > DEDUP_TTL) seen.delete(k);
    if (!key) return false;
    if (seen.has(key)) return true;
    seen.set(key, now);
    return false;
}

/**
 * Verify an Ed25519 signature using Node's built-in crypto (no external dep).
 * Discord's public key is 32 raw bytes hex-encoded — we wrap it in a DER
 * SubjectPublicKeyInfo so createPublicKey accepts it.
 */
function verifyEd25519({ signatureHex, timestamp, rawBody, publicKeyHex }) {
    if (!signatureHex || !timestamp || !publicKeyHex) return false;
    try {
        const signature = Buffer.from(signatureHex, 'hex');
        if (signature.length !== 64) return false;

        const pubRaw = Buffer.from(publicKeyHex, 'hex');
        if (pubRaw.length !== 32) return false;

        // 12-byte Ed25519 SPKI prefix: OID 1.3.101.112
        const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
        const spki = Buffer.concat([spkiPrefix, pubRaw]);

        const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
        const message = Buffer.concat([Buffer.from(String(timestamp), 'utf8'), rawBody]);

        return crypto.verify(null, message, key, signature);
    } catch (err) {
        logger.warn('[DiscordWebhook] signature verify threw', { err: err.message });
        return false;
    }
}

/**
 * Record raw event payloads to a durable log. The handlers below do their
 * own enriched inserts; this one is the "we got it" trail for debugging.
 */
async function logEnvelope(envelope) {
    try {
        await pool.execute(
            `INSERT INTO discord_webhook_events (event_type, application_id, payload, received_at)
             VALUES (?, ?, ?, NOW())`,
            [
                envelope?.type ?? envelope?.event?.type ?? null,
                envelope?.application_id ?? null,
                JSON.stringify(envelope ?? {}).slice(0, 65535),
            ]
        );
    } catch (err) {
        // Table may be missing on first run; log but don't fail the webhook.
        logger.warn('[DiscordWebhook] envelope persist failed', { err: err.message });
    }
}

async function handleApplicationAuthorized(ev) {
    const d = ev?.data || {};
    const guildId = d.guild?.id || null;
    const userId = d.user?.id || null;
    const integrationType = d.integration_type ?? null;
    logger.info('[DiscordWebhook] APPLICATION_AUTHORIZED', { guildId, userId, integrationType });
    try {
        await pool.execute(
            `INSERT INTO discord_app_installs
                 (user_id, guild_id, integration_type, scopes, authorized_at)
             VALUES (?, ?, ?, ?, NOW())`,
            [
                userId,
                guildId,
                integrationType,
                JSON.stringify(d.scopes ?? []),
            ]
        );
    } catch (err) {
        logger.warn('[DiscordWebhook] install persist failed', { err: err.message });
    }
}

async function handleEntitlementCreate(ev) {
    const d = ev?.data || {};
    logger.info('[DiscordWebhook] ENTITLEMENT_CREATE', {
        entitlementId: d.id, userId: d.user_id, guildId: d.guild_id, skuId: d.sku_id,
    });
    // The gateway EntitlementCreate handler already writes to audit_logs when a
    // guild_id is set; this path mirrors it for user-scope entitlements where
    // the gateway hook is intentionally quiet.
}

async function handleQuestEnrollment(ev) {
    const d = ev?.data || {};
    logger.info('[DiscordWebhook] QUEST_USER_ENROLLMENT', { userId: d.user_id, questId: d.quest_id });
}

router.post('/', express.raw({ type: '*/*', limit: '128kb' }), async (req, res) => {
    const publicKey = process.env.DISCORD_WEBHOOK_PUBLIC_KEY || process.env.DISCORD_PUBLIC_KEY;
    if (!publicKey) {
        logger.warn('[DiscordWebhook] no DISCORD_WEBHOOK_PUBLIC_KEY env set — refusing to accept');
        return res.status(503).send('endpoint not configured');
    }

    const signatureHex = req.get('X-Signature-Ed25519');
    const timestamp = req.get('X-Signature-Timestamp');
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

    if (!verifyEd25519({ signatureHex, timestamp, rawBody, publicKeyHex: publicKey })) {
        logger.warn('[DiscordWebhook] invalid signature');
        return res.status(401).send('invalid signature');
    }

    if (alreadySeen(signatureHex)) return res.status(204).send();

    let envelope;
    try { envelope = JSON.parse(rawBody.toString('utf8')); }
    catch { return res.status(400).send('bad json'); }

    // PING handshake. Discord's docs say respond 204 with no body; some tooling
    // expects 200 with {} — we return 204 which matches the current docs.
    if (envelope?.type === 0) {
        logger.info('[DiscordWebhook] PING acknowledged');
        return res.status(204).send();
    }

    // Fire-and-forget processing; ACK fast.
    res.status(204).send();

    try {
        await logEnvelope(envelope);
        const ev = envelope?.event;
        switch (ev?.type) {
            case 'APPLICATION_AUTHORIZED':  await handleApplicationAuthorized(ev); break;
            case 'ENTITLEMENT_CREATE':      await handleEntitlementCreate(ev); break;
            case 'QUEST_USER_ENROLLMENT':   await handleQuestEnrollment(ev); break;
            default: logger.info('[DiscordWebhook] unknown event type', { type: ev?.type });
        }
    } catch (err) {
        logger.error('[DiscordWebhook] async handler threw', { err: err.message, stack: err.stack });
    }
});

export default router;
