/**
 * Discord Linked Roles — Twitch-sourced connection metadata.
 *
 * Discord's native "Connections" surface lets server admins create roles with
 * requirements like "subscribed to this creator's Twitch" or "Twitch partner".
 * Our app has to:
 *   1. Register a METADATA SCHEMA (one time per app). Defines which fields we
 *      publish and their types.
 *   2. Have each user complete a Discord OAuth with the `role_connections.write`
 *      scope so they grant us permission to update THEIR metadata.
 *   3. PUSH per-user metadata values. Discord stores them and uses them to
 *      enforce role requirements.
 *
 * This module handles (1) and (3). Step (2) — the user-facing OAuth flow — lives
 * in dashboard/routes/auth-discord-linked-role.js (follow-up build).
 *
 * Values are derived from twitch_oauth_accounts + twitch_role_sync_members.
 * One linked user, one metadata record — not per-guild.
 */
import axios from 'axios';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

const LOG = '[LinkedRoles]';
const DISCORD_API = 'https://discord.com/api/v10';

// Discord caps at 5 metadata fields per application. Prioritised: subscriber + tier +
// partner + vip + mod. Dropped: is_affiliate (less useful than Partner for role gating).
const SCHEMA = [
    { key: 'is_subscriber', name: 'Twitch Subscriber',    description: 'Currently subscribed to a tracked creator',  type: 7 }, // 7 = BOOLEAN_EQUAL
    { key: 'follower_tier', name: 'Twitch Follower Tier', description: 'Highest sub tier (0=none, 1-3=Tier 1/2/3)',  type: 2 }, // 2 = INTEGER_GREATER_THAN_OR_EQUAL
    { key: 'is_partner',    name: 'Twitch Partner',       description: 'Twitch Partner',                               type: 7 },
    { key: 'is_vip',        name: 'Twitch VIP',           description: 'Has VIP status on a tracked creator channel', type: 7 },
    { key: 'is_mod',        name: 'Twitch Moderator',     description: 'Moderator on a tracked creator channel',      type: 7 },
];

function appId() { return process.env.DISCORD_CLIENT_ID || process.env.DISCORD_APPLICATION_ID; }
function botToken() { return process.env.DISCORD_TOKEN || process.env.BOT_TOKEN; }

/**
 * Register the metadata schema on our Discord application. Idempotent — PUT
 * replaces the whole schema, so re-running is safe. Call on boot.
 */
export async function registerSchema() {
    const id = appId();
    const token = botToken();
    if (!id || !token) { logger.warn(`${LOG} skip registerSchema: missing env`); return null; }
    try {
        const res = await axios.put(
            `${DISCORD_API}/applications/${id}/role-connections/metadata`,
            SCHEMA,
            { headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, timeout: 10000, validateStatus: () => true });
        if (res.status >= 300) {
            logger.warn(`${LOG} registerSchema status=${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
            return null;
        }
        logger.info(`${LOG} schema registered (${SCHEMA.length} fields)`);
        return res.data;
    } catch (err) {
        logger.warn(`${LOG} registerSchema failed: ${err.message}`);
        return null;
    }
}

/**
 * Push one user's metadata to Discord. Requires that user's OAuth access_token
 * carrying `role_connections.write` scope — collected via the Linked Role OAuth
 * flow (follow-up; stored in user_linked_role_tokens table).
 *
 * @param {string} userAccessToken - the user's Discord OAuth bearer token
 * @param {object} values - { is_subscriber, follower_tier, is_affiliate, ... }
 */
export async function pushMetadata(userAccessToken, values) {
    const id = appId();
    if (!id || !userAccessToken) return null;
    const platform_name = 'CertiFried Twitch';
    const platform_username = values?.platform_username || null;
    const metadata = {};
    for (const field of SCHEMA) {
        if (values[field.key] === undefined) continue;
        metadata[field.key] = typeof values[field.key] === 'boolean'
            ? (values[field.key] ? 1 : 0) : Number(values[field.key]);
    }
    try {
        const res = await axios.put(
            `${DISCORD_API}/users/@me/applications/${id}/role-connection`,
            { platform_name, platform_username, metadata },
            { headers: { Authorization: `Bearer ${userAccessToken}`, 'Content-Type': 'application/json' }, timeout: 10000, validateStatus: () => true });
        if (res.status >= 300) {
            logger.warn(`${LOG} pushMetadata status=${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
            return null;
        }
        return res.data;
    } catch (err) {
        logger.warn(`${LOG} pushMetadata failed: ${err.message}`);
        return null;
    }
}

/**
 * Derive metadata values for a Discord user from our Twitch data.
 * Returns null if the user hasn't verified a Twitch identity.
 */
export async function deriveMetadata(discordUserId) {
    const [[identity]] = await pool.execute(
        'SELECT twitch_user_id, twitch_username FROM twitch_oauth_accounts WHERE discord_user_id = ?',
        [String(discordUserId)]);
    if (!identity) return null;
    const twitchId = String(identity.twitch_user_id);

    // Partner/affiliate flags live on the Helix user — we may not have them cached locally.
    // Subscriber / VIP / mod status is readable from twitch_role_sync_members where it exists.
    // The table has is_sub / is_vip / is_mod and no tier column. The aliases avoid reserved words:
    // MOD is reserved in MariaDB, so `AS mod` was a syntax error that the old silent catch hid.
    const [[sub]]  = await pool.execute(
        `SELECT MAX(is_sub) AS sub_flag, MAX(is_vip) AS vip_flag, MAX(is_mod) AS mod_flag
           FROM twitch_role_sync_members WHERE twitch_user_id = ?`, [twitchId]).catch((err) => {
        logger.warn(`${LOG} role lookup failed: ${err.message}`);
        return [[{}]];
    });
    return {
        platform_username: identity.twitch_username,
        is_subscriber:  !!Number(sub?.sub_flag || 0),
        follower_tier:  0,      // no sub tier is stored locally (twitch_role_sync_members has no tier column)
        is_partner:     false,  // enrich via Helix GET /users 'broadcaster_type' when we add that call
        is_vip:         !!Number(sub?.vip_flag || 0),
        is_mod:         !!Number(sub?.mod_flag || 0),
    };
}

export const _schema = SCHEMA;
