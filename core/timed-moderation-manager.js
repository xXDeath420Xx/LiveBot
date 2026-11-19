/*
 * Temporary bans (timed_moderation, action_type 'ban') and temporary roles (temp_roles).
 *
 * Both are written by `/admin mod ban duration:` and `/admin mod temprole`, and undone by
 * jobs/timed-moderation-job.js, which reads only rows that are due — expiry survives restarts
 * because the deadline lives in the database, not in a timer.
 *
 * Temporary bans are tagged in the Discord ban reason with `[tempban #<row id>]`. When the timer
 * runs out the job looks at the ban that is actually on the user: if it no longer carries this
 * row's tag (someone unbanned and re-banned them, possibly permanently, by hand or another command),
 * the ban is left alone. A timer can only ever undo the ban it placed.
 *
 * Failures (missing permissions, Discord outage) are retried with backoff — 1, 2, 4 … minutes,
 * MAX_ATTEMPTS times — and a give-up is posted to the mod log. Missing members, deleted roles and
 * bans already lifted are not failures: the row is simply closed with a note in last_error.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logInfraction } from './moderation-manager.js';
import { postModNote } from './mod-log-notes.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { forgetRole } from './sticky-roles-manager.js';
import { MAX_ATTEMPTS, backoffMinutes, banCarriesMarker, errorText, tempBanMarker } from './timed-moderation-logic.js';

function resolveGuild(guildId) {
    const client = global.botManager?.getClientForGuild?.(guildId);
    const guild = client?.guilds?.cache?.get(guildId);
    return guild && client.isReady() ? { client, guild } : null;
}

// ── Temporary bans ───────────────────────────────────────────────────────────────────────────

/** Record a pending temporary ban; returns the row id (used in the ban reason). */
export async function createTempBanRow({ guildId, userId, moderatorId, reason, seconds }) {
    const [res] = await pool.execute(
        `INSERT INTO timed_moderation (guild_id, user_id, moderator_id, action_type, expires_at, reason)
         VALUES (?, ?, ?, 'ban', DATE_ADD(NOW(), INTERVAL ? SECOND), ?)`,
        [guildId, userId, moderatorId, Math.floor(seconds), reason || null]
    );
    return res.insertId;
}

/** Close a row without acting on it (ban failed to apply, replaced, cancelled …). */
export async function closeTempBanRow(id, note) {
    await pool.execute(
        `UPDATE timed_moderation SET executed = 1, executed_at = NOW(), last_error = ?
          WHERE id = ? AND executed = 0`,
        [note ? String(note).slice(0, 255) : null, id]
    );
}

/**
 * Stop every pending temporary-ban timer for a user — they were unbanned by hand, or banned again
 * (a new ban supersedes the old timer). Returns how many were cancelled.
 */
export async function cancelPendingBans(guildId, userId, note) {
    const [res] = await pool.execute(
        `UPDATE timed_moderation SET executed = 1, executed_at = NOW(), last_error = ?
          WHERE guild_id = ? AND user_id = ? AND action_type = 'ban' AND executed = 0`,
        [String(note || 'cancelled').slice(0, 255), guildId, userId]
    );
    return res.affectedRows || 0;
}

/**
 * The pending temporary-ban row whose tag is on the user's current ban, if any — i.e. the timer
 * that would lift the ban that is actually in place.
 */
export async function findTimerForBan(guildId, userId, banReason) {
    const [rows] = await pool.execute(
        `SELECT id, expires_at FROM timed_moderation
          WHERE guild_id = ? AND user_id = ? AND action_type = 'ban' AND executed = 0
          ORDER BY id DESC`,
        [guildId, userId]
    );
    return rows.find(r => banCarriesMarker(banReason, r.id)) || null;
}

/** Give a running temporary ban a new end time (counted from now). */
export async function rescheduleTempBan(id, seconds, moderatorId, reason) {
    await pool.execute(
        `UPDATE timed_moderation
            SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND), moderator_id = ?, reason = COALESCE(?, reason),
                attempts = 0, last_attempt_at = NULL, last_error = NULL
          WHERE id = ? AND executed = 0`,
        [Math.floor(seconds), moderatorId, reason || null, id]
    );
}

async function recordBanFailure(row, err) {
    const attempts = Number(row.attempts) + 1;
    await pool.execute(
        `UPDATE timed_moderation SET attempts = attempts + 1, last_attempt_at = NOW(), last_error = ?
          WHERE id = ? AND executed = 0`,
        [errorText(err), row.id]
    );
    logger.warn('[TimedModeration] Lifting a temporary ban failed', { rowId: row.id, guildId: row.guild_id, attempts, error: err?.message });
    if (attempts >= MAX_ATTEMPTS) {
        const ctx = resolveGuild(row.guild_id);
        if (ctx) {
            const modLogChannelId = await postModNote(ctx.guild, {
                kind: 'warning',
                title: 'Temporary ban could not be lifted',
                description: `The temporary ban on <@${row.user_id}> (${row.user_id}) ran out, but I could not unban them after ${attempts} attempts. Please unban them by hand.`,
                fields: [{ name: 'Last error', value: errorText(err) }],
            });
            void logFeatureEvent(() => (ctx.guild), 'moderation.timerFailed', () => ({
                title: '⚠️ Timed Action Failed',
                description: 'A temporary ban ran out but could not be lifted. Please unban them by hand.',
                fields: [
                    ['Member', userLabel(row.user_id)],
                    ['Action', 'Lift temporary ban'],
                    ['Attempts', String(attempts)],
                    ['Last error', errorText(err), false],
                ],
                avoidChannelIds: [modLogChannelId],
            }));
        }
    }
}

/** Is this row's backoff over? (`since` = minutes since the last attempt, NULL if none.) */
function readyForAttempt(row) {
    if (row.since_attempt === null || row.since_attempt === undefined) return true;
    return Number(row.since_attempt) >= backoffMinutes(Number(row.attempts) - 1);
}

export async function processDueBans() {
    const [rows] = await pool.execute(
        `SELECT id, guild_id, user_id, moderator_id, reason, attempts,
                TIMESTAMPDIFF(MINUTE, last_attempt_at, NOW()) AS since_attempt
           FROM timed_moderation
          WHERE action_type = 'ban' AND executed = 0 AND expires_at <= NOW() AND attempts < ?
          ORDER BY expires_at ASC
          LIMIT 50`,
        [MAX_ATTEMPTS]
    );
    let lifted = 0;
    for (const row of rows) {
        if (!readyForAttempt(row)) continue;
        const ctx = resolveGuild(row.guild_id);
        if (!ctx) {
            await recordBanFailure(row, new Error('Server not available to the bot'));
            continue;
        }
        const { client, guild } = ctx;
        try {
            let ban = null;
            try {
                ban = await guild.bans.fetch({ user: row.user_id, force: true });
            } catch (err) {
                if (err.code !== 10026) throw err; // 10026 Unknown Ban → already lifted
            }
            if (!ban) {
                await closeTempBanRow(row.id, 'already unbanned');
                await deactivateBanInfraction(row);
                continue;
            }
            if (!banCarriesMarker(ban.reason, row.id)) {
                await closeTempBanRow(row.id, 'ban was replaced; left in place');
                await postModNote(guild, {
                    kind: 'warning',
                    title: 'Temporary ban timer ended — ban left in place',
                    description: `The temporary ban on <@${row.user_id}> (${row.user_id}) expired, but the ban on them now is a different one (it was re-applied since), so it was not lifted.`,
                });
                continue;
            }

            await guild.members.unban(row.user_id, `Temporary ban expired ${tempBanMarker(row.id)}`);
            await closeTempBanRow(row.id, null);
            await deactivateBanInfraction(row);
            lifted++;

            const user = ban.user ?? await client.users.fetch(row.user_id).catch(() => ({ id: row.user_id, tag: row.user_id }));
            // Stand-in interaction, the same shape automod uses: the bot is the moderator.
            await logInfraction({ guild, user: client.user, client }, user, 'Unban', `Temporary ban expired (set by <@${row.moderator_id}>)`);
        } catch (err) {
            await recordBanFailure(row, err);
        }
    }
    return lifted;
}

async function deactivateBanInfraction(row) {
    try {
        await pool.execute(
            `UPDATE infractions SET is_active = 0
              WHERE guild_id = ? AND user_id = ? AND type = 'Ban' AND is_active = 1
                AND expires_at IS NOT NULL AND expires_at <= NOW()`,
            [row.guild_id, row.user_id]
        );
    } catch (err) {
        logger.error('[TimedModeration] Could not mark the ban infraction inactive', { rowId: row.id, error: err.message });
    }
}

// ── Temporary roles ──────────────────────────────────────────────────────────────────────────

export async function getActiveTempRole(guildId, userId, roleId) {
    const [rows] = await pool.execute(
        `SELECT id, expires_at FROM temp_roles
          WHERE guild_id = ? AND user_id = ? AND role_id = ? AND auto_removed = 0
          ORDER BY id DESC LIMIT 1`,
        [guildId, userId, roleId]
    );
    return rows[0] || null;
}

/**
 * Give `role` to `member` for `seconds`. If they already hold it on a timer, the timer is reset
 * to the new length. Refuses when they hold it permanently — the timer would take away a role
 * nobody meant to be temporary.
 * @returns {Promise<{ok:true, extended:boolean} | {ok:false, error:string}>}
 */
export async function grantTempRole({ member, role, moderator, seconds, reason }) {
    const guildId = member.guild.id;
    const active = await getActiveTempRole(guildId, member.id, role.id);
    if (!active && member.roles.cache.has(role.id)) {
        return { ok: false, error: `${member.user.tag} already has ${role.name} permanently. Remove it first if it should be temporary.` };
    }

    let rowId = active?.id ?? null;
    if (active) {
        await pool.execute(
            `UPDATE temp_roles SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND), assigned_by = ?, reason = ?,
                    attempts = 0, last_attempt_at = NULL, last_error = NULL
              WHERE id = ?`,
            [Math.floor(seconds), moderator.id, reason || null, active.id]
        );
    } else {
        // Row first: a crash between the two never leaves an untracked "temporary" role.
        const [res] = await pool.execute(
            `INSERT INTO temp_roles (guild_id, user_id, role_id, assigned_by, expires_at, reason)
             VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?)`,
            [guildId, member.id, role.id, moderator.id, Math.floor(seconds), reason || null]
        );
        rowId = res.insertId;
    }

    if (!member.roles.cache.has(role.id)) {
        try {
            await member.roles.add(role, `Temporary role from ${moderator.tag}${reason ? `: ${reason}` : ''}`.slice(0, 512));
        } catch (err) {
            if (!active) await closeTempRoleRow(rowId, `could not add role: ${errorText(err)}`);
            throw err;
        }
    }
    return { ok: true, extended: !!active };
}

/** Stop the timer but leave the role where it is. */
export async function cancelTempRole(guildId, userId, roleId, note) {
    const [res] = await pool.execute(
        `UPDATE temp_roles SET auto_removed = 1, removed_at = NOW(), last_error = ?
          WHERE guild_id = ? AND user_id = ? AND role_id = ? AND auto_removed = 0`,
        [String(note || 'timer cancelled').slice(0, 255), guildId, userId, roleId]
    );
    return res.affectedRows || 0;
}

async function closeTempRoleRow(id, note) {
    await pool.execute(
        `UPDATE temp_roles SET auto_removed = 1, removed_at = NOW(), last_error = ?
          WHERE id = ? AND auto_removed = 0`,
        [note ? String(note).slice(0, 255) : null, id]
    );
}

async function recordRoleFailure(row, err) {
    const attempts = Number(row.attempts) + 1;
    await pool.execute(
        `UPDATE temp_roles SET attempts = attempts + 1, last_attempt_at = NOW(), last_error = ?
          WHERE id = ? AND auto_removed = 0`,
        [errorText(err), row.id]
    );
    logger.warn('[TimedModeration] Removing a temporary role failed', { rowId: row.id, guildId: row.guild_id, attempts, error: err?.message });
    if (attempts >= MAX_ATTEMPTS) {
        const ctx = resolveGuild(row.guild_id);
        if (ctx) {
            const modLogChannelId = await postModNote(ctx.guild, {
                kind: 'warning',
                title: 'Temporary role could not be removed',
                description: `<@&${row.role_id}> should have been taken from <@${row.user_id}> but removing it failed ${attempts} times. Please remove it by hand.`,
                fields: [{ name: 'Last error', value: errorText(err) }],
            });
            void logFeatureEvent(() => (ctx.guild), 'moderation.timerFailed', () => ({
                title: '⚠️ Timed Action Failed',
                description: 'A temporary role ran out but could not be removed. Please remove it by hand.',
                fields: [
                    ['Member', userLabel(row.user_id)],
                    ['Action', 'Remove temporary role'],
                    ['Role', `<@&${row.role_id}>`],
                    ['Attempts', String(attempts)],
                    ['Last error', errorText(err), false],
                ],
                avoidChannelIds: [modLogChannelId],
            }));
        }
    }
}

export async function processDueRoles() {
    const [rows] = await pool.execute(
        `SELECT id, guild_id, user_id, role_id, assigned_by, attempts,
                TIMESTAMPDIFF(MINUTE, last_attempt_at, NOW()) AS since_attempt
           FROM temp_roles
          WHERE auto_removed = 0 AND expires_at <= NOW() AND attempts < ?
          ORDER BY expires_at ASC
          LIMIT 100`,
        [MAX_ATTEMPTS]
    );
    let removed = 0;
    for (const row of rows) {
        if (!readyForAttempt(row)) continue;
        const ctx = resolveGuild(row.guild_id);
        if (!ctx) {
            await recordRoleFailure(row, new Error('Server not available to the bot'));
            continue;
        }
        const { guild } = ctx;
        try {
            const role = guild.roles.cache.get(row.role_id);
            if (!role) {
                await closeTempRoleRow(row.id, 'role was deleted');
                continue;
            }
            let member = null;
            try {
                member = await guild.members.fetch(row.user_id);
            } catch (err) {
                if (err.code !== 10007 && err.code !== 10013) throw err; // Unknown Member / Unknown User
            }
            if (!member) {
                // They left. Make sure sticky roles does not hand the expired role back on rejoin.
                await forgetRole(row.guild_id, row.user_id, row.role_id);
                await closeTempRoleRow(row.id, 'member not in server');
                continue;
            }
            if (!member.roles.cache.has(role.id)) {
                await closeTempRoleRow(row.id, 'role already removed');
                continue;
            }
            await member.roles.remove(role, 'Temporary role expired');
            await closeTempRoleRow(row.id, null);
            removed++;
            const modLogChannelId = await postModNote(guild, {
                kind: 'role_remove',
                title: 'Temporary role expired',
                fields: [
                    { name: 'Member', value: `${member.user.tag} (${member.id})`, inline: true },
                    { name: 'Role', value: `${role.name} (${role.id})`, inline: true },
                    { name: 'Given by', value: row.assigned_by ? `<@${row.assigned_by}>` : 'unknown', inline: true },
                ],
            });
            void logFeatureEvent(() => (guild), 'moderation.tempRoleEnded', () => ({
                title: '⌛ Temporary Role Removed',
                fields: [
                    ['Member', userLabel(member)],
                    ['Role', `<@&${role.id}>`],
                    ['Given by', row.assigned_by ? userLabel(row.assigned_by) : null],
                    ['How', 'Expired'],
                ],
                avoidChannelIds: [modLogChannelId],
            }));
        } catch (err) {
            await recordRoleFailure(row, err);
        }
    }
    return removed;
}

export default {
    createTempBanRow, closeTempBanRow, cancelPendingBans, findTimerForBan, rescheduleTempBan, processDueBans,
    grantTempRole, cancelTempRole, getActiveTempRole, processDueRoles,
};
