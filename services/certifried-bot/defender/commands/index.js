/**
 * Defender chat-command registration + permission tiers.
 *
 * Defender commands are dispatched directly from command-handler.js (an
 * in-memory map), NOT through the DB-backed tokes_global_command_config
 * registry. Tiers: everyone < broadcaster < manager < admin.
 */
import pool from '../../../../utils/db.js';
import { isManager } from '../managers.js';
import * as banlistCmds from './banlist-commands.js';
import * as infoCmds from './info-commands.js';

// Bot-owner platform ids (Kick/Twitch), from env — same source tokes-admin uses.
const OWNER_PLATFORM_IDS = new Set(
    [process.env.TOKES_OWNER_ID, process.env.TOKES_KICK_OWNER_ID]
        .filter(Boolean)
        .map(String)
);

export function meetsMinRole(minRole, { isBroadcaster, isManager: mgr, isAdmin }) {
    switch (minRole) {
        case 'admin': return !!isAdmin;
        case 'manager': return !!isAdmin || !!mgr;
        case 'broadcaster': return !!isAdmin || !!mgr || !!isBroadcaster;
        case 'everyone':
        default: return true;
    }
}

/**
 * Map a chat sender's platform user id to their tokes_users.id (+ role), or
 * null if they have no linked account.
 */
export async function resolveTokesUser(platform, platformUserId) {
    if (!platformUserId) return null;
    const [[row]] = await pool.execute(
        `SELECT u.id, u.role
         FROM tokes_users u
         JOIN tokes_platform_connections pc ON pc.user_id = u.id
         WHERE pc.platform = ? AND pc.platform_id = ?
         LIMIT 1`,
        [platform, String(platformUserId)]
    );
    return row || null;
}

/**
 * Build the permission context for a chat sender:
 *  - isAdmin: bot owner (env platform id) OR tokes role 'owner'
 *  - isManager: row in kbd_managers (or admin)
 *  - isBroadcaster: channel owner (from the chat event)
 */
export async function resolvePermissionContext(ctx) {
    const tokesUser = await resolveTokesUser(ctx.platform, ctx.userId);
    const tokesUserId = tokesUser?.id ?? null;
    const isAdmin = OWNER_PLATFORM_IDS.has(String(ctx.userId)) || tokesUser?.role === 'owner';
    const mgr = isAdmin || await isManager(tokesUserId);
    return { isBroadcaster: !!ctx.isBroadcaster, isManager: mgr, isAdmin, tokesUserId };
}

// command key -> { handler, minRole, aliases }
export const defenderCommands = {
    'add-ban':       { handler: banlistCmds.addBanCmd,      minRole: 'manager',  aliases: ['add-bans'] },
    'remove-ban':    { handler: banlistCmds.removeBanCmd,   minRole: 'manager',  aliases: ['remove-bans'] },
    'add-sublist':   { handler: banlistCmds.addSublistCmd,  minRole: 'manager',  aliases: ['add-sublists'] },
    'clear-sublist': { handler: banlistCmds.clearSublistCmd, minRole: 'manager', aliases: [] },
    'add-unban':     { handler: banlistCmds.addUnbanCmd,    minRole: 'manager',  aliases: ['add-unbans'] },
    'remove-unban':  { handler: banlistCmds.removeUnbanCmd, minRole: 'manager',  aliases: ['remove-unbans'] },
    'add-malicious-site':    { handler: banlistCmds.addSiteCmd,    minRole: 'manager', aliases: ['add-known-malicious-site'] },
    'remove-malicious-site': { handler: banlistCmds.removeSiteCmd, minRole: 'manager', aliases: ['remove-known-malicious-site'] },
    'check-ban':     { handler: banlistCmds.checkBanCmd,    minRole: 'everyone', aliases: [] },
    'kbd-counts':    { handler: banlistCmds.countsCmd,      minRole: 'manager',  aliases: ['get-ban-count', 'get-sublist-count', 'get-unban-count', 'get-unbans-count'] },
    'ping':          { handler: infoCmds.pingCmd,           minRole: 'everyone', aliases: ['kumabot', 'kbd'] },
    'kbd-info':      { handler: infoCmds.infoCmd,           minRole: 'everyone', aliases: ['kbd-help'] },
    'join':          { handler: infoCmds.joinCmd,           minRole: 'everyone', aliases: [] },
    'mod-check':     { handler: infoCmds.modCheckCmd,       minRole: 'manager',  aliases: ['mod-checks'] }
};

// alias/key -> canonical key
const aliasToKey = (() => {
    const map = {};
    for (const [key, def] of Object.entries(defenderCommands)) {
        map[key] = key;
        for (const alias of def.aliases) map[alias] = key;
    }
    return map;
})();

/** Resolve a typed command name (or alias) to a defender command def, or null. */
export function resolveDefenderCommand(name) {
    const key = aliasToKey[name?.toLowerCase()];
    return key ? { key, ...defenderCommands[key] } : null;
}
