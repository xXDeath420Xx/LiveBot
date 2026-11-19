/**
 * Channel access manager — turns a hand-maintained per-user channel whitelist into a role.
 *
 * The mess this cleans up: an admin who hasn't made peace with roles grants channel access
 * one user at a time, as Discord member (type 1) permission overwrites. Twenty members later
 * the channel's access list exists nowhere but Discord's overwrite table, nobody can answer
 * "who can see this?" without scrolling a settings pane, and revoking access means hunting
 * for one row among twenty.
 *
 * The conversion is three moves: give the ROLE access to the channel, give the ROLE to
 * everyone on the whitelist, then drop the per-user overwrites that just became redundant.
 *
 * Three rules keep it from being destructive:
 *   1. An overwrite counts as "whitelist" only if it ALLOWS ViewChannel. Member overwrites
 *      that merely deny things are punishments — channel mutes, per-user blocks — and are
 *      never touched, never counted, never removed.
 *   2. The role receives the bits every whitelisted member SHARED (the intersection), never
 *      the union. One member holding ManageMessages must not hand ManageMessages to everyone
 *      who will ever wear the role.
 *   3. A member overwrite is deleted only once it is provably redundant — it grants nothing
 *      beyond what the role now grants, and denies nothing beyond what the role denies.
 *      Anything else is kept and reported, because deleting it would silently change that
 *      member's access.
 *
 * Ticket channels are refused outright: ticket-manager.js maintains per-user overwrites there
 * as its actual access-control mechanism, so "cleaning up the whitelist" would evict the
 * ticket's owner. See scripts/gotham-harden-channel-perms.mjs for the same caveat.
 */
import { PermissionsBitField, OverwriteType, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent } from './feature-log.js';

/**
 * Below this many whitelisted users there is no mess worth automating — converting two
 * people to a role is more clicks than just fixing it by hand, and it leaves a role behind
 * that nobody asked for. Deliberately not configurable.
 */
export const MIN_WHITELIST = 3;

const VIEW = PermissionsBitField.Flags.ViewChannel;

/** Threads have no overwrite table of their own — they inherit the parent's. */
const THREAD_TYPES = new Set([ChannelType.AnnouncementThread, ChannelType.PublicThread, ChannelType.PrivateThread]);

/** Audit-log reasons ride an ASCII-only HTTP header. */
const reason = (text) => String(text).replace(/[^\x20-\x7E]/g, '').slice(0, 400);

const bitsToOverwriteOptions = (allow, deny) => {
    const options = {};
    for (const name of new PermissionsBitField(allow).toArray()) options[name] = true;
    for (const name of new PermissionsBitField(deny).toArray()) options[name] = false;
    return options;
};

const permNames = (bits) => new PermissionsBitField(bits).toArray();

/**
 * The per-user grants on a channel: member overwrites that hand out ViewChannel.
 * Overwrites that only take permissions away are punishments and are excluded.
 */
export function readWhitelist(channel) {
    if (!channel?.permissionOverwrites || THREAD_TYPES.has(channel.type)) return [];
    const entries = [];
    for (const overwrite of channel.permissionOverwrites.cache.values()) {
        if (overwrite.type !== OverwriteType.Member) continue;
        const allow = overwrite.allow.bitfield;
        if ((allow & VIEW) !== VIEW) continue;
        entries.push({ userId: overwrite.id, allow, deny: overwrite.deny.bitfield });
    }
    return entries;
}

async function isTicketChannel(guildId, channelId) {
    try {
        const [rows] = await pool.execute(
            'SELECT 1 FROM tickets WHERE guild_id = ? AND channel_id = ? LIMIT 1', [guildId, channelId]);
        return rows.length > 0;
    } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') return false;
        logger.warn(`[ChannelAccess] Ticket lookup failed for ${channelId}: ${error.message}`);
        return false;   // fail open on a lookup error; the caller still sees the ticket-ish name
    }
}

/** Every ticket channel in the guild, in one query — a scan must not query per channel. */
async function ticketChannelIds(guildId) {
    try {
        const [rows] = await pool.execute('SELECT channel_id FROM tickets WHERE guild_id = ?', [guildId]);
        return new Set(rows.map(r => r.channel_id));
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.warn(`[ChannelAccess] Ticket lookup failed for guild ${guildId}: ${error.message}`);
        }
        return new Set();
    }
}

/**
 * Every channel in the guild currently carrying per-user grants, worst offender first.
 * This is the "find the mess I don't know about yet" half of the feature.
 */
export async function scanGuild(guild) {
    const ticketChannels = await ticketChannelIds(guild.id);
    const found = [];
    for (const channel of guild.channels.cache.values()) {
        if (THREAD_TYPES.has(channel.type)) continue;
        const whitelist = readWhitelist(channel);
        if (!whitelist.length) continue;
        found.push({
            channelId: channel.id,
            name: channel.name,
            type: channel.type,
            isCategory: channel.type === ChannelType.GuildCategory,
            userCount: whitelist.length,
            isTicket: ticketChannels.has(channel.id),
            convertible: whitelist.length >= MIN_WHITELIST,
        });
    }
    found.sort((a, b) => b.userCount - a.userCount || a.name.localeCompare(b.name));

    const watches = await listWatches(guild.id);
    const watchByChannel = new Map(watches.map(w => [w.channel_id, w]));
    for (const row of found) {
        const watch = watchByChannel.get(row.channelId);
        row.watchedRoleId = watch?.enabled ? watch.role_id : null;
    }
    return found;
}

/**
 * Convert one channel's per-user whitelist into `role`.
 *
 * Returns a plain result object rather than throwing on a refusal — every caller (slash
 * command, dashboard, watcher) needs to explain the refusal to a human, not swallow it.
 */
export async function convertWhitelistToRole({ channel, role, actorTag = 'dashboard', dryRun = false }) {
    const guild = channel.guild;
    const label = `#${channel.name}`;

    if (role.guild.id !== guild.id) return { ok: false, code: 'role_wrong_guild' };
    if (role.id === guild.id) return { ok: false, code: 'role_is_everyone' };
    if (role.managed) return { ok: false, code: 'role_is_managed', roleName: role.name };
    if (!role.editable) return { ok: false, code: 'role_above_bot', roleName: role.name };
    if (THREAD_TYPES.has(channel.type)) return { ok: false, code: 'channel_is_thread', label };
    if (await isTicketChannel(guild.id, channel.id)) return { ok: false, code: 'channel_is_ticket', label };

    const me = guild.members.me;
    const canManage = channel.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageRoles);
    if (!canManage) return { ok: false, code: 'cannot_manage_channel', label };

    // ── who is on the whitelist ──────────────────────────────────────────────
    const whitelist = readWhitelist(channel);
    const actionable = [];
    const stale = [];
    const bots = [];
    for (const entry of whitelist) {
        const member = guild.members.cache.get(entry.userId)
            || await guild.members.fetch(entry.userId).catch(() => null);
        if (!member) { stale.push(entry.userId); continue; }
        if (member.user.bot) { bots.push(member); continue; }
        actionable.push({ ...entry, member });
    }

    if (actionable.length < MIN_WHITELIST) {
        return {
            ok: false,
            code: 'below_threshold',
            label,
            userCount: actionable.length,
            minimum: MIN_WHITELIST,
            staleCount: stale.length,
            botCount: bots.length,
        };
    }

    // ── what the role should grant ───────────────────────────────────────────
    // Intersection, not union: the role carries only what every whitelisted member already
    // shared, so nobody's stray extra permission becomes everyone's permission.
    let sharedAllow = actionable[0].allow;
    let sharedDeny = actionable[0].deny;
    for (const entry of actionable.slice(1)) {
        sharedAllow &= entry.allow;
        sharedDeny &= entry.deny;
    }

    const existing = channel.permissionOverwrites.cache.get(role.id);
    const roleHadAccess = !!existing && (existing.allow.bitfield & VIEW) === VIEW;
    // What the role will actually grant once we're done — the union of what it already had
    // and what we're about to add. Redundancy is judged against this.
    const effectiveAllow = (existing?.allow.bitfield ?? 0n) | (roleHadAccess ? 0n : sharedAllow);
    const effectiveDeny = roleHadAccess ? (existing?.deny.bitfield ?? 0n) : sharedDeny;

    const plan = {
        ok: true,
        dryRun,
        label,
        channelId: channel.id,
        roleId: role.id,
        roleName: role.name,
        userCount: actionable.length,
        roleHadAccess,
        roleGrantAdded: roleHadAccess ? [] : permNames(sharedAllow),
        roleDenyAdded: roleHadAccess ? [] : permNames(sharedDeny),
        granted: [],        // got the role
        alreadyHadRole: [],
        overwritesRemoved: [],
        overwritesKept: [],  // grant/deny more than the role does — removing them would change access
        failures: [],
        staleCount: stale.length,
        botCount: bots.length,
    };

    for (const entry of actionable) {
        const hasRole = entry.member.roles.cache.has(role.id);
        const redundant = (entry.allow & ~effectiveAllow) === 0n && (entry.deny & ~effectiveDeny) === 0n;
        const tag = entry.member.user.tag;
        if (hasRole) plan.alreadyHadRole.push(tag); else plan.granted.push(tag);
        if (redundant) plan.overwritesRemoved.push(tag);
        else plan.overwritesKept.push({ userId: entry.userId, tag, extraAllow: permNames(entry.allow & ~effectiveAllow), extraDeny: permNames(entry.deny & ~effectiveDeny) });
    }

    if (dryRun) return plan;

    // ── apply: role gets access first, so nobody is ever briefly locked out ──
    const auditReason = reason(`Whitelist to role by ${actorTag}`);
    if (!roleHadAccess) {
        try {
            await channel.permissionOverwrites.edit(role, bitsToOverwriteOptions(sharedAllow, sharedDeny), { reason: auditReason });
        } catch (error) {
            logger.error(`[ChannelAccess] Failed to grant ${role.name} access to ${label}: ${error.message}`);
            return { ok: false, code: 'role_grant_failed', label, roleName: role.name, error: error.message };
        }
    }

    plan.granted = [];
    plan.overwritesRemoved = [];
    for (const entry of actionable) {
        const tag = entry.member.user.tag;
        if (!entry.member.roles.cache.has(role.id)) {
            try {
                await entry.member.roles.add(role, auditReason);
                plan.granted.push(tag);
            } catch (error) {
                plan.failures.push({ tag, step: 'grant_role', error: error.message });
                continue;   // never strip the overwrite from someone who didn't get the role
            }
        }
        if (plan.overwritesKept.some(k => k.userId === entry.userId)) continue;
        try {
            await channel.permissionOverwrites.delete(entry.member.id, auditReason);
            plan.overwritesRemoved.push(tag);
        } catch (error) {
            plan.failures.push({ tag, step: 'remove_overwrite', error: error.message });
        }
    }

    logger.info(`[ChannelAccess] ${label} → @${role.name} by ${actorTag}: ${plan.granted.length} granted, `
        + `${plan.overwritesRemoved.length} overwrites removed, ${plan.overwritesKept.length} kept, `
        + `${plan.failures.length} failed (role overwrite ${roleHadAccess ? 'already present' : 'created'})`);
    return plan;
}

// ── watcher config ──────────────────────────────────────────────────────────
// Once a channel is converted, the next hand-added per-user grant undoes the tidying. A
// watched channel converts each new grant on the spot: role in, overwrite out.

export async function listWatches(guildId) {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM channel_access_watch WHERE guild_id = ? ORDER BY created_at DESC', [guildId]);
        return rows.map(r => ({ ...r, enabled: !!r.enabled }));
    } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') return [];
        throw error;
    }
}

export async function getWatch(guildId, channelId) {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM channel_access_watch WHERE guild_id = ? AND channel_id = ? AND enabled = 1 LIMIT 1',
            [guildId, channelId]);
        return rows[0] ?? null;
    } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') return null;
        throw error;
    }
}

export async function setWatch({ guildId, channelId, roleId, enabled = true, createdBy = null }) {
    await pool.execute(`
        INSERT INTO channel_access_watch (guild_id, channel_id, role_id, enabled, created_by)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), enabled = VALUES(enabled), created_by = VALUES(created_by)
    `, [guildId, channelId, roleId, enabled ? 1 : 0, createdBy]);
}

export async function removeWatch(guildId, channelId) {
    await pool.execute('DELETE FROM channel_access_watch WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
}

/**
 * A single per-user grant just appeared on a watched channel — give them the role instead.
 *
 * MIN_WHITELIST deliberately does not apply here: the threshold exists to stop someone
 * automating a three-click job, and this is already automated.
 */
export async function convertSingleGrant({ channel, userId, allow, deny }) {
    const watch = await getWatch(channel.guild.id, channel.id);
    if (!watch) return null;

    const role = channel.guild.roles.cache.get(watch.role_id);
    if (!role) {
        logger.warn(`[ChannelAccess] Watch on #${channel.name} points at deleted role ${watch.role_id} — disabling`);
        await pool.execute('UPDATE channel_access_watch SET enabled = 0 WHERE guild_id = ? AND channel_id = ?',
            [channel.guild.id, channel.id]);
        void logFeatureEvent(() => (channel.guild), 'system.featureDisabled', () => ({
            title: '⛔ Feature Auto-Disabled',
            description: `Channel access watch on ${channel} was turned off: the role it hands out was deleted. New per-user grants in that channel are no longer converted to a role until it is set up again with an existing role.`,
            fields: [
                ['Feature', 'Channel access watch'],
                ['Why', 'Its role was deleted'],
                ['Channel', `${channel}`],
                ['Deleted role ID', watch.role_id],
            ],
        }));
        return null;
    }
    if (!role.editable) {
        logger.warn(`[ChannelAccess] Watch on #${channel.name} cannot assign @${role.name} (above the bot)`);
        return null;
    }

    const member = channel.guild.members.cache.get(userId)
        || await channel.guild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot) return null;

    const roleOverwrite = channel.permissionOverwrites.cache.get(role.id);
    const roleAllow = roleOverwrite?.allow.bitfield ?? 0n;
    const roleDeny = roleOverwrite?.deny.bitfield ?? 0n;
    if ((roleAllow & VIEW) !== VIEW) {
        logger.warn(`[ChannelAccess] Watch on #${channel.name}: @${role.name} has no access here — leaving the grant alone`);
        return null;
    }
    // Only unwind a grant the role fully covers, same rule as the bulk conversion.
    if ((allow & ~roleAllow) !== 0n || (deny & ~roleDeny) !== 0n) {
        logger.info(`[ChannelAccess] Watch on #${channel.name}: kept ${member.user.tag}'s overwrite (grants more than @${role.name})`);
        return null;
    }

    const auditReason = reason(`Channel access watch: @${role.name} replaces per-user grant`);
    try {
        if (!member.roles.cache.has(role.id)) await member.roles.add(role, auditReason);
        await channel.permissionOverwrites.delete(userId, auditReason);
        await pool.execute(`
            UPDATE channel_access_watch SET converted_users = converted_users + 1, last_converted_at = CURRENT_TIMESTAMP
            WHERE guild_id = ? AND channel_id = ?`, [channel.guild.id, channel.id]);
        logger.info(`[ChannelAccess] Watch converted ${member.user.tag} on #${channel.name} to @${role.name}`);
        return { userTag: member.user.tag, roleName: role.name };
    } catch (error) {
        logger.error(`[ChannelAccess] Watch conversion failed on #${channel.name} for ${userId}: ${error.message}`);
        return null;
    }
}

/** Human-readable refusal text, shared by the slash command and the dashboard. */
export function explainRefusal(result) {
    switch (result.code) {
        case 'below_threshold':
            return `**${result.label}** has ${result.userCount} whitelisted user${result.userCount === 1 ? '' : 's'}. `
                + `That's not a mess, that's a Tuesday — the tool starts at ${result.minimum}. Do that one by hand.`;
        case 'channel_is_ticket':
            return `**${result.label}** is a ticket channel. Its per-user overwrites *are* the access control — `
                + `converting them would evict the person who opened the ticket.`;
        case 'channel_is_thread':
            return `**${result.label}** is a thread. Threads inherit access from their parent channel — convert the parent instead.`;
        case 'role_is_managed':
            return `**@${result.roleName}** is managed by an integration, so Discord won't let anyone assign it. Pick a normal role.`;
        case 'role_above_bot':
            return `**@${result.roleName}** sits above my highest role, so I can't hand it out. Move my role above it and retry.`;
        case 'role_is_everyone':
            return `That's @everyone. Granting @everyone access is just making the channel public — do that in channel settings.`;
        case 'role_wrong_guild':
            return `That role isn't from this server.`;
        case 'cannot_manage_channel':
            return `I don't have Manage Roles in **${result.label}**, so I can't edit its permissions.`;
        case 'role_grant_failed':
            return `Couldn't give **@${result.roleName}** access to **${result.label}**: ${result.error}`;
        default:
            return `Couldn't convert that channel (${result.code}).`;
    }
}

/** The "nice job" summary. Same words on both surfaces. */
export function summarize(plan) {
    const lines = [];
    const verb = plan.dryRun ? 'would get' : 'now has';
    lines.push(plan.roleHadAccess
        ? `**@${plan.roleName}** already had access to **${plan.label}**.`
        : `**@${plan.roleName}** ${verb} access to **${plan.label}**${plan.roleGrantAdded.length ? ` (${plan.roleGrantAdded.join(', ')})` : ''}.`);

    if (plan.granted.length) lines.push(`${plan.dryRun ? 'Would grant' : 'Granted'} the role to **${plan.granted.length}** member${plan.granted.length === 1 ? '' : 's'}: ${plan.granted.join(', ')}`);
    if (plan.alreadyHadRole.length) lines.push(`${plan.alreadyHadRole.length} already had the role.`);
    if (plan.overwritesRemoved.length) lines.push(`${plan.dryRun ? 'Would clear' : 'Cleared'} **${plan.overwritesRemoved.length}** per-user overwrite${plan.overwritesRemoved.length === 1 ? '' : 's'}.`);
    if (plan.overwritesKept.length) {
        lines.push(`Kept ${plan.overwritesKept.length} overwrite${plan.overwritesKept.length === 1 ? '' : 's'} that grant more than the role does — `
            + `removing them would have changed access: ${plan.overwritesKept.map(k => `${k.tag} (${[...k.extraAllow, ...k.extraDeny.map(d => `-${d}`)].join(', ')})`).join('; ')}`);
    }
    if (plan.staleCount) lines.push(`${plan.staleCount} overwrite${plan.staleCount === 1 ? '' : 's'} belong to users who left — left alone as cruft to review.`);
    if (plan.botCount) lines.push(`${plan.botCount} bot overwrite${plan.botCount === 1 ? '' : 's'} skipped.`);
    if (plan.failures.length) lines.push(`⚠️ ${plan.failures.length} failed: ${plan.failures.map(f => `${f.tag} (${f.step})`).join(', ')}`);

    if (!plan.dryRun) {
        lines.push('');
        lines.push(`Nicely done — that channel's access list is now one role instead of ${plan.userCount} hand-placed exceptions. `
            + `Adding somebody next time is one role assignment, and you can finally answer "who can see this?" by looking at the role.`);
    }
    return lines.join('\n');
}

export default {
    MIN_WHITELIST,
    readWhitelist,
    scanGuild,
    convertWhitelistToRole,
    convertSingleGrant,
    listWatches,
    getWatch,
    setWatch,
    removeWatch,
    explainRefusal,
    summarize,
};
