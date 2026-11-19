// Identity, roles, audit and the RCON command allowlist for the Windrose panel.
//
// This module is the whole point of the custom panel. Windrose+ has one shared
// RCON password and no idea who is behind a request; everything here exists to
// put a Discord identity in front of that and write down what was done.
//
// Enforcement must live server-side and be shared by every entry point. The
// Discord commands in Phase 7 import the same functions, so a role means the
// same thing whether it is exercised from the web or from chat.

import { query } from '../../utils/db.js';
import logger from '../../utils/logger.js';

// Ordered weakest → strongest. Comparison is by index, so inserting a role in
// the middle automatically works everywhere.
export const ROLES = ['viewer', 'player', 'admin', 'owner'];

export function roleAtLeast(role, minimum) {
    const have = ROLES.indexOf(role);
    const need = ROLES.indexOf(minimum);
    // Unknown roles are treated as "no access" rather than defaulting to the
    // weakest known role, so a typo in a DB row cannot silently grant anything.
    if (have === -1 || need === -1) return false;
    return have >= need;
}

/*
 * Commands that exist to poke at live Unreal Engine objects — read arbitrary
 * fields, call arbitrary methods, dump memory. They are debugging tools, not
 * admin tools: `wp.methods` on the right object is a footgun that can crash the
 * server or corrupt a save, and none of it is something a co-admin needs to run
 * a friends' server. Owner only.
 */
export const OWNER_ONLY_COMMANDS = new Set([
    'wp.inspect', 'wp.props', 'wp.methods', 'wp.peek', 'wp.fields',
    'wp.discover', 'wp.probe_player', 'wp.nativeprobe', 'wp.gm', 'wp.settings',
]);

/** Minimum role that may run a console command at all. */
export const CONSOLE_MIN_ROLE = 'admin';

/**
 * Normalise a console command to the token that decides permission.
 *
 * Case, leading whitespace and argument text must not change the verdict:
 * "  WP.Inspect foo" and "wp.inspect foo" are the same command, and an
 * allowlist that compares raw strings is bypassed by the first of those.
 */
export function normaliseCommand(input) {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    const [head] = trimmed.split(/\s+/);
    return head.toLowerCase();
}

/**
 * Decide whether `role` may run `command`.
 * `catalog` is the live command list from Windrose+ (windrose_plus_data/commands.json);
 * when supplied, unknown commands are refused rather than passed through.
 */
export function isCommandAllowed(role, command, catalog = null) {
    const name = normaliseCommand(command);
    if (!name) return { allowed: false, reason: 'empty command' };

    // Everything Windrose+ exposes is namespaced. Refusing anything else keeps
    // this from becoming a generic passthrough if upstream ever adds one.
    if (!name.startsWith('wp.')) {
        return { allowed: false, reason: 'only wp.* commands are permitted' };
    }

    if (!roleAtLeast(role, CONSOLE_MIN_ROLE)) {
        return { allowed: false, reason: `console access requires the ${CONSOLE_MIN_ROLE} role` };
    }

    if (OWNER_ONLY_COMMANDS.has(name) && !roleAtLeast(role, 'owner')) {
        return { allowed: false, reason: `${name} is an engine-introspection command and is owner-only` };
    }

    // Catalog enforcement applies below owner only.
    //
    // commands.json is the AUTOCOMPLETE list, not the full command set. Verified
    // against v1.3.17: it advertises 32 commands and deliberately omits exactly
    // the introspection families — wp.inspect, wp.props, wp.methods, wp.peek,
    // wp.fields, wp.discover, wp.probe_player, wp.nativeprobe, wp.gm,
    // wp.settings — plus wp.modreload. Those commands still execute.
    //
    // So enforcing the catalog against the owner would block precisely the
    // commands the owner tier exists to grant. Admins are held to the
    // advertised set (a tight, useful allowlist); the owner is trusted with
    // the rest, having already been gated by OWNER_ONLY_COMMANDS above.
    if (!roleAtLeast(role, 'owner') && Array.isArray(catalog) && catalog.length && !catalog.includes(name)) {
        return { allowed: false, reason: `unknown command ${name}` };
    }

    return { allowed: true, command: name };
}

/** Pull the flat list of command names out of whatever shape commands.json has. */
export function catalogNames(commandsJson) {
    if (!commandsJson) return [];
    const raw = Array.isArray(commandsJson) ? commandsJson : commandsJson.commands ?? [];
    return raw
        .map((c) => (typeof c === 'string' ? c : c?.name))
        .filter(Boolean)
        .map((n) => n.toLowerCase());
}

/**
 * Look up a user's role.
 *
 * Bootstrap: if the configured owner has no row yet, create one. Migration 199
 * seeds this, but a fresh database or a deleted row would otherwise lock the
 * owner out of their own server with no way to grant themselves back in.
 */
export async function getRole(discordId, { db = { query } } = {}) {
    if (!discordId) return 'viewer';

    const rows = await db.query('SELECT role FROM windrose_users WHERE discord_id = ?', [discordId]);
    if (rows.length) return rows[0].role;

    const ownerId = process.env.WINDROSE_OWNER_DISCORD_ID || process.env.BOT_OWNER_ID;
    if (ownerId && discordId === ownerId) {
        await db.query(
            `INSERT INTO windrose_users (discord_id, role, display_name, granted_by)
             VALUES (?, 'owner', 'owner (bootstrap)', 'bootstrap')
             ON DUPLICATE KEY UPDATE role = 'owner'`,
            [discordId],
        );
        return 'owner';
    }

    // Not an error: anyone logged in with Discord can look, which is what makes
    // the join page useful without an invite step.
    return 'viewer';
}

export async function setRole(discordId, role, { grantedBy = null, displayName = null, db = { query } } = {}) {
    if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
    await db.query(
        `INSERT INTO windrose_users (discord_id, role, display_name, granted_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by),
                                 display_name = COALESCE(VALUES(display_name), display_name)`,
        [discordId, role, displayName, grantedBy],
    );
    return { discordId, role };
}

export async function listUsers({ db = { query } } = {}) {
    return db.query(
        'SELECT discord_id, role, steam_id, display_name, granted_by, created_at FROM windrose_users ORDER BY FIELD(role, ?, ?, ?, ?) DESC, created_at ASC',
        ROLES,
    );
}

export async function linkSteamId(discordId, steamId, { db = { query } } = {}) {
    if (steamId && !/^\d{17}$/.test(steamId)) throw new Error('steam_id must be a 17-digit SteamID64');
    await db.query('UPDATE windrose_users SET steam_id = ? WHERE discord_id = ?', [steamId || null, discordId]);
    return { discordId, steamId: steamId || null };
}

/**
 * Record a privileged action. Never throws into the request path — losing an
 * audit line is bad, but failing the user's action because the audit insert
 * failed is worse, and the log still captures it.
 */
export async function audit(discordId, action, detail = null, result = 'ok', { db = { query } } = {}) {
    try {
        await db.query(
            'INSERT INTO windrose_audit (discord_id, action, detail, result) VALUES (?, ?, ?, ?)',
            [discordId || null, action, detail ? JSON.stringify(detail) : null, result],
        );
    } catch (err) {
        logger.error(`windrose audit write failed (${action}): ${err.message}`);
    }
}

export async function recentAudit({ limit = 100, action = null, db = { query } } = {}) {
    const capped = Math.min(Number(limit) || 100, 500);
    if (action) {
        return db.query(
            'SELECT * FROM windrose_audit WHERE action = ? ORDER BY id DESC LIMIT ?',
            [action, capped],
        );
    }
    return db.query('SELECT * FROM windrose_audit ORDER BY id DESC LIMIT ?', [capped]);
}

/**
 * Express middleware factory. Attaches `req.windroseRole` and refuses below
 * `minimum`, writing a denied audit row so attempts are visible.
 */
export function requireRole(minimum, { db = { query } } = {}) {
    return async function windroseRoleGate(req, res, next) {
        try {
            const discordId = req.user?.id;
            if (!discordId) {
                // Browsers get sent to login; API clients get JSON.
                if (req.path.includes('/api/')) return res.status(401).json({ error: 'not authenticated' });
                return res.redirect('/auth/discord?returnTo=' + encodeURIComponent(req.originalUrl));
            }

            const role = await getRole(discordId, { db });
            req.windroseRole = role;

            if (!roleAtLeast(role, minimum)) {
                await audit(discordId, 'access.denied', { path: req.originalUrl, role, needed: minimum }, 'denied', { db });
                if (req.path.includes('/api/')) {
                    return res.status(403).json({ error: `requires the ${minimum} role`, role });
                }
                return res.status(403).render('error', {
                    message: `This page needs the ${minimum} role. You have ${role}.`,
                    user: req.user,
                });
            }

            return next();
        } catch (err) {
            logger.error(`windrose role gate failed: ${err.message}`);
            return res.status(500).json({ error: 'permission check failed' });
        }
    };
}
