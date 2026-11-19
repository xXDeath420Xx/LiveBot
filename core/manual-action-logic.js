/*
 * "Manual action needed" — the pure part (no Discord or DB access; unit-tested in tests/manual-action.test.js).
 * The live side is core/manual-action.js, which every automated punitive path calls when the bot cannot act.
 *
 *   classifyCannotAct   BEFORE acting: why the bot cannot carry out an action on a member, as a cause plus the
 *                       sentence staff read. Causes:
 *                         missing_permission  the bot lacks Ban Members / Kick Members / Moderate Members /
 *                                             Manage Messages / Manage Roles (named in `permission`)
 *                         hierarchy           the member's highest role is not below the bot's highest role
 *                         role_hierarchy      the role the bot must give (flag / quarantine) is not below it
 *                         owner               the member owns the server
 *                         admin_timeout       Discord does not allow timing out administrators
 *                         not_member          they left (a ban still works on someone who left)
 *   cannotAct           the sentence only (the original message-threats API, re-exported from there)
 *   classifyError       AFTER Discord refused: a DiscordAPIError code turned into the same causes; null when the
 *                       failure is not something staff can fix by hand (network, rate limit, unknown)
 *   throttleKey         one alert per server per cause (per permission / per role) inside the throttle window,
 *                       so a raid of 200 joins against a bot without Ban Members is one alert, not 200
 */

export const PERMISSION_NAME = Object.freeze({
    ban: 'Ban Members',
    kick: 'Kick Members',
    timeout: 'Moderate Members',
    delete: 'Manage Messages',
    flag: 'Manage Roles',
    role: 'Manage Roles',
    quarantine: 'Manage Roles',
});

export const CAUSES = Object.freeze(['missing_permission', 'hierarchy', 'role_hierarchy', 'owner', 'admin_timeout', 'not_member', 'refused']);
export const THROTTLE_MS = 10 * 60_000;

const ROLE_ACTIONS = new Set(['flag', 'role', 'quarantine']);
const bold = (s) => (s ? `**${s}**` : null);

/**
 * Why the bot cannot do this, or null when it can.
 * @param {object} p
 * @param {string} p.action            ban | kick | timeout | delete | flag | role | quarantine
 * @param {object} p.botPerms          { ban, kick, timeout, delete, roles } booleans (delete = Manage Messages in that channel)
 * @param {number} p.botTop            position of the bot's highest role
 * @param {string} [p.botTopName]
 * @param {number|null} p.targetTop    position of the member's highest role (null = not a member)
 * @param {string} [p.targetTopName]
 * @param {string} [p.targetTopId]
 * @param {boolean} [p.targetOwner]
 * @param {boolean} [p.targetAdmin]    timeouts cannot be applied to administrators
 * @param {number|null} [p.rolePosition]  flag / quarantine: the position of the role to give
 * @param {string} [p.roleName]
 * @param {string} [p.roleId]
 * @returns {{ cause:string, permission:string|null, roleId:string|null, text:string } | null}
 */
export function classifyCannotAct({
    action, botPerms = {}, botTop = 0, botTopName = null, targetTop = null, targetTopName = null, targetTopId = null,
    targetOwner = false, targetAdmin = false, rolePosition = null, roleName = null, roleId = null,
}) {
    const permission = PERMISSION_NAME[action];
    if (!permission) return null;
    const permKey = ROLE_ACTIONS.has(action) ? 'roles' : action;
    if (!botPerms[permKey]) {
        return {
            cause: 'missing_permission', permission, roleId: null,
            text: `I am missing the **${permission}** permission${action === 'delete' ? ' in that channel' : ''}. Give my role ${permission} in Server Settings > Roles.`,
        };
    }
    if (action === 'delete') return null;
    if (ROLE_ACTIONS.has(action) && rolePosition != null && rolePosition >= botTop) {
        return {
            cause: 'role_hierarchy', permission: null, roleId: roleId ?? null,
            text: `The role I have to give (${bold(roleName) || 'that role'}) is not below my highest role (${bold(botTopName) || 'my role'}). Move my role above it in Server Settings > Roles.`,
        };
    }
    // Giving a role only needs the role below the bot: the member's own roles do not matter.
    if (ROLE_ACTIONS.has(action)) return targetTop == null ? { cause: 'not_member', permission: null, roleId: null, text: 'They are no longer in the server.' } : null;
    if (targetTop == null) {
        return action === 'ban' ? null : { cause: 'not_member', permission: null, roleId: null, text: 'They are no longer in the server.' };
    }
    if (targetOwner) return { cause: 'owner', permission: null, roleId: null, text: 'They own the server; nobody can act on the owner.' };
    if (action === 'timeout' && targetAdmin) {
        return { cause: 'admin_timeout', permission: null, roleId: null, text: 'They have Administrator, and Discord does not allow timing out administrators.' };
    }
    if (targetTop >= botTop) {
        return {
            cause: 'hierarchy', permission: null, roleId: targetTopId ?? null,
            text: `My highest role (${bold(botTopName) || 'my role'}) must be above theirs (${bold(targetTopName) || 'their highest role'}). Move my role higher in Server Settings > Roles.`,
        };
    }
    return null;
}

/** The sentence only (message threats' original API). */
export function cannotAct(p) {
    return classifyCannotAct(p)?.text ?? null;
}

/**
 * A Discord refusal turned into a cause staff can fix, or null.
 * 50013 Missing Permissions covers both a missing permission and the role order, so when the pre-flight check
 * passed the most useful sentence names both.
 * @param {{ code?:number|string, status?:number, message?:string }} err
 * @param {string} action
 */
export function classifyError(err, action) {
    const code = Number(err?.code);
    const permission = PERMISSION_NAME[action] ?? null;
    if (code === 50013) {
        return {
            cause: 'refused', permission, roleId: null,
            text: `Discord refused: missing permissions. Check that my role has ${permission ? `**${permission}**` : 'the permission'} and sits above the member's highest role.`,
        };
    }
    if (code === 50001) {
        return { cause: 'refused', permission: null, roleId: null, text: 'Discord refused: I cannot see that channel (Missing Access).' };
    }
    if (code === 10007 || code === 10013) return { cause: 'not_member', permission: null, roleId: null, text: 'They are no longer in the server.' };
    return null;
}

/** One alert per server per cause (and per permission / role) inside THROTTLE_MS. */
export function throttleKey(guildId, c) {
    return `manual:${guildId}:${c?.cause ?? 'unknown'}:${c?.permission || c?.roleId || ''}`;
}

/** Whether a cause is worth telling staff about (they left = nothing to do). */
export function needsStaff(c) {
    return !!c && c.cause !== 'not_member';
}

export default { PERMISSION_NAME, CAUSES, THROTTLE_MS, classifyCannotAct, cannotAct, classifyError, throttleKey, needsStaff };
