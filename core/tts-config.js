/*
 * Per-guild gating for /tools tts.
 *
 * `tts_config` existed in the schema with no reader at all: a server could not restrict who
 * used TTS, where, how long the text could be, or how often. Every column below is now honoured.
 *
 * Everything is fail-open. TTS is a convenience feature, and a config read failing should not
 * take a working command down with it — a server that never configured TTS keeps the previous
 * unrestricted behaviour.
 */

import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map();          // guildId -> { value, expires }
const lastUsed = new Map();       // `${guildId}:${userId}` -> timestamp

const DEFAULTS = {
    enabled: 1,
    default_voice: null,
    max_length: 0,          // 0 = no limit
    cooldown_seconds: 0,
    allowed_channels: null,
    blocked_channels: null,
    allowed_roles: null,
    blocked_roles: null,
};

export function invalidate(guildId) {
    cache.delete(guildId);
}

export async function getConfig(guildId) {
    const hit = cache.get(guildId);
    if (hit && hit.expires > Date.now()) return hit.value;

    let value = { ...DEFAULTS };
    try {
        const [rows] = await pool.execute('SELECT * FROM tts_config WHERE guild_id = ? LIMIT 1', [guildId]);
        if (rows[0]) {
            for (const [k, v] of Object.entries(rows[0])) {
                if (v !== null && v !== undefined) value[k] = v;
            }
        }
    } catch (err) {
        logger.warn(`[TTS] Could not read tts_config for ${guildId}: ${err.message}`);
    }

    cache.set(guildId, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
}

/** Lists are stored as JSON arrays by the dashboard; tolerate a comma-separated legacy string. */
function idList(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(String);
    const s = String(v).trim();
    if (s.startsWith('[')) {
        try { return JSON.parse(s).map(String); } catch { return []; }
    }
    return s.split(',').map(x => x.trim()).filter(Boolean);
}

/**
 * May this member run TTS here, with this text?
 * @returns {Promise<{allowed: boolean, reason?: string, config: object}>}
 */
export async function checkTTS(interaction, text) {
    const guildId = interaction.guild?.id;
    if (!guildId) return { allowed: true, config: DEFAULTS };

    const cfg = await getConfig(guildId);

    if (!(cfg.enabled === 1 || cfg.enabled === true)) {
        return { allowed: false, reason: 'Text-to-speech is turned off in this server.', config: cfg };
    }

    const blockedCh = idList(cfg.blocked_channels);
    if (blockedCh.includes(interaction.channelId)) {
        return { allowed: false, reason: 'Text-to-speech is not allowed in this channel.', config: cfg };
    }

    const allowedCh = idList(cfg.allowed_channels);
    if (allowedCh.length && !allowedCh.includes(interaction.channelId)) {
        return {
            allowed: false,
            reason: `Text-to-speech can only be used in ${allowedCh.map(id => `<#${id}>`).join(', ')}.`,
            config: cfg,
        };
    }

    const memberRoles = interaction.member?.roles?.cache;
    const blockedRoles = idList(cfg.blocked_roles);
    if (blockedRoles.length && memberRoles && blockedRoles.some(r => memberRoles.has(r))) {
        return { allowed: false, reason: 'Your role is not permitted to use text-to-speech here.', config: cfg };
    }

    const allowedRoles = idList(cfg.allowed_roles);
    if (allowedRoles.length && memberRoles && !allowedRoles.some(r => memberRoles.has(r))) {
        return {
            allowed: false,
            reason: `Text-to-speech is limited to ${allowedRoles.map(r => `<@&${r}>`).join(', ')}.`,
            config: cfg,
        };
    }

    const maxLen = Number(cfg.max_length) || 0;
    if (maxLen > 0 && text && text.length > maxLen) {
        return {
            allowed: false,
            reason: `That text is ${text.length} characters — this server allows up to ${maxLen}.`,
            config: cfg,
        };
    }

    const cooldown = Number(cfg.cooldown_seconds) || 0;
    if (cooldown > 0) {
        const key = `${guildId}:${interaction.user.id}`;
        const last = lastUsed.get(key) || 0;
        const waited = (Date.now() - last) / 1000;
        if (waited < cooldown) {
            return {
                allowed: false,
                reason: `Slow down — you can use text-to-speech again in ${Math.ceil(cooldown - waited)}s.`,
                config: cfg,
            };
        }
    }

    return { allowed: true, config: cfg };
}

/**
 * Record a successful use, starting the cooldown. Called only after the command actually ran,
 * so a rejected or failed attempt never costs the user their next turn.
 */
export function markUsed(guildId, userId) {
    lastUsed.set(`${guildId}:${userId}`, Date.now());

    // The map is keyed per guild+user and would otherwise grow without bound on a large network.
    if (lastUsed.size > 10_000) {
        const cutoff = Date.now() - 3600_000;
        for (const [k, t] of lastUsed) {
            if (t < cutoff) lastUsed.delete(k);
        }
    }
}

export default { getConfig, checkTTS, markUsed, invalidate };
