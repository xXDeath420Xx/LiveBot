/*
 * Channel lock / unlock that puts things back the way they were.
 *
 * `/admin mod lock` used to set @everyone Send Messages to deny and `unlock` to neutral, which
 * quietly changed channels that had an explicit allow (an announcements channel opened to everyone,
 * say) or that had no @everyone overwrite at all. Now the lock records the previous state in
 * `lockdowns.original_perms` (one row per channel, UNIQUE guild_id+channel_id) BEFORE changing
 * anything, and unlock restores exactly that state and deletes the row. With no row (a channel
 * locked before this existed, or by hand) unlock behaves as it always did: neutral.
 *
 * Both actions go to the mod log channel and to audit_logs.
 */
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { saveAuditLog } from './log-manager.js';
import { postModNote } from './mod-log-notes.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import {
    describeSendState, serialiseLockState, parseLockState, restoreValueFor, shouldDeleteOverwrite,
    describeStateForHumans,
} from './lockdown-state.js';

function everyoneOverwrite(channel) {
    return channel.permissionOverwrites.cache.get(channel.guild.id) || null;
}

export function currentSendState(channel) {
    const ow = everyoneOverwrite(channel);
    return describeSendState(ow ? ow.allow.bitfield : null, ow ? ow.deny.bitfield : null, PermissionFlagsBits.SendMessages);
}

export async function getLockdown(guildId, channelId) {
    const [rows] = await pool.execute(
        'SELECT id, locked_by, reason, locked_at, original_perms FROM lockdowns WHERE guild_id = ? AND channel_id = ?',
        [guildId, channelId]
    );
    return rows[0] || null;
}

/**
 * @returns {Promise<{status:'locked'|'already_locked'|'already_denied', previous?:object, row?:object}>}
 */
export async function lockChannel(channel, moderator, reason) {
    const guild = channel.guild;
    const current = currentSendState(channel);
    const existing = await getLockdown(guild.id, channel.id);

    if (existing && current.send_messages === 'deny') return { status: 'already_locked', row: existing };
    if (!existing && current.send_messages === 'deny') return { status: 'already_denied', previous: current };
    // An existing row with the channel no longer denied means it was reopened by hand since; the
    // state it is in now is the one to come back to.

    await pool.execute(
        `INSERT INTO lockdowns (guild_id, channel_id, locked_by, reason, original_perms)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE locked_by = VALUES(locked_by), reason = VALUES(reason),
                                 original_perms = VALUES(original_perms), locked_at = CURRENT_TIMESTAMP`,
        [guild.id, channel.id, moderator.id, reason || null, serialiseLockState(current)]
    );

    try {
        await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, {
            reason: `Locked by ${moderator.tag}: ${reason || 'no reason'}`.slice(0, 512),
        });
    } catch (err) {
        // Nothing changed on Discord, so nothing to restore later.
        await pool.execute('DELETE FROM lockdowns WHERE guild_id = ? AND channel_id = ?', [guild.id, channel.id])
            .catch(e => logger.error('[Lockdown] Could not remove the record of a failed lock', { channelId: channel.id, error: e.message }));
        throw err;
    }

    await saveAuditLog(guild.id, 'CHANNEL_LOCK', null, channel.id, moderator.id, channel.id,
        'Channel locked', reason || null, describeStateForHumans(current), 'Send Messages denied for @everyone', { previous: current });
    const modLogChannelId = await postModNote(guild, {
        kind: 'lock',
        title: 'Channel Locked',
        fields: [
            { name: 'Channel', value: `<#${channel.id}> (${channel.name})`, inline: true },
            { name: 'Moderator', value: `${moderator.tag} (${moderator.id})`, inline: true },
            { name: 'Reason', value: reason || 'No reason provided.' },
            { name: '@everyone Send Messages before', value: describeStateForHumans(current) },
        ],
    });
    void logFeatureEvent(() => (guild), 'moderation.lock', () => ({
        title: '🔒 Channel Locked',
        fields: [
            ['Channel', `<#${channel.id}>`],
            ['Moderator', userLabel(moderator)],
            ['@everyone Send Messages before', describeStateForHumans(current)],
            ['Reason', reason || 'No reason given', false],
        ],
        avoidChannelIds: [modLogChannelId],
    }));
    return { status: 'locked', previous: current };
}

/**
 * @returns {Promise<{restored:object|null, hadRecord:boolean}>}
 */
export async function unlockChannel(channel, moderator) {
    const guild = channel.guild;
    const row = await getLockdown(guild.id, channel.id);
    const state = row ? parseLockState(row.original_perms) : null;
    if (row && !state) {
        logger.warn('[Lockdown] Unreadable original_perms; unlocking to neutral', { guildId: guild.id, channelId: channel.id, lockdownId: row.id });
    }

    const auditReason = `Unlocked by ${moderator.tag}`;
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: restoreValueFor(state) }, { reason: auditReason });

    if (state) {
        const ow = everyoneOverwrite(channel);
        if (ow && shouldDeleteOverwrite(state, ow.allow.bitfield, ow.deny.bitfield)) {
            await ow.delete(auditReason).catch(err =>
                logger.warn('[Lockdown] Could not remove the now-empty @everyone overwrite', { channelId: channel.id, error: err.message }));
        }
    }
    if (row) await pool.execute('DELETE FROM lockdowns WHERE id = ?', [row.id]);

    const restoredText = state ? describeStateForHumans(state) : 'not set (no lock record — default unlock)';
    await saveAuditLog(guild.id, 'CHANNEL_UNLOCK', null, channel.id, moderator.id, channel.id,
        'Channel unlocked', null, 'Send Messages denied for @everyone', restoredText, { restored: state, lockedBy: row?.locked_by || null });
    const modLogChannelId = await postModNote(guild, {
        kind: 'unlock',
        title: 'Channel Unlocked',
        fields: [
            { name: 'Channel', value: `<#${channel.id}> (${channel.name})`, inline: true },
            { name: 'Moderator', value: `${moderator.tag} (${moderator.id})`, inline: true },
            { name: '@everyone Send Messages restored to', value: restoredText },
            ...(row ? [{ name: 'Locked', value: `by <@${row.locked_by}> <t:${Math.floor(new Date(row.locked_at).getTime() / 1000)}:R>${row.reason ? ` — ${row.reason}` : ''}` }] : []),
        ],
    });
    void logFeatureEvent(() => (guild), 'moderation.unlock', () => ({
        title: '🔓 Channel Unlocked',
        fields: [
            ['Channel', `<#${channel.id}>`],
            ['Moderator', userLabel(moderator)],
            ['@everyone Send Messages restored to', restoredText],
            ['Locked by', row ? userLabel(row.locked_by) : null],
            ['Locked', row ? `<t:${Math.floor(new Date(row.locked_at).getTime() / 1000)}:R>` : null],
            ['Lock reason', row?.reason || null, false],
        ],
        avoidChannelIds: [modLogChannelId],
    }));
    return { restored: state, hadRecord: !!row };
}

/** Hourly: drop lock records of channels that no longer exist. */
export async function pruneStaleLockdowns() {
    const manager = global.botManager;
    if (!manager?.getClientForGuild) return 0;
    const [rows] = await pool.execute('SELECT id, guild_id, channel_id FROM lockdowns');
    let removed = 0;
    for (const r of rows) {
        const client = manager.getClientForGuild(r.guild_id);
        const guild = client?.isReady() ? client.guilds.cache.get(r.guild_id) : null;
        if (!guild || guild.channels.cache.has(r.channel_id)) continue;
        await pool.execute('DELETE FROM lockdowns WHERE id = ?', [r.id]);
        removed++;
    }
    if (removed) logger.info('[Lockdown] Removed lock records for deleted channels', { removed });
    return removed;
}

export default { lockChannel, unlockChannel, getLockdown, currentSendState, pruneStaleLockdowns };
