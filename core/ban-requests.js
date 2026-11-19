/**
 * Ban requests (register H-657): who may ban outright with /ban, who kicks and files a request instead,
 * and where requests go. Set on the Moderation page (ban_request_config, migration 236;
 * PUT /api/guilds/:id/moderation/ban-requests) and read by commands/admin/ban.js and the approve / decline
 * buttons (interactions/buttons/ban_request.js).
 *
 * Without any setup the split follows Discord permissions: Ban Members bans, Kick Members files a request.
 * The page's roles add to that: approver roles may ban (and decide requests) without Ban Members, requester
 * roles may file requests without Kick Members. Before this, requester roles could only come from a table
 * nothing wrote, so the request path never ran.
 */
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';

export const BAN_REQUEST_ROLES_MAX = 25;

const ids = (raw) => {
    let v = raw;
    if (typeof raw === 'string') {
        try { v = JSON.parse(raw); } catch { v = []; }
    }
    return Array.isArray(v) ? [...new Set(v.map(String).filter((id) => /^\d{17,20}$/.test(id)))] : [];
};

/** A ban_request_config row (or nothing) → { channelId, approverRoleIds, requesterRoleIds }. */
export function parseBanRequestConfig(row) {
    const channel = String(row?.request_channel_id ?? '');
    return {
        channelId: /^\d{17,20}$/.test(channel) ? channel : null,
        approverRoleIds: ids(row?.approver_role_ids),
        requesterRoleIds: ids(row?.requester_role_ids),
    };
}

export async function readBanRequestConfig(guildId) {
    const [rows] = await pool.execute('SELECT * FROM ban_request_config WHERE guild_id = ?', [String(guildId)]);
    return parseBanRequestConfig(rows[0]);
}

const hasRole = (member, roleIds) => roleIds.some((r) => member?.roles?.cache?.has?.(r));
const hasPerm = (member, perm) => !!member?.permissions?.has?.(perm);

/**
 * What /ban does for this member: 'approver' bans outright, 'requester' kicks and files a request,
 * null may not use it.
 * @param {import('discord.js').GuildMember} member
 * @param {{ approverRoleIds: string[], requesterRoleIds: string[] }} cfg
 */
export function banRequestRole(member, cfg) {
    if (hasPerm(member, PermissionFlagsBits.BanMembers) || hasRole(member, cfg.approverRoleIds)) return 'approver';
    if (hasPerm(member, PermissionFlagsBits.KickMembers) || hasRole(member, cfg.requesterRoleIds)) return 'requester';
    return null;
}

/** Whether this member may approve or decline a request (the buttons check this, not the message). */
export const mayDecideBanRequest = (member, cfg) => banRequestRole(member, cfg) === 'approver';
