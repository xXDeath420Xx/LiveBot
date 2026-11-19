/**
 * Role Manager — pure rules behind the dashboard's Roles page
 * (dashboard/routes/api/features/role-manager.js). No Discord or DB access here, so every
 * hierarchy decision is unit-tested (tests/role-manager-logic.test.js).
 *
 * Who may touch a role:
 *   - never @everyone (except permission edits) and never a managed role (bots, boosts,
 *     integrations — Discord assigns those itself);
 *   - the bot only below its own highest role;
 *   - the person only below THEIR highest role, unless they own the server. The dashboard
 *     gate only proves Manage Server, so without this a moderator could hand themselves
 *     a role above their own — something Discord's own UI never allows.
 *
 * Role history comes from audit_logs (MEMBER_ROLES_ADDED / MEMBER_ROLES_REMOVED, written by
 * core/log-manager.js with metadata.roleIds) replayed in id order.
 */

import { PermissionFlagsBits } from 'discord.js';

/** Permissions worth flagging on the role list — the ones that make a role "staff". */
export const KEY_PERMISSIONS = [
    'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers',
    'KickMembers', 'ModerateMembers', 'ManageMessages', 'MentionEveryone', 'ManageWebhooks',
];

export const MAX_ROLE_NAME = 100;

/**
 * The authority a request acts with.
 *   ownerOrBypass — server owner, or a super-admin acting through the bot: limited only by the bot.
 *   top           — the actor's highest role position (ignored when ownerOrBypass).
 */
export function actorAuthority({ isOwner = false, isSuperAdmin = false, topPosition = 0 } = {}) {
    return { ownerOrBypass: !!(isOwner || isSuperAdmin), top: Number(topPosition) || 0 };
}

/**
 * Can this role be edited / assigned / deleted by the bot on this actor's behalf?
 * @param {{id:string, position:number, managed:boolean}} role
 * @param {{guildId:string, botTop:number, actor:{ownerOrBypass:boolean, top:number}}} ctx
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canManageRole(role, { guildId, botTop, actor }) {
    if (!role) return { ok: false, reason: 'That role no longer exists.' };
    if (role.id === guildId) return { ok: false, reason: '@everyone is held by every member and cannot be assigned.' };
    if (role.managed) return { ok: false, reason: 'Managed by an integration or bot — Discord assigns it itself.' };
    if (role.position >= botTop) return { ok: false, reason: "At or above the bot's highest role." };
    if (!actor.ownerOrBypass && role.position >= actor.top) {
        return { ok: false, reason: 'At or above your own highest role.' };
    }
    return { ok: true };
}

/** Names of the KEY_PERMISSIONS set in a permission bitfield (bigint or string). */
export function keyPermissions(bits) {
    let value;
    try { value = BigInt(bits ?? 0); } catch { return []; }
    if (value & PermissionFlagsBits.Administrator) return ['Administrator'];
    return KEY_PERMISSIONS.filter(name => value & PermissionFlagsBits[name]);
}

/**
 * Validate a role edit from the page. Only the fields present are changed.
 * @returns {{ patch: object } | { error: string }}
 */
export function validateRoleEdit(body, { resolveColor, resolvePermissions }) {
    const patch = {};
    const b = body || {};

    if (b.name !== undefined) {
        const name = String(b.name).trim();
        if (!name) return { error: 'A role needs a name.' };
        if (name.length > MAX_ROLE_NAME) return { error: `Role names are capped at ${MAX_ROLE_NAME} characters.` };
        patch.name = name;
    }
    if (b.color !== undefined) {
        const c = resolveColor(b.color === null ? '' : b.color);
        if (c.error) return { error: c.error };
        patch.color = c.color;
    }
    if (b.hoist !== undefined) patch.hoist = !!b.hoist;
    if (b.mentionable !== undefined) patch.mentionable = !!b.mentionable;
    if (b.permissions !== undefined) {
        if (!Array.isArray(b.permissions)) return { error: 'Permissions must be a list.' };
        const p = resolvePermissions(b.permissions);
        if (p.error) return { error: p.error };
        patch.permissions = p.perms;
    }
    if (!Object.keys(patch).length) return { error: 'Nothing to change.' };
    return { patch };
}

/**
 * A permission edit may only add bits the actor could grant themselves. Bits the role
 * already has are kept even if the actor lacks them (removing is always allowed), so an
 * edit can't silently strip something the editor never touched.
 *
 * @param {string[]} requested   flag names the role should end up with
 * @param {string[]} current     flag names the role has now
 * @param {(name:string)=>boolean} actorMayGrant
 * @returns {{ final: string[], refused: string[] }}
 */
export function mergePermissionEdit(requested, current, actorMayGrant) {
    const have = new Set(current);
    const final = [];
    const refused = [];
    for (const name of new Set(requested)) {
        if (have.has(name) || actorMayGrant(name)) final.push(name);
        else refused.push(name);
    }
    return { final, refused };
}

/**
 * Replay a member's role events to find what they held when they last left.
 *
 * @param {Array<{id:number, event_type:string, metadata:any, timestamp:any}>} events
 *        This member's audit_logs rows, any order.
 * @returns {{ leftAt: any, roleIds: string[] } | null}  null if no leave is on record.
 */
export function rolesAtLastLeave(events) {
    const sorted = [...(events || [])].sort((a, b) => Number(a.id) - Number(b.id));
    const held = new Set();
    let last = null;
    for (const e of sorted) {
        if (e.event_type === 'GUILD_MEMBER_LEAVE') {
            last = { leftAt: e.timestamp, roleIds: [...held] };
            held.clear();
            continue;
        }
        const ids = roleIdsOf(e.metadata);
        if (e.event_type === 'MEMBER_ROLES_ADDED') ids.forEach(id => held.add(id));
        else if (e.event_type === 'MEMBER_ROLES_REMOVED') ids.forEach(id => held.delete(id));
    }
    return last;
}

/** metadata.roleIds from an audit_logs row (JSON string or already-parsed object). */
export function roleIdsOf(metadata) {
    let m = metadata;
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return []; } }
    const ids = m?.roleIds;
    return Array.isArray(ids) ? ids.map(String).filter(id => /^\d{15,25}$/.test(id)) : [];
}

/** X-Audit-Log-Reason must be plain ASCII — em-dashes and emoji make Discord 400. */
export function auditReason(text) {
    return String(text ?? '').replace(/[^\x20-\x7E]/g, '').slice(0, 400) || 'Role Manager (dashboard)';
}
