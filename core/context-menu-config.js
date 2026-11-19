/*
 * Per-guild gating and registry for context-menu (right-click) commands.
 *
 * `context_menu_config` shipped with no reader and, until now, nothing to read it about: the
 * codebase contained no context-menu commands at all. The table is one row per menu per guild:
 *
 *   menu_name        matches the command's `data.name`
 *   menu_type        'user' | 'message'
 *   enabled          per-guild switch
 *   permission_roles JSON array of role ids allowed to use it (empty = anyone)
 *
 * Rows are created lazily the first time a guild sees a menu, so the dashboard list fills itself
 * in rather than requiring a server to guess what exists.
 */

import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getConfig as getFeatureConfig } from './feature-config.js';

const CACHE_TTL_MS = 60_000;

/**
 * The Context Menus page's own switch (guild_feature_config 'context-menus'.enabled, on by default):
 * off turns every right-click action off in the server, whatever the per-menu rows say.
 */
export function menusSwitchedOn(cfg) {
    const v = cfg?.enabled;
    return !(v === false || v === 0 || v === '0' || v === 'false');
}
const cache = new Map(); // `${guildId}:${menuName}` -> { value, expires }

export function invalidate(guildId, menuName) {
    if (guildId && menuName) cache.delete(`${guildId}:${menuName}`);
    else cache.clear();
}

/**
 * Ensure a row exists for every known menu in this guild, so the dashboard has something to
 * list. Defaults to enabled — a menu that appears in Discord but is off by default would look
 * broken rather than optional.
 */
export async function ensureRows(guildId, menus) {
    if (!guildId || !menus?.length) return;
    try {
        for (const m of menus) {
            await pool.execute(
                `INSERT INTO context_menu_config (guild_id, menu_name, menu_type, enabled)
                 VALUES (?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE menu_type = VALUES(menu_type)`,
                [guildId, m.name, m.type]
            );
        }
    } catch (err) {
        // The table has no unique key on (guild_id, menu_name) in every deployment; a duplicate
        // here is harmless noise, not a failure worth surfacing.
        logger.debug(`[ContextMenu] ensureRows: ${err.message}`);
    }
}

/** Menu names as Discord allows them for context menus (1-32 characters; this table allows 100). */
export const MENU_NAME = /^[\p{L}\p{N} _'.-]{1,100}$/u;

/**
 * Change one menu's switch and role limit from the Context Menus page (H-703). Only an existing row
 * (seeded by ensureRows when the page opens) can be changed. `patch` takes `enabled` (0/1) and
 * `permission_roles` (an array of role ids; empty = anyone). Roles must belong to the server when the
 * bot can see it. Clears the cached row so checkAccess uses the change at once.
 * @returns {Promise<{ok: true, row: object} | {ok: false, error: string}>}
 */
export async function updateMenu(guildId, menuName, patch, { db = pool, guild } = {}) {
    if (!guildId || !MENU_NAME.test(String(menuName || ''))) return { ok: false, error: 'Unknown menu' };
    const sets = [];
    const values = [];
    if ('enabled' in patch) {
        sets.push('enabled = ?');
        values.push(patch.enabled ? 1 : 0);
    }
    if ('permission_roles' in patch) {
        const roles = [...new Set((Array.isArray(patch.permission_roles) ? patch.permission_roles : []).map(String))];
        if (roles.length > 25 || roles.some((r) => !/^\d{15,25}$/.test(r))) return { ok: false, error: 'Pick up to 25 roles.' };
        const g = guild === undefined ? global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId) : guild;
        if (g && roles.some((r) => r === String(guildId) || !g.roles.cache.has(r))) return { ok: false, error: 'A role is not in this server.' };
        sets.push('permission_roles = ?');
        values.push(roles.length ? JSON.stringify(roles) : null);
    }
    if (!sets.length) return { ok: false, error: 'Nothing to change' };
    const [res] = await db.execute(
        `UPDATE context_menu_config SET ${sets.join(', ')} WHERE guild_id = ? AND menu_name = ?`,
        [...values, guildId, menuName]
    );
    if (!res.affectedRows) return { ok: false, error: 'Unknown menu' };
    invalidate(guildId, menuName);
    const [rows] = await db.execute(
        'SELECT menu_name, menu_type, enabled, permission_roles FROM context_menu_config WHERE guild_id = ? AND menu_name = ? LIMIT 1',
        [guildId, menuName]
    );
    return { ok: true, row: rows[0] ?? null };
}

/** May this member use this menu here? Fail-open: an unconfigured guild keeps full access. */
export async function checkAccess(guildId, menuName, member) {
    if (!guildId) return { allowed: true };

    try {
        if (!menusSwitchedOn(await getFeatureConfig('context-menus', guildId))) {
            return { allowed: false, reason: 'Right-click actions are turned off in this server.' };
        }
    } catch (err) {
        logger.warn(`[ContextMenu] Could not read the Context Menus switch: ${err.message}`);
    }

    const key = `${guildId}:${menuName}`;
    const hit = cache.get(key);
    let row = hit && hit.expires > Date.now() ? hit.value : undefined;

    if (row === undefined) {
        try {
            const [rows] = await pool.execute(
                'SELECT enabled, permission_roles FROM context_menu_config WHERE guild_id = ? AND menu_name = ? LIMIT 1',
                [guildId, menuName]
            );
            row = rows[0] ?? null;
        } catch (err) {
            logger.warn(`[ContextMenu] Could not read config for ${menuName}: ${err.message}`);
            return { allowed: true };
        }
        cache.set(key, { value: row, expires: Date.now() + CACHE_TTL_MS });
    }

    if (!row) return { allowed: true };

    if (!(row.enabled === 1 || row.enabled === true)) {
        return { allowed: false, reason: 'That action is turned off in this server.' };
    }

    let roles = [];
    try {
        roles = row.permission_roles
            ? (Array.isArray(row.permission_roles) ? row.permission_roles : JSON.parse(row.permission_roles))
            : [];
    } catch { roles = []; }

    if (roles.length) {
        const has = member?.roles?.cache && roles.some(r => member.roles.cache.has(String(r)));
        if (!has) {
            return {
                allowed: false,
                reason: `That action is limited to ${roles.map(r => `<@&${r}>`).join(', ')}.`,
            };
        }
    }

    return { allowed: true };
}

export default { ensureRows, checkAccess, invalidate, updateMenu };
