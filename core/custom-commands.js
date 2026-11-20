/**
 * Custom commands — the store behind `/tools cc` (commands/admin/cc.js).
 *
 * One table, one set of rules. `custom_commands` is also what the dashboard's Custom Commands page
 * edits (dashboard/routes/api/features/custom-commands.js) and what core/custom-command-handler.js
 * runs from chat (`!name`), so /cc uses the same columns (command_name, response, action_type,
 * action_content, required_roles, allowed_channels, use_count, last_used_at), the same name rule,
 * the same 2000-character response limit, the same built-in-name check and the same template
 * variables ({user.name}, {choice:a|b}, {api:https://…} …, core/custom-command-vars.js). Every write
 * clears the handler's lookup cache so the change applies at once.
 *
 * Until 2026-11-18 this file held a second {{…}} template engine and read columns the table never
 * had, so every /cc subcommand failed with "Unknown column 'name'" (register H-300).
 */
import pool from '../utils/db.js';
import { invalidateCommandCache } from './custom-command-handler.js';
import { validateTemplate, MESSAGE_MAX } from './custom-command-vars.js';
import { isReservedName, resolve as resolveChatPath } from './universal-commands.js';
import { getCommand } from './prefix-command-registry.js';

export const NAME_MAX = 30;
export const NAME_RE = /^[a-z0-9_-]{1,30}$/;
export const RESPONSE_MAX = MESSAGE_MAX; // one Discord message

export function normaliseName(name) {
    return String(name ?? '').toLowerCase().trim();
}

/**
 * The dashboard's name rule. A name that is already a built-in command or shortcut is refused,
 * because the chat bridge checks custom commands last and such a command would never fire.
 * @param opts.currentName skip the built-in check when an existing command keeps its name.
 * @returns {{ name: string } | { error: string }}
 */
export function checkName(name, { currentName = null } = {}) {
    const clean = normaliseName(name);
    if (!NAME_RE.test(clean)) {
        return { error: `Name must be 1–${NAME_MAX} characters: letters, numbers, - or _ (no prefix symbol).` };
    }
    // resolveChatPath: a bare word chat already answers (e.g. "welcome" runs /manage welcome) shadows it too (H-805).
    if (clean !== currentName && (getCommand(clean) || isReservedName(clean) || resolveChatPath([clean])?.path)) {
        return { error: `"${clean}" is already a built-in command or shortcut — pick another name.` };
    }
    return { name: clean };
}

export async function list(guildId) {
    const [rows] = await pool.execute(
        `SELECT id, command_name, action_type, action_content, required_roles, allowed_channels, use_count, last_used_at
           FROM custom_commands WHERE guild_id = ? ORDER BY command_name`, [String(guildId)]);
    return rows;
}

export async function get(guildId, name) {
    const [[row]] = await pool.execute(
        'SELECT * FROM custom_commands WHERE guild_id = ? AND command_name = ?', [String(guildId), normaliseName(name)]);
    return row || null;
}

/** Names starting with `typed`, for autocomplete. */
export async function namesLike(guildId, typed, limit = 25) {
    const prefix = normaliseName(typed).replace(/[\\%_]/g, (c) => `\\${c}`);
    const [rows] = await pool.execute(
        `SELECT command_name FROM custom_commands WHERE guild_id = ? AND command_name LIKE ?
          ORDER BY command_name LIMIT ${Math.max(1, Math.min(25, Number(limit) || 25))}`,
        [String(guildId), `${prefix}%`]);
    return rows.map(r => r.command_name);
}

/**
 * Create a reply command, or replace an existing command's response. Replacing a role command
 * turns it into a reply command; its required roles and allowed channels are kept.
 * @returns {Promise<{ name: string, created: boolean, warnings: string[] } | { error: string }>}
 */
export async function saveReply(guildId, name, response) {
    const text = String(response ?? '');
    if (!text.trim()) return { error: 'A reply command needs a response.' };
    if (text.length > RESPONSE_MAX) return { error: `Response must be under ${RESPONSE_MAX} characters.` };

    const existing = await get(guildId, name);
    const check = checkName(name, { currentName: existing?.command_name ?? null });
    if (check.error) return check;

    if (existing) {
        await pool.execute(
            `UPDATE custom_commands SET response = ?, action_type = 'reply', action_content = NULL
              WHERE id = ? AND guild_id = ?`,
            [text, existing.id, String(guildId)]);
    } else {
        await pool.execute(
            `INSERT INTO custom_commands (guild_id, command_name, response, action_type)
             VALUES (?, ?, ?, 'reply')`,
            [String(guildId), check.name, text]);
    }
    invalidateCommandCache(guildId, check.name);
    return { name: check.name, created: !existing, warnings: validateTemplate(text).warnings };
}

export async function remove(guildId, name) {
    const clean = normaliseName(name);
    const [res] = await pool.execute(
        'DELETE FROM custom_commands WHERE guild_id = ? AND command_name = ?', [String(guildId), clean]);
    if (res.affectedRows > 0) invalidateCommandCache(guildId, clean);
    return res.affectedRows > 0;
}

export function parseIds(value) {
    try {
        const ids = value ? JSON.parse(value) : [];
        return Array.isArray(ids) ? ids.map(String) : [];
    } catch { return []; }
}

export default { NAME_MAX, NAME_RE, RESPONSE_MAX, normaliseName, checkName, list, get, namesLike, saveReply, remove, parseIds };
