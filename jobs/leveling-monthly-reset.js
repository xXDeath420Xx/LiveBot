import cron from 'node-cron';
import { PermissionFlagsBits } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

let task = null;

// Who counts as staff for the reset: the owner plus anyone holding one of these permissions.
// Used for the stream-sub pause exemption always, and for the XP wipe + role strip when the
// guild has level_config.reset_exempt_staff = 1 (migration 412).
const STAFF_PERMS = (
    PermissionFlagsBits.Administrator |
    PermissionFlagsBits.ManageGuild   |
    PermissionFlagsBits.KickMembers   |
    PermissionFlagsBits.BanMembers    |
    PermissionFlagsBits.ModerateMembers
);

function collectStaffIds(guild, members) {
    const staff = new Set();
    if (guild.ownerId) staff.add(String(guild.ownerId));
    for (const m of members.values()) {
        try {
            if (m.permissions && m.permissions.bitfield != null) {
                // discord.js PermissionsBitField.bitfield is a BigInt; mix with BigInt.
                const bits = typeof m.permissions.bitfield === 'bigint'
                    ? m.permissions.bitfield
                    : BigInt(m.permissions.bitfield);
                if ((bits & STAFF_PERMS) !== 0n) staff.add(String(m.id));
            }
        } catch { /* ignore permission read errors — treated as not staff */ }
    }
    return staff;
}

// Opt-in via level_config.monthly_reset_enabled. Cron runs daily at 00:05 UTC
// and per-guild gating compares `reset_interval_days` against `last_reset_at`.
// `force` + `guildIds` are escape hatches for manual verification runs.
export async function runMonthlyReset(client, { force = false, guildIds = null } = {}) {
    logger.info('[LevelingMonthlyReset] Starting reset sweep', { force, scope: guildIds?.length || 'all' });

    let rows;
    if (force && guildIds?.length) {
        const placeholders = guildIds.map(() => '?').join(',');
        [rows] = await pool.execute(
            `SELECT guild_id, reset_interval_days, last_reset_at, reset_exempt_staff
             FROM level_config
             WHERE guild_id IN (${placeholders})`,
            guildIds
        );
    } else {
        [rows] = await pool.execute(
            `SELECT guild_id, reset_interval_days, last_reset_at, reset_exempt_staff
             FROM level_config
             WHERE monthly_reset_enabled = 1
               AND (last_reset_at IS NULL
                    OR TIMESTAMPDIFF(DAY, last_reset_at, NOW()) >= reset_interval_days)`
        );
    }

    if (!rows.length) {
        logger.info('[LevelingMonthlyReset] No due guilds, nothing to do');
        return;
    }

    for (const row of rows) {
        const { guild_id: guildId, reset_interval_days, last_reset_at } = row;
        try {
            await resetGuild(client, guildId, { exemptStaff: Number(row.reset_exempt_staff) === 1 });
            await pool.execute(
                'UPDATE level_config SET last_reset_at = NOW() WHERE guild_id = ?',
                [guildId]
            );
            logger.info(`[LevelingMonthlyReset] ${guildId}: reset complete (interval=${reset_interval_days}d, prev_reset=${last_reset_at || 'never'})`);
        } catch (err) {
            logger.error(`[LevelingMonthlyReset] Failed for guild ${guildId}: ${err.message}`, { stack: err.stack });
        }
    }
    logger.info('[LevelingMonthlyReset] Sweep complete');
}

async function resetGuild(client, guildId, { exemptStaff = false } = {}) {
    let guild = client.guilds.cache.get(guildId);
    if (!guild && global.botManager?.clients) {
        for (const [, c] of global.botManager.clients) {
            guild = c.guilds.cache.get(guildId);
            if (guild) break;
        }
    }

    // A staff-exempt guild needs the member list to know who staff are. Without it, wiping would
    // hit staff too, so skip the whole reset; last_reset_at is not updated and it retries tomorrow.
    let members = null;
    let staff = new Set();
    if (guild) {
        members = await guild.members.fetch();
        staff = collectStaffIds(guild, members);
    } else if (exemptStaff) {
        throw new Error('guild not available on any client; staff-exempt reset postponed to the next run');
    }

    // 1. Wipe user_levels for this guild (keeping staff rows when the guild exempts staff)
    const keep = exemptStaff ? Array.from(staff) : [];
    const keepClause = keep.length ? `AND user_id NOT IN (${keep.map(() => '?').join(',')})` : '';
    const [delRes] = await pool.execute(
        `DELETE FROM user_levels WHERE guild_id = ? ${keepClause}`,
        [guildId, ...keep]
    );
    logger.info(`[LevelingMonthlyReset] ${guildId}: cleared ${delRes.affectedRows} user_levels rows${exemptStaff ? ` (${keep.length} staff kept)` : ''}`);

    if (!guild) {
        logger.warn(`[LevelingMonthlyReset] ${guildId}: guild not available on any client, skipping role strip & sub pause`);
        return;
    }

    // 2. Collect role-reward role IDs for this guild and strip them from all members
    //    (staff keep theirs when the guild exempts staff)
    const [rewards] = await pool.execute(
        'SELECT role_id FROM level_role_rewards WHERE guild_id = ?',
        [guildId]
    );
    const rewardRoleIds = rewards.map(r => r.role_id);

    let stripCount = 0;
    for (const m of members.values()) {
        if (exemptStaff && staff.has(String(m.id))) continue;
        for (const rid of rewardRoleIds) {
            if (m.roles.cache.has(rid)) {
                await m.roles.remove(rid, 'Leveling reset').catch(() => {});
                stripCount++;
            }
        }
    }
    logger.info(`[LevelingMonthlyReset] ${guildId}: stripped ${stripCount} role-reward grants`);

    // 3. Pause stream subscriptions whose owner is below the signup level gate.
    //
    //    GATES (all required, per owner directive 2026-10-29):
    //    - Guild MUST have stream_signup_config (opt-in to the "earn your shoutout" mechanic).
    //      Without it, the monthly leveling reset leaves subs alone — the role strip is enough.
    //    - External subs (tracking_origin='external') are curated by staff, never auto-paused.
    //    - Admins/mods/owners are never paused (STAFF_PERMS above), whatever reset_exempt_staff says.
    //
    //    The threshold comes from stream_signup_config.level_gate (not a hardcoded 3) so a guild
    //    on a stricter gate (e.g. 5) and a looser one (e.g. 1) both behave as that server set up.
    const [[signup]] = await pool.execute(
        'SELECT level_gate FROM stream_signup_config WHERE guild_id = ?',
        [guildId]
    );
    const gate = Number(signup?.level_gate ?? 0);
    if (!signup || gate < 1) {
        logger.info(`[LevelingMonthlyReset] ${guildId}: no stream_signup_config.level_gate — skipping sub pause (role strip only)`);
        return;
    }

    const exemptArr = Array.from(staff);
    const notInClause = exemptArr.length
        ? `AND (s.discord_user_id IS NULL OR s.discord_user_id NOT IN (${exemptArr.map(() => '?').join(',')}))`
        : '';
    const [pausedRes] = await pool.execute(
        `UPDATE subscriptions sub
         JOIN streamers s ON s.streamer_id = sub.streamer_id
         LEFT JOIN user_levels ul ON ul.guild_id = sub.guild_id AND ul.user_id = s.discord_user_id
         SET sub.paused = 1
         WHERE sub.guild_id = ?
           AND sub.tracking_origin <> 'external'
           AND COALESCE(ul.level, 0) < ?
           ${notInClause}`,
        [guildId, gate, ...exemptArr]
    );
    logger.info(`[LevelingMonthlyReset] ${guildId}: paused ${pausedRes.affectedRows} subscriptions below lvl ${gate} (opt-in, ${exemptArr.length} staff exempted, external skipped)`);
}

export function startMonthlyResetScheduler(client) {
    if (task) return;
    // 00:05 every day UTC — per-guild eligibility is gated by reset_interval_days inside runMonthlyReset.
    task = cron.schedule('5 0 * * *', () => {
        runMonthlyReset(client).catch(err => logger.error('[LevelingMonthlyReset] fatal', { err: err.message }));
    }, { timezone: 'UTC' });
    logger.info('[LevelingMonthlyReset] scheduler started (5 0 * * * UTC, per-guild reset_interval_days)');
}

export function stopMonthlyResetScheduler() {
    if (task) { task.stop(); task = null; }
}
