/*
 * Registry of webhooks this bot creates.
 *
 * `webhook_config` shipped with no reader or writer, so the dashboard's webhook list was always
 * empty and the "allow the bot to create webhooks" toggle did nothing. Two jobs here:
 *
 *   register()   — record a webhook the bot just created, so the page lists something real
 *   mayCreate()  — honour the per-guild toggle before a webhook is created
 *
 * Why a server would turn creation off: the bot posts stream announcements through a webhook so
 * they carry the streamer's name and avatar. A server that would rather every message come from
 * the bot's own identity — or that is at Discord's 15-webhooks-per-channel ceiling — needs a way
 * to say no. Previously there was none.
 *
 * Both calls fail open. A registry write failing must never stop an announcement going out.
 */

import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const CACHE_TTL_MS = 60_000;
const allowCache = new Map(); // guildId -> { value, expires }

export function invalidate(guildId) {
    if (guildId) allowCache.delete(guildId);
    else allowCache.clear();
}

/**
 * May the bot create a webhook in this guild?
 * Defaults to true — creation has always been allowed, and a guild that never touched the
 * setting must keep working exactly as before.
 */
export async function mayCreate(guildId) {
    if (!guildId) return true;

    const hit = allowCache.get(guildId);
    if (hit && hit.expires > Date.now()) return hit.value;

    let value = true;
    try {
        const { getConfig } = await import('./feature-config.js');
        const cfg = await getConfig('webhooks', guildId);
        if ('allow_creation' in cfg) {
            value = cfg.allow_creation === true || cfg.allow_creation === 1 || cfg.allow_creation === '1';
        }
    } catch (err) {
        logger.warn(`[WebhookRegistry] Could not read creation policy for ${guildId}: ${err.message}`);
    }

    allowCache.set(guildId, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
}

/**
 * Record a webhook the bot created or adopted.
 *
 * The URL contains the token, which is a credential — anyone holding it can post as that
 * webhook. It is stored because Discord will not hand it back later and reconstructing it is
 * impossible, but it is never sent to the dashboard: the API's column list for this table
 * deliberately excludes `webhook_url`.
 */
export async function register({ guildId, channelId, webhook, name, type = 'incoming', createdBy = null }) {
    if (!guildId || !webhook?.id) return;
    try {
        await pool.execute(
            `INSERT INTO webhook_config
                (guild_id, webhook_id, webhook_name, channel_id, webhook_url, webhook_type, created_by, active, last_used)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())
             ON DUPLICATE KEY UPDATE
                webhook_name = VALUES(webhook_name),
                channel_id   = VALUES(channel_id),
                webhook_url  = VALUES(webhook_url),
                active       = 1,
                last_used    = NOW()`,
            [
                guildId,
                webhook.id,
                name || webhook.name || 'webhook',
                channelId || webhook.channelId || null,
                webhook.url || null,
                type,
                createdBy,
            ]
        );
    } catch (err) {
        logger.warn(`[WebhookRegistry] Could not record webhook ${webhook.id}: ${err.message}`);
    }
}

/** Bump last_used so the dashboard can show which webhooks are actually in service. */
export async function touch(webhookId) {
    if (!webhookId) return;
    try {
        await pool.execute(
            'UPDATE webhook_config SET last_used = NOW(), active = 1 WHERE webhook_id = ?',
            [webhookId]
        );
    } catch { /* purely informational — never worth failing a send over */ }
}

/** Mark a webhook gone, so the list does not show deleted webhooks as live. */
export async function deactivate(webhookId) {
    if (!webhookId) return;
    try {
        await pool.execute('UPDATE webhook_config SET active = 0 WHERE webhook_id = ?', [webhookId]);
    } catch { /* best effort */ }
}

export default { mayCreate, register, touch, deactivate, invalidate };
