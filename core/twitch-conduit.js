/**
 * Twitch EventSub Conduits — the scalable transport layer that replaces direct
 * webhook subscriptions once the per-app subscription count gets near the ~10K
 * ceiling. We create one conduit, register one shard with our existing
 * /webhooks/twitch/eventsub endpoint + secret, and have every subscription
 * point at the conduit. One conduit holds up to 20K subs.
 *
 * Public API:
 *   ensureConduit()           : find-or-create our conduit + register shard 0,
 *                               cache the id. Idempotent. Call on boot.
 *   getCachedConduitId()      : null until ensureConduit has succeeded once.
 *                               Reads from an in-memory cache populated at boot.
 *   migrateExistingWebhookSubs(): one-shot — converts every existing webhook
 *                               sub to a conduit twin (create-then-delete per
 *                               sub, rate-limited to avoid 429s).
 *
 * This module imports from twitch-eventsub-manager.js carefully: no circular
 * dependencies — we only call helpers that don't call back into us.
 */
import axios from 'axios';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getAccessToken } from '../utils/platforms/twitch-api.js';

const LOG = '[TwitchConduit]';
const HELIX_CONDUITS        = 'https://api.twitch.tv/helix/eventsub/conduits';
const HELIX_CONDUIT_SHARDS  = 'https://api.twitch.tv/helix/eventsub/conduits/shards';
const HELIX_EVENTSUB        = 'https://api.twitch.tv/helix/eventsub/subscriptions';

// In-memory cache — the DB is the source of truth, this is just to avoid a
// per-create DB round-trip. Nulled when ensureConduit is called with force=true.
let cachedConduitId = null;

export function getCachedConduitId() { return cachedConduitId; }

async function appHeaders() {
    const token = await getAccessToken();
    return { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function getCallbackUrl() {
    if (process.env.TWITCH_EVENTSUB_CALLBACK_URL) return process.env.TWITCH_EVENTSUB_CALLBACK_URL;
    const base = String(process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
    return base ? `${base}/webhooks/twitch/eventsub` : '';
}
function getSecret() { return process.env.TWITCH_EVENTSUB_SECRET || ''; }

/**
 * Idempotent — find or create our single conduit, register shard 0 with our
 * webhook endpoint, cache the id. Safe to call on every boot.
 */
export async function ensureConduit() {
    // Fast path: DB already has a row.
    const [rows] = await pool.execute('SELECT conduit_id, shard_count FROM twitch_eventsub_conduit WHERE id = 1');
    let conduitId = rows[0]?.conduit_id || null;
    const shardCount = rows[0]?.shard_count || 1;

    const headers = await appHeaders();

    if (conduitId) {
        // Verify Twitch still has it — if it got deleted externally we'll make a new one.
        const vr = await axios.get(HELIX_CONDUITS, { headers, validateStatus: () => true, timeout: 15000 });
        const exists = Array.isArray(vr.data?.data) && vr.data.data.some(c => c.id === conduitId);
        if (!exists) {
            logger.warn(`${LOG} stored conduit ${conduitId} is gone upstream — recreating`);
            conduitId = null;
        }
    }

    if (!conduitId) {
        const res = await axios.post(HELIX_CONDUITS, { shard_count: shardCount }, { headers, validateStatus: () => true, timeout: 15000 });
        if (res.status >= 300) {
            logger.error(`${LOG} create conduit failed: ${res.status} ${JSON.stringify(res.data).slice(0, 300)}`);
            throw new Error(`conduit create failed: ${res.status}`);
        }
        conduitId = res.data?.data?.[0]?.id;
        if (!conduitId) throw new Error('conduit create returned no id');
        await pool.execute(
            `INSERT INTO twitch_eventsub_conduit (id, conduit_id, shard_count) VALUES (1, ?, ?)
             ON DUPLICATE KEY UPDATE conduit_id = VALUES(conduit_id), shard_count = VALUES(shard_count)`,
            [conduitId, shardCount]);
        logger.info(`${LOG} created conduit ${conduitId} with ${shardCount} shard(s)`);
    }

    // Ensure shard 0 points at our webhook endpoint. Twitch marks shards whose
    // transport fails verification as `webhook_callback_verification_failed`;
    // this PATCH triggers a fresh verification challenge.
    const callback = getCallbackUrl();
    const secret = getSecret();
    if (!callback || !/^https:\/\//i.test(callback)) throw new Error(`conduit: invalid callback url "${callback}"`);
    if (!secret) throw new Error('conduit: TWITCH_EVENTSUB_SECRET not set');

    const sr = await axios.get(`${HELIX_CONDUIT_SHARDS}?conduit_id=${encodeURIComponent(conduitId)}`,
        { headers, validateStatus: () => true, timeout: 15000 });
    const shards = sr.data?.data || [];
    const shard0 = shards.find(s => String(s.id) === '0');

    const needsPatch = !shard0
        || shard0.transport?.method !== 'webhook'
        || shard0.transport?.callback !== callback
        || !['enabled', 'webhook_callback_verification_pending'].includes(shard0.status);

    if (needsPatch) {
        const pr = await axios.patch(HELIX_CONDUIT_SHARDS, {
            conduit_id: conduitId,
            shards: [{ id: '0', transport: { method: 'webhook', callback, secret } }],
        }, { headers, validateStatus: () => true, timeout: 15000 });
        if (pr.status >= 300) {
            logger.error(`${LOG} patch shard 0 failed: ${pr.status} ${JSON.stringify(pr.data).slice(0, 300)}`);
            throw new Error(`shard patch failed: ${pr.status}`);
        }
        logger.info(`${LOG} shard 0 registered -> ${callback}`);
    } else {
        logger.info(`${LOG} shard 0 already registered correctly (status: ${shard0.status})`);
    }

    cachedConduitId = conduitId;
    return conduitId;
}

/**
 * Convert every existing webhook-transport subscription to a conduit-transport
 * twin. Create-then-delete per sub. Rate-limited: 300ms between creates to stay
 * well under Twitch's 800/min app-token ceiling.
 *
 * Returns { converted, skipped, failed, totalBefore }.
 */
export async function migrateExistingWebhookSubs() {
    const conduitId = cachedConduitId || await ensureConduit();
    const headers = await appHeaders();

    // Enumerate every subscription we currently have, with pagination.
    const all = [];
    let cursor = null;
    do {
        const url = cursor ? `${HELIX_EVENTSUB}?after=${encodeURIComponent(cursor)}` : HELIX_EVENTSUB;
        const res = await axios.get(url, { headers, validateStatus: () => true, timeout: 15000 });
        if (res.status >= 300) throw new Error(`list subs failed: ${res.status}`);
        all.push(...(res.data?.data || []));
        cursor = res.data?.pagination?.cursor || null;
    } while (cursor);

    const webhookSubs = all.filter(s => s.transport?.method === 'webhook');
    const conduitSubs = all.filter(s => s.transport?.method === 'conduit');

    // Build a set of (broadcaster, type) tuples the conduit already covers so
    // we don't create duplicates when the migration is re-run.
    const conduitCovers = new Set(conduitSubs.map(s => {
        const bid = s.condition?.broadcaster_user_id
                 || s.condition?.to_broadcaster_user_id
                 || s.condition?.moderator_user_id || '';
        return `${bid}:${s.type}`;
    }));

    logger.info(`${LOG} migration: ${webhookSubs.length} webhook subs -> conduit (${conduitSubs.length} already conduit)`);

    let converted = 0, skipped = 0, failed = 0;
    for (const old of webhookSubs) {
        const bid = old.condition?.broadcaster_user_id
                 || old.condition?.to_broadcaster_user_id
                 || old.condition?.moderator_user_id || '';
        const key = `${bid}:${old.type}`;
        if (conduitCovers.has(key)) {
            // Twin already exists — just delete the webhook sub.
            try {
                await axios.delete(`${HELIX_EVENTSUB}?id=${encodeURIComponent(old.id)}`,
                    { headers, validateStatus: () => true, timeout: 15000 });
                skipped++;
            } catch { failed++; }
            await sleep(300);
            continue;
        }
        try {
            const createRes = await axios.post(HELIX_EVENTSUB, {
                type: old.type,
                version: old.version,
                condition: old.condition,
                transport: { method: 'conduit', conduit_id: conduitId },
            }, { headers, validateStatus: () => true, timeout: 15000 });
            if (createRes.status >= 300) {
                // 409 conflict means Twitch already has this conduit sub — safe to delete the webhook.
                if (createRes.status !== 409) {
                    logger.warn(`${LOG} create conduit twin for ${old.type} / ${bid} failed: ${createRes.status} ${JSON.stringify(createRes.data).slice(0, 200)}`);
                    failed++;
                    await sleep(300);
                    continue;
                }
            }
            await axios.delete(`${HELIX_EVENTSUB}?id=${encodeURIComponent(old.id)}`,
                { headers, validateStatus: () => true, timeout: 15000 });
            converted++;
        } catch (e) {
            logger.warn(`${LOG} migrate ${old.type} / ${bid}: ${e.message}`);
            failed++;
        }
        await sleep(300);
    }

    logger.info(`${LOG} migration done: converted ${converted}, skipped ${skipped}, failed ${failed}, totalBefore ${webhookSubs.length}`);
    return { converted, skipped, failed, totalBefore: webhookSubs.length };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
