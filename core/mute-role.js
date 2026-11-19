/*
 * The Moderation page's "Mute role" (moderation_config.muted_role_id).
 *
 * A mute in CertiFried is a Discord timeout, whoever applies it: /admin mod mute, automod, an
 * escalation rule, the word-filter card, or a moderator using Discord's own menu. When the server
 * has a mute role, the role follows the timeout:
 *   - given when the timeout starts or is extended (events/guildMemberUpdate.js sees
 *     communication_disabled_until change and calls syncMuteRole),
 *   - held on a temp_roles timer that ends when the timeout ends, so jobs/timed-moderation-job.js
 *     takes it away (Discord sends no event when a timeout simply runs out),
 *   - taken away at once when the timeout is lifted early.
 *
 * A mute role a member already held without a timer (given by hand) is never touched. Managed roles,
 * @everyone and roles at or above the bot's highest role are never handed out; the mod log is told
 * once per process per guild and problem so the setting can be fixed.
 */
import { PermissionsBitField } from 'discord.js';
import logger from '../utils/logger.js';
import { getModerationSettings } from './moderation-manager.js';
import { grantTempRole, getActiveTempRole, cancelTempRole } from './timed-moderation-manager.js';
import { postModNote } from './mod-log-notes.js';

const warned = new Set(); // `${guildId}:${roleId}:${problem}` already reported to the mod log

const PROBLEM_TEXT = Object.freeze({
    deleted: 'The mute role set on the Moderation page no longer exists.',
    managed: 'The mute role set on the Moderation page belongs to an integration, so it cannot be given to members.',
    everyone: 'The mute role set on the Moderation page is @everyone.',
    'no-permission': 'I do not have the Manage Roles permission, so I cannot give the mute role.',
    'above-bot': 'The mute role is at or above my highest role, so I cannot give it. Move my role above it in Server Settings > Roles.',
});

/** Why the bot cannot give `role`, or null when it can. `me` is the bot's GuildMember. Pure. */
export function muteRoleProblem(role, me) {
    if (!role) return 'deleted';
    if (role.managed) return 'managed';
    if (role.guild && role.id === role.guild.id) return 'everyone';
    if (!me?.permissions?.has?.(PermissionsBitField.Flags.ManageRoles)) return 'no-permission';
    if (role.position >= (me.roles?.highest?.position ?? 0)) return 'above-bot';
    return null;
}

/** The member's timeout end in ms when it is still in the future, else null. Pure. */
export function activeTimeoutEnd(member, now = Date.now()) {
    const t = member?.communicationDisabledUntilTimestamp;
    return typeof t === 'number' && t > now ? t : null;
}

/** Several bot clients can share a server; only the one serving it acts, so the role is given once. */
function isResponsibleClient(member) {
    const owner = global.botManager?.getClientForGuild?.(member.guild.id);
    return !owner || owner === member.client;
}

async function reportProblem(guild, roleId, problem) {
    const key = `${guild.id}:${roleId}:${problem}`;
    logger.warn('[MuteRole] Cannot give the mute role', { guildId: guild.id, roleId, problem });
    if (warned.has(key)) return;
    warned.add(key);
    await postModNote(guild, {
        kind: 'warning',
        title: 'Mute role not given',
        description: `${PROBLEM_TEXT[problem] || 'The mute role cannot be given.'} Muted members still get the Discord timeout. The mute role is set on the dashboard's Moderation page.`,
    }).catch(() => {});
}

/**
 * Give the mute role until `untilMs` (or move its timer there when the member already has it on one).
 * @returns {Promise<{ok:boolean, reason?:string, extended?:boolean}>}
 */
export async function applyMuteRole(member, roleId, untilMs) {
    const guild = member.guild;
    const role = guild.roles.cache.get(roleId) || null;
    const problem = muteRoleProblem(role, guild.members.me);
    if (problem) {
        await reportProblem(guild, roleId, problem);
        return { ok: false, reason: problem };
    }
    const seconds = Math.max(60, Math.ceil((untilMs - Date.now()) / 1000));
    const result = await grantTempRole({
        member, role, moderator: member.client.user, seconds, reason: 'Muted (timeout)',
    });
    if (!result.ok) {
        // Held without a timer: someone gave it by hand, and a timer would take it away again.
        logger.info('[MuteRole] Member already holds the mute role permanently; left as it is', { guildId: guild.id, userId: member.id, roleId });
        return { ok: false, reason: 'held-permanently' };
    }
    return { ok: true, extended: result.extended };
}

/**
 * Take the mute role away now and stop its timer, but only when the bot gave it for a mute (there is
 * a running temp_roles timer). On failure the timer is left running, so the timed-moderation job
 * retries when it ends and reports to the mod log if it still cannot.
 * @returns {Promise<{ok:boolean, removed:boolean}>}
 */
export async function liftMuteRole(member, roleId, reason = 'Mute ended') {
    const guild = member.guild;
    const active = await getActiveTempRole(guild.id, member.id, roleId);
    if (!active) return { ok: true, removed: false };
    const role = guild.roles.cache.get(roleId) || null;
    if (role && member.roles.cache.has(roleId)) {
        if (muteRoleProblem(role, guild.members.me)) return { ok: false, removed: false };
        try {
            await member.roles.remove(role, reason);
        } catch (err) {
            logger.warn('[MuteRole] Could not remove the mute role', { guildId: guild.id, userId: member.id, roleId, error: err.message });
            return { ok: false, removed: false };
        }
        await cancelTempRole(guild.id, member.id, roleId, 'mute ended early');
        return { ok: true, removed: true };
    }
    await cancelTempRole(guild.id, member.id, roleId, role ? 'role already removed' : 'role was deleted');
    return { ok: true, removed: false };
}

/**
 * guildMemberUpdate hook: keep the mute role in step with the member's timeout. Never throws.
 */
export async function syncMuteRole(oldMember, newMember) {
    try {
        if (!newMember?.guild || newMember.user?.bot) return;
        const before = oldMember?.communicationDisabledUntilTimestamp ?? null;
        const after = newMember.communicationDisabledUntilTimestamp ?? null;
        if (before === after) return;
        if (!isResponsibleClient(newMember)) return;
        const { mutedRoleId } = await getModerationSettings(newMember.guild.id);
        if (!mutedRoleId) return;
        const until = activeTimeoutEnd(newMember);
        if (until) await applyMuteRole(newMember, mutedRoleId, until);
        else await liftMuteRole(newMember, mutedRoleId, 'Timeout removed');
    } catch (err) {
        logger.error('[MuteRole] Sync failed', { guildId: newMember?.guild?.id, userId: newMember?.id, error: err.message });
    }
}

export default { syncMuteRole, applyMuteRole, liftMuteRole, muteRoleProblem, activeTimeoutEnd };
