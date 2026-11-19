/*
 * Sticky roles: a member who leaves and comes back gets their roles back.
 *
 *   on leave  (events/guildMemberRemove.js) — save their roles to role_persistence with left_at
 *   on rejoin (events/guildMemberAdd.js)    — if they left within the retention window, give back
 *                                             every saved role the bot may hand out, delete the row,
 *                                             and post a 'sticky-roles' log event
 *   expiry    (jobs/timed-moderation-job.js, hourly) — purgeExpired()
 *
 * Per-guild settings live on `guilds` (migration 281), edited from the dashboard's Sticky Roles card:
 *   sticky_roles_enabled          the on/off switch (already existed; off by default)
 *   sticky_roles_retention_days   how long a departed member's roles are remembered (default 30)
 *   sticky_roles_exclude          JSON array of role ids never restored (and never saved)
 *
 * Never restored: @everyone, managed roles (boosts, bot and integration roles — Discord assigns
 * those), roles at or above the bot's highest role, and the exclude list. A member's roles are
 * known at departure only if discord.js has them cached; for an uncached member the latest
 * snapshot (snapshotMember, fed by guildMemberUpdate) is used instead, when one exists.
 *
 * Because a quarantined or muted member leaves holding only the quarantine/muted role, rejoining
 * does not shed it — sticky roles close that evasion route rather than opening one.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { sendLogEmbed } from './log-manager.js';
import { themeColor } from './guild-theme.js';
import {
    retentionDays, parseRoleIdList, rolesToSave, partitionRestorable, describeSkipped, DEFAULT_RETENTION_DAYS,
} from './sticky-roles-logic.js';

export async function getStickySettings(guildId) {
    const [rows] = await pool.execute(
        `SELECT sticky_roles_enabled, sticky_roles_exclude, sticky_roles_retention_days
           FROM guilds WHERE guild_id = ?`,
        [guildId]
    );
    const r = rows[0];
    if (!r) return { enabled: false, exclude: [], days: DEFAULT_RETENTION_DAYS };
    return {
        enabled: Number(r.sticky_roles_enabled) === 1,
        exclude: parseRoleIdList(r.sticky_roles_exclude),
        days: retentionDays(r.sticky_roles_retention_days),
    };
}

function roleShapes(member) {
    return [...member.roles.cache.values()].map(r => ({ id: r.id, managed: r.managed }));
}

/** guildMemberRemove: remember the roles of a departing member. */
export async function saveOnLeave(member) {
    if (!member?.guild || member.user?.bot) return;
    const guildId = member.guild.id;
    try {
        const settings = await getStickySettings(guildId);
        if (!settings.enabled) return;

        if (member.partial || !member.roles?.cache?.size) {
            // Not cached, so discord.js cannot tell us their roles. Fall back to the snapshot kept by
            // snapshotMember(), if there is one.
            const [res] = await pool.execute(
                'UPDATE role_persistence SET left_at = NOW() WHERE guild_id = ? AND user_id = ? AND left_at IS NULL',
                [guildId, member.id]
            );
            if (!res.affectedRows) {
                logger.info('[StickyRoles] Member left uncached and with no snapshot — their roles are unknown', { guildId, userId: member.id });
            }
            return;
        }

        const ids = rolesToSave(roleShapes(member), guildId, settings.exclude);
        if (!ids.length) {
            // Nothing to give back; drop any older record so a stale role set is never restored.
            await pool.execute('DELETE FROM role_persistence WHERE guild_id = ? AND user_id = ?', [guildId, member.id]);
            return;
        }
        await pool.execute(
            `INSERT INTO role_persistence (guild_id, user_id, role_ids, left_at)
             VALUES (?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE role_ids = VALUES(role_ids), left_at = VALUES(left_at)`,
            [guildId, member.id, JSON.stringify(ids)]
        );
        logger.debug('[StickyRoles] Saved roles on leave', { guildId, userId: member.id, count: ids.length });
    } catch (err) {
        logger.error('[StickyRoles] Could not save roles on leave', { guildId, userId: member.id, error: err.message });
    }
}

/**
 * guildMemberAdd: give back the roles saved when they left, if within the retention window.
 * Returns { restored: string[], skipped } or null when there was nothing to do.
 */
export async function restoreOnJoin(member) {
    if (!member?.guild || member.user?.bot) return null;
    const guild = member.guild;
    try {
        const settings = await getStickySettings(guild.id);
        if (!settings.enabled) return null;

        const [rows] = await pool.execute(
            `SELECT id, role_ids, left_at FROM role_persistence
              WHERE guild_id = ? AND user_id = ? AND left_at IS NOT NULL
                AND left_at >= NOW() - INTERVAL ? DAY
              LIMIT 1`,
            [guild.id, member.id, settings.days]
        );
        const row = rows[0];
        if (!row) return null;

        const saved = parseRoleIdList(row.role_ids);
        const roles = new Map(guild.roles.cache.map(r => [r.id, { id: r.id, managed: r.managed, editable: r.editable }]));
        const { restore, skipped } = partitionRestorable(saved, {
            guildId: guild.id,
            roles,
            memberRoleIds: new Set(member.roles.cache.keys()),
            excludeIds: settings.exclude,
        });

        if (restore.length) {
            try {
                await member.roles.add(restore, 'Sticky roles: giving back the roles they had before leaving');
            } catch (err) {
                // Keep the row: a missing permission fixed later, or a rejoin after a failed join, can
                // still restore within the window.
                logger.error('[StickyRoles] Restoring roles failed', { guildId: guild.id, userId: member.id, code: err.code, error: err.message });
                await postLog(guild, member, [], skipped, `Could not restore ${restore.length} role(s): ${err.message}`);
                return { restored: [], skipped, error: err.message };
            }
        }

        await pool.execute('DELETE FROM role_persistence WHERE id = ?', [row.id]);
        await postLog(guild, member, restore, skipped, null, row.left_at);
        logger.info('[StickyRoles] Restored roles on rejoin', { guildId: guild.id, userId: member.id, restored: restore.length });
        return { restored: restore, skipped };
    } catch (err) {
        logger.error('[StickyRoles] Restore on join failed', { guildId: guild.id, userId: member.id, error: err.message });
        return null;
    }
}

async function postLog(guild, member, restored, skipped, failure = null, leftAt = null) {
    const skippedText = describeSkipped(skipped);
    if (!restored.length && !skippedText && !failure) return;
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, failure ? 'danger' : 'primary'))
        .setTitle(failure ? '📌 Sticky Roles: restore failed' : '📌 Sticky Roles Restored')
        .setDescription(`${member.user.tag} (<@${member.id}>) rejoined${leftAt ? `, having left <t:${Math.floor(new Date(leftAt).getTime() / 1000)}:R>` : ''}.`)
        .addFields({
            name: `Restored (${restored.length})`,
            value: restored.length ? restored.map(id => `<@&${id}>`).join(' ').slice(0, 1024) : 'none',
        })
        .setFooter({ text: `User ID ${member.id}` })
        .setTimestamp();
    if (skippedText) embed.addFields({ name: 'Not restored', value: skippedText.slice(0, 1024) });
    if (failure) embed.addFields({ name: 'Error', value: String(failure).slice(0, 1024) });
    await sendLogEmbed(guild, 'sticky-roles', embed, failure ? 'sticky-roles.failed' : 'sticky-roles.restored');
}

/**
 * guildMemberUpdate (optional integration): keep a current snapshot of a member's roles, so a
 * departure the cache missed still has something to restore. Only acts on role changes.
 */
export async function snapshotMember(newMember, oldMember = null) {
    if (!newMember?.guild || newMember.user?.bot || newMember.partial) return;
    if (oldMember && !oldMember.partial) {
        const before = new Set(oldMember.roles.cache.keys());
        const after = newMember.roles.cache;
        if (before.size === after.size && [...after.keys()].every(id => before.has(id))) return;
    }
    const guildId = newMember.guild.id;
    try {
        const settings = await getStickySettings(guildId);
        if (!settings.enabled) return;
        const ids = rolesToSave(roleShapes(newMember), guildId, settings.exclude);
        if (!ids.length) {
            await pool.execute('DELETE FROM role_persistence WHERE guild_id = ? AND user_id = ? AND left_at IS NULL', [guildId, newMember.id]);
            return;
        }
        await pool.execute(
            `INSERT INTO role_persistence (guild_id, user_id, role_ids, left_at)
             VALUES (?, ?, ?, NULL)
             ON DUPLICATE KEY UPDATE role_ids = VALUES(role_ids), left_at = NULL`,
            [guildId, newMember.id, JSON.stringify(ids)]
        );
    } catch (err) {
        logger.error('[StickyRoles] Snapshot failed', { guildId, userId: newMember.id, error: err.message });
    }
}

/**
 * A temporary role ran out while the member was away: make sure a rejoin does not hand it back.
 * Called by core/timed-moderation-manager.js.
 */
export async function forgetRole(guildId, userId, roleId) {
    try {
        const [rows] = await pool.execute(
            'SELECT id, role_ids FROM role_persistence WHERE guild_id = ? AND user_id = ?',
            [guildId, userId]
        );
        if (!rows[0]) return;
        const remaining = parseRoleIdList(rows[0].role_ids).filter(id => id !== roleId);
        if (remaining.length) {
            await pool.execute('UPDATE role_persistence SET role_ids = ? WHERE id = ?', [JSON.stringify(remaining), rows[0].id]);
        } else {
            await pool.execute('DELETE FROM role_persistence WHERE id = ?', [rows[0].id]);
        }
    } catch (err) {
        logger.error('[StickyRoles] Could not drop an expired temporary role from saved roles', { guildId, userId, roleId, error: err.message });
    }
}

/**
 * Expiry (hourly):
 *   - departed members' rows older than their guild's retention window;
 *   - snapshots of members of guilds that have sticky roles off, or that the bot has left, after 30 days.
 */
export async function purgeExpired() {
    let removed = 0;
    try {
        const [a] = await pool.execute(
            `DELETE rp FROM role_persistence rp
               LEFT JOIN guilds g ON g.guild_id = rp.guild_id
              WHERE rp.left_at IS NOT NULL
                AND rp.left_at < NOW() - INTERVAL LEAST(GREATEST(COALESCE(g.sticky_roles_retention_days, ${DEFAULT_RETENTION_DAYS}), 1), 365) DAY`
        );
        const [b] = await pool.execute(
            `DELETE rp FROM role_persistence rp
               LEFT JOIN guilds g ON g.guild_id = rp.guild_id
              WHERE rp.left_at IS NULL
                AND (g.guild_id IS NULL OR g.sticky_roles_enabled = 0 OR g.left_at IS NOT NULL)
                AND rp.last_updated < NOW() - INTERVAL 30 DAY`
        );
        removed = (a.affectedRows || 0) + (b.affectedRows || 0);
        if (removed) logger.info('[StickyRoles] Expired saved role sets removed', { removed });
    } catch (err) {
        logger.error('[StickyRoles] Expiry sweep failed', { error: err.message });
    }
    return removed;
}

export default { saveOnLeave, restoreOnJoin, snapshotMember, forgetRole, purgeExpired, getStickySettings };
