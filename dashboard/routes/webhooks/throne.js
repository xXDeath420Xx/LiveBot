/**
 * Throne webhook receiver — Phase 2 production.
 *
 * Per the Throne help-centre contract (see memory [[reference-throne-webhook-contract]]):
 *   headers      X-Signature-Ed25519 (hex, 128 chars = 64 bytes) + X-Signature-Timestamp (Unix s)
 *   signed msg   M = `${timestamp}.${rawBody}` (literal period, NOT a byte concat)
 *   algorithm    pure Ed25519, verified with crypto.verify(null, M, pubkey, sig)
 *   SLA          respond 2xx within 10 s
 *   event types  gift_purchased, contribution_purchased, gift_crowdfunded
 *
 * Mounted BEFORE the global body parser (same pattern as Fourthwall / Kick / Twitch EventSub)
 * because the signature covers the raw request bytes — re-serialised JSON is not
 * byte-faithful. express.raw with wildcard content-type preserves them.
 *
 * Subscriptions with purpose='probe' bypass signature verification and only capture the raw
 * delivery into throne_webhook_events — used for format discovery before cutting over. Promoting
 * a subscription to purpose='production' turns on verification + dispatch.
 */
import express from 'express';
import crypto from 'node:crypto';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import botManager from '../../../core/bot-manager.js';
import {
    fetchThroneProfile,
    formatPrice,
    centsToDollars,
} from '../../../utils/scrapers/throne-scraper.js';
import { cacheProfileAndWishlist } from '../../../core/throne-manager.js';

const router = express.Router();
const LOG = '[ThroneWebhook]';

// System-wide static Ed25519 public key, from https://help.throne.com/ (webhook integration
// article, 2026-07-27). Env override exists for key rotation without a code deploy.
const THRONE_PUBKEY_PEM = process.env.THRONE_WEBHOOK_PUBLIC_KEY_PEM || `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAPXbUfxh7XL4SYUVcfhmYMIbxvtR9E9LDd8gPJ1PwSD8=
-----END PUBLIC KEY-----`;
const THRONE_PUBKEY = (() => { try { return crypto.createPublicKey(THRONE_PUBKEY_PEM); } catch (e) { logger.error(`${LOG} failed to parse THRONE_PUBKEY_PEM`, { err: e.message }); return null; } })();

// Replay guard — Throne clocks are generally close to real time; 5 min allows normal network
// delay without accepting day-old intercepted deliveries.
const MAX_TIMESTAMP_DRIFT_SEC = 300;

// Signature + timestamp header names (confirmed from first-fire 2026-10-13).
const SIG_HEADER = 'x-signature-ed25519';
const TS_HEADER = 'x-signature-timestamp';

// ─── helpers ────────────────────────────────────────────────────

function headersAsPlainObject(req) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) {
        h[String(k).toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
    }
    return h;
}

/** Verify Throne's Ed25519 signature over `${timestamp}.${rawBody}`. */
function verifyThroneSignature(rawBody, timestamp, sigHex) {
    if (!THRONE_PUBKEY) return false;
    if (!Buffer.isBuffer(rawBody)) return false;
    if (!sigHex || typeof sigHex !== 'string' || sigHex.length !== 128) return false;
    let sig;
    try { sig = Buffer.from(sigHex, 'hex'); } catch { return false; }
    if (sig.length !== 64) return false;
    const message = Buffer.concat([Buffer.from(String(timestamp), 'utf8'), Buffer.from('.', 'utf8'), rawBody]);
    try { return crypto.verify(null, message, THRONE_PUBKEY, sig); } catch { return false; }
}

/** Convert a Throne webhook `gift_purchased` payload into the gift shape existing
 *  core/throne-manager.js `postGiftNotifications` already consumes. Field names mirror the
 *  REST-sourced shape in utils/scrapers/throne-scraper.js (fetchThroneGiftHistory) so the two
 *  paths share the same embed builder.
 */
function adaptGiftPurchased(d, eventId) {
    const amountCents = Number(d.price) || null;
    const currency = d.currency || 'USD';
    const anon = !d.gifter_username || /^anonymous$/i.test(String(d.gifter_username).trim());
    return {
        id: `wh:${eventId}`,
        name: d.item_name || 'Unknown item',
        purchasedAt: new Date(),
        status: 'Purchased',
        isComplete: null,
        isDigital: null,
        isCrowdfunded: false,
        imageUrl: d.item_thumbnail_url || null,
        link: null,
        totalFormatted: amountCents != null ? formatPrice(amountCents, currency) : null,
        currency,
        totalCents: amountCents,
        gifters: [{
            username: anon ? 'Anonymous' : d.gifter_username,
            imageUrl: null,
            message: d.message || null,
            amountCents,
            amountFormatted: amountCents != null ? formatPrice(amountCents, currency) : null,
        }],
        contributorCount: 1,
    };
}

/** `gift_crowdfunded` → same embed path as gift_purchased, but the payload omits
 *  gifter_username / message by design (anonymous crowdfund aggregate). */
function adaptGiftCrowdfunded(d, eventId) {
    const amountCents = Number(d.price) || null;
    const currency = d.currency || 'USD';
    return {
        id: `wh:${eventId}`,
        name: d.item_name || 'Unknown item',
        purchasedAt: new Date(),
        status: 'Crowdfunded',
        isComplete: null,
        isDigital: null,
        isCrowdfunded: true,
        imageUrl: d.item_thumbnail_url || null,
        link: null,
        totalFormatted: amountCents != null ? formatPrice(amountCents, currency) : null,
        currency,
        totalCents: amountCents,
        gifters: [],
        contributorCount: 0,
    };
}

/** `contribution_purchased` → the shape `postContributionNotifications` consumes. */
function adaptContribution(d, eventId) {
    const amountCents = Number(d.amount) || null;
    const currency = d.currency || 'USD';
    const anon = !d.gifter_username || /^anonymous$/i.test(String(d.gifter_username).trim());
    return {
        id: `wh:${eventId}`,
        name: d.item_name || 'Unknown item',
        previousContributorCount: 0,       // webhook payload does not include running count — manager tolerates 0
        contributorCount: 1,
        totalFormatted: amountCents != null ? formatPrice(amountCents, currency) : null,
        status: 'Crowdfunded',
        imageUrl: d.item_thumbnail_url || null,
        gifters: [{
            username: anon ? 'Anonymous' : d.gifter_username,
            imageUrl: null,
            message: d.message || null,
            amountCents,
            amountFormatted: amountCents != null ? formatPrice(amountCents, currency) : null,
        }],
    };
}

/** Visibility gate — never post data the creator has chosen to hide on Throne itself. */
async function creatorVisibilityAllowsGiftPost(username) {
    try {
        const [rows] = await pool.execute(
            'SELECT show_previous_gifts FROM throne_cached_profiles WHERE throne_username = ?',
            [username]);
        return rows[0]?.show_previous_gifts !== 0;   // 1 or null = visible; 0 = hidden
    } catch { return true; /* best effort — do not fail-close on a DB blip */ }
}

/** Pre-populate throne_seen_gifts so the next 2-min REST cycle does not emit a duplicate
 *  notification for the same gift. The REST path keys dedup on gift_id. */
async function markGiftSeen(username, giftId, giftName, status, isCrowdfunded, contributorCount) {
    try {
        await pool.execute(
            `INSERT INTO throne_seen_gifts (throne_username, gift_id, gift_name, status, is_crowdfunded, contributor_count)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE status = VALUES(status), contributor_count = VALUES(contributor_count)`,
            [username, String(giftId), giftName ? String(giftName).slice(0, 255) : null,
             status || null, isCrowdfunded ? 1 : 0, Number(contributorCount) || 0],
        );
    } catch (err) {
        logger.warn(`${LOG} markGiftSeen failed`, { username, giftId, err: err.message });
    }
}

/** Dispatch a verified webhook event to the right notification path. */
async function dispatchEvent(sub, event, eventId) {
    const d = event?.data || {};
    const username = d.creator_username;
    if (!username) {
        logger.warn(`${LOG} event missing creator_username`, { eventId, type: event.event_type });
        return { posted: false, reason: 'no_creator_username' };
    }

    const allowed = await creatorVisibilityAllowsGiftPost(username);
    if (!allowed) {
        logger.info(`${LOG} ${username} hides previous gifts on Throne — skipping webhook post`, { eventId });
        return { posted: false, reason: 'creator_hides_previous_gifts' };
    }

    const channel = await findChannelForSub(sub);
    if (!channel) {
        logger.warn(`${LOG} channel not reachable`, { subId: sub.id, guildId: sub.guild_id, channelId: sub.channel_id });
        return { posted: false, reason: 'channel_unreachable' };
    }

    // Lazy-load the manager posters so we don't pull the whole import graph on module init.
    const mgr = await import('../../../core/throne-manager.js');

    switch (event.event_type) {
        case 'gift_purchased': {
            const gift = adaptGiftPurchased(d, eventId);
            await mgr.postGiftNotifications(channel, username, [gift]);
            await markGiftSeen(username, gift.id, gift.name, gift.status, gift.isCrowdfunded, gift.contributorCount);
            scheduleRestResync(username);
            return { posted: true, reason: 'gift_purchased' };
        }
        case 'gift_crowdfunded': {
            const gift = adaptGiftCrowdfunded(d, eventId);
            await mgr.postGiftNotifications(channel, username, [gift]);
            await markGiftSeen(username, gift.id, gift.name, gift.status, gift.isCrowdfunded, gift.contributorCount);
            scheduleRestResync(username);
            return { posted: true, reason: 'gift_crowdfunded' };
        }
        case 'contribution_purchased': {
            const upd = adaptContribution(d, eventId);
            await mgr.postContributionNotifications(channel, username, [upd]);
            scheduleRestResync(username);
            return { posted: true, reason: 'contribution_purchased' };
        }
        default:
            logger.warn(`${LOG} unknown event_type — captured but not dispatched`, { eventId, type: event.event_type });
            return { posted: false, reason: 'unknown_event_type' };
    }
}

async function findChannelForSub(sub) {
    try {
        const client = botManager.getClientForGuild(sub.guild_id);
        if (!client) return null;
        return await client.channels.fetch(sub.channel_id).catch(() => null);
    } catch { return null; }
}

/** Fire-and-forget: refresh the creator's cached wishlist + profile so the 2-min REST cycle
 *  sees the state the webhook event implies (new purchase → item possibly out of stock,
 *  contribution → funding % moved). The REST manager handles its own locks + rate limiting.
 */
function scheduleRestResync(username) {
    setImmediate(() => {
        cacheProfileAndWishlist(username, { force: true })
            .catch(err => logger.warn(`${LOG} resync failed for ${username}`, { err: err.message }));
    });
}

// ─── routes ─────────────────────────────────────────────────────

router.post(
    '/:token',
    express.raw({ type: '*/*', limit: '2mb' }),
    async (req, res) => {
        const { token } = req.params;
        const headersObj = headersAsPlainObject(req);
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
        const bodyText = rawBody.toString('utf8');
        const rawSha256 = crypto.createHash('sha256').update(rawBody).digest('hex');
        const sigHex = headersObj[SIG_HEADER];
        const timestamp = headersObj[TS_HEADER];

        // 1. Subscription lookup
        let sub;
        try {
            const [rows] = await pool.execute(
                `SELECT id, guild_id, channel_id, throne_username, secret, enabled, purpose
                   FROM throne_webhook_subscriptions WHERE token = ?`,
                [token]);
            sub = rows[0];
        } catch (err) {
            logger.error(`${LOG} subscription lookup failed`, { err: err.message });
            return res.status(500).end();
        }
        if (!sub || !sub.enabled) return res.status(404).end();

        // 2. Production-mode verification. Probe mode logs + stores but does not verify.
        let verified = false;
        let rejectedReason = null;
        if (sub.purpose === 'production') {
            if (!sigHex) rejectedReason = 'missing_signature_header';
            else if (!timestamp || !/^\d+$/.test(String(timestamp))) rejectedReason = 'missing_or_invalid_timestamp';
            else {
                const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
                if (skew > MAX_TIMESTAMP_DRIFT_SEC) rejectedReason = `timestamp_skew_${Math.round(skew)}s`;
                else verified = verifyThroneSignature(rawBody, timestamp, sigHex);
                if (!verified && !rejectedReason) rejectedReason = 'signature_mismatch';
            }
            if (!verified) {
                logger.warn(`${LOG} production delivery rejected`, {
                    subId: sub.id, reason: rejectedReason, sigPrefix: sigHex ? sigHex.slice(0, 16) : null,
                });
                return res.status(401).end();
            }
        }

        // 3. Parse JSON (best effort). Probe mode still stores the raw body for later inspection
        // when the body is malformed.
        let event = null;
        let jsonErr = null;
        try { event = JSON.parse(bodyText); } catch (e) { jsonErr = e.message; }
        const eventType = event?.event_type || null;
        const eventId = event?.event_id || null;

        // 4. Idempotent store. The UNIQUE(subscription_id, raw_sha256) collides on retries; the
        // insertId on first write lets the Discord forward reference the stored row.
        let eventRowId = null;
        try {
            const [ins] = await pool.execute(
                `INSERT INTO throne_webhook_events
                 (subscription_id, event_type, event_id, signature_header, signature_value,
                  headers, body, raw_sha256)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
                [
                    sub.id,
                    eventType ? String(eventType).slice(0, 100) : null,
                    eventId ? String(eventId).slice(0, 100) : null,
                    sigHex ? SIG_HEADER : null,
                    sigHex ? String(sigHex).slice(0, 32) : null,          // never log full sig per Throne's security guidance
                    JSON.stringify(headersObj),
                    bodyText.slice(0, 1024 * 1024),
                    rawSha256,
                ],
            );
            eventRowId = ins.insertId || null;
        } catch (err) {
            logger.error(`${LOG} event insert failed`, { err: err.message, subId: sub.id });
            // Still ACK so Throne doesn't retry.
        }

        // 5. Touch subscription counters
        pool.execute(
            `UPDATE throne_webhook_subscriptions SET last_event_at = CURRENT_TIMESTAMP,
             event_count = event_count + 1 WHERE id = ?`,
            [sub.id]).catch(() => {});

        // 6. ACK fast (10 s SLA from Throne)
        res.status(200).json({ ok: true, received: true, eventId });

        // 7. Process async — dispatch (production) or probe-forward to Discord
        setImmediate(async () => {
            if (sub.purpose === 'production' && event && eventType) {
                // Stream bot tip events (core/stream-bot), keyed by the creator's Throne username.
                import('../../../core/stream-bot/index.js')
                    .then(({ onTip }) => onTip('throne', event, String(event?.data?.creator_username || '').toLowerCase()))
                    .catch(() => {});
                try {
                    const result = await dispatchEvent(sub, event, eventId);
                    await pool.execute(
                        `UPDATE throne_webhook_events SET posted_discord = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [result.posted ? 1 : 0, eventRowId]).catch(() => {});
                } catch (err) {
                    logger.error(`${LOG} dispatch failed`, { err: err.message, stack: err.stack, eventId, type: eventType });
                    if (eventRowId) {
                        pool.execute(`UPDATE throne_webhook_events SET error = ? WHERE id = ?`,
                            [String(err.message).slice(0, 500), eventRowId]).catch(() => {});
                    }
                }
            } else {
                // Probe mode (or unverified / unparsed in production, though we already 401'd those).
                try {
                    const channel = await findChannelForSub(sub);
                    if (!channel) return;
                    const bodyPreview = bodyText.length > 1000 ? bodyText.slice(0, 1000) + '\n…(truncated)' : bodyText;
                    const embed = {
                        title: `Throne webhook (${sub.purpose})${eventType ? ` · ${eventType}` : ''}`,
                        description: event
                            ? `**Event id:** \`${eventId || 'n/a'}\`\n**Signature header:** \`${sigHex ? SIG_HEADER : 'none'}\`\n**SHA-256:** \`${rawSha256}\``
                            : `JSON parse error: \`${jsonErr}\`\n**Signature header:** \`${sigHex ? SIG_HEADER : 'none'}\``,
                        color: event ? 0x4caf50 : 0xff9800,
                        fields: [
                            { name: 'Headers', value: '```json\n' + JSON.stringify(headersObj, null, 2).slice(0, 1000) + '\n```' },
                            { name: 'Body',    value: '```json\n' + bodyPreview + '\n```' },
                        ],
                        footer: { text: `probe · subscription #${sub.id} · event row #${eventRowId || '?'} · ${sub.purpose}` },
                        timestamp: new Date().toISOString(),
                    };
                    await channel.send({ embeds: [embed] });
                    pool.execute(`UPDATE throne_webhook_events SET posted_discord = 1, processed_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [eventRowId]).catch(() => {});
                } catch (err) {
                    logger.error(`${LOG} probe forward failed`, { err: err.message, subId: sub.id, eventRowId });
                }
            }
        });
    },
);

// Ping endpoint for subscription health checks (no event fire).
router.get('/:token/ping', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, guild_id, channel_id, purpose, enabled, event_count, last_event_at
               FROM throne_webhook_subscriptions WHERE token = ?`,
            [req.params.token]);
        const sub = rows[0];
        if (!sub) return res.status(404).json({ error: 'unknown token' });
        res.json({
            ok: true, subscriptionId: sub.id,
            guildId: sub.guild_id, channelId: sub.channel_id,
            purpose: sub.purpose, enabled: !!sub.enabled,
            eventCount: sub.event_count, lastEventAt: sub.last_event_at,
            pubkeyLoaded: !!THRONE_PUBKEY,
        });
    } catch (err) {
        logger.error(`${LOG} ping failed`, { err: err.message });
        res.status(500).end();
    }
});

export default router;
